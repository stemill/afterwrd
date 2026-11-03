// The owner's Feed: the newest posts from every connected site (peers.js), fetched when the page opens. The
// owner's comments go to the friend's site, which keeps them; a copy is kept here in comments_elsewhere.
//   GET  /_feed/files/<connection>/<sha256>                     a photo from their site, passed through
//   POST /_feed/comments                                       connection, target, text (a form)
//   POST /_feed/comments/<connection>/<remote id>/delete       (a form)
import { MAX_COMMENT } from "./archive/comments.js";
import { SERVABLE_TYPES } from "../public/static/import/schema.js";
import { callSite, cleanFeed } from "./peers.js";
import { messagePage } from "./pages.js";
import { html, now } from "./util.js";

// Only photos are shared (posts.js), and afterwrd stores them at most 2560px a side.
const MAX_PHOTO = 25 * 1024 * 1024;

const MAX_SITES = 40; // each one is a request; the free plan allows 50 per page

export async function loadFeed(db) {
  const { results: connections } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL
    ORDER BY name COLLATE NOCASE LIMIT ?`).bind(MAX_SITES).all();
  const replies = await Promise.all(connections.map(async (connection) => {
    try {
      return { connection, feed: cleanFeed(await callSite(connection.origin, "/_peer/feed", { key: connection.their_key })) };
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
  // The owner's own comments are the ones this site sent (comments_elsewhere), whatever the friend's site says.
  const { results: sent } = await db.prepare("SELECT connection_id, remote_id FROM comments_elsewhere").all();
  const mine = new Set(sent.map((s) => `${s.connection_id}-${s.remote_id}`));
  const posts = replies.flatMap((r) => (r.feed?.posts ?? []).map((p) => ({
    ...p, connection: r.connection, comments: p.comments.map((c) => ({ ...c, mine: mine.has(`${r.connection.id}-${c.id}`) })),
  }))).sort((a, b) => b.created_at - a.created_at);
  return { posts, connections, unreachable: replies.filter((r) => r.error) };
}

export async function handleFeed(request, env, url) {
  const db = env.DB;
  const file = /^\/_feed\/files\/(\d+)\/([0-9a-f]{64})$/.exec(url.pathname);
  if (request.method === "GET" && file) {
    const connection = await connectionById(db, file[1]);
    if (!connection) return new Response("Not found", { status: 404 });
    let theirs;
    try {
      theirs = await fetch(`${connection.origin}/_peer/files/${file[2]}`, {
        redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${connection.their_key}` },
      });
    } catch {
      return new Response("Couldn't reach their site", { status: 502 });
    }
    const type = theirs.headers.get("Content-Type");
    if (!theirs.ok || !SERVABLE_TYPES.has(type) || Number(theirs.headers.get("Content-Length")) > MAX_PHOTO) {
      await theirs.body?.cancel();
      return new Response("Not found", { status: 404 });
    }
    // The address is the file's hash, so check it is: then it can be cached for good.
    const bytes = await readCapped(theirs, MAX_PHOTO);
    if (!bytes || (await sha256Hex(bytes)) !== file[2]) return new Response("Not found", { status: 404 });
    return new Response(bytes, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable" } });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });

  const form = await request.formData().catch(() => new FormData());
  if (url.pathname === "/_feed/comments") {
    const connection = await connectionById(db, form.get("connection"));
    const target = String(form.get("target") ?? "");
    const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
    if (!connection) return problem("You're no longer connected with them.");
    if (!text) return Response.redirect(`${url.origin}/feed`, 303);
    if (text.length > MAX_COMMENT) return problem(`Comments can be up to ${MAX_COMMENT} characters.`);
    try {
      const { id } = await callSite(connection.origin, "/_peer/comments", { key: connection.their_key, body: { target, text } });
      if (!Number.isSafeInteger(id)) throw new Error("Their site sent something unexpected.");
      await db.prepare(`INSERT INTO comments_elsewhere (connection_id, remote_id, target, text, created_at)
        VALUES (?, ?, ?, ?, ?)`).bind(connection.id, id, target, text, now()).run();
      return Response.redirect(`${url.origin}/feed#r${connection.id}-${id}`, 303);
    } catch (error) {
      return problem(`Couldn't send your comment: ${error.message}`);
    }
  }
  const del = /^\/_feed\/comments\/(\d+)\/(\d+)\/delete$/.exec(url.pathname);
  if (del) {
    const connection = await connectionById(db, del[1]);
    if (!connection) return problem("You're no longer connected with them.");
    try {
      await callSite(connection.origin, `/_peer/comments/${Number(del[2])}/delete`, { key: connection.their_key, body: {} });
      await db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ? AND remote_id = ?").bind(connection.id, Number(del[2])).run();
      return Response.redirect(`${url.origin}/feed`, 303);
    } catch (error) {
      return problem(`Couldn't delete your comment: ${error.message}`);
    }
  }
  return new Response("Not found", { status: 404 });
}

async function readCapped(response, limit) {
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL")
  .bind(Number(id) || 0).first();

const problem = (message) => html(messagePage(message, { href: "/feed", label: "Back to Feed" }), 400);
