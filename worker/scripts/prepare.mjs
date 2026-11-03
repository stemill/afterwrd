// Picks what to publish from data/heybert.db (built by `uv run heybert-ingest`):
//   data/publish/archive.sql   rows for the Worker's D1 database, replacing what's there
//   data/site/                 the photos, videos and thumbnails those rows use, plus the stylesheet
//
// Only what the chosen sections show is included. With the default (posts, photos), comments only come along
// when a photo is attached to them, likes and your friends list stay on your computer, and people appear by
// name only where a post or photo mentions them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const SECTIONS = ["overview", "timeline", "posts", "photos", "comments", "likes", "friends"];
export const DEFAULT_SECTIONS = ["posts", "photos"];
const MAX_FILE = 25 * 1024 * 1024; // Cloudflare's limit for a single static asset
const MARKER = ".heybert-site";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = process.env.HEYBERT_DATA ?? join(root, "data");
export const SQL_FILE = join(dataDir, "publish", "archive.sql");
const SITE_DIR = join(dataDir, "site");

export function prepare(sections) {
  const dbPath = join(dataDir, "heybert.db");
  if (!existsSync(dbPath)) throw new Error("No data yet: run `uv run heybert-ingest <export folder>` first.");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  const on = (...names) => names.some((s) => sections.includes(s));

  // Without their own sections, posts and comments come along only to caption photos on the photo pages.
  const allPosts = on("posts", "timeline", "overview", "friends");
  const allComments = on("comments", "timeline", "overview", "friends");
  let posts = allPosts ? rows("SELECT * FROM posts")
    : on("photos") ? rows("SELECT * FROM posts WHERE id IN (SELECT post_id FROM media)") : [];
  let comments = allComments ? rows("SELECT * FROM comments")
    : on("photos") ? rows("SELECT * FROM comments WHERE id IN (SELECT comment_id FROM media)") : [];
  const reactions = on("likes", "timeline", "overview", "friends") ? rows("SELECT * FROM reactions") : [];
  const tagged = on("photos", "overview", "friends") ? rows("SELECT * FROM tagged_photos") : [];
  const albums = on("photos", "overview") ? rows("SELECT * FROM albums") : [];
  let postIds = new Set(posts.map((p) => p.id));
  let commentIds = new Set(comments.map((c) => c.id));
  const me = rows("SELECT * FROM people WHERE is_me = 1")[0];

  const profileIds = on("overview") ? [me.profile_media_id, me.cover_media_id] : [];
  const tooBig = [];
  const media = rows("SELECT * FROM media").filter((m) => {
    const wanted = on("photos") || postIds.has(m.post_id) || commentIds.has(m.comment_id) || profileIds.includes(m.id);
    if (!wanted) return false;
    const size = statSync(join(dataDir, "media", m.path), { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_FILE) tooBig.push([m.path, size]);
    return size > 0 && size <= MAX_FILE;
  });
  const mediaIds = new Set(media.map((m) => m.id));
  // A caption whose photos were all left out (missing or too big) has nothing to caption.
  if (!allPosts) posts = posts.filter((p) => media.some((m) => m.post_id === p.id));
  if (!allComments) comments = comments.filter((c) => media.some((m) => m.comment_id === c.id));
  postIds = new Set(posts.map((p) => p.id));
  commentIds = new Set(comments.map((c) => c.id));
  const postTags = rows("SELECT * FROM post_tags").filter((t) => postIds.has(t.post_id));

  // Everyone, with friendship dates, only if the friends section is published; otherwise just the people the
  // published rows name, without them.
  const named = new Set([me.id, ...posts.map((p) => p.target_id), ...postTags.map((t) => t.person_id),
    ...comments.flatMap((c) => [c.target_owner_id, c.author_id]), ...reactions.map((r) => r.target_owner_id),
    ...tagged.map((t) => t.owner_id)]);
  const people = rows("SELECT * FROM people")
    .filter((p) => on("friends") || named.has(p.id))
    .map((p) => ({
      ...p,
      friend_since: on("friends") ? p.friend_since : null,
      unfriended_at: on("friends") ? p.unfriended_at : null,
      profile_media_id: mediaIds.has(p.profile_media_id) ? p.profile_media_id : null,
      cover_media_id: mediaIds.has(p.cover_media_id) ? p.cover_media_id : null,
    }));
  db.close();

  const tables = { people, albums, posts, post_tags: postTags, comments, reactions, media, tagged_photos: tagged };
  mkdirSync(dirname(SQL_FILE), { recursive: true });
  writeFileSync(SQL_FILE, [
    ...Object.keys(tables).map((t) => `DELETE FROM ${t};`),
    ...Object.entries(tables).flatMap(([table, list]) => inserts(table, list)),
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', ${literal(JSON.stringify(sections))});`,
  ].join("\n") + "\n");

  const size = buildSite(media);
  return { counts: Object.fromEntries(Object.entries(tables).map(([t, list]) => [t, list.length])), size, tooBig };
}

function buildSite(media) {
  if (existsSync(SITE_DIR) && readdirSync(SITE_DIR).length && !existsSync(join(SITE_DIR, MARKER))) {
    throw new Error(`${SITE_DIR} isn't empty and wasn't made by heybert; move it out of the way first.`);
  }
  rmSync(SITE_DIR, { recursive: true, force: true });
  mkdirSync(SITE_DIR, { recursive: true });
  writeFileSync(join(SITE_DIR, MARKER), "");
  writeFileSync(join(SITE_DIR, ".assetsignore"), `${MARKER}\n.assetsignore\n`);

  let size = 0;
  const copy = (from, to) => {
    if (!existsSync(from)) return;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    size += statSync(from).size;
  };
  copy(join(root, "heybert", "static", "style.css"), join(SITE_DIR, "static", "style.css"));
  for (const m of media) {
    copy(join(dataDir, "media", m.path), join(SITE_DIR, "media", m.path));
    if (m.kind === "photo" && m.width) {
      const thumb = m.path.replace(/(\.[^./]*)?$/, ".jpg"); // as thumb_name() in heybert/config.py
      copy(join(dataDir, "thumbs", thumb), join(SITE_DIR, "thumbs", thumb));
    }
  }
  return size;
}

// Multi-row INSERTs, kept well under D1's 100 KB statement limit.
function inserts(table, list) {
  if (!list.length) return [];
  const columns = Object.keys(list[0]);
  const statements = [];
  let values = [];
  let length = 0;
  const flush = () => {
    if (values.length) statements.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values.join(",\n")};`);
    values = [];
    length = 0;
  };
  for (const row of list) {
    const tuple = `(${columns.map((c) => literal(row[c])).join(", ")})`;
    if (length + tuple.length > 50_000) flush();
    values.push(tuple);
    length += tuple.length;
  }
  flush();
  return statements;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function parseSections(args) {
  const i = args.indexOf("--sections");
  if (i === -1) return DEFAULT_SECTIONS;
  const value = args[i + 1] ?? "";
  const sections = value === "all" ? SECTIONS : value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = sections.filter((s) => !SECTIONS.includes(s));
  if (!sections.length || unknown.length) {
    throw new Error(`--sections takes a comma-separated list from: ${SECTIONS.join(", ")}; or 'all'`);
  }
  return sections;
}
