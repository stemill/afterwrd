// What the browser importer makes from a Facebook download, and the Worker stores in D1. Shared by the browser
// (import page) and the Worker (import endpoints, src/importer.js), so they can't drift apart.
//
// Each import uploads every table into an empty <table>_next copy, then swaps them in at once (one transaction):
// - `merged` tables (posts, media, albums) also hold what's made on afterwrd (source 'afterwrd'). Their Facebook
//   rows (source 'facebook') are replaced; their afterwrd rows stay. The live tables have more columns than here
//   (source, and albums.role/created_at): see migrations/0013_one_set_of_tables.js.
// - the facebook_* tables are Facebook's record of the owner's life there, and are replaced whole.
// Ids in an upload start from 1. Merged rows move above the ids already in use, and `refs` (the columns pointing
// at a merged table's rows) move with them. No foreign keys: the tables refer to each other in a circle.

export const ARCHIVE = {
  facebook_people: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      name: "TEXT NOT NULL",
      is_me: "INTEGER NOT NULL DEFAULT 0",
      friend_since: "INTEGER", // NULL unless currently a friend
      unfriended_at: "INTEGER",
      profile_media_id: "INTEGER", // current profile picture (only known for me)
      cover_media_id: "INTEGER", // current cover photo (only known for me)
    },
    refs: { profile_media_id: "media", cover_media_id: "media" },
    indexes: { facebook_people_me: "is_me" },
  },
  albums: {
    merged: true,
    columns: {
      id: "INTEGER PRIMARY KEY",
      name: "TEXT NOT NULL",
      description: "TEXT",
      last_modified: "INTEGER",
      cover_media_id: "INTEGER",
    },
    refs: { cover_media_id: "media" },
  },
  posts: {
    merged: true,
    columns: {
      id: "INTEGER PRIMARY KEY",
      key: "TEXT NOT NULL", // its address (activity.js facebookPostKey), made once
      created_at: "INTEGER NOT NULL",
      kind: "TEXT NOT NULL", // status | photo | video | link | shared | wall | group | checkin | review
      title: "TEXT", // Facebook's summary line, e.g. "Sam Taylor shared a link."
      text: "TEXT",
      target_id: "INTEGER", // whose profile a wall post was written on
      group_name: "TEXT",
      link_url: "TEXT",
      place_name: "TEXT",
      place_address: "TEXT",
      latitude: "REAL",
      longitude: "REAL",
      fbid: "TEXT",
    },
  },
  facebook_post_tags: {
    columns: { post_id: "INTEGER NOT NULL", person_id: "INTEGER NOT NULL" },
    primaryKey: "post_id, person_id",
    refs: { post_id: "posts" },
  },
  facebook_comments: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      created_at: "INTEGER NOT NULL",
      author_id: "INTEGER", // me, or my anonymous alias in groups
      action: "TEXT NOT NULL", // commented | replied
      target_owner_id: "INTEGER",
      target_kind: "TEXT", // post | photo | comment | reel | link | album | ...
      group_name: "TEXT",
      text: "TEXT", // NULL when the export only kept the summary line
      link_url: "TEXT",
      title: "TEXT",
    },
    indexes: { facebook_comments_owner: "target_owner_id", facebook_comments_created: "created_at" },
  },
  facebook_reactions: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      created_at: "INTEGER NOT NULL",
      reaction: "TEXT NOT NULL", // Like | Love | Haha | Wow | Sad | Angry | Care
      target_owner_id: "INTEGER",
      target_kind: "TEXT",
      group_name: "TEXT",
      url: "TEXT",
      fbid: "TEXT",
      title: "TEXT",
    },
    indexes: { facebook_reactions_owner: "target_owner_id", facebook_reactions_created: "created_at" },
  },
  media: {
    merged: true,
    columns: {
      id: "INTEGER PRIMARY KEY",
      path: "TEXT NOT NULL", // where it was in the export
      kind: "TEXT NOT NULL", // photo | video
      created_at: "INTEGER", // uploaded
      taken_at: "INTEGER",
      width: "INTEGER", // photos only, after EXIF rotation;
      height: "INTEGER", // NULL means no thumbnail could be made
      description: "TEXT",
      latitude: "REAL",
      longitude: "REAL",
      album_id: "INTEGER",
      post_id: "INTEGER",
      comment_id: "INTEGER", // a facebook_comments row, which keeps its id
      hash: "TEXT", // SHA-256 of the file: its address in storage (/files/<hash>)
      thumb_hash: "TEXT", // the thumbnail's, for photos
      size: "INTEGER",
      type: "TEXT", // MIME type
    },
    refs: { album_id: "albums", post_id: "posts" },
  },
  facebook_tagged_photos: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      created_at: "INTEGER NOT NULL",
      owner_id: "INTEGER",
      url: "TEXT",
      fbid: "TEXT",
    },
    indexes: { facebook_tagged_owner: "owner_id" },
  },
};

/** `CREATE TABLE <name>` for one of the tables above, as uploaded. */
export function createTable(name, table) {
  const { columns, primaryKey } = ARCHIVE[table];
  return `CREATE TABLE ${name} (${Object.entries(columns).map(([c, type]) => `${c} ${type}`).join(", ")}${
    primaryKey ? `, PRIMARY KEY (${primaryKey})` : ""})`;
}

/** A row with every column present: null, or the column's default. */
export function emptyRow(table) {
  const row = {};
  for (const [name, type] of Object.entries(ARCHIVE[table].columns)) {
    const fallback = /DEFAULT (\d+)/.exec(type);
    row[name] = fallback ? Number(fallback[1]) : null;
  }
  return row;
}

// Files the site will store and serve, by extension. Anything else is refused, so an upload can never be
// served back as a page.
export const MEDIA_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};
export const SERVABLE_TYPES = new Set(Object.values(MEDIA_TYPES));

// The Worker accepts request bodies up to 100 MB on Cloudflare's free plan.
export const MAX_FILE = 95 * 1024 * 1024;
