// Editing posts and comments (docs/editing-plan.md). The words of a post written here, or of a comment here, can be
// changed for EDIT_SECONDS after it was made, and only until someone else has commented after it (or, on a poll,
// answered it): nobody's reply should end up under words they never saw. Only the words: not photos, not a poll's
// choices. What's replaced is kept (post_versions, comment_versions), shown under "Edited", and goes when the post or
// comment does. The site holding a post or comment decides: a friend's site asks this one (/_peer/comments/<n>/edit).
import { now, Refusal } from "./util.js";

export const EDIT_SECONDS = 15 * 60;
// Edits to any one post or comment: plenty for fixing typos, and a hard limit on what a hostile friend or group member
// can make this site write and keep (each edit keeps a version). Checked in the same statement as the change.
export const MAX_EDITS = 10;
export const MAX_POST_TEXT = 5000;
const EARLIER_SHOWN = 20; // versions kept forever; this many shown (and sent to friends), the newest

// SQL: post p (an alias) can still have its words changed at ?at: written here, new enough, nobody else has commented
// on it, and nobody else has answered its poll. The owner's own comments and answers don't count. An event's words
// change with the event instead (events.js).
const POST_OPEN = (p) => `${p}.source = 'afterwrd' AND ${p}.created_at > ?at - ${EDIT_SECONDS}
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.post_id = ${p}.id)
  AND (SELECT COUNT(*) FROM post_versions h WHERE h.post_id = ${p}.id) < ${MAX_EDITS}
  AND NOT EXISTS (SELECT 1 FROM comments o WHERE o.target = ${p}.key AND NOT (o.origin = 'site' AND o.author_id IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM poll_votes v WHERE v.post_id = ${p}.id AND v.voter != 'site')`;

// SQL: comment c can still be changed at ?at: new enough, and no later comment on the same thing by anyone else.
// (Comment numbers only go up: comments AUTOINCREMENT.) Who wrote it: the owner (origin 'site' with an author_id),
// a friend's site (origin), or, on older sites, a visitor (origin 'site', no author_id).
const SAME_AUTHOR = (a, b) => `(${a}.origin = ${b}.origin AND (${a}.author_id IS NULL) = (${b}.author_id IS NULL))`;
const COMMENT_OPEN = (c) => `${c}.created_at > ?at - ${EDIT_SECONDS}
  AND (SELECT COUNT(*) FROM comment_versions h WHERE h.comment_id = ${c}.id) < ${MAX_EDITS}
  AND NOT EXISTS (SELECT 1 FROM comments l WHERE l.target = ${c}.target AND l.id > ${c}.id AND NOT ${SAME_AUTHOR("l", c)})`;

/** Statements removing versions whose post or comment has gone. Add to any batch that deletes posts or comments. */
export const versionsGone = (db) => [
  db.prepare("DELETE FROM post_versions WHERE post_id NOT IN (SELECT id FROM posts)"),
  db.prepare("DELETE FROM comment_versions WHERE comment_id NOT IN (SELECT id FROM comments)"),
];

/** The same for the owner's copies of their comments on friends' sites. */
export const elsewhereVersionsGone = (db) =>
  db.prepare("DELETE FROM comments_elsewhere_versions WHERE comment_id NOT IN (SELECT id FROM comments_elsewhere)");

// --- the owner's posts ------------------------------------------------------------------------------------------------

// Lists of ids go to D1 as one JSON value (json_each): a statement takes at most 100 bound values, and a page can show
// more comments than that.
const IDS = "(SELECT value FROM json_each(?))";

/** Which of these posts (ids) the owner can still change. */
export async function editablePosts(db, ids, at = now()) {
  if (!ids.length) return new Set();
  const { results } = await db.prepare(`SELECT p.id FROM posts p WHERE p.id IN ${IDS.replace("?", "?2")}
    AND ${POST_OPEN("p").replaceAll("?at", "?1")}`).bind(at, JSON.stringify(ids)).all();
  return new Set(results.map((r) => r.id));
}

/**
 * The owner changes the words of their post `postId`. Refuses (Refusal) if it can't be changed, or the words won't
 * do; does nothing if they're the same. Returns { key } (its address).
 */
export async function editPost(env, postId, words) {
  const db = env.DB;
  const text = typeof words === "string" ? words.replace(/\r\n?/g, "\n").trim() : "";
  const post = await db.prepare(`SELECT p.*, EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id) AS has_photos,
    EXISTS (SELECT 1 FROM polls q WHERE q.post_id = p.id) AS has_poll FROM posts p WHERE p.id = ? AND p.source = 'afterwrd'`)
    .bind(postId).first();
  if (!post) throw new Refusal("That post isn't there any more.", 404);
  if (await db.prepare("SELECT 1 FROM events WHERE post_id = ?").bind(post.id).first()) throw new Refusal("Change an event with its own Change it.");
  if (text.length > MAX_POST_TEXT) throw new Refusal(`Posts can be up to ${MAX_POST_TEXT} characters.`);
  if (!text && post.has_poll) throw new Refusal("A poll needs its question.");
  if (!text && !post.has_photos) throw new Refusal("Write something: a post without photos needs words.");
  if (text === (post.text ?? "")) return { key: post.key };
  const at = now();
  const open = POST_OPEN("posts").replaceAll("?at", "?2");
  const [, changed] = await db.batch([
    db.prepare(`INSERT INTO post_versions (post_id, text, replaced_at) SELECT id, text, ?2 FROM posts WHERE id = ?1 AND ${open}`)
      .bind(post.id, at),
    db.prepare(`UPDATE posts SET text = ?3, edited_at = ?2 WHERE id = ?1 AND ${open}`).bind(post.id, at, text || null),
  ]);
  if (!changed.meta.changes) {
    throw new Refusal(`A post can only be changed ${MAX_EDITS} times, for ${EDIT_SECONDS / 60} minutes after it's posted, and until someone else comments on it or answers it.`, 403);
  }
  return { key: post.key };
}

/** Earlier versions of these posts (ids): Map id -> [{ text, replaced_at }], oldest first (the newest EARLIER_SHOWN). */
export async function postVersions(db, ids) {
  return versionsOf(db, "post_versions", "post_id", ids);
}

// --- comments here ---------------------------------------------------------------------------------------------------

/**
 * Comment `commentId` here is changed by whoever wrote it: `by` is { owner: true } or { origin } (a friend's site).
 * Refuses if they didn't write it, it can't be changed any more, or the words won't do. Returns { target }.
 */
export async function editComment(env, commentId, by, words, maxLength) {
  const db = env.DB;
  const text = typeof words === "string" ? words.replace(/\r\n?/g, "\n").trim() : "";
  if (!text || text.length > maxLength) throw new Refusal(`Comments need 1 to ${maxLength} characters.`, 400);
  const comment = await db.prepare("SELECT * FROM comments WHERE id = ?").bind(commentId).first();
  const theirs = comment && (by.owner ? comment.origin === "site" && comment.author_id !== null : comment.origin === by.origin);
  if (!theirs) throw new Refusal("That comment isn't there any more.", 404);
  if (text === comment.text) return { target: comment.target };
  const at = now();
  const open = COMMENT_OPEN("comments").replaceAll("?at", "?2");
  const [, changed] = await db.batch([
    db.prepare(`INSERT INTO comment_versions (comment_id, text, replaced_at) SELECT id, text, ?2 FROM comments WHERE id = ?1 AND ${open}`)
      .bind(comment.id, at),
    db.prepare(`UPDATE comments SET text = ?3, edited_at = ?2 WHERE id = ?1 AND ${open}`).bind(comment.id, at, text),
  ]);
  if (!changed.meta.changes) {
    throw new Refusal(`A comment can only be changed ${MAX_EDITS} times, for ${EDIT_SECONDS / 60} minutes, and until someone else comments after it.`, 403);
  }
  return { target: comment.target };
}

/** Which of these comments (ids) can still be changed by whoever wrote them. */
export async function editableComments(db, ids, at = now()) {
  if (!ids.length) return new Set();
  const { results } = await db.prepare(`SELECT c.id FROM comments c WHERE c.id IN ${IDS.replace("?", "?2")}
    AND ${COMMENT_OPEN("c").replaceAll("?at", "?1")}`).bind(at, JSON.stringify(ids)).all();
  return new Set(results.map((r) => r.id));
}

/** Earlier versions of these comments (ids): Map id -> [{ text, replaced_at }], oldest first. */
export async function commentVersions(db, ids) {
  return versionsOf(db, "comment_versions", "comment_id", ids);
}

/** Earlier versions of the owner's copies of their comments on friends' sites (comments_elsewhere ids). */
export async function elsewhereVersions(db, ids) {
  return versionsOf(db, "comments_elsewhere_versions", "comment_id", ids);
}

async function versionsOf(db, table, column, ids) {
  const versions = new Map();
  if (!ids.length) return versions;
  // The newest EARLIER_SHOWN of each, counted in SQL, so however many there are, only those are read.
  const { results } = await db.prepare(`SELECT of, text, replaced_at FROM (SELECT ${column} AS of, text, replaced_at, id,
      ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY id DESC) AS n FROM ${table} WHERE ${column} IN ${IDS})
    WHERE n <= ${EARLIER_SHOWN} ORDER BY id`).bind(JSON.stringify(ids)).all();
  for (const v of results) {
    if (!versions.has(v.of)) versions.set(v.of, []);
    versions.get(v.of).push({ text: v.text, replaced_at: v.replaced_at });
  }
  return versions;
}

// Between sites, a post or comment carries its edits as `updated` and `afterwrd:earlier` (activity.js editedFields).

// --- groups: on a group's own Worker (groups.js) ---------------------------------------------------------------------
// The same rules, for whoever wrote it: a member's site, by its origin. An event's own edit (its words and time, at any
// time, telling those going) is separate, so event posts aren't edited here.
const GROUP_POST_OPEN = (p) => `${p}.created_at > ?at - ${EDIT_SECONDS}
  AND (SELECT COUNT(*) FROM group_post_versions h WHERE h.post_id = ${p}.id) < ${MAX_EDITS}
  AND NOT EXISTS (SELECT 1 FROM group_events e WHERE e.post_id = ${p}.id)
  AND NOT EXISTS (SELECT 1 FROM group_comments o WHERE o.post_id = ${p}.id AND o.origin != ${p}.origin)
  AND NOT EXISTS (SELECT 1 FROM group_poll_votes v WHERE v.post_id = ${p}.id AND v.origin != ${p}.origin)`;
const GROUP_COMMENT_OPEN = (c) => `${c}.created_at > ?at - ${EDIT_SECONDS}
  AND (SELECT COUNT(*) FROM group_comment_versions h WHERE h.comment_id = ${c}.id) < ${MAX_EDITS}
  AND NOT EXISTS (SELECT 1 FROM group_comments l WHERE l.post_id = ${c}.post_id AND l.id > ${c}.id AND l.origin != ${c}.origin)`;

/** Statements removing a group's versions whose post or comment has gone. */
export const groupVersionsGone = (db) => [
  db.prepare("DELETE FROM group_post_versions WHERE post_id NOT IN (SELECT id FROM group_posts)"),
  db.prepare("DELETE FROM group_comment_versions WHERE comment_id NOT IN (SELECT id FROM group_comments)"),
];

/** A member (`origin`) changes the words of their post `id` in the group. Refuses (Refusal) as editPost does. */
export async function editGroupPost(db, groupId, origin, id, words, max) {
  const text = typeof words === "string" ? words.replace(/\r\n?/g, "\n").trim() : "";
  const post = await db.prepare(`SELECT p.*, EXISTS (SELECT 1 FROM group_photos f WHERE f.post_id = p.id) AS has_photos,
    EXISTS (SELECT 1 FROM group_polls q WHERE q.post_id = p.id) AS has_poll,
    EXISTS (SELECT 1 FROM group_events e WHERE e.post_id = p.id) AS is_event
    FROM group_posts p WHERE p.id = ? AND p.group_id = ?`).bind(Number(id), groupId).first();
  if (!post || post.origin !== origin) throw new Refusal("That isn't yours, or it's gone.", 404);
  if (post.is_event) throw new Refusal("An event is changed with Change event.", 400);
  if (text.length > max) throw new Refusal(`Posts can be up to ${max} characters.`);
  if (!text && post.has_poll) throw new Refusal("A poll needs its question.");
  if (!text && !post.has_photos) throw new Refusal("Write something: a post without photos needs words.");
  if (text === (post.text ?? "")) return;
  const at = now();
  const open = GROUP_POST_OPEN("group_posts").replaceAll("?at", "?2");
  const [, changed] = await db.batch([
    db.prepare(`INSERT INTO group_post_versions (post_id, text, replaced_at) SELECT id, text, ?2 FROM group_posts WHERE id = ?1 AND ${open}`)
      .bind(post.id, at),
    db.prepare(`UPDATE group_posts SET text = ?3, edited_at = ?2 WHERE id = ?1 AND ${open}`).bind(post.id, at, text || null),
  ]);
  if (!changed.meta.changes) {
    throw new Refusal(`A post can only be changed ${MAX_EDITS} times, for ${EDIT_SECONDS / 60} minutes after it's posted, and until someone else comments on it or answers it.`, 403);
  }
}

/** A member (`origin`) changes the words of their comment `id` in the group. */
export async function editGroupComment(db, groupId, origin, id, words, max) {
  const text = typeof words === "string" ? words.replace(/\r\n?/g, "\n").trim() : "";
  if (!text || text.length > max) throw new Refusal(`Comments need 1 to ${max} characters.`, 400);
  const comment = await db.prepare(`SELECT c.* FROM group_comments c JOIN group_posts p ON p.id = c.post_id
    WHERE c.id = ? AND p.group_id = ?`).bind(Number(id), groupId).first();
  if (!comment || comment.origin !== origin) throw new Refusal("That isn't yours, or it's gone.", 404);
  if (text === comment.text) return;
  const at = now();
  const open = GROUP_COMMENT_OPEN("group_comments").replaceAll("?at", "?2");
  const [, changed] = await db.batch([
    db.prepare(`INSERT INTO group_comment_versions (comment_id, text, replaced_at) SELECT id, text, ?2 FROM group_comments WHERE id = ?1 AND ${open}`)
      .bind(comment.id, at),
    db.prepare(`UPDATE group_comments SET text = ?3, edited_at = ?2 WHERE id = ?1 AND ${open}`).bind(comment.id, at, text),
  ]);
  if (!changed.meta.changes) {
    throw new Refusal(`A comment can only be changed ${MAX_EDITS} times, for ${EDIT_SECONDS / 60} minutes, and until someone else comments after it.`, 403);
  }
}

/** Earlier versions of a group's posts and comments (ids), as postVersions. */
export const groupPostVersions = (db, ids) => versionsOf(db, "group_post_versions", "post_id", ids);
export const groupCommentVersions = (db, ids) => versionsOf(db, "group_comment_versions", "comment_id", ids);

// --- groups: on a member's site (membership.js) -----------------------------------------------------------------------

/** Earlier versions of the owner's own copies of what they posted and said in groups (group_mine ids). */
export const mineVersions = (db, ids) => versionsOf(db, "group_mine_versions", "mine_id", ids);
export const mineVersionsGone = (db) => db.prepare("DELETE FROM group_mine_versions WHERE mine_id NOT IN (SELECT id FROM group_mine)");
