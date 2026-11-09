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
import pkg from "../package.json";
import { connectedToken, tokenFor } from "./cloudflare.js";
import { api, deployVersion, existingDatabase, findWorker, loadRelease, uploadAssets } from "./deploy.js";
import { GROUP_RELEASE, isGroupWorker } from "./groupsites.js";
import { html, json, now, pageData } from "./util.js";
import { updatePage } from "./views/update.js";
import { lastChecked, tooSoonToCheck } from "./checks.js";

const VERSION = pkg.version;
const REPO = pkg.afterwrd.releases;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
// The fallback, a token made by hand: D1 too, so the same token can start and delete groups (groupsites.js).
const PERMISSIONS = [{ key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }];
export const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMISSIONS)) + "&accountId=*&zoneId=all&name=afterwrd%20update";
export const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const CHECK_SECONDS = 900; // how often the dot on the picture (and "Update available") looks for a new release
const REFRESH_WAIT_MS = 1500; // how long a page waits for GitHub's answer when it's the one asking
const FRESH_SECONDS = 300; // how long the Update page trusts its last answer from GitHub

export async function handleUpdate(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/update".length);
  if (request.method === "GET" && path === "") {
    return html(updatePage(pageData(env, await updateData(request, env, url, owner))));
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
      const { account } = await findWorker(token, url.hostname);
      await api(token, `/accounts/${account}/workers/scripts/${script}/secrets/UPDATE_TOKEN`, { method: "DELETE" });
      return json({ ok: true });
    }
    const token = tokenFor(request, body);
    if (path !== "/check" && !/^[0-9a-f]{32}$/.test(body.account ?? "")) throw new Error("Unknown Cloudflare account.");
    const release = () => loadRelease(`https://github.com/${REPO}/releases/download/${body.tag}`);
    if (path === "/check") return json({ account: (await findWorker(token, url.hostname)).account });
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

/** What the Update page shows: this version, the latest release, groups behind, and asking a friend for a check. */
async function updateData(request, env, url, owner) {
  const latest = await latestRelease(env.DB);
  return {
    owner: owner.name, version: VERSION, latest,
    available: Boolean(latest.version && newer(latest.version, VERSION)),
    // The newest release that fixed a security problem, if this site is older than it.
    securityFix: latest.securityFix && newer(latest.securityFix, VERSION) ? latest.securityFix : null,
    site: url.host, connected: Boolean(connectedToken(request)), oldToken: Boolean(env.UPDATE_TOKEN), groups: await groupsBehind(env.DB),
    go: url.searchParams.get("go"), checked: await lastChecked(env.DB), checkWait: tooSoonToCheck(env),
    friends: (await env.DB.prepare(`SELECT id, name FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
      AND their_key IS NOT NULL ORDER BY name COLLATE NOCASE LIMIT 200`).all()).results,
  };
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
    // Noted as checked, so a GitHub that's down or slow is asked again later, not on every page and poll.
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
 * The newer release that's out, if there is one (else null), for the dot on the owner's picture and "Update
 * available" behind it. Uses the copy of the latest version kept in settings, refreshed every 15 minutes or so. The
 * request that refreshes it waits a moment for GitHub's answer, so that page shows it too (before 0.35.1 only the
 * next page did); if GitHub is slow, it finishes after the page is sent. An open page gets the news within 30
 * seconds from live.js asking /_live.
 */
export async function waitingRelease(env, work) {
  const known = await knownRelease(env.DB);
  let { version } = known;
  if (!known.checked || now() - known.checked > CHECK_SECONDS) {
    const refresh = latestRelease(env.DB).catch(() => null);
    if (work?.waitUntil) work.waitUntil(refresh);
    const answer = await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS))]);
    if (typeof answer?.version === "string") version = answer.version;
  }
  return version && TAG_RE.test(`v${version}`) && newer(version, VERSION) ? version : null;
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
