-- People who can see the archive. Revoking someone keeps the row (so the list shows who had access) but
-- removes their passkeys, sessions and unused invites.
CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);

-- One-time links; only a hash of the token is stored.
CREATE TABLE invites (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);

-- Passkeys: the public half only; the private key never leaves the person's device.
CREATE TABLE credentials (
    id            TEXT PRIMARY KEY,           -- base64url credential ID
    user_id       INTEGER NOT NULL REFERENCES users(id),
    public_key    TEXT NOT NULL,              -- base64url COSE key
    counter       INTEGER NOT NULL,
    transports    TEXT NOT NULL,              -- JSON array
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- WebAuthn challenges, each used once within five minutes.
CREATE TABLE challenges (
    id          TEXT PRIMARY KEY,
    challenge   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
