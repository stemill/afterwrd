-- Groups (0.18.0). Each group is its own small afterwrd Worker, made by whoever starts it in their own Cloudflare
-- account, and running in group mode (src/groups.js): no archive, no profile, and no one signs in. Everyone, its owner
-- included, reads and runs it from their own afterwrd site (src/membership.js) with a key the group gave their site
-- when they joined. Being in a group isn't being friends: those keys open the group, and nothing on anyone's site.
-- Members' sites read the group when they open it (nothing is sent to every member when someone posts); the group
-- sends a note only about a comment on a post a member wrote or commented on. Both kinds of site have every table.

-- On a person's site: the groups its owner is in (origin: the group's site). In a group's Worker: the group itself,
-- one row, with origin NULL. Ids are never reused.
CREATE TABLE groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    about        TEXT,
    created_at   INTEGER NOT NULL,
    origin       TEXT,                        -- the group's site
    remote_id    INTEGER,                     -- its number there
    host_name    TEXT,                        -- its owner, as it says
    their_key    TEXT,                        -- sent when calling it (before it's claimed: the GROUP_KEY it was made with)
    key_hash     TEXT UNIQUE,                 -- SHA-256 of the key it sends when calling us
    joined_at    INTEGER,                     -- when the handshake finished (the group still has to let us in)
    role         TEXT,                        -- ours there, as it last said: owner, admin or member
    script       TEXT,                        -- if this site made the group's Worker: its name, Cloudflare account and
    account      TEXT,                        --   database, so this site can update it or delete it (and only that
    database     TEXT                         --   Worker and that database)
);
CREATE UNIQUE INDEX groups_remote ON groups(origin, remote_id);

-- --- in a group's Worker (src/groups.js) ---------------------------------------------------------------------------

-- Members' sites. Nothing is shown to one until an admin lets it in (approved_at). Roles: owner (who made the group),
-- admin (the owner's choice), member.
CREATE TABLE group_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    name         TEXT NOT NULL,               -- their owner's name, as their site says
    their_key    TEXT NOT NULL,               -- sent when calling them (notes)
    key_hash     TEXT NOT NULL UNIQUE,        -- SHA-256 of the key they send when calling us
    role         TEXT NOT NULL DEFAULT 'member',
    created_at   INTEGER NOT NULL,
    approved_at  INTEGER,
    UNIQUE (group_id, origin)
);

-- Invite links: one at a time, usable by anyone it's sent to until it expires (each use is only a request), up to a
-- number of requests, so a passed-on link can't keep the group busy.
CREATE TABLE group_links (
    token_hash   TEXT PRIMARY KEY,
    group_id     INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    requests     INTEGER NOT NULL DEFAULT 0
);

-- Posts and comments, by members' sites (origin). They stay if the member leaves.
CREATE TABLE group_posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    text         TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX group_posts_group ON group_posts(group_id, created_at);
CREATE INDEX group_posts_origin ON group_posts(origin, created_at);

-- Photos in posts, copied here from the member's site when they post.
CREATE TABLE group_photos (
    id           INTEGER PRIMARY KEY,
    post_id      INTEGER NOT NULL,
    hash         TEXT NOT NULL,
    thumb_hash   TEXT NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    size         INTEGER NOT NULL
);
CREATE INDEX group_photos_post ON group_photos(post_id);

CREATE TABLE group_comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id      INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    text         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX group_comments_post ON group_comments(post_id, created_at);
CREATE INDEX group_comments_origin ON group_comments(origin, created_at);

-- --- on a person's site (src/membership.js) -------------------------------------------------------------------------

-- The owner's own copies of what they've posted and said in groups (kind 'post' or 'comment'), so a group can't put
-- words in their mouth; they stay after leaving (site says where).
CREATE TABLE group_mine (
    id           INTEGER PRIMARY KEY,
    group_id     INTEGER NOT NULL,
    site         TEXT NOT NULL,
    remote_group INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    post_id      INTEGER NOT NULL,            -- the post there (for a comment, the post it's on)
    remote_id    INTEGER NOT NULL,            -- the post's or comment's number there
    text         TEXT,
    photos       TEXT,                        -- a post's photos, as a JSON list of their hashes
    created_at   INTEGER NOT NULL
);
CREATE INDEX group_mine_site ON group_mine(site, remote_group, kind, post_id);

-- Notes from a group: a comment on a post the owner wrote or commented on there. Untrusted (cut to size, shown as
-- text), kept 60 days, and only shown while the owner's still in the group.
CREATE TABLE group_inbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL,
    post_id      INTEGER NOT NULL,
    actor        TEXT,
    text         TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX group_inbox_time ON group_inbox(created_at);
CREATE INDEX group_inbox_group ON group_inbox(group_id, post_id);
