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
import { actorId, CONTEXT, iso } from "../public/static/activity.js";
import { messageProblem, outbox } from "./outbox.js";
import { callSite, host } from "./peers.js";
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
const RATE = { count: 120, seconds: 600, daily: 1000, everyone: 3000, bytes: 1_000_000 };
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

/** The chat with the friend at `origin`, made if it's new. A name that's changed is brought up to date when a message is saved. */
async function chatFor(db, origin, name) {
  return (await db.prepare("SELECT * FROM chats WHERE origin = ?").bind(origin).first())
    ?? db.prepare(`INSERT INTO chats (origin, name, created_at) VALUES (?, ?, ?)
      ON CONFLICT (origin) DO UPDATE SET origin = excluded.origin RETURNING *`).bind(origin, name, now()).first();
}

async function findChat(db, id) {
  const chat = await db.prepare("SELECT * FROM chats WHERE id = ?").bind(Number(id)).first();
  if (!chat) throw new Refusal("That chat isn't here any more.", 404);
  return chat;
}

/** The note that carries a message of the owner's to the friend at `to`. */
function messageNote(site, to, message) {
  const object = { type: "Note", id: `${site}/messages/${message.uid}`, attributedTo: actorId(site), to: [actorId(to)],
    mediaType: "text/plain", content: message.text, published: iso(message.sent_at) };
  return { "@context": CONTEXT, type: "Create", actor: actorId(site), to: [actorId(to)], object };
}

/** A message as pages and the API show it, and its state if it's the owner's: sending, delivered or failed. */
function shown(m) {
  const state = !m.mine ? null : m.delivered_at ? "delivered" : m.failed_at ? "failed" : "sending";
  return { id: m.id, mine: Boolean(m.mine), text: m.text, sent_at: m.sent_at, state, problem: m.failed_at ? m.problem : null };
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
  const friend = await db.prepare(FRIEND_SQL).bind(chat.origin).first();
  if (!friend) throw new Refusal(`You're not friends with ${chat.name} any more, so you can't send them messages.`, 403);
  const at = now();
  const message = await db.prepare(`INSERT INTO messages (chat_id, mine, uid, text, sent_at, received_at)
    VALUES (?, 1, ?, ?, ?, ?) RETURNING *`).bind(chat.id, randomToken(), words, at, at).first();
  await db.prepare("UPDATE chats SET last_at = ?, name = ?, read_up_to = ? WHERE id = ?").bind(at, friend.name, message.id, chat.id).run();
  return { message: shown(await deliver(env, site, friend, message)) };
}

/** Tries a message that wasn't delivered again, now. */
export async function retryMessage(env, site, chatId, messageId) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const message = await db.prepare("SELECT * FROM messages WHERE id = ? AND chat_id = ? AND mine = 1").bind(Number(messageId), chat.id).first();
  if (!message) throw new Refusal("That message isn't here any more.", 404);
  if (!message.failed_at) return { message: shown(message) };
  const friend = await db.prepare(FRIEND_SQL).bind(chat.origin).first();
  if (!friend) throw new Refusal(`You're not friends with ${chat.name} any more, so you can't send them messages.`, 403);
  const fresh = await db.prepare("UPDATE messages SET failed_at = NULL, problem = NULL WHERE id = ? RETURNING *").bind(message.id).first();
  return { message: shown(await deliver(env, site, friend, fresh)) };
}

/** Sends a saved message to the friend's site; returns it as it now stands (delivered, sending, or failed). */
async function deliver(env, site, friend, message) {
  const db = env.DB;
  try {
    await callSite(friend.origin, "/_peer/message", { key: friend.their_key, body: messageNote(site, friend.origin, message), timeout: DIRECT_TIMEOUT_MS });
    return db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? RETURNING *").bind(now(), message.id).first();
  } catch (error) {
    const problem = messageProblem(error.status ?? 0);
    if (problem === "unreachable") {
      await outbox(env).sendMessage(friend.id, message.id, messageNote(site, friend.origin, message), FIRST_RETRY_SECONDS);
      return message;
    }
    return db.prepare("UPDATE messages SET failed_at = ?, problem = ? WHERE id = ? RETURNING *").bind(now(), problem, message.id).first();
  }
}

/** Deletes one message, here only. */
export async function deleteMessage(env, chatId, messageId) {
  const chat = await findChat(env.DB, chatId);
  await env.DB.prepare("DELETE FROM messages WHERE id = ? AND chat_id = ?").bind(Number(messageId), chat.id).run();
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

/**
 * What's new in a chat that's open: messages after `after`, and how the owner's own messages listed in `pending` now
 * stand. The page is being looked at, so everything in it counts as seen.
 */
export async function chatSince(env, chatId, after, pending) {
  const db = env.DB;
  const chat = await findChat(db, chatId);
  const ids = pending.map(Number).filter(Number.isSafeInteger).slice(0, 100);
  const [fresh, states, friend] = await db.batch([
    db.prepare("SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?").bind(chat.id, Number(after) || 0, SHOWN),
    db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND mine = 1 AND id IN (${ids.map(() => "?").join(",") || "NULL"})`).bind(chat.id, ...ids),
    db.prepare(FRIEND_SQL).bind(chat.origin),
  ]);
  // Read, and open on screen right now (so a new message here doesn't notify: push.js). Noted every few seconds at most.
  const newest = fresh.results.at(-1)?.id ?? 0;
  const at = now();
  if (newest > chat.read_up_to || at - (chat.viewing_at ?? 0) >= VIEWING_EVERY) {
    await db.prepare("UPDATE chats SET read_up_to = MAX(read_up_to, ?), viewing_at = ? WHERE id = ?").bind(newest, at, chat.id).run();
  }
  return { messages: fresh.results.map(shown), states: states.results.map(shown), canSend: Boolean(friend.results[0]) };
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
      AND (SELECT COUNT(*) FROM messages WHERE mine = 0 AND received_at > ?5 - 86400) < ?9
      AND (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM messages
        WHERE chat_id = ?1 AND mine = 0 AND received_at > ?5 - 86400) + LENGTH(CAST(?3 AS BLOB)) <= ?10
    RETURNING id`).bind(chat.id, uid, text, sentAt, at, RATE.seconds, RATE.count, RATE.daily, RATE.everyone, RATE.bytes).first();
  if (!row) {
    const known = await db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND mine = 0 AND uid = ?").bind(chat.id, uid).first();
    return known ? [{ ok: true }, 200] : [{ error: "That's a lot of messages for now. Try again later." }, 429];
  }
  await db.prepare("UPDATE chats SET last_at = ?, name = ? WHERE id = ?").bind(at, peer.name, chat.id).run();
  work.waitUntil(notifyMessage(env, site, { ...chat, name: peer.name }, text).catch((error) => console.error("Notifying about a message failed:", error)));
  return [{ ok: true }, 201];
}

// --- pages (loaders, archive/routes.js) ------------------------------------------------------------------------

/** How many chats (not muted) have messages the owner hasn't seen, for the menu. */
export async function unreadChats(db) {
  // From the chats: one look in each (messages_by_chat), however many messages there are.
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM chats c WHERE c.muted = 0
    AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.id > c.read_up_to AND m.mine = 0)`).first();
  return row?.n ?? 0;
}

/** Messages: every chat, newest first, and the friends there's no chat with yet. */
export async function messagesIndex(ctx) {
  const { db } = ctx;
  const [chats, friends] = await db.batch([
    db.prepare(`SELECT c.id, c.origin, c.name, c.muted, c.last_at,
      (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_text,
      (SELECT mine FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_mine,
      EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id AND mine = 0 AND id > c.read_up_to) AS unread,
      EXISTS (SELECT 1 FROM connections WHERE origin = c.origin AND connected_at IS NOT NULL AND approved_at IS NOT NULL) AS friend
      FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id)
      ORDER BY COALESCE(c.last_at, c.created_at) DESC, c.id DESC`),
    // Friends with nothing said yet (a chat opened and left empty doesn't count).
    db.prepare(`SELECT id, name, origin FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
      AND origin NOT IN (SELECT origin FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id))
      ORDER BY name COLLATE NOCASE`),
  ]);
  return {
    chats: chats.results.map((c) => ({ id: c.id, name: c.name, host: host(c.origin), muted: Boolean(c.muted), last_at: c.last_at,
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
  const before = Number.parseInt(params.get("before"), 10) || null;
  const [rows, friend] = await db.batch([
    db.prepare(`SELECT * FROM messages WHERE chat_id = ? ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...[chat.id, before, SHOWN + 1].filter((v) => v !== null)),
    db.prepare(FRIEND_SQL).bind(chat.origin),
  ]);
  const list = rows.results.slice(0, SHOWN).reverse();
  const newest = list.at(-1)?.id ?? 0;
  // Read now. (Whether it's open on screen is up to its script, which asks for news while it's in view: chatSince.)
  if (!before && newest > chat.read_up_to) {
    await db.prepare("UPDATE chats SET read_up_to = MAX(read_up_to, ?) WHERE id = ?").bind(newest, chat.id).run();
    ctx.messages = await unreadChats(db); // the menu's count, now this one's been read
  }
  return {
    chat: { id: chat.id, name: chat.name, host: host(chat.origin), muted: Boolean(chat.muted) },
    friend: friend.results[0] ? { id: friend.results[0].id } : null,
    messages: list.map(shown),
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

// --- the web side (/_messages/…): the chat page's script, and its forms without one -------------------------------

const ROUTES = [
  [/^\/_messages\/(\d+)\/send$/, (a) => sendMessage(a.env, a.url.origin, a.m[1], a.body.text)],
  [/^\/_messages\/(\d+)\/(\d+)\/retry$/, (a) => retryMessage(a.env, a.url.origin, a.m[1], a.m[2])],
  [/^\/_messages\/(\d+)\/(\d+)\/delete$/, (a) => deleteMessage(a.env, a.m[1], a.m[2])],
  [/^\/_messages\/(\d+)\/mute$/, (a) => muteChat(a.env, a.m[1], a.body.muted === true || a.body.muted === "1")],
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
