// Small helpers shared by the sign-in and admin code.

export const now = () => Math.floor(Date.now() / 1000);

/** A reply to another site: its JSON body and HTTP status, for json(). @typedef {[object, number]} Answer */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Every signed-in page is a loader and a view (src/views/). The loader gathers what the page shows and returns it as
// plain data, which could be sent as JSON just as it is; the view turns that into HTML and does nothing else. So the
// data must never carry a key or a hash of one: these are the columns that hold them.
const SECRET_FIELDS = new Set(["their_key", "key_hash", "token_hash", "session_hash", "privateJwk", "p256dh", "refresh_token", "access_token", "auto_key", "auto_refresh"]);

/**
 * A page's data, as its loader returns it. When testing (CHECK_PAGE_DATA, which test/e2e/run.sh sets on every site)
 * it's checked first: plain values, arrays and objects only (no HTML, Maps, Responses or database handles), and no
 * secret columns, so the end-to-end tests catch a page that would leak something if its data were ever served as it is.
 */
export function pageData(env, data) {
  if (env?.CHECK_PAGE_DATA) checkPlain(data, "data");
  return data;
}

function checkPlain(value, path, seen = new Set()) {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === "string" || type === "boolean" || (type === "number" && Number.isFinite(value))) return;
  if (type !== "object") throw new Error(`Page data isn't plain at ${path} (${type})`);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkPlain(item, `${path}[${i}]`, seen));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`Page data isn't plain at ${path} (${proto?.constructor?.name})`);
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key)) throw new Error(`Page data carries a secret at ${path}.${key}`);
    checkPlain(item, `${path}.${key}`, seen);
  }
}

/**
 * An action saying no: what to tell the person, and the HTTP status. Actions (the code that changes things: a
 * comment, a post, approving a friend) take plain values and return plain results, and know nothing about forms,
 * redirects or pages; they throw a Refusal when they won't or can't. The web side around each one reads the form or
 * JSON, and turns the result into a redirect, a page or JSON, and a Refusal into its message page or {error}. So an
 * API could call the same actions. Anything else thrown is a fault, as before.
 */
export class Refusal extends Error {
  /** `more`: anything else the answer says, beside the message (as JSON: {error, ...more}). */
  constructor(message, status = 400, more = null) {
    super(message);
    this.status = status;
    this.more = more;
  }
}

/** A connection or group row without its keys, for a page. */
export const withoutKeys = (row) => {
  if (!row) return row;
  const { their_key, key_hash, ...rest } = row;
  return rest;
};

const ENTITIES ={ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };

// Same output as Jinja's escaping, so pages match the local app's.
export function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export function randomToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
