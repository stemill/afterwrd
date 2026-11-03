// The published archive's tables: what the browser importer produces and the Worker stores in D1.
// Same shape as the tables in afterwrd/ingest.py, plus where each photo or video is stored (media.hash etc.).
// Shared by the browser (import page) and the Worker (import endpoints), so they can't drift apart.
// No foreign keys: an import replaces every table at once, and they refer to each other in a circle.

export const ARCHIVE = {
  people: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      name: "TEXT NOT NULL",
      is_me: "INTEGER NOT NULL DEFAULT 0",
      friend_since: "INTEGER", // NULL unless currently a friend
      unfriended_at: "INTEGER",
      profile_media_id: "INTEGER", // current profile picture (only known for me)
      cover_media_id: "INTEGER", // current cover photo (only known for me)
    },
    indexes: { people_me: "is_me" },
  },
  albums: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      name: "TEXT NOT NULL",
      description: "TEXT",
      last_modified: "INTEGER",
      cover_media_id: "INTEGER",
    },
  },
  posts: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      timestamp: "INTEGER NOT NULL",
      kind: "TEXT NOT NULL", // status | photo | video | link | shared | wall | group | checkin | review
      title: "TEXT", // Facebook's summary line, e.g. "Ste Millington shared a link."
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
    indexes: { posts_ts: "timestamp", posts_target: "target_id" },
  },
  post_tags: {
    columns: { post_id: "INTEGER NOT NULL", person_id: "INTEGER NOT NULL" },
    primaryKey: "post_id, person_id",
  },
  comments: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      timestamp: "INTEGER NOT NULL",
      author_id: "INTEGER", // me, or my anonymous alias in groups
      action: "TEXT NOT NULL", // commented | replied
      target_owner_id: "INTEGER",
      target_kind: "TEXT", // post | photo | comment | reel | link | album | ...
      group_name: "TEXT",
      text: "TEXT", // NULL when the export only kept the summary line
      link_url: "TEXT",
      title: "TEXT",
    },
    indexes: { comments_owner: "target_owner_id", comments_ts: "timestamp" },
  },
  reactions: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      timestamp: "INTEGER NOT NULL",
      reaction: "TEXT NOT NULL", // Like | Love | Haha | Wow | Sad | Angry | Care
      target_owner_id: "INTEGER",
      target_kind: "TEXT",
      group_name: "TEXT",
      url: "TEXT",
      fbid: "TEXT",
      title: "TEXT",
    },
    indexes: { reactions_owner: "target_owner_id", reactions_ts: "timestamp" },
  },
  media: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      path: "TEXT NOT NULL", // where it was in the export
      kind: "TEXT NOT NULL", // photo | video
      timestamp: "INTEGER", // uploaded
      taken_at: "INTEGER",
      width: "INTEGER", // photos only, after EXIF rotation;
      height: "INTEGER", // NULL means no thumbnail could be made
      description: "TEXT",
      latitude: "REAL",
      longitude: "REAL",
      album_id: "INTEGER",
      post_id: "INTEGER",
      comment_id: "INTEGER",
      hash: "TEXT", // SHA-256 of the file: its address in storage (/files/<hash>)
      thumb_hash: "TEXT", // the thumbnail's, for photos
      size: "INTEGER",
      type: "TEXT", // MIME type
    },
    indexes: { media_album: "album_id", media_post: "post_id", media_comment: "comment_id" },
  },
  tagged_photos: {
    columns: {
      id: "INTEGER PRIMARY KEY",
      timestamp: "INTEGER NOT NULL",
      owner_id: "INTEGER",
      url: "TEXT",
      fbid: "TEXT",
    },
    indexes: { tagged_owner: "owner_id" },
  },
};

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
