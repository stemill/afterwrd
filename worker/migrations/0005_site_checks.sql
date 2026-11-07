-- Checks of friends' sites (src/checks.js). The owner makes a one-time link and sends it; the friend opens it, allows
-- read-only access in Cloudflare, and this site compares the code their site runs with the release and reads their
-- account's audit log. Only what was found is kept: no token, emails or IP addresses.
CREATE TABLE site_checks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash     TEXT NOT NULL UNIQUE,
    connection_id  INTEGER,
    site           TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    checked_at     INTEGER,
    result         TEXT
);
