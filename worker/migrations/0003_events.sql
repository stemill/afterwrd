-- Events in groups (0.19.0). An event is a group post with an event attached: the post holds who added it, the words
-- about it, its photos and comments, as for any post (0002_groups.sql). Members say whether they're going; those
-- going, or who might, get a note when it changes or is called off, and nothing else (notify.js).

-- --- in a group's Worker (src/groups.js) ---------------------------------------------------------------------------

CREATE TABLE group_events (
    post_id      INTEGER PRIMARY KEY,         -- the post it's part of
    title        TEXT NOT NULL,
    starts_at    INTEGER NOT NULL,            -- a moment (all day: the start of its day where it's held)
    ends_at      INTEGER,                     -- all day: the start of its last day
    all_day      INTEGER NOT NULL DEFAULT 0,
    time_zone    TEXT NOT NULL,               -- where it's held, as its times are shown
    place        TEXT,
    cancelled_at INTEGER,
    changed_at   INTEGER
);
CREATE INDEX group_events_time ON group_events(starts_at);

-- Who's going: going, maybe or no, by member's site. Names come from group_members, so only members are listed.
CREATE TABLE group_answers (
    post_id      INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    answer       TEXT NOT NULL,
    answered_at  INTEGER NOT NULL,
    PRIMARY KEY (post_id, origin)
);

-- --- on a person's site (src/membership.js) -------------------------------------------------------------------------

-- Events the owner here is going to, or might: a copy, as the group last said, for Coming up on Groups and so notes
-- about them are only taken while the owner wants them. Gone when they say they can't go, or leave the group.
CREATE TABLE group_plans (
    group_id     INTEGER NOT NULL,            -- the group, here
    post_id      INTEGER NOT NULL,            -- the event's post, there
    answer       TEXT NOT NULL,               -- going or maybe
    title        TEXT NOT NULL,
    starts_at    INTEGER NOT NULL,
    ends_at      INTEGER,
    all_day      INTEGER NOT NULL DEFAULT 0,
    time_zone    TEXT NOT NULL,
    place        TEXT,
    cancelled_at INTEGER,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (group_id, post_id)
);

-- What a note from a group is about: NULL, a comment; 'changed' or 'cancelled', an event the owner's going to.
ALTER TABLE group_inbox ADD COLUMN kind TEXT;

-- The owner's own copy of an event they added (as JSON), shown in place of what the group says, as their words are.
ALTER TABLE group_mine ADD COLUMN event TEXT;
