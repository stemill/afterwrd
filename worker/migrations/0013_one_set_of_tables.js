// One set of tables for posts, photos and albums (docs/tables-plan.md). Until now, what was made on afterwrd lived in
// site_posts, site_photos and site_albums, and was copied into Facebook's tables (posts, media, albums) at ids from
// 1,000,000,000 after every change. From here on both live in the same tables, told apart by `source`, and every post
// keeps its address in `key` instead of having it worked out from what it says.
//
// A code step, not an .sql file: the addresses of the owner's own posts are worked out here, once, exactly as the
// pages did until now, so every comment on them and link to them stays. There are only ever a few of those; a
// Facebook download can have thousands of posts, so theirs are made in SQL instead (no JavaScript time, which the
// free plan keeps short), as post-<time>-<id in hex>: they take no comments now, so their old addresses needn't
// survive, and the next import makes them afresh. Everything happens in one batch (one transaction): it either all
// happens or none of it does, and a site whose migration fails stays exactly as it was.
//
// Also: Facebook's own records get facebook_* names; site_comments, site_polls and site_poll_votes become comments,
// polls and poll_votes; `timestamp` becomes `created_at`; comments on Facebook posts and photos go (afterwrd only
// takes comments on what was made on afterwrd, for now).
import { facebookPostKey, newPostKey } from "../public/static/activity.js";

const SITE_ID = 1_000_000_000; // where the old copies of afterwrd's posts, photos and albums started
const KEYS_PER_STATEMENT = 400;

export default async function oneSetOfTables(db) {
  // The addresses of the owner's own posts, as the pages worked them out until now: from what mirror() copied (its
  // kind, and "Posted on afterwrd." when it had no title).
  const { results: written } = await db.prepare(`SELECT p.id, p.created_at, CASE WHEN EXISTS (SELECT 1 FROM site_photos f
      WHERE f.post_id = p.id) THEN 'photo' ELSE 'status' END AS kind, COALESCE(p.title, 'Posted on afterwrd.') AS title,
      p.text, NULL AS link_url, NULL AS group_name FROM site_posts p`).all();
  const taken = new Set();
  const rows = []; // [site_posts id, address]
  for (const p of written) {
    let key = facebookPostKey(p);
    // Two of the owner's own posts alike to the second: the second gets an address of its own.
    while (taken.has(key)) key = newPostKey(p.created_at);
    taken.add(key);
    rows.push([p.id, key]);
  }

  const sql = [
    // An import left unfinished: its staging tables are in the old shapes, and the next import starts afresh anyway.
    ...["people", "albums", "posts", "post_tags", "comments", "reactions", "media", "tagged_photos"]
      .map((table) => `DROP TABLE IF EXISTS ${table}_next`),
    "CREATE TABLE post_keys (id INTEGER PRIMARY KEY, key TEXT NOT NULL)",
    ...chunks(rows, KEYS_PER_STATEMENT).map((list) =>
      `INSERT INTO post_keys (id, key) VALUES ${list.map(([id, key]) => `(${id}, '${key}')`).join(", ")}`),
    // A post written since they were read (an older version still answering, mid-update) has no address yet: this
    // fails (key can't be NULL), so nothing happens, and the migration runs again, from the start, on the next request.
    "INSERT INTO post_keys (id, key) SELECT id, NULL FROM site_posts WHERE id NOT IN (SELECT id FROM post_keys)",

    // --- posts, photos and albums, from both sources ------------------------------------------------------------------
    `CREATE TABLE posts_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT NOT NULL UNIQUE,
      source         TEXT NOT NULL CHECK (source IN ('afterwrd', 'facebook')),
      created_at     INTEGER NOT NULL,
      kind           TEXT,
      title          TEXT,
      text           TEXT,
      target_id      INTEGER,
      group_name     TEXT,
      link_url       TEXT,
      place_name     TEXT,
      place_address  TEXT,
      latitude       REAL,
      longitude      REAL,
      fbid           TEXT
    )`,
    `INSERT INTO posts_new (id, key, source, created_at, kind, title, text, target_id, group_name, link_url, place_name,
      place_address, latitude, longitude, fbid)
      SELECT p.id, 'post-' || p.timestamp || '-' || printf('%08x', p.id), 'facebook', p.timestamp, p.kind, p.title, p.text,
        p.target_id, p.group_name, p.link_url, p.place_name, p.place_address, p.latitude, p.longitude, p.fbid
      FROM posts p WHERE p.id < ${SITE_ID}`,
    `INSERT INTO posts_new (id, key, source, created_at, title, text)
      SELECT ${SITE_ID} + p.id, k.key, 'afterwrd', p.created_at, p.title, p.text
      FROM site_posts p JOIN post_keys k ON k.id = p.id`,

    `CREATE TABLE media_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL CHECK (source IN ('afterwrd', 'facebook')),
      path         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      created_at   INTEGER,
      taken_at     INTEGER,
      width        INTEGER,
      height       INTEGER,
      description  TEXT,
      latitude     REAL,
      longitude    REAL,
      album_id     INTEGER,
      post_id      INTEGER,
      comment_id   INTEGER,
      hash         TEXT,
      thumb_hash   TEXT,
      size         INTEGER,
      type         TEXT
    )`,
    `INSERT INTO media_new (id, source, path, kind, created_at, taken_at, width, height, description, latitude, longitude,
      album_id, post_id, comment_id, hash, thumb_hash, size, type)
      SELECT m.id, 'facebook', m.path, m.kind, m.timestamp, m.taken_at, m.width, m.height, m.description, m.latitude,
        m.longitude, m.album_id, m.post_id, m.comment_id, m.hash, m.thumb_hash,
        m.size, m.type
      FROM media m WHERE m.id < ${SITE_ID}`,
    // Photos posted without an album of their own were shown in a made-up "Posted on afterwrd" (album 1,000,000,000):
    // now a real album, at the same id.
    `INSERT INTO media_new (id, source, path, kind, created_at, width, height, album_id, post_id, hash, thumb_hash, size, type)
      SELECT ${SITE_ID} + f.id, 'afterwrd', 'afterwrd/' || f.hash || '.jpg', 'photo', COALESCE(f.created_at, p.created_at),
        f.width, f.height, ${SITE_ID} + COALESCE(f.album_id, 0), CASE WHEN f.post_id IS NOT NULL THEN ${SITE_ID} + f.post_id END,
        f.hash, f.thumb_hash, f.size, 'image/jpeg'
      FROM site_photos f LEFT JOIN site_posts p ON p.id = f.post_id`,

    `CREATE TABLE albums_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL CHECK (source IN ('afterwrd', 'facebook')),
      name            TEXT NOT NULL,
      description     TEXT,
      created_at      INTEGER,
      last_modified   INTEGER,
      cover_media_id  INTEGER,
      role            TEXT CHECK (role IN ('posts', 'profile', 'cover'))
    )`,
    `INSERT INTO albums_new (id, source, name, description, last_modified, cover_media_id)
      SELECT id, 'facebook', name, description, last_modified, cover_media_id FROM albums WHERE id < ${SITE_ID}`,
    `INSERT INTO albums_new (id, source, name, created_at, role)
      SELECT ${SITE_ID}, 'afterwrd', 'Posted on afterwrd', MIN(created_at), 'posts' FROM media_new
      WHERE album_id = ${SITE_ID} HAVING COUNT(*) > 0`,
    // "Profile pictures" and "Cover photos" were found by name; now by what they're for.
    `INSERT INTO albums_new (id, source, name, description, created_at, role)
      SELECT ${SITE_ID} + a.id, 'afterwrd', a.name, a.description, a.created_at,
        CASE WHEN a.id = (SELECT MIN(id) FROM site_albums WHERE name = 'Profile pictures') THEN 'profile'
          WHEN a.id = (SELECT MIN(id) FROM site_albums WHERE name = 'Cover photos') THEN 'cover' END
      FROM site_albums a`,

    // --- Facebook's own records -------------------------------------------------------------------------------------
    "ALTER TABLE people RENAME TO facebook_people",
    "DROP INDEX people_me",
    "CREATE INDEX facebook_people_me ON facebook_people(is_me)",
    "ALTER TABLE post_tags RENAME TO facebook_post_tags",
    "ALTER TABLE comments RENAME TO facebook_comments",
    "ALTER TABLE facebook_comments RENAME COLUMN timestamp TO created_at",
    "DROP INDEX comments_owner",
    "DROP INDEX comments_ts",
    "CREATE INDEX facebook_comments_owner ON facebook_comments(target_owner_id)",
    "CREATE INDEX facebook_comments_created ON facebook_comments(created_at)",
    "ALTER TABLE reactions RENAME TO facebook_reactions",
    "ALTER TABLE facebook_reactions RENAME COLUMN timestamp TO created_at",
    "DROP INDEX reactions_owner",
    "DROP INDEX reactions_ts",
    "CREATE INDEX facebook_reactions_owner ON facebook_reactions(target_owner_id)",
    "CREATE INDEX facebook_reactions_created ON facebook_reactions(created_at)",
    "ALTER TABLE tagged_photos RENAME TO facebook_tagged_photos",
    "ALTER TABLE facebook_tagged_photos RENAME COLUMN timestamp TO created_at",
    "DROP INDEX tagged_owner",
    "CREATE INDEX facebook_tagged_owner ON facebook_tagged_photos(owner_id)",

    // --- the new tables take the names ----------------------------------------------------------------------------
    "DROP TABLE posts",
    "DROP TABLE media",
    "DROP TABLE albums",
    "ALTER TABLE posts_new RENAME TO posts",
    "ALTER TABLE media_new RENAME TO media",
    "ALTER TABLE albums_new RENAME TO albums",
    "CREATE INDEX posts_created ON posts(created_at)",
    "CREATE INDEX posts_source ON posts(source, created_at)",
    "CREATE INDEX posts_target ON posts(target_id)",
    "CREATE INDEX media_album ON media(album_id)",
    "CREATE INDEX media_post ON media(post_id)",
    "CREATE INDEX media_comment ON media(comment_id)",
    "CREATE INDEX media_hash ON media(hash)",
    "CREATE UNIQUE INDEX albums_role ON albums(role) WHERE role IS NOT NULL",

    // --- comments and polls on afterwrd's posts -----------------------------------------------------------------------
    // Only on what was made on afterwrd, for now: a Facebook post's address may not survive a new download.
    `DELETE FROM site_comments WHERE target NOT IN (SELECT key FROM posts WHERE source = 'afterwrd')
      AND (target NOT LIKE 'photo-%' OR substr(target, 7) NOT IN (SELECT hash FROM media WHERE source = 'afterwrd'))`,
    "ALTER TABLE site_comments RENAME TO comments",
    "DROP INDEX site_comments_target",
    "DROP INDEX site_comments_created",
    "CREATE INDEX comments_target ON comments(target, created_at)",
    "CREATE INDEX comments_created ON comments(created_at)",
    // Poll ids were site_posts ids; posts keep the ids their copies had.
    `UPDATE site_polls SET post_id = post_id + ${SITE_ID}`,
    `UPDATE site_poll_votes SET post_id = post_id + ${SITE_ID}`,
    "ALTER TABLE site_polls RENAME TO polls",
    "ALTER TABLE site_poll_votes RENAME TO poll_votes",

    "DROP TABLE site_photos",
    "DROP TABLE site_albums",
    "DROP TABLE site_posts",
    "DROP TABLE post_keys",
  ];
  return sql.map((s) => db.prepare(s));
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
