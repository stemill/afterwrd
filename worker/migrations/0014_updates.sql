-- Each version of afterwrd this site has run, noted by the version itself when it first starts (src/migrate.js):
-- when, and the version before it (NULL for the first noted; versions before 0.41.0 didn't note themselves). The
-- Update page lists them. If an update goes wrong, this says when, which is what a database restore (D1 Time Travel)
-- needs: see docs/recovery.md.
CREATE TABLE updates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    version       TEXT NOT NULL,
    from_version  TEXT,
    at            INTEGER NOT NULL
);
