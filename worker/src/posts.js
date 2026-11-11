// The owner's new posts, written with the composer on Posts (public/static/compose.js, which uploads the photos
// through the import's file endpoints first):
//   POST /_admin/posts                {text, photos: [{hash, thumb_hash, width, height, size}], poll?: {options, multiple,
//                                     closes_at}}: a poll asks the post's words (polls.js)
//   POST /_admin/posts/<id>/delete    a form on the post itself
//   POST /_admin/posts/<id>/vote      choice (one, or several if the poll takes more), back: the owner answers their poll
//   POST /_admin/posts/<id>/close     back: the owner closes their poll
// They're kept in site_posts and site_photos (with albums in site_albums, photos.js) and copied into the archive's
// tables by mirror().
import { photoKey, postKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { html, json, now, Refusal } from "./util.js";
import { notifyNewPost } from "./notify.js";
import { safeNext } from "./auth.js";
import { answerHere, readPoll } from "./polls.js";
import { messagePage } from "./views/pages.js";

// Copies take ids from here up, far beyond any an import gives out.
export const SITE_ID = 1_000_000_000;
const ALBUM = "Posted on afterwrd"; // photos posted without an album of their own
const MAX_TEXT = 5000;
const MAX_PHOTOS = 20;
const MAX_SIDE = 20_000;

/**
 * Statements that rebuild the archive's copy of the owner's posts, albums and photos; run with every change and
 * every import. A site album n becomes album SITE_ID + n; SITE_ID itself is "Posted on afterwrd".
 */
export function mirror(db) {
  return [
    db.prepare("DELETE FROM posts WHERE id >= ?").bind(SITE_ID),
    db.prepare("DELETE FROM media WHERE id >= ?").bind(SITE_ID),
    db.prepare("DELETE FROM albums WHERE id >= ?").bind(SITE_ID),
    db.prepare(`INSERT INTO posts (id, timestamp, kind, title, text)
      SELECT ?1 + p.id, p.created_at,
        CASE WHEN EXISTS (SELECT 1 FROM site_photos f WHERE f.post_id = p.id) THEN 'photo' ELSE 'status' END,
        COALESCE(p.title, 'Posted on afterwrd.'), p.text
      FROM site_posts p`).bind(SITE_ID),
    db.prepare(`INSERT INTO media (id, path, kind, timestamp, width, height, album_id, post_id, hash, thumb_hash, size, type)
      SELECT ?1 + f.id, 'afterwrd/' || f.hash || '.jpg', 'photo', COALESCE(f.created_at, p.created_at), f.width, f.height,
        CASE WHEN f.album_id IS NULL THEN ?1 ELSE ?1 + f.album_id END, CASE WHEN f.post_id IS NULL THEN NULL ELSE ?1 + f.post_id END,
        f.hash, f.thumb_hash, f.size, 'image/jpeg'
      FROM site_photos f LEFT JOIN site_posts p ON p.id = f.post_id`).bind(SITE_ID),
    db.prepare(`INSERT INTO albums (id, name, last_modified, cover_media_id)
      SELECT ?1, ?2, MAX(timestamp), MAX(id) FROM media WHERE album_id = ?1 HAVING COUNT(*) > 0`).bind(SITE_ID, ALBUM),
    db.prepare(`INSERT INTO albums (id, name, description, last_modified, cover_media_id)
      SELECT ?1 + a.id, a.name, a.description,
        (SELECT MAX(timestamp) FROM media WHERE album_id = ?1 + a.id), (SELECT MAX(id) FROM media WHERE album_id = ?1 + a.id)
      FROM site_albums a`).bind(SITE_ID),
  ];
}

/** An error message if these uploaded photos' details aren't right, or they aren't all stored yet; else null. */
export async function checkPhotos(env, photos, max = MAX_PHOTOS) {
  if (!Array.isArray(photos) || photos.length > max) return `Up to ${max} photos at a time.`;
  const side = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_SIDE;
  if (!photos.every((f) => f && HASH_RE.test(f.hash) && HASH_RE.test(f.thumb_hash) && side(f.width) && side(f.height)
    && Number.isSafeInteger(f.size) && f.size > 0)) {
    return "Unexpected photo details.";
  }
  const hashes = [...new Set(photos.flatMap((f) => [f.hash, f.thumb_hash]))];
  const stored = (await Promise.all([...new Set(hashes.map((h) => h[0]))].map((shard) =>
    mediaStore(env, shard).has(hashes.filter((h) => h[0] === shard))))).flat();
  return stored.length === hashes.length ? null : "Some photos didn't finish uploading. Try again.";
}

/** Statements adding photos (in order) to the newest site post if `inPost`, and to a site album if given. */
export function addPhotos(db, photos, { inPost = false, albumId = null } = {}) {
  return photos.map((f) => db.prepare(`INSERT INTO site_photos (post_id, album_id, hash, thumb_hash, width, height, size, created_at)
    VALUES (${inPost ? "(SELECT MAX(id) FROM site_posts)" : "NULL"}, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(albumId, f.hash, f.thumb_hash, f.width, f.height, f.size, now()));
}

/** Deletes stored files nothing in the archive uses any more (a photo can share a file with an imported one). */
export async function removeUnusedFiles(env, files) {
  files = [...new Set(files.filter(Boolean))];
  if (!files.length) return;
  const marks = files.map(() => "?").join(",");
  // …including by an import under way, whose photos are waiting in media_next.
  const importing = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_next'").first();
  // …or, in a group's own Worker, by a post in the group (group_photos).
  const tables = importing ? ["media", "media_next", "group_photos"] : ["media", "group_photos"];
  const { results: used } = await env.DB.prepare(tables.map((t) => `SELECT hash FROM ${t} WHERE hash IN (${marks})
    UNION SELECT thumb_hash FROM ${t} WHERE thumb_hash IN (${marks})`).join(" UNION "))
    .bind(...tables.flatMap(() => [...files, ...files])).all();
  const unused = files.filter((h) => !used.some((u) => u.hash === h));
  await Promise.all([...new Set(unused.map((h) => h[0]))].map((shard) =>
    mediaStore(env, shard).remove(unused.filter((h) => h[0] === shard))));
}

export async function handlePosts(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (url.pathname === "/_admin/posts") {
    try {
      await createPost(env, url.origin, await request.json().catch(() => ({})));
      return json({ ok: true });
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  const del = /^\/_admin\/posts\/(\d+)\/delete$/.exec(url.pathname);
  if (del) {
    await deletePost(env, Number(del[1]));
    return Response.redirect(`${url.origin}/posts`, 303);
  }
  const poll = /^\/_admin\/posts\/(\d+)\/(vote|close)$/.exec(url.pathname);
  if (poll) {
    const form = await request.formData().catch(() => new FormData());
    const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
    try {
      if (poll[2] === "vote") await answerPoll(env, Number(poll[1]), form.getAll("choice").map(String));
      else await closePoll(env, Number(poll[1]));
    } catch (error) {
      if (error instanceof Refusal) {
        return html(messagePage(error.message, { href: back.pathname + back.search, label: "Go back" }), error.status);
      }
      throw error;
    }
    back.hash = `poll-${poll[1]}`;
    return Response.redirect(back, 303);
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/**
 * A new post: {text, photos: [{hash, thumb_hash, width, height, size}], poll}, the photos already uploaded; with a
 * poll (polls.js readPoll), the text is its question. Friends are told.
 */
export async function createPost(env, origin, body) {
  const db = env.DB;
  const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (text.length > MAX_TEXT) throw new Refusal(`Posts can be up to ${MAX_TEXT} characters.`);
  const { poll, error } = readPoll(body.poll);
  if (error) throw new Refusal(error);
  if (poll && !text) throw new Refusal("Write the question your poll asks.");
  if (!text && !photos.length) throw new Refusal("Write something or add a photo.");
  const problem = await checkPhotos(env, photos);
  if (problem) throw new Refusal(problem);
  // One transaction: the post, its photos, its poll and the archive's copy.
  await db.batch([
    db.prepare("INSERT INTO site_posts (created_at, text) VALUES (?, ?)").bind(now(), text || null),
    ...addPhotos(db, photos, { inPost: true }),
    ...(poll ? [db.prepare(`INSERT INTO site_polls (post_id, options, multiple, closes_at) VALUES ((SELECT MAX(id) FROM site_posts), ?, ?, ?)`)
      .bind(JSON.stringify(poll.options), poll.multiple, poll.closes_at)] : []),
    ...mirror(db),
  ]);
  await notifyNewPost(env, origin);
}

// Deletes a post made here (by its archive id) and the comments on it. Its photos go too (files included, unless
// something else uses them), apart from any that were added to an album, which stay there. Nothing if it isn't one.
export async function deletePost(env, postId) {
  const db = env.DB;
  const id = postId - SITE_ID;
  const post = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(SITE_ID + id).first();
  if (post && id > 0) {
    const { results: photos } = await db.prepare("SELECT * FROM site_photos WHERE post_id = ?").bind(id).all();
    const going = photos.filter((f) => f.album_id === null);
    // Photo comments are kept by picture, so they go only once no photo here shows it (an imported one can).
    await db.batch([
      db.prepare("DELETE FROM site_comments WHERE target = ?").bind(postKey(post)),
      db.prepare("DELETE FROM site_photos WHERE post_id = ? AND album_id IS NULL").bind(id),
      db.prepare("UPDATE site_photos SET post_id = NULL WHERE post_id = ?").bind(id),
      db.prepare("DELETE FROM site_posts WHERE id = ?").bind(id),
      db.prepare("DELETE FROM site_polls WHERE post_id = ?").bind(id),
      db.prepare("DELETE FROM site_poll_votes WHERE post_id = ?").bind(id),
      ...mirror(db),
      ...going.map((f) => db.prepare("DELETE FROM site_comments WHERE target = ? AND NOT EXISTS (SELECT 1 FROM media WHERE hash = ?)")
        .bind(photoKey(f), f.hash)),
    ]);
    await removeUnusedFiles(env, going.flatMap((f) => [f.hash, f.thumb_hash]));
  }
}

/** The owner answers the poll in their post `postId` (its archive id): `choices`, the options' numbers. */
export async function answerPoll(env, postId, choices) {
  const owner = await env.DB.prepare("SELECT name FROM users LIMIT 1").first();
  const trouble = await answerHere(env.DB, postId - SITE_ID, "site", owner?.name ?? "You", choices);
  if (trouble) throw new Refusal(trouble);
}

/** The owner closes the poll in their post `postId` (its archive id): its answers stay, and no more are taken. */
export async function closePoll(env, postId) {
  await env.DB.prepare("UPDATE site_polls SET closed_at = ? WHERE post_id = ? AND closed_at IS NULL").bind(now(), postId - SITE_ID).run();
}
