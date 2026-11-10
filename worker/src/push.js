// Notifications on the owner's own phones and computers, for messages from friends, and for nothing else: never posts,
// comments, friend requests or updates (afterwrd doesn't chase attention; open it when you want to). A device says yes
// from Messages (public/static/messages.js); after that, a message from a friend notifies it even while it's asleep,
// unless that chat's muted, or open on screen right now. Each site signs its own notifications and encrypts each one
// for that device alone (webpush.js), so the push service passes it on without being able to read it.
//   POST /_push/devices          {endpoint, keys: {p256dh, auth}, name, preview}: this device says yes
//   POST /_push/devices/forget   {endpoint}: this device says no
//   POST /_push/devices/preview  {endpoint, preview}: show the message on the lock screen, or only who it's from
// Each device is listed in Your devices (admin.js), where it can be turned off from anywhere; Home mentions a new one
// for 14 days, as it does a new passkey. A device goes when the passkey that was signed in when it said yes is
// removed, when that session signs out, and on "Sign out everywhere".
import { testingHere } from "./cloudflare.js";
import { unreadChats } from "./messages.js";
import { fromBase64Url, html, json, now, Refusal } from "./util.js";
import { messagePage } from "./views/pages.js";
import { makeVapidKeys, pushEndpoint, sendPush } from "./webpush.js";

// The site's signing key pair. In settings, which Download everything leaves out (export.js names what it takes).
const KEY = "push_vapid";
const MAX_DEVICES = 10;
const PREVIEW = 200; // characters of a message on the lock screen
const OPEN_SECONDS = 25; // a chat whose page asked for news this recently is open on screen (messages.js chatSince)
const QUIET_SECONDS = 60; // after a notification makes a sound, more from that chat replace it quietly for a minute
const NEW_DEVICE_SECONDS = 14 * 86400; // how long Home mentions a device newly turned on

/** The site's public signing key, as devices are given it when they say yes. Made the first time it's needed. */
export async function pushKey(env) {
  return (await vapidKeys(env)).publicKey;
}

async function vapidKeys(env) {
  const read = async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first();
    return row ? JSON.parse(row.value) : null;
  };
  const found = await read();
  if (found) return found;
  // The first one saved wins, so two pages opened at once can't end up with different keys.
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(await makeVapidKeys())).run();
  return read();
}

/**
 * A device saying yes: its push address and keys (PushSubscription.toJSON()), what it's called, and preview. `owner`
 * is who's signed in (auth.js currentUser): the passkey and session it's tied to. `site` is this site's address.
 */
export async function addDevice(env, body, owner, site) {
  const endpoint = pushEndpoint(body.endpoint, { local: testingHere(env, site) });
  if (!endpoint) throw new Refusal("That isn't a push service this site will send to.");
  const p256dh = String(body.keys?.p256dh ?? "");
  const auth = String(body.keys?.auth ?? "");
  const size = (text) => { try { return fromBase64Url(text).length; } catch { return 0; } };
  if (size(p256dh) !== 65 || size(auth) !== 16) throw new Refusal("That device's keys aren't right.");
  const name = String(body.name ?? "").replace(/[^\w ()-]/g, "").slice(0, 40) || "A device";
  const db = env.DB;
  await db.batch([
    db.prepare(`INSERT INTO push_devices (endpoint, p256dh, auth, name, preview, credential_id, session_hash, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, name = ?4, preview = ?5, credential_id = ?6, session_hash = ?7`)
      .bind(endpoint, p256dh, auth, name, body.preview === false ? 0 : 1, owner.session_credential ?? null, owner.session_hash ?? null, now()),
    // At most ten: the oldest go.
    db.prepare(`DELETE FROM push_devices WHERE id NOT IN (SELECT id FROM push_devices ORDER BY id DESC LIMIT ${MAX_DEVICES})`),
  ]);
  return { on: true };
}

export async function forgetDevice(env, endpoint) {
  await env.DB.prepare("DELETE FROM push_devices WHERE endpoint = ?").bind(String(endpoint ?? "")).run();
  return { on: false };
}

export async function setPreview(env, endpoint, preview) {
  const row = await env.DB.prepare("UPDATE push_devices SET preview = ? WHERE endpoint = ? RETURNING preview")
    .bind(preview ? 1 : 0, String(endpoint ?? "")).first();
  if (!row) throw new Refusal("Notifications aren't on for this device.", 404);
  return { preview: Boolean(row.preview) };
}

/** Every device with notifications on, for Your devices: what it's called, and when. Never its address or keys. */
export async function listDevices(db) {
  const { results } = await db.prepare("SELECT id, name, preview, created_at, last_ok_at FROM push_devices ORDER BY id").all();
  return results;
}

/** Turns notifications off for a device, from Your devices (any device the owner's signed in on). */
export async function forgetDeviceById(env, id) {
  await env.DB.prepare("DELETE FROM push_devices WHERE id = ?").bind(Number(id)).run();
}

/** Devices turned on in the last 14 days that the owner hasn't said were them, for a notice on Home. */
export async function newPushDevices(db) {
  const { results } = await db.prepare("SELECT id, name, created_at FROM push_devices WHERE seen_at IS NULL AND created_at > ? ORDER BY id")
    .bind(now() - NEW_DEVICE_SECONDS).all();
  return results;
}

/** "That was me" on Home's notice. */
export async function pushDevicesSeen(env) {
  await env.DB.prepare("UPDATE push_devices SET seen_at = ? WHERE seen_at IS NULL").bind(now()).run();
}

/** Whether this device (by its push address) has notifications on here, and with what preview. */
export async function deviceState(env, endpoint) {
  const row = await env.DB.prepare("SELECT preview FROM push_devices WHERE endpoint = ?").bind(String(endpoint ?? "")).first();
  return row ? { on: true, preview: Boolean(row.preview) } : { on: false };
}

/**
 * A message from a friend (or, `from`, a member of a group) has just been saved in `chat` (messages.js): tell the
 * owner's devices, unless the chat's muted, its notifications are off, or it's open on screen. One notification per chat (each replaces the last), with the number of
 * chats waiting on the app's icon. Devices whose address no longer works (they said no, or the app was removed) are
 * forgotten. `site` is this site's address, which push services are given as who to contact about its notifications.
 */
export async function notifyMessage(env, site, chat, text, from = null) {
  const db = env.DB;
  // A muted chat, one whose notifications are off (a group chat, to begin with), or one that's open on screen: nothing.
  if (chat.muted || chat.notify === 0 || (chat.viewing_at && now() - chat.viewing_at < OPEN_SECONDS)) return;
  const { results: devices } = await db.prepare("SELECT * FROM push_devices ORDER BY id").all();
  if (!devices.length) return;
  const vapid = await vapidKeys(env);
  const badge = await unreadChats(db);
  const subject = site.startsWith("https://") ? site : "https://afterwrd.app";
  // In a group chat, who said it: the notification's title is the group.
  const words = `${from ? `${from}: ` : ""}${text.replace(/\s+/g, " ").trim()}`;
  // A busy chat makes a sound at most once a minute; in between, its notification is brought up to date quietly.
  const at = now();
  const quiet = Boolean(chat.notified_at && at - chat.notified_at < QUIET_SECONDS);
  if (!quiet) await db.prepare("UPDATE chats SET notified_at = ? WHERE id = ?").bind(at, chat.id).run();
  const local = testingHere(env, site);
  const sent = await Promise.all(devices.map((d) => sendPush(d, {
    title: chat.name,
    body: d.preview ? (words.length > PREVIEW ? `${words.slice(0, PREVIEW - 1)}…` : words) : "New message",
    url: `/messages/${chat.id}`,
    tag: `chat-${chat.id}`,
    quiet,
    badge,
  }, { vapid, subject, local }).catch(() => ({ status: 0, gone: false }))));
  const gone = devices.filter((_, i) => sent[i].gone).map((d) => d.id);
  const ok = devices.filter((_, i) => sent[i].status >= 200 && sent[i].status < 300).map((d) => d.id);
  const marks = (list) => list.map(() => "?").join(",");
  await db.batch([
    ...(gone.length ? [db.prepare(`DELETE FROM push_devices WHERE id IN (${marks(gone)})`).bind(...gone)] : []),
    // When each device last got one, to the day (no need to write it for every message).
    ...(ok.length ? [db.prepare(`UPDATE push_devices SET last_ok_at = ?1 WHERE id IN (${marks(ok)}) AND COALESCE(last_ok_at, 0) < ?1 - 86400`)
      .bind(now(), ...ok)] : []),
  ]);
}

// --- the web side: the owner's own pages only -----------------------------------------------------------------

const ROUTES = {
  "/_push/devices": (env, body, owner, url) => addDevice(env, body, owner, url.origin),
  "/_push/devices/forget": (env, body) => forgetDevice(env, body.endpoint),
  "/_push/devices/preview": (env, body) => setPreview(env, body.endpoint, body.preview === true),
  "/_push/devices/state": (env, body) => deviceState(env, body.endpoint),
};

export async function handlePush(request, env, url, owner) {
  const act = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  if (!act || request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    return json(await act(env, body && typeof body === "object" ? body : {}, owner, url));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: error.message }, error.status);
    return html(messagePage(error.message, { href: "/messages", label: "Back to Messages" }), error.status);
  }
}
