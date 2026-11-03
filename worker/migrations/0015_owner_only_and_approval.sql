-- Only the owner signs in now: friends see each other from their own sites, and there are no visitors without one.
-- Everyone else is signed out and kept, revoked, so their comments still say who wrote them. (Only where there is
-- an owner: a site somehow without one is left as it was rather than locked.)
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_owner = 0) AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1);
DELETE FROM credentials WHERE user_id IN (SELECT id FROM users WHERE is_owner = 0) AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1);
DELETE FROM invites WHERE user_id IN (SELECT id FROM users WHERE is_owner = 0) AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1);
UPDATE users SET revoked_at = strftime('%s', 'now') WHERE is_owner = 0 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1);

-- Each session remembers which passkey started it, so removing a passkey signs that device out.
ALTER TABLE sessions ADD COLUMN credential_id TEXT;

-- Connecting needs the owner's approval: a Connect link only asks. Connections made before this are approved.
-- invited_as is the person from the Facebook download the link was made for, linked to them on approval.
ALTER TABLE connections ADD COLUMN approved_at INTEGER;
UPDATE connections SET approved_at = connected_at WHERE connected_at IS NOT NULL;
ALTER TABLE connections ADD COLUMN invited_as TEXT;

-- Connect links made from the Facebook friends list say who they were for, and when.
ALTER TABLE connect_links ADD COLUMN person_name TEXT;
ALTER TABLE connect_links ADD COLUMN created_at INTEGER;
