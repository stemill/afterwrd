// The owner's side of connections: Feed (the newest posts from every connected site, fetched when the page opens),
// friends' posts and photos read from here (friends.js), and comments sent to their sites, which keep them; a
// copy is kept here in comments_elsewhere.
//   POST /_feed/comments                                       connection, target, text, back (a form)
//   POST /_feed/comments/<connection>/<remote id>/delete       back (a form)
import { actorId, commentId, targetId } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { cleanFeed } from "./friends.js";
import { messagePage } from "./pages.js";
import { callSite } from "./peers.js";
import { html, now } from "./util.js";

const MAX_SITES = 40; // each one is a request; the free plan allows 50 per page
const TARGET_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;

export const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL")
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
  const { results } = await db.prepare("SELECT remote_id, text FROM comments_elsewhere WHERE connection_id = ? AND target = ?")
    .bind(connectionId, target).all();
  const sent = new Map(results.map((r) => [r.remote_id, r.text]));
  return comments.flatMap((c) => (sent.has(c.id) ? [{ ...c, mine: true, text: sent.get(c.id), from: null }]
    : c.from === ownOrigin ? [] : [{ ...c, mine: false }]));
}

export async function loadFeed(db, ownOrigin) {
  const { results: connections } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL
    ORDER BY name COLLATE NOCASE LIMIT ?`).bind(MAX_SITES).all();
  const replies = await Promise.all(connections.map(async (connection) => {
    try {
      const feed = await callSite(connection.origin, "/_peer/feed", { key: connection.their_key });
      return { connection, feed: cleanFeed(feed, connection.origin) };
    } catch (error) {
      return { connection, error: error.message };
    }
  }));
  // Keep names up to date if a friend changes theirs.
  const renamed = replies.filter((r) => r.feed?.name && r.feed.name !== r.connection.name);
  if (renamed.length) {
    await db.batch(renamed.map((r) => db.prepare("UPDATE connections SET name = ? WHERE id = ?").bind(r.feed.name, r.connection.id)));
    for (const r of renamed) r.connection.name = r.feed.name;
  }
  for (const r of replies) if (r.feed) r.connection.avatar = r.feed.avatar;
  const pictures = replies.map((r) => r.feed?.avatar && rememberPicture(db, r.connection, r.feed.avatar)).filter(Boolean);
  if (pictures.length) await db.batch(pictures);
  const posts = [];
  for (const r of replies) {
    for (const p of r.feed?.posts ?? []) {
      posts.push({ ...p, connection: r.connection, comments: await markMine(db, r.connection.id, p.key, p.comments, ownOrigin) });
    }
  }
  posts.sort((a, b) => b.created_at - a.created_at);
  return { posts, connections, unreachable: replies.filter((r) => r.error) };
}

export async function handleFeed(request, env, url) {
  const db = env.DB;
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });

  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/feed"), url), url.origin);
  if (url.pathname === "/_feed/comments") {
    const connection = await connectionById(db, form.get("connection"));
    const target = String(form.get("target") ?? "");
    const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
    if (!connection) return problem("You're no longer connected with them.", back);
    if (!TARGET_RE.test(target)) return problem("That isn't something you can comment on.", back);
    if (!text) return Response.redirect(back, 303);
    if (text.length > MAX_COMMENT) return problem(`Comments can be up to ${MAX_COMMENT} characters.`, back);
    const owner = await db.prepare("SELECT name FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1").first();
    try {
      const reply = await callSite(connection.origin, "/_peer/comments", {
        key: connection.their_key,
        body: {
          "@context": "https://www.w3.org/ns/activitystreams", type: "Note", mediaType: "text/plain", content: text,
          attributedTo: { type: "Person", id: actorId(url.origin), name: owner?.name }, inReplyTo: targetId(connection.origin, target),
        },
      });
      // Their address for it: <the post's or photo's address>#c<n>.
      const n = /#c(\d{1,15})$/.exec(typeof reply.id === "string" ? reply.id : "");
      if (!n || reply.id !== commentId(connection.origin, target, n[1])) throw new Error("Their site sent something unexpected.");
      const id = Number(n[1]);
      await db.prepare(`INSERT INTO comments_elsewhere (connection_id, site, remote_id, target, text, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(connection.id, connection.origin, id, target, text, now()).run();
      back.hash = `r${connection.id}-${id}`;
      return Response.redirect(back, 303);
    } catch (error) {
      return problem(`Couldn't send your comment: ${error.message}`, back);
    }
  }
  const del = /^\/_feed\/comments\/(\d+)\/(\d+)\/delete$/.exec(url.pathname);
  if (del) {
    const connection = await connectionById(db, del[1]);
    if (!connection) return problem("You're no longer connected with them.", back);
    try {
      await callSite(connection.origin, `/_peer/comments/${Number(del[2])}/delete`, { key: connection.their_key, body: {} });
      await db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ? AND remote_id = ?").bind(connection.id, Number(del[2])).run();
      return Response.redirect(back, 303);
    } catch (error) {
      return problem(`Couldn't delete your comment: ${error.message}`, back);
    }
  }
  return new Response("Not found", { status: 404 });
}

const problem = (message, back = null) =>
  html(messagePage(message, { href: back ? back.pathname + back.search : "/feed", label: "Go back" }), 400);
