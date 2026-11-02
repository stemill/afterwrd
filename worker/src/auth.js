// Passkey sign-in. scripts/invite.mjs creates a person and a one-time invite link; opening the link lets them
// register a passkey on their device, which they then use to sign in. Nothing here needs a password or email.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { invitePage, loginPage, messagePage } from "./pages.js";
import { fromBase64Url, html, json, now, randomToken, sha256, toBase64Url } from "./util.js";

const SESSION_COOKIE = "hb_session";
const CHALLENGE_COOKIE = "hb_challenge";
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
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  try {
    if (route === "GET /_auth/login") return html(loginPage(safeNext(url.searchParams.get("next"))));
    if (route === "GET /_auth/logout") return logout(request, env);
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
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return new Response("Not found", { status: 404 });
}

// --- registration (from an invite) -----------------------------------------

async function registerOptions(env, url, { token }) {
  const invite = await findInvite(env, token);
  if (!invite) return json({ error: "This invite has expired or has already been used." }, 400);
  const { results: existing } = await env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
    .bind(invite.user_id).all();
  const options = await generateRegistrationOptions({
    rpName: "heybert",
    rpID: url.hostname,
    userName: invite.name,
    userID: new TextEncoder().encode(String(invite.user_id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return withChallenge(env, options.challenge, json(options));
}

async function registerVerify(request, env, url, { token, response }) {
  const invite = await findInvite(env, token);
  const challenge = await takeChallenge(request, env);
  if (!invite || !challenge) return json({ error: "This invite has expired or the request timed out." }, 400);
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
  });
  if (!verified) return json({ error: "The passkey couldn't be verified." }, 400);

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
  return withChallenge(env, options.challenge, json(options));
}

async function loginVerify(request, env, url, { response }) {
  const challenge = await takeChallenge(request, env);
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
  if (!verified) return json({ error: "The passkey couldn't be verified." }, 400);
  await env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(authenticationInfo.newCounter, now(), stored.id).run();
  return startSession(env, stored.user_id, json({ ok: true }));
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  const response = html(messagePage("You've signed out.", { href: "/_auth/login", label: "Sign in again" }));
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return response;
}

// --- storage ---------------------------------------------------------------

async function findInvite(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT i.token_hash, u.id AS user_id, u.name FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND u.revoked_at IS NULL`,
  ).bind(await sha256(String(token)), now()).first();
}

async function withChallenge(env, challenge, response) {
  const id = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO challenges (id, challenge, expires_at) VALUES (?, ?, ?)")
      .bind(id, challenge, now() + CHALLENGE_SECONDS),
  ]);
  response.headers.append("Set-Cookie",
    `${CHALLENGE_COOKIE}=${id}; Path=/_auth/; Max-Age=${CHALLENGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

// Each challenge works once: it's deleted as it's read.
async function takeChallenge(request, env) {
  const id = readCookie(request, CHALLENGE_COOKIE);
  if (!id) return null;
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ? AND expires_at > ? RETURNING challenge")
    .bind(id, now()).first();
  return row?.challenge ?? null;
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

function safeNext(next) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/_auth/") ? next : "/";
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
