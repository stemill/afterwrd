// The owner's new posts, written with the composer on Posts (public/static/compose.js, which uploads the photos
// through the import's file endpoints first):
//   POST /_admin/posts                {text, photos: [{hash, thumb_hash, width, height, size}], poll?: {options, multiple,
//                                     closes_at}}: a poll asks the post's words (polls.js)
//   POST /_admin/posts/<id>/delete    a form on the post itself
//   POST /_admin/posts/<id>/edit      text, back: new words, for 15 minutes and until someone else comments (edits.js)
//   POST /_admin/posts/<id>/vote      choice (one, or several if the poll takes more), back: the owner answers their poll
//   POST /_admin/posts/<id>/close     back: the owner closes their poll
// They're kept in `posts`, with their photos in `media` and albums in `albums` (photos.js), beside Facebook's, as
// source 'afterwrd'. Each post's address (posts.key) is made when it's written and never changes.
import { newPostKey } from "../public/static/activity.js";
import { photoKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { html, json, now, Refusal } from "./util.js";
import { notifyNewPost } from "./notify.js";
import { safeNext } from "./auth.js";
import { answerHere, readPoll } from "./polls.js";
import { editPost, MAX_POST_TEXT, versionsGone } from "./edits.js";
import { messagePage } from "./views/pages.js";

const MAX_TEXT = MAX_POST_TEXT;
const MAX_PHOTOS = 20;
const MAX_SIDE = 20_000;

// Albums afterwrd keeps for a purpose (albums.role): photos posted without an album of their own, and the owner's
// profile pictures and covers.
export const ROLE_ALBUMS = { posts: "Posted on afterwrd", profile: "Profile pictures", cover: "Cover photos" };

/** A statement making the album for `role` (ROLE_ALBUMS), unless there is one. */
export function roleAlbum(db, role) {
  return db.prepare(`INSERT INTO albums (source, name, created_at, role) SELECT 'afterwrd', ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM albums WHERE role = ?)`).bind(ROLE_ALBUMS[role], now(), role, role);
}

/**
 * Statements adding photos (in order) to an album: `albumId`, or else the one for `role`; and to the post whose
 * address is `postKey`, if given.
 */
export function addPhotos(db, photos, { albumId = null, role = null, postKey = null }) {
  return photos.map((f) => db.prepare(`INSERT INTO media (source, path, kind, created_at, width, height, album_id,
      post_id, hash, thumb_hash, size, type)
    VALUES ('afterwrd', ?, 'photo', ?, ?, ?, COALESCE(?, (SELECT id FROM albums WHERE role = ?)),
      (SELECT id FROM posts WHERE key = ?), ?, ?, ?, 'image/jpeg')`)
    .bind(`afterwrd/${f.hash}.jpg`, now(), f.width, f.height, albumId, role, postKey, f.hash, f.thumb_hash, f.size));
}

/** A new post's row: its address, made now. Returns [statement, key]. */
export function newPost(db, { text = null, title = null }) {
  const at = now();
  const key = newPostKey(at);
  return [db.prepare("INSERT INTO posts (key, source, created_at, title, text) VALUES (?, 'afterwrd', ?, ?, ?)")
    .bind(key, at, title, text), key];
}

/**
 * Statements deleting the comments on these photos' pictures (photo-<sha256>), once no photo made on afterwrd shows
 * that picture any more. Run after the photos have gone.
 */
export const photoCommentsGone = (db, photos) => photos.map((f) => db.prepare(`DELETE FROM comments WHERE target = ?
  AND NOT EXISTS (SELECT 1 FROM media WHERE hash = ? AND source = 'afterwrd')`).bind(photoKey(f), f.hash));

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
  const poll = /^\/_admin\/posts\/(\d+)\/(vote|close|edit)$/.exec(url.pathname);
  if (poll) {
    const form = await request.formData().catch(() => new FormData());
    const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
    try {
      if (poll[2] === "edit") {
        const { key } = await editPost(env, Number(poll[1]), String(form.get("text") ?? ""));
        back.hash = `p-${key}`;
        return Response.redirect(back, 303);
      }
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
  // One transaction: the post, its photos (in "Posted on afterwrd") and its poll.
  const [post, key] = newPost(db, { text: text || null });
  await db.batch([
    post,
    ...(photos.length ? [roleAlbum(db, "posts"), ...addPhotos(db, photos, { role: "posts", postKey: key })] : []),
    ...(poll ? [db.prepare(`INSERT INTO polls (post_id, options, multiple, closes_at) VALUES ((SELECT id FROM posts WHERE key = ?), ?, ?, ?)`)
      .bind(key, JSON.stringify(poll.options), poll.multiple, poll.closes_at)] : []),
  ]);
  await notifyNewPost(env, origin, key);
}

/**
 * Deletes a post made here and the comments on it. Its photos go too (files included, unless something else uses
 * them), apart from any that are also in an album of the owner's, which stay there. Nothing if it isn't one.
 */
export async function deletePost(env, postId) {
  const db = env.DB;
  const post = await db.prepare("SELECT * FROM posts WHERE id = ? AND source = 'afterwrd'").bind(postId).first();
  if (!post) return;
  const IN_POSTS = "album_id IN (SELECT id FROM albums WHERE role = 'posts')";
  const { results: going } = await db.prepare(`SELECT * FROM media WHERE post_id = ? AND ${IN_POSTS}`).bind(post.id).all();
  await db.batch([
    db.prepare("DELETE FROM comments WHERE target = ?").bind(post.key),
    db.prepare(`DELETE FROM media WHERE post_id = ? AND ${IN_POSTS}`).bind(post.id),
    db.prepare("UPDATE media SET post_id = NULL WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM polls WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM poll_votes WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(post.id),
    ...photoCommentsGone(db, going),
    ...versionsGone(db),
  ]);
  await removeUnusedFiles(env, going.flatMap((f) => [f.hash, f.thumb_hash]));
}

/** The owner answers the poll in their post `postId`: `choices`, the options' numbers. */
export async function answerPoll(env, postId, choices) {
  const owner = await env.DB.prepare("SELECT name FROM users LIMIT 1").first();
  const trouble = await answerHere(env.DB, postId, "site", owner?.name ?? "You", choices);
  if (trouble) throw new Refusal(trouble);
}

/** The owner closes the poll in their post `postId`: its answers stay, and no more are taken. */
export async function closePoll(env, postId) {
  await env.DB.prepare("UPDATE polls SET closed_at = ? WHERE post_id = ? AND closed_at IS NULL").bind(now(), postId).run();
}
