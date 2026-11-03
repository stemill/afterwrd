-- Sign-in challenges now travel in a signed cookie (src/auth.js), so strangers asking to sign in don't write to
-- the database. Each challenge is recorded here only once a passkey has verified against it, so it can't be
-- replayed while it's still valid.
DROP TABLE IF EXISTS challenges;
CREATE TABLE used_challenges (
    challenge   TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
);
