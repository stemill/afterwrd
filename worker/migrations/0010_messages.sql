-- Messages between the owner and their friends (src/messages.js). A chat is kept by the friend's site address, not
-- their connection, so it stays (read-only) if they're removed as a friend, and carries on if they're added again.
-- Friends' sites send messages to POST /_peer/message. Nothing here is ever sent anywhere else, apart from a new
-- message's notification to the owner's own devices (push_devices, src/push.js).
CREATE TABLE chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    origin      TEXT NOT NULL UNIQUE,         -- the friend's site
    name        TEXT NOT NULL,                -- their name, as their connection last gave it
    muted       INTEGER NOT NULL DEFAULT 0,   -- 1: never notify about this chat
    read_up_to  INTEGER NOT NULL DEFAULT 0,   -- the newest message the owner has seen here (messages.id)
    last_at     INTEGER,                      -- when the newest message was saved, for putting chats in order
    viewing_at  INTEGER,                      -- when the chat was last open on screen: no notifications while it is
    notified_at INTEGER,                      -- when a notification for it last made a sound: at most once a minute
    created_at  INTEGER NOT NULL
);

CREATE TABLE messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    mine          INTEGER NOT NULL,           -- 1: the owner sent it, 0: the friend did
    uid           TEXT NOT NULL,              -- the end of its address, <sender's site>/messages/<uid>
    text          TEXT NOT NULL,
    sent_at       INTEGER NOT NULL,           -- the sender's time (a friend's is never later than when it arrived)
    received_at   INTEGER NOT NULL,           -- when it was saved here
    delivered_at  INTEGER,                    -- the owner's: when the friend's site said it had it
    failed_at     INTEGER,                    -- the owner's: when sending gave up
    problem       TEXT,                       -- the owner's: why (unreachable, no-messages, not-friends, refused)
    UNIQUE (chat_id, mine, uid)
);
CREATE INDEX messages_by_chat ON messages (chat_id, id);
CREATE INDEX messages_from ON messages (chat_id, mine, received_at);  -- a friend's limits (messages.js receiveMessage)
CREATE INDEX messages_arrived ON messages (mine, received_at);        -- everyone's limit

-- The owner's phones and computers that said yes to notifications about messages (src/push.js, src/webpush.js): each
-- one's address at its push service (Apple's, Google's, Mozilla's, Microsoft's) and the keys to encrypt for it.
CREATE TABLE push_devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    name        TEXT NOT NULL,               -- "Android (home screen)", as the device said when it said yes
    preview     INTEGER NOT NULL DEFAULT 1,  -- 1: show the message on the lock screen, 0: only who it's from
    credential_id TEXT,                      -- the passkey signed in when it said yes: removing that passkey removes it
    session_hash  TEXT,                      -- and the session: signing out there removes it
    created_at  INTEGER NOT NULL,
    seen_at     INTEGER,                     -- when the owner said, on Home, that adding it was them
    last_ok_at  INTEGER                      -- when a notification last reached its push service
);
