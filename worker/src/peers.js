// What a connected friend's site may ask of this one, using the key this site gave it (see connect.js):
//   GET  /_peer/hello                   who's here (also works mid-connect, to prove the key is theirs)
//   GET  /_peer/feed                    the owner's newest posts written on afterwrd, with their comments
//   GET  /_peer/files/<sha256>          a photo or thumbnail from one of those posts
//   POST /_peer/comments                {target, text}: their owner comments on one of those posts
//   POST /_peer/comments/<id>/delete    their owner deletes a comment they made
//   POST /_peer/disconnect              they've disconnected
// Only posts written on afterwrd are shared, never the imported archive. Plus the helpers for calling them back.
import { findTarget, loadThreads, MAX_COMMENT, postKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { SITE_ID } from "./posts.js";
import { json, now, sha256 } from "./util.js";

const FEED_POSTS = 30;
const TIMEOUT_MS = 8000;
const MAX_REPLY = 2_000_000;
const RATE = { count: 30, seconds: 600 };
export const KEY_RE = /^[\w-]{40,100}$/;

/** An https site address (or http on this computer, for testing) as an origin, or null. */
export function siteOrigin(text) {
  try {
    const url = new URL(String(text));
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol === "https:" || local) && !url.username && !url.password) return url.origin;
  } catch {}
  return null;
}

export const host = (origin) => new URL(origin).host;

export async function ownerName(db) {
  const owner = await db.prepare("SELECT name FROM users WHERE is_owner = 1 AND revoked_at IS NULL ORDER BY id LIMIT 1").first();
  return owner?.name ?? "Someone";
}

/** Calls another site, JSON both ways; throws with a message fit to show the owner. */
export async function callSite(origin, path, { key, body } = {}) {
  let response;
  try {
    response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error(`Couldn't reach ${host(origin)}.`);
  }
  let data = {};
  try {
    data = JSON.parse(await readLimited(response, MAX_REPLY));
  } catch {}
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `${host(origin)} answered ${response.status}.`);
  }
  return data;
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Reply too big.");
    }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

/** The connection whose key this request carries, or null. */
export async function peerFrom(request, env, { pending = false } = {}) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || !KEY_RE.test(match[1])) return null;
  const connection = await env.DB.prepare("SELECT * FROM connections WHERE key_hash = ?").bind(await sha256(match[1])).first();
  return connection && (pending || connection.connected_at) ? connection : null;
}

export async function handlePeer(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const peer = await peerFrom(request, env, { pending: route === "GET /_peer/hello" });
  if (!peer) return json({ error: "Not connected." }, 401);
  const db = env.DB;

  if (route === "GET /_peer/hello") return json({ name: await ownerName(db) });
  if (route === "GET /_peer/feed") return json({ name: await ownerName(db), posts: await feed(db, peer) });
  if (route === "POST /_peer/disconnect") {
    await db.batch([
      db.prepare("DELETE FROM connections WHERE id = ?").bind(peer.id),
      db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ?").bind(peer.id),
    ]);
    return json({ ok: true });
  }

  const file = /^GET \/_peer\/files\/([0-9a-f]{64})$/.exec(route);
  if (file) {
    const shared = await db.prepare("SELECT 1 FROM media WHERE id >= ? AND (hash = ?2 OR thumb_hash = ?2)").bind(SITE_ID, file[1]).first();
    if (!shared) return new Response("Not found", { status: 404 });
    const stored = await mediaStore(env, file[1]).fetch(new Request(`https://media/${file[1]}`));
    return new Response(stored.body, stored);
  }

  if (route === "POST /_peer/comments") {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
    if (!text || text.length > MAX_COMMENT) return json({ error: `Comments need 1 to ${MAX_COMMENT} characters.` }, 400);
    const found = await findTarget(db, String(body.target ?? ""));
    if (!found?.post || found.post.id < SITE_ID) return json({ error: "That post isn't there any more." }, 404);
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM site_comments WHERE origin = ? AND created_at > ?")
      .bind(peer.origin, now() - RATE.seconds).first();
    if (recent.n >= RATE.count) return json({ error: "That's a lot of comments in a few minutes. Try again shortly." }, 429);
    const row = await db.prepare(`INSERT INTO site_comments (target, author_id, author_name, text, created_at, origin)
      VALUES (?, NULL, ?, ?, ?, ?) RETURNING id`).bind(body.target, peer.name, text, now(), peer.origin).first();
    return json({ id: row.id });
  }

  const del = /^POST \/_peer\/comments\/(\d+)\/delete$/.exec(route);
  if (del) {
    await db.prepare("DELETE FROM site_comments WHERE id = ? AND origin = ?").bind(Number(del[1]), peer.origin).run();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

async function feed(db, peer) {
  const { results: posts } = await db.prepare("SELECT * FROM posts WHERE id >= ? ORDER BY timestamp DESC, id DESC LIMIT ?")
    .bind(SITE_ID, FEED_POSTS).all();
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const { results: photos } = await db.prepare(`SELECT post_id, hash, thumb_hash, width, height FROM media
    WHERE id >= ? AND post_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(SITE_ID, ...ids).all();
  const keys = posts.map(postKey);
  const threads = await loadThreads(db, keys);
  return posts.map((p, i) => ({
    key: keys[i],
    created_at: p.timestamp,
    text: p.text,
    photos: photos.filter((m) => m.post_id === p.id).map(({ hash, thumb_hash, width, height }) => ({ hash, thumb_hash, width, height })),
    comments: threads.get(keys[i]).map((c) => ({
      id: c.id, name: c.name, text: c.text, created_at: c.created_at,
      from: c.origin === "site" ? null : host(c.origin), mine: c.origin === peer.origin,
    })),
  }));
}

/** A friend's feed as their site sent it, keeping only well-formed parts. */
export function cleanFeed(data) {
  const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const posts = Array.isArray(data?.posts) ? data.posts.slice(0, 50) : [];
  return {
    name: str(data?.name, 100),
    posts: posts.filter((p) => /^post-\d+-[0-9a-f]{8}$/.test(p?.key) && int(p.created_at) !== null).map((p) => ({
      key: p.key,
      created_at: p.created_at,
      text: str(p.text, 5000),
      photos: (Array.isArray(p.photos) ? p.photos.slice(0, 20) : [])
        .filter((m) => HASH_RE.test(m?.hash) && HASH_RE.test(m?.thumb_hash) && int(m.width) && int(m.height))
        .map(({ hash, thumb_hash, width, height }) => ({ hash, thumb_hash, width, height, kind: "photo" })),
      comments: (Array.isArray(p.comments) ? p.comments.slice(0, 300) : [])
        .filter((c) => int(c?.id) !== null && str(c.name, 100) && str(c.text, MAX_COMMENT) && int(c.created_at) !== null)
        .map((c) => ({ id: c.id, name: c.name, text: c.text, created_at: c.created_at, from: str(c.from, 255), mine: c.mine === true })),
    })),
  };
}
