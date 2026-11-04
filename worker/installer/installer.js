// afterwrd installer, version __VERSION__.
//
// Deploy this as a Cloudflare Worker (the install page's "Install on Cloudflare" button does it, or paste this whole
// file into a Worker by hand), then open the Worker's address:
//   - as a new Worker, it installs afterwrd at the address you choose;
//   - over an existing afterwrd, it updates it to this version, keeping its passkeys, connections, archive and photos.
//
// What it does, with the API token you give it:
//   1. finds this Worker in your account
//   2. creates a D1 database for afterwrd, or reuses the one afterwrd already has
//   3. downloads afterwrd from the address below and checks every file against the fingerprint below,
//      so what's installed is exactly the published release
//   4. uploads it as a new version of this Worker or, for a new site at a different address, as a new Worker with
//      that name, then removes this installer once afterwrd answers there (Cloudflare's Deploy page gives the
//      installer a name with a random ending, so the address is chosen here instead)
// If you tick "Remember it", the token is kept as the site's encrypted secret UPDATE_TOKEN, so the Update page can
// install later releases in one click (the site can forget it there). Otherwise it isn't stored: delete it afterwards.
import { accountIds, api, deployVersion, existingDatabase, findOrCreateDatabase, findWorker, loadRelease, uploadAssets, workerSettings } from "../src/deploy.js";

const RELEASE = "__RELEASE_BASE__";
const MANIFEST_SHA256 = "__MANIFEST_SHA256__";
const VERSION = "__VERSION__";
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=afterwrd%20installer";
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

// Pasted over an existing afterwrd, this Worker still has afterwrd's photo store attached; Cloudflare only accepts
// the paste if the class is still exported. This stand-in is replaced by the real one as soon as installing
// finishes, and the photos it holds are untouched in between.
export class MediaStore {
  fetch() {
    return new Response("afterwrd is being updated; try again in a minute.", { status: 503 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The token is typed into this page, so it's only ever served over https.
    if (url.protocol === "http:") return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    if (request.method === "GET" && url.pathname === "/") {
      // Pasted over an existing afterwrd, the Worker still has its database: that's an update, at the same address.
      return new Response(page(url, Boolean(env?.DB)), { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    }
    const step = url.pathname.slice("/install/".length);
    if (request.method === "POST" && url.pathname.startsWith("/install/") && Object.hasOwn(STEPS, step)) {
      if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Request from another site" }, { status: 403 });
      try {
        return Response.json(await STEPS[step](await request.json(), scriptName(url), url));
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
    }
    return new Response("afterwrd is being installed.", { status: 404, headers: HEADERS });
  },
};

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; form-action 'self'",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

// Cloudflare account ids are 32 hex characters; anything else is refused before it reaches an API path.
function accountId(id) {
  if (!/^[0-9a-f]{32}$/.test(String(id ?? ""))) throw new Error("That isn't a Cloudflare account id.");
  return id;
}

// The Worker's address is <script>.<your-subdomain>.workers.dev.
function scriptName(url) {
  if (!url.hostname.endsWith(".workers.dev")) throw new Error("Open the installer at its workers.dev address.");
  return url.hostname.split(".")[0];
}
const accountDomain = (url) => url.hostname.split(".").slice(1).join("."); // <your-subdomain>.workers.dev

// The address to suggest: "afterwrd" when this is the Deploy page's installer, otherwise this Worker's own name.
const suggestedName = (script) => (/^afterwrd-installer(-|$)/.test(script) ? "afterwrd" : script);

// Refuses a name another Worker has. Only "no such Worker" counts as free: an API hiccup is an error, not a yes.
async function assertFree(token, account, name) {
  if (await workerSettings(token, account, name)) {
    throw new Error(`There's already a Worker called "${name}" in this Cloudflare account. Choose another address, or if `
      + "it's left from an earlier try, delete it in Cloudflare (Workers & Pages) and press Install again.");
  }
}

// A Worker name, which is also the first part of the site's address.
function siteName(name) {
  const clean = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) {
    throw new Error("Your address can use lowercase letters, numbers and hyphens (not at the start or end).");
  }
  return clean;
}


const STEPS = {
  // Which of the token's accounts this Worker is in, whether it's already afterwrd, which release goes in, and the
  // Worker afterwrd goes into: this one for an update, or the chosen name (which mustn't be taken) for a new site.
  async check({ token, name }, script) {
    if (!String(token ?? "").trim()) throw new Error("Paste your API token first.");
    const { account, settings } = await findWorker(token, script); // the token is checked before anything is fetched
    const { manifest } = await loadRelease(RELEASE, MANIFEST_SHA256);
    const upgrade = Boolean(existingDatabase(settings));
    const target = upgrade ? script : siteName(name ?? script);
    if (target !== script) await assertFree(token, account, target);
    // A token that spans several accounts can change all of them, so the page unticks Remember and says why.
    const accounts = (await accountIds(token)).length;
    return { account, version: manifest.version, upgrade, target, severalAccounts: accounts > 1 };
  },

  // The site's own files (stylesheet, import page).
  async assets({ token, account, target }, script) {
    return { jwt: await uploadAssets(token, accountId(account), siteName(target ?? script), await loadRelease(RELEASE, MANIFEST_SHA256)) };
  },

  // The database and the code, as a new version of this Worker, or as a new Worker at the chosen address.
  // With `remember`, the token is kept as the secret UPDATE_TOKEN for one-click updates.
  async deploy({ token, account, jwt, remember, target }, script, url) {
    accountId(account);
    const release = await loadRelease(RELEASE, MANIFEST_SHA256);
    const settings = await api(token, `/accounts/${account}/workers/scripts/${script}/settings`);
    const existing = existingDatabase(settings);
    if (existing) {
      await deployVersion(token, account, script, release, { jwt, databaseId: existing, settings });
      // An update keeps the site's secrets, so a remembered token is set on its own rather than alongside them.
      if (remember) {
        await api(token, `/accounts/${account}/workers/scripts/${script}/secrets`, {
          method: "PUT", body: JSON.stringify({ name: "UPDATE_TOKEN", text: token, type: "secret_text" }),
        });
      }
      return { next: "/", upgrade: true };
    }
    const name = siteName(target ?? script);
    const moved = name !== script;
    if (moved) await assertFree(token, account, name); // checked again here, so a new Worker never lands on another
    const database = await findOrCreateDatabase(token, account, name);
    const setupCode = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const secrets = { SETUP_CODE: setupCode, ...(remember && { UPDATE_TOKEN: token }) };
    await deployVersion(token, account, name, release, { jwt, databaseId: database.uuid, settings: moved ? {} : settings, secrets });
    // A Worker made through the API isn't on its workers.dev address until it's switched on.
    if (moved) {
      await api(token, `/accounts/${account}/workers/scripts/${name}/subdomain`, {
        method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }),
      });
    }
    const site = moved ? `https://${name}.${accountDomain(url)}` : url.origin;
    return { next: `${site}/_auth/setup?code=${setupCode}`, site, moved, upgrade: false };
  },

  // Once afterwrd answers at its own address, this installer is removed. Only ever this Worker, only while it isn't
  // afterwrd itself, and only once the new site has its database.
  async cleanup({ token, account, target }, script) {
    accountId(account);
    const name = siteName(target);
    if (name === script) return { ok: true };
    const [mine, theirs] = await Promise.all([workerSettings(token, account, script), workerSettings(token, account, name)]);
    if (!mine || existingDatabase(mine) || !theirs || !existingDatabase(theirs)) return { ok: false };
    await api(token, `/accounts/${account}/workers/scripts/${script}`, { method: "DELETE" });
    return { ok: true };
  },
};

// --- the page ----------------------------------------------------------------

function page(url, isUpdate) {
  const domain = accountDomain(url);
  let n = 0;
  const step = (body, cls = "") => `<li${cls ? ` class="${cls}"` : ""}><span class="n">${++n}</span><div>${body}</div></li>`;
  const address = isUpdate ? "" : step(`
    <h2>Choose your address</h2>
    <p class="address"><input id="name" value="${suggestedName(scriptName(url))}" autocomplete="off" spellcheck="false"
      autocapitalize="none" aria-label="Your site's name"><span class="meta">.${domain}</span></p>
    <p class="meta">This is how friends will find your site. Lowercase letters, numbers and hyphens.</p>`);
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>Install afterwrd</title>
<style>
  :root { --bg: #16201b; --surface: #1f2b25; --raised: #263329; --sunken: #121a16; --text: #ede6da; --muted: #a9a092;
          --border: #2e3d35; --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; --moss: #8fbf7f;
          --round: ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 24px auto; background: var(--surface); border-radius: 24px; padding: 28px; }
  .brand { display: flex; align-items: center; font: 900 1.35rem/1 var(--round); margin: 0 0 18px; letter-spacing: -0.02em; }
  .brand .o { width: 0.82em; height: 0.82em; color: var(--accent); margin: 0 0.02em; }
  h1 { font: 900 1.75rem/1.2 var(--round); margin: 0 0 8px; letter-spacing: -0.015em; }
  h2 { font: 800 1.05rem/1.3 var(--round); margin: 4px 0 4px; }
  p { margin: 6px 0; }
  a { color: var(--accent-strong); }
  .meta { color: var(--muted); font-size: 0.88rem; }
  .button, button { display: inline-block; padding: 10px 18px; border: 0; border-radius: 999px; background: var(--text); color: var(--on-accent);
    font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  .button.secondary { background: var(--raised); color: var(--text); }
  button:disabled { opacity: 0.6; cursor: default; }

  /* The three steps: a numbered circle, then the step. */
  ol.how { list-style: none; padding: 0; margin: 22px 0 0; display: grid; gap: 20px; }
  ol.how > li { display: grid; grid-template-columns: 30px 1fr; gap: 14px; }
  ol.how .n { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--on-accent);
    font: 900 0.95rem var(--round); display: grid; place-items: center; margin-top: 2px; }
  ol.how .button { margin-top: 8px; }
  #token { width: 100%; font: inherit; padding: 10px 16px; margin: 6px 0 0; border: 1px solid var(--border); border-radius: 999px;
    background: var(--sunken); color: var(--text); -webkit-text-security: disc; }
  label.remember { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin-top: 12px; cursor: pointer; }
  label.remember input { margin: 4px 0 0; width: 16px; height: 16px; accent-color: var(--accent); }
  label.remember .meta { grid-column: 2; }
  #go { margin-top: 0; }
  p.address { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  #name { width: 11em; max-width: 100%; font: inherit; font-weight: 700; padding: 8px 14px; border: 1px solid var(--border);
    border-radius: 999px; background: var(--sunken); color: var(--text); }
  ol.how > li.go { align-items: center; }

  /* Progress: each line is ticked off as the next begins. */
  #log { list-style: none; padding: 0; margin: 20px 0 0; }
  #log:empty { display: none; }
  #log li { position: relative; padding-left: 26px; margin: 4px 0; color: var(--muted); }
  #log li::before { content: ""; position: absolute; left: 4px; top: 0.55em; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  #log li.done { color: var(--text); }
  #log li.done::before { content: "✓"; background: none; color: var(--moss); top: 0; left: 2px; width: auto; height: auto; font-weight: 800; }
  #error, .warn { color: #ff8070; }
  #error:empty { display: none; }

  #done { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 16px; }
  #done[hidden], #done [hidden], #form[hidden], #several[hidden] { display: none; }
  #done h2 { font-size: 1.2rem; }
  #done .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .foot { margin: 22px 0 0; }
</style>
</head>
<body>
<main>
<p class="brand" aria-label="afterwrd">afterw<svg class="o" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-4.7 14.5L3.8 20l1.2-3.6A8 8 0 0 1 12 4z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>rd</p>
<h1>${isUpdate ? "Update" : "Install"} afterwrd</h1>
<p class="meta">${isUpdate
  ? `This updates your afterwrd to ${VERSION}, keeping your passkeys, connections and archive.`
  : `This installs afterwrd ${VERSION} into your Cloudflare account, at the address you choose.`}</p>
<section id="form">
<ol class="how">
  ${address}
  ${step(`
    <h2>Make a token</h2>
    <p class="meta">afterwrd needs it to create a database and upload itself. Cloudflare's page opens with the
    permissions filled in: scroll down, press <b>Continue to summary</b>, then <b>Create Token</b>, and copy it.</p>
    <a class="button secondary" href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a>`)}
  ${step(`
    <h2>Paste it here</h2>
    <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token" aria-label="Your API token">
    <label class="remember"><input type="checkbox" id="remember" checked><span>Remember it, so updates are one click</span>
    <span class="meta">It's kept as an encrypted secret of your site, which no one can read back, not even you. It can
    change the Workers in this Cloudflare account, so untick this if the account is used for anything else. You can
    forget it from afterwrd's Update page at any time.</span></label>
    <p id="several" class="meta warn" hidden>This token can see more than one Cloudflare account, so it won't be
    remembered. For one-click updates, make a token in an account that's just for afterwrd.</p>`)}
  ${step(`<button id="go">${isUpdate ? "Update afterwrd" : "Install afterwrd"}</button>`, "go")}
</ol>
</section>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" hidden>
  <h2 id="done-title"></h2>
  <p id="kept" class="meta">Your token is remembered, so later updates are one click from afterwrd's <b>Update</b> page.</p>
  <div id="not-kept">
    <p class="meta">One last thing: <b>delete the token</b>. afterwrd hasn't kept it, but while it exists it can change your
    Workers. Find "afterwrd installer" in the list and choose <b>Delete</b>. You'll make a new one when you update.</p>
  </div>
  <p id="leftover" class="meta" hidden>The installer couldn't remove itself: you can delete the Worker called
    <b>${scriptName(url)}</b> in Cloudflare (Workers &amp; Pages).</p>
  <div class="row">
    <a class="button" id="continue" href="/">Continue to afterwrd</a>
    <a class="button secondary" id="tokens" href="${TOKENS_PAGE}" target="_blank" rel="noopener">Open my API tokens</a>
  </div>
</section>
<p class="meta foot">Release files are checked against the fingerprint ${MANIFEST_SHA256.slice(0, 12)}… before anything is installed.</p>
</main>
<script>
  // Each new line ticks off the one before.
  const logList = document.getElementById("log");
  const tick = (li) => { if (li) { li.classList.add("done"); li.textContent = li.textContent.replace(/…$/, ""); } };
  const log = (text) => {
    tick(logList.lastElementChild);
    const li = document.createElement("li");
    li.textContent = text;
    logList.append(li);
  };
  async function step(name, body) {
    const res = await fetch("/install/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  document.getElementById("go").addEventListener("click", async (e) => {
    const box = document.getElementById("token");
    const token = box.value.trim();
    const error = document.getElementById("error");
    error.textContent = "";
    if (!token) { error.textContent = "Paste your API token first."; return; }
    e.target.disabled = true;
    logList.textContent = ""; // a fresh start after an error
    try {
      const name = document.getElementById("name")?.value;
      log("Checking the token and the release…");
      const { account, version, upgrade, target, severalAccounts } = await step("check", { token, name });
      const rememberBox = document.getElementById("remember");
      if (severalAccounts && rememberBox.checked) {
        rememberBox.checked = false;
        document.getElementById("several").hidden = false;
      }
      log("Uploading afterwrd " + version + "'s site files…");
      const { jwt } = await step("assets", { token, account, target });
      log(upgrade ? "Updating afterwrd to " + version + "…" : "Creating the database and installing afterwrd…");
      const remember = document.getElementById("remember").checked;
      const { next, site, moved } = await step("deploy", { token, account, jwt, remember, target });
      log("Waiting for afterwrd to start" + (moved ? " at " + new URL(site).host : "") + "…");
      // A new address can take a minute to appear; until it does, fetching it fails.
      for (let i = 0; i < 60; i++) {
        const ok = moved
          ? await fetch(site + "/_auth/login", { mode: "no-cors", cache: "no-store" }).then(() => true, () => false)
          : (await fetch("/_auth/login", { cache: "no-store" })).ok;
        if (ok) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (moved) {
        log("Removing the installer…");
        const { ok } = await step("cleanup", { token, account, target }).catch(() => ({ ok: false }));
        if (!ok) document.getElementById("leftover").hidden = false;
      }
      box.value = "";
      document.getElementById("done-title").textContent = upgrade
        ? "afterwrd is updated to " + version + "."
        : "afterwrd is installed at " + new URL(site).host + ". Next you'll make yourself its owner.";
      document.getElementById("continue").href = next;
      document.getElementById("kept").hidden = !remember;
      document.getElementById("not-kept").hidden = remember;
      document.getElementById("tokens").hidden = remember;
      tick(logList.lastElementChild);
      document.getElementById("form").hidden = true;
      document.getElementById("done").hidden = false;
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
