// afterwrd's installer at https://install.afterwrd.app: installs afterwrd into someone's own Cloudflare account from
// any browser, a phone's included, with no code editor and no Deploy page. It runs in Ste's Cloudflare account and is
// deployed by hand (`npx wrangler deploy -c central/wrangler.jsonc`), never from GitHub, so no Cloudflare credential
// is kept there. It has no storage of its own.
//
//   GET  /             the page: a name for the site, Connect, then the steps with their progress
//   GET  /connect      a fresh PKCE secret in a short cookie, then off to Cloudflare to press Allow
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
import { api, databaseInUse, databaseTakenMessage, deployVersion, findOrCreateDatabase, loadRelease, uploadAssets, useApiBase,
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
  // Only from this page (or typed in): a connection started elsewhere would end in the steps running by themselves.
  const from = request.headers.get("Sec-Fetch-Site");
  if (from && from !== "same-origin" && from !== "none") return new Response("Start from install.afterwrd.app.", { status: 403 });
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
      .catch((error) => { throw new Error(`Cloudflare wouldn't take that name (${error.message.replace(/^Cloudflare said: /, "")}). Try another.`); });
    return { domain: clean };
  },

  // Everything that would stop the install, before anything is uploaded; and which release it'll be.
  async check(token, { account, name }, here) {
    await ownAccount(token, account);
    const site = siteName(name);
    const domain = await workersDev(token, account);
    if (!domain) throw new Error("This account needs a workers.dev name first.");
    if (await workerSettings(token, account, site)) {
      throw new Error(`There's already a Worker called "${site}" in this Cloudflare account. Choose another name, or if it's left `
        + "from an earlier try, delete it in Cloudflare (Workers & Pages) and try again.");
    }
    if ((await databaseInUse(token, account, site))?.tables) throw new Error(databaseTakenMessage(site));
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
  button:disabled { opacity: 0.6; cursor: default; }
  .field { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 8px 0; }
  input[type=text] { flex: 1 1 8em; min-width: 0; font: inherit; font-weight: 700; padding: 10px 16px; border: 1px solid var(--border);
    border-radius: 999px; background: var(--sunken); color: var(--text); }
  .suffix { color: var(--muted); word-break: break-all; }
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

<section id="start"${connected && go ? " hidden" : ""}>
  <p>Your own afterwrd site, in your own free Cloudflare account. It takes a couple of minutes, and works on a phone.</p>
  <h2>1. A Cloudflare account</h2>
  <p class="meta">Make one first, and stay signed in in this browser. An email address is all it asks for; don't add a card.
  If you already use Cloudflare for other things, make a new account just for afterwrd.</p>
  <a class="button secondary" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">Make a free Cloudflare account</a>
  <h2>2. Your site's name</h2>
  <p class="field"><input type="text" id="name" value="afterwrd" autocomplete="off" spellcheck="false" autocapitalize="none" aria-label="Your site's name"><span class="suffix">.your-name.workers.dev</span></p>
  <p class="meta">How friends will find your site. Lowercase letters, numbers and hyphens.</p>
  <h2>3. Connect Cloudflare</h2>
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
  <h2>Choose your Cloudflare name</h2>
  <p class="meta">This account doesn't have one yet. Every site in it will be at <i>site</i>.<b>this name</b>.workers.dev,
  so something like your own name works well. Lowercase letters, numbers and hyphens.</p>
  <p class="field"><input type="text" id="domain" autocomplete="off" spellcheck="false" autocapitalize="none" aria-label="Your Cloudflare name"><span class="suffix">.workers.dev</span></p>
  <button id="use-domain">Use this name</button>
</section>

<ol id="log"></ol>
<p id="error" role="alert">${error ? escapeHtml(error) : ""}</p>
<button id="again" class="secondary" hidden>Try again</button>

<section id="ready" class="ready" hidden>
  <h2>Your site is ready</h2>
  <p>It's at <b id="address"></b>. Next you'll make yourself its owner, with a passkey (your face, fingerprint or phone PIN).</p>
  <a class="button" id="continue" href="/">Set up my site</a>
  <p class="meta">Before you use it, it's worth checking: <a href="https://afterwrd.app/check/">Check your install</a>, or ask a
  friend with afterwrd to check it (on your new site: <b>Update → Ask a friend to check my site</b>). Your Cloudflare
  connection has been dropped here, and ends by itself within the hour.</p>
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
  // Connect takes the page away and back: the name typed is kept for the return.
  $("connect").addEventListener("click", () => { try { sessionStorage.setItem("afterwrd-name", $("name").value.trim()); } catch {} });
  let name = "afterwrd";
  try { name = sessionStorage.getItem("afterwrd-name") || name; } catch {}
  $("name").value = name;

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
      while (!account.domain) {
        $("naming").hidden = false;
        await waitFor($("use-domain"));
        try {
          account.domain = (await step("name", { account: account.id, domain: $("domain").value })).domain;
          $("naming").hidden = true;
        } catch (err) {
          $("error").textContent = err.message;
        }
      }
      $("error").textContent = "";
      log("Checking the name and the release…");
      const { version, site } = await step("check", { account: account.id, name });
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
      try { sessionStorage.removeItem("afterwrd-name"); } catch {}
      $("address").textContent = new URL(site).host;
      $("continue").href = next;
      $("ready").hidden = false;
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
