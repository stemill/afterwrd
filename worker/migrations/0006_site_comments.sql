-- Comments written here by the people who can see the site, on a post or a photo. Re-importing the archive
-- renumbers everything, so `target` names what's commented on by something that survives that: a post by its time
-- and a fingerprint of its content ("post-<timestamp>-<fingerprint>"), a photo by its file's hash
-- ("photo-<sha256>"). `origin` is 'site' for now; comments shared back from a friend's Facebook export can join
-- them later. The author's name is copied in so a comment still reads right after their access is revoked.
CREATE TABLE site_comments (
    id          INTEGER PRIMARY KEY,
    target      TEXT NOT NULL,
    author_id   INTEGER REFERENCES users(id),
    author_name TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    origin      TEXT NOT NULL DEFAULT 'site'
);
CREATE INDEX site_comments_target ON site_comments(target, created_at);
CREATE INDEX site_comments_created ON site_comments(created_at);

-- When each person last opened Activity, so the menu can show how many comments are new to them.
ALTER TABLE users ADD COLUMN activity_seen_at INTEGER;
