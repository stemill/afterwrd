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
//
// Groups work the same way, through POST /_member/notify: a group's Worker sends a comment on one of its posts to the
// members' sites whose owners wrote that post or commented on it (notifyGroupComment). New posts in a group aren't sent
// anywhere: members' sites read the group when they open it. A member's site keeps a note in `group_inbox` only if its
// owner wrote or commented on that post there (receiveGroupNote). The only other note a group sends is to those going
// to an event (or who might) when it changes or is called off (notifyEventChange); a member's site keeps it only if
// its owner still has plans for that event (group_plans).
import { CONTEXT, groupPostId, POST_KEY_RE, postId, postKey, targetId } from "../public/static/activity.js";
import { eventObject, eventWhen, parseEvent } from "./calendar.js";
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

/**
 * In a group's Worker: tells the members' sites that will want to know about a new comment (`id`) on `post`:
 * its writer's and those of everyone else who's commented on it, apart from the comment's own writer (`from`).
 */
export async function notifyGroupComment(env, site, group, post, { id, name, text, from }) {
  const { results } = await env.DB.prepare(`SELECT id FROM group_members WHERE group_id = ?1 AND approved_at IS NOT NULL AND origin != ?2
    AND (origin = ?3 OR origin IN (SELECT origin FROM group_comments WHERE post_id = ?4 AND origin IS NOT NULL)) ORDER BY id`)
    .bind(group.id, from, post.origin, post.id).all();
  if (!results.length) return;
  const address = groupPostId(site, group.id, post.id);
  await outbox(env).sendToMembers(results.map((r) => r.id), { "@context": CONTEXT, type: "Create", object: { type: "Note",
    id: `${address}#c${id}`, inReplyTo: address, content: snippet(text), attributedTo: { type: "Person", name: snippet(name, 100) } } });
}

/**
 * In a group's Worker: tells the sites of the members going to an event, or who might, that it's changed or been
 * called off (`kind`), apart from whoever did it (`from`). Nothing else about events is sent to anyone.
 */
export async function notifyEventChange(env, site, group, post, event, { kind, name, from }) {
  const { results } = await env.DB.prepare(`SELECT m.id FROM group_members m JOIN group_answers a ON a.origin = m.origin AND a.post_id = ?1
    WHERE m.group_id = ?2 AND m.approved_at IS NOT NULL AND m.origin != ?3 AND a.answer IN ('going', 'maybe') ORDER BY m.id`)
    .bind(post.id, group.id, from).all();
  if (!results.length) return;
  await outbox(env).sendToMembers(results.map((r) => r.id), { "@context": CONTEXT, type: "Update", "afterwrd:change": kind,
    actor: { type: "Person", name: snippet(name, 100) },
    object: { type: "Note", id: groupPostId(site, group.id, post.id), "afterwrd:event": eventObject(event) } });
}

/**
 * A group's note that an event the owner here is going to (or might) has changed or been called off: their copy of
 * it is brought up to date, and the note kept. Ignored if they've no plans for it.
 */
async function receiveEventNote(db, group, note) {
  const prefix = groupPostId(group.origin, group.remote_id, "");
  const id = typeof note.object?.id === "string" && note.object.id.startsWith(prefix) ? note.object.id.slice(prefix.length) : "";
  const event = parseEvent(note.object?.["afterwrd:event"]);
  const kind = note["afterwrd:change"];
  if (!/^\d{1,15}$/.test(id) || !event || (kind !== "changed" && kind !== "cancelled")) return [{ error: "That isn't about an event in this group." }, 400];
  const at = now();
  if (kind === "cancelled") event.cancelled_at ??= at;
  const plan = await db.prepare(`UPDATE group_plans SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, time_zone = ?, place = ?,
    cancelled_at = ?, updated_at = ? WHERE group_id = ? AND post_id = ? RETURNING answer`).bind(event.title, event.starts_at, event.ends_at,
    event.all_day, event.time_zone, event.place, event.cancelled_at, at, group.id, Number(id)).first();
  if (!plan) return [{ ok: true }, 202];
  const words = `${event.title} · ${eventWhen(event)}${event.place ? ` · ${event.place}` : ""}`;
  const row = await db.prepare(`INSERT INTO group_inbox (group_id, post_id, actor, text, created_at, kind)
    SELECT ?1, ?2, ?3, ?4, ?5, ?9
    WHERE (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND created_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND created_at > ?5 - 86400) < ?8
    RETURNING id`).bind(group.id, Number(id), snippet(note.actor?.name, 100) || "Someone", snippet(words, 400), at,
    RATE.seconds, RATE.count, DAILY, kind).first();
  return row ? [{ ok: true }, 202] : [{ error: "That's a lot of notes for now." }, 429];
}

/** A note from a group the owner here is in: kept, ignored, or refused. Returns [body, status]. */
export async function receiveGroupNote(db, group, note) {
  if (note?.type === "Update" && note.object?.type === "Note") return receiveEventNote(db, group, note);
  const object = note?.type === "Create" && note.object?.type === "Note" ? note.object : null;
  const prefix = groupPostId(group.origin, group.remote_id, "");
  const post = typeof object?.inReplyTo === "string" && object.inReplyTo.startsWith(prefix) ? object.inReplyTo.slice(prefix.length) : "";
  if (!/^\d{1,15}$/.test(post)) return [{ error: "That isn't about a post in this group." }, 400];
  // Only news if the owner here wrote that post or commented on it.
  if (!(await db.prepare("SELECT 1 FROM group_mine WHERE site = ? AND remote_group = ? AND post_id = ? LIMIT 1")
    .bind(group.origin, group.remote_id, Number(post)).first())) {
    return [{ ok: true }, 202];
  }
  const at = now();
  const row = await db.prepare(`INSERT INTO group_inbox (group_id, post_id, actor, text, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND created_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND created_at > ?5 - 86400) < ?8
    RETURNING id`).bind(group.id, Number(post), snippet(object.attributedTo?.name, 100) || "Someone", snippet(object.content) || null,
    at, RATE.seconds, RATE.count, DAILY).first();
  await db.prepare("DELETE FROM group_inbox WHERE created_at < ? OR group_id NOT IN (SELECT id FROM groups)").bind(at - KEEP_SECONDS).run();
  return row ? [{ ok: true }, 202] : [{ error: "That's a lot of notes for now." }, 429];
}

/** Notes from a current, approved connection: the join every read of `inbox` uses. */
export const INBOX_JOIN = "JOIN connections co ON co.id = i.connection_id AND co.approved_at IS NOT NULL";
