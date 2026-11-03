// What a connected friend's site may ask of this one, using the key this site gave it (see connect.js):
//   GET  /_peer/hello?from=<origin>     who's here; only mid-connect, to prove to <origin> the key is ours for it
//   GET  /_peer/feed                    the owner's newest posts written on afterwrd, with the owner's comments
//                                       and the caller's own (not those of other visitors or other friends)
//   GET  /_peer/files/<sha256>          a photo or thumbnail from one of those posts
//   POST /_peer/comments                a Note inReplyTo one of those posts: their owner comments on it
//   POST /_peer/comments/<n>/delete     their owner deletes a comment they made
//   POST /_peer/ticket                  {next}: a one-time pass for their owner to come in and look round (auth.js)
//   POST /_peer/disconnect              they've disconnected
// The feed and comments are ActivityStreams (public/static/activity.js). Only posts written on afterwrd are
// shared, never the imported archive. Plus the helpers for calling other sites.
import {
  actorId, commentAuthor, commentId, commentNote, CONTEXT, iso, mediaObject, POST_KEY_RE, postId, seconds, tidy,
} from "../public/static/activity.js";
import { findTarget, loadThreads, MAX_COMMENT, postKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { SITE_ID } from "./posts.js";
import { json, now, randomToken, sha256 } from "./util.js";

const FEED_POSTS = 30;
const TIMEOUT_MS = 8000;
const MAX_REPLY = 2_000_000;
const RATE = { count: 30, seconds: 600 };
const DAILY = 300; // comments from one site a day, whatever the pace
const TICKET_SECONDS = 120;
export const KEY_RE = /^[\w-]{40,100}$/;

/** An https site address as an origin, or null. http on this computer only when testing (ALLOW_LOCAL_SITES). */
export function siteOrigin(text, env) {
  try {
    const url = new URL(String(text));
    const local = env?.ALLOW_LOCAL_SITES === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
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
export async function callSite(origin, path, { key, body, timeout = TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
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

/** Statements that end a friend's visits: their sessions here, their person (revoked, kept for their comments). */
export function forgetFriend(db, origin) {
  return [
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE site = ?)").bind(origin),
    db.prepare("UPDATE users SET revoked_at = ? WHERE site = ? AND revoked_at IS NULL").bind(now(), origin),
    db.prepare("DELETE FROM friend_tickets WHERE connection_id IN (SELECT id FROM connections WHERE origin = ?)").bind(origin),
  ];
}

/** The connection whose key this request carries (whether or not it's finished connecting), or null. */
async function peerFrom(request, env) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || !KEY_RE.test(match[1])) return null;
  return env.DB.prepare("SELECT * FROM connections WHERE key_hash = ?").bind(await sha256(match[1])).first();
}

export async function handlePeer(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const peer = await peerFrom(request, env);
  const db = env.DB;

  // Mid-connect, the site we're connecting to asks whether this key is ours. Only for a connection still being
  // made, and only to that very site: otherwise a site we're connected with could show our key to a third site
  // and pass itself off as us.
  if (route === "GET /_peer/hello") {
    const asker = siteOrigin(url.searchParams.get("from"), env);
    if (!peer || peer.connected_at || !asker || peer.origin !== asker) return json({ error: "Not connected." }, 401);
    return json({ name: await ownerName(db) });
  }
  if (!peer?.connected_at) return json({ error: "Not connected." }, 401);

  if (route === "GET /_peer/feed") return json(await feed(db, url.origin, peer));
  if (route === "POST /_peer/disconnect") {
    // The owner's copies of what they said on that site (comments_elsewhere) stay: they're theirs.
    await db.batch([...forgetFriend(db, peer.origin), db.prepare("DELETE FROM connections WHERE id = ?").bind(peer.id)]);
    return json({ ok: true });
  }
  if (route === "POST /_peer/ticket") {
    const body = await request.json().catch(() => ({}));
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM friend_tickets WHERE expires_at < ?").bind(now()),
      db.prepare("INSERT INTO friend_tickets (token_hash, connection_id, next, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(token), peer.id, typeof body.next === "string" ? body.next.slice(0, 500) : "/", now() + TICKET_SECONDS),
    ]);
    return json({ url: `${url.origin}/_auth/friend?ticket=${token}` });
  }

  const file = /^GET \/_peer\/files\/([0-9a-f]{64})$/.exec(route);
  if (file) {
    const shared = await db.prepare("SELECT 1 FROM media WHERE id >= ? AND (hash = ?2 OR thumb_hash = ?2)").bind(SITE_ID, file[1]).first();
    if (!shared) return new Response("Not found", { status: 404 });
    const stored = await mediaStore(env, file[1]).fetch(new Request(`https://media/${file[1]}`));
    return new Response(stored.body, stored);
  }

  if (route === "POST /_peer/comments") {
    const note = await request.json().catch(() => ({}));
    const text = note?.type === "Note" && typeof note.content === "string" ? note.content.replace(/\r\n?/g, "\n").trim() : "";
    if (!text || text.length > MAX_COMMENT) return json({ error: `Comments need 1 to ${MAX_COMMENT} characters.` }, 400);
    const prefix = postId(url.origin, "");
    const target = typeof note.inReplyTo === "string" && note.inReplyTo.startsWith(prefix) ? note.inReplyTo.slice(prefix.length) : "";
    const found = POST_KEY_RE.test(target) && (await findTarget(db, target));
    if (!found?.post || found.post.id < SITE_ID) return json({ error: "That post isn't there any more." }, 404);
    const [recent, today] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM site_comments WHERE origin = ? AND created_at > ?").bind(peer.origin, now() - RATE.seconds),
      db.prepare("SELECT COUNT(*) AS n FROM site_comments WHERE origin = ? AND created_at > ?").bind(peer.origin, now() - 86400),
    ]);
    if (recent.results[0].n >= RATE.count || today.results[0].n >= DAILY) {
      return json({ error: "That's a lot of comments for now. Try again later." }, 429);
    }
    const row = await db.prepare(`INSERT INTO site_comments (target, author_id, author_name, text, created_at, origin)
      VALUES (?, NULL, ?, ?, ?, ?) RETURNING id`).bind(target, peer.name, text, now(), peer.origin).first();
    return json({ id: commentId(url.origin, target, row.id) });
  }

  const del = /^POST \/_peer\/comments\/(\d+)\/delete$/.exec(route);
  if (del) {
    await db.prepare("DELETE FROM site_comments WHERE id = ? AND origin = ?").bind(Number(del[1]), peer.origin).run();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

/** The owner's newest afterwrd posts as an OrderedCollection of Notes, each with its photos and replies. */
async function feed(db, site, peer) {
  const owner = { type: "Person", id: actorId(site), name: await ownerName(db) };
  const { results: posts } = await db.prepare("SELECT * FROM posts WHERE id >= ? ORDER BY timestamp DESC, id DESC LIMIT ?")
    .bind(SITE_ID, FEED_POSTS).all();
  const ids = posts.map((p) => p.id);
  const { results: photos } = ids.length ? await db.prepare(`SELECT * FROM media
    WHERE id >= ? AND post_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(SITE_ID, ...ids).all() : { results: [] };
  const keys = posts.map(postKey);
  const threads = await loadThreads(db, keys);
  return tidy({
    "@context": CONTEXT,
    type: "OrderedCollection",
    attributedTo: owner,
    totalItems: posts.length,
    orderedItems: posts.map((p, i) => {
      // Visitors commented for this site's eyes, and other friends for this owner's; neither is passed on.
      const replies = threads.get(keys[i]).filter((c) => c.author_is_owner || c.origin === peer.origin);
      return {
        type: "Note",
        id: postId(site, keys[i]),
        attributedTo: owner.id,
        published: iso(p.timestamp),
        mediaType: "text/plain",
        content: p.text ?? "",
        attachment: photos.filter((m) => m.post_id === p.id).map((m) => mediaObject(site, m)),
        replies: { type: "Collection", totalItems: replies.length, items: replies.map((c) => commentNote(site, c, commentAuthor(site, c))) },
      };
    }),
  });
}

/**
 * A friend's feed as their site (`site`) sent it, in the shape Feed shows: only well-formed parts, and only
 * addresses on their own site.
 */
export function cleanFeed(data, site) {
  const text = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
  const own = (url, prefix) => (typeof url === "string" && url.startsWith(site + prefix) ? url.slice(site.length + prefix.length) : null);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 50) : [];
  const posts = [];
  for (const note of items) {
    const key = own(note?.id, "/posts/");
    const created = seconds(note?.published);
    if (note?.type !== "Note" || !POST_KEY_RE.test(key ?? "") || created === null) continue;
    const photos = (Array.isArray(note.attachment) ? note.attachment.slice(0, 20) : []).flatMap((m) => {
      const hash = own(m?.url, "/files/");
      const thumb = own(m?.preview?.url, "/files/");
      const size = (n) => Number.isSafeInteger(n) && n > 0;
      return m?.type === "Image" && HASH_RE.test(hash ?? "") && HASH_RE.test(thumb ?? "") && size(m.width) && size(m.height)
        ? [{ hash, thumb_hash: thumb, width: m.width, height: m.height, kind: "photo" }] : [];
    });
    // Which comments are the owner's own is decided here (feed.js), not taken from their site.
    const replies = Array.isArray(note.replies?.items) ? note.replies.items.slice(0, 300) : [];
    const comments = replies.flatMap((c) => {
      const n = /^#c(\d{1,15})$/.exec((typeof c?.id === "string" && c.id.startsWith(note.id) && c.id.slice(note.id.length)) || "");
      const name = typeof c?.attributedTo === "string" ? (c.attributedTo === actorId(site) ? data.attributedTo?.name : null)
        : c?.attributedTo?.name;
      const at = seconds(c?.published);
      return c?.type === "Note" && n && text(name, 100) && text(c.content, MAX_COMMENT) && at !== null
        ? [{ id: Number(n[1]), name, text: c.content, created_at: at }] : [];
    });
    posts.push({ key, created_at: created, text: text(note.content, 5000) || null, photos, comments });
  }
  return { name: text(data?.attributedTo?.name, 100), posts };
}
