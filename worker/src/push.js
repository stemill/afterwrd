// Notifications on the owner's own phones and computers, for events and mentions and nothing else: when a friend
// invites them to one, when an event they haven't said no to changes or is called off (a friend's, events.js; or a
// group's, notify.js), and when someone mentions them in a post or comment, or uses @here in a group (mentions.js), on
// each device that hasn't turned mentions off. The test for anything that buzzes a phone: addressed to you, by a person.
// Never other posts, comments, friend requests or updates: afterwrd doesn't chase attention, and those wait on the
// Notifications page for whenever the owner looks. A device says yes from Events (public/static/notifications.js);
// after that it's told even while it's asleep. Each site signs its own notifications and encrypts each one for that
// device alone (webpush.js), so the push service passes it on without being able to read it.
//   POST /_push/devices          {endpoint, keys: {p256dh, auth}, name, preview}: this device says yes
//   POST /_push/devices/forget   {endpoint}: this device says no
//   POST /_push/devices/preview  {endpoint, preview}: show the event on the lock screen, or only who it's from
//   POST /_push/devices/mentions {endpoint, mentions}: mentions buzz this device too, or only events
//   POST /_push/devices/state    {endpoint}: whether this device has them on, and for mentions
//   POST /_push/devices/renew    {old, endpoint, keys}: the device's push service gave it a new address (push-sw.js)
// Each device is listed in Your devices (admin.js), where it can be turned off from anywhere; Home mentions a new one
// for 14 days, as it does a new passkey. A device goes when the passkey that was signed in when it said yes is
// removed, when that session signs out, and on "Sign out everywhere".
import { testingHere } from "./cloudflare.js";
import { fromBase64Url, html, json, now, Refusal } from "./util.js";
import { messagePage } from "./views/pages.js";
import { makeVapidKeys, pushEndpoint, sendPush } from "./webpush.js";

// The site's signing key pair. In settings, which Download everything leaves out (export.js names what it takes).
const KEY = "push_vapid";
const MAX_DEVICES = 10;
const PREVIEW = 200; // characters of what it's about on the lock screen
const NEW_DEVICE_SECONDS = 14 * 86400; // how long Home mentions a device newly turned on
// A push service that couldn't be reached, or said "later", is asked again after these (milliseconds), all within the
// half a minute a request may carry on working once it's answered.
const RETRY_MS = [2000, 8000];

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

/** A device's push address and keys (PushSubscription.toJSON()), checked: only at a known push service. */
function subscription(env, body, site) {
  const endpoint = pushEndpoint(body.endpoint, { local: testingHere(env, site) });
  if (!endpoint) throw new Refusal("That isn't a push service this site will send to.");
  const p256dh = String(body.keys?.p256dh ?? "");
  const auth = String(body.keys?.auth ?? "");
  const size = (text) => { try { return fromBase64Url(text).length; } catch { return 0; } };
  if (size(p256dh) !== 65 || size(auth) !== 16) throw new Refusal("That device's keys aren't right.");
  return { endpoint, p256dh, auth };
}

/**
 * A device saying yes: its push address and keys, what it's called, and preview. `owner` is who's signed in
 * (auth.js currentUser): the passkey and session it's tied to. `site` is this site's address.
 */
export async function addDevice(env, body, owner, site) {
  const { endpoint, p256dh, auth } = subscription(env, body, site);
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

/**
 * A device's push service gave it a new address (its service worker is told: push-sw.js pushsubscriptionchange). The
 * device carries on as it was, at the new one. Only for a device that's on here, by its old address.
 */
export async function renewDevice(env, body, site) {
  const { endpoint, p256dh, auth } = subscription(env, body, site);
  const old = String(body.old ?? "");
  const db = env.DB;
  const [, renewed] = await db.batch([
    // The new address may already be here (the page turned it on again first): the old one takes its place.
    db.prepare("DELETE FROM push_devices WHERE endpoint = ?1 AND ?1 != ?2 AND EXISTS (SELECT 1 FROM push_devices WHERE endpoint = ?2)").bind(endpoint, old),
    db.prepare("UPDATE push_devices SET endpoint = ?, p256dh = ?, auth = ? WHERE endpoint = ? RETURNING id").bind(endpoint, p256dh, auth, old),
  ]);
  if (!renewed.results.length) throw new Refusal("Notifications aren't on for this device.", 404);
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

/** Whether this device (by its push address) has notifications on here, with what preview, and for mentions too. */
export async function deviceState(env, endpoint) {
  const row = await env.DB.prepare("SELECT preview, mentions FROM push_devices WHERE endpoint = ?").bind(String(endpoint ?? "")).first();
  return row ? { on: true, preview: Boolean(row.preview), mentions: Boolean(row.mentions) } : { on: false };
}

/** Whether this device (by its push address) is told about mentions too, or only events. */
export async function setMentions(env, endpoint, on) {
  await env.DB.prepare("UPDATE push_devices SET mentions = ? WHERE endpoint = ?").bind(on ? 1 : 0, String(endpoint ?? "")).run();
  return { ok: true };
}

/**
 * @typedef {object} Notice What to tell the owner's devices.
 * @property {string} title who it's from: a friend's name, or a group's
 * @property {string} text what it's about, shown when the device has the preview on
 * @property {string} hidden what's shown instead when it hasn't (nothing the sender wrote)
 * @property {string} url the page here that a tap opens
 * @property {string} tag what it's about: a later notice with the same tag takes the earlier one's place
 * @property {"event" | "mention"} [kind] an event's (the default), or a mention, which only devices that said yes to
 *   mentions are told
 */

/**
 * Tells every one of the owner's devices with notifications on about `notice`, even while it's asleep. A push service
 * that can't be reached, or says to try later, is asked again a couple of times; a device whose address no longer
 * works (it said no, or the app was removed) is forgotten. `site` is this site's address, which push services are
 * given as who to contact about its notifications. Only ever called for events and mentions (see the top of this
 * file); a mention only to devices that said yes to those too (push_devices.mentions).
 * @param {any} env
 * @param {string} site
 * @param {Notice} notice
 */
export async function notifyDevices(env, site, notice) {
  const db = env.DB;
  const { results: all } = await db.prepare("SELECT * FROM push_devices ORDER BY id").all();
  const devices = notice.kind === "mention" ? all.filter((d) => d.mentions) : all;
  if (!devices.length) return;
  const vapid = await vapidKeys(env);
  const subject = site.startsWith("https://") ? site : "https://afterwrd.app";
  const local = testingHere(env, site);
  const words = notice.text.replace(/\s+/g, " ").trim();
  const sent = await Promise.all(devices.map((d) => sendWithRetries(d, {
    title: notice.title,
    body: d.preview ? (words.length > PREVIEW ? `${words.slice(0, PREVIEW - 1)}…` : words) : notice.hidden,
    url: notice.url,
    tag: notice.tag,
  }, { vapid, subject, local })));
  const gone = devices.filter((_, i) => sent[i].gone).map((d) => d.id);
  const ok = devices.filter((_, i) => sent[i].status >= 200 && sent[i].status < 300).map((d) => d.id);
  const marks = (list) => list.map(() => "?").join(",");
  await db.batch([
    ...(gone.length ? [db.prepare(`DELETE FROM push_devices WHERE id IN (${marks(gone)})`).bind(...gone)] : []),
    // When each device last got one, to the day.
    ...(ok.length ? [db.prepare(`UPDATE push_devices SET last_ok_at = ?1 WHERE id IN (${marks(ok)}) AND COALESCE(last_ok_at, 0) < ?1 - 86400`)
      .bind(now(), ...ok)] : []),
  ]);
}

async function sendWithRetries(device, message, options) {
  for (let i = 0; ; i += 1) {
    const result = await sendPush(device, message, options).catch(() => ({ status: 0, gone: false }));
    const again = (result.status === 0 && !result.gone) || result.status >= 500 || result.status === 429;
    if (!again || i >= RETRY_MS.length) return result;
    await new Promise((r) => setTimeout(r, RETRY_MS[i]));
  }
}

/**
 * Something `notifyDevices` is to say, after the request's been answered (`work`: its waitUntil), so the friend's or
 * group's site isn't kept waiting on push services. Failing to notify never fails what the note was for.
 */
export function notifyLater(env, site, work, notice) {
  work.waitUntil(notifyDevices(env, site, notice).catch((error) => console.error("Notifying the owner's devices failed:", error)));
}

// --- the web side: the owner's own pages only -----------------------------------------------------------------

const ROUTES = {
  "/_push/devices": (env, body, owner, url) => addDevice(env, body, owner, url.origin),
  "/_push/devices/forget": (env, body) => forgetDevice(env, body.endpoint),
  "/_push/devices/preview": (env, body) => setPreview(env, body.endpoint, body.preview === true),
  "/_push/devices/mentions": (env, body) => setMentions(env, body.endpoint, body.mentions === true),
  "/_push/devices/state": (env, body) => deviceState(env, body.endpoint),
  "/_push/devices/renew": (env, body, owner, url) => renewDevice(env, body, url.origin),
};

export async function handlePush(request, env, url, owner) {
  const act = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  if (!act || request.method !== "POST") return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
    return json(await act(env, body && typeof body === "object" ? body : {}, owner, url));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: error.message }, error.status);
    return html(messagePage(error.message, { href: "/events", label: "Back to Events" }), error.status);
  }
}
