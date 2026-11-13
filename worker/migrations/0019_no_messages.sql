-- Messages between friends, and groups' chats, are gone (0.47.0): WhatsApp, Signal and the like do that better. Their
-- tables go with them, on people's sites (chats, messages) and on groups' (group_chat). push_devices stays: the owner's
-- phones and computers are now told about events instead (src/push.js).
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS chats;
DROP TABLE IF EXISTS group_chat;
