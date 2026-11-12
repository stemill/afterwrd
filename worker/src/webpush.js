// Web Push: this site telling the owner's own phone or computer something, even while it's asleep. The device gave
// this site an address at its push service (Apple's, Google's, Mozilla's or Microsoft's) and two keys; the site
// encrypts the message for that device alone (RFC 8291) and signs the request with its own key (VAPID, RFC 8292),
// so the push service can only pass it on, never read it, and nobody else can send to that address. No central
// server of ours is involved: each site has its own signing key. Used for notifications about messages (push.js).
import { fromBase64Url, now, toBase64Url } from "./util.js";

const enc = new TextEncoder();
const RECORD_SIZE = 4096;
/** The most a message may be: Apple refuses pushes over 4 KB, and this leaves room for the encryption's own bytes. */
export const MAX_MESSAGE = 3000;
// Every push is padded to this, so they're all the same size (a message shows at most 200 characters).
const PADDED = 1024;

// Push services a device's address may be at. The Worker only ever sends to these, whatever it's given.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

/**
 * A device's push address if it's at a known push service (https, standard port), or null. `local` (only for a site
 * being tested on this computer: cloudflare.js testingHere) also allows http here, for a stand-in push service.
 */
export function pushEndpoint(text, { local = false } = {}) {
  try {
    const url = new URL(String(text));
    if (url.username || url.password) return null;
    if (local && url.protocol === "http:" && url.hostname === "localhost") return url.href;
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

/** A new signing key pair for this site: the public half (as devices are given it) and the private half as a JWK. */
export async function makeVapidKeys() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
  return {
    publicKey: toBase64Url(new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", pair.publicKey)))),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

/** The Authorization header for a push to `endpoint`: a JWT signed with the site's key, valid 12 hours. */
export async function vapidAuthorization(endpoint, vapid, subject, at = now()) {
  const part = (value) => toBase64Url(enc.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: at + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is already JWT's form (r and s, 32 bytes each).
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * `message` (bytes or text) encrypted for one device, as the body of a push (RFC 8291, "aes128gcm"). `p256dh` and
 * `auth` are the device's keys from its subscription. `padTo`: padded to at least that many bytes, so the push
 * service can't tell long messages from short ones. `serverKeys` and `salt` are made fresh each time; they're only
 * passed in to check this against the RFC's worked example.
 * @param {Uint8Array | string} message
 * @param {{ p256dh: string, auth: string }} keys
 * @param {{ serverKeys?: CryptoKeyPair, salt?: Uint8Array, padTo?: number }} [options]
 */
export async function encryptMessage(message, { p256dh, auth }, { serverKeys, salt, padTo = 0 } = {}) {
  const uaPublic = fromBase64Url(String(p256dh));
  const authSecret = fromBase64Url(String(auth));
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("That device's keys aren't right.");
  const plain = typeof message === "string" ? enc.encode(message) : message;
  if (plain.length > MAX_MESSAGE) throw new Error("That message is too long to send.");
  serverKeys ??= /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  salt ??= crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", serverKeys.publicKey)));

  const device = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Cloudflare's type descriptions call it "$public"; the runtime, like the standard, wants "public".
  const shared = await crypto.subtle.deriveBits(/** @type {any} */ ({ name: "ECDH", public: device }), serverKeys.privateKey, 256);
  const ikm = await hkdf(authSecret, shared, join(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the message, the delimiter 2, then zeros to pad it (RFC 8188).
  const padding = new Uint8Array(Math.max(0, padTo - plain.length - 1));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, join(plain, [2], padding)));

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return join(header, sealed);
}

/**
 * Sends `message` (an object, as JSON) to one device. Returns { status, gone, detail }: `gone` when the push service
 * says the address no longer works (the person turned notifications off or removed the app), so it can be forgotten.
 */
export async function sendPush(device, message, { vapid, subject, urgency = "high", ttl = 24 * 3600, local = false }) {
  const endpoint = pushEndpoint(device.endpoint, { local });
  if (!endpoint) return { status: 0, gone: true, detail: "not a push service" };
  const body = await encryptMessage(JSON.stringify(message), device, { padTo: PADDED });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
  return { status: res.status, gone: res.status === 404 || res.status === 410, detail };
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
