// What this site shows a connected friend's site (peers.js), so its owner can read the posts and photos here from
// their own site: the same as they'd see visiting, as ActivityStreams (public/static/activity.js).
//   posts(page)      posts, newest first, with photos and comments
//   albums()         the albums, with covers
//   album(key, page) one album's photos and videos
//   photo(hash)      one photo or video, with comments, the post it came with, and its neighbours
// Photos and videos aren't sent: each comes with a link signed here ("afterwrd:fetch") that the friend's browser
// loads straight from this site for the next hour or two (signedFile, checked in index.js).
import { actorId, commentAuthor, commentNote, editedFields, iso, mediaObject, postId } from "../public/static/activity.js";
import { postVersions } from "./edits.js";
import { loadThreads } from "./archive/comments.js";
import { mediaSet } from "./archive/routes.js";
import { profilePictures } from "./photos.js";
import { pollObject, sitePolls } from "./polls.js";
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

/**
 * Posts as Notes, with photos (signed links), tags, place, a poll if one asks something (with `viewer`'s own answer:
 * the friend's site asking), and, unless asked not to, their comments. Facebook posts take no comments (for now),
 * so they come without `replies`.
 */
export async function notes(env, site, posts, { replies = true, viewer = null } = {}) {
  const db = env.DB;
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const marks = ids.map(() => "?").join(",");
  const [photos, tags] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE post_id IN (${marks}) AND hash IS NOT NULL ORDER BY created_at, id`).bind(...ids),
    db.prepare(`SELECT t.post_id, p.name FROM facebook_post_tags t JOIN facebook_people p ON p.id = t.person_id
      WHERE t.post_id IN (${marks})`).bind(...ids),
  ]);
  const own = posts.filter((p) => p.source === "afterwrd");
  const threads = replies ? await loadThreads(db, own.map((p) => p.key)) : new Map();
  const polls = await sitePolls(db, own.map((p) => p.id), viewer);
  const earlier = await postVersions(db, own.filter((p) => p.edited_at).map((p) => p.id));
  return Promise.all(posts.map(async (p) => ({
    type: "Note",
    id: postId(site, p.key),
    attributedTo: actorId(site),
    published: iso(p.created_at),
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
    ...editedFields({ ...p, earlier: earlier.get(p.id) }),
    "afterwrd:kind": p.kind ?? undefined, // Facebook's; afterwrd's own posts have none
    "afterwrd:poll": polls.has(p.id) ? pollObject(polls.get(p.id)) : undefined,
    replies: threads.has(p.key) ? {
      type: "Collection", totalItems: threads.get(p.key).length,
      items: threads.get(p.key).map((c) => commentNote(site, c, commentAuthor(site, c))),
    } : undefined,
  })));
}

export async function sharePosts(env, site, page, name, viewer = null) {
  const db = env.DB;
  const own = (await chosen(db)).includes("posts") ? "" : "WHERE source = 'afterwrd'";
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM posts ${own}`),
    db.prepare(`SELECT * FROM posts ${own} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(POSTS_PAGE, (page - 1) * POSTS_PAGE),
  ]);
  const total = count.results[0].n;
  return {
    type: "OrderedCollectionPage", attributedTo: await ownerActor(env, site, name), totalItems: total, "afterwrd:page": page,
    "afterwrd:hasNext": page * POSTS_PAGE < total, orderedItems: await notes(env, site, rows.results, { viewer }),
  };
}

/** The albums the friend may see: all of them if Photos is published, otherwise just those made on afterwrd. */
async function setKeys(db) {
  const imported = (await chosen(db)).includes("photos");
  const { results } = await db.prepare(`SELECT id FROM albums ${imported ? "" : "WHERE source = 'afterwrd'"}`).all();
  return [...results.map((a) => String(a.id)), ...(imported ? ["other", "videos"] : [])];
}

async function setInfo(db, key) {
  const set = mediaSet(key);
  const stats = await db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts,
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
    const cover = await db.prepare(`SELECT * FROM media WHERE ${album?.cover_media_id ? "id = ?" : `${set.where} AND hash IS NOT NULL ORDER BY created_at DESC`} LIMIT 1`)
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
    ORDER BY COALESCE(created_at, 0), id LIMIT ? OFFSET ?`).bind(...set.params, PHOTOS_PAGE, (page - 1) * PHOTOS_PAGE).all();
  return {
    type: "OrderedCollectionPage", name, summary: album?.description || undefined, totalItems: stats.count,
    published: iso(stats.first_ts), updated: iso(stats.last_ts), "afterwrd:key": key, "afterwrd:page": page,
    "afterwrd:hasNext": page * PHOTOS_PAGE < stats.count, orderedItems: await Promise.all(results.map((m) => media(env, site, m))),
  };
}

/** Whether a friend may see this post: one written here, or any if the owner has shared their Facebook posts. */
export async function postShared(db, post) {
  return post.source === "afterwrd" || (await chosen(db)).includes("posts");
}

const postById = (db, id) => db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first();

/**
 * Whether a friend may see this photo or video: it's in an album they're shown, or it came with a post they're
 * shown. Anything else isn't theirs to see, even if they know its fingerprint.
 */
export async function photoShared(db, m) {
  const key = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  if ((await setKeys(db)).includes(key)) return true;
  const post = m.post_id && await postById(db, m.post_id);
  return Boolean(post) && postShared(db, post);
}

export async function sharePhoto(env, site, hash) {
  const db = env.DB;
  // A picture both imported and posted on afterwrd is shown as afterwrd's.
  const m = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1").bind(hash).first();
  if (!m || !(await photoShared(db, m))) return null;
  const key = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  const neighbours = {};
  if ((await setKeys(db)).includes(key)) {
    const { set, stats, name } = await setInfo(db, key);
    const order = "(COALESCE(created_at, 0), id)";
    const at = [m.created_at ?? 0, m.id];
    const [prev, next, before] = await db.batch([
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)
        ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} > (?, ?)
        ORDER BY COALESCE(created_at, 0), id LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)`).bind(...set.params, ...at),
    ]);
    Object.assign(neighbours, {
      "afterwrd:album": { key, name, totalItems: stats.count, index: before.results[0].n + 1 },
      "afterwrd:prev": prev.results[0]?.hash, "afterwrd:next": next.results[0]?.hash,
    });
  }
  // The post it came with, if that's one the friend may see.
  const withPost = m.post_id && await postById(db, m.post_id);
  const post = withPost && (await postShared(db, withPost)) ? withPost : null;
  return {
    ...await media(env, site, m),
    ...neighbours,
    "afterwrd:postedWith": post ? (await notes(env, site, [post], { replies: false }))[0] : undefined,
    // Only photos made on afterwrd take comments, for now.
    replies: m.source === "afterwrd" ? await threadOf(db, site, `photo-${hash}`) : undefined,
  };
}
