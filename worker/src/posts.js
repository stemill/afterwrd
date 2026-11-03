// The owner's new posts, written with the composer on Posts (public/static/compose.js, which uploads the photos
// through the import's file endpoints first):
//   POST /_admin/posts                {text, photos: [{hash, thumb_hash, width, height, size}]}
//   POST /_admin/posts/<id>/delete    a form on the post itself
// They're kept in site_posts and site_photos and copied into the archive's tables by mirror().
import { photoKey, postKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { json, now } from "./util.js";

// Copies take ids from here up, far beyond any an import gives out.
export const SITE_ID = 1_000_000_000;
const ALBUM = "Posted on afterwrd";
const MAX_TEXT = 5000;
const MAX_PHOTOS = 20;
const MAX_SIDE = 20_000;

/** Statements that rebuild the archive's copy of the owner's posts; run with every change and every import. */
export function mirror(db) {
  return [
    db.prepare("DELETE FROM posts WHERE id >= ?").bind(SITE_ID),
    db.prepare("DELETE FROM media WHERE id >= ?").bind(SITE_ID),
    db.prepare("DELETE FROM albums WHERE id >= ?").bind(SITE_ID),
    db.prepare(`INSERT INTO posts (id, timestamp, kind, title, text)
      SELECT ?1 + p.id, p.created_at,
        CASE WHEN EXISTS (SELECT 1 FROM site_photos f WHERE f.post_id = p.id) THEN 'photo' ELSE 'status' END,
        'Posted on afterwrd.', p.text
      FROM site_posts p`).bind(SITE_ID),
    db.prepare(`INSERT INTO media (id, path, kind, timestamp, width, height, album_id, post_id, hash, thumb_hash, size, type)
      SELECT ?1 + f.id, 'afterwrd/' || f.hash || '.jpg', 'photo', p.created_at, f.width, f.height, ?1, ?1 + p.id,
        f.hash, f.thumb_hash, f.size, 'image/jpeg'
      FROM site_photos f JOIN site_posts p ON p.id = f.post_id`).bind(SITE_ID),
    db.prepare(`INSERT INTO albums (id, name, last_modified, cover_media_id)
      SELECT ?1, ?2, MAX(timestamp), MAX(id) FROM media WHERE album_id = ?1 HAVING COUNT(*) > 0`).bind(SITE_ID, ALBUM),
  ];
}

export async function handlePosts(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (url.pathname === "/_admin/posts") return create(env, await request.json().catch(() => ({})));
  const del = /^\/_admin\/posts\/(\d+)\/delete$/.exec(url.pathname);
  if (del) return remove(env, url, Number(del[1]) - SITE_ID);
  return new Response("Not found", { status: 404 });
}

async function create(env, body) {
  const db = env.DB;
  const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (text.length > MAX_TEXT) return json({ error: `Posts can be up to ${MAX_TEXT} characters.` }, 400);
  if (photos.length > MAX_PHOTOS) return json({ error: `Up to ${MAX_PHOTOS} photos in a post.` }, 400);
  if (!text && !photos.length) return json({ error: "Write something or add a photo." }, 400);
  const side = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_SIDE;
  if (!photos.every((f) => f && HASH_RE.test(f.hash) && HASH_RE.test(f.thumb_hash) && side(f.width) && side(f.height)
    && Number.isSafeInteger(f.size) && f.size > 0)) {
    return json({ error: "Unexpected photo details." }, 400);
  }
  // Every file must already be in the media store.
  const hashes = [...new Set(photos.flatMap((f) => [f.hash, f.thumb_hash]))];
  const stored = (await Promise.all([...new Set(hashes.map((h) => h[0]))].map((shard) =>
    mediaStore(env, shard).has(hashes.filter((h) => h[0] === shard))))).flat();
  if (stored.length !== hashes.length) return json({ error: "Some photos didn't finish uploading. Try again." }, 400);

  // One transaction: the post, its photos (in order) and the archive's copy.
  await db.batch([
    db.prepare("INSERT INTO site_posts (created_at, text) VALUES (?, ?)").bind(now(), text || null),
    ...photos.map((f) => db.prepare(`INSERT INTO site_photos (post_id, hash, thumb_hash, width, height, size)
      VALUES ((SELECT MAX(id) FROM site_posts), ?, ?, ?, ?, ?)`).bind(f.hash, f.thumb_hash, f.width, f.height, f.size)),
    ...mirror(db),
  ]);
  return json({ ok: true });
}

// Deletes the post, its photos' files (unless something else uses the same file) and the comments on them.
async function remove(env, url, id) {
  const db = env.DB;
  const post = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(SITE_ID + id).first();
  if (post && id > 0) {
    const { results: photos } = await db.prepare("SELECT * FROM media WHERE post_id = ? AND id >= ?").bind(post.id, SITE_ID).all();
    const targets = [postKey(post), ...photos.map(photoKey)];
    await db.batch([
      db.prepare(`DELETE FROM site_comments WHERE target IN (${targets.map(() => "?").join(",")})`).bind(...targets),
      db.prepare("DELETE FROM site_photos WHERE post_id = ?").bind(id),
      db.prepare("DELETE FROM site_posts WHERE id = ?").bind(id),
      ...mirror(db),
    ]);
    const files = [...new Set(photos.flatMap((m) => [m.hash, m.thumb_hash]))];
    if (files.length) {
      const marks = files.map(() => "?").join(",");
      const { results: used } = await db.prepare(`SELECT hash FROM media WHERE hash IN (${marks})
        UNION SELECT thumb_hash FROM media WHERE thumb_hash IN (${marks})`).bind(...files, ...files).all();
      const unused = files.filter((h) => !used.some((u) => u.hash === h));
      await Promise.all([...new Set(unused.map((h) => h[0]))].map((shard) =>
        mediaStore(env, shard).remove(unused.filter((h) => h[0] === shard))));
    }
  }
  return Response.redirect(`${url.origin}/posts`, 303);
}
