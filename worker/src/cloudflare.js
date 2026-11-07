// Connecting to Cloudflare: afterwrd asks for a one-hour token through Cloudflare's own sign-in (OAuth 2.0 with
// PKCE, as a public client: no secret) instead of a token the owner makes by hand. Used by the installer
// (installer/installer.js), the Update page (update.js) and groups (groupsites.js). Nothing is kept beyond the hour:
// the token lives in a cookie that expires with it, which only this site's own pages can use, and afterwrd never
// asks for permission to make tokens of its own.
//
// Cloudflare only sends people back to the one address registered for afterwrd, https://afterwrd.app/connect/: a
// static page (installer/connect.html) that forwards them to their own site, which is the only thing that holds the
// PKCE secret and so the only thing that can use the code. The steps, all on the person's own site:
//   GET  /_cloudflare/start?back=<path>  a fresh PKCE secret and state in a short cookie, then off to the relay page,
//                                        which sends them to Cloudflare to press Allow
//   GET  /_cloudflare/done#code=…&state=…  back from the relay: a tiny page posts the code to…
//   POST /_cloudflare/finish {code, state}  checks the state against the cookie, swaps the code for the token (sending
//                                        the PKCE secret), keeps the token in a cookie, and says where to go back to
//   POST /_cloudflare/disconnect         drops the token early
// A site in group mode serves none of this (index.js); only the owner reaches it on their own site.
import pkg from "../package.json";
import { html, json } from "./util.js";

export const CLIENT_ID = pkg.afterwrd.cloudflareClient;
export const RELAY = `https://${pkg.afterwrd.site}/connect/`;
// What Cloudflare is asked for (the relay page, installer/connect.html, sends it; keep the two the same): making,
// changing and deleting Workers (afterwrd's own, and groups'; "Workers Editor" can't make a new one, so a fresh
// install or a new group needs "Workers Admin"), making databases, and reading the account's workers.dev name.
export const SCOPES = "workers-scripts.admin d1.write account-settings.read";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
// Both cookies are host-only. (workers.dev is a public suffix, so other Workers under the same account subdomain
// count as the same site: they're all afterwrd's own, and every POST here checks Origin exactly, which is what holds.)
const START_COOKIE = "cf_connect";
const TOKEN_COOKIE = "cf_token";
const START_SECONDS = 600;
const BACK_RE = /^\/(?![/\\])[\x21-\x7e]*$/; // a path on this site (never another site), as the browser would read it
export const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,1024}$/;

/** The link that starts connecting, coming back to `back` (a path here) once it's done. */
export const connectLink = (back) => `/_cloudflare/start?back=${encodeURIComponent(back)}`;

/** The token from an earlier Connect, while it lasts; null if there isn't one. */
export function connectedToken(request) {
  const token = readCookie(request, TOKEN_COOKIE);
  return token && CODE_RE.test(token) ? token : null;
}

/** The token a step uses: one pasted by hand (the fallback), or the connected one. Throws if there's neither. */
export function tokenFor(request, body = {}) {
  const pasted = typeof body.token === "string" ? body.token.trim() : "";
  const token = pasted || connectedToken(request);
  if (!token) throw new Error("Connect Cloudflare first.");
  return token;
}

/** The connection's steps, for the paths under /_cloudflare/; null for anything else. */
export async function handleCloudflare(request, env, url) {
  const path = url.pathname.slice("/_cloudflare".length);
  if (request.method === "GET" && path === "/start") return start(request, url);
  if (request.method === "GET" && path === "/done") return html(donePage("/_cloudflare/finish"));
  if (request.method !== "POST") return null;
  if (request.headers.get("Origin") !== url.origin) return json({ error: "Request from another site" }, 403);
  if (path === "/finish") return finish(request, env, await request.json().catch(() => ({})));
  if (path === "/disconnect") return withCookie(json({ ok: true }), `${TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return null;
}

async function start(request, url) {
  // Only from this site's own pages (or typed in), never a link on another site: a connection someone else started
  // could end in the auto-run that follows it.
  const from = request.headers.get("Sec-Fetch-Site");
  if (from && from !== "same-origin" && from !== "none") return json({ error: "Start connecting from your own site." }, 403);
  const back = url.searchParams.get("back") ?? "/";
  if (!BACK_RE.test(back)) return json({ error: "Unexpected details." }, 400);
  const { verifier, state, relay } = await relayLink(`${url.origin}/_cloudflare/done`);
  // Lax, so the cookie comes along when the relay page sends the browser back here.
  return withCookie(Response.redirect(relay.toString(), 302),
    `${START_COOKIE}=${state}.${verifier}.${base64url(new TextEncoder().encode(back))}; Path=/; Max-Age=${START_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

async function finish(request, env, body) {
  const started = readCookie(request, START_COOKIE) ?? "";
  const [state, verifier, backEncoded] = started.split(".");
  const clear = `${START_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  if (!state || !verifier || !backEncoded) return withCookie(json({ error: "This connection has expired. Start again from your site." }, 400), clear);
  if (typeof body.state !== "string" || body.state !== state) return withCookie(json({ error: "That isn't the connection this site started. Start again." }, 400), clear);
  if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return withCookie(json({ error: "Cloudflare didn't send a code." }, 400), clear);
  const back = new TextDecoder().decode(fromBase64url(backEncoded));
  let data;
  try {
    data = await exchangeCode(env, body.code, verifier, new URL(request.url).origin);
  } catch (error) {
    return withCookie(json({ error: error.message }, 400), clear);
  }
  // Kept just short of the hour Cloudflare gives it, so a step never starts with a token about to expire.
  const seconds = Math.max(60, Math.min(Number(data.expires_in) || 3600, 3600) - 60);
  const done = withCookie(json({ back: BACK_RE.test(back) ? back : "/" }), clear);
  return withCookie(done, `${TOKEN_COOKIE}=${data.access_token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`);
}

/**
 * Whether test stand-ins may be used: ALLOW_LOCAL_SITES set AND this site running on this computer. A setting alone
 * isn't enough, so one added to a real site (say, by someone with access to the account) can't send Connect's codes,
 * or a check's, to an address of their choosing.
 */
export function testingHere(env, origin) {
  try {
    return env?.ALLOW_LOCAL_SITES === "1" && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * A fresh PKCE secret and state, and the relay link that sends the browser to Cloudflare and back to `to` (a
 * `/_cloudflare/done` here for full access, or `/_check/done` for a check's read-only access: the relay page picks
 * what to ask Cloudflare for from that path, so a check can never be given more).
 */
export async function relayLink(to) {
  const { verifier, state, challenge } = await pkce();
  const relay = new URL(RELAY);
  relay.searchParams.set("to", to);
  relay.searchParams.set("state", state);
  relay.searchParams.set("challenge", challenge);
  return { verifier, state, relay };
}

/** A fresh PKCE secret, its challenge (what Cloudflare is shown) and a state to match the return against. */
export async function pkce() {
  const verifier = random(48);
  const state = random(24);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, state, challenge };
}

/** Swaps Cloudflare's one-time code for the token (sending the PKCE secret); throws with a message to show. */
export async function exchangeCode(env, code, verifier, origin, redirectUri = RELAY) {
  // When testing on this computer, a stand-in for Cloudflare's token endpoint.
  const endpoint = testingHere(env, origin) && env.OAUTH_TOKEN_URL ? env.OAUTH_TOKEN_URL : TOKEN_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(`Cloudflare didn't finish connecting: ${data.error_description || data.error || `HTTP ${response.status}`}`);
  }
  if (!CODE_RE.test(data.access_token)) throw new Error("Cloudflare's token isn't in a form this site can use.");
  return data;
}

// Back from the relay: the code and state travel in the fragment (never sent to a server or kept in a log), and this
// page posts them to /finish, which can read the cookie the fragment can't.
export function donePage(finishPath) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>Connecting to Cloudflare</title>
<style>
  body { margin: 0; padding: 24px; background: #16201b; color: #ede6da; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 480px; margin: 48px auto; }
  a { color: #ffab73; }
  #error:empty { display: none; }
</style>
</head>
<body>
<main>
<p id="status">Finishing connecting to Cloudflare…</p>
<p id="error" role="alert"></p>
</main>
<script>
  (async () => {
    const params = new URLSearchParams(location.hash.slice(1));
    const status = document.getElementById("status");
    const problem = document.getElementById("error");
    history.replaceState(null, "", location.pathname); // the code is single-use, and not for the history
    if (params.get("error")) {
      status.textContent = "";
      problem.textContent = params.get("error") === "access_denied"
        ? "You didn't allow it, so nothing has changed. You can go back and try again."
        : "Cloudflare couldn't connect: " + params.get("error");
      return;
    }
    try {
      const res = await fetch(${JSON.stringify(finishPath)}, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: params.get("code"), state: params.get("state") }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      // A friend's check (checks.js) then reads the account's audit log, a page at a time.
      if (data.audit) {
        status.textContent = "Reading the account's audit log…";
        let cursor = "";
        for (let page = 1; ; page++) {
          const step = await fetch("/_check/audit", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(page > 40 ? { stop: true } : { cursor }) });
          const got = await step.json().catch(() => ({}));
          if (!step.ok) throw new Error(got.error || "Something went wrong.");
          if (got.done) break;
          cursor = got.cursor;
        }
      }
      location.replace(data.back || "/");
    } catch (err) {
      status.textContent = "";
      problem.textContent = err.message;
    }
  })();
</script>
</body>
</html>`;
}

export function withCookie(response, cookie) {
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", cookie);
  return out;
}

export function readCookie(request, name) {
  const found = (request.headers.get("Cookie") ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

export const random = (bytes) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
