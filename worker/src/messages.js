// Messages between the owner and their friends: a separate, "instant" channel, used like a messaging app, while posts
// stay quiet. The one thing that may notify the owner's phone (push.js), and only for chats they haven't muted.
//
// Sending: the message is saved here, then sent straight to the friend's site (POST /_peer/message, with the key it
// gave this site). If their site can't be reached, the outbox (outbox.js) tries again after 10 seconds, then 1 and 5
// minutes, half an hour, 2 and 6 hours, and then it's marked not delivered. A site that says no (it doesn't do
// messages, or they've removed the owner as a friend) isn't asked again. "Delivered" means their site has it; nothing
// says whether they've read it.
//
// Receiving: from approved friends only (peers.js checks the key), as plain text, cut to size, rate-limited, and kept
// once however many times it's sent. Every message is an ActivityStreams Create of a Note addressed to one person:
//   { type: "Create", actor, to: [<friend>], object: { type: "Note", id: "<sender's site>/messages/<uid>",
//     attributedTo, to, mediaType: "text/plain", content, published } }
//
// A chat belongs to the friend's site address, so if they're removed as a friend it stays (read-only, with its own
// Delete) and carries on if they're added again. Deleting a message or a chat only deletes it here.
//
// Group chats: a chat with a group (kept by its address, <group's site>/groups/<n>). A message goes to the group's site
// (POST /_group/chat, groups.js), which passes it on to the other members' sites (POST /_member/message, here:
// receiveGroupMessage), each keeping its own copy with who wrote it. Their messages go after 30 days: for keeping,
// there are posts. A group chat doesn't notify unless the owner turns that on for it. In a group chat, the writer of a
// message, or the group's admins, can delete it for everyone (the group tells the members' sites).
import { actorId, CONTEXT, groupId, iso } from "../public/static/activity.js";
import { messageProblem, outbox } from "./outbox.js";
import { callSite, host, siteOrigin } from "./peers.js";
import { notifyMessage, pushKey } from "./push.js";
import { html, now, randomToken, Refusal } from "./util.js";
import { messagePage } from "./views/pages.js";

export const MAX_MESSAGE = 4000;
const UID_RE = /^[\w-]{16,64}$/;
const DIRECT_TIMEOUT_MS = 5000;
const FIRST_RETRY_SECONDS = 10;
const VIEWING_EVERY = 10; // seconds: how often an open chat notes that it's still open (push.js OPEN_SECONDS)
const SHOWN = 200; // messages on a chat's page, newest last; older ones a page at a time
// From one friend: a busy conversation is fine, a flood isn't. And a ceiling for everyone together.
const RATE = { count: 120, seconds: 600, daily: 1000, bytes: 1_000_000, everyone: 3000, everyoneBytes: 5_000_000 };
// From a group: all its members together (a little over what a group's site lets through, groups.js CHAT_GROUP_RATE).
// And every group together, apart from friends, so groups can't crowd out friends' messages.
const GROUP_RATE = { count: 300, seconds: 600, daily: 3000, bytes: 2_000_000, everyone: 6000, everyoneBytes: 6_000_000 };
const LIVE = "deleted_at IS NULL"; // a group chat's deleted messages are blanked and kept a while, but never shown
export const GROUP_KEEP_SECONDS = 30 * 86400; // a group chat's messages go after this: for keeping, there are posts
const GROUP_RE = /^(https?:\/\/[^/]+)\/groups\/(\d{1,15})$/;
const BACKDATE_SECONDS = 7 * 86400; // a friend's clock may say a message was written up to a week before it arrived

const FRIEND_SQL = "SELECT * FROM connections WHERE origin = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY id DESC LIMIT 1";

/**
 * Plain text as a message: newlines kept, other control characters dropped (and the invisible ones that reverse
 * text, which could make it read differently from what it is), trimmed; "" if empty or too long.
 */
export function cleanMessage(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return text.length <= MAX_MESSAGE ? text : "";
}

/**
 * The chat with the friend at `origin` (or, `kind` group, the group at that address), made if it's new; a group's
 * doesn't notify to begin with. A name that's changed is brought up to date when a message is saved.
 */
async function chatFor(db, origin, name, kind = "friend") {
  return (await db.prepare("SELECT * FROM chats WHERE origin = ?").bind(origin).first())
    ?? db.prepare(`INSERT INTO chats (origin, name, kind, notify, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (origin) DO UPDATE SET origin = excluded.origin RETURNING *`).bind(origin, name, kind, kind === "group" ? 0 : 1, now()).first();
}

/**
 * Where a chat's messages go: the friend's site (their connection) or the group's (its row here), with the key for
 * it and the outbox's queue for it; null if they're not a friend, or this site's not in the group, any more.
 */
async function recipientOf(db, chat) {
  if (chat.kind === "group") {
    const [, origin, n] = GROUP_RE.exec(chat.origin) ?? [];
    const group = origin && await db.prepare("SELECT * FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NOT NULL")
      .bind(origin, Number(n)).first();
    return group ? { id: group.id, origin: group.origin, key: group.their_key, path: "/_group/chat", table: "group_messages",
      to: chat.origin, name: group.name, group } : null;
  }
  const friend = await db.prepare(FRIEND_SQL).bind(chat.origin).first();
  return friend ? { id: friend.id, origin: friend.origin, key: friend.their_key, path: "/_peer/message", table: "messages",
    to: actorId(friend.origin), name: friend.name } : null;
}

const notThere = (chat) => new Refusal(chat.kind === "group"
  ? `You're not in ${chat.name} any more, so you can't send messages to it.`
  : `You're not friends with ${chat.name} any more, so you can't send them messages.`, 403);

/** In a group chat, whether the owner here runs the group (and so may delete anyone's message for everyone). */
const runsGroup = (to) => to?.group?.role === "owner" || to?.group?.role === "admin";

/** A group chat's messages from more than 30 days ago go: in one chat, or (no `chatId`) all of them. */
function pruneGroupChats(db, chatId = null) {
  return db.prepare(`DELETE FROM messages WHERE received_at < ?
    AND chat_id IN (SELECT id FROM chats WHERE kind = 'group' ${chatId ? "AND id = ?" : ""})`)
    .bind(...[now() - GROUP_KEEP_SECONDS, chatId].filter((v) => v !== null)).run();
}

async function findChat(db, id) {
  const chat = await db.prepare("SELECT * FROM chats WHERE id = ?").bind(Number(id)).first();
  if (!chat) throw new Refusal("That chat isn't here any more.", 404);
  return chat;
}

/** The note that carries a message of the owner's to `to`: a friend (their site's actor) or a group (its address). */
function messageNote(site, to, message) {
  const object = { type: "Note", id: `${site}/messages/${message.uid}`, attributedTo: actorId(site), to: [to],
    mediaType: "text/plain", content: message.text, published: iso(message.sent_at) };
  return { "@context": CONTEXT, type: "Create", actor: actorId(site), to: [to], object };
}

/**
 * A message as pages and the API show it: its state if it's the owner's (sending, delivered or failed); in a group
 * chat, who wrote it (and their site, if they're not one of the owner's `friends`, so a look-alike name stands out),
 * and whether the owner may delete it for everyone (`admin`: they run the group).
 */
function shown(m, chat = null, admin = false, friends = new Set()) {
  const state = !m.mine ? null : m.delivered_at ? "delivered" : m.failed_at ? "failed" : "sending";
  return { id: m.id, mine: Boolean(m.mine), text: m.text, sent_at: m.sent_at, state, problem: m.failed_at ? m.problem : null,
    author: m.mine ? null : m.author_name ?? null, authorSite: !m.mine && m.author_origin && !friends.has(m.author_origin) ? host(m.author_origin) : null,
    everywhere: chat?.kind === "group" && Boolean(m.mine || admin) };
}

/** The sites of the owner's friends, in a group chat (where not everyone is one); in a chat with one friend, none needed. */
async function friendSites(db, chat) {
  if (chat.kind !== "group") return new Set();
  const rows = await db.prepare("SELECT origin FROM connections WHERE approved_at IS NOT NULL").all();
  return new Set(rows.results.map((r) => r.origin));
}

// --- actions (the owner's) ---------------------------------------------------------------------------------------

/** The chat with a friend (by their connection), made if it's new: its id. */
export async function openChat(env, connectionId) {
  const friend = await env.DB.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL")
    .bind(Number(connectionId)).first();
  if (!friend) throw new Refusal("You're not friends with them, so you can't send them messages.", 404);
  return { chat: (await chatFor(env.DB, friend.origin, friend.name)).id };
}

/** Sends `text` to the chat's friend: saved here, then sent at once, or queued if their site can't be reached. */
export async function sendMessage(env, site, chatId, text) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const words = cleanMessage(text);
  if (!words) throw new Refusal(`Messages need 1 to ${MAX_MESSAGE} characters.`);
  const to = await recipientOf(db, chat);
  if (!to) throw notThere(chat);
  const at = now();
  const message = await db.prepare(`INSERT INTO messages (chat_id, mine, uid, text, sent_at, received_at)
    VALUES (?, 1, ?, ?, ?, ?) RETURNING *`).bind(chat.id, randomToken(), words, at, at).first();
  await db.prepare("UPDATE chats SET last_at = ?, name = ?, read_up_to = ? WHERE id = ?").bind(at, to.name, message.id, chat.id).run();
  return { message: shown(await deliver(env, site, to, message), chat) };
}

/** Tries a message that wasn't delivered again, now. */
export async function retryMessage(env, site, chatId, messageId) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const message = await db.prepare("SELECT * FROM messages WHERE id = ? AND chat_id = ? AND mine = 1").bind(Number(messageId), chat.id).first();
  if (!message) throw new Refusal("That message isn't here any more.", 404);
  if (!message.failed_at) return { message: shown(message, chat) };
  const to = await recipientOf(db, chat);
  if (!to) throw notThere(chat);
  const fresh = await db.prepare("UPDATE messages SET failed_at = NULL, problem = NULL WHERE id = ? RETURNING *").bind(message.id).first();
  return { message: shown(await deliver(env, site, to, fresh), chat) };
}

/** Sends a saved message to the friend's or group's site (`to`); returns it as it now stands (delivered, sending, or failed). */
async function deliver(env, site, to, message) {
  const db = env.DB;
  const note = messageNote(site, to.to, message);
  try {
    await callSite(to.origin, to.path, { key: to.key, body: note, timeout: DIRECT_TIMEOUT_MS });
    return db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? RETURNING *").bind(now(), message.id).first();
  } catch (error) {
    const problem = messageProblem(error.status ?? 0);
    if (problem === "unreachable") {
      await outbox(env).sendMessage(to.table, to.id, message.id, note, FIRST_RETRY_SECONDS);
      return message;
    }
    return db.prepare("UPDATE messages SET failed_at = ?, problem = ? WHERE id = ? RETURNING *").bind(now(), problem, message.id).first();
  }
}

/**
 * Deletes one message: here only, or (`everywhere`, in a group chat: the owner's own, or anyone's if they run the
 * group) for everyone, which the group's site passes on to the members' sites.
 */
export async function deleteMessage(env, site, chatId, messageId, everywhere = false) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const message = await db.prepare(`SELECT * FROM messages WHERE id = ? AND chat_id = ? AND ${LIVE}`).bind(Number(messageId), chat.id).first();
  if (!message) return { deleted: true };
  // An own message the group never got only needs deleting here.
  if (everywhere && !(message.mine && !message.delivered_at)) {
    if (chat.kind !== "group") throw new Refusal("Only a message in a group chat can be deleted for everyone.");
    const to = await recipientOf(db, chat);
    if (!to) throw notThere(chat);
    const address = message.mine ? `${site}/messages/${message.uid}` : message.uid;
    try {
      await callSite(to.origin, "/_group/chat/delete", { key: to.key, body: { "@context": CONTEXT, type: "Delete", object: address } });
    } catch (error) {
      throw new Refusal(`Couldn't delete it for everyone: ${error.message}`);
    }
  }
  // In a group chat it's blanked and kept until it goes (so the group's limits still count it); elsewhere, gone.
  await (chat.kind === "group"
    ? db.prepare("UPDATE messages SET text = '', deleted_at = ? WHERE id = ?").bind(now(), message.id)
    : db.prepare("DELETE FROM messages WHERE id = ?").bind(message.id)).run();
  return { deleted: true };
}

/** Deletes a whole chat, here only. If they're still a friend, a new message starts a new one. */
export async function deleteChat(env, chatId) {
  const chat = await findChat(env.DB, chatId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chat.id),
    env.DB.prepare("DELETE FROM chats WHERE id = ?").bind(chat.id),
  ]);
  return { deleted: true };
}

/**
 * Mutes or unmutes a chat. A muted chat still shows new messages while it's open, and in Messages, but doesn't add to
 * the menu's count, and never notifies.
 */
export async function muteChat(env, chatId, muted) {
  const chat = await findChat(env.DB, chatId);
  await env.DB.prepare("UPDATE chats SET muted = ? WHERE id = ?").bind(muted ? 1 : 0, chat.id).run();
  return { muted: Boolean(muted) };
}

/** Whether a chat's messages notify (a group chat's don't, to begin with; muting stops them either way). */
export async function notifyChat(env, chatId, notify) {
  const chat = await findChat(env.DB, chatId);
  await env.DB.prepare("UPDATE chats SET notify = ? WHERE id = ?").bind(notify ? 1 : 0, chat.id).run();
  return { notify: Boolean(notify) };
}

/**
 * What's new in a chat that's open: messages after `after`, and how the owner's own messages listed in `pending` now
 * stand. The page is being looked at, so everything in it counts as seen.
 */
export async function chatSince(env, chatId, after, pending) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const ids = pending.map(Number).filter(Number.isSafeInteger).slice(0, 100);
  const [fresh, states] = await db.batch([
    db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND id > ? AND ${LIVE} ORDER BY id LIMIT ?`).bind(chat.id, Number(after) || 0, SHOWN),
    db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND mine = 1 AND id IN (${ids.map(() => "?").join(",") || "NULL"})`).bind(chat.id, ...ids),
  ]);
  const to = await recipientOf(db, chat);
  const friends = await friendSites(db, chat);
  const show = (m) => shown(m, chat, runsGroup(to), friends);
  // Read, and open on screen right now (so a new message here doesn't notify: push.js). Noted every few seconds at most.
  const newest = fresh.results.at(-1)?.id ?? 0;
  const at = now();
  if (newest > chat.read_up_to || at - (chat.viewing_at ?? 0) >= VIEWING_EVERY) {
    await db.prepare("UPDATE chats SET read_up_to = MAX(read_up_to, ?), viewing_at = ? WHERE id = ?").bind(newest, at, chat.id).run();
  }
  return { messages: fresh.results.map(show), states: states.results.map(show), canSend: Boolean(to) };
}

// --- from a friend's site --------------------------------------------------------------------------------------

/**
 * A message from a connected, approved friend's site (peers.js): kept, or refused. Returns [body, status]. Once it's
 * kept, the owner's devices are told (push.js), after answering, through `work` (the request's waitUntil). `site` is
 * this site's address.
 */
export async function receiveMessage(env, peer, note, { site, work }) {
  const db = env.DB;
  const object = note?.type === "Create" && note.object?.type === "Note" ? note.object : null;
  const prefix = `${peer.origin}/messages/`;
  const uid = typeof object?.id === "string" && object.id.startsWith(prefix) ? object.id.slice(prefix.length) : "";
  if (!UID_RE.test(uid)) return [{ error: "That isn't a message from your site." }, 400];
  const text = cleanMessage(object.content);
  if (!text) return [{ error: `Messages need 1 to ${MAX_MESSAGE} characters.` }, 400];
  const at = now();
  // Their clock isn't ours to trust: never later than it arrived.
  const published = Date.parse(typeof object.published === "string" ? object.published : "");
  const sentAt = Number.isFinite(published) ? Math.max(at - BACKDATE_SECONDS, Math.min(at, Math.floor(published / 1000))) : at;
  const chat = await chatFor(db, peer.origin, peer.name);
  // The limits, and keeping each message once, are checked in the same statement as the insert.
  const row = await db.prepare(`INSERT OR IGNORE INTO messages (chat_id, mine, uid, text, sent_at, received_at)
    SELECT ?1, 0, ?2, ?3, ?4, ?5
    WHERE (SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - 86400) < ?8
      AND (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM messages
        WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - 86400) + LENGTH(CAST(?3 AS BLOB)) <= ?10
      AND (SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.kind = 'friend' AND m.mine = 0 AND m.received_at > ?5 - 86400) < ?9
      AND (SELECT COALESCE(SUM(LENGTH(CAST(m.text AS BLOB))), 0) FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.kind = 'friend' AND m.mine = 0 AND m.received_at > ?5 - 86400) + LENGTH(CAST(?3 AS BLOB)) <= ?11
    RETURNING id`).bind(chat.id, uid, text, sentAt, at, RATE.seconds, RATE.count, RATE.daily, RATE.everyone, RATE.bytes, RATE.everyoneBytes).first();
  if (!row) {
    const known = await db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND mine = 0 AND uid = ?").bind(chat.id, uid).first();
    return known ? [{ ok: true }, 200] : [{ error: "That's a lot of messages for now. Try again later." }, 429];
  }
  await db.prepare("UPDATE chats SET last_at = ?, name = ? WHERE id = ?").bind(at, peer.name, chat.id).run();
  work.waitUntil(notifyMessage(env, site, { ...chat, name: peer.name }, text).catch((error) => console.error("Notifying about a message failed:", error)));
  return [{ ok: true }, 201];
}

// --- from a group's site ---------------------------------------------------------------------------------------

/**
 * From a group this site is in (membership.js, POST /_member/message, with the key this site gave the group): a
 * member's message in its chat, passed on, or the news that one was deleted for everyone. Returns [body, status].
 *   {type: "Create", object: {type: "Note", id: "<member's site>/messages/<uid>", context: "<group's address>",
 *     attributedTo: {id: "<member's site>/", name}, content, published}}
 *   {type: "Delete", object: "<member's site>/messages/<uid>"}
 * The group vouches for who wrote it, as it does for posts; but never for the owner here, who speaks for themselves.
 */
export async function receiveGroupMessage(env, group, note, { site, work }) {
  const db = env.DB;
  const address = groupId(group.origin, group.remote_id);
  if (note?.type === "Delete") {
    const id = typeof note.object === "string" ? note.object : "";
    const chat = id && await db.prepare("SELECT id FROM chats WHERE origin = ?").bind(address).first();
    const own = `${site}/messages/`;
    if (chat) {
      // Blanked, not removed, so the chat's limits still count it (deleting and sending again can't get round them).
      await db.prepare(`UPDATE messages SET text = '', deleted_at = ? WHERE chat_id = ? AND mine = ? AND uid = ? AND ${LIVE}`)
        .bind(now(), chat.id, id.startsWith(own) ? 1 : 0, id.startsWith(own) ? id.slice(own.length) : id).run();
    }
    return [{ ok: true }, 200];
  }
  const object = note?.type === "Create" && note.object?.type === "Note" ? note.object : null;
  if (!object || object.context !== address) return [{ error: "That isn't a message in this group." }, 400];
  const author = siteOrigin(typeof object.attributedTo?.id === "string" ? object.attributedTo.id : "", env);
  if (!author || author === site) return [{ error: "That isn't a member's message." }, 400];
  const prefix = `${author}/messages/`;
  if (typeof object.id !== "string" || !object.id.startsWith(prefix) || !UID_RE.test(object.id.slice(prefix.length))) {
    return [{ error: "That isn't a message from that member's site." }, 400];
  }
  const text = cleanMessage(object.content);
  if (!text) return [{ error: `Messages need 1 to ${MAX_MESSAGE} characters.` }, 400];
  const name = cleanMessage(object.attributedTo?.name).replace(/\s+/g, " ").slice(0, 100) || "Someone";
  const at = now();
  const published = Date.parse(typeof object.published === "string" ? object.published : "");
  const sentAt = Number.isFinite(published) ? Math.max(at - BACKDATE_SECONDS, Math.min(at, Math.floor(published / 1000))) : at;
  const chat = await chatFor(db, address, group.name, "group");
  // A message is kept by its whole address (uid), so two members' can't clash.
  const bytes = new TextEncoder().encode(text).length;
  const row = await db.prepare(`INSERT OR IGNORE INTO messages (chat_id, mine, uid, text, sent_at, received_at, author_origin, author_name, bytes)
    SELECT ?1, 0, ?2, ?3, ?4, ?5, ?11, ?12, ?13
    WHERE (SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - 86400) < ?8
      AND (SELECT COALESCE(SUM(bytes), 0) FROM messages WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - 86400) + ?13 <= ?10
      AND (SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.kind = 'group' AND m.mine = 0 AND m.received_at > ?5 - 86400) < ?9
      AND (SELECT COALESCE(SUM(m.bytes), 0) FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.kind = 'group' AND m.mine = 0 AND m.received_at > ?5 - 86400) + ?13 <= ?14
    RETURNING id`).bind(chat.id, object.id, text, sentAt, at, GROUP_RATE.seconds, GROUP_RATE.count, GROUP_RATE.daily,
    GROUP_RATE.everyone, GROUP_RATE.bytes, author, name, bytes, GROUP_RATE.everyoneBytes).first();
  if (!row) {
    const known = await db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND mine = 0 AND uid = ?").bind(chat.id, object.id).first();
    return known ? [{ ok: true }, 200] : [{ error: "That's a lot of messages for now. Try again later." }, 429];
  }
  await db.prepare("UPDATE chats SET last_at = ?, name = ? WHERE id = ?").bind(at, group.name, chat.id).run();
  await pruneGroupChats(db, chat.id);
  work.waitUntil(notifyMessage(env, site, { ...chat, name: group.name }, text, name)
    .catch((error) => console.error("Notifying about a message failed:", error)));
  return [{ ok: true }, 201];
}

// --- pages (loaders, archive/routes.js) ------------------------------------------------------------------------

/** How many chats (not muted) have messages the owner hasn't seen, for the menu. */
export async function unreadChats(db) {
  // From the chats: one look in each (messages_by_chat), however many messages there are.
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM chats c WHERE c.muted = 0
    AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.id > c.read_up_to AND m.mine = 0 AND m.${LIVE})`).first();
  return row?.n ?? 0;
}

/** Messages: every chat, newest first, and the friends there's no chat with yet. */
export async function messagesIndex(ctx) {
  const { db } = ctx;
  await pruneGroupChats(db);
  const [chats, friends] = await db.batch([
    db.prepare(`SELECT c.id, c.origin, c.name, c.kind, c.muted, c.last_at,
      (SELECT text FROM messages WHERE chat_id = c.id AND ${LIVE} ORDER BY id DESC LIMIT 1) AS last_text,
      (SELECT mine FROM messages WHERE chat_id = c.id AND ${LIVE} ORDER BY id DESC LIMIT 1) AS last_mine,
      EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id AND mine = 0 AND id > c.read_up_to AND ${LIVE}) AS unread,
      CASE WHEN c.kind = 'group'
        THEN EXISTS (SELECT 1 FROM groups g WHERE g.joined_at IS NOT NULL AND g.origin || '/groups/' || g.remote_id = c.origin)
        ELSE EXISTS (SELECT 1 FROM connections WHERE origin = c.origin AND connected_at IS NOT NULL AND approved_at IS NOT NULL)
      END AS friend
      FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id AND ${LIVE})
      ORDER BY COALESCE(c.last_at, c.created_at) DESC, c.id DESC`),
    // Friends with nothing said yet (a chat opened and left empty doesn't count).
    db.prepare(`SELECT id, name, origin FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
      AND origin NOT IN (SELECT origin FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id AND ${LIVE}))
      ORDER BY name COLLATE NOCASE`),
  ]);
  return {
    chats: chats.results.map((c) => ({ id: c.id, name: c.name, kind: c.kind, host: host(c.origin), muted: Boolean(c.muted), last_at: c.last_at,
      last: c.last_text === null ? null : { mine: Boolean(c.last_mine), text: c.last_text.slice(0, 120) },
      unread: Boolean(c.unread), friend: Boolean(c.friend) })),
    friends: friends.results.map((f) => ({ id: f.id, name: f.name, host: host(f.origin) })),
    pushKey: await pushKey(ctx.env), // public: devices are given it when they say yes to notifications
  };
}

/** A chat: its newest messages (or those before `?before=`), oldest first. Opening it counts them as seen. */
export async function chatPage(ctx, params, id) {
  const { db } = ctx;
  const chat = await db.prepare("SELECT * FROM chats WHERE id = ?").bind(Number(id)).first();
  if (!chat) return null;
  if (chat.kind === "group") await pruneGroupChats(db, chat.id);
  const before = Number.parseInt(params.get("before"), 10) || null;
  const rows = await db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND ${LIVE} ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...[chat.id, before, SHOWN + 1].filter((v) => v !== null)).all();
  const to = await recipientOf(db, chat);
  const friends = await friendSites(db, chat);
  const list = rows.results.slice(0, SHOWN).reverse();
  const newest = list.at(-1)?.id ?? 0;
  // Read now. (Whether it's open on screen is up to its script, which asks for news while it's in view: chatSince.)
  if (!before && newest > chat.read_up_to) {
    await db.prepare("UPDATE chats SET read_up_to = MAX(read_up_to, ?) WHERE id = ?").bind(newest, chat.id).run();
    ctx.messages = await unreadChats(db); // the menu's count, now this one's been read
  }
  return {
    chat: { id: chat.id, name: chat.name, kind: chat.kind, host: host(chat.origin), muted: Boolean(chat.muted), notify: Boolean(chat.notify) },
    // Who it's with now: their connection here (a friend), or the group here; null if not any more.
    friend: to && chat.kind !== "group" ? { id: to.id } : null,
    group: to && chat.kind === "group" ? { id: to.id } : null,
    canSend: Boolean(to),
    keepDays: chat.kind === "group" ? GROUP_KEEP_SECONDS / 86400 : null,
    messages: list.map((m) => shown(m, chat, runsGroup(to), friends)),
    earlier: rows.results.length > SHOWN ? list[0].id : null,
    paged: Boolean(before),
    max: MAX_MESSAGE,
  };
}

/** /friend/<n>/message: the chat with that friend, made if it's new. */
export async function friendMessage(ctx, params, connectionId) {
  try {
    const { chat } = await openChat(ctx.env, connectionId);
    return Response.redirect(`${ctx.url.origin}/messages/${chat}`, 303);
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

/** /groups/<n>/chat: the chat with a group this site is in, made if it's new. */
export async function groupChat(ctx, params, id) {
  const group = await ctx.db.prepare("SELECT * FROM groups WHERE id = ? AND joined_at IS NOT NULL AND origin IS NOT NULL").bind(Number(id)).first();
  if (!group) return null;
  const chat = await chatFor(ctx.db, groupId(group.origin, group.remote_id), group.name, "group");
  return Response.redirect(`${ctx.url.origin}/messages/${chat.id}`, 303);
}

// --- the web side (/_messages/…): the chat page's script, and its forms without one -------------------------------

const ROUTES = [
  [/^\/_messages\/(\d+)\/send$/, (a) => sendMessage(a.env, a.url.origin, a.m[1], a.body.text)],
  [/^\/_messages\/(\d+)\/(\d+)\/retry$/, (a) => retryMessage(a.env, a.url.origin, a.m[1], a.m[2])],
  [/^\/_messages\/(\d+)\/(\d+)\/delete$/, (a) => deleteMessage(a.env, a.url.origin, a.m[1], a.m[2], a.body.everywhere === true || a.body.everywhere === "1")],
  [/^\/_messages\/(\d+)\/mute$/, (a) => muteChat(a.env, a.m[1], a.body.muted === true || a.body.muted === "1")],
  [/^\/_messages\/(\d+)\/notify$/, (a) => notifyChat(a.env, a.m[1], a.body.notify === true || a.body.notify === "1")],
  [/^\/_messages\/(\d+)\/delete$/, (a) => deleteChat(a.env, a.m[1]), "/messages"],
];

export async function handleMessages(request, env, url) {
  const since = /^\/_messages\/(\d+)\/since$/.exec(url.pathname);
  if (request.method === "GET" && since) {
    // Only for this site's own chat page: it counts as reading the chat, which another site shouldn't do by linking here.
    const from = request.headers.get("Sec-Fetch-Site");
    if (from && from !== "same-origin") return new Response("Request from another site", { status: 403 });
    return answer(() => chatSince(env, since[1], url.searchParams.get("after"), (url.searchParams.get("pending") ?? "").split(",").filter(Boolean)), true);
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });
  const asJson = request.headers.get("Content-Type")?.startsWith("application/json");
  const body = asJson ? await request.json().catch(() => ({})) : Object.fromEntries(await request.formData().catch(() => new FormData()));
  for (const [pattern, act, after] of ROUTES) {
    const m = pattern.exec(url.pathname);
    if (!m) continue;
    const back = after ?? `/messages/${m[1]}`;
    return answer(() => act({ env, url, m, body: body && typeof body === "object" ? body : {} }), asJson, `${url.origin}${back}`);
  }
  return new Response("Not found", { status: 404 });
}

/** An action's result as JSON, or, for a form, back to the page; a refusal as {error} or a plain message. */
async function answer(act, asJson, back) {
  try {
    const result = await act();
    if (asJson) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    return Response.redirect(back, 303);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (asJson) return Response.json({ error: error.message }, { status: error.status });
    return html(messagePage(error.message, { href: back, label: "Back" }), error.status);
  }
}
