-- Editing posts and comments (src/edits.js, docs/editing-plan.md): for 15 minutes, and only until someone else has
-- commented (or, on a poll, answered). What's replaced is kept, oldest first, and shown under "Edited".

-- The owner's posts: when they were last changed, and what they said before.
ALTER TABLE posts ADD COLUMN edited_at INTEGER;
CREATE TABLE post_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id      INTEGER NOT NULL,            -- posts.id
    text         TEXT,                        -- what it said until replaced_at
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX post_versions_post ON post_versions(post_id, id);

-- Comments here, rebuilt so their numbers are never used twice (AUTOINCREMENT): a comment's address is
-- <post or photo>#c<n>, and friends' sites keep theirs by n, so a deleted comment's n mustn't go to someone else's.
CREATE TABLE comments_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target       TEXT NOT NULL,               -- the post's key, or photo-<sha256>
    author_id    INTEGER REFERENCES users(id),
    author_name  TEXT NOT NULL,
    text         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'site', -- 'site' for the owner, else the friend's site
    edited_at    INTEGER
);
INSERT INTO comments_new (id, target, author_id, author_name, text, created_at, origin)
    SELECT id, target, author_id, author_name, text, created_at, origin FROM comments;
-- Numbers carry on 1000 past the highest left, so the newest comments deleted before now aren't given out again.
INSERT INTO comments_new (id, target, author_name, text, created_at) SELECT COALESCE(MAX(id), 0) + 1000, '', '', '', 0 FROM comments_new;
DELETE FROM comments_new WHERE target = '' AND author_name = '' AND created_at = 0;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX comments_target ON comments(target, created_at);
CREATE INDEX comments_created ON comments(created_at);
CREATE TABLE comment_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id   INTEGER NOT NULL,            -- comments.id
    text         TEXT NOT NULL,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX comment_versions_comment ON comment_versions(comment_id, id);

-- The owner's own copies of their comments on friends' sites, edited there too.
ALTER TABLE comments_elsewhere ADD COLUMN edited_at INTEGER;
CREATE TABLE comments_elsewhere_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id   INTEGER NOT NULL,            -- comments_elsewhere.id
    text         TEXT NOT NULL,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX comments_elsewhere_versions_comment ON comments_elsewhere_versions(comment_id, id);

-- --- groups: on a group's own Worker (groups.js) ------------------------------------------------------------------------
-- Posts and comments in the group, changed by whoever wrote them, under the same rules (edits.js). An event's own
-- edit (its words and time, at any time) stays as it was.
ALTER TABLE group_posts ADD COLUMN edited_at INTEGER;
CREATE TABLE group_post_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id      INTEGER NOT NULL,            -- group_posts.id
    text         TEXT,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX group_post_versions_post ON group_post_versions(post_id, id);
ALTER TABLE group_comments ADD COLUMN edited_at INTEGER;
CREATE TABLE group_comment_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id   INTEGER NOT NULL,            -- group_comments.id
    text         TEXT NOT NULL,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX group_comment_versions_comment ON group_comment_versions(comment_id, id);

-- --- groups: on a member's site (membership.js) --------------------------------------------------------------------------
-- The owner's own copies of what they've posted and said in groups, edited there too: their own record, shown instead
-- of what the group says.
ALTER TABLE group_mine ADD COLUMN edited_at INTEGER;
CREATE TABLE group_mine_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mine_id      INTEGER NOT NULL,            -- group_mine.id
    text         TEXT,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX group_mine_versions_mine ON group_mine_versions(mine_id, id);
