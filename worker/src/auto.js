// Automatic updates (docs/security-and-install-plan.md, section 6). Once the owner allows "Background Access" for
// updating (one Allow, Workers Editor only), the site updates itself to each new release Ste has signed (signing.js),
// once it's been out for a few days, and its groups after it. Nobody has to do anything; the owner can turn it off.
//
// Turning it on and off (the owner, signed in):
//   GET  /_cloudflare/auto-start      (?then=checks: straight on to letting friends' sites check it, friendchecks.js)
//                                     a PKCE secret in a short cookie, then off to the relay page, which asks Cloudflare
//                                     for `offline_access workers-scripts.edit` only (installer/connect.html)
//   GET  /_cloudflare/auto-done       back from the relay: posts the code to…
//   POST /_cloudflare/auto-finish     swaps it for a refresh token (kept in the outbox's vault, never in D1), sets the
//                                     Worker's daily schedule, and turns automatic updates on
//   POST /_admin/update/auto-off      clears the schedule and forgets the refresh token (Revoke in Cloudflare too)
// The daily run (the Worker's cron trigger, at a random minute set when it was turned on): runAuto() below, which
// works out what to do and has each step done by a request to the site's own address, so each step gets its own
// 50 outside calls (the free plan's limit per request). Those requests carry a key from the vault; nothing else can
// make them (handleAutoStep):
//   POST /_auto/step {step: "assets" | "stage" | "switch" | "groups", …}
// Once the site itself has switched, "groups" is asked of the new version (the old one can only hand out its own
// code), so the site's groups follow in the same run.
// "Install it now" on the Update page is the same run, started by the owner: it doesn't wait out the days, and it
// tries a release that didn't take before, but only ever installs what's signed.
// "switch" is the careful part. It runs in the version that's live now (the old one), so a new version that breaks
// can't be the thing that's meant to undo it: it notes the live version, makes the staged one live, then asks the
// site's own /_version?health=1 (which runs the database migrations and a few typical reads) until the new version
// answers. Healthy: done. Errors, or no answer within a few minutes: the old version is put back at once, that release
// is marked as not taking (never tried again by itself), and Home says so. The database isn't restored (the update
// grant has no database access), and migrations may change anything (migrate.js), so once the new version has
// changed the database the old one can't run on it: then the new version is kept, and Home says what happened.
// (Versions before 0.41.0 didn't know this, and put the old version back regardless.) The time of every switch is
// kept for a later, owner-chosen restore.
import pkg from "../package.json";
import { exchangeCode, pkce, readCookie, RELAY, testingHere, withCookie, CODE_RE, donePage } from "./cloudflare.js";
import { existingDatabase, findWorker, liveVersion, loadRelease, stageVersion, switchTo, uploadAssets, useApiBase, api } from "./deploy.js";
import { isGroupWorker } from "./groupsites.js";
import { checkNewer, ensureSchema } from "./migrate.js";
import { releaseKey, signedList } from "./signing.js";
import { askFriendsToCheckSoon, checkGrant, friendCheckStep } from "./friendchecks.js";
import { groupsBehind } from "./update.js";
import { json, now, html } from "./util.js";

const VERSION = pkg.version;
const REPO = pkg.afterwrd.releases;
export const AUTO_SCOPES = "offline_access workers-scripts.edit";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const WAIT_SECONDS = 3 * 86400; // a release has been out this long before sites take it by themselves…
const SECURITY_WAIT_SECONDS = 86400; // …or this long, if it fixes a security problem
const HEALTH_MS = 180_000; // how long a switch waits for the new version to answer healthily
const HEALTH_EVERY_MS = 6000;
const LOCK_SECONDS = 360; // one run at a time (a run takes at most about four minutes; one cut off frees itself after this)
const KEEP_FRESH_SECONDS = 6 * 86400; // the grant is used at least this often, even with nothing to install
const TRIES = 2; // a release that fails this many times isn't tried again by itself
const GROUPS_PER_RUN = 3; // groups updated by one run of the schedule…
const GROUPS_NOW = 8; // …or when the owner is waiting for it on the Update page
const START_COOKIE = "cf_auto";
const START_SECONDS = 600;
const SETTINGS_KEY = "auto_update";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// --- what's kept --------------------------------------------------------------------------------------------------

/** What the Update page and Home show, and what the run needs: {on, origin, cron, since, last, waiting, failed}. */
export async function autoState(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTINGS_KEY).first().catch(() => null);
  const state = row ? JSON.parse(row.value) : {};
  return { on: false, failed: [], ...state };
}

// Merged in one statement (JSON merge patch: a null removes that field), so writes from a run, its steps and the
// owner's page can't undo each other.
async function saveState(db, change) {
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?1, json_patch('{}', ?2))
    ON CONFLICT(key) DO UPDATE SET value = json_patch(settings.value, ?2)`).bind(SETTINGS_KEY, JSON.stringify(change)).run();
}

// The secrets live in an Outbox object of their own, named "vault": separate storage from the queue of notes to
// friends' sites (the object called "outbox"), whose alarm and sending code never see it. Not a class of its own, as a
// new class can't be installed carefully (scripts/release.mjs refuses one without --new-store).
const vault = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("vault"));

// --- turning it on and off ----------------------------------------------------------------------------------------

/** The owner's Connect for background access: GET /_cloudflare/auto-start, /auto-done, POST /auto-finish. Null otherwise. */
export async function handleAutoConnect(request, env, url) {
  const path = url.pathname.slice("/_cloudflare".length);
  if (request.method === "GET" && path === "/auto-start") {
    // Only from this site's own pages (or typed in), as with Connect.
    const from = request.headers.get("Sec-Fetch-Site");
    if (from && from !== "same-origin" && from !== "none") return json({ error: "Start from your own site." }, 403);
    const { verifier, state, challenge } = await pkce();
    const relay = new URL(RELAY);
    relay.searchParams.set("to", `${url.origin}/_cloudflare/auto-done`);
    relay.searchParams.set("state", state);
    relay.searchParams.set("challenge", challenge);
    const then = url.searchParams.get("then") === "checks" ? ".checks" : "";
    return withCookie(Response.redirect(relay.toString(), 302),
      `${START_COOKIE}=${state}.${verifier}${then}; Path=/_cloudflare; Max-Age=${START_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
  }
  if (request.method === "GET" && path === "/auto-done") return html(donePage("/_cloudflare/auto-finish"));
  if (request.method === "POST" && path === "/auto-finish") {
    const clear = `${START_COOKIE}=; Path=/_cloudflare; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    const [state, verifier, then] = (readCookie(request, START_COOKIE) ?? "").split(".");
    const body = await request.json().catch(() => ({}));
    if (!state || !verifier) return withCookie(json({ error: "This has expired. Start again from your Update page." }, 400), clear);
    if (body.state !== state) return withCookie(json({ error: "That isn't what this site started. Start again." }, 400), clear);
    if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return withCookie(json({ error: "Cloudflare didn't send a code." }, 400), clear);
    try {
      const data = await exchangeCode(env, body.code, verifier, url.origin);
      await turnOn(env, url, data);
    } catch (error) {
      return withCookie(json({ error: error.message }, 400), clear);
    }
    // Asked for both at once (Home): on to friends' checks, one more Allow, unless they're already allowed.
    const next = then === "checks" && !(await checkGrant(env.DB)).on ? "/_cloudflare/checks-start" : "/_admin/update#auto";
    return withCookie(json({ back: next }), clear);
  }
  return null;
}

async function turnOn(env, url, data) {
  if (typeof data.refresh_token !== "string" || !CODE_RE.test(data.refresh_token)) {
    throw new Error("Cloudflare didn't give background access, so automatic updates are still off. Try again, and leave Background Access ticked.");
  }
  // Only ever the narrow grant (Workers Editor and Background Access): anything broader isn't kept, so a tampered relay
  // page can't leave a wider lasting grant here.
  // Cloudflare always says what it gave; an answer that doesn't isn't trusted.
  const granted = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : null;
  if (!granted || granted.some((scope) => !AUTO_SCOPES.split(" ").includes(scope))) {
    throw new Error("Cloudflare gave more access than automatic updates need, so it wasn't kept. Nothing has changed.");
  }
  testApi(env, url.origin);
  const { account, script } = await whichWorker(env, data.access_token, url.origin);
  // A random time each day, so sites don't all ask GitHub and Cloudflare at once.
  const cron = `${Math.floor(Math.random() * 60)} ${Math.floor(Math.random() * 24)} * * *`;
  await api(data.access_token, `/accounts/${account}/workers/scripts/${script}/schedules`, { method: "PUT", body: JSON.stringify([{ cron }]) });
  const box = vault(env);
  await box.keepSecret("auto_refresh", data.refresh_token);
  await box.keepSecret("auto_key", randomKey()); // a new key each time they're turned on
  await saveState(env.DB, { on: true, origin: url.origin, account, script, cron, since: now(), refreshedAt: now(), problem: null, offPending: null });
}

/** POST /_admin/update/auto-off: clears the schedule (if the grant still works) and forgets the grant. */
export async function turnOff(env, url) {
  // A run under way may be switching versions with a token from the grant: forgetting the grant now would end that
  // token, and with it the chance to put the old version back. So it's off at once, and the run tidies up as it ends.
  if (await runningSince(env.DB)) {
    await saveState(env.DB, { on: false, offPending: true, waiting: null, problem: null });
    return;
  }
  await finishTurningOff(env, url.origin);
}

async function finishTurningOff(env, origin) {
  const url = { origin };
  const state = await autoState(env.DB);
  testApi(env, url.origin);
  try {
    const token = await accessToken(env, url.origin);
    if (token && state.account && state.script) {
      await api(token, `/accounts/${state.account}/workers/scripts/${state.script}/schedules`, { method: "PUT", body: "[]" });
    }
  } catch (error) {
    console.error("Turning off automatic updates: couldn't clear the schedule:", error.message);
  }
  await vault(env).keepSecret("auto_refresh", null);
  await vault(env).keepSecret("auto_key", null);
  await saveState(env.DB, { on: false, waiting: null, problem: null, offPending: null });
}

/** "Not now" on Home's offer. */
export const laterAuto = (env) => saveState(env.DB, { later: now() });

// --- the daily run ------------------------------------------------------------------------------------------------

/** When a run that's still going started (seconds), or null: for "already running" on the Update page. */
export async function runningSince(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'auto_lock'").first().catch(() => null);
  const since = Number.parseInt(row?.value, 10); // the lock is "<time>:<run>"
  return Number.isFinite(since) && since > now() - LOCK_SECONDS ? since : null;
}

/**
 * The Worker's cron trigger, and "Install it now" on the Update page ({now: true}: no waiting the days out). False if
 * another run is still going.
 */
export async function runAuto(env, { now: ownerAsked = false } = {}) {
  await ensureSchema(env);
  const state = await autoState(env.DB);
  if (!state.on || !state.origin) return true;
  // One run at a time: the lock ("<time>:<run>") is taken only if there isn't a fresh one. Each line of progress
  // renews it, so a long run keeps it; only this run removes it.
  const run = randomKey().slice(0, 16);
  const taken = await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('auto_lock', ?1)
    ON CONFLICT(key) DO UPDATE SET value = ?1 WHERE CAST(settings.value AS INTEGER) < ?2`).bind(`${now()}:${run}`, now() - LOCK_SECONDS).run();
  if (!taken.meta?.changes) return false;
  try {
    await saveState(env.DB, { progress: [] });
    await runOnce(env, state, ownerAsked);
  } catch (error) {
    if (!error.off) {
      console.error("Automatic update:", error.message);
      await saveState(env.DB, { lastRun: Date.now(), problem: plain(error), lastCheck: { at: now(), words: `It couldn't run: ${plain(error)}` } });
    }
  } finally {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'auto_lock' AND value LIKE ?").bind(`%:${run}`).run();
    // Turned off while it ran: now nothing is using the grant, it can go.
    if ((await autoState(env.DB)).offPending) await finishTurningOff(env, state.origin).catch((error) => console.error("Turning off:", error.message));
  }
  return true;
}

/**
 * "Install it now": the run is started by the vault's alarm (outbox.js), not by the owner's page, so closing the page
 * or a phone locking can't cut it off halfway through a switch. The page watches GET /_admin/update/progress.
 */
export async function startRunNow(env, origin) {
  await saveState(env.DB, { askedAt: Date.now() });
  await vault(env).runSoon(origin);
}

/** A problem cleared, unless automatic updates have just turned themselves off (whose reason stays). */
const clearProblem = async (env) => ((await autoState(env.DB)).on ? { problem: null } : {});

async function runOnce(env, state, ownerAsked = false) {
  const origin = state.origin;
  // The steps carry the vault's key and a working token, so they only ever go to this site's own address.
  if (!ownAddress(env, origin, state.script)) throw new Error("The site's address on record isn't its workers.dev address. Turn automatic updates off and on again.");
  testApi(env, origin);
  await finishSwitch(env, origin, state);
  const list = await signedList(env, origin);
  if (!list && releaseKey(env, origin)) {
    // (A list signed by an older sign.mjs, without its second signature, isn't believed by this version.)
    await saveState(env.DB, { lastRun: Date.now(), lastCheck: { at: now(), words: "Couldn't read the signed list of releases, so nothing was installed. It'll look again tomorrow." } });
    return;
  }
  // A signed list never goes backwards: an older one, put back by someone with the repository, isn't believed.
  if (list && list.seq < (state.listSeq ?? 0)) throw new Error("The list of signed releases went backwards, so nothing was installed.");
  if (list && list.seq > (state.listSeq ?? 0)) await saveState(env.DB, { listSeq: list.seq });
  // The owner pressing "Install it now" doesn't wait the days out, and may try a release that didn't take before.
  const choice = await chooseRelease(env, origin, list, ownerAsked ? [] : state.failed ?? [], fetch, { noWait: ownerAsked });
  const stillOn = async () => {
    if (!(await autoState(env.DB)).on) throw Object.assign(new Error("Turned off while running."), { off: true });
  };
  // Already found to need installing by hand: not uploaded again every day.
  if (choice.ready && state.waiting?.needsHand && state.waiting.version === choice.ready.version) {
    await saveState(env.DB, { lastRun: Date.now(), ...(await clearProblem(env)),
      lastCheck: { at: now(), words: `afterwrd ${choice.ready.version} is waiting for you to install it by hand.` } });
    return;
  }
  if (choice.ready) {
    const token = await accessToken(env, origin);
    if (!token) throw new Error("Cloudflare no longer allows background access. Turn automatic updates on again from the Update page.");
    const { account, script } = await whichWorker(env, token, origin);
    const common = { token, account, script, version: choice.ready.version, manifestSha256: choice.ready.manifestSha256 };
    await progress(env, `Uploading afterwrd ${choice.ready.version}'s site files…`);
    const { jwt } = await step(env, origin, { step: "assets", ...common });
    await stillOn();
    await progress(env, `Uploading afterwrd ${choice.ready.version} (not live yet)…`);
    const staged = await step(env, origin, { step: "stage", ...common, jwt });
    if (staged.needsHand) {
      await saveState(env.DB, { lastRun: Date.now(), waiting: { version: choice.ready.version, needsHand: true }, ...(await clearProblem(env)),
        lastCheck: { at: now(), words: `afterwrd ${choice.ready.version} has to be installed by hand.` } });
      return;
    }
    await stillOn();
    await progress(env, `Switching to afterwrd ${choice.ready.version} and checking it works (this can take a few minutes)…`);
    const switched = await step(env, origin, { step: "switch", token, account, script, versionId: staged.versionId });
    const last = { at: now(), version: choice.ready.version, from: VERSION, result: switched.result, previous: switched.previous };
    // Tried again once (a passing hiccup shouldn't turn down a security fix for good), then not by itself.
    const tries = { ...(state.tries ?? {}), [choice.ready.version]: (state.tries?.[choice.ready.version] ?? 0) + (["done", "kept"].includes(switched.result) ? 0 : 1) };
    const failed = tries[choice.ready.version] >= TRIES ? [...new Set([...(state.failed ?? []), choice.ready.version])].slice(-20) : state.failed;
    let groupWords = "";
    if (switched.result === "done") {
      await progress(env, `Your site is on afterwrd ${choice.ready.version}.`);
      groupWords = await groupsByNewVersion(env, origin, choice.ready.version, ownerAsked);
      await askFriendsToCheckSoon(env).catch(() => {});
    }
    const words = switched.result === "done" ? `Installed afterwrd ${choice.ready.version}.${groupWords ? ` ${groupWords}` : ""}`
      : switched.result === "kept" ? `afterwrd ${choice.ready.version} had already updated your site's database when it failed its checks, so it was kept: the older version can't run on it.`
      : `afterwrd ${choice.ready.version} didn't ${switched.result === "unhealthy" ? "work" : "start"}, so the site was put back as it was.`;
    await saveState(env.DB, { lastRun: Date.now(), last, failed, tries, waiting: null, ...(await clearProblem(env)), lastCheck: { at: now(), words } });
    return;
  }
  // Nothing for the site itself: bring its groups up to its version, a few at a time.
  const { told, tried } = await runGroups(env, origin, list, ownerAsked ? GROUPS_NOW : GROUPS_PER_RUN);
  if (!tried && now() - (state.refreshedAt ?? 0) > KEEP_FRESH_SECONDS && !(await accessToken(env, origin))) {
    // With nothing to do for a while, the grant is still used now and then, so Cloudflare doesn't let it lapse.
    throw new Error("Cloudflare no longer allows background access. Turn automatic updates on again from the Update page.");
  }
  const words = told.length ? `${told.join("; ")}.`.replace(/^./, (c) => c.toUpperCase())
    : choice.waiting?.version ? `Nothing to install yet: afterwrd ${choice.waiting.version} is waiting until ${new Date(choice.waiting.after * 1000).toUTCString().slice(5, 22)} UTC.`
    : "Nothing new to install, and your groups are up to date.";
  await saveState(env.DB, { lastRun: Date.now(), waiting: choice.waiting ?? null, ...(await clearProblem(env)), lastCheck: { at: now(), words } });
}

/**
 * A switch that was cut off (its step's request ended before it could check the new version, or put the old one
 * back): looked at now. If the new version is live and healthy, all's well. If it's live and not healthy, it isn't
 * put back from here: the version running this can't tell whether the database has changed under the old one, so it
 * says so instead (Home), and it's for the owner to decide.
 */
async function finishSwitch(env, origin, state) {
  const was = state.switching;
  if (!was?.versionId || was.at > now() - LOCK_SECONDS) return;
  await saveState(env.DB, { switching: null });
  const token = await accessToken(env, origin);
  if (!token) return;
  const { account, script } = await whichWorker(env, token, origin);
  const live = await liveVersion(token, account, script);
  if (live !== was.versionId) return; // it never went live, or was already put back
  const check = healthCheck(env, origin);
  for (let i = 0; i < 5; i++) {
    if ((await check(was.versionId).catch(() => null))?.healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  // (Thrown, so the run stops here and the Update page and Home say it.)
  throw new Error("An update was cut off partway, and the new version isn't answering as it should. Please tell whoever looks after afterwrd.");
}

/**
 * Brings the groups this site made up to this site's version, at most `limit` of them: only to a version Ste signed
 * (the site's own may have been installed by hand), and exactly as signed. {told: [words], tried: whether any were}.
 */
async function runGroups(env, origin, list, limit) {
  const pinned = list?.releases.get(VERSION)?.manifestSha256 ?? null;
  const groups = pinned ? await groupsBehind(env.DB) : [];
  const told = []; // what happened to each group, for the Update page
  if (!groups.length) return { told, tried: false };
  const token = await accessToken(env, origin);
  if (!token) throw new Error("Cloudflare no longer allows background access. Turn automatic updates on again from the Update page.");
  const results = { ...((await autoState(env.DB)).groups ?? {}) };
  for (const group of groups.slice(0, limit)) {
    if (!(await autoState(env.DB)).on) throw Object.assign(new Error("Turned off while running."), { off: true });
    await progress(env, `Updating ${String(group.name).slice(0, 100)}…`);
    const common = { token, group: group.id, manifestSha256: pinned };
    let result;
    try {
      const { jwt } = await step(env, origin, { step: "group-assets", ...common });
      const staged = await step(env, origin, { step: "group-stage", ...common, jwt });
      result = staged.needsHand ? "needs-hand"
        : (await step(env, origin, { step: "group-switch", ...common, versionId: staged.versionId })).result;
    } catch (error) {
      console.error(`Automatic update of group ${group.id}:`, error.message);
      result = `error: ${plain(error).slice(0, 200)}`;
    }
    results[group.id] = { name: String(group.name).slice(0, 100), version: VERSION, result, at: now() };
    const words = result === "done" ? `brought ${group.name} up to ${VERSION}`
      : result === "needs-hand" ? `${group.name} has to be updated by hand`
      : result.startsWith("error") ? `couldn't update ${group.name} (${result.slice(7)})`
      : `${group.name} didn't take ${VERSION}, so it was put back`;
    told.push(words);
    await progress(env, `${words.replace(/^./, (c) => c.toUpperCase())}.`);
  }
  if (groups.length > limit) told.push(`${groups.length - limit} more ${groups.length - limit === 1 ? "follows" : "follow"} at the next daily look`);
  await saveState(env.DB, { groups: results });
  return { told, tried: true };
}

/**
 * Once the site itself is on `version`, its groups are brought up to it by the new version (the old one only has its
 * own code to hand out): the run asks its own address for the "groups" step, which only the new version answers.
 * Words for the Update page.
 */
async function groupsByNewVersion(env, origin, version, ownerAsked) {
  for (let i = 0; i < 5; i++) {
    try {
      const answer = await step(env, origin, { step: "groups", version, now: ownerAsked });
      if (!answer.notYet) {
        return answer.told?.length ? `${answer.told.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : "";
      }
    } catch (error) {
      console.error("Groups after the update:", error.message);
      return "Your groups follow at the next daily look.";
    }
    // The old version answered: Cloudflare is still switching. (On this computer the code never changes, so not long.)
    await new Promise((resolve) => setTimeout(resolve, testingHere(env, origin) && Number(env.TEST_HEALTH_MS) > 0 ? 100 : 3000));
  }
  return "Your groups follow at the next daily look.";
}

/** A line for the Update page to show while the owner waits ("Install it now"). */
async function progress(env, line) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE settings SET value = json_insert(value, '$.progress[#]', ?) WHERE key = ?
      AND json_array_length(value, '$.progress') < 30`).bind(String(line).slice(0, 300), SETTINGS_KEY),
    // A run that's still saying what it's doing is still going.
    env.DB.prepare(`UPDATE settings SET value = ?1 || substr(value, instr(value, ':')) WHERE key = 'auto_lock'`).bind(String(now())),
  ]);
}

/**
 * The newest release in the signed list that's newer than this site, hasn't failed here, and has been out long
 * enough: {ready: {version, manifestSha256}}, and/or, if one is signed but still waiting, {waiting: {version, after}}.
 */
export async function chooseRelease(env, origin, list, failed = [], fetcher = fetch, { noWait = false } = {}) {
  if (!releaseKey(env, origin)) return { waiting: { unsigned: true } };
  if (!list) return { waiting: null };
  let waiting = null;
  const candidates = [...list.releases.entries()]
    .filter(([version]) => newer(version, VERSION) && !failed.includes(version))
    .sort(([a], [b]) => (newer(a, b) ? -1 : 1))
    .slice(0, 5);
  for (const [version, signed] of candidates) {
    if (signed.signedAt > now() + 300) continue; // from the future: something's wrong
    const response = await fetcher(`${releasesBase(env, origin)}/v${version}/manifest.json`, { headers: { "User-Agent": "afterwrd" } }).catch(() => null);
    const length = Number(response?.headers?.get("Content-Length") ?? 0);
    const manifest = response?.ok && length < 2_000_000 ? new Uint8Array(await response.arrayBuffer()) : null;
    if (!manifest || manifest.length > 2_000_000 || (await sha256hex(manifest)) !== signed.manifestSha256) continue; // not what was signed
    const fixes = (() => { try { return JSON.parse(new TextDecoder().decode(manifest)).security_fix === version; } catch { return false; } })();
    const after = signed.signedAt + waitFor(env, fixes);
    if (noWait || now() >= after) return { ready: { version, manifestSha256: signed.manifestSha256, after }, waiting };
    waiting ??= { version, after };
  }
  return { waiting };
}

/**
 * How long a signed release waits before sites take it. A site's owner can shorten it for their own site with the
 * Worker secret TEST_AUTO_WAIT_SECONDS (for trying automatic updates out; a friend's check shows it as a secret
 * afterwrd doesn't use).
 */
function waitFor(env, fixes) {
  const test = Number(env.TEST_AUTO_WAIT_SECONDS);
  if (Number.isFinite(test) && test >= 0 && env.TEST_AUTO_WAIT_SECONDS !== undefined && env.TEST_AUTO_WAIT_SECONDS !== "") return Math.floor(test);
  return fixes ? SECURITY_WAIT_SECONDS : WAIT_SECONDS;
}

/**
 * For the owner's own Update page (update.js): a token from automatic updates' background grant, so updating by hand
 * needs no Connect while they're on. Null if they're off. (Workers Editor: enough to update this site and its groups.)
 */
export async function backgroundToken(env, origin) {
  if (!(await autoState(env.DB)).on) return null;
  testApi(env, origin);
  return accessToken(env, origin);
}

/** A fresh access token from the background grant, keeping the new refresh token first; null if there's no grant. */
async function accessToken(env, origin) {
  const box = vault(env);
  const refresh = await box.secret("auto_refresh");
  if (!refresh) return null;
  const endpoint = testingHere(env, origin) && env.OAUTH_TOKEN_URL ? env.OAUTH_TOKEN_URL : TOKEN_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: pkg.afterwrd.cloudflareClient }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string" || !CODE_RE.test(data.access_token)) {
    // Refused (revoked in Cloudflare, say): the grant is no use any more, so automatic updates are off until it's
    // allowed again (the run says why).
    if (response.status === 400 || response.status === 401) {
      await box.keepSecret("auto_refresh", null);
      // Noted, and kept after they're turned on again, so it can be seen that it happened (and when). Home says so.
      await saveState(env.DB, { on: false, refusedAt: now(),
        problem: "Cloudflare no longer allows background access, so automatic updates turned themselves off. Turn them on again from the Update page." });
    }
    return null;
  }
  if (typeof data.refresh_token === "string" && CODE_RE.test(data.refresh_token)) await box.keepSecret("auto_refresh", data.refresh_token);
  await saveState(env.DB, { refreshedAt: now() });
  return data.access_token;
}

/** Has the site's own address do one step (handleAutoStep), with the vault's key; throws with its message if it fails. */
export async function step(env, origin, body) {
  const key = await vault(env).secret("auto_key");
  if (!key) throw new Error("The key for automatic updates is missing. Turn them off and on again.");
  const response = await fetch(`${origin}/_auto/step`, {
    method: "POST", redirect: "manual",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The ${body.step} step failed (${response.status}).`);
  return data;
}

// --- the steps, each a request of its own -------------------------------------------------------------------------

/** POST /_auto/step, from the site's own run only (the vault's key). */
export async function handleAutoStep(request, env, url) {
  if (request.method !== "POST" || url.pathname !== "/_auto/step") return new Response("Not found", { status: 404 });
  const given = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!given) return new Response("Not found", { status: 404 }); // without even asking the vault
  const key = await vault(env).secret("auto_key");
  if (!key || !(await sameSecret(given, key))) return new Response("Not found", { status: 404 });
  testApi(env, url.origin);
  const body = await request.json().catch(() => ({}));
  try {
    // "Install it now", from the vault's alarm (startRunNow): the run, waited for by the vault, not the owner's page.
    if (body.step === "run-now") return json({ ran: await runAuto(env, { now: true }) });
    // Checking a friend's site (friendchecks.js): the token is theirs, for reading their account.
    if (typeof body.step === "string" && body.step.startsWith("fc-")) return json(await friendCheckStep(env, url.origin, body));
    if (body.step === "groups") {
      // Asked by the version before this one, just after it switched to this one. If Cloudflare sent the request to
      // the old version instead, it says so, and the run asks again.
      // (On this computer the code never changes, so a test says which Worker it's standing in for instead.)
      if (body.version !== VERSION && !(testingHere(env, url.origin) && env.TEST_WORKER)) return json({ notYet: true });
      const state = await autoState(env.DB);
      if (!state.on) return json({ told: [] });
      const list = await signedList(env, url.origin);
      if (list && list.seq < (state.listSeq ?? 0)) throw new Error("The list of signed releases went backwards.");
      return json(await runGroups(env, url.origin, list, body.now === true ? GROUPS_NOW : GROUPS_PER_RUN));
    }
    if (typeof body.token !== "string" || !CODE_RE.test(body.token)) throw new Error("No token.");
    if (body.step?.startsWith("group-")) return json(await groupStep(env, url.origin, body));
    if (!/^[0-9a-f]{32}$/.test(body.account ?? "") || body.script !== url.hostname.split(".")[0] && !testingHere(env, url.origin)) {
      throw new Error("Not this site's Worker.");
    }
    if (body.step === "switch") {
      if (typeof body.versionId !== "string" || !/^[0-9a-f-]{36}$/.test(body.versionId)) throw new Error("Unknown version.");
      // Noted first, so a switch cut off halfway (the request ended, say) is finished or undone by the next run.
      await saveState(env.DB, { switching: { versionId: body.versionId, previous: env.VERSION?.id ?? null, at: now() } });
      const switched = await switchCarefully(env, url.origin, body.token, body.account, body.script, body.versionId, healthCheck(env, url.origin), env.VERSION?.id,
        { migrated: () => checkNewer(env) });
      await saveState(env.DB, { switching: null });
      return json(switched);
    }
    if (!VERSION_RE.test(body.version ?? "") || !newer(body.version, VERSION) || !/^[0-9a-f]{64}$/.test(body.manifestSha256 ?? "")) {
      throw new Error("Unknown release.");
    }
    // The manifest must be the one that was signed (the run checked the signature): every file is checked against it.
    const release = await loadRelease(`${releasesBase(env, url.origin)}/v${body.version}`, body.manifestSha256);
    if (body.step === "assets") return json({ jwt: await uploadAssets(body.token, body.account, body.script, release) });
    if (body.step === "stage") {
      const settings = await api(body.token, `/accounts/${body.account}/workers/scripts/${body.script}/settings`);
      const databaseId = existingDatabase(settings);
      if (!databaseId) throw new Error("This Worker doesn't look like afterwrd.");
      try {
        return json({ versionId: await stageVersion(body.token, body.account, body.script, release, { jwt: body.jwt, databaseId, settings }) });
      } catch (error) {
        if (error.needsHand) return json({ needsHand: true });
        throw error;
      }
    }
    throw new Error("Unknown step.");
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}

async function groupStep(env, origin, body) {
  const group = (await groupsBehind(env.DB)).find((g) => g.id === Number(body.group));
  if (!group || !/^[0-9a-f]{32}$/.test(group.account)) throw new Error("That group is up to date, or couldn't be reached.");
  if (!/^[0-9a-f]{64}$/.test(body.manifestSha256 ?? "")) throw new Error("Groups only get a signed release.");
  const release = await loadRelease(`${releasesBase(env, origin)}/v${VERSION}`, body.manifestSha256);
  if (body.step === "group-assets") return { jwt: await uploadAssets(body.token, group.account, group.script, release) };
  const settings = await api(body.token, `/accounts/${group.account}/workers/scripts/${group.script}/settings`);
  if (!isGroupWorker(settings, group)) throw new Error("That Worker isn't the group's any more.");
  if (body.step === "group-stage") {
    try {
      return { versionId: await stageVersion(body.token, group.account, group.script, release, { jwt: body.jwt, databaseId: group.database, settings }) };
    } catch (error) {
      if (error.needsHand) return { needsHand: true };
      throw error;
    }
  }
  if (body.step === "group-switch") {
    if (typeof body.versionId !== "string" || !/^[0-9a-f-]{36}$/.test(body.versionId)) throw new Error("Unknown version.");
    const check = async () => {
      const r = await fetch(`${group.origin}/_group/ping`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const ping = r.ok ? await r.json().catch(() => null) : null;
      return { answered: r.status, healthy: ping?.version === VERSION };
    };
    return switchCarefully(env, origin, body.token, group.account, group.script, body.versionId, check);
  }
  throw new Error("Unknown step.");
}

/**
 * Makes `versionId` live, waits for `check` to find it healthy, and puts the old version back if it doesn't, unless
 * `migrated()` says the new version has already changed the database, which the old one couldn't run on (migrate.js).
 * Run by the version that's live now. {result: "done" | "unhealthy" | "no-answer" | "kept", previous, at}.
 */
export async function switchCarefully(env, origin, token, account, script, versionId, check, runningAs = null, { migrated = null } = {}) {
  // On this computer a test may wait less (and only there: a setting alone can't change a real site's patience).
  const testing = testingHere(env, origin);
  const waitMs = testing && Number(env.TEST_HEALTH_MS) > 0 ? Number(env.TEST_HEALTH_MS) : HEALTH_MS;
  const everyMs = testing && Number(env.TEST_HEALTH_MS) > 0 ? 200 : HEALTH_EVERY_MS;
  const previous = await liveVersion(token, account, script);
  if (!previous) throw new Error("More than one version is serving visitors, so nothing was changed.");
  // Run by the live version itself (the site's own switch): Cloudflare's idea of what's live must agree, or putting
  // "the old version" back could put something else back.
  if (runningAs && previous !== runningAs && !testingHere(env, origin)) throw new Error("Cloudflare's live version isn't this one, so nothing was changed.");
  if (previous === versionId) return { result: "done", previous, at: now() };
  const at = now();
  await switchTo(token, account, script, versionId);
  let errors = 0;
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    const answer = await check(versionId).catch(() => ({ answered: 0 }));
    if (answer.healthy) return { result: "done", previous, at };
    if (answer.answered >= 500) errors++;
  }
  if (migrated && await migrated()) return { result: "kept", previous, at };
  await switchTo(token, account, script, previous);
  return { result: errors ? "unhealthy" : "no-answer", previous, at };
}

/** The site's own health, as a switch sees it: is `versionId` answering, migrations done, typical reads working? */
export function healthCheck(env, origin) {
  const address = testingHere(env, origin) && env.TEST_HEALTH_URL ? env.TEST_HEALTH_URL : `${origin}/_version?health=1`;
  return async (versionId) => {
    const r = await fetch(`${address}${address.includes("?") ? "&" : "?"}t=${Date.now()}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const answer = r.ok ? await r.json().catch(() => null) : null;
    return { answered: r.status, healthy: answer?.ok === true && answer.id === versionId };
  };
}

/** GET /_version?health=1: the migrations have run (every request runs them first) and typical reads work. */
export async function health(env) {
  for (const table of ["users", "connections", "posts", "events", "groups", "settings"]) {
    await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all();
  }
  return { id: env.VERSION?.id ?? null, ok: true };
}

// --- helpers ------------------------------------------------------------------------------------------------------

/** Whether `origin` is this site's own workers.dev address, its Worker called `script` (or, testing here, localhost). */
function ownAddress(env, origin, script) {
  if (testingHere(env, origin)) return true;
  try {
    const url = new URL(origin);
    const [first, , ...rest] = url.hostname.split(".");
    return url.protocol === "https:" && !url.port && url.origin === origin && rest.join(".") === "workers.dev"
      && url.hostname.split(".").length === 4 && first === script;
  } catch {
    return false;
  }
}

/** This site's Worker: its account (found the way the Update page finds it) and name. */
async function whichWorker(env, token, origin) {
  // On this computer there's no workers.dev address to go by: the test says which Worker the stand-in has.
  if (testingHere(env, origin) && env.TEST_WORKER) {
    const [account, script] = env.TEST_WORKER.split(":");
    return { account, script };
  }
  const { hostname } = new URL(origin);
  return { account: (await findWorker(token, hostname)).account, script: hostname.split(".")[0] };
}

function releasesBase(env, origin) {
  return (testingHere(env, origin) && env.RELEASES_URL) || `https://github.com/${REPO}/releases/download`;
}

// Cloudflare's API, or a stand-in when testing on this computer.
function testApi(env, origin) {
  useApiBase(testingHere(env, origin) && env.CLOUDFLARE_API_URL ? env.CLOUDFLARE_API_URL : null);
}

const plain = (error) => String(error?.message ?? error).slice(0, 300);
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares two secrets without the time taken saying how much of them matched.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
