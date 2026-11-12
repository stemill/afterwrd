-- Friends' automatic checks (src/friendchecks.js, docs/security-and-install-plan.md section 7).

-- On the checking site: what it found each time it checked a friend's site (the newest few for each).
CREATE TABLE friend_checks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  INTEGER NOT NULL,          -- the friend whose site was checked
    checked_at     INTEGER NOT NULL,
    verdict        TEXT NOT NULL,             -- 'all good', 'needs a look' or 'couldn''t check'
    result         TEXT,                      -- what was found (JSON, as checks.js checkSite, plus the uploads looked at)
    seen_at        INTEGER                    -- when the owner put it away on Home
);
CREATE INDEX friend_checks_connection ON friend_checks(connection_id, id);

-- On the site checked: when friends' sites were handed a token (for the limits), newest two days.
CREATE TABLE check_tokens (
    connection_id  INTEGER NOT NULL,
    at             INTEGER NOT NULL
);
CREATE INDEX check_tokens_at ON check_tokens(connection_id, at);

-- On the checking site: friends' sites that were just updated and asked to be checked soon.
CREATE TABLE check_soon (
    connection_id  INTEGER PRIMARY KEY,
    at             INTEGER NOT NULL
);

-- A friend's check of this site that found something: what it found (JSON list of words). NULL: it passed.
ALTER TABLE checked ADD COLUMN problems TEXT;
