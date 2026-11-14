-- Friends' newest posts as their sites last sent them (feed.js), so Home shows them without waiting on their sites.
-- Kept after cleaning (friends.js cleanFeed), as the JSON Home draws from; never anything of their keys. Fetched again
-- in the background (the Outbox) when a copy gets old or a friend's note says they've posted.
CREATE TABLE friend_posts (
    connection_id INTEGER NOT NULL,
    post_key      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    data          TEXT NOT NULL,                -- the post, cleaned, with its comments as their site sent them
    PRIMARY KEY (connection_id, post_key)
);
CREATE INDEX friend_posts_newest ON friend_posts(created_at);
-- When each friend's copy was fetched, and until when it can be shown: the first of its photo links to expire (their
-- sites sign them for an hour or two: share.js), or a day after fetching if it has none.
ALTER TABLE connections ADD COLUMN copied_at INTEGER;
ALTER TABLE connections ADD COLUMN copy_until INTEGER;
-- Fetches in the background (a note, or a copy getting old) are rationed per friend, so a friend's site can't use up
-- this site's database writes: which day (days since 1970) they were counted for, and how many that day.
ALTER TABLE connections ADD COLUMN refresh_day INTEGER;
ALTER TABLE connections ADD COLUMN refreshes INTEGER NOT NULL DEFAULT 0;
