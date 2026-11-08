-- Asking to be friends without a link (0.32.0): someone in a group with the owner, or introduced to them by a friend,
-- can ask from their own site (connect.js). Nothing is shared until the owner approves, as with a link.

-- Why a request without a link came: 'group' (via_name: the group) or 'introduction' (via_name: who introduced them).
ALTER TABLE connections ADD COLUMN via_kind TEXT;
ALTER TABLE connections ADD COLUMN via_name TEXT;

-- Introductions the owner's friends have made: connection_id (the friend who made it) thinks the owner should meet
-- the person at origin. Kept until the owner asks, is asked, or dismisses it, or that friend is removed.
CREATE TABLE introductions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  INTEGER NOT NULL,
    origin         TEXT NOT NULL,
    name           TEXT NOT NULL,             -- their name, as the introducing friend's site has it
    note           TEXT,                      -- a line from the friend, if they wrote one
    created_at     INTEGER NOT NULL,
    UNIQUE (connection_id, origin)
);

-- Sites whose request without a link the owner declined: they can't ask again that way (the owner still can).
CREATE TABLE declined_asks (
    origin       TEXT PRIMARY KEY,
    declined_at  INTEGER NOT NULL
);

-- Requests without a link that had a reason, to cap how often (each makes this site call the asker), overall and
-- from any one site.
CREATE TABLE ask_log (
    at      INTEGER NOT NULL,
    origin  TEXT NOT NULL
);
CREATE INDEX ask_log_at ON ask_log(at);

-- Who was in each of the owner's groups when this site last asked it, so a request naming a group doesn't make this
-- site call the group every time: a member found here counts for 10 minutes; asked again after a minute at most.
CREATE TABLE group_member_cache (
    group_id    INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,                -- the group's name, as it said
    origins     TEXT NOT NULL,                -- JSON list of members' sites (let in)
    checked_at  INTEGER NOT NULL
);
