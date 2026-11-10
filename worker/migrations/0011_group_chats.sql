-- Group chats (src/messages.js on members' sites, src/groups.js on a group's own site). A group's chat is a chat here
-- like a friend's, kept by the group's address (<group's site>/groups/<n>), with each message's writer. Its messages
-- go after 30 days: for keeping, there are posts. A group chat doesn't notify unless the owner turns that on for it.
ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'friend';  -- friend or group
ALTER TABLE chats ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;    -- 0: never notify (a group chat, to begin with)
ALTER TABLE messages ADD COLUMN author_origin TEXT;                -- in a group chat, whose site wrote it
ALTER TABLE messages ADD COLUMN author_name TEXT;                  -- and their name, as the group gave it
-- A group chat's message deleted (for everyone, or here) is blanked and kept until it goes after 30 days, so the
-- chat's limits still count it: deleting and sending again can't get round them.
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN bytes INTEGER;                      -- its size when it came, for the limits

-- On a group's own site: its chat's messages, for 30 days, so it can keep each one once, limit how fast each member
-- writes, and let them (or an admin) delete one for everyone. Members' sites hold the copies people read.
CREATE TABLE group_chat (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL,
    origin       TEXT NOT NULL,                -- the member's site that wrote it
    uid          TEXT NOT NULL,                -- the end of its address there: <origin>/messages/<uid>
    author_name  TEXT NOT NULL,
    text         TEXT NOT NULL,                -- '' once deleted (kept 30 days, so the limits still count it)
    bytes        INTEGER NOT NULL,             -- its size when it came
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    deleted_by   TEXT,                         -- the member's site that deleted it (deleting has its own limit)
    UNIQUE (group_id, origin, uid)
);
CREATE INDEX group_chat_from ON group_chat (origin, created_at);
CREATE INDEX group_chat_age ON group_chat (created_at);
CREATE INDEX group_chat_deleting ON group_chat (deleted_by, deleted_at);
