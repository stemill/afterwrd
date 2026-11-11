// Reading a connected friend's site from this one: their posts and photos (and their newest posts, for Home) come as
// ActivityStreams from their /_peer endpoints (share.js on their side). Everything is checked here and turned into
// plain shapes for the pages; anything malformed is dropped, and every address must be on their own site.
// Photos and videos are shown from the signed links their site gives ("afterwrd:fetch"), which the browser loads
// straight from there.
import { actorId, POST_KEY_RE, seconds } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { MAX_POST_TEXT } from "./edits.js";
import { HASH_RE } from "./media.js";
import { callSite, siteOrigin } from "./peers.js";
import { parsePoll } from "./polls.js";

const text = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);

/** A path on their site after `prefix`, or null. */
const own = (site, url, prefix) => (typeof url === "string" && url.startsWith(site + prefix) ? url.slice(site.length + prefix.length) : null);

/** Their signed link for a file, if it's exactly that and nothing more (it ends up in pages, even in style="…"). */
export const signedLink = (site, link, hash) => (typeof link === "string" && link.startsWith(`${site}/files/${hash}?`)
  && /^\?exp=\d{1,12}&sig=[\w-]{43}$/.test(link.slice(`${site}/files/${hash}`.length)) ? link : null);

export function parseMedia(m, site) {
  const hash = own(site, m?.url, "/files/");
  if (!["Image", "Video"].includes(m?.type) || !HASH_RE.test(hash ?? "")) return null;
  const src = signedLink(site, m["afterwrd:fetch"], hash);
  if (!src) return null;
  const thumb = own(site, m.preview?.url, "/files/");
  const thumbSrc = HASH_RE.test(thumb ?? "") ? signedLink(site, m.preview["afterwrd:fetch"], thumb) : null;
  return {
    hash, kind: m.type === "Video" ? "video" : "photo", src, thumbSrc: thumbSrc ?? src,
    width: count(m.width), height: count(m.height), description: text(m.name, 5000), created_at: seconds(m.published),
  };
}

/**
 * Whether, and how, something was edited: { edited_at, earlier: [{text, replaced_at}] } (both empty if not). At most
 * 20 earlier versions, each no longer than `max`, oldest first, none replaced before it was written or after it was
 * last changed.
 */
export function parseEdits(item, created, max) {
  const editedAt = seconds(item?.updated);
  if (editedAt === null || editedAt < created) return { edited_at: null, earlier: [] };
  const list = Array.isArray(item["afterwrd:earlier"]) ? item["afterwrd:earlier"].slice(-20) : [];
  const earlier = list.flatMap((v) => {
    const at = seconds(v?.["afterwrd:replaced"]);
    const words = typeof v?.content === "string" && v.content.length <= max ? v.content : null;
    return words !== null && at !== null && at >= created && at <= editedAt ? [{ text: words, replaced_at: at }] : [];
  });
  return { edited_at: editedAt, earlier };
}

/**
 * Comments on something with address `base` (a post's or a photo's), as their site lists them; null if it doesn't
 * take comments (their site sent no `replies`: something from their Facebook download).
 */
function parseThread(collection, base, site, friendName) {
  if (!collection || typeof collection !== "object") return null;
  const items = Array.isArray(collection?.items) ? collection.items.slice(0, 500) : [];
  return items.flatMap((c) => {
    const n = /^#c(\d{1,15})$/.exec((typeof c?.id === "string" && c.id.startsWith(base) && c.id.slice(base.length)) || "");
    const author = c?.attributedTo;
    const name = author === actorId(site) ? friendName : text(author?.name, 100);
    const from = typeof author?.id === "string" && author.id !== actorId(site) ? siteOrigin(author.id.replace(/\/$/, "")) : null;
    const at = seconds(c?.published);
    return c?.type === "Note" && n && name && text(c.content, MAX_COMMENT) && at !== null
      ? [{ id: Number(n[1]), name, text: c.content, created_at: at, from, ...parseEdits(c, at, MAX_COMMENT) }] : [];
  });
}

export function parseNote(note, site, friendName, env = null) {
  const key = own(site, note?.id, "/posts/");
  const created = seconds(note?.published);
  if (note?.type !== "Note" || !POST_KEY_RE.test(key ?? "") || created === null) return null;
  const attachments = Array.isArray(note.attachment) ? note.attachment.slice(0, 100) : [];
  const link = attachments.find((a) => a?.type === "Link" && /^https?:\/\//.test(a.href ?? ""));
  return {
    key,
    created_at: created,
    text: text(note.content, 60_000) || null,
    title: text(note.summary, 1000),
    kind: text(note["afterwrd:kind"], 30) ?? "status",
    link_url: link ? text(link.href, 2000) : null,
    place: text(note.location?.name, 300),
    group: text(note.context?.name, 300),
    tags: (Array.isArray(note.tag) ? note.tag.slice(0, 50) : []).map((t) => text(t?.name, 100)).filter(Boolean),
    photos: attachments.map((m) => parseMedia(m, site)).filter(Boolean),
    comments: parseThread(note.replies, note.id, site, friendName),
    ...parseEdits(note, created, MAX_POST_TEXT), // earlier words of a post written on afterwrd: no longer than it allows
    // Their poll, if the post asks one: how many chose what, and what the owner here chose. Never who.
    poll: note["afterwrd:poll"] === undefined ? null : parsePoll(note["afterwrd:poll"], env),
  };
}

/** Who their site says its owner is: name, profile picture (`avatar`) and cover. */
function parseActor(actor, site) {
  return {
    name: text(actor?.name, 100)?.trim() || null,
    avatar: actor?.icon ? parseMedia(actor.icon, site) : null,
    cover: actor?.image ? parseMedia(actor.image, site) : null,
  };
}

/** A connected site's newest posts, for Home. */
export function cleanFeed(data, site) {
  const actor = parseActor(data?.attributedTo, site);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 50) : [];
  return { ...actor, posts: items.map((n) => parseNote(n, site, actor.name)).filter(Boolean) };
}

const call = (connection, path) => callSite(connection.origin, path, { key: connection.their_key });

export async function friendPosts(connection, page) {
  const data = await call(connection, `/_peer/posts?page=${page}`);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 100) : [];
  const { avatar, cover } = parseActor(data?.attributedTo, connection.origin);
  return {
    avatar, cover,
    posts: items.map((n) => parseNote(n, connection.origin, connection.name)).filter(Boolean),
    paging: { page, total: count(data?.totalItems) ?? 0, hasNext: data?.["afterwrd:hasNext"] === true },
  };
}

export async function friendAlbums(connection) {
  const data = await call(connection, "/_peer/albums");
  const items = Array.isArray(data?.items) ? data.items.slice(0, 2000) : [];
  return items.flatMap((a) => {
    const key = text(a?.["afterwrd:key"], 20);
    return key && /^(\d+|other|videos)$/.test(key) ? [{
      key, name: text(a.name, 300) ?? "Album", count: count(a.totalItems) ?? 0,
      first_ts: seconds(a.published), last_ts: seconds(a.updated), cover: a.icon ? parseMedia(a.icon, connection.origin) : null,
    }] : [];
  });
}

export async function friendAlbum(connection, key, page) {
  const data = await call(connection, `/_peer/albums/${key}?page=${page}`);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 500) : [];
  return {
    key, name: text(data?.name, 300) ?? "Album", description: text(data?.summary, 5000),
    first_ts: seconds(data?.published), last_ts: seconds(data?.updated), total: count(data?.totalItems) ?? 0,
    media: items.map((m) => parseMedia(m, connection.origin)).filter(Boolean),
    paging: { page, total: count(data?.totalItems) ?? 0, hasNext: data?.["afterwrd:hasNext"] === true },
  };
}

export async function friendPhoto(connection, hash) {
  const site = connection.origin;
  const data = await call(connection, `/_peer/photos/${hash}`);
  const m = parseMedia(data, site);
  if (!m || m.hash !== hash) throw new Error("Their site sent something unexpected.");
  const album = data["afterwrd:album"];
  const neighbour = (h) => (typeof h === "string" && HASH_RE.test(h) ? h : null);
  return {
    ...m,
    album: album && /^(\d+|other|videos)$/.test(album.key ?? "") ? {
      key: album.key, name: text(album.name, 300) ?? "Album", total: count(album.totalItems) ?? 0, index: count(album.index) ?? 1,
    } : null,
    prev: neighbour(data["afterwrd:prev"]),
    next: neighbour(data["afterwrd:next"]),
    post: data["afterwrd:postedWith"] ? parseNote(data["afterwrd:postedWith"], site, connection.name) : null,
    comments: parseThread(data.replies, `${site}/photos/sha256/${hash}`, site, connection.name),
  };
}
