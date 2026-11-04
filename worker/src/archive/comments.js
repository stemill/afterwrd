// Comments the owner writes on their own site, under their posts and photos (friends' comments arrive through
// /_peer/comments from their own sites). They show straight away; the author or the owner can delete one. Forms post here and land back on the page they came from:
//   POST /_comments                 target, text, back
//   POST /_comments/<id>/delete     back
// See migrations/0006_site_comments.sql for how `target` survives a re-import.
import { postKey } from "../../public/static/activity.js";
import { safeNext } from "../auth.js";
import { messagePage } from "../pages.js";
import { html, now } from "../util.js";
import { INBOX_JOIN, notifyComment } from "../notify.js";

export const MAX_COMMENT = 2000;
// Plenty for a conversation, too few for a runaway script.
const RATE = { count: 30, seconds: 600 };
const DAILY = 200; // from one person in a day, whatever the pace
const TARGET_RE = /^(?:post-(\d+)-[0-9a-f]{8}|photo-([0-9a-f]{64}))$/;

export { postKey };
export const photoKey = (m) => (m.hash ? `photo-${m.hash}` : null);

const COMMENT_SQL = `
  SELECT c.*, COALESCE(u.name, c.author_name) AS name, COALESCE(u.is_owner, 0) AS author_is_owner FROM site_comments c
  LEFT JOIN users u ON u.id = c.author_id`;

/** Map of target -> its comments, oldest first. */
export async function loadThreads(db, keys) {
  const wanted = [...new Set(keys.filter(Boolean))];
  const threads = new Map(wanted.map((k) => [k, []]));
  if (!wanted.length) return threads;
  const { results } = await db.prepare(`${COMMENT_SQL} WHERE c.target IN (${wanted.map(() => "?").join(",")})
    ORDER BY c.created_at, c.id`).bind(...wanted).all();
  for (const c of results) threads.get(c.target).push(c);
  return threads;
}

// Notifications: comments here (site_comments), and comments on friends' posts and photos the owner has commented on
// too, which their sites send (inbox, see notify.js). One list, newest first.
const NOTIFICATIONS_SQL = `
  SELECT 'here' AS source, c.id, c.target, c.text, c.created_at, COALESCE(u.name, c.author_name) AS name, c.author_id,
    NULL AS connection_id, NULL AS friend
  FROM site_comments c LEFT JOIN users u ON u.id = c.author_id
  UNION ALL
  SELECT 'friend', i.id, i.target, i.text, i.created_at, i.actor, NULL, i.connection_id, co.name
  FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment'`;

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
    (SELECT COUNT(*) FROM site_comments WHERE created_at > ?1 AND (author_id IS NULL OR author_id != ?2))
    + (SELECT COUNT(*) FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment' AND i.created_at > ?1) AS n`)
    .bind(user.activity_seen_at ?? 0, user.id).first();
  return row.n;
}

/** The post or photo a target names, if it's still in the archive: { post } or { photo }. */
export async function findTarget(db, target) {
  const match = TARGET_RE.exec(target ?? "");
  if (!match) return null;
  if (match[2]) {
    const photo = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY id LIMIT 1").bind(match[2]).first();
    return photo && { photo };
  }
  const { results } = await db.prepare("SELECT * FROM posts WHERE timestamp = ? ORDER BY id").bind(Number(match[1])).all();
  const post = results.find((p) => postKey(p) === target);
  return post && { post };
}

export async function handleComments(request, env, url, user, work) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
  const db = env.DB;

  if (url.pathname === "/_comments") {
    const target = String(form.get("target") ?? "");
    const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) return Response.redirect(back, 303);
    if (text.length > MAX_COMMENT) return message(`Comments can be up to ${MAX_COMMENT} characters.`, back, 400);
    if (!(await findTarget(db, target))) return message("That's no longer in the archive.", back, 404);
    // The limits are checked in the same statement as the insert, so comments sent all at once can't slip past.
    const row = await db.prepare(`INSERT INTO site_comments (target, author_id, author_name, text, created_at, origin)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT COUNT(*) FROM site_comments WHERE author_id = ?2 AND created_at > ?5 - ?7) < ?8
        AND (SELECT COUNT(*) FROM site_comments WHERE author_id = ?2 AND created_at > ?5 - 86400) < ?9
      RETURNING id`).bind(target, user.id, user.name, text, now(), user.site ?? "site", RATE.seconds, RATE.count, DAILY).first();
    if (!row) return message("That's a lot of comments for now. Try again later.", back, 429);
    await notifyComment(env, work, url.origin, target, { name: user.name, text });
    back.hash = `c${row.id}`;
    return Response.redirect(back, 303);
  }

  const del = /^\/_comments\/(\d+)\/delete$/.exec(url.pathname);
  if (del) {
    const comment = await db.prepare("SELECT * FROM site_comments WHERE id = ?").bind(Number(del[1])).first();
    if (comment && (comment.author_id === user.id || user.is_owner)) {
      await db.prepare("DELETE FROM site_comments WHERE id = ?").bind(comment.id).run();
      back.hash = `t-${comment.target}`;
    }
    return Response.redirect(back, 303);
  }
  return new Response("Not found", { status: 404 });
}

function message(text, back, status) {
  return html(messagePage(text, { href: back.pathname + back.search, label: "Go back" }), status);
}
