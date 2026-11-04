// Notes between connected sites, so a friend's site can say "something new" without asking every site in turn.
// Queued in the outbox (outbox.js), which sends them in batches to each friend's POST /_peer/notify:
//   a new post here        {type: "Create", object: {type: "Note", id: <the post's address>, content: <its start>}}
//                          to every approved connection
//   a comment here         {type: "Create", object: {type: "Note", inReplyTo: <the post or photo's address>,
//                          content, attributedTo: {name}}} to the approved connections whose owners have commented
//                          on that post or photo, apart from the one who wrote it
// Received (receiveNote, from peers.js): kept in `inbox` only if it's about the sender's own post or photo and, for a
// comment, only if the owner here has commented on it too. Cut to size, rate-limited, pruned after 60 days, and
// shown as text: Notifications lists the comments, and open pages count the posts (live.js).
import { CONTEXT, POST_KEY_RE, postId, postKey, targetId } from "../public/static/activity.js";
import { outbox } from "./outbox.js";
import { SITE_ID } from "./posts.js";
import { now } from "./util.js";

const SNIPPET = 200;
const KEEP_SECONDS = 60 * 86400;
const RATE = { count: 60, seconds: 600 }; // notes from one site
const DAILY = 500;

const snippet = (text, size = SNIPPET) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, size) : "");

// Queues `note` for each connection; the outbox sends them, a batch at a time, and tries again if a site is down.
async function send(env, connections, note) {
  if (connections.length) await outbox(env).send(connections.map((c) => c.id), { "@context": CONTEXT, ...note });
}

/** Tells every friend about the newest post here (call after it's been made and mirrored). */
export async function notifyNewPost(env, origin) {
  const db = env.DB;
  const post = await db.prepare("SELECT * FROM posts WHERE id >= ? ORDER BY timestamp DESC, id DESC LIMIT 1").bind(SITE_ID).first();
  if (!post) return;
  const { results } = await db.prepare(`SELECT id FROM connections
    WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY id`).all();
  await send(env, results, { type: "Create", object: { type: "Note", id: postId(origin, postKey(post)), content: snippet(post.text || post.title) } });
}

/** Tells the friends who've commented on `target` here about a new comment on it, apart from its writer's site. */
export async function notifyComment(env, origin, target, { name, text, from = null }) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT c.id FROM connections c
    JOIN site_comments s ON s.origin = c.origin AND s.target = ?
    WHERE c.connected_at IS NOT NULL AND c.approved_at IS NOT NULL AND c.origin != ? ORDER BY c.id`).bind(target, from ?? "").all();
  await send(env, results, { type: "Create", object: { type: "Note", inReplyTo: targetId(origin, target), content: snippet(text),
    attributedTo: { type: "Person", name: snippet(name, 100) } } });
}

/** A post or photo address on `origin` (the sender's own site) as a key: post-… or photo-<sha256>; else null. */
function keyOn(origin, address) {
  if (typeof address !== "string") return null;
  const posts = postId(origin, "");
  if (address.startsWith(posts)) return POST_KEY_RE.test(address.slice(posts.length)) ? address.slice(posts.length) : null;
  const photos = `${origin}/photos/sha256/`;
  if (address.startsWith(photos)) return /^[0-9a-f]{64}$/.test(address.slice(photos.length)) ? `photo-${address.slice(photos.length)}` : null;
  return null;
}

/** A note from a connected (approved) site: kept, ignored, or refused. Returns [body, status]. */
export async function receiveNote(db, peer, note) {
  const object = note?.type === "Create" && note.object?.type === "Note" ? note.object : null;
  const isComment = typeof object?.inReplyTo === "string";
  const target = object && keyOn(peer.origin, isComment ? object.inReplyTo : object.id);
  if (!target || (!isComment && !target.startsWith("post-"))) return [{ error: "That isn't about something on your site." }, 400];
  // A comment is only news here if this site's owner has commented on that post or photo too.
  if (isComment && !(await db.prepare("SELECT 1 FROM comments_elsewhere WHERE connection_id = ? AND target = ? LIMIT 1")
    .bind(peer.id, target).first())) {
    return [{ ok: true }, 202];
  }
  // The limits, and only one note per post, are checked in the same statement as the insert.
  const at = now();
  const row = await db.prepare(`INSERT INTO inbox (connection_id, kind, target, actor, text, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE (SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND created_at > ?6 - ?7) < ?8
      AND (SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND created_at > ?6 - 86400) < ?9
      AND NOT (?2 = 'post' AND EXISTS (SELECT 1 FROM inbox WHERE connection_id = ?1 AND kind = 'post' AND target = ?3))
    RETURNING id`).bind(peer.id, isComment ? "comment" : "post", target,
    isComment ? snippet(object.attributedTo?.name, 100) || "Someone" : null, snippet(object.content) || null,
    at, RATE.seconds, RATE.count, DAILY).first();
  await db.prepare("DELETE FROM inbox WHERE created_at < ? OR connection_id NOT IN (SELECT id FROM connections)")
    .bind(at - KEEP_SECONDS).run();
  if (!row && isComment) return [{ error: "That's a lot of notes for now." }, 429];
  return [{ ok: true }, 202];
}

/** Notes from a current, approved connection: the join every read of `inbox` uses. */
export const INBOX_JOIN = "JOIN connections co ON co.id = i.connection_id AND co.approved_at IS NOT NULL";
