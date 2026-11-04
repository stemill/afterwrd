// The owner's photos and albums made on the site, and choosing a profile picture and cover:
//   GET  /_admin/photos/add?album=<id>&for=profile|cover   the page for adding photos (public/static/add-photos.js)
//   POST /_admin/photos                     {album: <id>|"new", name?, description?, text?, share?, role?, photos}
//   POST /_admin/albums/<id>/edit           name, description (a form)
//   POST /_admin/albums/<id>/delete         (a form)
//   POST /_admin/photos/<id>/delete         (a form)
//   POST /_admin/profile                    role (profile|cover), hash, back (a form): any photo here
// Album and photo ids are the archive's copies (SITE_ID and up, see posts.js); only those made here can change.
import { photoKey } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { addPhotos, checkPhotos, mirror, removeUnusedFiles, SITE_ID } from "./posts.js";
import { escape, html, json, now } from "./util.js";
import { notifyNewPost } from "./notify.js";

const MAX_BATCH = 50;
const ROLES = { profile: "Profile pictures", cover: "Cover photos" };
const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");

/**
 * The owner's profile picture and cover: the ones chosen here (settings), if those photos are still here, or else
 * Facebook's, from the download.
 */
export async function profilePictures(db) {
  const [chosen, facebook] = await db.batch([
    db.prepare(`SELECT s.key, m.id, m.hash, m.thumb_hash FROM settings s
      JOIN media m ON m.hash = s.value WHERE s.key IN ('profile_hash', 'cover_hash') GROUP BY s.key`),
    db.prepare(`SELECT 'profile_hash' AS key, m.id, m.hash, m.thumb_hash FROM people p JOIN media m ON m.id = p.profile_media_id
        WHERE p.is_me = 1 AND m.hash IS NOT NULL
      UNION ALL SELECT 'cover_hash', m.id, m.hash, m.thumb_hash FROM people p JOIN media m ON m.id = p.cover_media_id
        WHERE p.is_me = 1 AND m.hash IS NOT NULL`),
  ]);
  const pick = (key) => chosen.results.find((r) => r.key === key) ?? facebook.results.find((r) => r.key === key) ?? null;
  return { profile: pick("profile_hash"), cover: pick("cover_hash") };
}

export async function handlePhotos(request, env, url, work) {
  const db = env.DB;
  if (request.method === "GET" && url.pathname === "/_admin/photos/add") {
    const { results: albums } = await db.prepare("SELECT id, name FROM site_albums ORDER BY created_at DESC").all();
    const role = Object.hasOwn(ROLES, url.searchParams.get("for")) ? url.searchParams.get("for") : null;
    return html(addPage(albums, Number(url.searchParams.get("album")) - SITE_ID, role));
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  if (url.pathname === "/_admin/photos") return add(env, await request.json().catch(() => ({})), url, work);

  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/photos"), url), url.origin);
  if (url.pathname === "/_admin/profile") {
    const role = String(form.get("role"));
    const hash = String(form.get("hash") ?? "");
    if (Object.hasOwn(ROLES, role) && (await db.prepare("SELECT 1 FROM media WHERE hash = ?").bind(hash).first())) {
      await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`${role}_hash`, hash).run();
    }
    return Response.redirect(back, 303);
  }

  const album = /^\/_admin\/albums\/(\d+)\/(edit|delete)$/.exec(url.pathname);
  if (album) {
    const id = Number(album[1]) - SITE_ID;
    if (id < 1 || !(await db.prepare("SELECT 1 FROM site_albums WHERE id = ?").bind(id).first())) return Response.redirect(back, 303);
    if (album[2] === "edit") {
      const name = clean(form.get("name"), 200);
      if (name) {
        await db.batch([
          db.prepare("UPDATE site_albums SET name = ?, description = ? WHERE id = ?").bind(name, clean(form.get("description"), 2000) || null, id),
          ...mirror(db),
        ]);
      }
      return Response.redirect(`${url.origin}/photos/album/${SITE_ID + id}`, 303);
    }
    // Deleting an album deletes its photos, apart from any also in a post, which move to "Posted on afterwrd".
    const { results: photos } = await db.prepare("SELECT * FROM site_photos WHERE album_id = ?").bind(id).all();
    const going = photos.filter((f) => f.post_id === null);
    await db.batch([
      db.prepare("DELETE FROM site_photos WHERE album_id = ? AND post_id IS NULL").bind(id),
      db.prepare("UPDATE site_photos SET album_id = NULL WHERE album_id = ?").bind(id),
      db.prepare("DELETE FROM site_albums WHERE id = ?").bind(id),
      ...mirror(db),
      ...comments(db, going),
    ]);
    await removeUnusedFiles(env, going.flatMap((f) => [f.hash, f.thumb_hash]));
    return Response.redirect(`${url.origin}/photos`, 303);
  }

  const photo = /^\/_admin\/photos\/(\d+)\/delete$/.exec(url.pathname);
  if (photo) {
    const f = await db.prepare("SELECT * FROM site_photos WHERE id = ?").bind(Number(photo[1]) - SITE_ID).first();
    if (!f) return Response.redirect(back, 303);
    await db.batch([
      db.prepare("DELETE FROM site_photos WHERE id = ?").bind(f.id),
      // A post left with nothing to show goes too.
      db.prepare(`DELETE FROM site_posts WHERE id = ? AND text IS NULL
        AND NOT EXISTS (SELECT 1 FROM site_photos WHERE post_id = site_posts.id)`).bind(f.post_id),
      ...mirror(db),
      ...comments(db, [f]),
    ]);
    await removeUnusedFiles(env, [f.hash, f.thumb_hash]);
    const to = f.album_id !== null ? `/photos/album/${SITE_ID + f.album_id}` : f.post_id !== null ? "/posts" : "/photos";
    return Response.redirect(`${url.origin}${to}`, 303);
  }
  return new Response("Not found", { status: 404 });
}

// Comments on photos are kept by picture (photo-<hash>), so they go only once no photo here shows that picture: an
// imported photo can have the same one. Run after mirror().
const comments = (db, photos) => photos.map((f) => db.prepare(`DELETE FROM site_comments WHERE target = ?
  AND NOT EXISTS (SELECT 1 FROM media WHERE hash = ?)`).bind(photoKey(f), f.hash));

async function add(env, body, url, work) {
  const db = env.DB;
  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (!photos.length) return json({ error: "Choose some photos first." }, 400);
  const problem = await checkPhotos(env, photos, MAX_BATCH);
  if (problem) return json({ error: problem }, 400);
  const role = Object.hasOwn(ROLES, body.role) ? body.role : null;

  // Which album: a new one, one made here before, or (for a profile picture or cover) the album kept for those.
  let albumId = null;
  let name;
  if (role) {
    name = ROLES[role];
    albumId = (await db.prepare("SELECT id FROM site_albums WHERE name = ? ORDER BY id LIMIT 1").bind(name).first())?.id ?? null;
  } else if (body.album === "new") {
    name = clean(body.name, 200);
    if (!name) return json({ error: "Give the new album a name." }, 400);
  } else {
    const found = await db.prepare("SELECT id, name FROM site_albums WHERE id = ?").bind(Number(body.album) - SITE_ID).first();
    if (!found) return json({ error: "That album isn't there any more." }, 400);
    [albumId, name] = [found.id, found.name];
  }
  if (albumId === null) {
    albumId = (await db.prepare("INSERT INTO site_albums (name, description, created_at) VALUES (?, ?, ?) RETURNING id")
      .bind(name, clean(body.description, 2000) || null, now()).first()).id;
  }

  // Optionally as a post too, so friends see it in Feed.
  const text = clean(body.text, 5000);
  const share = body.share === true;
  const n = photos.length;
  const title = role === "profile" ? "Updated their profile picture." : role === "cover" ? "Updated their cover photo."
    : `Added ${n} photo${n === 1 ? "" : "s"} to ${name}.`;
  await db.batch([
    ...(share ? [db.prepare("INSERT INTO site_posts (created_at, text, title) VALUES (?, ?, ?)").bind(now(), text || null, title)] : []),
    ...addPhotos(db, photos, { inPost: share, albumId }),
    ...(role ? [db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`${role}_hash`, photos[0].hash)] : []),
    ...mirror(db),
  ]);
  if (share) await notifyNewPost(env, work, url.origin);
  return json({ href: role ? "/posts" : `/photos/album/${SITE_ID + albumId}` });
}

function addPage(albums, chosen, role) {
  const title = role === "profile" ? "Choose a profile picture" : role === "cover" ? "Choose a cover photo" : "Add photos";
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
</head>
<body>
${ownerHeader("photos")}
<main class="add-photos">
<p class="crumbs"><a href="${role ? "/posts" : "/photos"}">${role ? "Posts" : "Photos"}</a> /</p>
<h1>${title}</h1>
${role ? `<p class="meta">Upload one here, or open any of your photos and press <b>Make ${role === "profile" ? "profile picture" : "cover"}</b>.</p>` : ""}
<form class="card composer" id="add" data-role="${role ?? ""}" data-max="${role ? 1 : MAX_BATCH}">
  ${role ? "" : `<label>Album
    <select name="album">
      <option value="new">New album…</option>
      ${albums.map((a) => `<option value="${SITE_ID + a.id}" ${a.id === chosen ? "selected" : ""}>${escape(a.name)}</option>`).join("")}
    </select></label>
  <div class="new-album">
    <input name="name" maxlength="200" placeholder="Album name, e.g. Summer 2026" aria-label="Album name">
    <textarea name="description" rows="2" maxlength="2000" placeholder="What's it about? (optional)" aria-label="Album description"></textarea>
  </div>`}
  <ul class="picked" hidden></ul>
  <label class="chip pick"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>
    <span>${role ? "Choose a photo" : "Choose photos"}</span><input type="file" accept="image/*" ${role ? "" : "multiple"} class="hidden"></label>
  <label class="check"><input type="checkbox" name="share" ${role ? "" : "checked"}> <span>Also share it as a post, so friends see it in their Feed</span></label>
  <textarea name="text" rows="2" maxlength="5000" placeholder="Say something about it (optional)" aria-label="Say something"></textarea>
  <p class="error" role="alert"></p>
  <div class="actions"><span class="status meta" role="status"></span><button class="post">${role ? "Use this photo" : "Add photos"}</button></div>
</form>
</main>
<script type="module" src="${asset("/static/add-photos.js")}"></script>
</body>
</html>`;
}
