// Friends' automatic checks (docs/security-and-install-plan.md, section 7): the network checking itself, with no one
// present. A site whose owner allows it keeps a lasting, read-only grant from Cloudflare (Background Access to read
// its Workers' code, and nothing else: no database, no account settings, no audit log) and hands any friend's site
// that asks a one-hour access token from it. That friend's site checks the code and setup against the signed list of
// releases (signing.js), and every version uploaded since its last check against the signed releases' etags, so
// "upload something else, then switch back before the check" shows. Friends' sites choose when (a few checks a week
// each, the friend checked least recently first, and soon after an update when asked), so a tampered site can't pick
// friendly checkers or stop being checked: refusing, again and again, shows too.
//
// The site checked (its owner, signed in):
//   GET  /_cloudflare/checks-start    a PKCE secret in a short cookie, then the relay page, which asks Cloudflare for
//                                     `offline_access workers-scripts.content_read` only (installer/connect.html)
//   GET  /_cloudflare/checks-done     back from the relay: posts the code to…
//   POST /_cloudflare/checks-finish   swaps it for a refresh token, kept in the outbox's vault (never in D1)
//   POST /_admin/checks/let-off       forgets it (and says to Revoke in Cloudflare too)
//   POST /_admin/checks/let-later     "Not now" on Home's offer
// Friends' sites, with their key (peers.js):
//   POST /_peer/check-token   {type: "CheckToken"}: an access token for a check (a few a day; the same token, while it
//                             has long enough left, so friends checking at once don't end each other's)
//   POST /_peer/check-soon    {type: "CheckSoon"}: their site was just updated; please check it soon
//   POST /_peer/check-failed  {type: "CheckFailed", site, version, problems}: their check of this site found something
//                             (a pass is POST /_peer/checked, as for a check by link: checks.js)
// The checking site: runFriendChecks(), after the daily automatic-update run, has each part of a check done by a
// request to its own address (auto.js step(), so each gets the free plan's 50 outside calls): "fc-site" (the code and
// setup: checks.js checkSite), "fc-versions" (every upload since the last check), "fc-files" (the site files). It
// needs automatic updates on (their schedule and the steps' key). The owner can stop it:
//   POST /_admin/checks/checking-off, /checking-on
//   POST /_admin/checks/found/<id>/seen   puts a finding away on Home
import pkg from "../package.json";
import { CODE_RE, donePage, exchangeCode, pkce, readCookie, RELAY, testingHere, withCookie } from "./cloudflare.js";
import { autoState, step } from "./auto.js";
import { checkSite, cloudflareReader, siteFiles, siteIn } from "./checks.js";
import { callSite } from "./peers.js";
import { signedList } from "./signing.js";
import { knownLatest } from "./update.js";
import { json, now, html } from "./util.js";

export const CHECK_SCOPES = "offline_access workers-scripts.content_read";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const GRANT_KEY = "check_grant"; // settings: {on, since, problem}
const CHECKING_KEY = "friend_checking"; // settings: {off}
const START_COOKIE = "cf_checks";
const START_SECONDS = 600;
const TOKEN_LEFT = 2400; // a token handed out still has at least this long to run (a check takes a few minutes)
const PER_FRIEND_DAY = 2; // tokens handed to one friend's site a day…
const ALL_DAY = 12; // …and to all of them
const CHECKS_PER_WEEK = 3; // regular checks this site makes of its friends' sites (so each site gets about as many)
const SOON = 2; // friends' "please check soon" taken on one run
const SOON_DAYS = 3;
const VERSIONS_MAX = 30; // uploads looked at in one check
const REFUSALS = 3; // checks in a row a friend's site wouldn't allow before Home says so
const KEEP = 5; // results kept for each friend
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const vault = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("vault"));
const setting = async (db, key) => {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first().catch(() => null);
  return row ? JSON.parse(row.value) : {};
};
// Merged in one statement (JSON merge patch: null removes a field), as auto.js does.
const saveSetting = (db, key, change) => db.prepare(`INSERT INTO settings (key, value) VALUES (?1, json_patch('{}', ?2))
  ON CONFLICT(key) DO UPDATE SET value = json_patch(settings.value, ?2)`).bind(key, JSON.stringify(change)).run();

// --- the site checked: allowing it, and handing out tokens ---------------------------------------------------------

/** Whether friends' sites can check this one by themselves, for the Update page: {on, since, problem}. */
export const checkGrant = (db) => setting(db, GRANT_KEY);

/** The owner allowing the read-only grant: GET /_cloudflare/checks-start, /checks-done, POST /checks-finish. Null otherwise. */
export async function handleChecksConnect(request, env, url) {
  const path = url.pathname.slice("/_cloudflare".length);
  if (request.method === "GET" && path === "/checks-start") {
    const from = request.headers.get("Sec-Fetch-Site");
    if (from && from !== "same-origin" && from !== "none") return json({ error: "Start from your own site." }, 403);
    const { verifier, state, challenge } = await pkce();
    const relay = new URL(RELAY);
    relay.searchParams.set("to", `${url.origin}/_cloudflare/checks-done`);
    relay.searchParams.set("state", state);
    relay.searchParams.set("challenge", challenge);
    return withCookie(Response.redirect(relay.toString(), 302),
      `${START_COOKIE}=${state}.${verifier}; Path=/_cloudflare; Max-Age=${START_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
  }
  if (request.method === "GET" && path === "/checks-done") return html(donePage("/_cloudflare/checks-finish"));
  if (request.method === "POST" && path === "/checks-finish") {
    if (request.headers.get("Origin") !== url.origin) return json({ error: "Request from another site" }, 403);
    const clear = `${START_COOKIE}=; Path=/_cloudflare; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    const [state, verifier] = (readCookie(request, START_COOKIE) ?? "").split(".");
    const body = await request.json().catch(() => ({}));
    if (!state || !verifier) return withCookie(json({ error: "This has expired. Start again from your Update page." }, 400), clear);
    if (body.state !== state) return withCookie(json({ error: "That isn't what this site started. Start again." }, 400), clear);
    if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return withCookie(json({ error: "Cloudflare didn't send a code." }, 400), clear);
    try {
      await letOn(env, await exchangeCode(env, body.code, verifier, url.origin));
    } catch (error) {
      return withCookie(json({ error: error.message }, 400), clear);
    }
    return withCookie(json({ back: "/_admin/update#check" }), clear);
  }
  return null;
}

async function letOn(env, data) {
  if (typeof data.refresh_token !== "string" || !CODE_RE.test(data.refresh_token)) {
    throw new Error("Cloudflare didn't give background access, so friends' sites still can't check yours by themselves. Try again, and leave Background Access ticked.");
  }
  // Only ever the read-only grant: anything broader isn't kept, as it would be handed to friends' sites.
  // Cloudflare always says what it gave; an answer that doesn't isn't trusted.
  const granted = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : null;
  if (!granted || granted.some((scope) => !CHECK_SCOPES.split(" ").includes(scope))) {
    throw new Error("Cloudflare gave more access than a check needs, so it wasn't kept. Nothing has changed.");
  }
  const box = vault(env);
  await box.keepSecret("check_refresh", data.refresh_token);
  await box.keepSecret("check_access", null);
  await saveSetting(env.DB, GRANT_KEY, { on: true, since: now(), problem: null });
}

/** "Not now" on Home's offer (the Update page still has it). */
export const laterChecks = (db) => saveSetting(db, GRANT_KEY, { later: now() });

/** POST /_admin/checks/let-off: forgets the grant (the owner should Revoke it in Cloudflare too). */
export async function letOff(env) {
  await vault(env).keepSecret("check_refresh", null);
  await vault(env).keepSecret("check_access", null);
  await saveSetting(env.DB, GRANT_KEY, { on: false, problem: null });
}

/** A friend's site asking for a token to check this one (POST /_peer/check-token). Returns [body, status]. */
export async function giveCheckToken(env, url, peer, body) {
  if (body?.type !== "CheckToken") return [{ error: "That isn't a request for a check." }, 400];
  if (!(await checkGrant(env.DB)).on) return [{ error: "This site doesn't let friends' sites check it by themselves.", off: true }, 409];
  const at = now();
  // Counted in the same statement as the insert, so requests sent all at once can't slip past.
  const row = await env.DB.prepare(`INSERT INTO check_tokens (connection_id, at) SELECT ?1, ?2
    WHERE (SELECT COUNT(*) FROM check_tokens WHERE connection_id = ?1 AND at > ?2 - 86400) < ?3
      AND (SELECT COUNT(*) FROM check_tokens WHERE at > ?2 - 86400) < ?4 RETURNING at`).bind(peer.id, at, PER_FRIEND_DAY, ALL_DAY).first();
  await env.DB.prepare("DELETE FROM check_tokens WHERE at < ?").bind(at - 2 * 86400).run();
  if (!row) return [{ error: "That's enough checks for today. Try again tomorrow." }, 429];
  const access = await checkAccess(env, url.origin);
  if (!access) return [{ error: "This site's owner needs to let friends' sites check it again.", off: true }, 409];
  return [{ token: access.token, until: access.until }, 200];
}

/**
 * An access token from the read-only grant with long enough left to run, the one already handed out if it has (a
 * refresh ends the previous token, which would cut short a check under way), else a new one. Null if there's no grant
 * or Cloudflare refuses it (then it's forgotten, and the Update page says so).
 */
async function checkAccess(env, origin) {
  const box = vault(env);
  let kept = null;
  try { kept = JSON.parse((await box.secret("check_access")) ?? "null"); } catch {}
  if (typeof kept?.token === "string" && kept.until - now() > TOKEN_LEFT) return kept;
  const refresh = await box.secret("check_refresh");
  if (!refresh) return null;
  const endpoint = testingHere(env, origin) && env.OAUTH_TOKEN_URL ? env.OAUTH_TOKEN_URL : TOKEN_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: pkg.afterwrd.cloudflareClient }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string" || !CODE_RE.test(data.access_token)) {
    if (response.status === 400 || response.status === 401) {
      await letOff(env);
      await saveSetting(env.DB, GRANT_KEY, { problem: "Cloudflare no longer allows it (it may have been removed under Connected Applications)." });
    }
    return null;
  }
  // The new refresh token first: the old one may not work again.
  if (typeof data.refresh_token === "string" && CODE_RE.test(data.refresh_token)) await box.keepSecret("check_refresh", data.refresh_token);
  const access = { token: data.access_token, until: now() + (Number(data.expires_in) > 0 ? Math.min(Number(data.expires_in), 3600) : 3600) };
  await box.keepSecret("check_access", JSON.stringify(access));
  return access;
}

/** After an update: two friends, picked at random, are asked to check soon. Best effort. */
export async function askFriendsToCheckSoon(env) {
  if (!(await checkGrant(env.DB)).on) return;
  const { results } = await env.DB.prepare(`SELECT origin, their_key FROM connections WHERE connected_at IS NOT NULL
    AND approved_at IS NOT NULL AND their_key IS NOT NULL ORDER BY RANDOM() LIMIT 2`).all();
  for (const friend of results) {
    await callSite(friend.origin, "/_peer/check-soon", { key: friend.their_key, timeout: 5000, body: { type: "CheckSoon" } }).catch(() => {});
  }
}

// What a friend's check can say it found, as codes: the words are this site's own (a friend's site can't put text
// of its choosing on Home).
const FOUND = {
  missing: "The Cloudflare account it was given has no Worker for your site.",
  several: "More than one Cloudflare account it was given has a Worker for your site.",
  unreadable: "Cloudflare wouldn't hand over your site's code.",
  code: "Your site's code isn't the published afterwrd release it says it is.",
  serving: "The code serving your site's visitors isn't the signed afterwrd release.",
  unsigned: "Your site says it's a release that isn't signed with afterwrd's own key.",
  upload: "Since the last check, something other than a signed afterwrd release was uploaded or made live as your site's code.",
  "too-many": "There were too many uploads to your site's code since the last check to look at them all.",
  account: "The Cloudflare account it was given isn't the one at your site's address.",
  setup: "Your site isn't set up the way afterwrd sets it up (what it's connected to, or where its requests and logs go).",
  files: "Cloudflare hands out some of your site's files without its code checking them first.",
};

/** A friend's check of this site that found something (POST /_peer/check-failed). Returns [body, status]. */
export async function receiveCheckFailed(env, url, peer, body) {
  if (body?.type !== "CheckFailed" || body.site !== url.origin) return [{ error: "That isn't a check of this site." }, 400];
  const problems = [...new Set((Array.isArray(body.found) ? body.found : []).filter((code) => Object.hasOwn(FOUND, code)))]
    .slice(0, 6).map((code) => FOUND[code]);
  if (!problems.length) return [{ error: "It doesn't say what was found." }, 400];
  // Only from a friend's site this one handed a token to lately: one that hasn't checked can't say it found anything.
  const handed = await env.DB.prepare("SELECT 1 FROM check_tokens WHERE connection_id = ? AND at > ?").bind(peer.id, now() - 7200).first();
  if (!handed) return [{ error: "This site didn't hand your site a token to check it with." }, 403];
  const version = typeof body.version === "string" && VERSION_RE.test(body.version) ? body.version : null;
  const at = now();
  // At most once an hour from one friend; the newest ten kept (as for a pass).
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO checked (connection_id, name, version, checked_at, problems) SELECT ?1, ?2, ?3, ?4, ?5
      WHERE NOT EXISTS (SELECT 1 FROM checked WHERE connection_id = ?1 AND checked_at > ?4 - 3600)`)
      .bind(peer.id, peer.name, version, at, JSON.stringify(problems)),
    env.DB.prepare("DELETE FROM checked WHERE id NOT IN (SELECT id FROM checked ORDER BY id DESC LIMIT 10)"),
  ]);
  return [{ ok: true }, 200];
}

/**
 * The newest friend's check of this site that found something, if no friend's check since has passed:
 * {name, version, checked_at, problems: [words]}, or null. For Home and the Update page.
 */
export async function lastFailure(db) {
  const row = await db.prepare(`SELECT name, version, checked_at, problems FROM checked c WHERE problems IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM checked p WHERE p.problems IS NULL AND p.checked_at > c.checked_at
      AND (p.connection_id = c.connection_id OR p.connection_id IS NULL))
    ORDER BY id DESC LIMIT 1`).first();
  return row ? { ...row, problems: JSON.parse(row.problems) } : null;
}

// --- the checking site --------------------------------------------------------------------------------------------

/** A friend's site saying it was just updated (POST /_peer/check-soon). Returns [body, status]. */
export async function receiveCheckSoon(env, peer, body) {
  if (body?.type !== "CheckSoon") return [{ error: "That isn't a request for a check." }, 400];
  if ((await setting(env.DB, CHECKING_KEY)).off) return [{ ok: true }, 200];
  await env.DB.prepare(`INSERT INTO check_soon (connection_id, at) VALUES (?1, ?2)
    ON CONFLICT (connection_id) DO UPDATE SET at = excluded.at`).bind(peer.id, now()).run();
  return [{ ok: true }, 200];
}

/** Whether this site checks its friends' sites by itself (it does, with automatic updates on, unless turned off). */
export const checkingFriends = async (db) => !(await setting(db, CHECKING_KEY)).off;
export const setCheckingFriends = (db, on) => saveSetting(db, CHECKING_KEY, { off: !on });

/**
 * After the daily automatic-update run: checks the friends' sites that are due. `everyone` (tests only): every
 * friend not checked in the last day, rather than about three a week.
 */
export async function runFriendChecks(env, origin, { everyone = false } = {}) {
  const state = await autoState(env.DB);
  if (!(await checkingFriends(env.DB)) || !state.on) return;
  // Without this site's own signed list (or with one older than it's seen), there's nothing to compare with: no
  // friend is asked, so none is wrongly said to have refused.
  const list = await signedList(env, origin);
  if (!list || list.seq < (state.listSeq ?? 0)) return;
  for (const friend of await whoToCheck(env.DB, everyone)) {
    try {
      await checkFriend(env, origin, friend);
    } catch (error) {
      console.error(`Checking ${friend.origin}:`, error.message);
    }
  }
}

async function whoToCheck(db, everyone) {
  const at = now();
  const { results: friends } = await db.prepare(`SELECT c.id, c.name, c.origin, c.their_key,
      (SELECT MAX(checked_at) FROM friend_checks f WHERE f.connection_id = c.id) AS last,
      (SELECT at FROM check_soon s WHERE s.connection_id = c.id) AS soon
    FROM connections c WHERE c.connected_at IS NOT NULL AND c.approved_at IS NOT NULL AND c.their_key IS NOT NULL`).all();
  const rested = (f) => !f.last || f.last < at - 86400; // never the same friend twice in a day
  const picked = friends.filter((f) => f.soon && f.soon > at - SOON_DAYS * 86400 && f.soon > (f.last ?? 0) && rested(f))
    .sort((a, b) => a.soon - b.soon).slice(0, SOON);
  if (everyone) picked.push(...friends.filter((f) => rested(f) && !picked.includes(f)));
  else if (Math.random() < CHECKS_PER_WEEK / 7) {
    // The friend this site checked least recently (or never), a random one of those if several.
    const due = friends.filter((f) => rested(f) && !picked.includes(f))
      .map((f) => ({ f, r: Math.random() })).sort((a, b) => (a.f.last ?? 0) - (b.f.last ?? 0) || a.r - b.r);
    if (due[0]) picked.push(due[0].f);
  }
  await db.prepare("DELETE FROM check_soon WHERE at < ?").bind(at - SOON_DAYS * 86400).run();
  for (const f of picked) await db.prepare("DELETE FROM check_soon WHERE connection_id = ?").bind(f.id).run();
  return picked;
}

async function checkFriend(env, origin, friend) {
  // Counted from before asking, so an upload made once their site knows a check is coming is looked at next time.
  const startedAt = now();
  // Whatever happens is kept: a site that keeps refusing (or keeps failing to be checked) shows on Home after a few.
  const refused = (why, more = {}) => keep(env.DB, friend, "couldn't check", { site: friend.origin, why: String(why).slice(0, 300), startedAt, ...more });
  let token;
  try {
    token = (await callSite(friend.origin, "/_peer/check-token", { key: friend.their_key, body: { type: "CheckToken" } })).token;
  } catch (error) {
    return refused(error.message, { off: error.status === 409 || error.status === 404 });
  }
  if (typeof token !== "string" || !CODE_RE.test(token)) return refused("It didn't hand over a token.");
  const since = await lastComplete(env.DB, friend.id);
  let result;
  try {
    ({ result } = await step(env, origin, { step: "fc-site", token, site: friend.origin }));
    if (!result.problem && !result.tieFailed) {
      result.versions = await step(env, origin, { step: "fc-versions", token, site: friend.origin, account: result.accountId, script: result.script, since });
      if (result.version && result.code === "matches") {
        result.files = (await step(env, origin, { step: "fc-files", site: friend.origin, version: result.version })).problems;
        result.problems.push(...result.files);
      }
    }
  } catch (error) {
    // Their token stopped working partway, say: not a finding, but it counts towards refusing.
    return refused(`The check couldn't finish: ${error.message}`);
  }
  delete result.accountId;
  delete result.audit; // an automatic check doesn't read the audit log
  result.automatic = true;
  result.startedAt = startedAt;
  // Only a check that looked at every upload in the right account moves "since the last check" on.
  result.complete = !result.problem && !result.tieFailed && Boolean(result.versions) && !result.versions.more && !result.versions.none;
  const found = verdictOf(result);
  await keep(env.DB, friend, found, result);
  // Their site is told either way: a pass (as for a check by link), or what was found, as codes.
  const tell = found === "all good"
    ? { path: "/_peer/checked", body: { type: "Checked", site: friend.origin, version: result.version } }
    : { path: "/_peer/check-failed", body: { type: "CheckFailed", site: friend.origin, version: result.version ?? null, found: findingCodes(result) } };
  await callSite(friend.origin, tell.path, { key: friend.their_key, timeout: 5000, body: tell.body }).catch(() => {});
}

/** When this site last checked friend `connectionId` all the way through (started), or 0. */
async function lastComplete(db, connectionId) {
  const row = await db.prepare(`SELECT MAX(json_extract(result, '$.startedAt')) AS at FROM friend_checks
    WHERE connection_id = ? AND json_extract(result, '$.complete') = 1`).bind(connectionId).first();
  return Number(row?.at) || 0;
}

/** What a check found, as FOUND codes, for the site checked. */
function findingCodes(r) {
  const codes = new Set();
  if (["missing", "several", "unreadable"].includes(r.problem)) codes.add(r.problem);
  if (r.code === "different") codes.add("code");
  if (r.servingMismatch || r.servingUnconfirmed) codes.add("serving");
  if (r.unsigned) codes.add("unsigned");
  if (r.tieFailed) codes.add("account");
  if ((r.versions?.unknown ?? []).length) codes.add("upload");
  if (r.versions?.more) codes.add("too-many");
  if ((r.files ?? []).length) codes.add("files");
  const accounted = (r.files ?? []).length + [r.servingMismatch || r.servingUnconfirmed, r.unsigned, r.tieFailed].filter(Boolean).length;
  if ((r.problems ?? []).length > accounted) codes.add("setup");
  if (!codes.size) codes.add("code");
  return [...codes];
}

/** "all good" or "needs a look" (a token for an account without the site's Worker counts: it's not what was asked). */
export function verdictOf(r) {
  const versions = r.versions ?? {};
  return !r.problem && r.code === "matches" && !(r.problems ?? []).length && r.versions && !(versions.unknown ?? []).length
    && !versions.more ? "all good" : "needs a look";
}

/** What a check found, in a few lines of words, for the site checked (and Home). */
export function findings(r) {
  const words = [];
  if (r.problem === "missing") words.push("The Cloudflare account it was given a token for has no Worker for the site.");
  else if (r.problem === "several") words.push("More than one Cloudflare account has a Worker for the site.");
  else if (r.problem === "unreadable") words.push("Cloudflare wouldn't hand over the site's code.");
  else if (r.code === "different") words.push(`The site's code isn't the published afterwrd ${r.version}.`);
  else if (r.code && r.code !== "matches") words.push("The site's code couldn't be compared with a release.");
  const unknown = r.versions?.unknown ?? [];
  if (unknown.length) words.push(`${unknown.length === 1 ? "An upload" : `${unknown.length} uploads`} to the site's code since the last check ${unknown.length === 1 ? "wasn't" : "weren't"} a signed afterwrd release.`);
  if (r.versions?.more) words.push("There were too many uploads since the last check to look at them all.");
  words.push(...(r.problems ?? []));
  return words.slice(0, 5);
}

async function keep(db, friend, verdict, result) {
  await db.batch([
    db.prepare("INSERT INTO friend_checks (connection_id, checked_at, verdict, result) VALUES (?, ?, ?, ?)")
      .bind(friend.id, now(), verdict, JSON.stringify(result)),
    // The newest few, and always the newest check that got through and the newest complete one: "since the last
    // check" and "has let this site check it before" mustn't be lost to a run of refusals.
    db.prepare(`DELETE FROM friend_checks WHERE connection_id = ?1 AND id NOT IN
      (SELECT id FROM friend_checks WHERE connection_id = ?1 ORDER BY id DESC LIMIT ?2)
      AND id != COALESCE((SELECT MAX(id) FROM friend_checks WHERE connection_id = ?1 AND verdict != 'couldn''t check'), 0)
      AND id != COALESCE((SELECT MAX(id) FROM friend_checks WHERE connection_id = ?1 AND json_extract(result, '$.complete') = 1), 0)`)
      .bind(friend.id, KEEP),
  ]);
}

/**
 * What this site's checks of its friends' sites found, for Home and the Update page: for each friend checked, the
 * newest result ({id, connection_id, name, checked_at, verdict, result, seen_at, refusals}), newest first.
 */
export async function friendCheckResults(db) {
  const { results } = await db.prepare(`SELECT f.id, f.connection_id, c.name, f.checked_at, f.verdict, f.result, f.seen_at
    FROM friend_checks f JOIN connections c ON c.id = f.connection_id
    WHERE f.id IN (SELECT MAX(id) FROM friend_checks GROUP BY connection_id) ORDER BY f.checked_at DESC LIMIT 50`).all();
  const out = [];
  for (const r of results) {
    // How many checks in a row, newest back, their site wouldn't allow (after it had once).
    let refusals = 0;
    if (r.verdict === "couldn't check") {
      const { results: recent } = await db.prepare("SELECT verdict FROM friend_checks WHERE connection_id = ? ORDER BY id DESC").bind(r.connection_id).all();
      const allowedOnce = recent.some((x) => x.verdict !== "couldn't check");
      refusals = allowedOnce ? recent.findIndex((x) => x.verdict !== "couldn't check") : 0; // (the newest that got through is always kept)
    }
    out.push({ ...r, result: JSON.parse(r.result), refusals });
  }
  return out;
}

/** What Home shows: findings not put away, and friends whose sites have refused checks REFUSALS times in a row. */
export async function friendCheckAlerts(db) {
  return (await friendCheckResults(db)).filter((r) => !r.seen_at && (r.verdict === "needs a look" || r.refusals >= REFUSALS));
}

export const putAway = (db, id) => db.prepare("UPDATE friend_checks SET seen_at = ? WHERE id = ?").bind(now(), id).run();

// --- the steps, each a request of its own (auto.js handleAutoStep) --------------------------------------------------

/** One part of checking a friend's site: "fc-site", "fc-versions" or "fc-files". */
export async function friendCheckStep(env, origin, body) {
  const list = await signedList(env, origin);
  if (!list) throw new Error("The signed list of releases couldn't be read, so nothing could be compared with it.");
  // Never an older list than this site has seen (it could bring back a pulled release, or have no fingerprints).
  if (list.seq < ((await autoState(env.DB)).listSeq ?? 0)) throw new Error("The signed list of releases went backwards.");
  const site = siteIn(body.site, env, origin);
  if (!site) throw new Error("That isn't an afterwrd site's address.");
  if (body.step === "fc-site") {
    if (typeof body.token !== "string" || !CODE_RE.test(body.token)) throw new Error("No token.");
    return { result: await checkSite(body.token, site, env, origin, { latest: await knownLatest(env.DB), signed: list, tie: true, files: false }) };
  }
  if (body.step === "fc-versions") {
    if (typeof body.token !== "string" || !CODE_RE.test(body.token) || !/^[0-9a-f]{32}$/.test(body.account ?? "")
      || !/^[a-z0-9-]{1,63}$/.test(body.script ?? "")) throw new Error("Unknown Worker.");
    return uploadsSince(body.token, env, origin, list, body.account, body.script, Number(body.since) || 0);
  }
  if (body.step === "fc-files") {
    if (!VERSION_RE.test(body.version ?? "")) throw new Error("Unknown release.");
    const signed = list.releases.get(body.version);
    if (!signed) return { problems: [] }; // the site step has already said it isn't signed
    const releases = (testingHere(env, origin) && env.RELEASES_URL) || `https://github.com/${pkg.afterwrd.releases}/releases/download`;
    const response = await fetch(`${releases}/v${body.version}/manifest.json`, { headers: { "User-Agent": "afterwrd" } });
    const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    if (!bytes || bytes.length > 2_000_000 || (await sha256hex(bytes)) !== signed.manifestSha256) return { problems: ["Couldn't download the release to check its site files against."] };
    return { problems: await siteFiles(site, JSON.parse(new TextDecoder().decode(bytes))) };
  }
  throw new Error("Unknown step.");
}

/**
 * Every version of the Worker uploaded, and every one made live, since `since` (and since the first release signed
 * with its etag: earlier ones can't be told apart), each of whose code must be a signed release's:
 * {checked, unknown: [{number, at, live}], more, from}. Putting an older upload back live makes no new version, so the
 * deployments are looked at as well as the uploads.
 */
async function uploadsSince(token, env, origin, list, account, script, since) {
  const etags = [...list.releases.values()].filter((r) => r.etag);
  if (!etags.length) return { checked: 0, unknown: [], none: true };
  const known = new Set(etags.map((r) => r.etag));
  const from = Math.max(since, Math.min(...etags.map((r) => r.signedAt)));
  const { getJSON } = cloudflareReader(token, env, origin);
  const at = `/accounts/${account}/workers/scripts/${script}`;
  const when = (t) => Math.floor(Date.parse(t ?? "") / 1000) || 0;
  const listed = (await getJSON(`${at}/versions?per_page=100`)).result;
  const all = (Array.isArray(listed) ? listed : listed?.items ?? [])
    .map((v) => ({ id: v?.id, number: v?.number, at: when(v?.metadata?.created_on) }))
    .filter((v) => typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id));
  const uploads = all.filter((v) => !v.at || v.at > from); // a time that can't be read counts as recent
  // A full page whose oldest is still recent: there may be more than this one listing shows.
  let more = all.length >= 100 && all.every((v) => !v.at || v.at > from);
  const deployed = new Map();
  for (const d of (await getJSON(`${at}/deployments`)).result?.deployments ?? []) {
    if (when(d?.created_on) && when(d.created_on) <= from) continue;
    for (const v of d?.versions ?? []) if (typeof v?.version_id === "string" && /^[0-9a-f-]{36}$/.test(v.version_id)) deployed.set(v.version_id, when(d.created_on));
  }
  const look = new Map(uploads.map((v) => [v.id, { number: v.number, at: v.at, live: deployed.has(v.id) }]));
  for (const [id, at2] of deployed) if (!look.has(id)) look.set(id, { number: all.find((v) => v.id === id)?.number ?? null, at: at2, live: true });
  if (look.size > VERSIONS_MAX) more = true;
  const unknown = [];
  for (const [id, v] of [...look].slice(0, VERSIONS_MAX)) {
    const etag = (await getJSON(`${at}/versions/${encodeURIComponent(id)}`)).result?.resources?.script?.etag;
    if (!known.has(etag)) unknown.push({ number: Number(v.number) || null, at: v.at, live: v.live });
  }
  return { checked: Math.min(look.size, VERSIONS_MAX), unknown, more, from };
}

async function sha256hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
