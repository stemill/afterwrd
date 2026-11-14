// The owner's side of connections: friends' newest posts on Home (feed.js picks which sites to ask when it opens),
// friends' posts and photos read from here (friends.js), and comments sent to their sites, which keep them; a
// copy is kept here in comments_elsewhere.
//   POST /_feed/comments                                       connection, target, text, back (a form)
//   POST /_feed/comments/<connection>/<remote id>/delete       back (a form)
//   POST /_feed/comments/<connection>/<remote id>/edit         text, back: change it (their site decides: edits.js)
//   POST /_feed/vote                                           connection, target, choice…, back: answering their poll
//   POST /_feed/answer                                         connection, target, answer, back: answering their event
//                                                              (events.js)
import { actorId, commentId, targetId } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { cleanFeed } from "./friends.js";
import { messagePage } from "./views/pages.js";
import { callSite } from "./peers.js";
import { html, now, Refusal, withoutKeys } from "./util.js";
import { INBOX_JOIN } from "./notify.js";
import { EDIT_SECONDS, elsewhereVersions, elsewhereVersionsGone } from "./edits.js";
import { answerFriendEvent, eventCopies } from "./events.js";
import { outbox } from "./outbox.js";
import { cleanMentions, mentionTags } from "./mentions.js";

// Home asks friends' sites for their newest posts when it opens. Each is a request, and the free plan allows 50 per
// page (calls out only: database queries have a cap of their own, near 1,000; tried on a free account, 14 Nov 2026),
// so with more friends than SITES it asks those whose notes (notify.js) say they've posted lately, newest
// first, keeping a few places for the friends asked longest ago, so a quiet friend or a missed note still turns up.
const SITES = 40;
const TAKING_TURNS = 5;
// A friend's site that hasn't answered for a day (or says this site isn't connected) stops being mentioned on Home,
// and Friends says so instead, with a way to remove them (views.js). It's still asked, but once an hour at most.
export const QUIET_SECONDS = 86_400;
const QUIET_ASK_SECONDS = 3600;
const TARGET_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;

/** @type {(db: D1Database, id: unknown) => Promise<Row<"connections"> | null>} */
export const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL")
  .bind(Number(id) || 0).first();

/**
 * Remembers a friend's profile picture link (and when it stops working), from what their site just sent.
 * @param {D1Database} db
 * @param {Row<"connections">} connection
 * @param {{ thumbSrc?: string } | null | undefined} avatar
 */
export function rememberPicture(db, connection, avatar) {
  const exp = Number(/[?&]exp=(\d+)/.exec(avatar?.thumbSrc ?? "")?.[1]) || null;
  if (!exp || connection.avatar_url === avatar.thumbSrc) return null;
  connection.avatar_url = avatar.thumbSrc;
  connection.avatar_exp = exp;
  return db.prepare("UPDATE connections SET avatar_url = ?, avatar_exp = ? WHERE id = ?").bind(avatar.thumbSrc, exp, connection.id);
}

/**
 * Marks the owner's own comments on a friend's post or photo (`target`): the ones this site sent there
 * (comments_elsewhere), shown with the words this site kept, whatever the friend's site says. Anything else claiming
 * to come from this site is left out: a friend's site can't put words in the owner's mouth.
 */
export async function markMine(db, connectionId, target, comments, ownOrigin) {
  return (await markAllMine(db, [{ connectionId, target, comments }], ownOrigin))[0];
}

/**
 * markMine for many at once (`items`: { connectionId, target, comments }), in the same order: two queries however
 * many there are. (Home has up to 40 friends' 30 posts each, and each query is a wait.)
 */
export async function markAllMine(db, items, ownOrigin) {
  const asked = items.filter((i) => i.comments);
  const { results } = asked.length ? await db.prepare(`SELECT e.connection_id, e.target, e.id, e.remote_id, e.text, e.edited_at
      FROM comments_elsewhere e JOIN json_each(?) j ON e.connection_id = json_extract(j.value, '$[0]') AND e.target = json_extract(j.value, '$[1]')`)
    .bind(JSON.stringify([...new Set(asked.map((i) => JSON.stringify([Number(i.connectionId), i.target])))].map((k) => JSON.parse(k)))).all()
    : { results: [] };
  // The owner's own words, and their own record of changing them: never what the friend's site says they said.
  const earlier = await elsewhereVersions(db, results.filter((r) => r.edited_at).map((r) => r.id));
  const at = now();
  return items.map(({ connectionId, target, comments }) => {
    if (!comments) return null; // nothing there takes comments
    const sent = new Map(results.filter((r) => r.connection_id === Number(connectionId) && r.target === target).map((r) => [r.remote_id, r]));
    // Whether the owner can still change one: as their site will decide (edits.js), so the page only offers what works.
    const later = (c) => comments.some((l) => l.id > c.id && !sent.has(l.id));
    return comments.flatMap((c) => (sent.has(c.id)
      ? [{ ...c, mine: true, from: null, text: sent.get(c.id).text, edited_at: sent.get(c.id).edited_at, earlier: earlier.get(sent.get(c.id).id) ?? [],
        editable: c.created_at > at - EDIT_SECONDS && !later(c) }]
      : c.from === ownOrigin ? [] : [{ ...c, mine: false }]));
  });
}

/** Whether a friend's site has gone quiet, or says this site isn't connected any more: shown on Friends, not Home. */
export const gone = (c, at = now()) => Boolean(c.said_no || (c.missing_since && c.missing_since <= at - QUIET_SECONDS));

/**
 * Notes how a friend's site just answered (`error`: what was thrown, if anything) on `connection` itself, and returns
 * the statement that keeps it. Only callSite's errors (which carry a status; 0 if it couldn't be reached) say the
 * site isn't answering; 401 means it doesn't know this site's key: they removed it.
 * @param {D1Database} db
 * @param {Row<"connections">} connection
 * @param {any} [error]
 * @param {number} [at]
 */
export function noteAnswer(db, connection, error = null, at = now()) {
  Object.assign(connection, error?.status !== undefined
    ? { missing_since: connection.missing_since ?? at, said_no: error.status === 401 ? 1 : 0 }
    : { reached_at: at, missing_since: null, said_no: 0 });
  return db.prepare("UPDATE connections SET reached_at = ?, missing_since = ?, said_no = ? WHERE id = ?")
    .bind(connection.reached_at ?? null, connection.missing_since, connection.said_no, connection.id);
}

/** Which friends' sites Home asks this time (see SITES). */
async function sitesToAsk(db, all) {
  const at = now();
  const connections = all.filter((c) => !gone(c, at) || (c.feed_checked_at ?? 0) <= at - QUIET_ASK_SECONDS);
  if (connections.length <= SITES) return connections;
  const { results: lately } = await db.prepare(`SELECT i.connection_id AS id, MAX(i.created_at) AS latest FROM inbox i ${INBOX_JOIN}
    WHERE i.kind = 'post' GROUP BY i.connection_id ORDER BY latest DESC LIMIT ?`).bind(SITES - TAKING_TURNS).all();
  const posted = new Set(lately.map((r) => r.id));
  const turns = connections.filter((c) => !posted.has(c.id)).sort((a, b) => (a.feed_checked_at ?? 0) - (b.feed_checked_at ?? 0));
  return [...connections.filter((c) => posted.has(c.id)), ...turns.slice(0, SITES - posted.size)];
}

/**
 * Home's friends' posts come from the copies kept here (friend_posts), as their sites last sent them, so Home doesn't
 * wait on their sites. A copy can be shown until the first of its photo links expires (their sites sign them for an
 * hour or two: share.js), or for COPY_SECONDS if it has none. Each time Home opens, copies older than FRESH_SECONDS are
 * fetched again in the background (the Outbox, which has its own allowance of calls: refreshCopies), so the next visit
 * has them; and a friend's note that they've posted or commented fetches theirs at once (peers.js). Only friends with
 * no copy that can be shown are asked while Home waits, as before (sitesToAsk). Nothing's fetched when nobody's looking:
 * D1's free plan allows 100,000 rows written a day.
 */
const FRESH_SECONDS = 5 * 60;
const COPY_SECONDS = 86_400;
const MARGIN_SECONDS = 5 * 60; // a copy whose links expire sooner than this isn't shown: its photos could break
const HOME_POSTS = 100; // friends' posts on Home, newest first, from every friend together
const KEEP_POSTS = 30; // of each friend's: as many as their feed sends (peers.js FEED_POSTS)
const MAX_POST_CHARS = 200_000; // a post bigger than this, as kept, isn't kept (a D1 row holds 2 MB at most)
const FUTURE_SECONDS = 300; // a post dated later than this from now is kept as made now, so it can't sit atop Home
// Fetches in the background (a friend's note, or a copy getting old), per friend: at most this many a day, claimed in the
// same statement as the check, so a friend's site can't use up this site's database writes by sending notes (each fetch
// writes at most KEEP_POSTS posts). Home asking while it waits isn't rationed: that's the owner looking.
const BACKGROUND_DAILY = 48;

/** Until when a copy fetched `at` can be shown: the first of its photos' links to expire, or a day on. */
function copyUntil(posts, at) {
  // The photos' signed links only (share.js signedFile: /files/<hash>?exp=…&sig=…), never anything in what they wrote.
  const links = JSON.stringify(posts.map((p) => p.photos ?? []));
  const expiries = [...links.matchAll(/\/files\/[0-9a-f]{64}\?exp=(\d+)&sig=/g)].map((m) => Number(m[1]));
  return Math.min(at + COPY_SECONDS, ...expiries);
}

/**
 * Statements keeping what friend `connection`'s site just sent (`feed`, cleaned): the copy of their posts Home shows,
 * their name and picture if they've changed, and copies of their events the owner's invited to (events.js).
 * @param {D1Database} db
 * @param {Row<"connections">} connection
 * @param {{ name?: string, avatar?: { thumbSrc?: string } | null, posts: any[] }} feed
 * @param {number} at
 */
function keepFeed(db, connection, feed, at) {
  const posts = feed.posts.slice(0, KEEP_POSTS).map((p) => ({ p, data: JSON.stringify(p) })).filter(({ data }) => data.length <= MAX_POST_CHARS);
  const keys = posts.map(({ p }) => p.key);
  connection.copied_at = at;
  connection.copy_until = copyUntil(posts.map(({ p }) => p), at);
  const statements = [
    db.prepare("DELETE FROM friend_posts WHERE connection_id = ? AND post_key NOT IN (SELECT value FROM json_each(?))")
      .bind(connection.id, JSON.stringify(keys)),
    ...posts.map(({ p, data }) => db.prepare(`INSERT INTO friend_posts (connection_id, post_key, created_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (connection_id, post_key) DO UPDATE SET created_at = excluded.created_at, data = excluded.data
      WHERE friend_posts.data IS NOT excluded.data`).bind(connection.id, p.key, Math.min(Number(p.created_at) || 0, at + FUTURE_SECONDS), data)),
    db.prepare("UPDATE connections SET copied_at = ?, copy_until = ? WHERE id = ?").bind(at, connection.copy_until, connection.id),
    ...eventCopies(db, connection, feed.posts),
  ];
  // Keep names up to date if a friend changes theirs.
  if (feed.name && feed.name !== connection.name) {
    connection.name = feed.name;
    statements.push(db.prepare("UPDATE connections SET name = ? WHERE id = ?").bind(feed.name, connection.id));
  }
  const picture = feed.avatar && rememberPicture(db, connection, feed.avatar);
  if (picture) statements.push(picture);
  return statements;
}

/**
 * Asks each of `connections`' sites for their newest posts, and keeps what they send. Returns {connection, error?}.
 * @template {Row<"connections">} C
 * @param {D1Database} db
 * @param {C[]} connections
 * @param {any} env
 * @returns {Promise<{ connection: C, error?: any }[]>}
 */
async function askSites(db, connections, env) {
  const replies = await Promise.all(connections.map(async (connection) => {
    try {
      const feed = await callSite(connection.origin, "/_peer/feed", { key: connection.their_key });
      return { connection, feed: cleanFeed(feed, connection.origin, env) };
    } catch (error) {
      return { connection, error };
    }
  }));
  const at = now();
  // A batch for each friend: small transactions, however many friends there are, and one friend's failing (something
  // too big to keep, say) doesn't stop the rest, or Home. A site that says this one isn't connected (401: they removed
  // the owner) has its copy forgotten at once.
  await Promise.all(replies.map(({ connection, feed, error }) => db.batch([
    db.prepare("UPDATE connections SET feed_checked_at = ? WHERE id = ?").bind(at, connection.id),
    noteAnswer(db, connection, error, at),
    ...(feed ? keepFeed(db, connection, feed, at) : []),
    ...(error?.status === 401 ? [db.prepare("DELETE FROM friend_posts WHERE connection_id = ?").bind(connection.id)] : []),
  ]).catch((failed) => console.error(`Keeping ${connection.origin}'s posts:`, failed.message))));
  return replies.map(({ connection, error }) => ({ connection, error }));
}

/** In the background (the Outbox's alarm): fetches these friends' newest posts again, and keeps them. */
export async function refreshCopies(env, ids) {
  if (!ids.length) return;
  const db = env.DB;
  const at = now();
  const day = Math.floor(at / 86400);
  // Each friend's fetch claimed from their day's ration first (BACKGROUND_DAILY), in one statement each: those over it wait.
  const claimed = await db.batch(ids.map((id) => db.prepare(`UPDATE connections
    SET refreshes = CASE WHEN refresh_day = ?2 THEN refreshes + 1 ELSE 1 END, refresh_day = ?2
    WHERE id = ?1 AND connected_at IS NOT NULL AND approved_at IS NOT NULL
      AND (refresh_day IS NOT ?2 OR refreshes < ?3)
    RETURNING *`).bind(Number(id), day, BACKGROUND_DAILY)));
  /** @type {Row<"connections">[]} */
  const results = claimed.flatMap((r) => /** @type {any[]} */ (r.results));
  await askSites(db, results, env);
}

/** Home's friends' posts: from the copies kept here, asking only the friends with none that can be shown (see above). */
export async function loadFeed(db, ownOrigin, env = null) {
  const at = now();
  /** @type {{ results: (Row<"connections"> & { avatar?: { thumbSrc: string } | null })[] }} */
  const { results: connections } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL
    AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE`).all();
  // A copy of a site that's said this one isn't connected any more isn't shown, however recent.
  const usable = (c) => Boolean(c.copied_at) && (c.copy_until ?? 0) > at + MARGIN_SECONDS && !c.said_no;
  const replies = await askSites(db, await sitesToAsk(db, connections.filter((c) => !usable(c))), env);
  // Fetched in the background, for next time: copies getting old, and friends with none that weren't asked now (more
  // than SITES of them). Quiet sites no more than hourly, as above.
  const asked = new Set(replies.map((r) => r.connection));
  const old = connections.filter((c) => !asked.has(c) && (!usable(c) || c.copied_at < at - FRESH_SECONDS)
    && (!gone(c, at) || (c.feed_checked_at ?? 0) <= at - QUIET_ASK_SECONDS));
  if (old.length && env?.OUTBOX) await outbox(env).refresh(old.map((c) => c.id)).catch((error) => console.error("Refreshing copies:", error.message));
  // What Home shows, with each friend as it's shown: without the keys to their site (util.js pageData), and with the
  // picture last remembered for them.
  for (const c of connections) c.avatar = c.avatar_url && c.avatar_exp > at ? { thumbSrc: c.avatar_url } : null;
  const shown = new Map(connections.map((c) => [c.id, withoutKeys(c)]));
  const showing = connections.filter(usable).map((c) => c.id);
  /** @type {{ results: Pick<Row<"friend_posts">, "connection_id" | "data">[] }} */
  const { results: rows } = showing.length ? await db.prepare(`SELECT connection_id, data FROM friend_posts
    WHERE connection_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?`).bind(JSON.stringify(showing), HOME_POSTS).all()
    : { results: [] };
  const theirs = rows.map((r) => ({ id: r.connection_id, p: JSON.parse(r.data) }));
  // A copy can be older than a poll's closing time: past it, it's closed (their site won't take answers either).
  for (const { p } of theirs) if (p.poll?.open && p.poll.closes_at && p.poll.closes_at <= at) p.poll = { ...p.poll, open: false };
  const marked = await markAllMine(db, theirs.map(({ id, p }) => ({ connectionId: id, target: p.key, comments: p.comments })), ownOrigin);
  const posts = theirs.map(({ id, p }, i) => ({ ...p, connection: shown.get(id), comments: marked[i] }));
  // Home only mentions a friend's site that's just stopped answering; one that's gone quiet is on Friends instead.
  const unreachable = replies.filter((r) => r.error && !gone(r.connection, at))
    .map((r) => ({ connection: shown.get(r.connection.id), error: r.error.message }));
  return { posts, connections: [...shown.values()], unreachable };
}

export async function handleFeed(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
  try {
    if (url.pathname === "/_feed/comments") {
      const made = await commentOnFriend(env, url.origin, {
        connection: form.get("connection"), target: String(form.get("target") ?? ""), text: String(form.get("text") ?? ""),
        mentions: form.get("mentions"),
      });
      if (made) back.hash = `r${made.connection}-${made.id}`;
      return Response.redirect(back.href, 303);
    }
    if (url.pathname === "/_feed/answer") {
      const connection = String(form.get("connection") ?? "");
      const target = String(form.get("target") ?? "");
      const friend = await connectionById(env.DB, connection);
      if (!friend) throw new Refusal("You're no longer connected with them.");
      await answerFriendEvent(env, friend, target, String(form.get("answer") ?? ""));
      await copyChanged(env, friend.id);
      back.hash ||= `f${friend.id}-${TARGET_RE.test(target) ? target : ""}`;
      return Response.redirect(back.href, 303);
    }
    if (url.pathname === "/_feed/vote") {
      const connection = String(form.get("connection") ?? "");
      const target = String(form.get("target") ?? "");
      await voteOnFriend(env, { connection, target, choices: form.getAll("choice").map(String) });
      back.hash = `f${Number(connection) || 0}-${TARGET_RE.test(target) ? target : ""}`;
      return Response.redirect(back.href, 303);
    }
    const change = /^\/_feed\/comments\/(\d+)\/(\d+)\/edit$/.exec(url.pathname);
    if (change) {
      await editFriendComment(env, { connection: change[1], id: Number(change[2]), text: String(form.get("text") ?? "") });
      back.hash = `r${Number(change[1])}-${Number(change[2])}`;
      return Response.redirect(back.href, 303);
    }
    const del = /^\/_feed\/comments\/(\d+)\/(\d+)\/delete$/.exec(url.pathname);
    if (del) {
      await deleteFriendComment(env, { connection: del[1], id: Number(del[2]) });
      return Response.redirect(back.href, 303);
    }
  } catch (error) {
    if (error instanceof Refusal) return problem(error.message, back);
    throw error;
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/**
 * After the owner changes something on a friend's post (a comment, a vote, an answer), Home's copy of their posts is
 * out of date: it isn't shown again until it's been fetched afresh, in the background now, or by Home itself.
 */
async function copyChanged(env, connectionId) {
  await env.DB.prepare("UPDATE connections SET copy_until = 0 WHERE id = ?").bind(connectionId).run();
  if (env.OUTBOX) await outbox(env).refresh([connectionId]).catch((error) => console.error("Refreshing after a change:", error.message));
}

/**
 * The owner comments on a friend's post or photo (`target`, its key), perhaps mentioning people (their site decides who
 * of them is told): the comment goes to their site, which keeps it,
 * and this site keeps the owner's own copy. Returns { connection, id } (their number for it), or null if there's
 * nothing to send.
 */
export async function commentOnFriend(env, origin, { connection: connectionId, target, text, mentions: given = null }) {
  const db = env.DB;
  const connection = await connectionById(db, connectionId);
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!connection) throw new Refusal("You're no longer connected with them.");
  if (!TARGET_RE.test(target)) throw new Refusal("That isn't something you can comment on.");
  if (!text) return null;
  if (text.length > MAX_COMMENT) throw new Refusal(`Comments can be up to ${MAX_COMMENT} characters.`);
  const owner = await db.prepare("SELECT name FROM users LIMIT 1").first();
  try {
    const reply = await callSite(connection.origin, "/_peer/comments", {
      key: connection.their_key,
      body: {
        "@context": "https://www.w3.org/ns/activitystreams", type: "Note", mediaType: "text/plain", content: text,
        attributedTo: { type: "Person", id: actorId(origin), name: owner?.name }, inReplyTo: targetId(connection.origin, target),
        // Who it mentions (mentions.js): their site tells those of them who can see it.
        tag: mentionTags(cleanMentions(given, text, env)),
      },
    });
    // Their address for it: <the post's or photo's address>#c<n>.
    const n = /#c(\d{1,15})$/.exec(typeof reply.id === "string" ? reply.id : "");
    if (!n || reply.id !== commentId(connection.origin, target, n[1])) throw new Error("Their site sent something unexpected.");
    const id = Number(n[1]);
    await db.prepare(`INSERT INTO comments_elsewhere (connection_id, site, remote_id, target, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(connection.id, connection.origin, id, target, text, now()).run();
    await copyChanged(env, connection.id);
    return { connection: connection.id, id };
  } catch (error) {
    throw new Refusal(`Couldn't send your comment: ${error.message}`);
  }
}

/**
 * The owner answers the poll in a friend's post (`target`, its key): `choices`, the options' numbers. Their site keeps
 * it, and shows the owner's choice back to them; it isn't kept here.
 */
export async function voteOnFriend(env, { connection: connectionId, target, choices }) {
  const connection = await connectionById(env.DB, connectionId);
  if (!connection) throw new Refusal("You're no longer connected with them.");
  if (!/^post-\d+-[0-9a-f]{8}$/.test(target)) throw new Refusal("That isn't a poll you can answer.");
  const list = choices.slice(0, 20).map((c) => (/^\d{1,2}$/.test(c) ? Number(c) : -1));
  try {
    await callSite(connection.origin, "/_peer/vote", { key: connection.their_key, body: {
      "@context": "https://www.w3.org/ns/activitystreams", type: "afterwrd:Vote", inReplyTo: targetId(connection.origin, target),
      "afterwrd:choices": list,
    } });
  } catch (error) {
    throw new Refusal(`Couldn't send your answer: ${error.message}`);
  }
  await copyChanged(env, connection.id);
}

/** The owner deletes their comment `id` (their number for it) on friend `connection`'s site, and their copy here. */
export async function deleteFriendComment(env, { connection: connectionId, id }) {
  const db = env.DB;
  const connection = await connectionById(db, connectionId);
  if (!connection) throw new Refusal("You're no longer connected with them.");
  try {
    await callSite(connection.origin, `/_peer/comments/${id}/delete`, { key: connection.their_key, body: {} });
    await db.batch([db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ? AND remote_id = ?").bind(connection.id, id),
      elsewhereVersionsGone(db)]);
  } catch (error) {
    throw new Refusal(`Couldn't delete your comment: ${error.message}`);
  }
  await copyChanged(env, connection.id);
}

/**
 * The owner changes their comment `id` (their number for it) on friend `connection`'s site. Their site decides whether
 * it still can be (edits.js there); then this site's copy changes too, keeping what it said before.
 */
export async function editFriendComment(env, { connection: connectionId, id, text }) {
  const db = env.DB;
  const connection = await connectionById(db, connectionId);
  if (!connection) throw new Refusal("You're no longer connected with them.");
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > MAX_COMMENT) throw new Refusal(`Comments need 1 to ${MAX_COMMENT} characters.`);
  const mine = await db.prepare("SELECT * FROM comments_elsewhere WHERE connection_id = ? AND remote_id = ?").bind(connection.id, id).first();
  if (!mine) throw new Refusal("That isn't a comment of yours.");
  if (mine.text === text) return;
  try {
    await callSite(connection.origin, `/_peer/comments/${id}/edit`, { key: connection.their_key,
      body: { "@context": "https://www.w3.org/ns/activitystreams", type: "Note", mediaType: "text/plain", content: text } });
  } catch (error) {
    // A site from before editing answers an unknown address with "Not found.".
    if (error.status === 404 && error.message === "Not found.") throw new Refusal(`${connection.name}'s site can't change comments yet. You can still delete it.`);
    throw new Refusal(`Couldn't change your comment: ${error.message}`);
  }
  const at = now();
  await db.batch([
    db.prepare("INSERT INTO comments_elsewhere_versions (comment_id, text, replaced_at) VALUES (?, ?, ?)").bind(mine.id, mine.text, at),
    db.prepare("UPDATE comments_elsewhere SET text = ?, edited_at = ? WHERE id = ?").bind(text, at, mine.id),
  ]);
  await copyChanged(env, connection.id);
}

const problem = (message, back = null) =>
  html(messagePage(message, { href: back ? back.pathname + back.search : "/", label: "Go back" }), 400);
