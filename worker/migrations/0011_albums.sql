-- Albums the owner makes on the site, and photos added straight to one rather than in a post (src/photos.js).
-- A post can now carry its own heading (e.g. "Added 3 photos to Holiday."), kept so comments stay with it even
-- if the album is renamed. Profile and cover pictures are chosen in settings (profile_hash, cover_hash).
CREATE TABLE site_albums (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   INTEGER NOT NULL
);
ALTER TABLE site_posts ADD COLUMN title TEXT;

-- site_photos gains an album and a time of its own, and no longer has to be in a post (SQLite can only drop
-- that by copying the table).
CREATE TABLE site_photos_next (
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
INSERT INTO site_photos_next (id, post_id, hash, thumb_hash, width, height, size, created_at)
    SELECT f.id, f.post_id, f.hash, f.thumb_hash, f.width, f.height, f.size, p.created_at
    FROM site_photos f JOIN site_posts p ON p.id = f.post_id;
DROP TABLE site_photos;
ALTER TABLE site_photos_next RENAME TO site_photos;
CREATE INDEX site_photos_post ON site_photos(post_id);
CREATE INDEX site_photos_album ON site_photos(album_id);
