// afterwrd's installer at https://install.afterwrd.app: installs afterwrd into someone's own Cloudflare account from
// any browser, a phone's included, with no code editor and no Deploy page. It runs in Ste's Cloudflare account and is
// deployed by hand (`npx wrangler deploy -c central/wrangler.jsonc`), never from GitHub, so no Cloudflare credential
// is kept there. It has no storage of its own.
//
//   GET  /             the page: a Cloudflare account, Connect, then the steps with their progress
//   GET  /connect      a fresh PKCE secret in a short cookie, then off to Cloudflare to press Allow (afterwrd.app's
//                      Install button comes straight here, so people who start there skip this site's first page)
//   GET  /done         back from Cloudflare (registered on the OAuth client as a redirect address): swaps the code for
//                      an hour's token, kept only in a cookie in the person's own browser, never stored here
//   POST /step/<name>  one step at a time with that token: accounts, name (a workers.dev name, for a new account),
//                      check, assets, deploy; then finish, which drops the token
//
// What it installs is the latest release, every file checked against the release's manifest (src/deploy.js). Revoking
// in Cloudflare doesn't end a token already given, so the hour is the real limit: "Check your install"
// (afterwrd.app/check/) and a friend's check (src/checks.js) are the second key.
import pkg from "../package.json";
import { CLIENT_ID, CODE_RE, exchangeCode, pkce, readCookie, SCOPES, testingHere } from "../src/cloudflare.js";
import { api, databaseInUse, deployVersion, findOrCreateDatabase, loadRelease, uploadAssets, useApiBase,
  workerSettings } from "../src/deploy.js";

const REPO = pkg.afterwrd.releases;
const HOME = "https://install.afterwrd.app";
const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const START = "__Host-install_start";
const TOKEN = "__Host-install_token";
const ERRORS = {
  denied: "You didn't allow it, so nothing was installed.",
  expired: "That connection expired or wasn't started here. Connect again.",
  failed: "Cloudflare didn't finish connecting. Connect again.",
};
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const testing = testingHere(env, url.origin);
    // When testing on this computer only: stand-ins for Cloudflare's API and GitHub's releases.
    useApiBase(testing ? env.CLOUDFLARE_API_URL : null);
    const here = { url, env, testing, home: testing ? url.origin : HOME };
    let response;
    try {
      response = await route(request, here);
    } catch (error) {
      response = Response.json({ error: error.message }, { status: 400 });
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(headersFor(here))) if (!headers.has(name)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },
};

function headersFor({ testing, env }) {
  // The page fetches nothing but this site, and the new site's address (to see when it's started).
  const sites = testing && env.TEST_SITE_URL ? env.TEST_SITE_URL : "https://*.workers.dev";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; connect-src 'self' ${sites}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

async function route(request, here) {
  const { url } = here;
  if (url.protocol === "http:" && !here.testing) return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(page(Boolean(readCookie(request, TOKEN)), url.searchParams.get("go") === "1", ERRORS[url.searchParams.get("error")] ?? null),
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method === "GET" && url.pathname === "/connect") return connect(request, here);
  if (request.method === "GET" && url.pathname === "/done") return done(request, here);
  const step = /^\/step\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (request.method === "POST" && step && Object.hasOwn(STEPS, step)) {
    if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Request from another site" }, { status: 403 });
    if (step === "finish") return withCookie(Response.json({ ok: true }), clear(TOKEN, "Strict"));
    const token = readCookie(request, TOKEN);
    if (!token || !CODE_RE.test(token)) return Response.json({ error: "Your Cloudflare connection has ended. Connect again." }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    return Response.json(await STEPS[step](token, body, here));
  }
  return new Response("Not found", { status: 404 });
}

// --- connecting ----------------------------------------------------------------------------------------------------

async function connect(request, { home }) {
  // Only from this page, afterwrd.app's Install button (the same site: afterwrd.app and its subdomains, which are
  // all afterwrd's), or typed in. A connection started from anywhere else would end in the steps running by themselves.
  const from = request.headers.get("Sec-Fetch-Site");
  if (from && !["same-origin", "same-site", "none"].includes(from)) return new Response("Start from install.afterwrd.app.", { status: 403 });
  const { verifier, state, challenge } = await pkce();
  const auth = new URL(AUTHORIZE);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", CLIENT_ID);
  auth.searchParams.set("redirect_uri", `${home}/done`);
  auth.searchParams.set("scope", SCOPES);
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  // Lax, so it comes back with the browser from Cloudflare.
  return withCookie(Response.redirect(auth.toString(), 302), `${START}=${state}.${verifier}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
}

async function done(request, { url, env, home }) {
  const [state, verifier] = (readCookie(request, START) ?? "").split(".");
  // Only a word goes in the address, and the page shows fixed words for it: a link can't make this page say anything else.
  const back = (error) => withCookie(Response.redirect(`${url.origin}/?error=${error}`, 303), clear(START, "Lax"));
  if (url.searchParams.get("error")) {
    return back(url.searchParams.get("error") === "access_denied" ? "denied" : "failed");
  }
  if (!state || !verifier || url.searchParams.get("state") !== state) return back("expired");
  const code = url.searchParams.get("code") ?? "";
  if (!CODE_RE.test(code)) return back("failed");
  let data;
  try {
    data = await exchangeCode(env, code, verifier, url.origin, `${home}/done`);
  } catch {
    return back("failed");
  }
  const seconds = Math.max(60, Math.min(Number(data.expires_in) || 3600, 3600) - 60);
  // On from here with a page of our own rather than a redirect: the browser arrived from Cloudflare's site, so a
  // redirect would count as coming from there and the token's cookie (SameSite=Strict, so that a link on another site
  // can never set the steps running) wouldn't be sent. Moving on from this page counts as coming from here.
  const ready = withCookie(new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connected</title><style>body{margin:0;padding:24px;background:#16201b;color:#ede6da;font:16px/1.5 system-ui,sans-serif}a{color:#ffab73}</style>
<p>Connected to Cloudflare. <a id="on" href="/?go=1">Carry on installing</a></p>
<script>location.replace("/?go=1");</script>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }), clear(START, "Lax"));
  return withCookie(ready, `${TOKEN}=${data.access_token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`);
}

// --- the steps -----------------------------------------------------------------------------------------------------

const accountId = (id) => {
  if (!/^[0-9a-f]{32}$/.test(String(id ?? ""))) throw new Error("That isn't a Cloudflare account.");
  return id;
};
const siteName = (name) => {
  const clean = String(name ?? "").trim().toLowerCase();
  if (!NAME_RE.test(clean)) throw new Error("Your site's name can use lowercase letters, numbers and hyphens (not at the start or end).");
  return clean;
};
const releases = ({ testing, env }) => (testing && env.RELEASES_ROOT) || `https://github.com/${REPO}/releases`;

/** The account's workers.dev name (the part between a site's name and workers.dev), or null if it hasn't one yet. */
async function workersDev(token, account) {
  try {
    const name = (await api(token, `/accounts/${account}/workers/subdomain`))?.subdomain;
    if (typeof name !== "string" || !name) throw new Error("Cloudflare gave an unexpected answer about this account's workers.dev name.");
    return name;
  } catch (error) {
    // Only Cloudflare saying there isn't one counts as none: anything else (busy, down, unexpected) stops here, so a
    // hiccup can never lead to renaming a name that exists, which would move every site in the account.
    if (error.status === 404) return null;
    throw new Error(`Couldn't read this account's workers.dev name: ${error.message.replace(/^Cloudflare said: /, "")} Try again.`);
  }
}

async function ownAccount(token, id) {
  accountId(id);
  if (!(await api(token, "/accounts")).some((a) => a.id === id)) throw new Error("That account isn't one you allowed.");
  return id;
}

const STEPS = {
  // The accounts the person allowed, and whether each has a workers.dev name yet.
  async accounts(token) {
    const list = (await api(token, "/accounts")).slice(0, 10);
    return { accounts: await Promise.all(list.map(async (a) => ({ id: a.id, name: String(a.name ?? "").slice(0, 100), domain: await workersDev(token, a.id) }))) };
  },

  // A brand-new account's workers.dev name, which every site in it lives under.
  async name(token, { account, domain }) {
    await ownAccount(token, account);
    const clean = String(domain ?? "").trim().toLowerCase();
    if (!NAME_RE.test(clean)) throw new Error("That name can use lowercase letters, numbers and hyphens (not at the start or end).");
    if (await workersDev(token, account)) throw new Error("This account already has a workers.dev name.");
    await api(token, `/accounts/${account}/workers/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain: clean }) })
      .catch((error) => { throw new Error(`Cloudflare wouldn't give you afterwrd.${clean}.workers.dev `
        + `(${error.message.replace(/^Cloudflare said: /, "").replace(/\.$/, "")}). Someone may have it already: try another, perhaps with a number on the end.`); });
    return { domain: clean };
  },

  // Everything that would stop the install, before anything is uploaded; and which release it'll be. The site is
  // called afterwrd unless that's taken in this account, when the page asks for another name (`taken` says why).
  async check(token, { account, name }, here) {
    await ownAccount(token, account);
    const site = siteName(name);
    const domain = await workersDev(token, account);
    if (!domain) throw new Error("This account needs a workers.dev name first.");
    const leftover = "(If it's left over from an earlier try and you don't need it, you could instead delete it in Cloudflare, ";
    if (await workerSettings(token, account, site)) {
      return { taken: `There's already a site called "${site}" in this Cloudflare account. Choose another name for this one. `
        + `${leftover}under Workers & Pages, and keep this name.)` };
    }
    if ((await databaseInUse(token, account, site))?.tables) {
      return { taken: `There's already a database called "${site}" with things in it in this Cloudflare account, probably from `
        + `an earlier afterwrd. Choose another name for this site. ${leftover}under Storage & databases → D1, and keep this name.)` };
    }
    return { version: await latestVersion(here), site: siteAddress(here, site, domain) };
  },

  async assets(token, { account, name, version }, here) {
    await ownAccount(token, account);
    return { jwt: await uploadAssets(token, account, siteName(name), await release(here, version)) };
  },

  async deploy(token, { account, name, version, jwt }, here) {
    await ownAccount(token, account);
    const site = siteName(name);
    const domain = await workersDev(token, account);
    if (!domain) throw new Error("This account needs a workers.dev name first.");
    if (await workerSettings(token, account, site)) throw new Error(`There's already a Worker called "${site}" in this Cloudflare account.`);
    if (typeof jwt !== "string" || !jwt) throw new Error("The site files weren't uploaded. Try again.");
    const database = await findOrCreateDatabase(token, account, site);
    const setupCode = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await deployVersion(token, account, site, await release(here, version), { jwt, databaseId: database.uuid, settings: {}, secrets: { SETUP_CODE: setupCode } });
    // A Worker made through the API isn't on its workers.dev address until it's switched on.
    await api(token, `/accounts/${account}/workers/scripts/${site}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }) });
    const address = siteAddress(here, site, domain);
    return { site: address, next: `${address}/_auth/setup?code=${setupCode}` };
  },

  finish() {}, // handled in route: drops the token
};

// The latest release only: the version comes back from the page, so it's checked against GitHub's latest again.
async function latestVersion(here) {
  const latest = await fetch(`${releases(here)}/latest/download/manifest.json`, { headers: { "User-Agent": "afterwrd" } });
  const version = latest.ok ? (await latest.json().catch(() => ({}))).version : null;
  if (!VERSION_RE.test(version ?? "")) throw new Error("Couldn't find afterwrd's latest release on GitHub. Try again in a minute.");
  return version;
}

async function release(here, version) {
  if (!VERSION_RE.test(String(version ?? "")) || version !== await latestVersion(here)) throw new Error("A newer afterwrd has just come out. Start again.");
  return loadRelease(`${releases(here)}/download/v${version}`);
}

// The new site's address; when testing, a stand-in on this computer.
const siteAddress = ({ testing, env }, name, domain) => (testing && env.TEST_SITE_URL) || `https://${name}.${domain}.workers.dev`;

const withCookie = (response, cookie) => {
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", cookie);
  return out;
};
const clear = (name, sameSite) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;

// --- the page ------------------------------------------------------------------------------------------------------

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(connected, go, error) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install afterwrd</title>
<link rel="icon" href="data:,">
<style>
  :root { --bg: #16201b; --surface: #1f2b25; --raised: #263329; --sunken: #121a16; --text: #ede6da; --muted: #a9a092;
          --border: #2e3d35; --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; --moss: #8fbf7f;
          --round: ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 520px; margin: 16px auto; background: var(--surface); border-radius: 24px; padding: 24px; }
  .brand { display: flex; align-items: center; font: 900 1.35rem/1 var(--round); margin: 0 0 18px; letter-spacing: -0.02em; }
  .brand .o { width: 0.82em; height: 0.82em; color: var(--accent); margin: 0 0.02em; }
  h1 { font: 900 1.7rem/1.2 var(--round); margin: 0 0 8px; letter-spacing: -0.015em; }
  h2 { font: 800 1.05rem/1.3 var(--round); margin: 18px 0 4px; }
  p { margin: 8px 0; }
  a { color: var(--accent-strong); }
  .meta { color: var(--muted); font-size: 0.9rem; }
  .button, button { display: block; width: 100%; min-height: 3rem; margin-top: 12px; padding: 12px 18px; border: 0; border-radius: 999px;
    background: var(--text); color: var(--on-accent); font: inherit; font-weight: 800; text-align: center; text-decoration: none; cursor: pointer; }
  .button.secondary, button.secondary { background: var(--raised); color: var(--text); }
  button.linkish { display: inline; width: auto; min-height: 0; margin: 0; padding: 0; background: none; color: var(--accent-strong);
    font-weight: 400; font-size: 0.9rem; text-decoration: underline; border-radius: 0; }
  button:disabled { opacity: 0.6; cursor: default; }
  .field { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 8px 0; }
  input[type=text] { flex: 1 1 8em; min-width: 0; font: inherit; font-weight: 700; padding: 10px 16px; border: 1px solid var(--border);
    border-radius: 999px; background: var(--sunken); color: var(--text); }
  .suffix, .address-preview { color: var(--muted); word-break: break-all; }
  .address-preview { color: var(--text); }
  label.account { display: flex; gap: 10px; align-items: center; padding: 10px 14px; margin: 6px 0; border-radius: 16px; background: var(--raised); }
  [hidden] { display: none !important; }
  #log { list-style: none; padding: 0; margin: 16px 0 0; }
  #log li { position: relative; padding-left: 26px; margin: 4px 0; color: var(--muted); }
  #log li::before { content: ""; position: absolute; left: 4px; top: 0.6em; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  #log li.done { color: var(--text); }
  #log li.done::before { content: "✓"; background: none; color: var(--moss); top: 0; left: 2px; width: auto; height: auto; font-weight: 800; }
  #error { color: #ff8070; }
  #error:empty { display: none; }
  .ready { border-top: 1px solid var(--border); margin-top: 18px; padding-top: 8px; }
  .foot { margin-top: 22px; }
</style>
</head>
<body>
<main>
<p class="brand" aria-label="afterwrd">afterw<svg class="o" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-4.7 14.5L3.8 20l1.2-3.6A8 8 0 0 1 12 4z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>rd</p>
<h1>Install afterwrd</h1>
<p id="invited" class="meta" hidden>A friend invited you: once your site is ready, you'll be friends in one step.</p>

<section id="start"${connected && go ? " hidden" : ""}>
  <p>Your own afterwrd site, in your own free Cloudflare account. It takes a few minutes, and works on a phone.</p>
  <h2>1. A Cloudflare account</h2>
  <p class="meta">Make one first, and stay signed in in this browser. An email address is all it asks for; don't add a card.
  Cloudflare emails you a link to confirm your address: open it, then come back to this page. If you already use
  Cloudflare for other things, make a new account just for afterwrd.</p>
  <a class="button secondary" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">Make a free Cloudflare account</a>
  <h2>2. Connect Cloudflare</h2>
  <p class="meta">Cloudflare asks you to allow afterwrd to make and change Workers and databases in your account, for an
  hour, so it can install your site. Nothing is kept afterwards.</p>
  <a class="button" id="connect" href="/connect">Connect Cloudflare and install</a>
</section>

<section id="choose" hidden>
  <h2>Which Cloudflare account?</h2>
  <div id="accounts"></div>
  <button id="use-account">Install here</button>
</section>

<section id="naming" hidden>
  <h2>Your name</h2>
  <p class="meta">As your friends will see it.</p>
  <p class="field"><input type="text" id="person" placeholder="e.g. Sam Taylor" autocomplete="name" autocapitalize="words" maxlength="100" aria-label="Your name"></p>
  <div id="new-address" hidden>
    <p class="meta">Your site will be at <b class="address-preview">afterwrd.<span id="preview">your-name</span>.workers.dev</b>.
    It's how friends' sites find you, so it can't be changed later.</p>
    <div id="address-box" hidden>
      <p class="meta">Choose the middle part: lowercase letters, numbers and hyphens.</p>
      <p class="field"><input type="text" id="domain" placeholder="your-name" autocomplete="off" spellcheck="false" autocapitalize="none" aria-label="Your address"></p>
    </div>
    <button type="button" id="change-address" class="linkish">Use a different address</button>
  </div>
  <p class="meta" id="old-address" hidden>Your site will be at <b class="address-preview"></b>.</p>
  <button id="use-person">Carry on</button>
</section>

<section id="renaming" hidden>
  <h2>Another name for this site</h2>
  <p class="meta" id="taken"></p>
  <p class="field"><input type="text" id="name" autocomplete="off" spellcheck="false" autocapitalize="none" aria-label="Your site's name"></p>
  <button id="use-name">Use this name</button>
</section>

<ol id="log"></ol>
<p id="error" role="alert">${error ? escapeHtml(error) : ""}</p>
<button id="again" class="secondary" hidden>Try again</button>

<section id="ready" class="ready" hidden>
  <h2>Your site is ready</h2>
  <p>It's at <b id="address"></b>. Taking you there to make yourself its owner, with a passkey (your face, fingerprint or phone PIN).</p>
  <a class="button" id="continue" href="/">Set up my site</a>
</section>

<p class="meta foot">This installer is part of afterwrd and its code is public:
<a href="https://github.com/${REPO}">github.com/${REPO}</a>. Prefer not to use it? <a href="https://afterwrd.app/#by-hand">Install
with Cloudflare's own Deploy page instead</a>. <a href="https://afterwrd.app/how-it-works/">How it works</a>.</p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const logList = $("log");
  const tick = (li) => { if (li) { li.classList.add("done"); li.textContent = li.textContent.replace(/…$/, ""); } };
  const log = (text) => { tick(logList.lastElementChild); const li = document.createElement("li"); li.textContent = text; logList.append(li); };
  async function step(name, body = {}) {
    const res = await fetch("/step/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const waitFor = (button) => new Promise((resolve) => button.addEventListener("click", resolve, { once: true }));
  // A friend's link, brought from their site after the # (so it never reaches this installer's server): kept in this
  // browser (for a day, so it survives going off to make a Cloudflare account and coming back in another tab), and
  // handed on to the new site the same way, which opens "Add … as a friend?" once its owner has a passkey.
  const INVITE_RE = /^(https:\\/\\/[a-z0-9-]+\\.[a-z0-9-]+\\.workers\\.dev|http:\\/\\/localhost:\\d+)\\/_connect\\/[\\w-]{40,100}$/;
  const KEPT = "afterwrd-invite";
  const brought = new URLSearchParams(location.hash.slice(1));
  try {
    if (INVITE_RE.test(brought.get("invite") ?? "")) {
      localStorage.setItem(KEPT, JSON.stringify({ link: brought.get("invite"), name: (brought.get("name") ?? "").slice(0, 100), at: Date.now() }));
    }
  } catch {}
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  let invite = null;
  let invitedAs = "";
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT) || "null");
    if (kept && Date.now() - kept.at < 86400000 && INVITE_RE.test(kept.link)) { invite = kept.link; invitedAs = String(kept.name || ""); }
    else localStorage.removeItem(KEPT);
  } catch {}
  if (invite) $("invited").hidden = false;
  // An address to suggest, from the name the friend invited them by ("Bob Smith" → "bob-smith").
  // Names are tidied as they're typed, so "Pauline Millington" becomes pauline-millington rather than an error: accents
  // dropped, anything else that isn't a letter or number turned into a hyphen. A hyphen can end the box while typing
  // (the space before a surname), and finished() takes it off when the name is used.
  const tidy = (text) => text.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 63);
  const finished = (text) => tidy(text).replace(/-+$/, "");
  // The site is called afterwrd (its address afterwrd.<their name>.workers.dev), unless that's taken in the account.
  let name = "afterwrd";
  const preview = () => { $("preview").textContent = finished($("domain").value) || "your-name"; };
  for (const id of ["domain", "name"]) {
    $(id).addEventListener("input", () => {
      const box = $(id);
      const tidied = tidy(box.value);
      if (tidied !== box.value) box.value = tidied;
      if (id === "domain") { addressTouched = true; preview(); }
    });
  }
  // Their name, asked once: it fills in the address (until they change the address themselves), and goes on to the
  // new site's setup page, after the #, so that page has it ready. Starts as the name a friend invited them by.
  let addressTouched = false;
  const fromName = () => { if (!addressTouched) { $("domain").value = finished($("person").value).slice(0, 50).replace(/-+$/, ""); preview(); } };
  $("person").addEventListener("input", fromName);
  const showAddressBox = () => { $("address-box").hidden = false; $("change-address").hidden = true; };
  $("change-address").addEventListener("click", () => { showAddressBox(); $("domain").focus(); });

  async function install() {
    $("error").textContent = "";
    $("again").hidden = true;
    logList.textContent = "";
    try {
      log("Looking at your Cloudflare account…");
      const { accounts } = await step("accounts");
      if (!accounts.length) throw new Error("Cloudflare didn't share an account. Connect again and choose one.");
      let account = accounts[0];
      if (accounts.length > 1) {
        $("accounts").innerHTML = "";
        accounts.forEach((a, i) => {
          const label = document.createElement("label");
          label.className = "account";
          const radio = Object.assign(document.createElement("input"), { type: "radio", name: "account", value: a.id, checked: i === 0 });
          label.append(radio, document.createTextNode(a.name + (a.domain ? " (" + a.domain + ".workers.dev)" : "")));
          $("accounts").append(label);
        });
        $("choose").hidden = false;
        await waitFor($("use-account"));
        $("choose").hidden = true;
        account = accounts.find((a) => a.id === document.querySelector("input[name=account]:checked").value);
      }
      // Done looking: the tick stops the line reading as if it were still busy while they choose.
      tick(logList.lastElementChild);
      if (!$("person").value) $("person").value = invitedAs.trim().slice(0, 100);
      $("new-address").hidden = Boolean(account.domain);
      $("old-address").hidden = !account.domain;
      if (account.domain) $("old-address").querySelector("b").textContent = "afterwrd." + account.domain + ".workers.dev";
      fromName();
      $("naming").hidden = false;
      for (;;) {
        await waitFor($("use-person"));
        $("error").textContent = "";
        if (!$("person").value.trim()) { $("error").textContent = "Give your name."; continue; }
        if (account.domain) break;
        $("domain").value = finished($("domain").value);
        preview();
        if (!$("domain").value) {
          showAddressBox();
          $("error").textContent = "Choose an address for your site, using letters a to z, numbers and hyphens.";
          continue;
        }
        try {
          account.domain = (await step("name", { account: account.id, domain: $("domain").value })).domain;
          break;
        } catch (err) {
          // Usually someone else on Cloudflare has it already: open the address box, filled in, to change it.
          showAddressBox();
          $("error").textContent = err.message;
        }
      }
      $("naming").hidden = true;
      const ownerName = $("person").value.trim().slice(0, 100);
      $("error").textContent = "";
      log("Checking your account and the release…");
      let checked = await step("check", { account: account.id, name });
      while (checked.taken) {
        $("taken").textContent = checked.taken;
        if (!$("name").value) $("name").value = name;
        $("renaming").hidden = false;
        await waitFor($("use-name"));
        name = $("name").value = finished($("name").value);
        try {
          checked = await step("check", { account: account.id, name });
          $("error").textContent = "";
        } catch (err) {
          $("error").textContent = err.message;
        }
      }
      $("renaming").hidden = true;
      const { version, site } = checked;
      log("Uploading afterwrd " + version + "'s site files…");
      const { jwt } = await step("assets", { account: account.id, name, version });
      log("Creating the database and installing afterwrd…");
      const { next } = await step("deploy", { account: account.id, name, version, jwt });
      log("Waiting for your site to start at " + new URL(site).host + "…");
      for (let i = 0; i < 60; i++) {
        if (await fetch(site + "/_auth/login", { mode: "no-cors", cache: "no-store" }).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      tick(logList.lastElementChild);
      await step("finish").catch(() => {});
      $("address").textContent = new URL(site).host;
      const handOn = new URLSearchParams({ name: ownerName });
      if (invite) handOn.set("invite", invite);
      $("continue").href = next + "#" + handOn.toString();
      try { localStorage.removeItem(KEPT); } catch {}
      $("ready").hidden = false;
      // Straight on to the new site (the button stays, in case the browser holds back the move).
      location.assign($("continue").href);
    } catch (err) {
      $("error").textContent = err.message;
      $("again").hidden = false;
    }
  }
  $("again").addEventListener("click", install);
  if (${connected && go}) {
    history.replaceState(null, "", "/");
    install();
  }
</script>
</body>
</html>`;
}
