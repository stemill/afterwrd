// The owner's Update page: installs a newer afterwrd release over this one, keeping the database, photos and
// secrets, with a Cloudflare API token the owner makes for the purpose (and deletes afterwards).
//   GET  /_admin/update            the page: this version, and the latest release if it's newer
//   GET  /_admin/update/version    this version, for the page to see when the update has taken over
//   POST /_admin/update/check      {token, tag} -> which account this Worker is in
//   POST /_admin/update/assets     {token, account, tag} -> upload the release's site files
//   POST /_admin/update/deploy     {token, account, tag, jwt} -> the new version
// Releases come from the GitHub repository in package.json (afterwrd.releases). Every file is checked against
// the release's manifest; as with installing, trust rests on that repository.
import { asset, ownerHeader } from "./nav.js";
import pkg from "../package.json";
import { api, deployVersion, existingDatabase, findWorker, loadRelease, uploadAssets } from "./deploy.js";
import { escape, html, json } from "./util.js";

const VERSION = pkg.version;
const REPO = pkg.afterwrd.releases;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "account_settings", type: "read" }];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=afterwrd%20update";
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

export async function handleUpdate(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/update".length);
  if (request.method === "GET" && path === "") return html(updatePage(owner, await latestRelease()));
  if (request.method === "GET" && path === "/version") return json({ version: VERSION });
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  try {
    if (!url.hostname.endsWith(".workers.dev")) throw new Error("Updating works from the site's workers.dev address.");
    if (!TAG_RE.test(body.tag ?? "")) throw new Error("Unknown release.");
    const script = url.hostname.split(".")[0];
    const release = () => loadRelease(`https://github.com/${REPO}/releases/download/${body.tag}`);
    if (path === "/check") return json({ account: (await findWorker(body.token, script)).account });
    if (path === "/assets") return json({ jwt: await uploadAssets(body.token, body.account, script, await release()) });
    if (path === "/deploy") {
      const settings = await api(body.token, `/accounts/${body.account}/workers/scripts/${script}/settings`);
      const databaseId = existingDatabase(settings);
      if (!databaseId) throw new Error("This Worker doesn't look like afterwrd, so it wasn't updated.");
      await deployVersion(body.token, body.account, script, await release(), { jwt: body.jwt, databaseId, settings });
      return json({ ok: true });
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return new Response("Not found", { status: 404 });
}

// The latest release's manifest names its version. It's fetched from GitHub's download links rather than its API:
// the API allows 60 anonymous requests an hour per address, and Workers share their addresses with many others.
// (Only the version is read here; updating downloads the release by tag and checks every file.)
async function latestRelease() {
  try {
    const response = await fetch(`https://github.com/${REPO}/releases/latest/download/manifest.json`, {
      headers: { "User-Agent": "afterwrd" },
    });
    if (!response.ok) return { error: `GitHub said ${response.status}.` };
    const { version } = await response.json();
    const tag = `v${version}`;
    if (!TAG_RE.test(tag)) return { error: "The latest release has an unexpected version." };
    return { tag, version, page: `https://github.com/${REPO}/releases/tag/${tag}` };
  } catch (error) {
    return { error: error.message };
  }
}

function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function updatePage(owner, latest) {
  const available = latest.version && newer(latest.version, VERSION);
  let body;
  if (latest.error) {
    body = `<p>Couldn't check for a newer version: ${escape(latest.error)}</p>`;
  } else if (!available) {
    body = `<p>You have the latest version.</p>`;
  } else {
    body = `
<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">What's new</a></p>
<p class="meta">Updating keeps everyone's access, your archive and your photos. It needs a Cloudflare API token, used only while
updating and not kept.</p>
<ol class="how">
  <li><a class="button" href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a>
    <span class="meta">The permissions are filled in: scroll down, press <b>Continue to summary</b>, <b>Create Token</b>, and copy it.</span></li>
  <li>Paste it here: <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token"></li>
  <li><button id="go" data-tag="${escape(latest.tag)}" data-version="${escape(latest.version)}">Update to ${escape(latest.version)}</button></li>
</ol>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" class="card" hidden>
  <p><b>Updated to ${escape(latest.version)}.</b> Now delete the token: afterwrd doesn't keep it, but while it exists it can
  change your Workers.</p>
  <p><a class="button secondary" href="${TOKENS_PAGE}" target="_blank" rel="noopener">Open my API tokens</a>
     <a class="button" href="/_admin/update">Done</a></p>
</section>`;
  }
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Update · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
<link rel="icon" href="data:,">
<style>
  .how { padding-left: 1.2rem; }
  .how li { margin: 0.6rem 0; }
  .button, #go { display: inline-block; padding: 0.5rem 1rem; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .button.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
  #go:disabled { opacity: 0.6; cursor: default; }
  #token { width: 100%; font: inherit; padding: 0.5rem; margin-top: 0.3rem; border: 1px solid var(--border); border-radius: 999px;
    background: var(--bg); color: var(--text); -webkit-text-security: disc; }
  #error { color: #d93025; }
  #done[hidden] { display: none; }
</style>
</head>
<body>
${ownerHeader("update")}
<main>
<h1>Update afterwrd</h1>
<p class="meta">Signed in as ${escape(owner.name)}. This site is afterwrd ${escape(VERSION)}.</p>
${body}
</main>
<script>
  const go = document.getElementById("go");
  if (go) go.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const box = document.getElementById("token");
    const token = box.value.trim();
    const { tag, version } = go.dataset;
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
    async function post(path, body) {
      const res = await fetch("/_admin/update/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      return data;
    }
    error.textContent = "";
    if (!token) { error.textContent = "Paste your API token first."; return; }
    go.disabled = true;
    try {
      log("Checking the token…");
      const { account } = await post("check", { token, tag });
      log("Uploading " + version + "'s site files…");
      const { jwt } = await post("assets", { token, account, tag });
      log("Installing " + version + "…");
      await post("deploy", { token, account, tag, jwt });
      box.value = "";
      log("Waiting for the new version to start…");
      for (let i = 0; i < 30; i++) {
        const res = await fetch("/_admin/update/version", { cache: "no-store" }).catch(() => null);
        if (res && res.ok && (await res.json()).version === version) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      document.getElementById("done").hidden = false;
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
