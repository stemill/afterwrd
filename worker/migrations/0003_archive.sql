-- The published copy of the archive, which the Worker reads to build pages. Same shape as the tables in
-- heybert/ingest.py, minus foreign keys: the copy is replaced wholesale on each publish and its tables refer to
-- each other in a circle (people -> media -> posts -> people), which D1's enforced foreign keys would refuse.
CREATE TABLE people (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    is_me            INTEGER NOT NULL DEFAULT 0,
    friend_since     INTEGER,
    unfriended_at    INTEGER,
    profile_media_id INTEGER,
    cover_media_id   INTEGER
);

CREATE TABLE albums (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT,
    last_modified  INTEGER,
    cover_media_id INTEGER
);

CREATE TABLE posts (
    id            INTEGER PRIMARY KEY,
    timestamp     INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    title         TEXT,
    text          TEXT,
    target_id     INTEGER,
    group_name    TEXT,
    link_url      TEXT,
    place_name    TEXT,
    place_address TEXT,
    latitude      REAL,
    longitude     REAL,
    fbid          TEXT
);

CREATE TABLE post_tags (
    post_id   INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    PRIMARY KEY (post_id, person_id)
);

CREATE TABLE comments (
    id              INTEGER PRIMARY KEY,
    timestamp       INTEGER NOT NULL,
    author_id       INTEGER,
    action          TEXT NOT NULL,
    target_owner_id INTEGER,
    target_kind     TEXT,
    group_name      TEXT,
    text            TEXT,
    link_url        TEXT,
    title           TEXT
);

CREATE TABLE reactions (
    id              INTEGER PRIMARY KEY,
    timestamp       INTEGER NOT NULL,
    reaction        TEXT NOT NULL,
    target_owner_id INTEGER,
    target_kind     TEXT,
    group_name      TEXT,
    url             TEXT,
    fbid            TEXT,
    title           TEXT
);

CREATE TABLE media (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    timestamp   INTEGER,
    taken_at    INTEGER,
    width       INTEGER,
    height      INTEGER,
    description TEXT,
    latitude    REAL,
    longitude   REAL,
    album_id    INTEGER,
    post_id     INTEGER,
    comment_id  INTEGER
);

CREATE TABLE tagged_photos (
    id        INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    owner_id  INTEGER,
    url       TEXT,
    fbid      TEXT
);

CREATE INDEX comments_owner ON comments(target_owner_id);
CREATE INDEX comments_ts ON comments(timestamp);
CREATE INDEX reactions_owner ON reactions(target_owner_id);
CREATE INDEX reactions_ts ON reactions(timestamp);
CREATE INDEX posts_ts ON posts(timestamp);
CREATE INDEX posts_target ON posts(target_id);
CREATE INDEX media_album ON media(album_id);
CREATE INDEX media_post ON media(post_id);
CREATE INDEX media_comment ON media(comment_id);
CREATE INDEX tagged_owner ON tagged_photos(owner_id);
CREATE INDEX people_me ON people(is_me);

-- What the owner chose to publish, e.g. sections = ["posts","photos"].
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
