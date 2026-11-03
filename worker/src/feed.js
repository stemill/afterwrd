// The owner's side of connections: Feed (the newest posts from every connected site, fetched when the page opens),
// friends' posts and photos read from here (friends.js), and comments sent to their sites, which keep them; a
// copy is kept here in comments_elsewhere.
//   GET  /_feed/visit?to=<their site>&next=<path>                go and look round their site, as a friend
//   POST /_feed/comments                                       connection, target, text, back (a form)
//   POST /_feed/comments/<connection>/<remote id>/delete       back (a form)
import { actorId, commentId, targetId } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { cleanFeed } from "./friends.js";
import { messagePage } from "./pages.js";
import { callSite, siteOrigin } from "./peers.js";
import { html, now } from "./util.js";

const MAX_SITES = 40; // each one is a request; the free plan allows 50 per page
const TARGET_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;

export const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL")
  .bind(Number(id) || 0).first();

/** Marks the owner's own comments: the ones this site sent (comments_elsewhere), whatever the friend's site says. */
export async function markMine(db, connectionId, comments) {
  const { results } = await db.prepare("SELECT remote_id FROM comments_elsewhere WHERE connection_id = ?").bind(connectionId).all();
  const mine = new Set(results.map((r) => r.remote_id));
  return comments.map((c) => ({ ...c, mine: mine.has(c.id) }));
}

export async function loadFeed(db) {
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
  const posts = [];
  for (const r of replies) {
    for (const p of r.feed?.posts ?? []) posts.push({ ...p, connection: r.connection, comments: await markMine(db, r.connection.id, p.comments) });
  }
  posts.sort((a, b) => b.created_at - a.created_at);
  return { posts, connections, unreachable: replies.filter((r) => r.error) };
}

export async function handleFeed(request, env, url) {
  const db = env.DB;
  if (request.method === "GET" && url.pathname === "/_feed/visit") {
    const connection = await db.prepare("SELECT * FROM connections WHERE origin = ? AND connected_at IS NOT NULL")
      .bind(siteOrigin(url.searchParams.get("to"), env) ?? "").first();
    if (!connection) return problem("Your site isn't connected with that one. Connect first, from Connections.");
    try {
      const pass = await callSite(connection.origin, "/_peer/ticket", { key: connection.their_key, body: { next: url.searchParams.get("next") ?? "/" } });
      // Only ever on to their own sign-in page.
      if (typeof pass.url !== "string" || !pass.url.startsWith(`${connection.origin}/_auth/friend?ticket=`)) {
        throw new Error("Their site sent something unexpected.");
      }
      return Response.redirect(pass.url, 302);
    } catch (error) {
      return problem(`Couldn't open ${connection.name}'s site: ${error.message}`);
    }
  }
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
