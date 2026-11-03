-- Friends' afterwrd sites this one is connected to (src/connect.js). Each side keeps the key it sends when
-- calling the other, and only a hash of the key the other sends when calling it. A row with no connected_at
-- is a connection half made, while the other site is being asked.
CREATE TABLE connections (
    id            INTEGER PRIMARY KEY,
    origin        TEXT NOT NULL UNIQUE,   -- https://their-site
    name          TEXT NOT NULL,          -- their owner's name
    their_key     TEXT,                   -- sent when calling them
    key_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of the key they send when calling us
    created_at    INTEGER NOT NULL,
    connected_at  INTEGER
);

-- One-time links for a friend's site to connect with this one; only a hash of the token is stored.
CREATE TABLE connect_links (
    token_hash  TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);

-- The owner's own copy of each comment they've left on a connected site's post (the original lives there).
CREATE TABLE comments_elsewhere (
    id             INTEGER PRIMARY KEY,
    connection_id  INTEGER NOT NULL,
    remote_id      INTEGER NOT NULL,
    target         TEXT NOT NULL,
    text           TEXT NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX comments_elsewhere_connection ON comments_elsewhere(connection_id, remote_id);
