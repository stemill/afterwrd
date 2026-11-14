-- Mentions (docs/mentions-plan.md): @Name in a post or comment tells that person, and @here in a group tells everyone
-- in it. Each post and comment keeps who it mentions, as JSON [{ "name": "Ann Example", "origin": "https://…" }]
-- (origin "here" for @here in a group); only names in that list are shown as mentions.
ALTER TABLE posts ADD COLUMN mentions TEXT;
ALTER TABLE comments ADD COLUMN mentions TEXT;
ALTER TABLE group_posts ADD COLUMN mentions TEXT;
ALTER TABLE group_comments ADD COLUMN mentions TEXT;
-- Each phone or computer with notifications on says whether mentions buzz it too (1) or only events (0).
ALTER TABLE push_devices ADD COLUMN mentions INTEGER NOT NULL DEFAULT 1;
-- In a group's Worker: whether any member may use @here (1), or only its owner and admins (0, the default).
ALTER TABLE groups ADD COLUMN here_anyone INTEGER NOT NULL DEFAULT 0;
-- In a group's Worker: each @here used, for its limits (a few a day each, and for the group).
CREATE TABLE here_log (
    member_id  INTEGER NOT NULL,
    at         INTEGER NOT NULL
);
CREATE INDEX here_log_at ON here_log(at);
