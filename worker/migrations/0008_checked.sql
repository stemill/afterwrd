-- Checks of this site (0.34.0): a friend's site saying it checked this one and found it exactly the published
-- afterwrd (POST /_peer/checked, checks.js), or the owner saying they checked it themselves. A check is a snapshot,
-- so only the newest is shown (on Update), and once there is one, Home stops suggesting a check. The newest few kept.
CREATE TABLE checked (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  INTEGER,                   -- the friend whose site checked it; NULL: the owner checked it themselves
    name           TEXT,                      -- that friend's name at the time
    version        TEXT,                      -- the afterwrd release it matched (a friend's check only)
    checked_at     INTEGER NOT NULL
);
