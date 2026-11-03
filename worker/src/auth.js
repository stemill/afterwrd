// Passkey sign-in. The owner's People page (or scripts/invite.mjs) creates a person and a one-time invite link;
// opening the link lets them register a passkey on their device, which they then use to sign in. Nothing here
// needs a password or email.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { createInvite, OWNER_INVITE_SECONDS } from "./admin.js";
import { friendPage, invitePage, loginPage, messagePage, setupPage, signOutPage } from "./pages.js";
import { fromBase64Url, html, json, now, randomToken, sha256, toBase64Url } from "./util.js";

// __Host- cookies can only be set by this exact site, over HTTPS, for the whole site.
const SESSION_COOKIE = "__Host-hb_session";
const CHALLENGE_COOKIE = "__Host-hb_challenge";
const SESSION_SECONDS = 30 * 24 * 3600;
const CHALLENGE_SECONDS = 5 * 60;

export async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.revoked_at IS NULL`,
  ).bind(await sha256(token), now()).first();
}

export async function handleAuth(request, env, url) {
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Request from another site" }, 403);
  }
  const route = `${request.method} ${url.pathname}`;
  const body = request.method === "POST" && request.headers.get("Content-Type")?.startsWith("application/json")
    ? await request.json().catch(() => ({}))
    : {};
  try {
    if (route === "GET /_auth/login") return html(loginPage(safeNext(url.searchParams.get("next"), url)));
    // Signing out is a form post, so another site can't sign people out by linking here.
    if (route === "GET /_auth/logout") return html(signOutPage());
    if (route === "POST /_auth/logout") return await logout(request, env);
    if (route === "GET /_auth/setup" || route === "POST /_auth/setup") return await setup(request, env, url, body);
    if (request.method === "GET" && url.pathname.startsWith("/_auth/invite/")) {
      const invite = await findInvite(env, url.pathname.slice("/_auth/invite/".length));
      return invite
        ? html(invitePage(invite.name))
        : html(messagePage("This invite has expired or has already been used. Ask for a new one."), 404);
    }
    // `return await` so a rejected verification lands in the catch below.
    if (route === "POST /_auth/register/options") return await registerOptions(env, url, body);
    if (route === "POST /_auth/register/verify") return await registerVerify(request, env, url, body);
    if (route === "POST /_auth/login/options") return await loginOptions(env, url);
    if (route === "POST /_auth/login/verify") return await loginVerify(request, env, url, body);
    if (route === "GET /_auth/friend") return await friendWelcome(env, url);
    if (route === "POST /_auth/friend") return await friendSignIn(env, url, body);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return new Response("Not found", { status: 404 });
}

// --- first-run setup (from the installer) ------------------------------------

// The installer deploys afterwrd with a one-time SETUP_CODE and sends its owner to /_auth/setup?code=…. Until
// someone has a passkey, that link makes (or remakes) the owner's invite, so an abandoned setup can be finished
// later. Once any passkey exists it does nothing.
async function setup(request, env, url, body) {
  const code = request.method === "POST" ? String(body.code ?? "") : url.searchParams.get("code") ?? "";
  if (!env.SETUP_CODE || (await sha256(code)) !== (await sha256(env.SETUP_CODE))) {
    return html(messagePage("This setup link isn't valid."), 403);
  }
  if (await env.DB.prepare("SELECT 1 FROM credentials LIMIT 1").first()) {
    return html(messagePage("This site is already set up. Sign in with your passkey."), 409);
  }
  if (request.method === "GET") return html(setupPage());

  const name = String(body.name ?? "").trim().slice(0, 100);
  if (!name) return json({ error: "Give your name." }, 400);
  let owner = await env.DB.prepare("SELECT id FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1").first();
  if (owner) {
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, owner.id).run();
  } else {
    // Only creates the owner while there's still no one, so two setups racing can't both succeed.
    owner = await env.DB.prepare(`INSERT INTO users (name, is_owner, created_at)
      SELECT ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`).bind(name, now()).first();
    if (!owner) return json({ error: "This site is already set up." }, 409);
  }
  return json({ link: await createInvite(env, url, owner.id, OWNER_INVITE_SECONDS) });
}

// --- registration (from an invite) -----------------------------------------

async function registerOptions(env, url, { token }) {
  const invite = await findInvite(env, token);
  if (!invite) return json({ error: "This invite has expired or has already been used." }, 400);
  const { results: existing } = await env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
    .bind(invite.user_id).all();
  const options = await generateRegistrationOptions({
    rpName: "afterwrd",
    rpID: url.hostname,
    userName: invite.name,
    userID: new TextEncoder().encode(String(invite.user_id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return withChallenge(env, "register", options.challenge, json(options));
}

async function registerVerify(request, env, url, { token, response }) {
  const invite = await findInvite(env, token);
  const challenge = await readChallenge(request, env, "register");
  if (!invite || !challenge) return json({ error: "This invite has expired or the request timed out." }, 400);
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
  });
  if (!verified || !(await spendChallenge(env, challenge))) return json({ error: "The passkey couldn't be verified." }, 400);

  // Spend the invite before storing the passkey, so two registrations racing on one link can't both succeed.
  const spent = await env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(now(), invite.token_hash).run();
  if (!spent.meta.changes) return json({ error: "This invite has already been used." }, 400);

  const { credential } = registrationInfo;
  await env.DB.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(credential.id, invite.user_id, toBase64Url(credential.publicKey), credential.counter,
    JSON.stringify(credential.transports ?? []), now(), now()).run();
  return startSession(env, invite.user_id, json({ ok: true }));
}

// --- sign-in ---------------------------------------------------------------

async function loginOptions(env, url) {
  const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "preferred" });
  return withChallenge(env, "login", options.challenge, json(options));
}

async function loginVerify(request, env, url, { response }) {
  const challenge = await readChallenge(request, env, "login");
  if (!challenge) return json({ error: "The request timed out. Try again." }, 400);
  const stored = await env.DB.prepare(
    "SELECT c.* FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.revoked_at IS NULL",
  ).bind(String(response?.id)).first();
  if (!stored) return json({ error: "That passkey isn't recognised here." }, 400);

  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    credential: {
      id: stored.id,
      publicKey: fromBase64Url(stored.public_key),
      counter: stored.counter,
      transports: JSON.parse(stored.transports),
    },
  });
  if (!verified || !(await spendChallenge(env, challenge))) return json({ error: "The passkey couldn't be verified." }, 400);
  await env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(authenticationInfo.newCounter, now(), stored.id).run();
  return startSession(env, stored.user_id, json({ ok: true }));
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  const response = html(messagePage("You've signed out.", { href: "/_auth/login", label: "Sign in again" }));
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  // Photos are cached for a long time; on a shared computer they shouldn't outlive the session.
  response.headers.set("Clear-Site-Data", '"cache", "cookies"');
  return response;
}

// --- challenges ----------------------------------------------------------------

// A WebAuthn challenge travels in a signed cookie rather than the database, so strangers asking to sign in
// cost nothing but a request. It's recorded only once a passkey has verified against it, which makes each
// challenge single-use without letting anonymous requests write to the database.

async function withChallenge(env, purpose, challenge, response) {
  const expires = now() + CHALLENGE_SECONDS;
  const value = `${challenge}.${expires}.${await sign(env, `${purpose}.${challenge}.${expires}`)}`;
  response.headers.append("Set-Cookie",
    `${CHALLENGE_COOKIE}=${value}; Path=/; Max-Age=${CHALLENGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

async function readChallenge(request, env, purpose) {
  const [challenge, expires, mac] = (readCookie(request, CHALLENGE_COOKIE) ?? "").split(".");
  if (!challenge || !mac || !(Number(expires) > now())) return null;
  return (await verify(env, `${purpose}.${challenge}.${expires}`, mac)) ? challenge : null;
}

/** Records a challenge as used; false if it already was (a replay). */
async function spendChallenge(env, challenge) {
  const [, recorded] = await env.DB.batch([
    env.DB.prepare("DELETE FROM used_challenges WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT OR IGNORE INTO used_challenges (challenge, expires_at) VALUES (?, ?)")
      .bind(challenge, now() + CHALLENGE_SECONDS),
  ]);
  return recorded.meta.changes === 1;
}

let signingKey = null;

// One random key per site, made on first use and kept in the settings table.
async function key(env) {
  if (!signingKey) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('challenge_key', ?)").bind(randomToken()).run();
    const { value } = await env.DB.prepare("SELECT value FROM settings WHERE key = 'challenge_key'").first();
    signingKey = await crypto.subtle.importKey("raw", fromBase64Url(value), { name: "HMAC", hash: "SHA-256" }, false,
      ["sign", "verify"]);
  }
  return signingKey;
}

async function sign(env, text) {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(text))));
}

async function verify(env, text, mac) {
  try {
    return await crypto.subtle.verify("HMAC", await key(env), fromBase64Url(mac), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

// --- storage ---------------------------------------------------------------

async function findInvite(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT i.token_hash, u.id AS user_id, u.name FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND u.revoked_at IS NULL`,
  ).bind(await sha256(String(token)), now()).first();
}

// --- connected friends --------------------------------------------------------------------------------------

// A connected friend's own site asks for a one-time pass (peers.js, POST /_peer/ticket) and sends them here with it.
// They're a person here like anyone invited, marked with their site; disconnecting revokes them (connect.js).
const TICKET_GONE = "This link has expired or has been used. Go back to your own site and try again.";

async function friendWelcome(env, url) {
  const ticket = await env.DB.prepare(`SELECT c.name FROM friend_tickets t JOIN connections c ON c.id = t.connection_id
    WHERE t.token_hash = ? AND t.expires_at > ? AND c.connected_at IS NOT NULL`)
    .bind(await sha256(url.searchParams.get("ticket") ?? ""), now()).first();
  if (!ticket) return html(messagePage(TICKET_GONE), 404);
  const owner = await env.DB.prepare("SELECT name FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1").first();
  return html(friendPage(ticket.name, owner?.name ?? "this"));
}

async function friendSignIn(env, url, body) {
  const db = env.DB;
  const ticket = await db.prepare("DELETE FROM friend_tickets WHERE token_hash = ? AND expires_at > ? RETURNING connection_id, next")
    .bind(await sha256(String(body.ticket ?? "")), now()).first();
  if (!ticket) return json({ error: TICKET_GONE }, 400);
  const connection = await db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL").bind(ticket.connection_id).first();
  if (!connection) return json({ error: "Your sites aren't connected any more." }, 403);
  let user = await db.prepare("SELECT id FROM users WHERE site = ? ORDER BY id LIMIT 1").bind(connection.origin).first();
  if (user) {
    await db.prepare("UPDATE users SET name = ?, revoked_at = NULL WHERE id = ?").bind(connection.name, user.id).run();
  } else {
    user = await db.prepare("INSERT INTO users (name, created_at, site) VALUES (?, ?, ?) RETURNING id")
      .bind(connection.name, now(), connection.origin).first();
  }
  return startSession(env, user.id, json({ ok: true, next: safeNext(ticket.next, url) }));
}

async function startSession(env, userId, response) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), userId, now() + SESSION_SECONDS),
  ]);
  response.headers.append("Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
  return response;
}

// --- helpers ---------------------------------------------------------------

// Only a path on this site, resolved the way the browser will resolve it: "/\evil.example" and "/\t/evil.example"
// both look like paths but take browsers to another site.
export function safeNext(next, url) {
  if (!next) return "/";
  let target;
  try {
    target = new URL(next, url.origin);
  } catch {
    return "/";
  }
  if (target.origin !== url.origin || target.pathname.startsWith("/_auth/")) return "/";
  return target.pathname + target.search + target.hash;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return null;
}
