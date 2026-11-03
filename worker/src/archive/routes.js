// The archive's pages, ported from the routes in afterwrd/app.py and reading the D1 copy that
// `npm run publish` uploads. Only the sections chosen at publish time are served.
import { findTarget, latestComments, loadThreads, newCount, photoKey, postKey } from "./comments.js";
import { loadFeed } from "../feed.js";
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
  [/^\/$/, "overview", overview],
  [/^\/timeline$/, "timeline", timeline],
  [/^\/posts$/, "posts", posts],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})$/, ["posts", "timeline", "friends"], post],
  [/^\/comments$/, "comments", comments],
  [/^\/likes$/, "likes", likes],
  [/^\/photos$/, "photos", photos],
  [/^\/photos\/tagged$/, "photos", tagged],
  [/^\/photos\/album\/([^/]+)$/, "photos", album],
  [/^\/photos\/(\d+)$/, "photos", photo],
  [/^\/friends$/, "friends", friends],
  [/^\/people\/(\d+)$/, "friends", person],
  [/^\/activity$/, null, activity],
  [/^\/feed$/, null, feed],
];

export async function renderArchive(request, env, url, user) {
  const db = env.DB;
  const [settings, me] = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'sections'"),
    db.prepare(`SELECT p.*, pm.hash AS profile_hash, cm.hash AS cover_hash FROM people p
      LEFT JOIN media pm ON pm.id = p.profile_media_id
      LEFT JOIN media cm ON cm.id = p.cover_media_id
      WHERE p.is_me = 1`),
  ]);
  const sections = settings.results[0] ? JSON.parse(settings.results[0].value) : [];
  const ctx = { db, url, user, sections, me: me.results[0], newComments: await newCount(db, user) };
  // Feed doesn't need an archive of your own.
  if ((!ctx.me || !sections.length) && url.pathname !== "/feed") return page(views.emptyPage(ctx, "Nothing has been published here yet."));

  if (url.pathname === "/" && !sections.includes("overview")) {
    return Response.redirect(`${url.origin}/${sections[0]}`, 302);
  }
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
const pageNumber = (params) => Math.max(1, Number.parseInt(params.get("page"), 10) || 1);

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
  if (q) f.add("(p.text LIKE ? OR p.title LIKE ? OR p.link_url LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', p.timestamp, 'unixepoch') = ?", year);
  if (kind) f.add("p.kind = ?", kind);
  const { rows, paging } = await paginate(db, `${POST_SQL} ${f.sql} ORDER BY p.timestamp DESC`, f.params, pageNumber(params));
  const kinds = (await all(db, "SELECT kind FROM posts GROUP BY kind ORDER BY COUNT(*) DESC")).map((r) => r.kind);
  return views.postsPage(ctx, { posts: await loadPosts(db, rows), paging, q, year, kind, years: await years(db, "posts"), kinds });
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
function mediaSet(key) {
  if (key === "videos") return { title: "Videos", where: "album_id IS NULL AND kind = 'video'", params: [] };
  if (key === "other") return { title: "Other photos", where: "album_id IS NULL AND kind = 'photo'", params: [] };
  if (/^\d+$/.test(key)) return { title: null, where: "album_id = ?", params: [Number(key)] };
  return null;
}

const setStats = (db, where, params) => first(db,
  `SELECT COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts FROM media WHERE ${where}`, params);

async function photos(ctx) {
  const { db } = ctx;
  const albums = await all(db, `
    SELECT a.id, a.name, m.hash, m.thumb_hash, m.kind, m.width, m.height,
      COUNT(x.id) AS count, MIN(x.timestamp) AS first_ts, MAX(x.timestamp) AS last_ts
    FROM albums a
    JOIN media x ON x.album_id = a.id
    LEFT JOIN media m ON m.id = a.cover_media_id
    GROUP BY a.id ORDER BY first_ts DESC`);
  const byYear = groupBy(albums, (a) => fmtDate(a.first_ts).slice(-4));

  const collections = [];
  for (const key of ["other", "videos"]) {
    const { title, where, params } = mediaSet(key);
    const stats = await setStats(db, where, params);
    const cover = await first(db, `SELECT * FROM media WHERE ${where} ORDER BY timestamp DESC LIMIT 1`, params);
    if (cover) collections.push({ key, title, cover, ...stats });
  }
  const taggedCount = (await first(db, "SELECT COUNT(*) AS n FROM tagged_photos")).n;
  return views.photosPage(ctx, { byYear, collections, tagged: taggedCount });
}

async function album(ctx, params, key) {
  const { db } = ctx;
  const set = mediaSet(key);
  if (!set) return null;
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
  for (const key of new Set(rows.map((c) => c.target))) targets.set(key, await findTarget(db, key));
  const seen = user.activity_seen_at ?? 0;
  if (paging.page === 1) {
    await db.prepare("UPDATE users SET activity_seen_at = ? WHERE id = ?").bind(now(), user.id).run();
    ctx.newComments = 0;
  }
  const items = rows.map((c) => ({ ...c, on: targets.get(c.target), isNew: c.created_at > seen && c.author_id !== user.id }));
  return views.activityPage(ctx, { items, paging });
}

/** The owner's Feed: new posts from connected friends' sites. */
async function feed(ctx) {
  if (!ctx.user.is_owner) return null;
  return views.feedPage(ctx, await loadFeed(ctx.db));
}
