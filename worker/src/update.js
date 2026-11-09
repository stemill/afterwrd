// The owner's Update page: installs a newer afterwrd release over this one, keeping the database, photos and
// secrets. It works with a one-hour token from Cloudflare's own sign-in (cloudflare.js: Connect, press Allow), or,
// if that can't be used, with an API token the owner makes and pastes for the purpose. Nothing is kept afterwards.
//   GET  /_admin/update            the page: this version, and the latest release (with its notes) if it's newer
//   GET  /_admin/update/version    this version, for the page to see when the update has taken over
//   POST /_admin/update/check      {token?, tag} -> which account this Worker is in
//   POST /_admin/update/assets     {token?, account, tag} -> upload the release's site files
//   POST /_admin/update/deploy     {token?, account, tag, jwt} -> the new version
//   POST /_admin/update/forget     delete UPDATE_TOKEN, a token an earlier version remembered (no longer used)
//   POST /_admin/update/group-assets  {token?, group} -> upload this version's site files for a group this site made
//   POST /_admin/update/group-deploy  {token?, group, jwt} -> bring that group's Worker up to this site's version
// Without a token in the request, the connected one is used. Groups (groupsites.js) follow their owner's site: once
// it's updated, this page offers to bring its groups up to the same version.
// Releases come from the GitHub repository in package.json (afterwrd.releases). Every file is checked against
// the release's manifest; as with installing, trust rests on that repository.
import { asset, FAVICON, ownerHeader } from "./nav.js";
import pkg from "../package.json";
import { connectedToken, connectLink, tokenFor } from "./cloudflare.js";
import { api, deployVersion, existingDatabase, findWorker, loadRelease, uploadAssets } from "./deploy.js";
import { GROUP_RELEASE, isGroupWorker } from "./groupsites.js";
import { escape, html, json, now } from "./util.js";
import { checkedWords, lastChecked } from "./checks.js";

const VERSION = pkg.version;
const REPO = pkg.afterwrd.releases;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
// The fallback, a token made by hand: D1 too, so the same token can start and delete groups (groupsites.js).
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=afterwrd%20update";
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const CHECK_SECONDS = 3600; // how often the mark on the Update button (and Home's line) looks for a new release
const FRESH_SECONDS = 300; // how long the Update page trusts its last answer from GitHub

export async function handleUpdate(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/update".length);
  if (request.method === "GET" && path === "") {
    return html(updatePage(owner, await latestRelease(env.DB), {
      site: url.host, connected: Boolean(connectedToken(request)), oldToken: Boolean(env.UPDATE_TOKEN), groups: await groupsBehind(env.DB), go: url.searchParams.get("go"),
      checked: await lastChecked(env.DB),
    }));
  }
  if (request.method === "GET" && path === "/version") return json({ version: VERSION });
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (path === "/group-assets" || path === "/group-deploy") return updateGroup(request, env, path, body);
  try {
    if (path !== "/forget") {
      if (!TAG_RE.test(body.tag ?? "")) throw new Error("Unknown release.");
      // Only ever forward: an older release could bring back problems since fixed.
      if (!newer(body.tag.slice(1), VERSION)) throw new Error("That isn't newer than this site's version.");
    }
    if (!url.hostname.endsWith(".workers.dev")) throw new Error("Updating works from the site's workers.dev address.");
    const script = url.hostname.split(".")[0];
    if (path === "/forget") {
      // A token remembered by a version before 0.20.0: removed with the connected (or pasted) token, or with itself.
      if (!env.UPDATE_TOKEN) return json({ ok: true });
      let token;
      try { token = tokenFor(request, body); } catch { token = env.UPDATE_TOKEN; }
      const { account } = await findWorker(token, script);
      await api(token, `/accounts/${account}/workers/scripts/${script}/secrets/UPDATE_TOKEN`, { method: "DELETE" });
      return json({ ok: true });
    }
    const token = tokenFor(request, body);
    if (path !== "/check" && !/^[0-9a-f]{32}$/.test(body.account ?? "")) throw new Error("Unknown Cloudflare account.");
    const release = () => loadRelease(`https://github.com/${REPO}/releases/download/${body.tag}`);
    if (path === "/check") return json({ account: (await findWorker(token, script)).account });
    if (path === "/assets") return json({ jwt: await uploadAssets(token, body.account, script, await release()) });
    if (path === "/deploy") {
      // A long-lived token an earlier version kept (UPDATE_TOKEN) goes now, while there's a fresh one to remove it
      // with; the update itself keeps every other secret. If it can't be removed, the page still offers Forget.
      if (env.UPDATE_TOKEN) {
        await api(token, `/accounts/${body.account}/workers/scripts/${script}/secrets/UPDATE_TOKEN`, { method: "DELETE" })
          .catch((error) => console.error("Couldn't remove UPDATE_TOKEN:", error.message));
      }
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
async function updateGroup(request, env, path, body) {
  try {
    const token = tokenFor(request, body);
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
// (Only the version is read here; updating downloads the release by tag and checks every file.) The answer is kept
// in settings ('latest_release') and reused for a few minutes, or for longer if GitHub can't be reached.
async function latestRelease(db) {
  const known = await knownRelease(db);
  if (known.latest && now() - known.checked < FRESH_SECONDS) return known.latest;
  let latest;
  try {
    const response = await fetch(`https://github.com/${REPO}/releases/latest/download/manifest.json`, {
      headers: { "User-Agent": "afterwrd" },
    });
    if (!response.ok) throw new Error(`GitHub said ${response.status}.`);
    const { version, notes, security_fix: fix } = await response.json();
    const tag = `v${version}`;
    if (!TAG_RE.test(tag)) throw new Error("The latest release has an unexpected version.");
    latest = { tag, version, notes: typeof notes === "string" ? notes.slice(0, 3000) : "", page: `https://github.com/${REPO}/releases/tag/${tag}` };
    // The newest release that fixed a security problem (package.json afterwrd.securityFix), so a site older than it
    // can say so on Home, even if later releases fixed nothing of the kind.
    if (typeof fix === "string" && TAG_RE.test(`v${fix}`) && !newer(fix, version)) latest.securityFix = fix;
  } catch (error) {
    // Noted as checked, so a GitHub that's down or slow is asked again in an hour, not on every page and poll.
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', ?)")
      .bind(JSON.stringify({ ...known, checked: now() })).run().catch(() => {});
    return known.latest ?? { error: error.message };
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', ?)")
    .bind(JSON.stringify({ version: latest.version, checked: now(), latest })).run();
  return latest;
}

const knownRelease = async (db) => {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'latest_release'").first();
  return row ? JSON.parse(row.value) : {};
};

/**
 * The newer release that's out, if there is one (else null), for a mark on the owner's Update button and a line on
 * Home. Uses the copy of the latest version kept in settings, refreshed at most hourly, after the page is sent
 * (`work.waitUntil`); a page that's open gets the news within 30 seconds from live.js asking /_live.
 */
export async function waitingRelease(env, work) {
  const known = await knownRelease(env.DB);
  if (!known.checked || now() - known.checked > CHECK_SECONDS) {
    const refresh = latestRelease(env.DB).catch(() => {});
    if (work?.waitUntil) work.waitUntil(refresh);
    else await refresh;
  }
  return known.version && TAG_RE.test(`v${known.version}`) && newer(known.version, VERSION) ? known.version : null;
}

export const updateWaiting = async (env, work) => Boolean(await waitingRelease(env, work));

/** The latest release this site knows of, and the newest one that fixed a security problem (for checks.js). */
export async function knownLatest(db) {
  const latest = (await knownRelease(db)).latest;
  return { version: latest?.version ?? null, securityFix: latest?.securityFix ?? null };
}

export { newer };

/** The release that fixed a security problem, if this site is older than it, for a notice on Home; else null. */
export async function securityFixWaiting(db) {
  const fix = (await knownRelease(db)).latest?.securityFix;
  return typeof fix === "string" && TAG_RE.test(`v${fix}`) && newer(fix, VERSION) ? fix : null;
}

function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The Connect button for a step, or a note that it's done, with the by-hand fallback folded away. */
function connectPart(connected, back, what) {
  if (connected) return `<p class="meta connected">Connected to Cloudflare for the next hour.</p>`;
  return `
<p><a class="button" id="connect" href="${escape(connectLink(back))}">Connect Cloudflare</a>
  <span class="meta">Cloudflare asks you to allow afterwrd ${what}, for an hour. Nothing is kept afterwards.</span></p>
<details class="other"><summary>If connecting doesn't work, use an API token</summary>
  <ol class="how">
    <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a> in Cloudflare.
      <span class="meta">The permissions are filled in: scroll down, press <b>Continue to summary</b>, <b>Create Token</b>, and copy it.</span></li>
    <li>Paste it here: <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token" aria-label="Your API token">
      <span class="meta">It's used only now, and then you delete it in Cloudflare (My Profile → API Tokens).</span></li>
  </ol>
</details>`;
}

function updatePage(owner, latest, { site, connected, oldToken, groups, go, checked = null }) {
  const available = latest.version && newer(latest.version, VERSION);
  // Groups this site made that are behind it: brought up to this version, with the same connection.
  const groupsPart = groups.length && !available ? `
<section class="card" id="groups">
  <h2>Your groups</h2>
  <p>${groups.map((g) => `${escape(g.name)} (${escape(g.version)})`).join(", ")} ${groups.length === 1 ? "is" : "are"} behind your
  site. Bring ${groups.length === 1 ? "it" : "them"} up to ${escape(VERSION)}:</p>
  ${connectPart(connected, "/_admin/update?go=groups", "to change the groups' Workers")}
  <p><button id="groups-go" data-groups="${escape(JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))))}">Update ${groups.length === 1 ? "the group" : "the groups"}</button></p>
  <ol id="group-log"></ol>
  <p id="group-error" role="alert"></p>
</section>` : "";
  // A token kept by a version before 0.20.0, which nothing uses any more.
  const forget = oldToken ? `
<section class="card" id="old-token">
  <p>An earlier version kept a Cloudflare API token on this site. afterwrd no longer needs one: updating now asks Cloudflare
  each time, for an hour. <button class="link" id="forget">Forget it</button>, then delete the token in Cloudflare too
  (<a href="${TOKENS_PAGE}" target="_blank" rel="noopener">My Profile → API Tokens</a>).</p>
  <p id="forget-error" role="alert"></p>
</section>` : "";
  const notes = latest.notes ? `<section class="card notes"><h2>What's new</h2><p>${escape(latest.notes)}</p></section>` : "";
  let body;
  if (latest.error) {
    body = `<p>Couldn't check for a newer version: ${escape(latest.error)}</p>`;
  } else if (!available) {
    body = `<p>You have the latest version.</p>`;
  } else {
    body = `
<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">On GitHub</a></p>
${latest.securityFix && newer(latest.securityFix, VERSION) ? `<p class="security"><b>It fixes a security problem</b> (in ${escape(latest.securityFix)}), so it's worth updating soon.</p>` : ""}
${notes}
<p class="meta">Updating keeps everyone's access, your archive and your photos.</p>
${connectPart(connected, "/_admin/update?go=update", "to change this site's Worker")}
<p><button id="go" data-tag="${escape(latest.tag)}" data-version="${escape(latest.version)}">Update to ${escape(latest.version)}</button></p>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" class="card" hidden>
  <p><b>Updated to ${escape(latest.version)}.</b></p>
  <p class="meta">If a friend has afterwrd, it's worth <a href="#check">asking them to check your site</a> now.</p>
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
  .button, #go, #groups-go { display: inline-block; padding: 0.5rem 1rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .button + .meta { display: block; margin-top: 0.4rem; }
  #go:disabled, #groups-go:disabled { opacity: 0.6; cursor: default; }
  #token { width: 100%; font: inherit; padding: 0.5rem; margin-top: 0.3rem; border: 1px solid var(--border); border-radius: 999px;
    background: var(--bg); color: var(--text); -webkit-text-security: disc; }
  #error, #group-error, #forget-error { color: #d93025; }
  .security { padding: 0.6rem 0.9rem; border-left: 3px solid var(--danger); border-radius: 10px; background: var(--tint-4); }
  #done[hidden], #done [hidden] { display: none; }
  .notes h2, #check h2 { margin: 0 0 0.4rem; font-size: 1rem; }
  #ask-message { width: 100%; font: inherit; padding: 0.6rem; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text); }
  .notes p { margin: 0; white-space: pre-wrap; }
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
<section class="card" id="check">
  <h2>Ask a friend to check your site</h2>
  <p id="last-checked">${checked ? escape(checkedWords(checked)) : "Your site hasn't been checked yet."}</p>
  <p class="meta">A friend's afterwrd site can check that yours is exactly the published afterwrd, with nothing else done in
  your Cloudflare account. Worth doing when your site is new, and after updates. This writes a message for you to send
  them however you usually would: your site doesn't contact anyone, so a site that had been tampered with couldn't fake
  the check.</p>
  <p><button class="chip" id="ask-check">Ask a friend to check my site</button></p>
  <form method="post" action="/_admin/checks/myself?back=update" class="meta">Or <a href="https://afterwrd.app/check/">check it
    yourself</a>, and then <button class="link">say you've checked it</button>.</form>
  <div id="ask-panel" hidden>
    <textarea id="ask-message" readonly rows="5" aria-label="Message asking for a check">Could you check that my afterwrd site is genuine? It's at ${escape(site)}. On your afterwrd site, go to Friends, paste this message under "Checking a friend's site", press "Make a check link", and send me the link it makes. Thank you!</textarea>
    <p class="row"><button class="chip primary" id="ask-copy">Copy message</button>
      <button class="chip" id="ask-share" hidden>Share…</button></p>
  </div>
</section>
${groupsPart}
${forget}
</main>
<script>
  const go = document.getElementById("go");
  // Asking a friend for a check: only a message to send, nothing sent from here.
  document.getElementById("ask-check").addEventListener("click", () => {
    document.getElementById("ask-panel").hidden = false;
    document.getElementById("ask-message").select();
  });
  document.getElementById("ask-copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(document.getElementById("ask-message").value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy message"; }, 1500);
  });
  const askShare = document.getElementById("ask-share");
  if (navigator.share) {
    askShare.hidden = false;
    askShare.addEventListener("click", () => navigator.share({ text: document.getElementById("ask-message").value }).catch(() => {}));
  }
  const connected = ${connected};
  const autoGo = ${JSON.stringify(go === "update" || go === "groups" ? go : null)};
  async function post(path, body) {
    const res = await fetch("/_admin/update/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const pasted = () => document.getElementById("token")?.value.trim() || "";
  const forget = document.getElementById("forget");
  if (forget) forget.addEventListener("click", async () => {
    if (!confirm("Forget the old token? Afterwards, delete it in Cloudflare too.")) return;
    try {
      await post("forget", {});
      location.assign("${TOKENS_PAGE}");
    } catch (err) {
      document.getElementById("forget-error").textContent = "Couldn't forget it: " + err.message
        + " You can also delete the secret UPDATE_TOKEN in the Worker's settings in Cloudflare.";
    }
  });
  const groupsGo = document.getElementById("groups-go");
  if (groupsGo) groupsGo.addEventListener("click", async () => {
    const error = document.getElementById("group-error");
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("group-log").append(li); };
    const token = pasted();
    error.textContent = "";
    if (!token && !connected) { error.textContent = "Connect Cloudflare first."; return; }
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
  if (go) go.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const token = pasted();
    const { tag, version } = go.dataset;
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
    error.textContent = "";
    if (!token && !connected) { error.textContent = "Connect Cloudflare first."; return; }
    go.disabled = true;
    try {
      log("Checking your Cloudflare account…");
      const { account } = await post("check", { token, tag });
      log("Uploading " + version + "'s site files…");
      const { jwt } = await post("assets", { token, account, tag });
      log("Installing " + version + "…");
      await post("deploy", { token, account, tag, jwt });
      const box = document.getElementById("token");
      if (box) box.value = "";
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
  // Back from Connect: carry on with what was asked for.
  if (connected && autoGo) {
    history.replaceState(null, "", "/_admin/update");
    (autoGo === "groups" ? groupsGo : go)?.click();
  }
</script>
</body>
</html>`;
}
