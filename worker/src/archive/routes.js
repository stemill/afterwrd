// The archive's pages, ported from the routes in afterwrd/app.py and reading the D1 copy that
// `npm run publish` uploads. Only the sections chosen at publish time are served.
import { groupPostId } from "../../public/static/activity.js";
import { FINISHED_SQL, icsFile } from "../calendar.js";
import { connectedToken } from "../cloudflare.js";
import { findTarget, latestComments, loadThreads, newCount, photoKey, postKey } from "./comments.js";
import { connectionById, loadFeed, markMine, noteAnswer, rememberPicture } from "../feed.js";
import * as friend from "../friends.js";
import { MAX_GROUP_PHOTOS, MAX_MEMBERS } from "../groups.js";
import { whereAmI } from "../groupsites.js";
import * as groups from "../membership.js";
import { ownerName } from "../peers.js";
import { SITE_ID } from "../posts.js";
import { profilePictures } from "../photos.js";
import { updateWaiting } from "../update.js";
import { now } from "../util.js";
import { fmtDate, fmtMonth } from "./format.js";
import * as views from "./views.js";

const PAGE_SIZE = 50;
const PHOTO_PAGE_SIZE = 150;

const POST_SQL = `
  SELECT p.*, t.name AS target_name FROM posts p
  LEFT JOIN people t ON t.id = p.target_id`;
const COMMENT_SQL = `
  SELECT c.*, o.name AS owner_name, a.name AS author_name, a.is_me AS author_is_me
  FROM comments c
  LEFT JOIN people o ON o.id = c.target_owner_id
  LEFT JOIN people a ON a.id = c.author_id`;
const REACTION_SQL = `
  SELECT r.*, o.name AS owner_name FROM reactions r
  LEFT JOIN people o ON o.id = r.target_owner_id`;
const MEDIA_ORDER = "ORDER BY COALESCE(timestamp, 0), id";
const PERSON_TABS = {
  comments: ["Comments", `${COMMENT_SQL} WHERE c.target_owner_id = ? ORDER BY c.timestamp DESC`],
  likes: ["Likes", `${REACTION_SQL} WHERE r.target_owner_id = ? ORDER BY r.timestamp DESC`],
  wall: ["Wall posts", `${POST_SQL} WHERE p.target_id = ? ORDER BY p.timestamp DESC`],
  tags: ["Tagged together", `${POST_SQL} JOIN post_tags pt ON pt.post_id = p.id WHERE pt.person_id = ? ORDER BY p.timestamp DESC`],
  photos: ["Photos of you", "SELECT * FROM tagged_photos t WHERE t.owner_id = ? ORDER BY t.timestamp DESC"],
};

// [pattern, section(s) any of which must be published (null: always), handler]; handlers return a page, a
// Response, or null for 404.
const ROUTES = [
  [/^\/$/, null, home],
  [/^\/overview$/, "overview", overview],
  [/^\/memories$/, null, memories],
  [/^\/timeline$/, "timeline", timeline],
  [/^\/posts$/, "posts", posts],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})$/, ["posts", "timeline", "friends"], post],
  [/^\/comments$/, "comments", comments],
  [/^\/likes$/, "likes", likes],
  [/^\/photos$/, "photos", photos],
  [/^\/photos\/tagged$/, "photos", tagged],
  [/^\/photos\/album\/([^/]+)$/, "photos", album],
  [/^\/photos\/(\d+)$/, "photos", photo],
  [/^\/photos\/sha256\/([0-9a-f]{64})$/, "photos", photoByHash],
  [/^\/friends$/, "friends", friends],
  [/^\/people\/(\d+)$/, "friends", person],
  [/^\/activity$/, null, activity],
  [/^\/friend$/, null, friendsIndex],
  [/^\/friend\/(\d+)$/, null, friendHome],
  [/^\/friend\/(\d+)\/posts$/, null, friendPosts],
  [/^\/friend\/(\d+)\/photos$/, null, friendPhotos],
  [/^\/friend\/(\d+)\/photos\/album\/(\d+|other|videos)$/, null, friendAlbum],
  [/^\/friend\/(\d+)\/photos\/([0-9a-f]{64})$/, null, friendPhoto],
  [/^\/groups$/, null, groupsIndex],
  [/^\/groups\/new$/, null, groupNew],
  [/^\/groups\/join$/, null, groupJoin],
  [/^\/groups\/(\d{1,15})$/, null, groupHome],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})$/, null, groupPost],
  [/^\/groups\/(\d{1,15})\/members$/, null, groupMembers],
  [/^\/groups\/(\d{1,15})\/calendar$/, null, groupCalendar],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})\/edit$/, null, groupEventEdit],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})\/event\.ics$/, null, groupEventFile],
];

export async function renderArchive(request, env, url, user, work) {
  const db = env.DB;
  const [settings, me] = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'sections'"),
    db.prepare(`SELECT p.*, pm.hash AS profile_hash, cm.hash AS cover_hash FROM people p
      LEFT JOIN media pm ON pm.id = p.profile_media_id
      LEFT JOIN media cm ON cm.id = p.cover_media_id
      WHERE p.is_me = 1`),
  ]);
  // `chosen` is what the owner published from Facebook. Posts and Photos are always there, for posts written on
  // afterwrd, even before anything is imported; without their sections they show only those.
  const chosen = settings.results[0] ? JSON.parse(settings.results[0].value) : [];
  const sections = [...new Set([...chosen, "posts", "photos"])];
  const ctx = {
    env, db, url, user, chosen, sections, newComments: await newCount(db, user),
    zone: request.cf?.timezone ?? "Europe/London", // where the reader is, as near as Cloudflare can tell
    connected: Boolean(connectedToken(request)), // an hour's Cloudflare token from Connect (cloudflare.js), for groups
    requests: (await first(db, "SELECT COUNT(*) AS n FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL")).n,
    updateWaiting: await updateWaiting(env, work),
    me: me.results[0] ?? { id: -1, name: await ownerName(db), is_me: 1 },
    ownerName: await ownerName(db), // their name here, which can differ from the Facebook one (me.name)
    profile: await profilePictures(db),
    friendFaces: await friendFaces(db),
  };
  // A profile picture or cover chosen here takes over from Facebook's.
  if (ctx.profile.profile) Object.assign(ctx.me, { profile_hash: ctx.profile.profile.hash, profile_media_id: ctx.profile.profile.id });
  if (ctx.profile.cover) Object.assign(ctx.me, { cover_hash: ctx.profile.cover.hash, cover_media_id: ctx.profile.cover.id });

  for (const [pattern, section, handler] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match || (section && ![section].flat().some((s) => sections.includes(s)))) continue;
    const result = await handler(ctx, url.searchParams, ...match.slice(1));
    if (result instanceof Response) return result;
    if (result) return page(result);
    break;
  }
  return new Response("Not found", { status: 404 });
}

function page(body) {
  return new Response(String(body), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" },
  });
}

// --- data access ---------------------------------------------------------------

const all = (db, sql, params = []) => db.prepare(sql).bind(...params).all().then((r) => r.results);
const first = (db, sql, params = []) => db.prepare(sql).bind(...params).first();
const marks = (list) => list.map(() => "?").join(",");
const pageNumber = (params) => Math.min(10_000, Math.max(1, Number.parseInt(params.get("page"), 10) || 1));

/** Accumulates WHERE clauses and their parameters. */
class Filters {
  clauses = [];
  params = [];
  add(clause, ...params) {
    this.clauses.push(clause);
    this.params.push(...params);
  }
  get sql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

async function paginate(db, sql, params, page, size = PAGE_SIZE) {
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(...params),
    db.prepare(`${sql} LIMIT ? OFFSET ?`).bind(...params, size, (page - 1) * size),
  ]);
  const total = count.results[0].n;
  return { rows: rows.results, paging: { page, total, hasNext: page * size < total } };
}

async function years(db, table) {
  const rows = await all(db, `SELECT DISTINCT strftime('%Y', timestamp, 'unixepoch') AS y FROM ${table} ORDER BY y DESC`);
  return rows.map((r) => r.y);
}

/** Rows with a `media` list attached via media.<column>. */
async function withMedia(db, rows, column) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const media = await all(db, `SELECT * FROM media WHERE ${column} IN (${marks(ids)}) ORDER BY timestamp, id`, ids);
  return rows.map((r) => ({ ...r, media: media.filter((m) => m[column] === r.id) }));
}

/** Posts with their photos, tags and (unless `threads` is false) the comments written on them here. */
async function loadPosts(db, rows, { threads = true } = {}) {
  const posts = await withMedia(db, rows, "post_id");
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const tags = await all(db, `SELECT t.post_id, p.id, p.name FROM post_tags t JOIN people p ON p.id = t.person_id
    WHERE t.post_id IN (${marks(ids)})`, ids);
  const keys = posts.map(postKey);
  const comments = threads ? await loadThreads(db, keys) : null;
  return posts.map((p, i) => ({
    ...p, tags: tags.filter((t) => t.post_id === p.id), key: keys[i], thread: comments?.get(keys[i]),
  }));
}

const loadComments = (db, rows) => withMedia(db, rows, "comment_id");

function groupBy(items, key) {
  const groups = [];
  for (const item of items) {
    const k = key(item);
    if (groups.length && groups.at(-1)[0] === k) groups.at(-1)[1].push(item);
    else groups.push([k, [item]]);
  }
  return groups;
}

// --- pages -------------------------------------------------------------------

async function overview(ctx) {
  const { db } = ctx;
  const tables = ["posts", "comments", "reactions", "media", "albums", "tagged_photos"];
  const counts = {};
  const results = await db.batch([
    ...tables.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)),
    db.prepare("SELECT COUNT(*) AS n FROM people WHERE friend_since IS NOT NULL"),
  ]);
  tables.forEach((t, i) => { counts[t] = results[i].results[0].n; });
  counts.friends = results.at(-1).results[0].n;
  const byYear = await all(db, `
    SELECT year, SUM(t = 'p') AS posts, SUM(t = 'c') AS comments, SUM(t = 'r') AS reactions, SUM(t = 'm') AS photos
    FROM (
      SELECT strftime('%Y', timestamp, 'unixepoch') AS year, 'p' AS t FROM posts
      UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'c' FROM comments
      UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'r' FROM reactions
      UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'm' FROM media WHERE timestamp IS NOT NULL
    )
    GROUP BY year ORDER BY year DESC`);
  const topPeople = await all(db, `
    SELECT p.id, p.name, p.friend_since,
      (SELECT COUNT(*) FROM comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM reactions r WHERE r.target_owner_id = p.id) AS reactions
    FROM people p WHERE p.is_me = 0
    ORDER BY comments + reactions DESC LIMIT 15`);
  return views.overviewPage(ctx, { counts, byYear, topPeople });
}

async function timeline(ctx, params) {
  const { db } = ctx;
  const year = params.get("year") ?? "";
  const f = new Filters();
  if (year) f.add("strftime('%Y', timestamp, 'unixepoch') = ?", year);
  const sql = `
    SELECT * FROM (
      SELECT 'post' AS type, id, timestamp FROM posts
      UNION ALL SELECT 'comment', id, timestamp FROM comments
      UNION ALL SELECT 'reaction', id, timestamp FROM reactions
    ) ${f.sql} ORDER BY timestamp DESC, type, id DESC`;
  const { rows, paging } = await paginate(db, sql, f.params, pageNumber(params));

  async function load(type, baseSql, alias, loader) {
    const ids = rows.filter((r) => r.type === type).map((r) => r.id);
    if (!ids.length) return new Map();
    let found = await all(db, `${baseSql} WHERE ${alias}.id IN (${marks(ids)})`, ids);
    if (loader) found = await loader(db, found);
    return new Map(found.map((r) => [r.id, r]));
  }
  const lookup = {
    post: await load("post", POST_SQL, "p", loadPosts),
    comment: await load("comment", COMMENT_SQL, "c", loadComments),
    reaction: await load("reaction", REACTION_SQL, "r"),
  };
  const items = rows.map((r) => [r.type, lookup[r.type].get(r.id)]);
  const allYears = [...new Set([...await years(db, "posts"), ...await years(db, "comments"), ...await years(db, "reactions")])]
    .sort().reverse();
  return views.timelinePage(ctx, { items, paging, years: allYears, year });
}

async function posts(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (!ctx.chosen.includes("posts")) f.add("p.id >= ?", SITE_ID);
  if (q) f.add("(p.text LIKE ? OR p.title LIKE ? OR p.link_url LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', p.timestamp, 'unixepoch') = ?", year);
  if (kind) f.add("p.kind = ?", kind);
  const { rows, paging } = await paginate(db, `${POST_SQL} ${f.sql} ORDER BY p.timestamp DESC`, f.params, pageNumber(params));
  const own = ctx.chosen.includes("posts") ? "" : `WHERE id >= ${SITE_ID}`;
  const kinds = (await all(db, `SELECT kind FROM posts ${own} GROUP BY kind ORDER BY COUNT(*) DESC`)).map((r) => r.kind);
  const postYears = (await all(db, `SELECT DISTINCT strftime('%Y', timestamp, 'unixepoch') AS y FROM posts ${own} ORDER BY y DESC`))
    .map((r) => r.y);
  return views.postsPage(ctx, { posts: await loadPosts(db, rows), paging, q, year, kind, years: postYears, kinds });
}

async function comments(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(c.text LIKE ? OR o.name LIKE ? OR c.group_name LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', c.timestamp, 'unixepoch') = ?", year);
  if (kind) f.add("c.target_kind = ?", kind);
  const { rows, paging } = await paginate(db, `${COMMENT_SQL} ${f.sql} ORDER BY c.timestamp DESC`, f.params, pageNumber(params));
  const kinds = (await all(db, `SELECT target_kind FROM comments WHERE target_kind IS NOT NULL
    GROUP BY target_kind ORDER BY COUNT(*) DESC`)).map((r) => r.target_kind);
  return views.commentsPage(ctx, {
    comments: await loadComments(db, rows), paging, q, year, kind, years: await years(db, "comments"), kinds,
  });
}

async function likes(ctx, params) {
  const { db } = ctx;
  const [q, year, reaction] = ["q", "year", "reaction"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(o.name LIKE ? OR r.group_name LIKE ?)", ...Array(2).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', r.timestamp, 'unixepoch') = ?", year);
  if (reaction) f.add("r.reaction = ?", reaction);
  const { rows, paging } = await paginate(db, `${REACTION_SQL} ${f.sql} ORDER BY r.timestamp DESC`, f.params, pageNumber(params));
  const reactionTypes = (await all(db, "SELECT reaction FROM reactions GROUP BY reaction ORDER BY COUNT(*) DESC"))
    .map((r) => r.reaction);
  return views.likesPage(ctx, { reactions: rows, paging, q, year, reaction, years: await years(db, "reactions"), reactionTypes });
}

/** Filter for a photo set: an album id, 'other' (unalbumed photos) or 'videos'. */
export function mediaSet(key) {
  if (key === "videos") return { title: "Videos", where: "album_id IS NULL AND kind = 'video'", params: [] };
  if (key === "other") return { title: "Other photos", where: "album_id IS NULL AND kind = 'photo'", params: [] };
  if (/^\d+$/.test(key)) return { title: null, where: "album_id = ?", params: [Number(key)] };
  return null;
}

const setStats = (db, where, params) => first(db,
  `SELECT COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts FROM media WHERE ${where}`, params);

async function photos(ctx) {
  const { db } = ctx;
  const imported = ctx.chosen.includes("photos");
  const albums = await all(db, `
    SELECT a.id, a.name, m.hash, m.thumb_hash, m.kind, m.width, m.height,
      COUNT(x.id) AS count, MIN(x.timestamp) AS first_ts, MAX(x.timestamp) AS last_ts
    FROM albums a
    JOIN media x ON x.album_id = a.id
    LEFT JOIN media m ON m.id = a.cover_media_id
    ${imported ? "" : `WHERE a.id >= ${SITE_ID}`}
    GROUP BY a.id ORDER BY first_ts DESC`);
  const byYear = groupBy(albums, (a) => fmtDate(a.first_ts).slice(-4));

  const collections = [];
  for (const key of imported ? ["other", "videos"] : []) {
    const { title, where, params } = mediaSet(key);
    const stats = await setStats(db, where, params);
    const cover = await first(db, `SELECT * FROM media WHERE ${where} ORDER BY timestamp DESC LIMIT 1`, params);
    if (cover) collections.push({ key, title, cover, ...stats });
  }
  const taggedCount = imported ? (await first(db, "SELECT COUNT(*) AS n FROM tagged_photos")).n : 0;
  return views.photosPage(ctx, { byYear, collections, tagged: taggedCount });
}

async function album(ctx, params, key) {
  const { db } = ctx;
  const set = mediaSet(key);
  if (!set || (!ctx.chosen.includes("photos") && !(/^\d+$/.test(key) && Number(key) >= SITE_ID))) return null;
  let { title } = set;
  let info = null;
  if (title === null) {
    info = await first(db, "SELECT * FROM albums WHERE id = ?", set.params);
    if (!info) return null;
    title = info.name;
  }
  const stats = await setStats(db, set.where, set.params);
  const { rows, paging } = await paginate(db, `SELECT * FROM media WHERE ${set.where} ${MEDIA_ORDER}`, set.params,
    pageNumber(params), PHOTO_PAGE_SIZE);
  // Long-running sets read better split by month; a single trip's album doesn't need it.
  const spansMonths = fmtMonth(stats.first_ts) !== fmtMonth(stats.last_ts);
  const groups = spansMonths ? groupBy(rows, (m) => fmtMonth(m.timestamp)) : [[null, rows]];
  return views.albumPage(ctx, { key, title, info, stats, groups, paging });
}

async function tagged(ctx, params) {
  if (!ctx.chosen.includes("photos")) return null;
  const { rows, paging } = await paginate(ctx.db, `
    SELECT t.*, p.name AS owner_name FROM tagged_photos t LEFT JOIN people p ON p.id = t.owner_id
    ORDER BY t.timestamp DESC`, [], pageNumber(params));
  return views.taggedPage(ctx, { tagged: rows, paging });
}

async function photo(ctx, params, id) {
  const { db } = ctx;
  const m = await first(db, "SELECT * FROM media WHERE id = ?", [Number(id)]);
  if (!m) return null;
  const setKey = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  const { where, params: setParams, title } = mediaSet(setKey);
  const setTitle = title ?? (await first(db, "SELECT name FROM albums WHERE id = ?", setParams)).name;
  const order = "(COALESCE(timestamp, 0), id)";
  const position = [m.timestamp ?? 0, m.id];
  const [prev, next, index] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} < (?, ?)
      ORDER BY COALESCE(timestamp, 0) DESC, id DESC LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} > (?, ?) ${MEDIA_ORDER} LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${where} AND ${order} < (?, ?)`).bind(...setParams, ...position),
  ]);
  const before = index.results[0].n;
  // The post a photo came with is shown for context; comments here are on the photo itself.
  const post = m.post_id
    ? (await loadPosts(db, await all(db, `${POST_SQL} WHERE p.id = ?`, [m.post_id]), { threads: false }))[0] : null;
  const comment = m.comment_id
    ? (await loadComments(db, await all(db, `${COMMENT_SQL} WHERE c.id = ?`, [m.comment_id])))[0] : null;
  return views.photoPage(ctx, {
    m, setKey, setTitle, prev: prev.results[0], next: next.results[0], index: before + 1,
    total: (await setStats(db, where, setParams)).count, albumPage: Math.floor(before / PHOTO_PAGE_SIZE) + 1, post, comment,
    key: photoKey(m), thread: (await loadThreads(db, [photoKey(m)])).get(photoKey(m)),
  });
}

async function friends(ctx, params) {
  const [q, show, sort] = [params.get("q") ?? "", params.get("show") || "friends", params.get("sort") || "name"];
  const f = new Filters();
  f.add("p.is_me = 0");
  if (show === "friends") f.add("p.friend_since IS NOT NULL");
  else if (show === "removed") f.add("p.unfriended_at IS NOT NULL");
  if (q) f.add("p.name LIKE ?", `%${q}%`);
  const orders = {
    name: "p.name COLLATE NOCASE",
    since: "p.friend_since IS NULL, p.friend_since",
    activity: "comments + reactions DESC, p.name COLLATE NOCASE",
  };
  const order = Object.hasOwn(orders, sort) ? orders[sort] : orders.name;
  const people = await all(ctx.db, `
    SELECT p.*,
      (SELECT COUNT(*) FROM comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM reactions r WHERE r.target_owner_id = p.id) AS reactions,
      (SELECT COUNT(*) FROM posts x WHERE x.target_id = p.id) AS wall,
      (SELECT COUNT(*) FROM tagged_photos t WHERE t.owner_id = p.id) AS tagged
    FROM people p ${f.sql} ORDER BY ${order}`, f.params);
  return views.friendsPage(ctx, { people, q, show, sort });
}

async function person(ctx, params, id) {
  const { db } = ctx;
  const personId = Number(id);
  const p = await first(db, "SELECT * FROM people WHERE id = ?", [personId]);
  if (!p) return null;
  const keys = Object.keys(PERSON_TABS);
  const countRows = await db.batch(keys.map((k) => db.prepare(`SELECT COUNT(*) AS n FROM (${PERSON_TABS[k][1]})`).bind(personId)));
  const counts = Object.fromEntries(keys.map((k, i) => [k, countRows[i].results[0].n]));
  let tab = params.get("tab") ?? "";
  if (!Object.hasOwn(PERSON_TABS, tab)) tab = keys.find((k) => counts[k]) ?? "comments";
  let { rows, paging } = await paginate(db, PERSON_TABS[tab][1], [personId], pageNumber(params));
  if (tab === "comments") rows = await loadComments(db, rows);
  else if (tab === "wall" || tab === "tags") rows = await loadPosts(db, rows);
  const tabs = Object.fromEntries(keys.map((k) => [k, PERSON_TABS[k][0]]));
  return views.personPage(ctx, { person: p, tabs, counts, tab, rows, paging });
}

async function post(ctx, params, key) {
  const found = await findTarget(ctx.db, key);
  if (!found) return null;
  const [p] = await loadPosts(ctx.db, await all(ctx.db, `${POST_SQL} WHERE p.id = ?`, [found.post.id]));
  return views.postPage(ctx, p);
}

/** The newest comments from everyone, marking what's new since this person last looked. */
async function activity(ctx, params) {
  const { db, user } = ctx;
  const { rows, paging } = await latestComments(db, pageNumber(params), PAGE_SIZE);
  const targets = new Map();
  for (const key of new Set(rows.filter((c) => c.source === "here").map((c) => c.target))) targets.set(key, await findTarget(db, key));
  const seen = user.activity_seen_at ?? 0;
  if (paging.page === 1) {
    await db.prepare("UPDATE users SET activity_seen_at = ? WHERE id = ?").bind(now(), user.id).run();
    ctx.newComments = 0;
  }
  const items = rows.map((c) => ({ ...c, on: c.source === "here" ? targets.get(c.target) : null,
    isNew: c.created_at > seen && (c.source === "friend" || c.author_id !== user.id) }));
  return views.activityPage(ctx, { items, paging });
}

/** Home: write something, then the owner's own posts written here and their friends' newest, together. */
async function home(ctx, params) {
  const { db } = ctx;
  const own = await loadPosts(db, await all(db, `${POST_SQL} WHERE p.id >= ? ORDER BY p.timestamp DESC LIMIT 30`, [SITE_ID]));
  const friendsFeed = await loadFeed(db, ctx.url.origin);
  return views.homePage(ctx, {
    own, feed: friendsFeed, onThisDay: await onThisDay(ctx, 2), friends: friendsFeed.connections,
  });
}

async function memories(ctx) {
  return views.memoriesPage(ctx, { onThisDay: await onThisDay(ctx, 6) });
}

/** Posts from this day of the year (in London) in earlier years, newest first, with their photos. */
async function onThisDay(ctx, limit) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const rows = await all(ctx.db, `${POST_SQL} WHERE strftime('%m-%d', p.timestamp, 'unixepoch') = ?
    AND strftime('%Y', p.timestamp, 'unixepoch') < ? ORDER BY p.timestamp DESC LIMIT ?`, [`${parts.month}-${parts.day}`, parts.year, limit]);
  return loadPosts(ctx.db, rows, { threads: false });
}

/** A photo's permanent address (public/static/activity.js), which survives re-imports, leads to its page. */
async function photoByHash(ctx, params, hash) {
  const m = await first(ctx.db, "SELECT id FROM media WHERE hash = ? ORDER BY id LIMIT 1", [hash]);
  return m ? Response.redirect(`${ctx.url.origin}/photos/${m.id}${ctx.url.hash}`, 302) : null;
}

// --- a connected friend's posts and photos, read from their site (friends.js) ---------------------------------------

/** Only the owner reads friends' sites from here; `load` gets the connection and returns the page. */
async function fromFriend(ctx, id, load) {
  const connection = await connectionById(ctx.db, id);
  if (!connection) return null;
  connection.facebook = await facebookSelf(ctx.db, connection);
  try {
    const page = await load(connection);
    await noteAnswer(ctx.db, connection).run();
    return page;
  } catch (error) {
    await noteAnswer(ctx.db, connection, error).run();
    return views.friendProblem(ctx, connection, error.message);
  }
}

/**
 * The owner's Friends: friends on afterwrd (connected sites), each linked, if the owner says so, to who they are in
 * the Facebook download; then everyone else from that download. Matching names are suggested, never assumed.
 */
async function friendsIndex(ctx) {
  const { db } = ctx;
  const [connections, links, people, requests, invites] = await db.batch([
    db.prepare("SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT * FROM friend_links"),
    db.prepare("SELECT id, name, friend_since FROM people WHERE is_me = 0 AND friend_since IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT id, origin, name, invited_as, connected_at FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL ORDER BY connected_at DESC"),
    db.prepare(`SELECT person_name, MAX(created_at) AS invited_at FROM connect_links
      WHERE person_name IS NOT NULL AND used_at IS NULL AND expires_at > ? GROUP BY person_name`).bind(now()),
  ]);
  const same = (a, b) => a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;
  const linked = new Map(links.results.map((l) => [l.connection_id, l]));
  const taken = links.results.filter((l) => l.person_name);
  const friends = connections.results.map((c) => {
    const link = linked.get(c.id);
    if (link?.person_name) return { ...c, person: people.results.find((p) => same(p.name, link.person_name)) ?? { name: link.person_name } };
    if (link) return c; // they said the suggestion wasn't them
    const matches = people.results.filter((p) => same(p.name, c.name) && !taken.some((t) => same(t.person_name, p.name)));
    return matches.length === 1 ? { ...c, suggestion: matches[0] } : c;
  });
  // Where each Facebook friend stands: on afterwrd, asking to connect, invited, or not yet.
  const facebook = people.results.map((p) => ({
    ...p,
    friend: friends.find((f) => f.person && same(f.person.name, p.name)),
    asking: requests.results.find((r) => r.invited_as && same(r.invited_as, p.name)),
    invited: invites.results.find((i) => same(i.person_name, p.name))?.invited_at,
  }));
  // Requests show only what their site said when it connected: nothing is fetched from a site you haven't approved,
  // so a stranger can't slow this page down or see when you look at it.
  return views.friendsIndexPage(ctx, { friends, facebook, requests: requests.results });
}

/** Who a friend on afterwrd is in the owner's Facebook download, if the owner has linked them. */
async function facebookSelf(db, connection) {
  return first(db, `SELECT p.id, p.name FROM friend_links l JOIN people p ON p.name = l.person_name COLLATE NOCASE AND p.is_me = 0
    WHERE l.connection_id = ? LIMIT 1`, [connection.id]);
}

async function friendHome(ctx, params, id) {
  return Response.redirect(`${ctx.url.origin}/friend/${id}/posts`, 302);
}

async function friendPosts(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => {
    const { posts, paging, avatar, cover } = await friend.friendPosts(c, pageNumber(params));
    Object.assign(c, { avatar, cover });
    if (avatar) await rememberPicture(ctx.db, c, avatar)?.run();
    for (const p of posts) p.comments = await markMine(ctx.db, c.id, p.key, p.comments, ctx.url.origin);
    return views.friendPostsPage(ctx, c, { posts, paging });
  });
}

async function friendPhotos(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => views.friendPhotosPage(ctx, c, await friend.friendAlbums(c)));
}

async function friendAlbum(ctx, params, id, key) {
  return fromFriend(ctx, id, async (c) => views.friendAlbumPage(ctx, c, await friend.friendAlbum(c, key, pageNumber(params))));
}

async function friendPhoto(ctx, params, id, hash) {
  return fromFriend(ctx, id, async (c) => {
    const m = await friend.friendPhoto(c, hash);
    m.comments = await markMine(ctx.db, c.id, `photo-${m.hash}`, m.comments, ctx.url.origin);
    return views.friendPhotoPage(ctx, c, m);
  });
}

// --- groups, each its own Worker, read from there (membership.js) ------------------------------------------------------

/** The owner's groups, with comments waiting in each, and the events they're going to that are still to come. */
async function groupsIndex(ctx) {
  const list = await all(ctx.db, `SELECT g.*, (SELECT COUNT(*) FROM group_inbox i WHERE i.group_id = g.id AND i.created_at > ?) AS notes
    FROM groups g WHERE g.joined_at IS NOT NULL ORDER BY g.name COLLATE NOCASE`, [ctx.user.activity_seen_at ?? 0]);
  // Groups whose Worker this site made, but which it didn't finish claiming.
  const unfinished = await all(ctx.db, "SELECT id, name, origin FROM groups WHERE joined_at IS NULL AND script != '' ORDER BY created_at");
  // Plans long over are let go.
  await ctx.db.prepare(`DELETE FROM group_plans AS e WHERE ${FINISHED_SQL} < ?`).bind(now() - 30 * 86400).run();
  const plans = await all(ctx.db, `SELECT e.*, g.name AS group_name FROM group_plans e JOIN groups g ON g.id = e.group_id AND g.joined_at IS NOT NULL
    WHERE ${FINISHED_SQL} >= ? ORDER BY e.starts_at LIMIT 20`, [now()]);
  return views.groupsIndexPage(ctx, { groups: list, unfinished, plans, connected: ctx.connected });
}

/** Starting a group: its own Worker, made in the owner's Cloudflare account (groupsites.js). */
async function groupNew(ctx) {
  let address = null;
  try {
    address = whereAmI(ctx.url);
  } catch {}
  return views.groupNewPage(ctx, { connected: ctx.connected, domain: address?.domain ?? null, maxPhotos: MAX_GROUP_PHOTOS });
}

/** Opened from a group's invite link: join it? */
async function groupJoin(ctx, params) {
  const link = params.get("link") ?? "";
  try {
    const info = await groups.linkInfo(ctx.env, ctx.url, link);
    if (info.joined) return Response.redirect(`${ctx.url.origin}/groups/${info.joined}`, 302);
    return views.groupJoinPage(ctx, { info, link });
  } catch (error) {
    return views.groupJoinPage(ctx, { error: error.message });
  }
}

/** Only the owner reads a group from here; `load` gets the group and returns the page. */
async function fromGroup(ctx, id, load) {
  const group = await first(ctx.db, "SELECT * FROM groups WHERE id = ? AND joined_at IS NOT NULL", [Number(id)]);
  if (!group) return null;
  try {
    return await load(group);
  } catch (error) {
    return views.groupProblem(ctx, group, error.message);
  }
}

async function groupHome(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => views.groupPage(ctx, g,
    await groups.loadGroup(ctx.env, ctx.url.origin, g, pageNumber(params)), { maxPhotos: MAX_GROUP_PHOTOS }));
}

async function groupPost(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    return found?.post ? views.groupPostPage(ctx, g, found) : views.groupProblem(ctx, g, "That post isn't there any more.");
  });
}

/** A group's calendar: events to come, and adding one. */
async function groupCalendar(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => views.groupCalendarPage(ctx, g, await groups.loadEvents(ctx.env, ctx.url.origin, g)));
}

/** Changing an event the owner here added. */
async function groupEventEdit(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    if (!found?.post?.event || !found.post.mine) return views.groupProblem(ctx, g, "That isn't an event you added.");
    return views.groupEventEditPage(ctx, g, found);
  });
}

/** An event as a calendar file, to open in the owner's own calendar. */
async function groupEventFile(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    const p = found?.post;
    if (!p?.event) return views.groupProblem(ctx, g, "That isn't an event.");
    const page = `${ctx.url.origin}/groups/${g.id}/posts/${p.id}`;
    const body = icsFile(p.event, { uid: groupPostId(g.origin, g.remote_id, p.id), url: page,
      about: [p.text, `${found.group.name}: ${page}`].filter(Boolean).join("\n\n") });
    return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="event.ics"', "Cache-Control": "private, no-store" } });
  });
}

/** Who's in a group; for its admins, also requests to join, the invite link, and running it. */
async function groupMembers(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => views.groupMembersPage(ctx, g, await groups.loadMembers(ctx.env, g),
    { max: MAX_MEMBERS, connected: ctx.connected }));
}

/** Friends' profile pictures by site, where the link their site gave is still good. */
async function friendFaces(db) {
  const rows = await all(db, "SELECT origin, avatar_url FROM connections WHERE approved_at IS NOT NULL AND avatar_exp > ?", [now()]);
  return Object.fromEntries(rows.map((r) => [r.origin, r.avatar_url]));
}
