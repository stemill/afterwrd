// afterwrd installer, version __VERSION__.
//
// Paste this whole file into a Cloudflare Worker and deploy it, then open the Worker's address:
//   - into a new "Hello World" Worker, it installs afterwrd;
//   - over an existing afterwrd, it updates it to this version, keeping its people, archive and photos.
//
// What it does, with the API token you give it:
//   1. finds this Worker in your account
//   2. creates a D1 database for afterwrd, or reuses the one afterwrd already has
//   3. downloads afterwrd from the address below and checks every file against the fingerprint below,
//      so what's installed is exactly the published release
//   4. uploads it as a new version of this Worker
// The token is used only while installing and isn't stored anywhere. Delete it afterwards.
import { api, deployVersion, existingDatabase, findOrCreateDatabase, findWorker, loadRelease, uploadAssets } from "../src/deploy.js";

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
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(page(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const step = url.pathname.slice("/install/".length);
    if (request.method === "POST" && url.pathname.startsWith("/install/") && Object.hasOwn(STEPS, step)) {
      if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Request from another site" }, { status: 403 });
      try {
        return Response.json(await STEPS[step](await request.json(), scriptName(url)));
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
    }
    return new Response("afterwrd is being installed.", { status: 404 });
  },
};

// The Worker's address is <script>.<your-subdomain>.workers.dev.
function scriptName(url) {
  if (!url.hostname.endsWith(".workers.dev")) throw new Error("Open the installer at its workers.dev address.");
  return url.hostname.split(".")[0];
}

const STEPS = {
  // Which of the token's accounts this Worker is in, whether it's already afterwrd, and which release goes in.
  async check({ token }, script) {
    const { manifest } = await loadRelease(RELEASE, MANIFEST_SHA256);
    const { account, settings } = await findWorker(token, script);
    return { account, version: manifest.version, upgrade: Boolean(existingDatabase(settings)) };
  },

  // The site's own files (stylesheet, import page).
  async assets({ token, account }, script) {
    return { jwt: await uploadAssets(token, account, script, await loadRelease(RELEASE, MANIFEST_SHA256)) };
  },

  // The database and the code, as a new version of this Worker.
  async deploy({ token, account, jwt }, script) {
    const release = await loadRelease(RELEASE, MANIFEST_SHA256);
    const settings = await api(token, `/accounts/${account}/workers/scripts/${script}/settings`);
    const existing = existingDatabase(settings);
    if (existing) {
      await deployVersion(token, account, script, release, { jwt, databaseId: existing, settings });
      return { next: "/", upgrade: true };
    }
    const database = await findOrCreateDatabase(token, account, script);
    const setupCode = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await deployVersion(token, account, script, release, { jwt, databaseId: database.uuid, settings, secrets: { SETUP_CODE: setupCode } });
    return { next: `/_auth/setup?code=${setupCode}`, upgrade: false };
  },
};

// --- the page ----------------------------------------------------------------

function page() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>Install afterwrd</title>
<style>
  :root { --bg: #16201b; --surface: #1f2b25; --sunken: #121a16; --text: #ede6da; --muted: #a9a092; --border: #2e3d35;
          --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 24px auto; background: var(--surface); border-radius: 24px; padding: 26px; }
  h1 { font: 900 1.75rem/1.2 ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif; margin: 0 0 10px; letter-spacing: -0.015em; }
  a { color: var(--accent-strong); }
  ol.how { padding-left: 1.2rem; }
  ol.how li { margin: 0.5rem 0; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  a.button, button { display: inline-block; padding: 10px 16px; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  a.button.secondary { background: #263329; color: var(--text); }
  button:disabled { opacity: 0.6; cursor: default; }
  input { width: 100%; font: inherit; padding: 10px 14px; margin: 6px 0 12px; border: 1px solid var(--border); border-radius: 999px;
    background: var(--sunken); color: var(--text); -webkit-text-security: disc; }
  #log { padding-left: 1.2rem; }
  #error { color: #ff8070; }
  #done { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 12px; }
  #done[hidden] { display: none; }
</style>
</head>
<body>
<main>
<h1>Install afterwrd</h1>
<p>This installs afterwrd ${VERSION} into your Cloudflare account, as this Worker. If this Worker is already afterwrd,
it updates it to ${VERSION}, keeping everyone's access and your archive. It needs a Cloudflare API token so it can
create a database and upload afterwrd.</p>
<ol class="how">
  <li><a class="button" href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a><br>
    <span class="meta">On the page that opens, the permissions are already filled in. Scroll down, press
    <b>Continue to summary</b>, then <b>Create Token</b>, then copy the token.</span></li>
  <li>Paste the token here:<input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token"></li>
  <li><button id="go">Install afterwrd</button></li>
</ol>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" hidden>
  <p><b id="done-title"></b></p>
  <p>One last thing: <b>delete the token</b>. afterwrd doesn't keep it, but while it exists it can change your Workers.
  Find "afterwrd installer" in the list and choose <b>Delete</b>.</p>
  <p><a class="button secondary" href="${TOKENS_PAGE}" target="_blank" rel="noopener">Open my API tokens</a>
     <a class="button" id="continue" href="/">Continue to afterwrd</a></p>
</section>
<p class="meta">Release files are checked against the fingerprint ${MANIFEST_SHA256.slice(0, 12)}… before anything is installed.</p>
</main>
<script>
  const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
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
    try {
      log("Checking the token and the release…");
      const { account, version, upgrade } = await step("check", { token });
      log("Uploading afterwrd " + version + "'s site files…");
      const { jwt } = await step("assets", { token, account });
      log(upgrade ? "Updating afterwrd to " + version + "…" : "Creating the database and installing afterwrd…");
      const { next } = await step("deploy", { token, account, jwt });
      box.value = "";
      log("Waiting for afterwrd to start…");
      for (let i = 0; i < 30; i++) {
        const res = await fetch("/_auth/login", { cache: "no-store" });
        if (res.ok) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      document.getElementById("done-title").textContent = upgrade
        ? "afterwrd is updated to " + version + "."
        : "afterwrd is installed. Next you'll make yourself its owner.";
      document.getElementById("continue").href = next;
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
