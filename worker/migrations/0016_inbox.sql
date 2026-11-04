-- Small notes friends' sites send when something happens there (POST /_peer/notify, see notify.js): a new post, or
-- a comment on one of their posts or photos that the owner here has commented on too. Notifications shows the
-- comments; Home's "new posts" bar counts the posts. Untrusted (cut to size, shown as text) and kept 60 days.
-- Each note names its connection by id and site, and is only shown while that connection is still there.
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,       -- 'post' or 'comment'
  target TEXT NOT NULL,     -- the post or photo on their site, as a key: post-… or photo-<sha256>
  actor TEXT,               -- for a comment, who wrote it (as their site names them)
  text TEXT,                -- the start of the post or comment
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_by_time ON inbox (created_at);
CREATE INDEX inbox_by_connection ON inbox (connection_id, kind, target);
