-- Connected friends can open the whole site, signing in through their own (connect.js, peers.js, auth.js). Each
-- is a person here like any other, marked with their site; disconnecting revokes them.
ALTER TABLE users ADD COLUMN site TEXT;

-- One-time passes a connected site asks for so its owner can come in (POST /_peer/ticket). Used within two
-- minutes, once; only a hash is kept.
CREATE TABLE friend_tickets (
    token_hash     TEXT PRIMARY KEY,
    connection_id  INTEGER NOT NULL,
    next           TEXT,
    expires_at     INTEGER NOT NULL
);
