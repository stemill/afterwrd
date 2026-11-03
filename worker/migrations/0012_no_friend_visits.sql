-- Connected friends no longer come in through their own site: they read each other's posts and photos from their
-- own sites instead (friends.js). Anyone still signed in that way is signed out, and kept (revoked) so their
-- comments still say who wrote them. The one-time passes go.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE site IS NOT NULL);
UPDATE users SET revoked_at = strftime('%s', 'now') WHERE site IS NOT NULL AND revoked_at IS NULL;
DROP TABLE IF EXISTS friend_tickets;
