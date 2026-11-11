// The owner's side of connections: friends' newest posts on Home (feed.js picks which sites to ask when it opens),
// friends' posts and photos read from here (friends.js), and comments sent to their sites, which keep them; a
// copy is kept here in comments_elsewhere.
//   POST /_feed/comments                                       connection, target, text, back (a form)
//   POST /_feed/comments/<connection>/<remote id>/delete       back (a form)
//   POST /_feed/vote                                           connection, target, choice…, back: answering their poll
import { actorId, commentId, targetId } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { cleanFeed } from "./friends.js";
import { messagePage } from "./views/pages.js";
import { callSite } from "./peers.js";
import { html, now, Refusal, withoutKeys } from "./util.js";
import { INBOX_JOIN } from "./notify.js";

// Home asks friends' sites for their newest posts when it opens. Each is a request, and the free plan allows 50 per
// page, so with more friends than SITES it asks those whose notes (notify.js) say they've posted lately, newest
// first, keeping a few places for the friends asked longest ago, so a quiet friend or a missed note still turns up.
const SITES = 40;
const TAKING_TURNS = 5;
// A friend's site that hasn't answered for a day (or says this site isn't connected) stops being mentioned on Home,
// and Friends says so instead, with a way to remove them (views.js). It's still asked, but once an hour at most.
export const QUIET_SECONDS = 86_400;
const QUIET_ASK_SECONDS = 3600;
const TARGET_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;

export const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL")
  .bind(Number(id) || 0).first();

/** Remembers a friend's profile picture link (and when it stops working), from what their site just sent. */
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
  if (!comments) return null; // nothing there takes comments
  const { results } = await db.prepare("SELECT remote_id, text FROM comments_elsewhere WHERE connection_id = ? AND target = ?")
    .bind(connectionId, target).all();
  const sent = new Map(results.map((r) => [r.remote_id, r.text]));
  return comments.flatMap((c) => (sent.has(c.id) ? [{ ...c, mine: true, text: sent.get(c.id), from: null }]
    : c.from === ownOrigin ? [] : [{ ...c, mine: false }]));
}

/** Whether a friend's site has gone quiet, or says this site isn't connected any more: shown on Friends, not Home. */
export const gone = (c, at = now()) => Boolean(c.said_no || (c.missing_since && c.missing_since <= at - QUIET_SECONDS));

/**
 * Notes how a friend's site just answered (`error`: what was thrown, if anything) on `connection` itself, and returns
 * the statement that keeps it. Only callSite's errors (which carry a status; 0 if it couldn't be reached) say the
 * site isn't answering; 401 means it doesn't know this site's key: they removed it.
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

export async function loadFeed(db, ownOrigin) {
  const { results: connections } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL
    AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE`).all();
  const asking = await sitesToAsk(db, connections);
  const replies = await Promise.all(asking.map(async (connection) => {
    try {
      const feed = await callSite(connection.origin, "/_peer/feed", { key: connection.their_key });
      return { connection, feed: cleanFeed(feed, connection.origin) };
    } catch (error) {
      return { connection, error };
    }
  }));
  const checked = now();
  if (replies.length) {
    await db.batch(replies.flatMap(({ connection, error }) => [
      db.prepare("UPDATE connections SET feed_checked_at = ? WHERE id = ?").bind(checked, connection.id),
      noteAnswer(db, connection, error, checked),
    ]));
  }
  // Keep names up to date if a friend changes theirs.
  const renamed = replies.filter((r) => r.feed?.name && r.feed.name !== r.connection.name);
  if (renamed.length) {
    await db.batch(renamed.map((r) => db.prepare("UPDATE connections SET name = ? WHERE id = ?").bind(r.feed.name, r.connection.id)));
    for (const r of renamed) r.connection.name = r.feed.name;
  }
  for (const r of replies) if (r.feed) r.connection.avatar = r.feed.avatar;
  const pictures = replies.map((r) => r.feed?.avatar && rememberPicture(db, r.connection, r.feed.avatar)).filter(Boolean);
  if (pictures.length) await db.batch(pictures);
  // What Home shows, with each friend as it's shown: without the keys to their site (util.js pageData).
  const shown = new Map(connections.map((c) => [c, withoutKeys(c)]));
  const posts = [];
  for (const r of replies) {
    for (const p of r.feed?.posts ?? []) {
      posts.push({ ...p, connection: shown.get(r.connection), comments: await markMine(db, r.connection.id, p.key, p.comments, ownOrigin) });
    }
  }
  posts.sort((a, b) => b.created_at - a.created_at);
  // Home only mentions a friend's site that's just stopped answering; one that's gone quiet is on Friends instead.
  const unreachable = replies.filter((r) => r.error && !gone(r.connection, checked))
    .map((r) => ({ connection: shown.get(r.connection), error: r.error.message }));
  return { posts, connections: [...shown.values()], unreachable };
}

export async function handleFeed(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });

  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
  try {
    if (url.pathname === "/_feed/comments") {
      const made = await commentOnFriend(env, url.origin, {
        connection: form.get("connection"), target: String(form.get("target") ?? ""), text: String(form.get("text") ?? ""),
      });
      if (made) back.hash = `r${made.connection}-${made.id}`;
      return Response.redirect(back, 303);
    }
    if (url.pathname === "/_feed/vote") {
      const connection = String(form.get("connection") ?? "");
      const target = String(form.get("target") ?? "");
      await voteOnFriend(env, { connection, target, choices: form.getAll("choice").map(String) });
      back.hash = `f${Number(connection) || 0}-${TARGET_RE.test(target) ? target : ""}`;
      return Response.redirect(back, 303);
    }
    const del = /^\/_feed\/comments\/(\d+)\/(\d+)\/delete$/.exec(url.pathname);
    if (del) {
      await deleteFriendComment(env, { connection: del[1], id: Number(del[2]) });
      return Response.redirect(back, 303);
    }
  } catch (error) {
    if (error instanceof Refusal) return problem(error.message, back);
    throw error;
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/**
 * The owner comments on a friend's post or photo (`target`, its key): the comment goes to their site, which keeps it,
 * and this site keeps the owner's own copy. Returns { connection, id } (their number for it), or null if there's
 * nothing to send.
 */
export async function commentOnFriend(env, origin, { connection: connectionId, target, text }) {
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
      },
    });
    // Their address for it: <the post's or photo's address>#c<n>.
    const n = /#c(\d{1,15})$/.exec(typeof reply.id === "string" ? reply.id : "");
    if (!n || reply.id !== commentId(connection.origin, target, n[1])) throw new Error("Their site sent something unexpected.");
    const id = Number(n[1]);
    await db.prepare(`INSERT INTO comments_elsewhere (connection_id, site, remote_id, target, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(connection.id, connection.origin, id, target, text, now()).run();
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
}

/** The owner deletes their comment `id` (their number for it) on friend `connection`'s site, and their copy here. */
export async function deleteFriendComment(env, { connection: connectionId, id }) {
  const db = env.DB;
  const connection = await connectionById(db, connectionId);
  if (!connection) throw new Refusal("You're no longer connected with them.");
  try {
    await callSite(connection.origin, `/_peer/comments/${id}/delete`, { key: connection.their_key, body: {} });
    await db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ? AND remote_id = ?").bind(connection.id, id).run();
  } catch (error) {
    throw new Refusal(`Couldn't delete your comment: ${error.message}`);
  }
}

const problem = (message, back = null) =>
  html(messagePage(message, { href: back ? back.pathname + back.search : "/", label: "Go back" }), 400);
