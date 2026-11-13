-- Events on a person's own site, seen only by the friends they invite (docs/events-plan.md). Also: one table for every
-- event the owner knows about from elsewhere, friends' and groups', in place of group_plans; and events in groups that
-- repeat, with answers for each date.

-- --- who sees a post ---------------------------------------------------------------------------------------------------

-- All friends (as every post was until now), or only those listed in post_audience. Facebook's posts are always
-- 'friends': whether friends see them at all is up to the sections the owner shares (share.js).
ALTER TABLE posts ADD COLUMN audience TEXT NOT NULL DEFAULT 'friends' CHECK (audience IN ('friends', 'chosen'));

CREATE TABLE post_audience (
    post_id        INTEGER NOT NULL,          -- a post with audience 'chosen'
    connection_id  INTEGER NOT NULL,          -- a friend it's shared with
    added_at       INTEGER NOT NULL,
    -- For an event: what became of the invitation sent to their site (NULL: still on its way). 'refused': their site
    -- said no to it, as one from before events does.
    delivery       TEXT CHECK (delivery IN ('delivered', 'refused', 'unreachable')),
    PRIMARY KEY (post_id, connection_id)
);
CREATE INDEX post_audience_connection ON post_audience(connection_id);

-- --- the owner's own events (src/events.js) ---------------------------------------------------------------------------

-- An event is a post (its words, comments, who sees it) with this attached. As group_events (0003_events.sql).
CREATE TABLE events (
    post_id       INTEGER PRIMARY KEY,
    title         TEXT NOT NULL,
    starts_at     INTEGER NOT NULL,           -- a moment (all day: the start of its day where it's held)
    ends_at       INTEGER,                    -- all day: the start of its last day
    all_day       INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
    time_zone     TEXT NOT NULL,              -- where it's held, as its times are shown
    place         TEXT,
    cancelled_at  INTEGER,
    changed_at    INTEGER                     -- when its title, time or place last changed (one change per 5 minutes)
);
CREATE INDEX events_time ON events(starts_at);

-- Invited friends' answers. The owner is the host, and has none.
CREATE TABLE event_answers (
    post_id        INTEGER NOT NULL,
    connection_id  INTEGER NOT NULL,
    answer         TEXT NOT NULL CHECK (answer IN ('going', 'maybe', 'no')),
    answered_at    INTEGER NOT NULL,
    PRIMARY KEY (post_id, connection_id)
);

-- --- events from elsewhere (src/events.js, src/membership.js) ---------------------------------------------------------

-- A friend's event the owner is invited to, or a group's event they're going to or might go to: a copy, as the host or
-- group last said, for the calendar, and so notes about it are only taken while it's wanted.
CREATE TABLE events_elsewhere (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  INTEGER,                   -- a friend's event: who, here…
    post_key       TEXT,                      -- …and its post on their site (post-…)
    group_id       INTEGER,                   -- a group's event: which group, here…
    post_id        INTEGER,                   -- …and its post's number there
    date           TEXT NOT NULL DEFAULT '',  -- which date of a repeating one (YYYY-MM-DD where it's held); '' for a one-off
    answer         TEXT CHECK (answer IN ('going', 'maybe', 'no')), -- NULL: invited, not answered yet
    title          TEXT NOT NULL,
    starts_at      INTEGER NOT NULL,
    ends_at        INTEGER,
    all_day        INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
    time_zone      TEXT NOT NULL,
    place          TEXT,
    cancelled_at   INTEGER,
    invited_at     INTEGER,                   -- a friend's: when the invitation came
    updated_at     INTEGER NOT NULL,
    CHECK ((connection_id IS NOT NULL AND post_key IS NOT NULL AND group_id IS NULL AND post_id IS NULL)
        OR (group_id IS NOT NULL AND post_id IS NOT NULL AND connection_id IS NULL AND post_key IS NULL)),
    -- A group's is only kept while the owner's going or might: the group itself lists the rest.
    CHECK (group_id IS NULL OR answer IN ('going', 'maybe'))
);
CREATE UNIQUE INDEX events_elsewhere_friend ON events_elsewhere(connection_id, post_key) WHERE connection_id IS NOT NULL;
CREATE UNIQUE INDEX events_elsewhere_group ON events_elsewhere(group_id, post_id, date) WHERE group_id IS NOT NULL;
CREATE INDEX events_elsewhere_time ON events_elsewhere(starts_at);

INSERT INTO events_elsewhere (group_id, post_id, answer, title, starts_at, ends_at, all_day, time_zone, place, cancelled_at, updated_at)
    SELECT group_id, post_id, answer, title, starts_at, ends_at, all_day, time_zone, place, cancelled_at, updated_at
    FROM group_plans WHERE answer IN ('going', 'maybe');
DROP TABLE group_plans;

-- inbox.kind (0001_schema.sql) also takes 'invite', 'changed' and 'cancelled': a friend's event.

-- A group_inbox note about one date of a repeating event (a date called off): which one.
ALTER TABLE group_inbox ADD COLUMN date TEXT;

-- --- events in groups that repeat (in a group's Worker: src/groups.js) ---------------------------------------------------

-- The rule (calendar.js: a strict subset of iCalendar's RRULE), and when its last date finishes, for "over" in SQL.
ALTER TABLE group_events ADD COLUMN rrule TEXT;
ALTER TABLE group_events ADD COLUMN last_ends_at INTEGER;

-- Dates of a repeating event called off one at a time.
CREATE TABLE group_event_skips (
    post_id       INTEGER NOT NULL,
    date          TEXT NOT NULL,              -- YYYY-MM-DD, where it's held
    cancelled_at  INTEGER NOT NULL,
    PRIMARY KEY (post_id, date)
);

-- Answers are for one date of a repeating event ('' for a one-off): rebuilt with the date in its key.
CREATE TABLE group_answers_new (
    post_id      INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    date         TEXT NOT NULL DEFAULT '',
    answer       TEXT NOT NULL CHECK (answer IN ('going', 'maybe', 'no')),
    answered_at  INTEGER NOT NULL,
    PRIMARY KEY (post_id, origin, date)
);
INSERT INTO group_answers_new (post_id, origin, date, answer, answered_at)
    SELECT post_id, origin, '', answer, answered_at FROM group_answers WHERE answer IN ('going', 'maybe', 'no');
DROP TABLE group_answers;
ALTER TABLE group_answers_new RENAME TO group_answers;
