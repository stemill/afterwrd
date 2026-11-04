-- afterwrd's database (D1). The Worker applies migrations itself on its first request (src/migrate.js); this file
-- is the whole schema for a new site.

-- --- the owner, and signing in (src/auth.js, src/admin.js) ---------------------------------------------------------

-- One row: only the owner signs in.
CREATE TABLE users (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    activity_seen_at  INTEGER                 -- when Notifications was last opened
);

-- One-time links that add a passkey for the owner on a device (from setup, Your devices or the terminal).
CREATE TABLE device_links (
    token_hash  TEXT PRIMARY KEY,             -- SHA-256 of the link's token; the token itself isn't kept
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);

CREATE TABLE credentials (
    id            TEXT PRIMARY KEY,           -- base64url credential ID
    user_id       INTEGER NOT NULL REFERENCES users(id),
    public_key    TEXT NOT NULL,              -- base64url COSE key
    counter       INTEGER NOT NULL,
    transports    TEXT NOT NULL,              -- JSON array
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE sessions (
    token_hash     TEXT PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    expires_at     INTEGER NOT NULL,
    credential_id  TEXT                       -- the passkey that began it: removing the passkey ends the session
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Sign-in challenges already used, so none can be replayed.
CREATE TABLE used_challenges (
    challenge   TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
);

-- The site's own keys (challenge_key, media_key: made on first use) and choices (sections, profile_hash, ...).
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- --- the Facebook archive (src/importer.js) -------------------------------------------------------------------------
-- An import rebuilds these from public/static/import/schema.js, which they match. Rows at ids >= 1,000,000,000 are
-- copies of what's made on the site (site_* below), put back after every change and import (src/posts.js mirror).

CREATE TABLE people (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    is_me             INTEGER NOT NULL DEFAULT 0,
    friend_since      INTEGER,
    unfriended_at     INTEGER,
    profile_media_id  INTEGER,
    cover_media_id    INTEGER
);
CREATE INDEX people_me ON people(is_me);

CREATE TABLE albums (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    last_modified   INTEGER,
    cover_media_id  INTEGER
);

CREATE TABLE posts (
    id             INTEGER PRIMARY KEY,
    timestamp      INTEGER NOT NULL,
    kind           TEXT NOT NULL,
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
);
CREATE INDEX posts_ts ON posts(timestamp);
CREATE INDEX posts_target ON posts(target_id);

CREATE TABLE post_tags (
    post_id    INTEGER NOT NULL,
    person_id  INTEGER NOT NULL,
    PRIMARY KEY (post_id, person_id)
);

CREATE TABLE comments (
    id               INTEGER PRIMARY KEY,
    timestamp        INTEGER NOT NULL,
    author_id        INTEGER,
    action           TEXT NOT NULL,
    target_owner_id  INTEGER,
    target_kind      TEXT,
    group_name       TEXT,
    text             TEXT,
    link_url         TEXT,
    title            TEXT
);
CREATE INDEX comments_owner ON comments(target_owner_id);
CREATE INDEX comments_ts ON comments(timestamp);

CREATE TABLE reactions (
    id               INTEGER PRIMARY KEY,
    timestamp        INTEGER NOT NULL,
    reaction         TEXT NOT NULL,
    target_owner_id  INTEGER,
    target_kind      TEXT,
    group_name       TEXT,
    url              TEXT,
    fbid             TEXT,
    title            TEXT
);
CREATE INDEX reactions_owner ON reactions(target_owner_id);
CREATE INDEX reactions_ts ON reactions(timestamp);

CREATE TABLE media (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    timestamp    INTEGER,
    taken_at     INTEGER,
    width        INTEGER,
    height       INTEGER,
    description  TEXT,
    latitude     REAL,
    longitude    REAL,
    album_id     INTEGER,
    post_id      INTEGER,
    comment_id   INTEGER,
    hash         TEXT,                        -- the file in the media store (src/media.js), by SHA-256
    thumb_hash   TEXT,
    size         INTEGER,
    type         TEXT
);
CREATE INDEX media_album ON media(album_id);
CREATE INDEX media_post ON media(post_id);
CREATE INDEX media_comment ON media(comment_id);

CREATE TABLE tagged_photos (
    id         INTEGER PRIMARY KEY,
    timestamp  INTEGER NOT NULL,
    owner_id   INTEGER,
    url        TEXT,
    fbid       TEXT
);
CREATE INDEX tagged_owner ON tagged_photos(owner_id);

-- --- made on the site (src/posts.js, src/photos.js, src/archive/comments.js) ---------------------------------------

CREATE TABLE site_posts (
    id          INTEGER PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    text        TEXT,
    title       TEXT                          -- kept as written, as it's part of the post's permanent address
);

CREATE TABLE site_albums (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   INTEGER NOT NULL
);

CREATE TABLE site_photos (
    id          INTEGER PRIMARY KEY,
    post_id     INTEGER REFERENCES site_posts(id),
    album_id    INTEGER REFERENCES site_albums(id),
    hash        TEXT NOT NULL,
    thumb_hash  TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER
);
CREATE INDEX site_photos_post ON site_photos(post_id);
CREATE INDEX site_photos_album ON site_photos(album_id);

-- Comments on posts and photos here, by the owner (author_id) or a friend from their site (origin). `target` is the
-- post or photo's permanent key (post-<time>-<fingerprint> or photo-<sha256>), so comments survive re-imports.
CREATE TABLE site_comments (
    id           INTEGER PRIMARY KEY,
    target       TEXT NOT NULL,
    author_id    INTEGER REFERENCES users(id),
    author_name  TEXT NOT NULL,
    text         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'site' -- 'site' for the owner, else the friend's site
);
CREATE INDEX site_comments_target ON site_comments(target, created_at);
CREATE INDEX site_comments_created ON site_comments(created_at);

-- --- friends' sites (src/connect.js, src/peers.js, src/feed.js, src/notify.js) --------------------------------------

-- Ids are never reused (AUTOINCREMENT), so nothing kept about a friend who's gone can attach to a new one.
CREATE TABLE connections (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    origin           TEXT NOT NULL UNIQUE,    -- https://their-site
    name             TEXT NOT NULL,           -- their owner's name
    their_key        TEXT,                    -- sent when calling them
    key_hash         TEXT NOT NULL UNIQUE,    -- SHA-256 of the key they send when calling us
    created_at       INTEGER NOT NULL,
    connected_at     INTEGER,                 -- when the handshake finished
    approved_at      INTEGER,                 -- when the owner approved them (nothing's shared before)
    invited_as       TEXT,                    -- the person in the Facebook download the link was made for
    avatar_url       TEXT,                    -- their picture, as their site last signed it
    avatar_exp       INTEGER,
    feed_checked_at  INTEGER                  -- when Home last asked their site for posts
);

-- One-time Connect links; with person_name, made by "Invite" on Friends for someone in the Facebook download.
CREATE TABLE connect_links (
    token_hash   TEXT PRIMARY KEY,
    expires_at   INTEGER NOT NULL,
    used_at      INTEGER,
    person_name  TEXT,
    created_at   INTEGER
);

-- Which person in the Facebook download a friend is (person_name NULL: "not anyone there", so stop suggesting).
CREATE TABLE friend_links (
    connection_id  INTEGER PRIMARY KEY,
    person_name    TEXT,
    created_at     INTEGER NOT NULL
);

-- The owner's own copies of their comments on friends' sites, which stay after a disconnect (site says where).
CREATE TABLE comments_elsewhere (
    id             INTEGER PRIMARY KEY,
    connection_id  INTEGER NOT NULL,
    site           TEXT,
    remote_id      INTEGER NOT NULL,
    target         TEXT NOT NULL,
    text           TEXT NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX comments_elsewhere_connection ON comments_elsewhere(connection_id, remote_id);

-- Notes friends' sites send (src/notify.js): a new post, or a comment on something the owner commented on there too.
-- Untrusted (cut to size, shown as text), kept 60 days, and only shown while their connection is still here.
CREATE TABLE inbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  INTEGER NOT NULL,
    kind           TEXT NOT NULL,             -- 'post' or 'comment'
    target         TEXT NOT NULL,             -- the post or photo on their site: post-… or photo-<sha256>
    actor          TEXT,                      -- for a comment, who wrote it (as their site names them)
    text           TEXT,                      -- the start of the post or comment
    created_at     INTEGER NOT NULL
);
CREATE INDEX inbox_by_time ON inbox(created_at);
CREATE INDEX inbox_by_connection ON inbox(connection_id, kind, target);
