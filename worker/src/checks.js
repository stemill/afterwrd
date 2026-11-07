// Checking a friend's site: the second key (docs/security-and-install-plan.md, step 3). A site can't vouch for
// itself, since tampered code could answer from a copy of the real code, so the evidence comes from Cloudflare, and
// the check runs here, on the checker's site: the friend's own site never handles the token, so it can't hand over
// one for a clean decoy.
//
//   POST /_admin/checks/new {connection?}  the owner makes a one-time link (for a friend, or anyone they send it to)
//   POST /_admin/checks/<id>/delete        forget a check
//   GET  /_check/<token>                   the friend's page: what will happen, their site's address, the result
//   POST /_check/<token>/start {site}      a PKCE secret in a short cookie; back comes the relay link
//   GET  /_check/done                      back from Cloudflare via the relay, which asked only for read-only access
//                                          (workers-scripts.content_read account-settings.read; installer/connect.html)
//   POST /_check/finish {code, state}      swaps the code for an hour's token and checks the Worker (below)
//   POST /_check/audit {cursor?}           one page of the account's audit log, newest first; the page calls it
//                                          until it's read back to the install, then the token is dropped
// Between those calls the token waits in a cookie in the friend's own browser (HttpOnly, only for /_check, ten
// minutes), as Connect keeps its token: it's never stored on this site. A failed step leaves the link usable.
//
// What's checked, all read-only:
//   - the Worker named like the site, in the account allowed, with its workers.dev address switched on;
//   - its code, file by file, against the release it says it is (and whether that release is out of date);
//   - what it's connected to: exactly afterwrd's bindings (database, photo store, outbox, site files, its secrets),
//     no settings (plain text variables), no tail Workers or Logpush sending its requests elsewhere, the release's
//     compatibility settings, and one version serving all of its traffic;
//   - that it doesn't hand out its site files without its code checking them (each file, asked for without signing
//     in, must get the sign-in redirect the code gives, not the file from Cloudflare directly);
//   - what apps (OAuth) and API tokens did in the account since the Worker was made, marking what afterwrd doesn't do.
// The code carries the hash of every static file (src/static.js), so with the above it covers the whole site.
import pkg from "../package.json";
import { CODE_RE, donePage, exchangeCode, readCookie, relayLink, testingHere, withCookie } from "./cloudflare.js";
import { API } from "./deploy.js";
import { checkLinkPage, messagePage } from "./pages.js";
import { ownerName, siteOrigin } from "./peers.js";
import { knownLatest, newer } from "./update.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

const REPO = pkg.afterwrd.releases;
const LINK_SECONDS = 14 * 86400;
const OPEN_LINKS = 20; // at most this many unused links at once
const START_COOKIE = "cf_check";
const RUN_COOKIE = "cf_check_run";
const COOKIE_SECONDS = 600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const WORKERS_DEV = /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;
const VERSION_RE = /name: "afterwrd-worker",\s*version: "(\d+\.\d+\.\d+)"/;
const AUDIT_PAGE = 500;
// The bindings afterwrd gives a personal site (src/deploy.js deployVersion), and the secrets it may have.
const BINDINGS = ["assets ASSETS", "d1 DB", "durable_object_namespace MEDIA MediaStore", "durable_object_namespace OUTBOX Outbox"];
const SECRETS = new Set(["SETUP_CODE", "UPDATE_TOKEN"]);

// --- the owner's side -------------------------------------------------------------------------------------------

export async function handleCheckAdmin(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (url.pathname === "/_admin/checks/new") {
    // For a friend (from their card), for a site whose address (or whole "please check" message) was pasted, or,
    // with neither, for whichever site the person opening it names.
    const connection = body.connection == null ? null : Number(body.connection);
    let friend = null;
    let site = null;
    if (connection !== null) {
      friend = await env.DB.prepare("SELECT id, name, origin FROM connections WHERE id = ? AND approved_at IS NOT NULL").bind(connection).first();
      if (!friend) return json({ error: "That isn't one of your friends." }, 404);
      site = friend.origin;
    } else if (typeof body.site === "string" && body.site.trim()) {
      site = siteIn(body.site, env, url.origin);
      if (!site) return json({ error: "Couldn't find an afterwrd site's address (something.their-name.workers.dev) in that." }, 400);
      friend = await env.DB.prepare("SELECT id FROM connections WHERE origin = ? AND approved_at IS NOT NULL").bind(site).first();
    }
    const token = randomToken();
    const made = await env.DB.prepare(`INSERT INTO site_checks (token_hash, connection_id, site, site_fixed, created_at, expires_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COUNT(*) FROM site_checks WHERE checked_at IS NULL AND expires_at > ?5) < ?7`)
      .bind(await sha256(token), friend?.id ?? null, site, site ? 1 : 0, now(), now() + LINK_SECONDS, OPEN_LINKS).run();
    if (!made.meta.changes) return json({ error: `You have ${OPEN_LINKS} check links nobody has used yet; wait for those first.` }, 429);
    const link = `${url.origin}/_check/${token}`;
    const me = await ownerName(env.DB);
    return json({
      link,
      message: `${me} would like to check that your afterwrd site is genuine: exactly the published afterwrd, with `
        + `nothing else done in your Cloudflare account. Open this link and, when Cloudflare asks, allow read-only `
        + `access (it can't change anything). The link works once, for 14 days.\n\n${link}`,
    });
  }
  const forget = /^\/_admin\/checks\/(\d+)\/delete$/.exec(url.pathname);
  if (forget) {
    await env.DB.prepare("DELETE FROM site_checks WHERE id = ?").bind(Number(forget[1])).run();
    return Response.redirect(`${url.origin}/friend#checks`, 303);
  }
  return new Response("Not found", { status: 404 });
}

/** The latest checks, with what they found, for the Friends page. */
export async function recentChecks(db) {
  const { results } = await db.prepare(`SELECT c.id, c.site, c.created_at, c.expires_at, c.checked_at, c.result, f.name AS friend
    FROM site_checks c LEFT JOIN connections f ON f.id = c.connection_id ORDER BY c.created_at DESC LIMIT 20`).all();
  return results.map((c) => ({ ...c, result: c.result ? JSON.parse(c.result) : null }));
}

// --- the friend's side (not signed in) ---------------------------------------------------------------------------

export async function handleCheck(request, env, url) {
  const path = url.pathname.slice("/_check".length);
  if (request.method === "GET" && path === "/done") return html(donePage("/_check/finish"));
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return json({ error: "Request from another site" }, 403);
  if (request.method === "POST" && path === "/finish") return finish(request, env, url, await request.json().catch(() => ({})));
  if (request.method === "POST" && path === "/audit") return auditStep(request, env, url, await request.json().catch(() => ({})));
  const match = /^\/([A-Za-z0-9_-]+)(\/start)?$/.exec(path);
  const token = match && TOKEN_RE.test(match[1]) ? match[1] : null;
  const check = token && await findCheck(env.DB, token);
  if (!check) {
    return html(messagePage("This check link has expired or isn't right. Ask your friend for a new one.",
      { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
  }
  if (request.method === "GET" && !match[2]) {
    const result = check.result ? JSON.parse(check.result) : null;
    const owner = await ownerName(env.DB);
    const by = { name: owner, host: url.host };
    return html(checkLinkPage({ owner, checker: url.host, site: check.site, fixed: Boolean(check.site_fixed),
      result: result ? resultHtml(result, "yours", by) : null, reading: Boolean(result && !check.checked_at) }));
  }
  if (request.method === "POST" && match[2]) return start(env, url, check, token, await request.json().catch(() => ({})));
  return new Response("Not found", { status: 404 });
}

/**
 * The afterwrd site an address, link or whole message names: the first something.their-name.workers.dev in it (or,
 * when testing on this computer, an http://localhost address). Null if there isn't one.
 */
export function siteIn(text, env, here) {
  const words = String(text ?? "").trim().slice(0, 2000);
  const found = /(?<![\w.-])([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)(?![\w-]|\.[\w-])/i.exec(words)?.[1];
  if (found && WORKERS_DEV.test(found.toLowerCase())) return `https://${found.toLowerCase()}`;
  if (testingHere(env, here)) {
    const local = siteOrigin(words, env);
    if (local?.startsWith("http://")) return local;
  }
  return null;
}

const findCheck = async (db, token) => db.prepare("SELECT * FROM site_checks WHERE token_hash = ? AND expires_at > ?")
  .bind(await sha256(token), now()).first();
const clearStart = `${START_COOKIE}=; Path=/_check; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const clearRun = `${RUN_COOKIE}=; Path=/_check; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

async function start(env, url, check, token, body) {
  if (check.checked_at) return json({ error: "This site has already been checked with this link." }, 409);
  // A link made for a site checks that site; otherwise the person says where theirs is.
  const site = check.site_fixed ? check.site : siteIn(body.site, env, url.origin);
  if (!site) return json({ error: "That doesn't look like an afterwrd site's address (something.your-name.workers.dev)." }, 400);
  // Starting again (after a step failed) begins afresh.
  await env.DB.prepare("UPDATE site_checks SET site = ?, result = NULL WHERE id = ? AND checked_at IS NULL").bind(site, check.id).run();
  const { verifier, state, relay } = await relayLink(`${url.origin}/_check/done`);
  return withCookie(json({ relay: relay.toString() }),
    `${START_COOKIE}=${state}.${verifier}.${token}; Path=/_check; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

async function finish(request, env, url, body) {
  const [state, verifier, token] = (readCookie(request, START_COOKIE) ?? "").split(".");
  const fail = (error, status = 400) => withCookie(json({ error }, status), clearStart);
  if (!state || !verifier || !TOKEN_RE.test(token ?? "")) return fail("This check has expired. Open the link again.");
  if (typeof body.state !== "string" || body.state !== state) return fail("That isn't the check this page started. Open the link again.");
  if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return fail("Cloudflare didn't send a code.");
  const check = await findCheck(env.DB, token);
  if (!check?.site || check.checked_at) return fail("This check link has expired or has already been used.");
  let access;
  let result;
  try {
    access = (await exchangeCode(env, body.code, verifier, url.origin)).access_token;
    result = await checkSite(access, check.site, env, url.origin, { latest: await knownLatest(env.DB) });
  } catch (error) {
    // Nothing is kept, so the link can be used again.
    return fail(`The check couldn't finish: ${String(error.message).slice(0, 300)} Open the link to try again.`);
  }
  await env.DB.prepare("UPDATE site_checks SET result = ? WHERE id = ? AND checked_at IS NULL").bind(JSON.stringify(result), check.id).run();
  const back = `/_check/${token}`;
  // The audit log comes next, a page at a time, if there's a Worker to read it for.
  if (!result.problem) {
    const out = withCookie(json({ back, audit: true }), clearStart);
    return withCookie(out, `${RUN_COOKIE}=${token}${access}; Path=/_check; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  }
  await env.DB.prepare("UPDATE site_checks SET checked_at = ? WHERE id = ? AND checked_at IS NULL").bind(now(), check.id).run();
  return withCookie(json({ back }), clearStart);
}

/** One page of the audit log, newest first, added to the result; the last call marks the check done. */
async function auditStep(request, env, url, body) {
  const run = readCookie(request, RUN_COOKIE) ?? "";
  const token = run.slice(0, 43);
  const access = run.slice(43);
  const check = TOKEN_RE.test(token) && CODE_RE.test(access) ? await findCheck(env.DB, token) : null;
  const result = check?.result && !check.checked_at ? JSON.parse(check.result) : null;
  if (!result?.audit || result.audit.complete || result.audit.stopped) return withCookie(json({ error: "This check has finished or expired." }, 400), clearRun);
  const done = async (how) => {
    result.audit[how] = true;
    await env.DB.prepare("UPDATE site_checks SET result = ?, checked_at = ? WHERE id = ? AND checked_at IS NULL")
      .bind(JSON.stringify(result), now(), check.id).run();
    return withCookie(json({ done: true }), clearRun);
  };
  if (body.stop === true) return done("stopped"); // the page gave up (too many pages): it says the log wasn't all read
  try {
    const cursor = typeof body.cursor === "string" && /^[\w.=+/-]{1,2000}$/.test(body.cursor) ? body.cursor : "";
    const page = await readAuditPage(access, env, url.origin, result, cursor);
    await env.DB.prepare("UPDATE site_checks SET result = ? WHERE id = ? AND checked_at IS NULL").bind(JSON.stringify(result), check.id).run();
    if (!page.cursor) return done("complete");
    return json({ cursor: page.cursor });
  } catch (error) {
    result.audit.error = String(error.message).slice(0, 300);
    return done("stopped");
  }
}

// --- the check ---------------------------------------------------------------------------------------------------

const text = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : "");
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const apiBase = (env, here) => (testingHere(env, here) && env.CLOUDFLARE_API_URL) || API;

function client(token, env, here, fetcher) {
  const base = apiBase(env, here);
  const call = (path) => fetcher(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const getJSON = async (path) => {
    const response = await call(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(`Cloudflare said: ${data.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`}.`);
    }
    return data;
  };
  return { call, getJSON };
}

/**
 * What a token allowed for someone's account shows about their site (all but the audit log, which auditStep reads
 * afterwards). `here` is this site's own origin; `fetcher` is for tests.
 */
export async function checkSite(token, site, env, here, { latest = {} } = {}, fetcher = fetch) {
  const { call, getJSON } = client(token, env, here, fetcher);
  const releases = (testingHere(env, here) && env.RELEASES_URL) || `https://github.com/${REPO}/releases/download`;
  const script = new URL(site).hostname.split(".")[0];
  const result = { site, script, checkedAt: now() };
  const problems = []; // things that need a look, in words

  // The Worker: named like the site, in the account(s) the person allowed.
  const found = [];
  for (const account of ((await getJSON("/accounts")).result ?? []).slice(0, 5)) {
    if (typeof account?.id !== "string" || !/^[0-9a-f]{32}$/.test(account.id)) continue;
    const worker = ((await getJSON(`/accounts/${account.id}/workers/scripts`)).result ?? []).find((w) => w?.id === script);
    if (worker) found.push({ account: account.id, worker });
  }
  if (found.length !== 1) return { ...result, problem: found.length ? "several" : "missing" };
  const { account, worker } = found[0];
  const at = `/accounts/${account}/workers/scripts/${script}`;
  result.account = account.slice(-6);
  result.created = Math.floor(Date.parse(worker.created_on) / 1000) || null;
  try {
    if (!(await getJSON(`${at}/subdomain`)).result?.enabled) problems.push("Its workers.dev address is switched off, so this Worker isn't the one answering there.");
  } catch {
    problems.push("Couldn't see whether its workers.dev address is switched on.");
  }

  // Its code, file by file, against the release it says it is.
  const code = await call(at);
  if (!code.ok || !(code.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return { ...result, problem: "unreadable" };
  const files = new Map();
  let version = null;
  for (const [name, value] of (await code.formData()).entries()) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
    files.set(name, await hex(bytes));
    if (name === "index.js") version = VERSION_RE.exec(new TextDecoder().decode(bytes))?.[1] ?? null;
  }
  result.version = version;
  let manifest = null;
  if (!version) {
    result.code = "unknown";
  } else {
    const response = await fetcher(`${releases}/v${version}/manifest.json`, { headers: { "User-Agent": "afterwrd" } });
    manifest = response.ok ? await response.json().catch(() => null) : null;
    if (!manifest || !Array.isArray(manifest.modules)) {
      result.code = response.status === 404 ? "no-release" : "release-unavailable";
      manifest = null;
    } else {
      const expected = new Map(manifest.modules.map((m) => [m.name, m.sha256]));
      const odd = [];
      for (const [name, hash] of files) if (expected.get(name) !== hash) odd.push({ name: text(name, 100), why: expected.has(name) ? "different" : "extra" });
      for (const name of expected.keys()) if (!files.has(name)) odd.push({ name: text(name, 100), why: "missing" });
      result.code = odd.length ? "different" : "matches";
      result.files = odd.slice(0, 20);
    }
    if (latest.securityFix && newer(latest.securityFix, version)) {
      problems.push(`It's older than afterwrd ${latest.securityFix}, which fixed a security problem: it needs updating.`);
    } else if (latest.version && newer(latest.version, version)) {
      result.newer = latest.version;
    }
  }

  // What it's connected to, and where its requests and logs go.
  try {
    const settings = (await getJSON(`${at}/script-settings`)).result ?? {};
    if ((settings.tail_consumers ?? []).length) problems.push("Its requests are copied to another Worker (a tail Worker). afterwrd never sets one.");
    if (settings.logpush) problems.push("Its requests are sent out with Logpush. afterwrd never turns that on.");
    if ((settings.observability?.logs?.destinations ?? []).length) problems.push("Its logs are sent to another destination. afterwrd never sets one.");
  } catch {
    problems.push("Couldn't read its logging settings.");
  }
  try {
    const deployments = (await getJSON(`${at}/deployments`)).result?.deployments ?? [];
    const serving = deployments[0]?.versions ?? [];
    if (serving.length !== 1 || serving[0].percentage !== 100) {
      problems.push("More than one version of it is serving visitors, so the code checked may not be the code everyone gets.");
    } else {
      const detail = (await getJSON(`${at}/versions/${encodeURIComponent(serving[0].version_id)}`)).result ?? {};
      const have = (detail.resources?.bindings ?? []).map((b) => b?.type === "durable_object_namespace"
        ? `${b.type} ${b.name} ${b.class_name}` : `${text(b?.type, 40)} ${text(b?.name, 60)}`);
      const extra = have.filter((b) => !BINDINGS.includes(b) && !(b.startsWith("secret_text ") && SECRETS.has(b.slice(12))));
      const missing = BINDINGS.filter((b) => !have.includes(b));
      if (extra.length) problems.push(`It's connected to things afterwrd doesn't use: ${extra.slice(0, 8).join(", ")}.`);
      if (missing.length) problems.push(`It's missing parts afterwrd needs: ${missing.join(", ")}.`);
      const runtime = detail.resources?.script_runtime ?? {};
      if (manifest && (runtime.compatibility_date !== manifest.compatibility_date
        || [...(runtime.compatibility_flags ?? [])].sort().join() !== [...(manifest.compatibility_flags ?? [])].sort().join())) {
        problems.push("Its compatibility settings aren't the release's.");
      }
    }
  } catch {
    problems.push("Couldn't read what it's connected to.");
  }

  // Its site files only through its code: asked for without signing in, each must get the code's sign-in redirect.
  if (manifest) {
    const paths = (manifest.assets ?? []).map((a) => a?.path).filter((p) => typeof p === "string" && /^\/static\/[\w./-]+$/.test(p) && !p.startsWith("/static/fonts/"));
    const direct = [];
    for (const path of paths.slice(0, 25)) {
      const response = await fetcher(site + path, { method: "HEAD", redirect: "manual" }).catch(() => null);
      if (response && response.status === 200) direct.push(path);
    }
    if (direct.length) problems.push(`Cloudflare hands out ${direct.length === 1 ? "one of its files" : `${direct.length} of its files`} without its code checking them first (${direct.slice(0, 3).join(", ")}).`);
  }

  result.problems = problems;
  result.audit = { from: (result.created ?? now()) - 3600, until: new Date().toISOString(), count: 0, unexpected: [] };
  return result;
}

// What afterwrd does in an account through Connect: installing and updating its site, starting and deleting groups
// (Workers named after the site), and the installer removing itself.
function expected(e, script) {
  if (e.context !== "oauth") return false;
  const ours = e.resource === script || e.resource.startsWith(`${script}-`) || e.resource.startsWith("afterwrd-installer-");
  switch (`${e.type} ${e.what}`) {
    case "create workers/scripts.assets-upload-session": case "update workers/scripts": case "delete workers/scripts":
    case "create workers/scripts.subdomain": return ours;
    case "create d1/database": case "delete d1/database": return true;
    default: return false;
  }
}

async function readAuditPage(access, env, here, result, cursor, fetcher = fetch) {
  const { getJSON } = client(access, env, here, fetcher);
  const account = (await getJSON("/accounts")).result?.find((a) => a?.id?.endsWith(result.account))?.id;
  if (!account) throw new Error("Couldn't find the account again.");
  const data = await getJSON(`/accounts/${account}/logs/audit?since=${encodeURIComponent(new Date(result.audit.from * 1000).toISOString())}`
    + `&before=${encodeURIComponent(result.audit.until)}&direction=desc&limit=${AUDIT_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  for (const raw of data.result ?? []) {
    const context = raw?.actor?.context;
    // Views change nothing; "dash" is the person in Cloudflare's dashboard; a sign-in shows as "api".
    if (raw?.action?.type === "view" || (context !== "oauth" && context !== "api") || raw?.action?.description === "LOGIN") continue;
    const product = text(raw.resource?.product, 40);
    const e = { time: text(raw.action?.time, 40), type: text(raw.action?.type, 20), description: text(raw.action?.description, 100),
      what: `${product}/${text(raw.resource?.type, 60)}`, resource: text(raw.resource?.id, 100), context };
    result.audit.count++;
    if (expected(e, result.script) || result.audit.unexpected.length >= 40) continue;
    // Only Workers' and databases' names are kept: the rest of someone's account is theirs.
    if (product !== "workers" && product !== "d1") e.resource = "";
    result.audit.unexpected.push(e);
  }
  return { cursor: data.result?.length ? data.result_info?.cursor ?? "" : "" };
}

// --- showing it --------------------------------------------------------------------------------------------------

const when = (seconds) => new Date(seconds * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

/** What a check found, as HTML (everything from Cloudflare escaped). `whose`: "yours" for the person checked, else "theirs". */
export function resultHtml(r, whose = "theirs", by = null) {
  const site = escape(r.site ? new URL(r.site).host : "");
  const your = whose === "yours" ? "your" : "their";
  const Your = whose === "yours" ? "Your" : "Their";
  // Which site was checked, and by whom, first: with one person playing both parts it's easy to lose track.
  const lines = [`<p class="check-who">Site checked: <b>${site}</b>${r.account ? ` <span class="meta">(Worker ${escape(r.script ?? "")}, Cloudflare account ending ${escape(r.account)})</span>` : ""}`
    + (by ? `<br>Checked by: <b>${escape(by.name)}'s site</b> <span class="meta">(${escape(by.host)})</span>` : "") + "</p>"];
  const say = (good, words) => lines.push(`<p class="check-${good ? "good" : "bad"}">${good ? "✓" : "✗"} ${words}</p>`);
  if (r.problem === "missing") say(false, `No Worker called <b>${escape(r.script)}</b> in the Cloudflare account that was allowed. Was it the account ${site} is in?`);
  else if (r.problem === "several") say(false, `More than one account that was allowed has a Worker called <b>${escape(r.script)}</b>. Check again, allowing only the account ${site} is in.`);
  else if (r.problem === "unreadable") say(false, `Cloudflare wouldn't hand over the code of <b>${escape(r.script)}</b>.`);
  else {
    if (r.code === "matches") say(true, `${Your} site is running exactly <b>afterwrd ${escape(r.version)}</b>, every file the same as the published release.`);
    else if (r.code === "different") {
      say(false, `${Your} site's code is <b>not</b> the published afterwrd ${escape(r.version)}. Don't use it yet: see <a href="https://afterwrd.app/check/#wrong">what to do</a>.`);
      lines.push(`<ul class="check-files">${(r.files ?? []).map((f) => `<li>${escape(f.name)}: ${escape(f.why)}</li>`).join("")}</ul>`);
    } else if (r.code === "no-release") say(false, `It says it's afterwrd ${escape(r.version)}, but there's no such release.`);
    else if (r.code === "release-unavailable") say(false, `Couldn't download afterwrd ${escape(r.version)} from GitHub to compare with. Check again later.`);
    else say(false, "This Worker doesn't look like afterwrd: its version couldn't be read.");
    for (const p of r.problems ?? []) say(false, escape(p));
    if (!(r.problems ?? []).length && r.code === "matches") say(true, "It's connected to exactly what afterwrd uses, and hands out its files only through its code.");
    if (r.newer) lines.push(`<p class="meta">afterwrd ${escape(r.newer)} is out: worth updating.</p>`);
    const a = r.audit;
    if (a) {
      const odd = a.unexpected ?? [];
      if (a.error) say(false, `Couldn't read all of ${your} account's audit log: ${escape(a.error)}`);
      else if (!a.complete) say(false, a.stopped ? `${Your} account's audit log was too long to read all of, so it isn't checked.` : `Still reading ${your} account's audit log…`);
      if (!odd.length && a.complete) say(true, `Since it was installed, apps and API tokens did only what installing, updating and groups do (${a.count} ${a.count === 1 ? "change" : "changes"}).`);
      if (odd.length) {
        say(false, `${odd.length === 1 ? "One change" : `${odd.length} changes`} in ${your} Cloudflare account, made through an app or API token, isn't something afterwrd does. Check ${whose === "yours" ? "you" : "they"} recognise ${odd.length === 1 ? "it" : "them"}:`);
        lines.push(`<ul class="check-files">${odd.map((e) => `<li>${escape(e.time.replace("T", " ").slice(0, 16))} · ${escape(e.description || `${e.type} ${e.what}`)}${e.resource ? ` · ${escape(e.resource)}` : ""} (${e.context === "api" ? "API token" : "app"})</li>`).join("")}</ul>`);
      }
    }
  }
  lines.push(`<p class="meta">Checked ${escape(when(r.checkedAt))}, read-only. The access Cloudflare gave was used for this check and not kept.</p>`);
  return lines.join("\n");
}

/** One word for the Friends page. */
export function verdict(r) {
  if (!r) return null;
  if (r.problem) return "couldn't check";
  if (r.code === "matches" && !(r.problems ?? []).length && r.audit?.complete && !r.audit.error && !(r.audit.unexpected ?? []).length) return "all good";
  return "needs a look";
}
