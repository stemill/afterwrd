// The owner's photos and albums made on the site, and choosing a profile picture and cover:
//   GET  /_admin/photos/add?album=<id>&for=profile|cover   the page for adding photos (public/static/add-photos.js)
//   POST /_admin/photos                     {album: <id>|"new", name?, description?, text?, share?, role?, photos}
//   POST /_admin/albums/<id>/edit           name, description (a form)
//   POST /_admin/albums/<id>/delete         (a form)
//   POST /_admin/photos/<id>/delete         (a form)
//   POST /_admin/profile                    role (profile|cover), hash, back (a form): any photo here
// Only albums and photos made on afterwrd (source 'afterwrd') can change, and "Posted on afterwrd" (role 'posts', where
// photos posted without an album go) is neither renamed nor deleted.
import { safeNext } from "./auth.js";
import { addPhotos, checkPhotos, newPost, photoCommentsGone, removeUnusedFiles, roleAlbum, ROLE_ALBUMS } from "./posts.js";
import { versionsGone } from "./edits.js";
import { html, json, now, pageData, Refusal } from "./util.js";
import { addPage } from "./views/photos.js";
import { notifyNewPost } from "./notify.js";

const MAX_BATCH = 50;
const ROLES = ["profile", "cover"];
// An album of the owner's own that they can change, add to and delete.
const OWN_ALBUM = "SELECT * FROM albums WHERE id = ? AND source = 'afterwrd' AND role IS NOT 'posts'";
const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");

/**
 * The owner's profile picture and cover: the ones chosen here (settings), if those photos are still here, or else
 * Facebook's, from the download.
 */
export async function profilePictures(db) {
  const [chosen, facebook] = await db.batch([
    db.prepare(`SELECT s.key, m.id, m.hash, m.thumb_hash FROM settings s
      JOIN media m ON m.hash = s.value WHERE s.key IN ('profile_hash', 'cover_hash') GROUP BY s.key`),
    db.prepare(`SELECT 'profile_hash' AS key, m.id, m.hash, m.thumb_hash FROM facebook_people p JOIN media m ON m.id = p.profile_media_id
        WHERE p.is_me = 1 AND m.hash IS NOT NULL
      UNION ALL SELECT 'cover_hash', m.id, m.hash, m.thumb_hash FROM facebook_people p JOIN media m ON m.id = p.cover_media_id
        WHERE p.is_me = 1 AND m.hash IS NOT NULL`),
  ]);
  const pick = (key) => chosen.results.find((r) => r.key === key) ?? facebook.results.find((r) => r.key === key) ?? null;
  return { profile: pick("profile_hash"), cover: pick("cover_hash") };
}

export async function handlePhotos(request, env, url) {
  const db = env.DB;
  if (request.method === "GET" && url.pathname === "/_admin/photos/add") {
    const { results: albums } = await db.prepare(`SELECT id, name FROM albums WHERE source = 'afterwrd' AND role IS NOT 'posts'
      ORDER BY created_at DESC`).all();
    const role = ROLES.includes(url.searchParams.get("for")) ? url.searchParams.get("for") : null;
    // `chosen` is the one to start with.
    return html(addPage(pageData(env, { albums,
      chosen: Number(url.searchParams.get("album")), role, max: role ? 1 : MAX_BATCH })));
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  if (url.pathname === "/_admin/photos") {
    try {
      const { album, role } = await addToAlbum(env, url.origin, await request.json().catch(() => ({})));
      return json({ href: role ? "/posts" : `/photos/album/${album}` });
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      throw error;
    }
  }

  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/photos"), url), url.origin);
  if (url.pathname === "/_admin/profile") {
    await choosePicture(env, { role: String(form.get("role")), hash: String(form.get("hash") ?? "") });
    return Response.redirect(back.href, 303);
  }

  const album = /^\/_admin\/albums\/(\d+)\/(edit|delete)$/.exec(url.pathname);
  if (album) {
    const id = Number(album[1]);
    if (album[2] === "edit") {
      const edited = await editAlbum(env, id, { name: form.get("name"), description: form.get("description") });
      return Response.redirect(edited ? `${url.origin}/photos/album/${id}` : back.href, 303);
    }
    return Response.redirect(await deleteAlbum(env, id) ? `${url.origin}/photos` : back.href, 303);
  }

  const photo = /^\/_admin\/photos\/(\d+)\/delete$/.exec(url.pathname);
  if (photo) {
    const gone = await deletePhoto(env, Number(photo[1]));
    if (!gone) return Response.redirect(back.href, 303);
    const to = gone.album !== null ? `/photos/album/${gone.album}` : gone.inPost ? "/posts" : "/photos";
    return Response.redirect(`${url.origin}${to}`, 303);
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/** A profile picture or cover (`role`), from any photo here (`hash`). Does nothing if either isn't right. */
export async function choosePicture(env, { role, hash }) {
  const db = env.DB;
  if (ROLES.includes(role) && (await db.prepare("SELECT 1 FROM media WHERE hash = ?").bind(hash).first())) {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`${role}_hash`, hash).run();
  }
}

/** Renames an album made here (an empty name changes nothing). False if it isn't one. */
export async function editAlbum(env, albumId, { name, description }) {
  const db = env.DB;
  if (!(await db.prepare(OWN_ALBUM).bind(albumId).first())) return false;
  name = clean(name, 200);
  if (name) {
    await db.prepare("UPDATE albums SET name = ?, description = ? WHERE id = ?").bind(name, clean(description, 2000) || null, albumId).run();
  }
  return true;
}

/** Deletes an album made here and its photos, apart from any also in a post, which move to "Posted on afterwrd". False if it isn't one. */
export async function deleteAlbum(env, albumId) {
  const db = env.DB;
  if (!(await db.prepare(OWN_ALBUM).bind(albumId).first())) return false;
  const { results: photos } = await db.prepare("SELECT * FROM media WHERE album_id = ?").bind(albumId).all();
  const going = photos.filter((f) => f.post_id === null);
  await db.batch([
    ...(going.length < photos.length ? [roleAlbum(db, "posts")] : []),
    db.prepare("DELETE FROM media WHERE album_id = ? AND post_id IS NULL").bind(albumId),
    db.prepare("UPDATE media SET album_id = (SELECT id FROM albums WHERE role = 'posts') WHERE album_id = ?").bind(albumId),
    db.prepare("DELETE FROM albums WHERE id = ?").bind(albumId),
    ...photoCommentsGone(db, going),
    ...versionsGone(db),
  ]);
  await removeUnusedFiles(env, going.flatMap((f) => [f.hash, f.thumb_hash]));
  return true;
}

/**
 * Deletes a photo made here (and a post left with nothing to show, with its comments). Returns where it was:
 * { album } (its id) and { inPost }; or null if it isn't one.
 */
export async function deletePhoto(env, photoId) {
  const db = env.DB;
  const f = await db.prepare("SELECT * FROM media WHERE id = ? AND source = 'afterwrd'").bind(photoId).first();
  if (!f) return null;
  const EMPTY_POST = "SELECT key FROM posts WHERE id = ?1 AND text IS NULL AND NOT EXISTS (SELECT 1 FROM media WHERE post_id = ?1)";
  await db.batch([
    db.prepare("DELETE FROM media WHERE id = ?").bind(f.id),
    // A post left with nothing to show goes too.
    db.prepare(`DELETE FROM comments WHERE target IN (${EMPTY_POST})`).bind(f.post_id),
    db.prepare(`DELETE FROM posts WHERE key IN (${EMPTY_POST})`).bind(f.post_id),
    ...photoCommentsGone(db, [f]),
    ...versionsGone(db),
  ]);
  await removeUnusedFiles(env, [f.hash, f.thumb_hash]);
  return { album: f.album_id, inPost: f.post_id !== null };
}

/**
 * Adds uploaded photos to an album here (a new one, one made before, or, for a profile picture or cover (`role`),
 * the album kept for those), and optionally shares them as a post. Returns { album } (its id) and { role }.
 */
export async function addToAlbum(env, origin, body) {
  const db = env.DB;
  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (!photos.length) throw new Refusal("Choose some photos first.");
  const problem = await checkPhotos(env, photos, MAX_BATCH);
  if (problem) throw new Refusal(problem);
  const role = ROLES.includes(body.role) ? body.role : null;

  // Which album: a new one, one made here before, or (for a profile picture or cover) the album kept for those.
  let albumId = null;
  let name;
  if (role) {
    name = ROLE_ALBUMS[role];
  } else if (body.album === "new") {
    name = clean(body.name, 200);
    if (!name) throw new Refusal("Give the new album a name.");
    albumId = (await db.prepare("INSERT INTO albums (source, name, description, created_at) VALUES ('afterwrd', ?, ?, ?) RETURNING id")
      .bind(name, clean(body.description, 2000) || null, now()).first()).id;
  } else {
    const found = await db.prepare(OWN_ALBUM).bind(Number(body.album)).first();
    if (!found) throw new Refusal("That album isn't there any more.");
    [albumId, name] = [found.id, found.name];
  }

  // Optionally as a post too, so friends see it on their Home.
  const text = clean(body.text, 5000);
  const share = body.share === true;
  const n = photos.length;
  const title = role === "profile" ? "Updated their profile picture." : role === "cover" ? "Updated their cover photo."
    : `Added ${n} photo${n === 1 ? "" : "s"} to ${name}.`;
  const [post, postKey] = share ? newPost(db, { text: text || null, title }) : [null, null];
  await db.batch([
    ...(post ? [post] : []),
    ...(role ? [roleAlbum(db, role)] : []),
    ...addPhotos(db, photos, { albumId, role, postKey }),
    ...(role ? [db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`${role}_hash`, photos[0].hash)] : []),
  ]);
  if (share) await notifyNewPost(env, origin, postKey);
  albumId ??= (await db.prepare("SELECT id FROM albums WHERE role = ?").bind(role).first()).id;
  return { album: albumId, role };
}
