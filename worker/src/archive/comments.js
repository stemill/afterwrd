// Comments the owner writes on their own site, under their posts and photos (friends' comments arrive through
// /_peer/comments from their own sites). They show straight away; the author or the owner can delete one. Forms post
// here and land back on the page they came from:
//   POST /_comments                 target, text, back
//   POST /_comments/<id>/delete     back
//   POST /_comments/<id>/edit       text, back: the owner changes their own comment (edits.js)
// A comment's `target` is the post's address (posts.key) or the picture's (photo-<sha256>). Only posts and photos made
// on afterwrd take comments, for now: a Facebook post's address may not survive a new download (docs/tables-plan.md).
import { safeNext } from "../auth.js";
import { messagePage } from "../views/pages.js";
import { html, now, Refusal } from "../util.js";
import { INBOX_JOIN, notifyComment } from "../notify.js";
import { commentVersions, EDIT_SECONDS, editableComments, editComment, versionsGone } from "../edits.js";

export const MAX_COMMENT = 2000;
// Plenty for a conversation, too few for a runaway script.
const RATE = { count: 30, seconds: 600 };
const DAILY = 200; // from one person in a day, whatever the pace
const TARGET_RE = /^(?:post-\d+-[0-9a-f]{8}|photo-([0-9a-f]{64}))$/;

export const photoKey = (m) => (m.hash ? `photo-${m.hash}` : null);

const COMMENT_SQL = `
  SELECT c.*, COALESCE(u.name, c.author_name) AS name, (c.author_id IS NOT NULL) AS author_is_owner FROM comments c
  LEFT JOIN users u ON u.id = c.author_id`;

/**
 * Map of target -> its comments, oldest first, each with `earlier` (its earlier versions, if edited) and `editable`
 * (whoever wrote it can still change it: edits.js).
 */
export async function loadThreads(db, keys) {
  const wanted = [...new Set(keys.filter(Boolean))];
  const threads = new Map(wanted.map((k) => [k, []]));
  if (!wanted.length) return threads;
  const { results } = await db.prepare(`${COMMENT_SQL} WHERE c.target IN (${wanted.map(() => "?").join(",")})
    ORDER BY c.id`).bind(...wanted).all();
  // Only comments from the last few minutes can still be changed: ask about those alone.
  const recent = results.filter((c) => c.created_at > now() - EDIT_SECONDS).map((c) => c.id);
  const [earlier, editable] = [await commentVersions(db, results.filter((c) => c.edited_at).map((c) => c.id)), await editableComments(db, recent)];
  // author_is_owner comes back from SQLite as 1/0: a bare 0 would print as "0" under someone else's comment.
  for (const c of results) threads.get(c.target).push({ ...c, author_is_owner: Boolean(c.author_is_owner), earlier: earlier.get(c.id) ?? [],
    editable: editable.has(c.id) });
  return threads;
}

// In a group: what it said (group_inbox, see notify.js), while the owner's still in it.
const GROUP_THERE = "FROM group_inbox i JOIN groups g ON g.id = i.group_id AND g.joined_at IS NOT NULL";

// Notifications: comments here (comments), comments on friends' posts and photos the owner has commented on
// too, which their sites send (inbox, see notify.js), and comments in groups and changes to events there the owner is
// going to. One list, newest first. For a group, `connection_id` is the group, `friend` its name, `target` the post,
// `own_post` whether the owner wrote it, and `kind` NULL for a comment, or 'changed' or 'cancelled' for an event.
const NOTIFICATIONS_SQL = `
  SELECT 'here' AS source, c.id, c.target, c.text, c.created_at, COALESCE(u.name, c.author_name) AS name, c.author_id,
    NULL AS connection_id, NULL AS friend, NULL AS own_post, NULL AS kind
  FROM comments c LEFT JOIN users u ON u.id = c.author_id
  UNION ALL
  SELECT 'friend', i.id, i.target, i.text, i.created_at, i.actor, NULL, i.connection_id, co.name, NULL, NULL
  FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment'

  UNION ALL
  SELECT 'group', i.id, CAST(i.post_id AS TEXT), i.text, i.created_at, i.actor, NULL, g.id, g.name,
    EXISTS (SELECT 1 FROM group_mine m WHERE m.site = g.origin AND m.remote_group = g.remote_id AND m.kind = 'post' AND m.post_id = i.post_id),
    i.kind
  ${GROUP_THERE}`;

/** The newest notifications, for the Notifications page. */
export async function latestComments(db, page, size) {
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${NOTIFICATIONS_SQL})`),
    db.prepare(`SELECT * FROM (${NOTIFICATIONS_SQL}) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(size, (page - 1) * size),
  ]);
  const total = count.results[0].n;
  return { rows: rows.results, paging: { page, total, hasNext: page * size < total } };
}

/** How many notifications arrived since this person last opened Notifications (their own comments aren't news). */
export async function newCount(db, user) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM comments WHERE created_at > ?1 AND (author_id IS NULL OR author_id != ?2))
    + (SELECT COUNT(*) FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment' AND i.created_at > ?1)
    + (SELECT COUNT(*) ${GROUP_THERE} WHERE i.created_at > ?1) AS n`)
    .bind(user.activity_seen_at ?? 0, user.id).first();
  return row.n;
}

/**
 * The post or photo a target names, if it's still here: { post } or { photo }. A picture both imported and posted on
 * afterwrd is found as afterwrd's.
 */
export async function findTarget(db, target) {
  const match = TARGET_RE.exec(target ?? "");
  if (!match) return null;
  if (match[1]) {
    const photo = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1").bind(match[1]).first();
    return photo && { photo };
  }
  const post = await db.prepare("SELECT * FROM posts WHERE key = ?").bind(target).first();
  return post && { post };
}

/** Whether what findTarget found takes comments: only posts and photos made on afterwrd, for now. */
export const commentable = (found) => (found?.post ?? found?.photo)?.source === "afterwrd";

export async function handleComments(request, env, url, user) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
  try {
    if (url.pathname === "/_comments") {
      const made = await addComment(env, url.origin, user, { target: String(form.get("target") ?? ""), text: String(form.get("text") ?? "") });
      if (made) back.hash = `c${made.id}`;
      return Response.redirect(back.href, 303);
    }
    const change = /^\/_comments\/(\d+)\/edit$/.exec(url.pathname);
    if (change) {
      await editComment(env, Number(change[1]), { owner: true }, String(form.get("text") ?? ""), MAX_COMMENT);
      back.hash = `c${change[1]}`;
      return Response.redirect(back.href, 303);
    }
    const del = /^\/_comments\/(\d+)\/delete$/.exec(url.pathname);
    if (del) {
      const gone = await deleteComment(env, Number(del[1]));
      if (gone) back.hash = `t-${gone.target}`;
      return Response.redirect(back.href, 303);
    }
  } catch (error) {
    if (error instanceof Refusal) return message(error.message, back, error.status);
    throw error;
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/** The owner comments on their own post or photo (`target`, its key). Returns { id }, or null if there's nothing to say. */
export async function addComment(env, origin, user, { target, text }) {
  const db = env.DB;
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  if (text.length > MAX_COMMENT) throw new Refusal(`Comments can be up to ${MAX_COMMENT} characters.`, 400);
  const found = await findTarget(db, target);
  if (!found) throw new Refusal("That's no longer here.", 404);
  if (!commentable(found)) throw new Refusal("Only posts and photos added on afterwrd take comments.", 403);
  // The limits are checked in the same statement as the insert, so comments sent all at once can't slip past.
  const row = await db.prepare(`INSERT INTO comments (target, author_id, author_name, text, created_at, origin)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE (SELECT COUNT(*) FROM comments WHERE author_id = ?2 AND created_at > ?5 - ?7) < ?8
      AND (SELECT COUNT(*) FROM comments WHERE author_id = ?2 AND created_at > ?5 - 86400) < ?9
    RETURNING id`).bind(target, user.id, user.name, text, now(), "site", RATE.seconds, RATE.count, DAILY).first();
  if (!row) throw new Refusal("That's a lot of comments for now. Try again later.", 429);
  await notifyComment(env, origin, target, { name: user.name, text });
  return { id: row.id };
}

/** Deletes a comment here. Returns { target } (what it was on), or null if it wasn't here. */
export async function deleteComment(env, id) {
  const db = env.DB;
  const comment = await db.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  if (!comment) return null;
  await db.batch([db.prepare("DELETE FROM comments WHERE id = ?").bind(comment.id), ...versionsGone(db)]);
  return { target: comment.target };
}

function message(text, back, status) {
  return html(messagePage(text, { href: back.pathname + back.search, label: "Go back" }), status);
}
