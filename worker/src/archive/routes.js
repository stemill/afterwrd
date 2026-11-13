// The site's pages for the owner: their posts and photos (made on afterwrd, and from their Facebook download, in the
// same tables, told apart by `source`), Facebook's record of their life there (facebook_*), friends, groups and
// events. Of the Facebook download, only the sections chosen when importing are served.
import { groupPostId, postId as postAddress } from "../../public/static/activity.js";
import { eventsFor, invitable, keepFriendEvents, oldEventsGone } from "../events.js";
import { datesOf, FINISHED_SQL, finishedAt, icsFile, monthSpan, readDay, readMonth, readWeek, weekSpan } from "../calendar.js";
import { connectedToken } from "../cloudflare.js";
import { commentable, findTarget, latestComments, loadThreads, newCount, photoKey } from "./comments.js";
import { sitePolls } from "../polls.js";
import { editablePosts, postVersions } from "../edits.js";
import { connectionById, loadFeed, markMine, noteAnswer, rememberPicture } from "../feed.js";
import * as friend from "../friends.js";
import { MAX_GROUP_PHOTOS, MAX_MEMBERS } from "../groups.js";
import { whereAmI } from "../groupsites.js";
import * as groups from "../membership.js";
import { ownerName } from "../peers.js";
import { profilePictures } from "../photos.js";
import { newDevices } from "../admin.js";
import { newPushDevices, pushKey } from "../push.js";
import { checkRequests, lastChecked, recentChecks } from "../checks.js";
import { securityFixWaiting, waitingRelease } from "../update.js";
import { autoState } from "../auto.js";
import { checkGrant, friendCheckAlerts, lastFailure } from "../friendchecks.js";
import { now, pageData, withoutKeys } from "../util.js";
import { safeNext } from "../auth.js";
import { fmtDate, fmtMonth } from "../views/format.js";
import * as views from "../views/archive.js";

const PAGE_SIZE = 50;
export const AFTERWRD_KIND = "afterwrd"; // the Posts filter's choice for posts written here
const PHOTO_PAGE_SIZE = 150;

const POST_SQL = `
  SELECT p.*, t.name AS target_name FROM posts p
  LEFT JOIN facebook_people t ON t.id = p.target_id`;
// The owner's comments and likes on Facebook (not comments here, which are archive/comments.js).
const COMMENT_SQL = `
  SELECT c.*, o.name AS owner_name, a.name AS author_name, a.is_me AS author_is_me
  FROM facebook_comments c
  LEFT JOIN facebook_people o ON o.id = c.target_owner_id
  LEFT JOIN facebook_people a ON a.id = c.author_id`;
const REACTION_SQL = `
  SELECT r.*, o.name AS owner_name FROM facebook_reactions r
  LEFT JOIN facebook_people o ON o.id = r.target_owner_id`;
const MEDIA_ORDER = "ORDER BY COALESCE(created_at, 0), id";
const PERSON_TABS = {
  comments: ["Comments", `${COMMENT_SQL} WHERE c.target_owner_id = ? ORDER BY c.created_at DESC`],
  likes: ["Likes", `${REACTION_SQL} WHERE r.target_owner_id = ? ORDER BY r.created_at DESC`],
  wall: ["Wall posts", `${POST_SQL} WHERE p.target_id = ? ORDER BY p.created_at DESC`],
  tags: ["Tagged together", `${POST_SQL} JOIN facebook_post_tags pt ON pt.post_id = p.id WHERE pt.person_id = ? ORDER BY p.created_at DESC`],
  photos: ["Photos of you", "SELECT * FROM facebook_tagged_photos t WHERE t.owner_id = ? ORDER BY t.created_at DESC"],
};

// [pattern, section(s) any of which must be published (null: always), loader, view]. A loader gathers the page's
// data and returns it as plain data (no HTML, and never a key: util.js pageData), or a Response (a redirect, a file),
// or null for 404; the view (views/archive.js) turns the data into the page. A loader that can't reach a friend's or
// group's site throws a Problem, shown by that view instead.
/** @type {Array<[RegExp, string | string[] | null, (ctx: any, params: URLSearchParams, ...match: string[]) => any, ((frame: any, data: any) => any) | null]>} */
const ROUTES = [
  [/^\/$/, null, home, views.homePage],
  [/^\/overview$/, "overview", overview, views.overviewPage],
  [/^\/memories$/, null, memories, views.memoriesPage],
  [/^\/timeline$/, "timeline", timeline, views.timelinePage],
  [/^\/posts$/, "posts", posts, views.postsPage],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})$/, ["posts", "timeline", "friends"], post, views.postPage],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})\/event$/, null, ownEventEdit, views.ownEventEditPage],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})\/event\.ics$/, null, ownEventFile, null],
  [/^\/comments$/, "comments", comments, views.commentsPage],
  [/^\/likes$/, "likes", likes, views.likesPage],
  [/^\/photos$/, "photos", photos, views.photosPage],
  [/^\/photos\/tagged$/, "photos", tagged, views.taggedPage],
  [/^\/photos\/album\/([^/]+)$/, "photos", album, views.albumPage],
  [/^\/photos\/(\d+)$/, "photos", photo, views.photoPage],
  [/^\/photos\/sha256\/([0-9a-f]{64})$/, "photos", photoByHash, null],
  [/^\/friends$/, "friends", friends, views.friendsPage],
  [/^\/people\/(\d+)$/, "friends", person, views.personPage],
  [/^\/activity$/, null, activity, views.activityPage],
  [/^\/friend$/, null, friendsIndex, views.friendsIndexPage],
  [/^\/friend\/(\d+)$/, null, friendHome, null],
  [/^\/friend\/(\d+)\/posts$/, null, friendPosts, views.friendPostsPage],
  [/^\/friend\/(\d+)\/posts\/(post-\d+-[0-9a-f]{8})$/, null, friendPost, views.friendPostPage],
  [/^\/friend\/(\d+)\/posts\/(post-\d+-[0-9a-f]{8})\/event\.ics$/, null, friendEventFile, null],
  [/^\/friend\/(\d+)\/photos$/, null, friendPhotos, views.friendPhotosPage],
  [/^\/friend\/(\d+)\/photos\/album\/(\d+|other|videos)$/, null, friendAlbum, views.friendAlbumPage],
  [/^\/friend\/(\d+)\/photos\/([0-9a-f]{64})$/, null, friendPhoto, views.friendPhotoPage],
  [/^\/app$/, null, () => ({}), views.appPage], // Add to home screen
  [/^\/groups$/, null, groupsIndex, views.groupsIndexPage],
  [/^\/events$/, null, eventsIndex, views.eventsPage],
  [/^\/groups\/new$/, null, groupNew, views.groupNewPage],
  [/^\/groups\/join$/, null, groupJoin, views.groupJoinPage],
  [/^\/groups\/(\d{1,15})$/, null, groupHome, views.groupPage],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})$/, null, groupPost, views.groupPostPage],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})\/photos\/([0-9a-f]{64})$/, null, groupPhoto, views.groupPhotoPage],
  [/^\/groups\/(\d{1,15})\/members$/, null, groupMembers, views.groupMembersPage],
  [/^\/groups\/(\d{1,15})\/calendar$/, null, groupCalendar, views.groupCalendarPage],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})\/edit$/, null, groupEventEdit, views.groupEventEditPage],
  [/^\/groups\/(\d{1,15})\/posts\/(\d{1,15})\/event\.ics$/, null, groupEventFile, null],
];

/** A friend's or group's site couldn't give a page what it needed: `view` shows `data` instead. */
class Problem extends Error {
  constructor(view, data) {
    super(data.message);
    this.view = view;
    this.data = data;
  }
}

export async function renderArchive(request, env, url, user, work) {
  const db = env.DB;
  const [settings, me] = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'sections'"),
    db.prepare(`SELECT p.*, pm.hash AS profile_hash, cm.hash AS cover_hash FROM facebook_people p
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
    newRelease: await waitingRelease(env, work), // the newer afterwrd that's out, if any
    me: me.results[0] ?? { id: -1, name: await ownerName(db), is_me: 1 },
    ownerName: await ownerName(db), // their name here, which can differ from the Facebook one (me.name)
    profile: await profilePictures(db),
    friendFaces: await friendFaces(db),
  };
  ctx.updateWaiting = Boolean(ctx.newRelease);
  // A profile picture or cover chosen here takes over from Facebook's.
  if (ctx.profile.profile) Object.assign(ctx.me, { profile_hash: ctx.profile.profile.hash, profile_media_id: ctx.profile.profile.id });
  if (ctx.profile.cover) Object.assign(ctx.me, { cover_hash: ctx.profile.cover.hash, cover_media_id: ctx.profile.cover.id });

  for (const [pattern, section, load, view] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match || (section && ![section].flat().some((s) => sections.includes(s)))) continue;
    let data;
    let show = view;
    try {
      data = await load(ctx, url.searchParams, ...match.slice(1));
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      [show, data] = [error.view, error.data];
    }
    if (data instanceof Response) return data;
    if (!data) break;
    const shown = pageData(env, data);
    try {
      return page(show(frame(ctx), shown));
    } catch (error) {
      // Something from a friend's or group's site that its page couldn't show: said on the page, as it always was.
      if (show !== view || !(data.friend || data.membership)) throw error;
      return page(data.friend ? views.friendProblem(frame(ctx), { friend: data.friend, message: error.message })
        : views.groupProblem(frame(ctx), { membership: data.membership, message: error.message }));
    }
  }
  return new Response("Not found", { status: 404 });
}

/**
 * What every page's header and links need, apart from its own data: who's signed in, where they are, their
 * picture, what they've published, and the counts on the menu. No database or secrets: views only draw.
 */
function frame(ctx) {
  const { url, chosen, sections, newComments, zone, requests, updateWaiting, me, ownerName, profile, friendFaces } = ctx;
  return { url, user: { id: ctx.user.id, name: ctx.user.name }, chosen, sections, newComments, zone, requests, updateWaiting,
    me, ownerName, profile, friendFaces };
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
  const rows = await all(db, `SELECT DISTINCT strftime('%Y', created_at, 'unixepoch') AS y FROM ${table} ORDER BY y DESC`);
  return rows.map((r) => r.y);
}

/** Rows with a `media` list attached via media.<column>. */
async function withMedia(db, rows, column) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const media = await all(db, `SELECT * FROM media WHERE ${column} IN (${marks(ids)}) ORDER BY created_at, id`, ids);
  return rows.map((r) => ({ ...r, media: media.filter((m) => m[column] === r.id) }));
}

/**
 * Posts with their photos, tags and (unless `threads` is false) the comments written on them here. `thread` is
 * undefined without threads, null for a post that takes no comments (Facebook's, for now), else its comments.
 */
async function loadPosts(db, rows, { threads = true } = {}) {
  const posts = await withMedia(db, rows, "post_id");
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const tags = await all(db, `SELECT t.post_id, p.id, p.name FROM facebook_post_tags t JOIN facebook_people p ON p.id = t.person_id
    WHERE t.post_id IN (${marks(ids)})`, ids);
  const own = posts.filter((p) => p.source === "afterwrd");
  const comments = threads ? await loadThreads(db, own.map((p) => p.key)) : null;
  // Polls in posts written here, with who chose what: this is the owner's own site.
  const polls = await sitePolls(db, own.map((p) => p.id), "site");
  // Edits (edits.js): what posts written here said before, and which can still be changed.
  const earlier = await postVersions(db, own.filter((p) => p.edited_at).map((p) => p.id));
  const editable = await editablePosts(db, own.map((p) => p.id));
  // The owner's events (events.js), with everyone invited and their answers: this is the host's own site.
  const events = await eventsFor(db, own.map((p) => p.id));
  return posts.map((p) => ({
    ...p, tags: tags.filter((t) => t.post_id === p.id), thread: comments ? comments.get(p.key) ?? null : undefined,
    poll: polls.get(p.id) ?? null, earlier: earlier.get(p.id) ?? [], editable: editable.has(p.id), event: events.get(p.id) ?? null,
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
  const tables = { posts: "posts", comments: "facebook_comments", reactions: "facebook_reactions", media: "media", albums: "albums",
    tagged_photos: "facebook_tagged_photos" };
  const counts = {};
  const results = await db.batch([
    ...Object.values(tables).map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)),
    db.prepare("SELECT COUNT(*) AS n FROM facebook_people WHERE friend_since IS NOT NULL"),
  ]);
  Object.keys(tables).forEach((name, i) => { counts[name] = results[i].results[0].n; });
  counts.friends = results.at(-1).results[0].n;
  const byYear = await all(db, `
    SELECT year, SUM(t = 'p') AS posts, SUM(t = 'c') AS comments, SUM(t = 'r') AS reactions, SUM(t = 'm') AS photos
    FROM (
      SELECT strftime('%Y', created_at, 'unixepoch') AS year, 'p' AS t FROM posts
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'c' FROM facebook_comments
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'r' FROM facebook_reactions
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'm' FROM media WHERE created_at IS NOT NULL
    )
    GROUP BY year ORDER BY year DESC`);
  const topPeople = await all(db, `
    SELECT p.id, p.name, p.friend_since,
      (SELECT COUNT(*) FROM facebook_comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM facebook_reactions r WHERE r.target_owner_id = p.id) AS reactions
    FROM facebook_people p WHERE p.is_me = 0
    ORDER BY comments + reactions DESC LIMIT 15`);
  return { counts, byYear, topPeople };
}

async function timeline(ctx, params) {
  const { db } = ctx;
  const year = params.get("year") ?? "";
  const f = new Filters();
  if (year) f.add("strftime('%Y', created_at, 'unixepoch') = ?", year);
  const sql = `
    SELECT * FROM (
      SELECT 'post' AS type, id, created_at FROM posts
      UNION ALL SELECT 'comment', id, created_at FROM facebook_comments
      UNION ALL SELECT 'reaction', id, created_at FROM facebook_reactions
    ) ${f.sql} ORDER BY created_at DESC, type, id DESC`;
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
  const allYears = [...new Set([...await years(db, "posts"), ...await years(db, "facebook_comments"), ...await years(db, "facebook_reactions")])]
    .sort().reverse();
  return { items, paging, years: allYears, year };
}

async function posts(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (!ctx.chosen.includes("posts")) f.add("p.source = 'afterwrd'");
  if (q) f.add("(p.text LIKE ? OR p.title LIKE ? OR p.link_url LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', p.created_at, 'unixepoch') = ?", year);
  // Facebook's kinds, or AFTERWRD_KIND for posts written here (which have none).
  if (kind === AFTERWRD_KIND) f.add("p.source = 'afterwrd'");
  else if (kind) f.add("p.kind = ?", kind);
  const { rows, paging } = await paginate(db, `${POST_SQL} ${f.sql} ORDER BY p.created_at DESC`, f.params, pageNumber(params));
  const own = ctx.chosen.includes("posts") ? "" : "WHERE source = 'afterwrd'";
  const kinds = (await all(db, `SELECT COALESCE(kind, '${AFTERWRD_KIND}') AS kind FROM posts ${own} GROUP BY 1 ORDER BY COUNT(*) DESC`))
    .map((r) => r.kind);
  const postYears = (await all(db, `SELECT DISTINCT strftime('%Y', created_at, 'unixepoch') AS y FROM posts ${own} ORDER BY y DESC`))
    .map((r) => r.y);
  return { posts: await loadPosts(db, rows), paging, q, year, kind, years: postYears, kinds };
}

async function comments(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(c.text LIKE ? OR o.name LIKE ? OR c.group_name LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', c.created_at, 'unixepoch') = ?", year);
  if (kind) f.add("c.target_kind = ?", kind);
  const { rows, paging } = await paginate(db, `${COMMENT_SQL} ${f.sql} ORDER BY c.created_at DESC`, f.params, pageNumber(params));
  const kinds = (await all(db, `SELECT target_kind FROM facebook_comments WHERE target_kind IS NOT NULL
    GROUP BY target_kind ORDER BY COUNT(*) DESC`)).map((r) => r.target_kind);
  return {
    comments: await loadComments(db, rows), paging, q, year, kind, years: await years(db, "facebook_comments"), kinds,
  };
}

async function likes(ctx, params) {
  const { db } = ctx;
  const [q, year, reaction] = ["q", "year", "reaction"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(o.name LIKE ? OR r.group_name LIKE ?)", ...Array(2).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', r.created_at, 'unixepoch') = ?", year);
  if (reaction) f.add("r.reaction = ?", reaction);
  const { rows, paging } = await paginate(db, `${REACTION_SQL} ${f.sql} ORDER BY r.created_at DESC`, f.params, pageNumber(params));
  const reactionTypes = (await all(db, "SELECT reaction FROM facebook_reactions GROUP BY reaction ORDER BY COUNT(*) DESC"))
    .map((r) => r.reaction);
  return { reactions: rows, paging, q, year, reaction, years: await years(db, "facebook_reactions"), reactionTypes };
}

/**
 * Filter for a photo set: an album id, or 'other' and 'videos' (Facebook's photos and videos outside albums: every
 * photo made on afterwrd is in an album).
 */
export function mediaSet(key) {
  if (key === "videos") return { title: "Videos", where: "album_id IS NULL AND source = 'facebook' AND kind = 'video'", params: [] };
  if (key === "other") return { title: "Other photos", where: "album_id IS NULL AND source = 'facebook' AND kind = 'photo'", params: [] };
  if (/^\d+$/.test(key)) return { title: null, where: "album_id = ?", params: [Number(key)] };
  return null;
}

const setStats = (db, where, params) => first(db,
  `SELECT COUNT(*) AS count, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts FROM media WHERE ${where}`, params);

async function photos(ctx) {
  const { db } = ctx;
  const imported = ctx.chosen.includes("photos");
  const albums = await all(db, `
    SELECT a.id, a.name, m.hash, m.thumb_hash, m.kind, m.width, m.height,
      COUNT(x.id) AS count, MIN(x.created_at) AS first_ts, MAX(x.created_at) AS last_ts
    FROM albums a
    JOIN media x ON x.album_id = a.id
    LEFT JOIN media m ON m.id = COALESCE(a.cover_media_id, (SELECT MAX(id) FROM media y WHERE y.album_id = a.id))
    ${imported ? "" : "WHERE a.source = 'afterwrd'"}
    GROUP BY a.id ORDER BY first_ts DESC`);
  const byYear = groupBy(albums, (a) => fmtDate(a.first_ts).slice(-4));

  const collections = [];
  for (const key of imported ? ["other", "videos"] : []) {
    const { title, where, params } = mediaSet(key);
    const stats = await setStats(db, where, params);
    const cover = await first(db, `SELECT * FROM media WHERE ${where} ORDER BY created_at DESC LIMIT 1`, params);
    if (cover) collections.push({ key, title, cover, ...stats });
  }
  const taggedCount = imported ? (await first(db, "SELECT COUNT(*) AS n FROM facebook_tagged_photos")).n : 0;
  return { byYear, collections, tagged: taggedCount };
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
  // Facebook's albums only if Photos was published from the download.
  if (info?.source !== "afterwrd" && !ctx.chosen.includes("photos")) return null;
  const stats = await setStats(db, set.where, set.params);
  const { rows, paging } = await paginate(db, `SELECT * FROM media WHERE ${set.where} ${MEDIA_ORDER}`, set.params,
    pageNumber(params), PHOTO_PAGE_SIZE);
  // Long-running sets read better split by month; a single trip's album doesn't need it.
  const spansMonths = fmtMonth(stats.first_ts) !== fmtMonth(stats.last_ts);
  const groups = spansMonths ? groupBy(rows, (m) => fmtMonth(m.created_at)) : [[null, rows]];
  return { key, title, info, stats, groups, paging };
}

async function tagged(ctx, params) {
  if (!ctx.chosen.includes("photos")) return null;
  const { rows, paging } = await paginate(ctx.db, `
    SELECT t.*, p.name AS owner_name FROM facebook_tagged_photos t LEFT JOIN facebook_people p ON p.id = t.owner_id
    ORDER BY t.created_at DESC`, [], pageNumber(params));
  return { tagged: rows, paging };
}

/**
 * A photo or video, among the rest of its album; or, opened from a post (?in=post), among that post's photos, with
 * ✕ going back to where the post was (?back=, a page on this site), not into the middle of an album.
 */
async function photo(ctx, params, id) {
  const { db } = ctx;
  const m = await first(db, "SELECT * FROM media WHERE id = ?", [Number(id)]);
  if (!m) return null;
  const setKey = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  const inPost = params.get("in") === "post" && m.post_id != null;
  const { where, params: setParams, title } = inPost ? { where: "post_id = ?", params: [m.post_id], title: "Post" } : mediaSet(setKey);
  const setTitle = title ?? (await first(db, "SELECT name FROM albums WHERE id = ?", setParams)).name;
  const order = "(COALESCE(created_at, 0), id)";
  const position = [m.created_at ?? 0, m.id];
  const [prev, next, index] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} < (?, ?)
      ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} > (?, ?) ${MEDIA_ORDER} LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${where} AND ${order} < (?, ?)`).bind(...setParams, ...position),
  ]);
  const before = index.results[0].n;
  // The post a photo came with is shown for context; comments here are on the photo itself.
  const post = m.post_id
    ? (await loadPosts(db, await all(db, `${POST_SQL} WHERE p.id = ?`, [m.post_id]), { threads: false }))[0] : null;
  const comment = m.comment_id
    ? (await loadComments(db, await all(db, `${COMMENT_SQL} WHERE c.id = ?`, [m.comment_id])))[0] : null;
  // From a post: back where it was, and the post's other photos keep to the post too.
  const postPage = post && /^post-\d+-[0-9a-f]{8}$/.test(post.key) ? `/posts/${post.key}` : "/posts";
  const back = inPost ? (params.get("back") ? safeNext(params.get("back"), ctx.url) : postPage) : null;
  return {
    m, setKey, setTitle: inPost && post?.source === "afterwrd" ? "Your post" : setTitle, prev: prev.results[0], next: next.results[0],
    index: before + 1, total: (await setStats(db, where, setParams)).count, albumPage: Math.floor(before / PHOTO_PAGE_SIZE) + 1,
    post, comment, back, stay: inPost ? `?${new URLSearchParams({ in: "post", back })}` : "",
    ...await photoThread(db, m),
  };
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
      (SELECT COUNT(*) FROM facebook_comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM facebook_reactions r WHERE r.target_owner_id = p.id) AS reactions,
      (SELECT COUNT(*) FROM posts x WHERE x.target_id = p.id) AS wall,
      (SELECT COUNT(*) FROM facebook_tagged_photos t WHERE t.owner_id = p.id) AS tagged
    FROM facebook_people p ${f.sql} ORDER BY ${order}`, f.params);
  return { people, q, show, sort };
}

async function person(ctx, params, id) {
  const { db } = ctx;
  const personId = Number(id);
  const p = await first(db, "SELECT * FROM facebook_people WHERE id = ?", [personId]);
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
  return { person: p, tabs, counts, tab, rows, paging };
}

async function post(ctx, params, key) {
  const found = await findTarget(ctx.db, key);
  if (!found) return null;
  const [p] = await loadPosts(ctx.db, await all(ctx.db, `${POST_SQL} WHERE p.id = ?`, [found.post.id]));
  if (p.event) {
    // Friends who could still be invited.
    const asked = new Set([...p.event.going, ...p.event.maybe, ...p.event.cantGo, ...p.event.waiting].map((g) => g.id));
    p.invitable = (await invitable(ctx.db)).filter((f) => !asked.has(f.id)).map(({ id, name }) => ({ id, name }));
  }
  return { post: p };
}

/** Changing the owner's own event. */
async function ownEventEdit(ctx, params, key) {
  const found = await findTarget(ctx.db, key);
  if (found?.post?.source !== "afterwrd") return null;
  const event = (await eventsFor(ctx.db, [found.post.id])).get(found.post.id);
  return event ? { post: { id: found.post.id, key, text: found.post.text, event } } : null;
}

/** The owner's own event as a calendar file. */
async function ownEventFile(ctx, params, key) {
  const found = await findTarget(ctx.db, key);
  const e = found?.post && await first(ctx.db, "SELECT * FROM events WHERE post_id = ?", [found.post.id]);
  if (!e) return null;
  const page = `${ctx.url.origin}/posts/${key}`;
  return new Response(icsFile(e, { uid: postAddress(ctx.url.origin, key), url: page, about: [found.post.text, page].filter(Boolean).join("\n\n") }), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="event.ics"',
      "Cache-Control": "private, no-store" } });
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
  return { items, paging };
}

// Introductions from friends still here, to people the owner isn't connected with (or asking) yet (connect.js).
const INTRODUCTION_DAYS = 60;
const INTRODUCTIONS_SQL = `SELECT i.id, i.origin, i.name, i.note, c.name AS by_name FROM introductions i
      JOIN connections c ON c.id = i.connection_id AND c.approved_at IS NOT NULL AND c.reached_at IS NOT NULL
      WHERE i.created_at > ? AND NOT EXISTS (SELECT 1 FROM connections k WHERE k.origin = i.origin AND k.connected_at IS NOT NULL)
      ORDER BY i.created_at DESC`;

/** Home: write something, then the owner's own posts written here and their friends' newest, together. */
async function home(ctx, params) {
  const { db } = ctx;
  const own = await loadPosts(db, await all(db, `${POST_SQL} WHERE p.source = 'afterwrd' ORDER BY p.created_at DESC LIMIT 30`));
  const friendsFeed = await loadFeed(db, ctx.url.origin, ctx.env);
  return {
    own, feed: friendsFeed, onThisDay: await onThisDay(ctx, 2), friends: friendsFeed.connections,
    newDevices: await newDevices(db, ctx.user), newNotifying: await newPushDevices(db), securityFix: await securityFixWaiting(db),
    auto: await autoState(db), // automatic updates (auto.js): offered once, and anything that needs the owner
    // Until it's been checked (by a friend's site, or the owner themselves: checks.js), Home suggests a check.
    unchecked: !(await lastChecked(db)),
    // Friends asking for their site to be checked: one tap makes the link to send back (checks.js).
    checkRequests: await checkRequests(db),
    // A friend's site that checked this one and found something; this one's checks of friends' sites that did (or
    // that their sites keep refusing): friendchecks.js.
    checkFailure: await lastFailure(db),
    friendChecks: await friendCheckAlerts(db),
    checkGrant: await checkGrant(db), // offered once, after automatic updates
    // Someone asking to be friends: approved (or not) from Home in one tap, as well as from Friends.
    asking: await all(db, `SELECT id, origin, name, invited_as, via_kind, via_name FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL
      ORDER BY connected_at DESC LIMIT 3`),
    // Friends introducing the owner to someone: asked (or not) from Home too.
    introductions: await all(db, `${INTRODUCTIONS_SQL} LIMIT 3`, [now() - INTRODUCTION_DAYS * 86400]),
  };
}

async function memories(ctx) {
  return { onThisDay: await onThisDay(ctx, 6) };
}

/** Posts from this day of the year (in London) in earlier years, newest first, with their photos. */
async function onThisDay(ctx, limit) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const rows = await all(ctx.db, `${POST_SQL} WHERE strftime('%m-%d', p.created_at, 'unixepoch') = ?
    AND strftime('%Y', p.created_at, 'unixepoch') < ? ORDER BY p.created_at DESC LIMIT ?`, [`${parts.month}-${parts.day}`, parts.year, limit]);
  return loadPosts(ctx.db, rows, { threads: false });
}

/** A photo's comments ({key, thread}), if it takes them: only a picture posted on afterwrd, for now. */
async function photoThread(db, m) {
  const key = photoKey(m);
  if (!key || !commentable(await findTarget(db, key))) return { key: null, thread: null };
  return { key, thread: (await loadThreads(db, [key])).get(key) };
}

/** A photo's permanent address (public/static/activity.js) leads to its page: afterwrd's, if it's there too. */
async function photoByHash(ctx, params, hash) {
  const m = await first(ctx.db, "SELECT id FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1", [hash]);
  return m ? Response.redirect(`${ctx.url.origin}/photos/${m.id}${ctx.url.hash}`, 302) : null;
}

// --- a connected friend's posts and photos, read from their site (friends.js) ---------------------------------------

/**
 * Only the owner reads friends' sites from here. `load` gets the connection (with the key to call their site) and
 * returns the page's data; the page is given the friend without it.
 */
async function fromFriend(ctx, id, load) {
  const connection = await connectionById(ctx.db, id);
  if (!connection) return null;
  connection.facebook = await facebookSelf(ctx.db, connection);
  try {
    const data = await load(connection);
    await noteAnswer(ctx.db, connection).run();
    return { ...data, friend: withoutKeys(connection) };
  } catch (error) {
    await noteAnswer(ctx.db, connection, error).run();
    throw new Problem(views.friendProblem, { friend: withoutKeys(connection), message: error.message });
  }
}

/**
 * The owner's Friends: friends on afterwrd (connected sites), each linked, if the owner says so, to who they are in
 * the Facebook download; then everyone else from that download. Matching names are suggested, never assumed.
 */
async function friendsIndex(ctx) {
  const { db } = ctx;
  const [connections, links, people, requests, invites, introductions] = await db.batch([
    db.prepare("SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT * FROM friend_links"),
    db.prepare("SELECT id, name, friend_since FROM facebook_people WHERE is_me = 0 AND friend_since IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare(`SELECT id, origin, name, invited_as, via_kind, via_name, connected_at FROM connections
      WHERE connected_at IS NOT NULL AND approved_at IS NULL ORDER BY connected_at DESC`),
    db.prepare(`SELECT person_name, MAX(created_at) AS invited_at FROM connect_links
      WHERE person_name IS NOT NULL AND used_at IS NULL AND expires_at > ? GROUP BY person_name`).bind(now()),
    db.prepare(INTRODUCTIONS_SQL).bind(now() - INTRODUCTION_DAYS * 86400),
  ]);
  const same = (a, b) => a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;
  const linked = new Map(links.results.map((l) => [l.connection_id, l]));
  const taken = links.results.filter((l) => l.person_name);
  const friends = connections.results.map(withoutKeys).map((c) => {
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
  return { friends, facebook, requests: requests.results, introductions: introductions.results,
    checks: await recentChecks(db) };
}

/** Who a friend on afterwrd is in the owner's Facebook download, if the owner has linked them. */
async function facebookSelf(db, connection) {
  return first(db, `SELECT p.id, p.name FROM friend_links l JOIN facebook_people p ON p.name = l.person_name COLLATE NOCASE AND p.is_me = 0
    WHERE l.connection_id = ? LIMIT 1`, [connection.id]);
}

async function friendHome(ctx, params, id) {
  return Response.redirect(`${ctx.url.origin}/friend/${id}/posts`, 302);
}

async function friendPosts(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => {
    const { posts, paging, avatar, cover } = await friend.friendPosts(c, pageNumber(params), ctx.env);
    Object.assign(c, { avatar, cover });
    if (avatar) await rememberPicture(ctx.db, c, avatar)?.run();
    for (const p of posts) p.comments = await markMine(ctx.db, c.id, p.key, p.comments, ctx.url.origin);
    await keepFriendEvents(ctx.db, c, posts);
    return { posts, paging };
  });
}

/** One of a friend's posts (an event they invited the owner to, say), with its comments. */
async function friendPost(ctx, params, id, key) {
  return fromFriend(ctx, id, async (c) => {
    const p = await friend.friendPost(c, key, ctx.env);
    if (!p) {
      // Gone, or no longer shown to the owner (an invitation taken back): so is the owner's copy of it.
      await ctx.db.prepare("DELETE FROM events_elsewhere WHERE connection_id = ? AND post_key = ?").bind(c.id, key).run();
      throw new Error("That post isn't there any more.");
    }
    p.comments = await markMine(ctx.db, c.id, p.key, p.comments, ctx.url.origin);
    await keepFriendEvents(ctx.db, c, [p]);
    return { post: p };
  });
}

/** A friend's event as a calendar file, from the owner's own copy of it. */
async function friendEventFile(ctx, params, id, key) {
  const e = await first(ctx.db, `SELECT e.*, c.name AS friend, c.origin FROM events_elsewhere e JOIN connections c ON c.id = e.connection_id
    AND c.approved_at IS NOT NULL WHERE e.connection_id = ? AND e.post_key = ?`, [Number(id), key]);
  if (!e) return null;
  const page = `${ctx.url.origin}/friend/${id}/posts/${key}`;
  return new Response(icsFile(e, { uid: postAddress(e.origin, key), url: page, about: `${e.friend}'s event: ${page}` }), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="event.ics"',
      "Cache-Control": "private, no-store" } });
}

async function friendPhotos(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => ({ albums: await friend.friendAlbums(c) }));
}

async function friendAlbum(ctx, params, id, key) {
  return fromFriend(ctx, id, async (c) => ({ album: await friend.friendAlbum(c, key, pageNumber(params)) }));
}

/**
 * A friend's photo, among the rest of its album; or, opened from their post (?in=post), among that post's photos, with
 * ✕ going back to where the post was (?back=, a page on this site). Worked out here from the post their site sends
 * with the photo, so it's the same whatever version their site is.
 */
async function friendPhoto(ctx, params, id, hash) {
  return fromFriend(ctx, id, async (c) => {
    const m = await friend.friendPhoto(c, hash);
    m.comments = await markMine(ctx.db, c.id, `photo-${m.hash}`, m.comments, ctx.url.origin);
    const photos = m.post?.photos ?? [];
    const at = params.get("in") === "post" ? photos.findIndex((p) => p.hash === m.hash) : -1;
    if (at < 0) return { photo: { ...m, inPost: null } };
    const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : `/friend/${c.id}/posts#f${c.id}-${m.post.key}`;
    return { photo: { ...m, inPost: { index: at + 1, total: photos.length, prev: photos[at - 1]?.hash ?? null,
      next: photos[at + 1]?.hash ?? null, back, stay: `?${new URLSearchParams({ in: "post", back })}` } } };
  });
}

// --- groups, each its own Worker, read from there (membership.js) ------------------------------------------------------

/** The owner's groups, with comments waiting in each. (What's coming up in them is on Events.) */
async function groupsIndex(ctx) {
  const list = await all(ctx.db, `SELECT g.*, (SELECT COUNT(*) FROM group_inbox i WHERE i.group_id = g.id AND i.created_at > ?) AS notes
    FROM groups g WHERE g.joined_at IS NOT NULL ORDER BY g.name COLLATE NOCASE`, [ctx.user.activity_seen_at ?? 0]);
  // Groups whose Worker this site made, but which it didn't finish claiming.
  const unfinished = await all(ctx.db, "SELECT id, name, origin FROM groups WHERE joined_at IS NULL AND script != '' ORDER BY created_at");
  return { groups: list.map(withoutKeys), unfinished, connected: ctx.connected };
}

const LIST_SECONDS = 366 * 86400; // the List view: from now, up to a year ahead
const GROUPS_ASKED = 20; // groups the Events page asks for their events (two requests each, at most)

/**
 * Which view of a calendar a page asks for (?view=month, week or list; month by default), and the moments it covers:
 * { view, month, day, week, from, to }. `month` and `day` for the month's grid, `week` (its Monday) for a week.
 */
function calendarView(params, zone) {
  const view = ["week", "list"].includes(params.get("view")) ? params.get("view") : "month";
  const month = readMonth(params.get("month"), zone);
  const week = readWeek(params.get("week"), zone);
  const at = now();
  const [from, to] = view === "week" ? weekSpan(week, zone) : view === "list" ? [at, at + LIST_SECONDS] : monthSpan(month, zone);
  return { view, month, day: view === "month" ? readDay(params.get("day"), month) : null, week, from, to };
}

/** What a calendar page needs to know about the view it's showing (calendarView), as plain data. */
const calendarShown = ({ view, month, day, week, from, to }) => ({ view, month, day, week, from, to });

/** An event as the calendar shows it: when, where, whose, where it's answered, and the owner's answer. */
const calendarItem = (e, more) => ({ title: e.title, starts_at: e.starts_at, ends_at: e.ends_at ?? null, all_day: e.all_day ? 1 : 0,
  time_zone: e.time_zone, place: e.place ?? null, cancelled_at: e.cancelled_at ?? null, ...more });

/**
 * Events: a month's calendar of everything the owner could go to (their own events, friends' they're invited to, and
 * their groups', read from each group now), invitations still to answer, and making an event.
 */
async function eventsIndex(ctx, params) {
  const { db } = ctx;
  const shown = calendarView(params, ctx.zone);
  const { from, to } = shown;
  const at = now();
  await oldEventsGone(db).run();
  const IN_SPAN = `${FINISHED_SQL} >= ?1 AND e.starts_at < ?2`;
  const [hosted, friends, plans, joined, invites] = await db.batch([
    db.prepare(`SELECT e.*, p.key FROM events e JOIN posts p ON p.id = e.post_id WHERE ${IN_SPAN}`).bind(from, to),
    db.prepare(`SELECT e.*, c.name AS friend FROM events_elsewhere e JOIN connections c ON c.id = e.connection_id
      AND c.approved_at IS NOT NULL WHERE ${IN_SPAN} AND e.answer IS NOT 'no'`).bind(from, to),
    db.prepare(`SELECT e.* FROM events_elsewhere e WHERE e.group_id IS NOT NULL AND ${IN_SPAN}`).bind(from, to),
    db.prepare("SELECT * FROM groups WHERE joined_at IS NOT NULL ORDER BY name COLLATE NOCASE"),
    // Invitations still to answer, for events still to come and not called off.
    db.prepare(`SELECT e.*, c.id AS connection, c.name AS friend FROM events_elsewhere e JOIN connections c ON c.id = e.connection_id
      AND c.approved_at IS NOT NULL WHERE e.answer IS NULL AND e.cancelled_at IS NULL AND ${FINISHED_SQL} >= ?1 ORDER BY e.starts_at LIMIT 50`).bind(at),
  ]);
  const items = [
    ...hosted.results.map((e) => calendarItem(e, { kind: "own", href: `/posts/${e.key}`, who: "Your event" })),
    ...friends.results.map((e) => calendarItem(e, { kind: "friend", href: `/friend/${e.connection_id}/posts/${e.post_key}`,
      who: `${e.friend}'s event`, answer: e.answer })),
  ];
  // Each group is asked for what's coming up (and, for a month already begun, what's just been): one or two requests
  // each, as Home asks friends; at most GROUPS_ASKED groups, as a page may only ask 50 other sites on the free plan.
  // A group that doesn't answer, or isn't asked, shows the owner's own copies of their plans there.
  const unreachable = [];
  const asked = new Set(joined.results.slice(0, GROUPS_ASKED).map((g) => g.id));
  await Promise.all(joined.results.map(async (g) => {
    let reply;
    try {
      if (asked.has(g.id)) reply = await groups.loadEvents(ctx.env, ctx.url.origin, g, { past: from < at });
    } catch {}
    if (reply && !reply.outdated) {
      // Each date of a repeating one on its own, with the owner's answer to it.
      for (const d of [...reply.upcoming, ...reply.past].flatMap((p) => datesOf(p.event, { from, to }).map((x) => ({ ...x, post: p.id })))) {
        if (d.answer === "no" || d.starts_at >= to || finishedAt(d) < from) continue;
        items.push(calendarItem(d, { kind: "group", href: `/groups/${g.id}/posts/${d.post}${d.date ? `?date=${d.date}` : ""}`, who: g.name, answer: d.answer }));
      }
      return;
    }
    if (!reply && asked.has(g.id)) unreachable.push(g.name);
    for (const e of plans.results.filter((x) => x.group_id === g.id)) {
      items.push(calendarItem(e, { kind: "group", href: `/groups/${g.id}/posts/${e.post_id}${e.date ? `?date=${e.date}` : ""}`, who: g.name, answer: e.answer }));
    }
  }));
  items.sort((a, b) => a.starts_at - b.starts_at);
  return {
    ...calendarShown(shown), items, unreachable, notAsked: Math.max(0, joined.results.length - GROUPS_ASKED),
    invitations: invites.results.map((e) => calendarItem(e, { connection: e.connection, key: e.post_key, who: e.friend,
      href: `/friend/${e.connection}/posts/${e.post_key}` })),
    friends: (await invitable(db)).map(({ id, name }) => ({ id, name })),
    // The site's public signing key for notifications, which a device is given when it turns them on (push.js).
    pushKey: await pushKey(ctx.env),
  };
}

/** Starting a group: its own Worker, made in the owner's Cloudflare account (groupsites.js). */
async function groupNew(ctx) {
  let address = null;
  try {
    address = whereAmI(ctx.url);
  } catch {}
  return { connected: ctx.connected, domain: address?.domain ?? null, maxPhotos: MAX_GROUP_PHOTOS };
}

/** Opened from a group's invite link: join it? */
async function groupJoin(ctx, params) {
  const link = params.get("link") ?? "";
  try {
    const info = await groups.linkInfo(ctx.env, ctx.url, link);
    if (info.joined) return Response.redirect(`${ctx.url.origin}/groups/${info.joined}`, 302);
    return { info, link };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Only the owner reads a group from here. `load` gets the owner's membership (with the key to call the group's site)
 * and returns the page's data, or a Response, or throws to say what's wrong; the page is given the membership
 * without its keys.
 */
async function fromGroup(ctx, id, load) {
  const membership = await first(ctx.db, "SELECT * FROM groups WHERE id = ? AND joined_at IS NOT NULL", [Number(id)]);
  if (!membership) return null;
  let data;
  try {
    data = await load(membership);
  } catch (error) {
    throw new Problem(views.groupProblem, { membership: withoutKeys(membership), message: error.message });
  }
  // The membership last, so nothing the group's site said can stand in for it.
  return data instanceof Response ? data : { ...data, membership: withoutKeys(membership) };
}

async function groupHome(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => ({
    ...await groups.loadGroup(ctx.env, ctx.url.origin, g, pageNumber(params)), maxPhotos: MAX_GROUP_PHOTOS }));
}

async function groupPost(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    if (!found?.post) throw new Error("That post isn't there any more.");
    return found;
  });
}

/** A photo in a group's post, among that post's photos, with ✕ going back to where the post was (?back=, on this site). */
async function groupPhoto(ctx, params, id, postId, hash) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    const photos = found?.post?.photos ?? [];
    const at = photos.findIndex((m) => m.hash === hash);
    if (at < 0) throw new Error("That photo isn't there any more.");
    const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : `/groups/${g.id}#gp${found.post.id}`;
    return { ...found, photo: photos[at], index: at + 1, total: photos.length, prev: photos[at - 1]?.hash ?? null,
      next: photos[at + 1]?.hash ?? null, back, stay: `?${new URLSearchParams({ back })}` };
  });
}

/** A group's calendar: events to come, and adding one. */
async function groupCalendar(ctx, params, id) {
  const shown = calendarView(params, ctx.zone);
  return fromGroup(ctx, id, async (g) => ({ ...await groups.loadEvents(ctx.env, ctx.url.origin, g, { past: shown.from < now() }),
    ...calendarShown(shown) }));
}

/** Changing an event the owner here added. */
async function groupEventEdit(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    if (!found?.post?.event || !found.post.mine) throw new Error("That isn't an event you added.");
    return found;
  });
}

/** An event as a calendar file, to open in the owner's own calendar. */
async function groupEventFile(ctx, params, id, postId) {
  return fromGroup(ctx, id, async (g) => {
    const found = await groups.loadGroupPost(ctx.env, ctx.url.origin, g, postId);
    const p = found?.post;
    if (!p?.event) throw new Error("That isn't an event.");
    const page = `${ctx.url.origin}/groups/${g.id}/posts/${p.id}`;
    const body = icsFile(p.event, { uid: groupPostId(g.origin, g.remote_id, p.id), url: page,
      about: [p.text, `${found.group.name}: ${page}`].filter(Boolean).join("\n\n") });
    return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="event.ics"', "Cache-Control": "private, no-store" } });
  });
}

/** Who's in a group; for its admins, also requests to join, the invite link, and running it. */
async function groupMembers(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => ({
    ...await groups.loadMembers(ctx.env, g), max: MAX_MEMBERS, connected: ctx.connected,
    // Where the owner stands with each member, to offer asking them to be friends (connect.js).
    friends: await all(ctx.db, "SELECT id, origin, approved_at, reached_at, invited_as FROM connections WHERE connected_at IS NOT NULL"),
  }));
}

/**
 * Every friend's site, with their profile picture where the link their site gave is still good (else null). Pages use
 * it for faces, and to show a site address only beside someone who isn't a friend.
 */
async function friendFaces(db) {
  const rows = await all(db, "SELECT origin, CASE WHEN avatar_exp > ? THEN avatar_url END AS avatar_url FROM connections WHERE approved_at IS NOT NULL", [now()]);
  return Object.fromEntries(rows.map((r) => [r.origin, r.avatar_url]));
}
