// The owner's Update page: installs a newer afterwrd release over this one, keeping the database, photos and
// secrets, with a Cloudflare API token the owner makes for the purpose. If they choose, the token is remembered as
// the Worker secret UPDATE_TOKEN (encrypted, and unreadable through Cloudflare's API or dashboard), so later updates
// are one click; otherwise it's used only while updating, and they delete it afterwards.
//   GET  /_admin/update            the page: this version, and the latest release (with its notes) if it's newer
//   GET  /_admin/update/version    this version, for the page to see when the update has taken over
//   POST /_admin/update/check      {token?, tag} -> which account this Worker is in
//   POST /_admin/update/assets     {token?, account, tag} -> upload the release's site files
//   POST /_admin/update/deploy     {token?, account, tag, jwt} -> the new version
//   POST /_admin/update/remember   {token}: keep it as the secret UPDATE_TOKEN (after an update, or any time)
//   POST /_admin/update/forget     delete the remembered token from the Worker
//   POST /_admin/update/group-assets  {token?, group} -> upload this version's site files for a group this site made
//   POST /_admin/update/group-deploy  {token?, group, jwt} -> bring that group's Worker up to this site's version
// Without a token in the request, the remembered one is used. Groups (groupsites.js) follow their owner's site: once
// it's updated, this page offers to bring its groups up to the same version.
// Releases come from the GitHub repository in package.json (afterwrd.releases). Every file is checked against
// the release's manifest; as with installing, trust rests on that repository.
import { asset, FAVICON, ownerHeader } from "./nav.js";
import pkg from "../package.json";
import { api, deployVersion, existingDatabase, findWorker, loadRelease, uploadAssets } from "./deploy.js";
import { GROUP_RELEASE, isGroupWorker } from "./groupsites.js";
import { escape, html, json, now } from "./util.js";

const VERSION = pkg.version;
const REPO = pkg.afterwrd.releases;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
// D1 too, so the same token can start and delete groups (each has its own database; groupsites.js).
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=afterwrd%20update";
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const CHECK_SECONDS = 6 * 3600;

export async function handleUpdate(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/update".length);
  if (request.method === "GET" && path === "") {
    return html(updatePage(owner, await latestRelease(), Boolean(env.UPDATE_TOKEN), await groupsBehind(env.DB)));
  }
  if (request.method === "GET" && path === "/version") return json({ version: VERSION });
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (path === "/group-assets" || path === "/group-deploy") return updateGroup(env, path, body);
  try {
    if (!["/remember", "/forget"].includes(path)) {
      if (!TAG_RE.test(body.tag ?? "")) throw new Error("Unknown release.");
      // Only ever forward: an older release could bring back problems since fixed.
      if (!newer(body.tag.slice(1), VERSION)) throw new Error("That isn't newer than this site's version.");
    }
    if (!url.hostname.endsWith(".workers.dev")) throw new Error("Updating works from the site's workers.dev address.");
    const script = url.hostname.split(".")[0];
    const given = typeof body.token === "string" ? body.token.trim() : "";
    const token = given || env.UPDATE_TOKEN;
    if (!token) throw new Error("Paste your API token first.");
    if (path === "/remember") {
      if (!given) throw new Error("Paste your API token first.");
      const { account } = await findWorker(given, script);
      await api(given, `/accounts/${account}/workers/scripts/${script}/secrets`, {
        method: "PUT", body: JSON.stringify({ name: "UPDATE_TOKEN", text: given, type: "secret_text" }),
      });
      return json({ ok: true });
    }
    if (path === "/forget") {
      if (!env.UPDATE_TOKEN) return json({ ok: true });
      const { account } = await findWorker(env.UPDATE_TOKEN, script);
      await api(env.UPDATE_TOKEN, `/accounts/${account}/workers/scripts/${script}/secrets/UPDATE_TOKEN`, { method: "DELETE" });
      return json({ ok: true });
    }
    if (path !== "/check" && !/^[0-9a-f]{32}$/.test(body.account ?? "")) throw new Error("Unknown Cloudflare account.");
    const release = () => loadRelease(`https://github.com/${REPO}/releases/download/${body.tag}`);
    if (path === "/check") return json({ account: (await findWorker(token, script)).account });
    if (path === "/assets") return json({ jwt: await uploadAssets(token, body.account, script, await release()) });
    if (path === "/deploy") {
      const settings = await api(token, `/accounts/${body.account}/workers/scripts/${script}/settings`);
      const databaseId = existingDatabase(settings);
      if (!databaseId) throw new Error("This Worker doesn't look like afterwrd, so it wasn't updated.");
      await deployVersion(token, body.account, script, await release(), { jwt: body.jwt, databaseId, settings });
      return json({ ok: true });
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return new Response("Not found", { status: 404 });
}

/** The groups this site made, with the version each is running (null if it couldn't be reached). */
async function madeGroups(db) {
  const { results } = await db.prepare(`SELECT id, name, origin, script, account, database FROM groups
    WHERE joined_at IS NOT NULL AND role = 'owner' AND script IS NOT NULL AND script != '' ORDER BY name COLLATE NOCASE`).all();
  return Promise.all(results.map(async (g) => {
    const ping = await fetch(`${g.origin}/_group/ping`, { redirect: "manual", signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return { ...g, version: typeof ping?.version === "string" && /^\d+\.\d+\.\d+$/.test(ping.version) ? ping.version : null };
  }));
}

/** Those of them running an older version than this site. */
const groupsBehind = async (db) => (await madeGroups(db)).filter((g) => g.version && newer(VERSION, g.version));

/** Brings a group this site made up to this site's version: its files, then its code (keeping its database and secrets). */
async function updateGroup(env, path, body) {
  try {
    const token = (typeof body.token === "string" && body.token.trim()) || env.UPDATE_TOKEN;
    if (!token) throw new Error("Paste your API token first.");
    const group = (await groupsBehind(env.DB)).find((g) => g.id === Number(body.group));
    if (!group || !/^[0-9a-f]{32}$/.test(group.account)) throw new Error("That group is already up to date, or couldn't be reached.");
    const release = await loadRelease(GROUP_RELEASE);
    if (path === "/group-assets") return json({ jwt: await uploadAssets(token, group.account, group.script, release) });
    const settings = await api(token, `/accounts/${group.account}/workers/scripts/${group.script}/settings`);
    if (!isGroupWorker(settings, group)) throw new Error("That Worker isn't the group's any more, so it wasn't updated.");
    await deployVersion(token, group.account, group.script, release, { jwt: body.jwt, databaseId: group.database, settings });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
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
    const { version, notes } = await response.json();
    const tag = `v${version}`;
    if (!TAG_RE.test(tag)) return { error: "The latest release has an unexpected version." };
    return { tag, version, notes: typeof notes === "string" ? notes.slice(0, 3000) : "", page: `https://github.com/${REPO}/releases/tag/${tag}` };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Whether a newer release is out, for a mark on the owner's Update button. Uses a copy of the latest version kept
 * in settings and refreshed, after the page is sent (`work.waitUntil`), at most every six hours.
 */
export async function updateWaiting(env, work) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'latest_release'").first();
  const known = row ? JSON.parse(row.value) : {};
  if (!known.checked || now() - known.checked > CHECK_SECONDS) {
    const refresh = latestRelease().then((latest) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', ?)")
      .bind(JSON.stringify({ version: latest.version ?? known.version ?? null, checked: now() })).run()).catch(() => {});
    if (work?.waitUntil) work.waitUntil(refresh);
    else await refresh;
  }
  return Boolean(known.version && TAG_RE.test(`v${known.version}`) && newer(known.version, VERSION));
}

function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function updatePage(owner, latest, remembered, groups) {
  const available = latest.version && newer(latest.version, VERSION);
  // Groups this site made that are behind it: brought up to this version, with the same token.
  const groupsPart = groups.length && !available ? `
<section class="card" id="groups">
  <h2>Your groups</h2>
  <p>${groups.map((g) => `${escape(g.name)} (${escape(g.version)})`).join(", ")} ${groups.length === 1 ? "is" : "are"} behind your
  site. Bring ${groups.length === 1 ? "it" : "them"} up to ${escape(VERSION)}:</p>
  ${remembered ? "" : `<p class="meta">This needs a Cloudflare API token that can edit Workers and D1, as above.</p>
  <input id="group-token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token">`}
  <p><button id="groups-go" data-groups="${escape(JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))))}">Update ${groups.length === 1 ? "the group" : "the groups"}</button></p>
  <ol id="group-log"></ol>
  <p id="group-error" role="alert"></p>
</section>` : "";
  const forget = remembered ? `
<p class="meta remembered">Your update token is remembered, so updating is one click.
  <button class="link" id="forget">Forget it</button></p>` : "";
  const notes = latest.notes ? `<section class="card notes"><h2>What's new</h2><p>${escape(latest.notes)}</p></section>` : "";
  const fresh = `
<li><a class="button" href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a>
  <span class="meta">The permissions are filled in: scroll down, press <b>Continue to summary</b>, <b>Create Token</b>, and copy it.</span></li>
<li>Paste it here: <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token">
  <label class="remember"><input type="checkbox" id="remember"> Remember it for future updates
  <span class="meta">It's kept as an encrypted secret of your site, which no one can read back, not even you. It can
  change the Workers in your Cloudflare account, so only tick this if the account is just for afterwrd. You can
  forget it here at any time.</span></label></li>`;
  const rememberNow = remembered ? "" : `
<details class="other" id="save"><summary>Make updating one click next time</summary>
  <ol class="how">${fresh.replace("Remember it for future updates", "Remember it").replace('type="checkbox" id="remember"', 'type="checkbox" id="remember" checked hidden')}
    <li><button id="keep">Remember this token</button></li></ol>
</details>`;
  let body;
  if (latest.error) {
    body = `<p>Couldn't check for a newer version: ${escape(latest.error)}</p>${forget}${rememberNow}<p id="error" role="alert"></p>`;
  } else if (!available) {
    body = `<p>You have the latest version.</p>${forget}${rememberNow}<p id="error" role="alert"></p>`;
  } else {
    body = `
<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">On GitHub</a></p>
${notes}
<p class="meta">Updating keeps everyone's access, your archive and your photos.</p>
${remembered ? `${forget}
<p><button id="go" data-tag="${escape(latest.tag)}" data-version="${escape(latest.version)}">Update to ${escape(latest.version)}</button></p>
<details class="other"><summary>Use a different token</summary><ol class="how">${fresh}</ol></details>` : `
<p class="meta">It needs a Cloudflare API token:</p>
<ol class="how">${fresh}
  <li><button id="go" data-tag="${escape(latest.tag)}" data-version="${escape(latest.version)}">Update to ${escape(latest.version)}</button></li>
</ol>`}
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" class="card" hidden>
  <p><b>Updated to ${escape(latest.version)}.</b> <span id="done-remembered" hidden>Your token is remembered for next time.</span></p>
  <p id="done-delete" hidden>Now delete the token: afterwrd doesn't keep it, but while it exists it can change your Workers.
  <a class="button secondary" href="${TOKENS_PAGE}" target="_blank" rel="noopener">Open my API tokens</a></p>
  <p><a class="button" href="/_admin/update">Done</a></p>
</section>`;
  }
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Update · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
<style>
  .how { padding-left: 1.2rem; }
  .how li { margin: 0.6rem 0; }
  .button, #go { display: inline-block; padding: 0.5rem 1rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .button.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
  #go:disabled { opacity: 0.6; cursor: default; }
  #token { width: 100%; font: inherit; padding: 0.5rem; margin-top: 0.3rem; border: 1px solid var(--border); border-radius: 999px;
    background: var(--bg); color: var(--text); -webkit-text-security: disc; }
  #error { color: #d93025; }
  #done[hidden], #done [hidden] { display: none; }
  .notes h2 { margin: 0 0 0.4rem; font-size: 1rem; }
  .notes p { margin: 0; white-space: pre-wrap; }
  .remember { display: block; margin-top: 0.6rem; }
  .remember .meta { display: block; margin: 0.2rem 0 0 1.5rem; }
  .other { margin: 1rem 0; }
  .other summary { cursor: pointer; color: var(--muted); }
  button.link { padding: 0; border: 0; background: none; color: var(--accent-strong); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
</head>
<body>
${ownerHeader("update")}
<main>
<h1>Update afterwrd</h1>
<p class="meta">Signed in as ${escape(owner.name)}. This site is afterwrd ${escape(VERSION)}.</p>
${body}
${groupsPart}
</main>
<script>
  const go = document.getElementById("go");
  const remembered = ${remembered};
  async function post(path, body) {
    const res = await fetch("/_admin/update/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const forget = document.getElementById("forget");
  if (forget) forget.addEventListener("click", async () => {
    if (!confirm("Forget the remembered token? Next time you'll paste one again. Afterwards, delete the token in Cloudflare too.")) return;
    try {
      await post("forget", {});
      location.assign("${TOKENS_PAGE}");
    } catch (err) {
      alert("Couldn't forget it: " + err.message + " You can also delete the secret UPDATE_TOKEN in the Worker's settings in Cloudflare.");
    }
  });
  const groupsGo = document.getElementById("groups-go");
  if (groupsGo) groupsGo.addEventListener("click", async () => {
    const error = document.getElementById("group-error");
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("group-log").append(li); };
    const token = document.getElementById("group-token")?.value.trim() || "";
    error.textContent = "";
    groupsGo.disabled = true;
    try {
      for (const group of JSON.parse(groupsGo.dataset.groups)) {
        log("Updating " + group.name + "…");
        const { jwt } = await post("group-assets", { token, group: group.id });
        await post("group-deploy", { token, group: group.id, jwt });
      }
      log("Done.");
    } catch (err) {
      error.textContent = err.message;
      groupsGo.disabled = false;
    }
  });
  const keep = document.getElementById("keep");
  if (keep) keep.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const token = document.getElementById("token").value.trim();
    error.textContent = "";
    if (!token) { error.textContent = "Paste your API token first."; return; }
    keep.disabled = true;
    try {
      await post("remember", { token });
      await new Promise((r) => setTimeout(r, 3000)); // the site restarts with the secret
      location.reload();
    } catch (err) {
      error.textContent = err.message;
      keep.disabled = false;
    }
  });
  if (go) go.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const box = document.getElementById("token");
    const token = box ? box.value.trim() : "";
    const remember = Boolean(document.getElementById("remember")?.checked);
    const { tag, version } = go.dataset;
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
    error.textContent = "";
    if (!token && !remembered) { error.textContent = "Paste your API token first."; return; }
    go.disabled = true;
    try {
      log(token ? "Checking the token…" : "Using your remembered token…");
      const { account } = await post("check", { token, tag });
      log("Uploading " + version + "'s site files…");
      const { jwt } = await post("assets", { token, account, tag });
      log("Installing " + version + "…");
      await post("deploy", { token, account, tag, jwt });
      if (token && remember) {
        log("Remembering your token…");
        await post("remember", { token });
      }
      if (box) box.value = "";
      document.getElementById(remembered || (token && remember) ? "done-remembered" : "done-delete").hidden = false;
      log("Waiting for the new version to start…");
      for (let i = 0; i < 30; i++) {
        const res = await fetch("/_admin/update/version", { cache: "no-store" }).catch(() => null);
        if (res && res.ok && (await res.json()).version === version) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      document.getElementById("done").hidden = false;
    } catch (err) {
      // Cloudflare turning the remembered token away usually means it was deleted there.
      error.textContent = err.message + (remembered && !token && /Cloudflare said|Couldn't find a Worker/.test(err.message)
        ? " If you've deleted the remembered token in Cloudflare, use a different token below and tick Remember." : "");
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
