// What this site shows a connected friend's site (peers.js), so its owner can read the posts and photos here from
// their own site: the same as they'd see visiting, as ActivityStreams (public/static/activity.js).
//   posts(page)      posts, newest first, with photos and comments
//   albums()         the albums, with covers
//   album(key, page) one album's photos and videos
//   photo(hash)      one photo or video, with comments, the post it came with, and its neighbours
// Photos and videos aren't sent: each comes with a link signed here ("afterwrd:fetch") that the friend's browser
// loads straight from this site for the next hour or two (signedFile, checked in index.js).
import {
  actorId, commentAuthor, commentNote, iso, mediaObject, postId, postKey,
} from "../public/static/activity.js";
import { loadThreads } from "./archive/comments.js";
import { mediaSet } from "./archive/routes.js";
import { profilePictures } from "./photos.js";
import { SITE_ID } from "./posts.js";
import { fromBase64Url, now, randomToken, toBase64Url } from "./util.js";

const POSTS_PAGE = 30;
const PHOTOS_PAGE = 150;

// --- signed links to files ------------------------------------------------------------------------------------------

let mediaKey = null;
async function key(env) {
  if (!mediaKey) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('media_key', ?)").bind(randomToken()).run();
    const { value } = await env.DB.prepare("SELECT value FROM settings WHERE key = 'media_key'").first();
    mediaKey = await crypto.subtle.importKey("raw", fromBase64Url(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  return mediaKey;
}

const signature = async (env, hash, exp) =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(`${hash}.${exp}`))));

/**
 * A link to one stored file that works without signing in until it expires: one to two hours, on the hour, or for
 * a profile picture or cover (`long`), six to seven days, so friends' sites can keep showing it.
 */
export async function signedFile(env, site, hash, { long = false } = {}) {
  const exp = long ? (Math.floor(now() / 86400) + 7) * 86400 : (Math.floor(now() / 3600) + 2) * 3600;
  return `${site}/files/${hash}?exp=${exp}&sig=${await signature(env, hash, exp)}`;
}

/** Whether a request for /files/<hash> carries a good, unexpired signature; returns seconds left, or 0. */
export async function signedFor(env, hash, params) {
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  if (!Number.isSafeInteger(exp) || exp <= now() || !/^[\w-]{43}$/.test(sig)) return 0;
  const ok = await crypto.subtle.verify("HMAC", await key(env), fromBase64Url(sig), new TextEncoder().encode(`${hash}.${exp}`));
  return ok ? exp - now() : 0;
}

// --- what's shared --------------------------------------------------------------------------------------------------

/** The owner as a Person, with their profile picture (icon) and cover (image): see profilePictures. */
export async function ownerActor(env, site, name) {
  const db = env.DB;
  const pictures = await profilePictures(db);
  const pick = async (p) => {
    const m = p && await db.prepare("SELECT * FROM media WHERE id = ?").bind(p.id).first();
    return m ? media(env, site, m, { long: true }) : undefined;
  };
  return { type: "Person", id: actorId(site), name, icon: await pick(pictures.profile), image: await pick(pictures.cover) };
}

async function chosen(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sections'").first();
  return row ? JSON.parse(row.value) : [];
}

async function media(env, site, m, { long = false } = {}) {
  const object = mediaObject(site, m, { "afterwrd:fetch": await signedFile(env, site, m.hash, { long }) });
  if (object.preview && m.thumb_hash) object.preview["afterwrd:fetch"] = await signedFile(env, site, m.thumb_hash, { long });
  delete object.location; // where photos were taken stays here
  return object;
}

async function threadOf(db, site, target) {
  const comments = (await loadThreads(db, [target])).get(target);
  return { type: "Collection", totalItems: comments.length, items: comments.map((c) => commentNote(site, c, commentAuthor(site, c))) };
}

/** Posts as Notes, with photos (signed links), tags, place and, unless asked not to, their comments. */
export async function notes(env, site, posts, { replies = true } = {}) {
  const db = env.DB;
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const marks = ids.map(() => "?").join(",");
  const [photos, tags] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE post_id IN (${marks}) AND hash IS NOT NULL ORDER BY timestamp, id`).bind(...ids),
    db.prepare(`SELECT t.post_id, p.name FROM post_tags t JOIN people p ON p.id = t.person_id WHERE t.post_id IN (${marks})`).bind(...ids),
  ]);
  const keys = posts.map(postKey);
  const threads = replies ? await loadThreads(db, keys) : new Map();
  return Promise.all(posts.map(async (p, i) => ({
    type: "Note",
    id: postId(site, keys[i]),
    attributedTo: actorId(site),
    published: iso(p.timestamp),
    summary: p.title || undefined,
    mediaType: "text/plain",
    content: p.text ?? "",
    attachment: [
      ...await Promise.all(photos.results.filter((m) => m.post_id === p.id).map((m) => media(env, site, m))),
      ...(p.link_url ? [{ type: "Link", href: p.link_url }] : []),
    ],
    tag: tags.results.filter((t) => t.post_id === p.id).map((t) => ({ type: "Mention", name: t.name })),
    location: p.place_name ? { type: "Place", name: p.place_name } : undefined,
    context: p.group_name ? { type: "Group", name: p.group_name } : undefined,
    "afterwrd:kind": p.kind,
    replies: replies ? {
      type: "Collection", totalItems: threads.get(keys[i]).length,
      items: threads.get(keys[i]).map((c) => commentNote(site, c, commentAuthor(site, c))),
    } : undefined,
  })));
}

export async function sharePosts(env, site, page, name) {
  const db = env.DB;
  const own = (await chosen(db)).includes("posts") ? "" : `WHERE id >= ${SITE_ID}`;
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM posts ${own}`),
    db.prepare(`SELECT * FROM posts ${own} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`).bind(POSTS_PAGE, (page - 1) * POSTS_PAGE),
  ]);
  const total = count.results[0].n;
  return {
    type: "OrderedCollectionPage", attributedTo: await ownerActor(env, site, name), totalItems: total, "afterwrd:page": page,
    "afterwrd:hasNext": page * POSTS_PAGE < total, orderedItems: await notes(env, site, rows.results),
  };
}

/** The albums the friend may see: all of them if Photos is published, otherwise just "Posted on afterwrd". */
async function setKeys(db) {
  const imported = (await chosen(db)).includes("photos");
  const { results } = await db.prepare(`SELECT id FROM albums ${imported ? "" : `WHERE id >= ${SITE_ID}`}`).all();
  return [...results.map((a) => String(a.id)), ...(imported ? ["other", "videos"] : [])];
}

async function setInfo(db, key) {
  const set = mediaSet(key);
  const stats = await db.prepare(`SELECT COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts,
    MAX(id) AS last_id FROM media WHERE ${set.where} AND hash IS NOT NULL`).bind(...set.params).first();
  const album = set.title === null ? await db.prepare("SELECT * FROM albums WHERE id = ?").bind(...set.params).first() : null;
  return { set, stats, name: set.title ?? album?.name, album };
}

export async function shareAlbums(env, site) {
  const db = env.DB;
  const items = [];
  for (const key of await setKeys(db)) {
    const { set, stats, name, album } = await setInfo(db, key);
    if (!stats.count) continue;
    const cover = await db.prepare(`SELECT * FROM media WHERE ${album?.cover_media_id ? "id = ?" : `${set.where} AND hash IS NOT NULL ORDER BY timestamp DESC`} LIMIT 1`)
      .bind(...(album?.cover_media_id ? [album.cover_media_id] : set.params)).first();
    items.push({
      type: "Collection", name, totalItems: stats.count, "afterwrd:key": key,
      published: iso(stats.first_ts), updated: iso(stats.last_ts), icon: cover?.hash ? await media(env, site, cover) : undefined,
    });
  }
  return { type: "Collection", totalItems: items.length, items };
}

export async function shareAlbum(env, site, key, page) {
  const db = env.DB;
  if (!(await setKeys(db)).includes(key)) return null;
  const { set, stats, name, album } = await setInfo(db, key);
  const { results } = await db.prepare(`SELECT * FROM media WHERE ${set.where} AND hash IS NOT NULL
    ORDER BY COALESCE(timestamp, 0), id LIMIT ? OFFSET ?`).bind(...set.params, PHOTOS_PAGE, (page - 1) * PHOTOS_PAGE).all();
  return {
    type: "OrderedCollectionPage", name, summary: album?.description || undefined, totalItems: stats.count,
    published: iso(stats.first_ts), updated: iso(stats.last_ts), "afterwrd:key": key, "afterwrd:page": page,
    "afterwrd:hasNext": page * PHOTOS_PAGE < stats.count, orderedItems: await Promise.all(results.map((m) => media(env, site, m))),
  };
}

export async function sharePhoto(env, site, hash) {
  const db = env.DB;
  const m = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY id LIMIT 1").bind(hash).first();
  if (!m) return null;
  const key = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  const neighbours = {};
  if ((await setKeys(db)).includes(key)) {
    const { set, stats, name } = await setInfo(db, key);
    const order = "(COALESCE(timestamp, 0), id)";
    const at = [m.timestamp ?? 0, m.id];
    const [prev, next, before] = await db.batch([
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)
        ORDER BY COALESCE(timestamp, 0) DESC, id DESC LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} > (?, ?)
        ORDER BY COALESCE(timestamp, 0), id LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)`).bind(...set.params, ...at),
    ]);
    Object.assign(neighbours, {
      "afterwrd:album": { key, name, totalItems: stats.count, index: before.results[0].n + 1 },
      "afterwrd:prev": prev.results[0]?.hash, "afterwrd:next": next.results[0]?.hash,
    });
  }
  const post = m.post_id ? await db.prepare("SELECT * FROM posts WHERE id = ?").bind(m.post_id).first() : null;
  return {
    ...await media(env, site, m),
    ...neighbours,
    "afterwrd:postedWith": post ? (await notes(env, site, [post], { replies: false }))[0] : undefined,
    replies: await threadOf(db, site, `photo-${hash}`),
  };
}
