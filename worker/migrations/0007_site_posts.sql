-- Posts the owner writes on the site, with their photos in order. An import never touches these; they're copied
-- into the archive's posts, media and albums tables after every change and every import (src/posts.js), so the
-- pages show them like any other post. Photos are stored in the media store like imported ones.
CREATE TABLE site_posts (
    id          INTEGER PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    text        TEXT
);

CREATE TABLE site_photos (
    id          INTEGER PRIMARY KEY,
    post_id     INTEGER NOT NULL REFERENCES site_posts(id),
    hash        TEXT NOT NULL,
    thumb_hash  TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
CREATE INDEX site_photos_post ON site_photos(post_id);
