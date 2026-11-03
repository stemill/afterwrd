// heybert installer, version __VERSION__.
//
// Paste this whole file into a new Cloudflare Worker (Create → Hello World → Edit code), deploy it, then open
// the Worker's address. It installs heybert into your own Cloudflare account and replaces itself with it.
//
// What it does, with the API token you give it:
//   1. finds this Worker in your account
//   2. creates a D1 database for heybert (or reuses one with this Worker's name)
//   3. downloads heybert from the address below and checks every file against the fingerprint below,
//      so what's installed is exactly the published release
//   4. uploads it as a new version of this Worker
// The token is used only while installing and isn't stored anywhere; delete it afterwards if you like.

const RELEASE = "__RELEASE_BASE__";
const MANIFEST_SHA256 = "__MANIFEST_SHA256__";
const VERSION = "__VERSION__";
const API = "https://api.cloudflare.com/client/v4";
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=heybert%20installer";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(page(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname.startsWith("/install/")) {
      if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Request from another site" }, { status: 403 });
      try {
        const body = await request.json();
        return Response.json(await STEPS[url.pathname.slice("/install/".length)](body, scriptName(url)));
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

// The Worker's address is <script>.<your-subdomain>.workers.dev.
function scriptName(url) {
  if (!url.hostname.endsWith(".workers.dev")) throw new Error("Open the installer at its workers.dev address.");
  return url.hostname.split(".")[0];
}

const STEPS = {
  // Which of the token's accounts this Worker is in, and which release will be installed.
  async check({ token }, script) {
    const manifest = await release();
    const accounts = await api(token, "/accounts");
    for (const account of accounts) {
      const found = await fetch(`${API}/accounts/${account.id}/workers/scripts/${script}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (found.ok) return { account: account.id, version: manifest.version };
    }
    throw new Error(`Couldn't find a Worker called "${script}" with that token. Was the token made in the same Cloudflare account?`);
  },

  // The site's own files (stylesheet, import page), through Cloudflare's upload session.
  async assets({ token, account }, script) {
    const manifest = await release();
    const byHash = new Map(manifest.assets.map((a) => [a.hash, a]));
    const session = await api(token, `/accounts/${account}/workers/scripts/${script}/assets-upload-session`, {
      method: "POST",
      body: JSON.stringify({ manifest: Object.fromEntries(manifest.assets.map((a) => [a.path, { hash: a.hash, size: a.size }])) }),
    });
    let jwt = session.jwt;
    for (const bucket of session.buckets ?? []) {
      const form = new FormData();
      for (const hash of bucket) {
        const asset = byHash.get(hash);
        form.append(hash, new File([base64(await file(asset.sha256))], hash, { type: asset.type }));
      }
      const uploaded = await api(session.jwt, `/accounts/${account}/workers/assets/upload?base64=true`, { method: "POST", body: form });
      jwt = uploaded?.jwt ?? jwt;
    }
    return { jwt };
  },

  // The database and the code, as a new version of this Worker. Returns the one-time setup link.
  async deploy({ token, account, jwt }, script) {
    const manifest = await release();
    const databases = await api(token, `/accounts/${account}/d1/database?name=${encodeURIComponent(script)}`);
    const database = databases.find((d) => d.name === script)
      ?? await api(token, `/accounts/${account}/d1/database`, { method: "POST", body: JSON.stringify({ name: script }) });
    const setupCode = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({
      main_module: manifest.main_module,
      compatibility_date: manifest.compatibility_date,
      compatibility_flags: manifest.compatibility_flags,
      bindings: [
        { type: "d1", name: "DB", id: database.uuid },
        ...manifest.durable_objects.map((d) => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
        { type: "assets", name: "ASSETS" },
        { type: "secret_text", name: "SETUP_CODE", text: setupCode },
      ],
      migrations: manifest.migrations,
      assets: { jwt, config: manifest.assets_config },
    })], { type: "application/json" }));
    for (const module of manifest.modules) {
      form.append(module.name, new File([await file(module.sha256)], module.name, { type: module.type }));
    }
    await api(token, `/accounts/${account}/workers/scripts/${script}`, { method: "PUT", body: form });
    return { setup: `/_auth/setup?code=${setupCode}` };
  },
};

// --- the release, checked against its fingerprint ---------------------------------

async function release() {
  const bytes = await download(`${RELEASE}/manifest.json`);
  if ((await sha256(bytes)) !== MANIFEST_SHA256) throw new Error("The release doesn't match this installer's fingerprint, so nothing was installed.");
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function file(hash) {
  const bytes = await download(`${RELEASE}/${hash}`);
  if ((await sha256(bytes)) !== hash) throw new Error("A release file doesn't match its fingerprint, so nothing was installed.");
  return bytes;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download the release (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function api(token, path, init = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare said: ${message}`);
  }
  return data.result;
}

// --- the page ----------------------------------------------------------------

function page() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>Install heybert</title>
<style>
  :root { --bg: #f4f5f7; --surface: #fff; --text: #1c1e21; --muted: #65676b; --border: #dddfe2; --accent: #1b62d6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #18191a; --surface: #242526; --text: #e4e6eb; --muted: #a8abaf; --border: #3a3b3c; --accent: #6ea8ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 24px auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  ol.how { padding-left: 1.2rem; }
  ol.how li { margin: 0.5rem 0; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  a.button, button { display: inline-block; padding: 10px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff;
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  input { width: 100%; font: inherit; padding: 10px; margin: 6px 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); }
  #log { padding-left: 1.2rem; }
  #error { color: #d93025; }
</style>
</head>
<body>
<main>
<h1>Install heybert</h1>
<p>This installs heybert ${VERSION} into your Cloudflare account, as this Worker. It needs a Cloudflare API
token so it can create a database and upload heybert.</p>
<ol class="how">
  <li><a class="button" href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a><br>
    <span class="meta">On the page that opens, the permissions are already filled in. Scroll down, press
    <b>Continue to summary</b>, then <b>Create Token</b>, then copy the token.</span></li>
  <li>Paste the token here:<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Your API token"></li>
  <li><button id="go">Install heybert</button></li>
</ol>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<p class="meta">The token is only used while installing and isn't stored. Afterwards you can delete it under
My Profile → API Tokens. Release files are checked against the fingerprint ${MANIFEST_SHA256.slice(0, 12)}… before anything is installed.</p>
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
    const token = document.getElementById("token").value.trim();
    const error = document.getElementById("error");
    error.textContent = "";
    if (!token) { error.textContent = "Paste your API token first."; return; }
    e.target.disabled = true;
    try {
      log("Checking the token and the release…");
      const { account, version } = await step("check", { token });
      log("Uploading heybert " + version + "'s site files…");
      const { jwt } = await step("assets", { token, account });
      log("Creating the database and installing heybert…");
      const { setup } = await step("deploy", { token, account, jwt });
      log("Waiting for heybert to start…");
      for (let i = 0; i < 30; i++) {
        const res = await fetch("/_auth/login", { cache: "no-store" });
        if (res.ok) { location.replace(setup); return; }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("heybert is installed but hasn't started yet. Open " + location.origin + setup + " in a minute.");
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
