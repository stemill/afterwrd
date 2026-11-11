-- Polls (src/polls.js). A poll is a post that asks a question (its words) with 2 to 10 options. Everyone who can see
-- the post sees how many chose each option, and their own choice. Only whoever asked sees who chose what. A poll
-- closes when its writer closes it, or at the time they picked.
-- An answer is kept as a set of options (bit n for option n), one row per person, so changing it changes that row.

-- --- on a person's site (their own posts, src/posts.js and peers.js) --------------------------------------------------

CREATE TABLE site_polls (
    post_id      INTEGER PRIMARY KEY,         -- the site post (site_posts.id) asking it
    options      TEXT NOT NULL,               -- JSON: the options, in order
    multiple     INTEGER NOT NULL DEFAULT 0,  -- 1: more than one may be chosen
    closes_at    INTEGER,                     -- when it closes by itself, if it does
    closed_at    INTEGER                      -- when its writer closed it
);

CREATE TABLE site_poll_votes (
    post_id      INTEGER NOT NULL,
    voter        TEXT NOT NULL,               -- 'site' (the owner here), or a friend's site
    name         TEXT NOT NULL,               -- as they were called when they answered
    choices      INTEGER NOT NULL,            -- the options chosen, as bits
    voted_at     INTEGER NOT NULL,
    PRIMARY KEY (post_id, voter)
);

-- The owner's own copy of a poll they asked in a group (as JSON: options, multiple, closes_at), shown in place of what
-- the group says, as their words are.
ALTER TABLE group_mine ADD COLUMN poll TEXT;

-- --- in a group's Worker (src/groups.js) ------------------------------------------------------------------------------

CREATE TABLE group_polls (
    post_id      INTEGER PRIMARY KEY,         -- the group post asking it
    options      TEXT NOT NULL,
    multiple     INTEGER NOT NULL DEFAULT 0,
    closes_at    INTEGER,
    closed_at    INTEGER
);

-- Names come from group_members, so only members are counted, and leaving takes a member's answers with them.
CREATE TABLE group_poll_votes (
    post_id      INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    choices      INTEGER NOT NULL,
    voted_at     INTEGER NOT NULL,
    PRIMARY KEY (post_id, origin)
);
