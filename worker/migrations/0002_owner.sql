-- The owner manages access from /_admin. On a site that's already running, the first person invited
-- (normally you) becomes the owner; on a new site, `npm run invite -- add "Your Name" --owner` sets it.
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE revoked_at IS NULL);
