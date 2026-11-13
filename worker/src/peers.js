// What a connected friend's site may ask of this one, using the key this site gave it (see connect.js):
//   GET  /_peer/hello?from=<origin>     who's here; only mid-connect, to prove to <origin> the key is ours for it
//   GET  /_peer/feed                    the owner's newest posts written on afterwrd, with all their comments
//   GET  /_peer/posts?page=n            the owner's posts and photos, for their friend pages, through share.js:
//   GET  /_peer/posts/<key>               posts, one post, albums, an album's photos, one photo; files come as signed
//   GET  /_peer/albums                    links. Only what's shared with the asking friend: a post can be for only
//   GET  /_peer/albums/<key>?page=n       some friends (an event, for those invited)
//   GET  /_peer/photos/<sha256>
//   POST /_peer/comments                a Note inReplyTo a post or photo made on afterwrd: their owner comments on it
//   POST /_peer/comments/<n>/delete     their owner deletes a comment they made
//   POST /_peer/comments/<n>/edit       a Note: their owner changes a comment they made (15 minutes, until someone
//                                       else comments after it: edits.js)
//   POST /_peer/vote                    {inReplyTo: a post here, afterwrd:choices: [n…]}: their owner answers its poll
//                                       (none takes it back); answers with the poll as they now see it (polls.js)
//   POST /_peer/answer                  {type: Accept | TentativeAccept | Reject, object: an event's post here}: their
//                                       owner is going, might go, or can't (events.js); answers with the post as
//                                       they now see it
//   POST /_peer/notify                  a note: something new on their site (notify.js)
//   POST /_peer/message                 a message from their owner to the owner here (messages.js)
//   POST /_peer/introduce               {origin, name, content?}: their owner introduces the owner here to someone
//                                       (connect.js); either can then ask the other to be friends
//   POST /_peer/checked                 {site, version}: their site checked this one and found it genuine (checks.js)
//   POST /_peer/check-request           their owner asks the owner here to check their site (checks.js)
//   POST /_peer/check-token             their site asks for a one-hour read-only token to check this one by itself
//   POST /_peer/check-soon              their site was just updated: check it soon (friendchecks.js)
//   POST /_peer/check-failed            {site, version, problems}: their site checked this one and found something
//   POST /_peer/disconnect              they've disconnected
// The feed and comments are ActivityStreams (public/static/activity.js). The feed and notes carry only posts written
// on afterwrd; friend pages (posts, albums, photos) also show the parts of the Facebook archive the owner has chosen to
// share (share.js), and nothing else, even to a friend who knows a photo's fingerprint. Plus the helpers for calling
// other sites.
import { commentId, CONTEXT, POST_KEY_RE, postId, tidy } from "../public/static/activity.js";
import { commentable, findTarget, MAX_COMMENT } from "./archive/comments.js";
import { editComment, versionsGone } from "./edits.js";
import { notes, ownerActor, photoShared, postShared, SHARED_SQL, shareAlbum, shareAlbums, sharePhoto, sharePost, sharePosts } from "./share.js";
import { json, now, Refusal, sha256 } from "./util.js";
import { notifyComment, receiveNote } from "./notify.js";
import { receiveIntroduction } from "./connect.js";
import { receiveChecked, receiveCheckRequest } from "./checks.js";
import { giveCheckToken, receiveCheckFailed, receiveCheckSoon } from "./friendchecks.js";
import { receiveMessage } from "./messages.js";
import { answerHere, pollObject, sitePolls } from "./polls.js";
import { answerFromFriend, friendGone } from "./events.js";

const FEED_POSTS = 30;
const TIMEOUT_MS = 8000;
const MAX_REPLY = 2_000_000;
const RATE = { count: 30, seconds: 600 };
const DAILY = 300; // comments from one site a day, whatever the pace
export const KEY_RE = /^[\w-]{40,100}$/;
// The version of the protocol between sites (PROTOCOL.md), sent in the hello and ping answers. Adding things doesn't
// change it; anything an older site would misread does.
export const PROTOCOL = 1;

/** An https site address as an origin, or null. http on this computer only when testing (ALLOW_LOCAL_SITES). */
export function siteOrigin(text, env) {
  try {
    const url = new URL(String(text));
    const local = env?.ALLOW_LOCAL_SITES === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    // No trailing dot: "https://you.example." is the same site as "https://you.example", but wouldn't compare equal.
    if ((url.protocol === "https:" || local) && !url.username && !url.password && !url.hostname.endsWith(".")) return url.origin;
  } catch {}
  return null;
}

export const host = (origin) => new URL(origin).host;

export async function ownerName(db) {
  const owner = await db.prepare("SELECT name FROM users LIMIT 1").first();
  return owner?.name ?? "Someone";
}

/**
 * Calls another site, JSON both ways; throws with a message fit to show the owner, and `status`: what their site
 * answered (0: no answer).
 * @param {string} origin
 * @param {string} path
 * @param {{ key?: string, body?: object, timeout?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
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
    throw Object.assign(new Error(`Couldn't reach ${host(origin)}.`), { status: 0 }); // status: what their site answered
  }
  let data = {};
  try {
    data = JSON.parse(await readLimited(response, MAX_REPLY));
  } catch {}
  // Whatever else a site answers (null, a list, a number) counts as saying nothing.
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `${host(origin)} answered ${response.status}.`),
      { status: response.status });
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

/** The connection whose key this request carries (whether or not it's finished connecting), or null. */
async function peerFrom(request, env) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || !KEY_RE.test(match[1])) return null;
  return env.DB.prepare("SELECT * FROM connections WHERE key_hash = ?").bind(await sha256(match[1])).first();
}

// The most a friend's site may send in one request: a message, a comment, a note. (Checked before reading it.)
const MAX_REQUEST = 64 * 1024;

export async function handlePeer(request, env, url, work) {
  const route = `${request.method} ${url.pathname}`;
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_REQUEST) return json({ error: "That's too big." }, 413);
  const peer = await peerFrom(request, env);
  const db = env.DB;

  // Mid-connect, the site we're connecting to asks whether this key is ours. Only for a connection still being
  // made, and only to that very site: otherwise a site we're connected with could show our key to a third site
  // and pass itself off as us.
  if (route === "GET /_peer/hello") {
    const asker = siteOrigin(url.searchParams.get("from"), env);
    if (!peer || peer.connected_at || !asker || peer.origin !== asker) return json({ error: "Not connected." }, 401);
    return json({ name: await ownerName(db), protocol: PROTOCOL });
  }
  if (!peer?.connected_at) return json({ error: "Not connected." }, 401);
  // A connection this site's owner hasn't approved yet gets nothing but the chance to withdraw.
  if (!peer.approved_at && route !== "POST /_peer/disconnect") {
    return json({ error: `Waiting for ${await ownerName(db)} to approve the connection.` }, 403);
  }

  if (route === "GET /_peer/feed") return json(await feed(env, url.origin, peer));
  const page = Math.min(10_000, Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1));
  if (route === "GET /_peer/posts") return json(await sharePosts(env, url.origin, page, await ownerName(db), peer));
  if (route === "GET /_peer/albums") return json(await shareAlbums(env, url.origin));
  const shared = /^GET \/_peer\/(albums\/(\d+|other|videos)|photos\/([0-9a-f]{64})|posts\/(post-\d+-[0-9a-f]{8}))$/.exec(route);
  if (shared) {
    const found = shared[2] ? await shareAlbum(env, url.origin, shared[2], page)
      : shared[3] ? await sharePhoto(env, url.origin, shared[3], peer)
      : await sharePost(env, url.origin, shared[4], await ownerName(db), peer);
    return found ? json(tidy({ "@context": CONTEXT, ...found })) : json({ error: "That isn't there any more." }, 404);
  }
  if (route === "POST /_peer/disconnect") {
    // The owner's copies of what they said on that site (comments_elsewhere) stay: they're theirs.
    await db.batch([
      db.prepare("DELETE FROM connections WHERE id = ?").bind(peer.id),
      db.prepare("DELETE FROM friend_links WHERE connection_id = ?").bind(peer.id),
      db.prepare("DELETE FROM introductions WHERE connection_id = ?").bind(peer.id),
      ...friendGone(db, peer.id),
    ]);
    return json({ ok: true });
  }
  if (route === "POST /_peer/introduce") {
    const [body, status] = await receiveIntroduction(env, url, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/check-request") {
    const [body, status] = await receiveCheckRequest(env, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/check-token") {
    const [body, status] = await giveCheckToken(env, url, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/check-soon") {
    const [body, status] = await receiveCheckSoon(env, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/check-failed") {
    const [body, status] = await receiveCheckFailed(env, url, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/checked") {
    const [body, status] = await receiveChecked(env, url, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_peer/comments") {
    const note = await request.json().catch(() => ({}));
    const text = note?.type === "Note" && typeof note.content === "string" ? note.content.replace(/\r\n?/g, "\n").trim() : "";
    if (!text || text.length > MAX_COMMENT) return json({ error: `Comments need 1 to ${MAX_COMMENT} characters.` }, 400);
    // Connected friends can comment on what they can see that was made on afterwrd: a post, or a photo.
    const reply = typeof note.inReplyTo === "string" ? note.inReplyTo : "";
    const target = reply.startsWith(postId(url.origin, "")) ? reply.slice(postId(url.origin, "").length)
      : reply.startsWith(`${url.origin}/photos/sha256/`) ? `photo-${reply.slice(`${url.origin}/photos/sha256/`.length)}` : "";
    const found = await visibleTarget(db, target, peer);
    // Only what they're shown: something unshared answers as if it weren't there.
    if (!found) return json({ error: "That isn't there any more." }, 404);
    if (!commentable(found)) return json({ error: "Only posts and photos added on afterwrd take comments." }, 403);
    // Limits checked in the same statement as the insert, so comments sent all at once can't slip past.
    const row = await db.prepare(`INSERT INTO comments (target, author_id, author_name, text, created_at, origin)
      SELECT ?1, NULL, ?2, ?3, ?4, ?5
      WHERE (SELECT COUNT(*) FROM comments WHERE origin = ?5 AND created_at > ?4 - ?6) < ?7
        AND (SELECT COUNT(*) FROM comments WHERE origin = ?5 AND created_at > ?4 - 86400) < ?8
      RETURNING id`).bind(target, peer.name, text, now(), peer.origin, RATE.seconds, RATE.count, DAILY).first();
    if (!row) return json({ error: "That's a lot of comments for now. Try again later." }, 429);
    await notifyComment(env, url.origin, target, { name: peer.name, text, from: peer.origin });
    return json({ id: commentId(url.origin, target, row.id) });
  }

  if (route === "POST /_peer/vote") {
    const body = await request.json().catch(() => ({}));
    const reply = typeof body?.inReplyTo === "string" ? body.inReplyTo : "";
    const key = reply.startsWith(postId(url.origin, "")) ? reply.slice(postId(url.origin, "").length) : "";
    // Polls are only ever in posts written here, and answered only by those who can see them.
    const found = await visibleTarget(db, key, peer);
    const id = found?.post?.source === "afterwrd" ? found.post.id : null;
    if (!id) return json({ error: "That isn't there any more." }, 404);
    const trouble = await answerHere(db, id, peer.origin, peer.name, body["afterwrd:choices"]);
    if (trouble) return json({ error: trouble }, 400);
    return json(tidy({ "@context": CONTEXT, "afterwrd:poll": pollObject((await sitePolls(db, [id], peer.origin)).get(id)) }));
  }

  if (route === "POST /_peer/answer") {
    const body = await request.json().catch(() => ({}));
    const answer = { Accept: "going", TentativeAccept: "maybe", Reject: "no" }[body?.type];
    const reply = typeof body?.object === "string" ? body.object : "";
    const key = reply.startsWith(postId(url.origin, "")) ? reply.slice(postId(url.origin, "").length) : "";
    // Only an event they're invited to: anything else answers as if it weren't there.
    const found = await visibleTarget(db, key, peer);
    if (!found?.post || found.post.source !== "afterwrd") return json({ error: "That isn't there any more." }, 404);
    const trouble = answer ? await answerFromFriend(db, found.post.id, peer, answer) : "Answer going, maybe or no.";
    if (trouble) return json({ error: trouble }, 400);
    return json(tidy({ "@context": CONTEXT, ...(await sharePost(env, url.origin, key, await ownerName(db), peer)) }));
  }

  if (route === "POST /_peer/message") {
    const [body, status] = await receiveMessage(env, peer, await request.json().catch(() => ({})), { site: url.origin, work });
    return json(body, status);
  }

  if (route === "POST /_peer/notify") {
    const [body, status] = await receiveNote(db, peer, await request.json().catch(() => ({})));
    return json(body, status);
  }

  // Their own comments only; changing one also needs them still able to see what it's on. (Deleting doesn't: what
  // they said is theirs to take back.)
  const del = /^POST \/_peer\/comments\/(\d+)\/delete$/.exec(route);
  if (del) {
    await db.batch([db.prepare("DELETE FROM comments WHERE id = ? AND origin = ?").bind(Number(del[1]), peer.origin), ...versionsGone(db)]);
    return json({ ok: true });
  }
  const change = /^POST \/_peer\/comments\/(\d+)\/edit$/.exec(route);
  if (change) {
    const note = await request.json().catch(() => ({}));
    const on = await db.prepare("SELECT target FROM comments WHERE id = ? AND origin = ?").bind(Number(change[1]), peer.origin).first();
    if (on && !(await visibleTarget(db, on.target, peer))) return json({ error: "That isn't there any more." }, 404);
    try {
      if (note?.type !== "Note") throw new Refusal("That isn't a comment.", 400);
      await editComment(env, Number(change[1]), { origin: peer.origin }, note.content, MAX_COMMENT);
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      throw error;
    }
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

/**
 * A post or photo here (post-… or photo-<sha256>) that `peer` may see, as findTarget gives it; null if there's no
 * such thing, or it isn't shared with them.
 */
async function visibleTarget(db, target, peer) {
  const found = (POST_KEY_RE.test(target) || /^photo-[0-9a-f]{64}$/.test(target)) && (await findTarget(db, target));
  if (!found) return null;
  return (found.post ? await postShared(db, found.post, peer.id) : await photoShared(db, found.photo, peer.id)) ? found : null;
}

/**
 * The owner's newest afterwrd posts that `peer` may see, as an OrderedCollection of Notes, each with its photos,
 * comments and any poll (with the friend's own answer).
 */
async function feed(env, site, peer) {
  const { results: posts } = await env.DB.prepare(`SELECT p.* FROM posts p WHERE p.source = 'afterwrd' AND ${SHARED_SQL("?1")}
    ORDER BY p.created_at DESC, p.id DESC LIMIT ?2`).bind(peer.id, FEED_POSTS).all();
  return tidy({
    "@context": CONTEXT,
    type: "OrderedCollection",
    attributedTo: await ownerActor(env, site, await ownerName(env.DB)),
    totalItems: posts.length,
    orderedItems: await notes(env, site, posts, { peer }),
  });
}
