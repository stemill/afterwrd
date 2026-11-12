// Friends' automatic checks (src/friendchecks.js), end to end on two local sites: Ann's (A, 8787) lets her friends'
// sites check it; Sam's (B, 8788) checks it in its daily run (started with /__scheduled; TEST_CHECK_EVERYONE makes it
// check every friend due, not about three a week). Stand-ins on 8799: Cloudflare's token endpoint and API (Ann's
// account, whose workers.dev name is "ann", TEST_SUBDOMAIN), GitHub's release downloads and the signed list. The relay
// page is stood in for as in auto.mjs. The signing key is auto.mjs's throwaway one.
//   node friendchecks.mjs <A state dir> <B state dir>
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
// A form sent in place (ui.js, "afterwrd-inplace" when it's done) or the old way, with a new page: whichever happens.
const settled = (page, options) => Promise.race([page.waitForNavigation(options),
  page.evaluate(() => new Promise((r) => document.addEventListener("afterwrd-inplace", () => r(), { once: true }))).catch(() => new Promise(() => {}))]);
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stateA, stateB] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const CODE = "local-test-setup-code";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TEST_KEY = createPrivateKey({ key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIAwWlXoAziEK+W2opIfh92LiKpJBYhziPl8FbhGjYWvi", "base64"), format: "der", type: "pkcs8" });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (state, q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local",
  "--persist-to", state, "--json", "--command", q], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

// --- the stand-ins -----------------------------------------------------------------------------------------------
// Ann's site's code as Cloudflare hands it over, and release 9.9.9 (signed an hour ago, so Sam's site doesn't take it).
const INDEX = `// package.json\nvar package_default = {\n  name: "afterwrd-worker",\n  version: "9.9.9",\n  private: true\n};\nexport default {};\n`;
const MANIFEST = Buffer.from(JSON.stringify({ name: "afterwrd", version: "9.9.9", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  main_module: "index.js", modules: [{ name: "index.js", type: "application/javascript+module", sha256: sha(INDEX) }], assets: [],
  durable_objects: [], migrations: { new_tag: "v1", new_sqlite_classes: [] } }));
const ETAG_GOOD = sha("the etag of 9.9.9");
const signedText = ({ seq, releases: rs }) => `afterwrd releases\n${seq}\n${rs.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;
const signedText2 = ({ seq, releases: rs }) => `afterwrd releases 2\n${seq}\n${rs.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at} ${r.etag ?? "-"}\n`).join("")}`;
const LIST = { seq: 3, releases: [{ version: "9.9.9", manifest_sha256: sha(MANIFEST), signed_at: iso(3600), etag: ETAG_GOOD }] };
LIST.signature = sign(null, Buffer.from(signedText(LIST)), TEST_KEY).toString("base64");
LIST.signature2 = sign(null, Buffer.from(signedText2(LIST)), TEST_KEY).toString("base64");
const BINDINGS = [{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", id: "x" },
  { type: "durable_object_namespace", name: "MEDIA", class_name: "MediaStore" }, { type: "durable_object_namespace", name: "OUTBOX", class_name: "Outbox" },
  { type: "secret_text", name: "SETUP_CODE" }, { type: "version_metadata", name: "VERSION" }];
const cf = { live: null, versions: [], refreshes: [], asked: [], schedules: 0, refuse: new Set(), subdomain: "ann", past: [] };
const versionItem = (id, number, ago, etag) => ({ id, number, at: iso(ago), etag });
let n = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8799");
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, data, type = "application/json") => { res.statusCode = status; res.setHeader("Content-Type", type); res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  if (url.pathname === "/token") {
    const p = Object.fromEntries(new URLSearchParams(body));
    if (p.grant_type === "authorization_code") {
      const kind = p.code.split(".")[0];
      if (kind === "auto") return send(200, { access_token: `tok-auto-${++n}`, refresh_token: `ref-auto-${n}`, expires_in: 3600, scope: "offline_access workers-scripts.edit" });
      if (kind === "wide") return send(200, { access_token: `tok-check-${++n}`, refresh_token: `ref-check-${n}`, expires_in: 3600, scope: "offline_access workers-scripts.content_read workers-scripts.edit" });
      return send(200, { access_token: `tok-check-${++n}`, refresh_token: `ref-check-${n}`, expires_in: 3600, scope: "offline_access workers-scripts.content_read" });
    }
    cf.refreshes.push(p.refresh_token);
    if (cf.refuse.has(p.refresh_token)) return send(400, { error: "invalid_grant" });
    const kind = p.refresh_token.startsWith("ref-check") ? "check" : "auto";
    return send(200, { access_token: `tok-${kind}-${++n}`, refresh_token: `ref-${kind}-${n}`, expires_in: 3600 });
  }
  if (url.pathname === "/signatures/index.json") return send(200, LIST);
  if (url.pathname === "/releases/v9.9.9/manifest.json") return send(200, MANIFEST);
  if (url.pathname.startsWith("/releases/")) return send(404, "Not found", "text/plain");
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const api = url.pathname.replace(/^\/client\/v4/, "");
  cf.asked.push(`${token} ${req.method} ${api}`);
  // Sam's site turning on automatic updates (its schedule): nothing more of its own account is needed here.
  if (api === `/accounts/${ACCOUNT}/workers/scripts/samsite/schedules`) { cf.schedules++; return send(200, { success: true, result: {} }); }
  if (!token.startsWith("tok-check-")) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  const at = `/accounts/${ACCOUNT}/workers/scripts/localhost`;
  if (api === "/accounts") return send(200, { success: true, result: [{ id: ACCOUNT }] });
  if (api === `/accounts/${ACCOUNT}/workers/subdomain`) return send(200, { success: true, result: { subdomain: cf.subdomain } });
  if (api === `/accounts/${ACCOUNT}/workers/scripts`) return send(200, { success: true, result: [{ id: "localhost", created_on: "2026-11-01T00:00:00Z", modified_on: "2026-11-01T00:00:00Z" }] });
  if (api === `${at}/subdomain`) return send(200, { success: true, result: { enabled: true, previews_enabled: false } });
  if (api === at) {
    const form = new FormData();
    form.set("index.js", new Blob([INDEX]), "index.js");
    const response = new Response(form);
    return send(200, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
  }
  if (api === `${at}/script-settings`) return send(200, { success: true, result: { logpush: false, tail_consumers: [] } });
  if (api === `${at}/deployments`) {
    return send(200, { success: true, result: { deployments: [{ created_on: iso(2400), versions: [{ version_id: cf.live, percentage: 100 }] }, ...cf.past] } });
  }
  if (api === `${at}/versions`) {
    return send(200, { success: true, result: { items: cf.versions.map((v) => ({ id: v.id, number: v.number, metadata: { created_on: v.at } })) } });
  }
  const version = new RegExp(`^${at}/versions/([0-9a-f-]+)$`).exec(api);
  if (version) {
    const v = cf.versions.find((x) => x.id === version[1]);
    return send(200, { success: true, result: { id: version[1], resources: { bindings: BINDINGS,
      script_runtime: { compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"] }, script: { etag: v?.etag ?? ETAG_GOOD } } } });
  }
  return send(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));

// --- the two owners, friends -------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
let relay = null;
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${site}/_auth/setup?code=${CODE}`);
  await page.type("#name", name);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const to = new URL(req.url());
    if (to.hostname !== "afterwrd.app") return req.continue();
    if (to.pathname === "/connect/") relay = to;
    req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" });
  });
  return page;
}
const text = async (page, sel = "main") => (await page.$eval(sel, (m) => m.textContent).catch(() => "")).replace(/\s+/g, " ");
// Press a button that goes to Cloudflare by way of the relay, and come back the way the relay would, with `code`.
async function connect(page, selector, code) {
  relay = null;
  await page.goto(`${page.url().split("/").slice(0, 3).join("/")}/_admin/update`);
  await Promise.all([page.waitForFunction(() => document.title === "relay stand-in"), page.click(selector)]);
  await page.goto(`${relay.searchParams.get("to")}#${new URLSearchParams({ code, state: relay.searchParams.get("state") })}`);
  await page.waitForFunction(() => !location.pathname.startsWith("/_cloudflare/") || document.querySelector("#error")?.textContent, { timeout: 15000 });
  return page.url().includes("/_admin/update") ? null : await text(page, "#error");
}
const key = () => randomBytes(32).toString("base64url");
function befriend() {
  const [ab, ba] = [key(), key()]; // Ann's site calls Sam's with ab; Sam's calls Ann's with ba
  const row = (origin, name, theirs, ours) => `INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, approved_at, reached_at)
    VALUES ('${origin}', '${name}', '${theirs}', '${sha(ours)}', 1, 1, 1, 1)`;
  sql(stateA, row(B, "Sam Taylor", ab, ba));
  sql(stateB, row(A, "Ann Example", ba, ab));
  return { ab, ba };
}
const peerCall = (site, path, k, body) => fetch(site + path, { method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
  body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
// Sam's daily run, waited for until its check of Ann's site has been kept (or `ms` has passed).
async function samsRun(ms = 40000) {
  const before = sql(stateB, "SELECT COUNT(*) AS n FROM friend_checks")[0].n;
  await fetch(`${B}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    if (sql(stateB, "SELECT COUNT(*) AS n FROM friend_checks")[0].n > before) { await sleep(1500); break; }
  }
  return sql(stateB, "SELECT verdict, result FROM friend_checks ORDER BY id DESC LIMIT 1")[0];
}
// So the next run checks Ann's site again (not twice in a day), with tokens to spare.
const again = () => {
  sql(stateB, `UPDATE friend_checks SET checked_at = checked_at - 2 * 86400,
    result = CASE WHEN json_extract(result, '$.startedAt') IS NULL THEN result ELSE json_set(result, '$.startedAt', json_extract(result, '$.startedAt') - 2 * 86400) END`);
  sql(stateA, "DELETE FROM check_tokens");
  sql(stateA, "UPDATE checked SET checked_at = checked_at - 7200");
};

const ann = await owner(A, "Ann Example");
const sam = await owner(B, "Sam Taylor");
const { ab, ba } = befriend();
cf.live = (await (await fetch(`${A}/_version`)).json()).id ?? "11111111-1111-4111-8111-111111111111";
cf.versions.push(versionItem(cf.live, 7, 2400, ETAG_GOOD));

// --- Ann lets her friends' sites check hers ------------------------------------------------------------------------
check("before she allows it, a friend's site asking gets told no", (await peerCall(A, "/_peer/check-token", ba, { type: "CheckToken" })).status === 409);
await ann.goto(`${A}/_admin/update`);
check("Ann's Update page offers to let friends' sites check hers", (await text(ann, "#check")).includes("Let your friends' sites check yours by themselves"));
const wide = await connect(ann, "a[href='/_cloudflare/checks-start']", "wide.code-1");
check("a grant broader than reading code isn't kept", /more access than a check needs/.test(wide ?? ""), wide);
const allowed = await connect(ann, "a[href='/_cloudflare/checks-start']", "checks.code-2");
check("with Background Access to read code, it's on", allowed === null && (await text(ann, "#check")).includes("Your friends' sites check yours by themselves"), allowed);
check("the relay is asked to come back to the site's own checks-done", relay?.searchParams.get("to") === `${A}/_cloudflare/checks-done`);
check("the refresh token isn't in Ann's database", !JSON.stringify(sql(stateA, "SELECT * FROM settings")).includes("ref-check-"));

// --- what a friend's site can ask for --------------------------------------------------------------------------------
check("a site that isn't a friend gets nothing", (await peerCall(A, "/_peer/check-token", key(), { type: "CheckToken" })).status === 401);
check("…nor a request that isn't for a token", (await peerCall(A, "/_peer/check-token", ba, { type: "Something" })).status === 400);
const first = await peerCall(A, "/_peer/check-token", ba, { type: "CheckToken" });
const second = await peerCall(A, "/_peer/check-token", ba, { type: "CheckToken" });
const third = await peerCall(A, "/_peer/check-token", ba, { type: "CheckToken" });
check("a friend's site gets a one-hour read-only token", /^tok-check-\d+$/.test(first.json.token ?? "") && first.json.until > Date.now() / 1000 + 3000, JSON.stringify(first.json));
check("…the same one again while it has long enough left (a new one would end the first)", second.json.token === first.json.token);
check("…and two a day, no more", third.status === 429, String(third.status));
sql(stateA, "DELETE FROM check_tokens");

// --- Sam's site turns on automatic updates, and checks Ann's in its daily run ----------------------------------------
const autoOn = await connect(sam, "#auto a.button", "auto.code-1");
check("Sam turns on automatic updates", autoOn === null && (await text(sam, "#auto")).includes("Automatic updates are on"), autoOn);
await sam.goto(`${B}/`);
check("then Home offers, once, to let friends' sites check his", Boolean(await sam.$("#checks-offer")));
await Promise.all([settled(sam), sam.click("#checks-offer button")]);
check("…and \"Not now\" puts it away", !(await sam.$("#checks-offer")));
let found = await samsRun();
let result = JSON.parse(found?.result ?? "{}");
check("Sam's daily run checks Ann's site: all good", found?.verdict === "all good", `${found?.verdict} ${JSON.stringify(result).slice(0, 400)}`);
check("…its code against the signed release", result.code === "matches" && result.version === "9.9.9");
check("…and every upload since, by etag", result.versions?.checked === 1 && result.versions.unknown?.length === 0, JSON.stringify(result.versions));
check("…reading only with the token Ann's site handed over", cf.asked.filter((a) => a.includes(`/accounts/${ACCOUNT}/workers/scripts/localhost`)).every((a) => a.startsWith("tok-check-")));
check("…and keeping neither the token nor Ann's whole account id", !found.result.includes("tok-check-") && !found.result.includes(ACCOUNT));
check("Ann's site is told it passed", sql(stateA, "SELECT name, problems FROM checked ORDER BY id DESC LIMIT 1")[0]?.name === "Sam Taylor");
await ann.goto(`${A}/_admin/update`);
check("…and her Update page says who checked it last", (await text(ann, "#last-checked")).includes("Last checked by Sam Taylor's site"));
await sam.goto(`${B}/_admin/update`);
check("Sam's Update page lists the check", /Ann Example, .*: all good/.test(await text(sam, "#checking")), await text(sam, "#checking"));
await sam.goto(`${B}/`);
check("…and a pass says nothing on Home", !(await sam.$(".friend-check")));

// --- something else uploaded to Ann's site since: found, and both told ------------------------------------------------
again();
cf.versions.unshift(versionItem("22222222-2222-4222-8222-222222222222", 8, 1200, sha("someone else's code")));
found = await samsRun();
result = JSON.parse(found?.result ?? "{}");
check("an upload since the last check that isn't a signed release is found", found?.verdict === "needs a look"
  && result.versions?.unknown?.length === 1 && result.versions.unknown[0].number === 8, JSON.stringify(result.versions));
await sam.goto(`${B}/`);
check("Sam's Home says so, and suggests telling Ann", (await text(sam, ".friend-check")).includes("Your site checked Ann Example's site and found something that needs a look"));
await sam.goto(`${B}/_admin/update`);
check("…and his Update page shows what it found", (await text(sam, "#checking")).includes("wasn't a signed afterwrd release"));
const failure = sql(stateA, "SELECT name, problems FROM checked ORDER BY id DESC LIMIT 1")[0];
check("Ann's site is told what was found, in its own words", failure?.name === "Sam Taylor"
  && /something other than a signed afterwrd release was uploaded or made live/.test(failure.problems ?? ""), JSON.stringify(failure));
await ann.goto(`${A}/`);
check("…and her Home says so", (await text(ann, "#check-failure")).includes("Sam Taylor's site checked yours"));
await ann.goto(`${A}/_admin/update`);
check("…and her Update page lists it, without saying it passed", (await text(ann, "#check-failure")).includes("something other than a signed afterwrd release")
  && (await text(ann, "#last-checked")).includes("Last checked by Sam Taylor's site"));
await sam.goto(`${B}/`);
await Promise.all([settled(sam), sam.click(".friend-check button")]);
check("Sam can put it away", !(await sam.$(".friend-check")));
cf.versions.shift();

// --- what's live isn't what Cloudflare hands over (a genuine upload sitting unused on top of something else) ----------
again();
cf.versions[0].etag = sha("what's really serving");
found = await samsRun();
result = JSON.parse(found?.result ?? "{}");
check("code serving visitors that isn't the signed release is found, even when the code handed over is genuine",
  found?.verdict === "needs a look" && result.code === "matches" && result.servingMismatch === true, JSON.stringify(result.problems));
cf.versions[0].etag = ETAG_GOOD;
sql(stateB, "UPDATE friend_checks SET seen_at = 1");

// --- an old bad upload, put back live for a while since the last check (no new upload) -----------------------------
again();
cf.versions.push(versionItem("33333333-3333-4333-8333-333333333333", 2, 5 * 3600, sha("an old bad upload")));
cf.past.push({ created_on: iso(600), versions: [{ version_id: "33333333-3333-4333-8333-333333333333", percentage: 100 }] });
found = await samsRun();
result = JSON.parse(found?.result ?? "{}");
check("an old bad upload made live again since the last check is found", found?.verdict === "needs a look"
  && result.versions?.unknown?.some((u) => u.number === 2 && u.live), JSON.stringify(result.versions));
cf.past.length = 0;
cf.versions.pop();
sql(stateB, "UPDATE friend_checks SET seen_at = 1");

// --- a token for some other account (its workers.dev name isn't the address's) ---------------------------------------
again();
cf.subdomain = "someone-else";
found = await samsRun();
result = JSON.parse(found?.result ?? "{}");
check("a token for an account that isn't the one at Ann's address is found out", found?.verdict === "needs a look"
  && (result.problems ?? []).some((p) => p.includes("isn't the one at the site's address")), JSON.stringify(result.problems));
cf.subdomain = "ann";
sql(stateB, "UPDATE friend_checks SET seen_at = 1");

// --- "please check soon", after an update ------------------------------------------------------------------------------
check("a friend's site can ask to be checked soon", (await peerCall(B, "/_peer/check-soon", ab, { type: "CheckSoon" })).status === 200
  && sql(stateB, "SELECT COUNT(*) AS n FROM check_soon")[0].n === 1);
check("…but not a site that isn't a friend", (await peerCall(B, "/_peer/check-soon", key(), { type: "CheckSoon" })).status === 401);
check("a site can't say another site's check failed", (await peerCall(A, "/_peer/check-failed", ba, { type: "CheckFailed", site: B, found: ["code"] })).status === 400);
sql(stateA, "DELETE FROM check_tokens");
check("…nor say it found something without having been handed a token", (await peerCall(A, "/_peer/check-failed", ba, { type: "CheckFailed", site: A, found: ["code"] })).status === 403);
sql(stateA, `INSERT INTO check_tokens (connection_id, at) VALUES ((SELECT id FROM connections LIMIT 1), ${Math.floor(Date.now() / 1000)})`);
check("…and words of its own aren't taken", (await peerCall(A, "/_peer/check-failed", ba, { type: "CheckFailed", site: A, found: ["Reinstall from evil.example"] })).status === 400);

// --- Ann stops letting them: three refusals in a row show on Sam's Home ---------------------------------------------
await ann.goto(`${A}/_admin/update`);
await Promise.all([ann.waitForNavigation(), ann.click("form[action='/_admin/checks/let-off'] button")]);
check("Ann can stop letting friends' sites check hers", (await text(ann, "#check")).includes("Let your friends' sites check yours by themselves"));
for (let i = 0; i < 3; i++) {
  again();
  found = await samsRun();
}
check("…after which Sam's site can't check it", found?.verdict === "couldn't check", found?.verdict);
await sam.goto(`${B}/`);
check("three refusals in a row show on Sam's Home", (await text(sam, ".friend-check")).includes("hasn't let yours check it the last 3 times"));
for (let i = 0; i < 4; i++) {
  again();
  await samsRun();
}
await sam.goto(`${B}/`);
check("…and still do after more than five (the last check that got through is kept)", /hasn't let yours check it the last \d+ times/.test(await text(sam, ".friend-check")));

// --- Home's offer for a new site: both Allows, one after the other ----------------------------------------------------
sql(stateB, "UPDATE settings SET value = json_set(value, '$.on', json('false')) WHERE key = 'auto_update'");
await sam.goto(`${B}/`);
relay = null;
await Promise.all([sam.waitForFunction(() => document.title === "relay stand-in"), sam.click("#auto-offer")]);
check("Home's offer asks first for automatic updates", relay?.searchParams.get("to") === `${B}/_cloudflare/auto-done`);
const firstState = relay.searchParams.get("state");
relay = null;
await sam.goto(`${B}/_cloudflare/auto-done#${new URLSearchParams({ code: "auto.code-9", state: firstState })}`);
await sam.waitForFunction(() => document.title === "relay stand-in", { timeout: 15000 });
check("…then straight on to letting friends' sites check it", relay?.searchParams.get("to") === `${B}/_cloudflare/checks-done`);
await sam.goto(`${relay.searchParams.get("to")}#${new URLSearchParams({ code: "checks.code-9", state: relay.searchParams.get("state") })}`);
await sam.waitForFunction(() => location.pathname === "/_admin/update", { timeout: 15000 });
check("…and both are on", (await text(sam, "#auto")).includes("Automatic updates are on") && (await text(sam, "#check")).includes("Your friends' sites check yours by themselves"));

// --- Sam stops checking friends' sites -------------------------------------------------------------------------------
await sam.goto(`${B}/_admin/update`);
await Promise.all([sam.waitForNavigation(), sam.click("form[action='/_admin/checks/checking-off'] button")]);
again();
const before = sql(stateB, "SELECT COUNT(*) AS n FROM friend_checks")[0].n;
await samsRun(8000);
check("once Sam stops it, his site checks no one", sql(stateB, "SELECT COUNT(*) AS n FROM friend_checks")[0].n === before);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
