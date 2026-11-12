// Automatic updates (src/auto.js, src/signing.js), end to end on one local site with stand-ins on 8799 for
// Cloudflare's token endpoint and API, GitHub's release downloads, the signatures in the repository and the new
// version's health. run.sh starts the site with --test-scheduled, so the daily run is started by asking for
// /__scheduled, and with ALLOW_LOCAL_SITES=1 and the stand-ins' addresses. The relay page is stood in for as in
// checks.mjs. The signing key here is a throwaway made for this test; the site is told its public key
// (TEST_RELEASE_KEY), which only counts on this computer.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8787";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
// A test-only key. Its public half is in run.sh (TEST_RELEASE_KEY); it signs nothing real.
const TEST_KEY = createPrivateKey({ key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIAwWlXoAziEK+W2opIfh92LiKpJBYhziPl8FbhGjYWvi", "base64"), format: "der", type: "pkcs8" });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sql = (command) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", command],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const state = () => JSON.parse(sql("SELECT value FROM settings WHERE key = 'auto_update'")[0]?.value ?? "{}");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

// --- the stand-ins -----------------------------------------------------------------------------------------------
// Releases: version → {manifest bytes, its entry in the signed list}. Each has one module, no site files. The list is
// signed afresh whenever it changes, with the next sequence number (as scripts/sign.mjs does).
const releases = new Map();
const files = new Map();
const list = { seq: 0, forged: false, serveSeq: null, noSecond: false, forgedSecond: false };
const signedText = ({ seq, releases: rs }) => `afterwrd releases\n${seq}\n${rs.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;
const signedText2 = ({ seq, releases: rs }) => `afterwrd releases 2\n${seq}\n${rs.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at} ${r.etag ?? "-"}\n`).join("")}`;
const drop = (version) => { releases.delete(version); list.seq++; };
function release(version, { signedAgo, tamper = false, newStore = false, securityFix = false }) {
  const code = Buffer.from(`export default { version: "${version}" };\n`);
  files.set(sha(code), code);
  const manifest = Buffer.from(JSON.stringify({
    name: "afterwrd", version, notes: `Release ${version}`, ...(securityFix ? { security_fix: version } : {}),
    main_module: "index.js", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    modules: [{ name: "index.js", type: "application/javascript+module", sha256: sha(code), size: code.length }], assets: [],
    assets_config: { html_handling: "none", not_found_handling: "none", run_worker_first: true },
    durable_objects: [{ name: "MEDIA", class_name: "MediaStore" }, { name: "OUTBOX", class_name: "Outbox" }, ...(newStore ? [{ name: "NEW", class_name: "NewStore" }] : [])],
    migrations: { new_tag: newStore ? "v2" : "v1", new_sqlite_classes: ["MediaStore", "Outbox", ...(newStore ? ["NewStore"] : [])] },
  }));
  releases.set(version, { manifest, entry: { version, manifest_sha256: tamper ? sha("something else") : sha(manifest), signed_at: iso(signedAgo), etag: sha(`etag ${version}`) } });
  list.seq++;
}
const token = { exchanges: [], refreshes: [], revoked: new Set(), n: 0 };
const cf = { schedules: [], versions: [], deployments: [], live: "11111111-1111-4111-8111-111111111111", unhealthy: new Set() };
const asked = [];
// A group this site made, in the same account (added further down): its Worker's live version, and the afterwrd
// version its ping says it runs.
const SITE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const grp = { live: "22222222-2222-4222-8222-222222222222", version: "0.1.0", versions: [], deployments: [] };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8799");
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, data, type = "application/json") => { res.statusCode = status; res.setHeader("Content-Type", type); res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  if (url.pathname === "/token") {
    const p = Object.fromEntries(new URLSearchParams(body));
    if (p.grant_type === "authorization_code") {
      token.exchanges.push(p);
      if (p.code.startsWith("noback.")) return send(200, { access_token: "tok-no-background", token_type: "bearer", expires_in: 3600 });
      return send(200, { access_token: `tok-auto-${++token.n}`, refresh_token: `ref-auto-${token.n}`, token_type: "bearer", expires_in: 3600, scope: "offline_access workers-scripts.edit" });
    }
    token.refreshes.push(p.refresh_token);
    if (token.revoked.has(p.refresh_token)) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: `tok-auto-${++token.n}`, refresh_token: `ref-auto-${token.n}`, token_type: "bearer", expires_in: 3600 });
  }
  // The new version's health, as the site's switch asks for it (TEST_HEALTH_URL).
  if (url.pathname === "/health") {
    if (cf.unhealthy.has(cf.live)) return send(500, "Error 1101", "text/plain");
    return send(200, { id: cf.live, ok: true });
  }
  if (url.pathname === "/signatures/index.json") {
    const signed = { seq: list.serveSeq ?? list.seq, releases: [...releases.values()].map((r) => r.entry) };
    signed.signature = list.forged ? Buffer.alloc(64, 7).toString("base64") : sign(null, Buffer.from(signedText(signed)), TEST_KEY).toString("base64");
    // The second signature (with etags), from list TEST_SIGNATURE2_FROM (run.sh) on.
    if (!list.noSecond) signed.signature2 = list.forgedSecond ? Buffer.alloc(64, 7).toString("base64") : sign(null, Buffer.from(signedText2(signed)), TEST_KEY).toString("base64");
    return send(200, signed);
  }
  const rel = /^\/releases\/v([\d.]+)\/(.+)$/.exec(url.pathname);
  if (rel) {
    if (rel[2] === "manifest.json" && releases.has(rel[1])) return send(200, releases.get(rel[1]).manifest);
    if (files.has(rel[2])) return send(200, files.get(rel[2]), "application/octet-stream");
    return send(404, "Not found", "text/plain");
  }
  const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const api = url.pathname.replace(/^\/client\/v4/, "");
  asked.push(`${req.method} ${api} ${auth}`);
  if (url.pathname === "/grp/_group/ping") return send(200, { version: grp.version });
  const gat = `/accounts/${ACCOUNT}/workers/scripts/localhost-grp`;
  if (api === `${gat}/settings`) {
    return send(200, { success: true, result: { bindings: [{ type: "d1", name: "DB", id: "grp-db" }, { type: "assets", name: "ASSETS" },
      { type: "durable_object_namespace", name: "MEDIA", class_name: "MediaStore" }, { type: "durable_object_namespace", name: "OUTBOX", class_name: "Outbox" },
      { type: "secret_text", name: "GROUP_KEY" }, { type: "version_metadata", name: "VERSION" }] } });
  }
  if (api === `${gat}/assets-upload-session`) return send(200, { success: true, result: { jwt: "assets-jwt", buckets: [] } });
  if (api === `${gat}/versions` && req.method === "POST") { const id = randomUUID(); grp.versions.push(id); return send(200, { success: true, result: { id } }); }
  if (api === `${gat}/deployments` && req.method === "GET") return send(200, { success: true, result: { deployments: [{ versions: [{ version_id: grp.live, percentage: 100 }] }] } });
  if (api === `${gat}/deployments` && req.method === "POST") {
    grp.live = JSON.parse(body).versions[0].version_id;
    grp.deployments.push(grp.live);
    if (grp.versions.includes(grp.live)) grp.version = SITE_VERSION; // the new code answers its ping
    return send(200, { success: true, result: {} });
  }
  const at = `/accounts/${ACCOUNT}/workers/scripts/localhost`;
  if (api === "/accounts") return send(200, { success: true, result: [{ id: ACCOUNT }] });
  if (api === `${at}/schedules` && req.method === "PUT") { cf.schedules.push({ auth, body: JSON.parse(body) }); return send(200, { success: true, result: { schedules: JSON.parse(body) } }); }
  if (api === `${at}/settings`) {
    return send(200, { success: true, result: { bindings: [{ type: "d1", name: "DB", id: "db-uuid" }, { type: "assets", name: "ASSETS" },
      { type: "durable_object_namespace", name: "MEDIA", class_name: "MediaStore" }, { type: "durable_object_namespace", name: "OUTBOX", class_name: "Outbox" },
      { type: "secret_text", name: "SETUP_CODE" }, { type: "version_metadata", name: "VERSION" }] } });
  }
  if (api === `${at}/assets-upload-session`) return send(200, { success: true, result: { jwt: "assets-jwt", buckets: [] } });
  if (api === `${at}/versions` && req.method === "POST") {
    const id = randomUUID();
    const meta = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData().then((f) => f.get("metadata").text()).then(JSON.parse).catch(() => null);
    cf.versions.push({ id, auth, meta });
    return send(200, { success: true, result: { id } });
  }
  if (api === `${at}/deployments` && req.method === "GET") return send(200, { success: true, result: { deployments: [{ versions: [{ version_id: cf.live, percentage: 100 }] }] } });
  if (api === `${at}/deployments` && req.method === "POST") {
    const to = JSON.parse(body).versions[0].version_id;
    cf.deployments.push({ to, auth });
    cf.live = to;
    return send(200, { success: true, result: {} });
  }
  if (api === at && req.method === "PUT") return send(500, { success: false, errors: [{ code: 1, message: "Not expected in this test" }] });
  return send(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));

// --- the owner ---------------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const context = await browser.createBrowserContext();
const owner = await context.newPage();
owner.on("pageerror", (e) => errors.push(e.message));
owner.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
const cdp = await owner.createCDPSession();
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const link = execFileSync("node", ["scripts/owner.mjs", "Ann Example", "--local"], { cwd: WORKER, encoding: "utf8" }).match(/http\S+\/_auth\/device\/\S+/)[0];
await owner.goto(link);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
let relay = null;
await owner.setRequestInterception(true);
owner.on("request", (req) => {
  const at = new URL(req.url());
  if (at.hostname !== "afterwrd.app") return req.continue();
  if (at.pathname === "/connect/") relay = at;
  req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" });
});
const text = async (sel = "main") => (await owner.$eval(sel, (m) => m.textContent)).replace(/\s+/g, " ");

// Connect for background access, coming back the way the relay would, with Cloudflare's code.
async function turnOn(code) {
  relay = null;
  await owner.goto(`${BASE}/_admin/update`);
  await Promise.all([owner.waitForFunction(() => document.title === "relay stand-in"), owner.click("#auto a.button")]);
  await owner.goto(`${relay.searchParams.get("to")}#${new URLSearchParams({ code, state: relay.searchParams.get("state") })}`);
  await owner.waitForFunction(() => !location.pathname.startsWith("/_cloudflare/") || document.querySelector("#error")?.textContent, { timeout: 15000 });
  return owner.url().includes("/_admin/update") ? null : await text("#error");
}

// One daily run, as the cron trigger would start it, waited for until it has finished.
async function dailyRun() {
  const before = state().lastRun ?? 0;
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
  for (let i = 0; i < 60; i++) {
    const s = state();
    if ((s.lastRun ?? 0) > before || (s.lastRun && !before && i > 3)) return s;
    if (!sql("SELECT 1 FROM settings WHERE key = 'auto_lock'").length && i > 5) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return state();
}

// --- off, offered once on Home -----------------------------------------------------------------------------------
await owner.goto(`${BASE}/`);
check("Home offers automatic updates while they're off", (await text()).includes("afterwrd can keep itself up to date"));
await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_admin/update/auto-later'] button")]);
check("…and \"Not now\" puts the offer away", !(await text()).includes("afterwrd can keep itself up to date"));
await owner.goto(`${BASE}/_admin/update`);
check("the Update page still offers it", (await text("#auto")).includes("Turn on automatic updates"));
check("health answers: migrations done, typical reads work", await fetch(`${BASE}/_version?health=1`).then((r) => r.json()).then((h) => h.ok === true));

// --- turning it on -----------------------------------------------------------------------------------------------
const refusedNoBackground = await turnOn("noback.code-1");
check("an Allow without Background Access is refused, and stays off", /Background Access/.test(refusedNoBackground ?? "") && !state().on, refusedNoBackground);
check("the relay is asked for background access to the site's own auto-done", relay?.searchParams.get("to") === `${BASE}/_cloudflare/auto-done`);
const turnedOn = await turnOn("good.code-2");
check("Connect with Background Access turns automatic updates on", turnedOn === null && state().on === true, turnedOn);
const exchange = token.exchanges.at(-1);
check("…swapping the code with the PKCE secret and the relay as the redirect", exchange?.code_verifier?.length >= 43 && exchange.redirect_uri === "https://afterwrd.app/connect/");
check("…and setting a daily schedule at a random time", /^\d{1,2} \d{1,2} \* \* \*$/.test(cf.schedules.at(-1)?.body?.[0]?.cron ?? ""), JSON.stringify(cf.schedules.at(-1)));
check("the Update page says they're on", (await text("#auto")).includes("Automatic updates are on"));
const exported = await owner.evaluate(async () => (await fetch("/_admin/update")).text());
check("neither the refresh token nor the run's key reaches a page", !/ref-auto-\d/.test(exported) && !exported.includes("auto_key"));
check("…nor the database (it's kept in the outbox's vault)", !JSON.stringify(sql("SELECT * FROM settings")).match(/ref-auto-\d/));

// --- the steps can only be asked for by the site itself ----------------------------------------------------------
const noKey = await fetch(`${BASE}/_auto/step`, { method: "POST", body: JSON.stringify({ step: "switch" }) });
const wrongKey = await fetch(`${BASE}/_auto/step`, { method: "POST", headers: { Authorization: "Bearer guess" }, body: JSON.stringify({ step: "switch" }) });
check("a step without the site's key gets nothing (404)", noKey.status === 404 && wrongKey.status === 404, `${noKey.status} ${wrongKey.status}`);

// --- a run: the newest signed release that's waited long enough --------------------------------------------------
release("99.0.1", { signedAgo: 4 * 86400 }); // signed four days ago: ready
release("99.0.2", { signedAgo: 3600 }); // signed an hour ago: waits
const firstLive = cf.live;
let s = await dailyRun();
const staged = cf.versions.at(-1);
check("the run installs the newest release that's signed and has waited three days (99.0.1)", s.last?.version === "99.0.1" && s.last?.result === "done", JSON.stringify(s.last ?? s));
check("…staged first (a version, not a direct deploy), with the database and secrets kept",
  staged?.meta?.bindings?.some((b) => b.type === "d1" && b.id === "db-uuid") && staged?.meta?.keep_bindings?.includes("secret_text") && !staged?.meta?.migrations);
check("…then switched to exactly that version", cf.deployments.at(-1)?.to === staged?.id && cf.live === staged?.id);
check("…using a token from refreshing the grant, never the refresh token itself", token.refreshes.length === 1 && !asked.some((a) => / ref-auto-\d/.test(a)));
check("…and the list's sequence number is remembered", state().listSeq === list.seq);
cf.versions.length = 0; cf.deployments.length = 0;

// --- a release that doesn't work here: put back at once, not tried again -----------------------------------------
drop("99.0.1"); drop("99.0.2");
release("99.0.3", { signedAgo: 5 * 86400 });
const beforeBad = cf.live;
const healthy = cf.live;
// Whatever version the switch makes live now answers 500 at its health.
const realPost = cf.deployments.push.bind(cf.deployments);
cf.deployments.push = (d) => { if (d.to !== healthy) cf.unhealthy.add(d.to); return realPost(d); };
s = await dailyRun();
check("a release whose health fails is put back as it was", s.last?.version === "99.0.3" && s.last?.result === "unhealthy" && cf.live === beforeBad,
  `${JSON.stringify(s.last)} live=${cf.live === beforeBad}`);
check("…the old version made live again by id", cf.deployments.at(-1)?.to === beforeBad && cf.deployments.length === 2);
await owner.goto(`${BASE}/`);
check("Home says it didn't work, and where to look", (await text()).includes("didn't work on this site, so it was put back"));
check("…but it isn't given up on after one try (a passing hiccup)", !s.failed?.includes("99.0.3"));
cf.versions.length = 0; cf.deployments.length = 0;
s = await dailyRun();
check("tried once more, it's put back again and marked as not taking", s.last?.result === "unhealthy" && cf.live === beforeBad && s.failed?.includes("99.0.3"));
cf.deployments.push = realPost;
cf.versions.length = 0; cf.deployments.length = 0;
s = await dailyRun();
check("after that it isn't tried again by itself", cf.versions.length === 0 && cf.deployments.length === 0);

// --- a release that fails its checks after changing the database: kept, as the old version can't run on it ---------
// (Stood in for by a migration this version has never heard of, as the new version's would be.)
release("99.0.5", { signedAgo: 5 * 86400 });
const beforeKept = cf.live;
cf.deployments.push = (d) => { if (d.to !== beforeKept) cf.unhealthy.add(d.to); return realPost(d); };
sql("INSERT INTO d1_migrations (name) VALUES ('9999_from_a_newer_version')");
s = await dailyRun();
check("a release that had changed the database is kept, not put back", s.last?.version === "99.0.5" && s.last?.result === "kept"
  && cf.live !== beforeKept && cf.deployments.length === 1, `${JSON.stringify(s.last)} deployments=${cf.deployments.length}`);
check("…and isn't counted as failing", !s.failed?.includes("99.0.5") && !s.tries?.["99.0.5"]);
const holding = await owner.goto(`${BASE}/`);
check("this (older) version says the site is being updated, and writes nothing", holding.status() === 503
  && (await text("body")).includes("This site is being updated"));
const peerAnswer = await fetch(`${BASE}/_peer/feed`, { headers: { Authorization: `Bearer ${"x".repeat(43)}` } });
check("…to other sites too", peerAnswer.status === 503 && (await peerAnswer.json()).error?.includes("being updated"));
sql("DELETE FROM d1_migrations WHERE name = '9999_from_a_newer_version'");
await owner.goto(`${BASE}/`);
check("Home says what happened", (await text()).includes("failed its checks after updating your site's database, so it was kept"));
cf.deployments.push = realPost;
drop("99.0.5");
cf.live = beforeKept;
cf.versions.length = 0; cf.deployments.length = 0;

// --- signatures that don't match, the wait, and new stores -------------------------------------------------------
release("99.0.4", { signedAgo: 5 * 86400, tamper: true });
s = await dailyRun();
check("a release whose manifest isn't the one signed is ignored", cf.versions.length === 0);
drop("99.0.4");
release("99.0.9", { signedAgo: 5 * 86400 });
list.forged = true;
s = await dailyRun();
check("a list that isn't signed with afterwrd's key installs nothing", cf.versions.length === 0);
list.forged = false;
list.serveSeq = 1; // an older list, put back by someone with the repository
s = await dailyRun();
check("an older signed list isn't believed, and the run says so", cf.versions.length === 0 && /went backwards/.test(s.problem ?? ""), s.problem);
list.serveSeq = null;
list.noSecond = true; // the genuine list with its etags and second signature taken off
s = await dailyRun();
check("a list without its second signature (from the list that brought it in) installs nothing", cf.versions.length === 0);
list.noSecond = false;
list.forgedSecond = true;
s = await dailyRun();
check("…nor one whose second signature isn't genuine", cf.versions.length === 0);
list.forgedSecond = false;
drop("99.0.9");
release("99.0.5", { signedAgo: 2 * 86400 });
s = await dailyRun();
check("a release signed two days ago waits", cf.versions.length === 0 && s.waiting?.version === "99.0.5", JSON.stringify(s.waiting));
await owner.goto(`${BASE}/_admin/update`);
check("…and the Update page says when it'll install itself", /99\.0\.5 will install itself after/.test(await text("#auto")));
drop("99.0.5");
release("99.0.6", { signedAgo: 2 * 86400, securityFix: true });
s = await dailyRun();
check("a security fix only waits a day", s.last?.version === "99.0.6" && s.last?.result === "done", JSON.stringify(s.last));
drop("99.0.6");
cf.versions.length = 0; cf.deployments.length = 0;
release("99.0.7", { signedAgo: 5 * 86400, newStore: true });
s = await dailyRun();
check("a release that adds a store isn't deployed by itself", cf.versions.length === 0 && cf.deployments.length === 0 && s.waiting?.needsHand === true, JSON.stringify(s.waiting));
await owner.goto(`${BASE}/`);
check("…and Home says it has to be installed by hand", (await text()).includes("has to be installed by hand"));
drop("99.0.7");

// --- "Install it now": the run straight away, its groups following in the same run --------------------------------
drop("99.0.3"); // turned down earlier: nothing to do with what follows
release(SITE_VERSION, { signedAgo: 10 * 86400 }); // this site's own version, signed: what its groups are given
sql(`INSERT INTO groups (name, created_at, origin, remote_id, joined_at, role, script, account, database)
  VALUES ('Book club', 1, 'http://127.0.0.1:8799/grp', 1, 1, 'owner', 'localhost-grp', '${ACCOUNT}', 'grp-db')`);
release("99.0.10", { signedAgo: 3600 }); // signed an hour ago: by itself, it would wait three days
const latestRow = (version) => sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${JSON.stringify({ version, checked: Math.floor(Date.now() / 1000),
  latest: { tag: `v${version}`, version, notes: `Release ${version}`, page: `https://github.com/stemill/afterwrd/releases/tag/v${version}` } })}')`);
latestRow("99.0.10");
cf.versions.length = 0; cf.deployments.length = 0;
await owner.goto(`${BASE}/_admin/update`);
check("the Update page says when the newest release will install itself, and offers it now",
  /99\.0\.10 is available.*install itself after .*install it now/.test(await text()) && Boolean(await owner.$("button[data-install-now]")), await text());
check("…and there's no other way to update while automatic updates are on (no Connect, no unsigned install)",
  !(await owner.$("#go")) && !(await owner.$("#connect")) && !(await owner.$("#auto-now")));
await owner.click("button[data-install-now]");
await owner.waitForFunction(() => document.querySelector(".log + p a.button") || document.querySelector(".error")?.textContent, { timeout: 90000 });
const shown = (await text(".log")) + (await owner.$eval(".error", (e) => e.textContent));
check("\"Install it now\" installs it without waiting the days out", state().last?.version === "99.0.10" && state().last?.result === "done"
  && cf.versions.length === 1 && cf.live === cf.versions[0].id, JSON.stringify(state().last));
check("…and the site's group follows in the same run, as signed", grp.version === SITE_VERSION && grp.deployments.length === 1
  && grp.deployments[0] === grp.versions[0], JSON.stringify(grp));
check("…and the page says what it did", /Installed afterwrd 99\.0\.10\. Brought Book club up to/.test(shown), shown);
const steps = await owner.evaluate(async () => (await (await fetch("/_admin/update/progress")).json()).lines);
check("…having noted each step as it went", steps.some((l) => l.startsWith("Switching to afterwrd 99.0.10")) && steps.some((l) => l.startsWith("Updating Book club")),
  JSON.stringify(steps));
drop("99.0.10");
cf.versions.length = 0; cf.deployments.length = 0;
// A group behind with nothing for the site: the button on the groups card does it.
grp.version = "0.1.0";
latestRow(SITE_VERSION);
await owner.goto(`${BASE}/_admin/update`);
check("a group behind the site is offered \"Update it now\"", (await text("#groups")).includes("Book club (0.1.0)") && Boolean(await owner.$("#groups button[data-install-now]")));
await owner.click("#groups button[data-install-now]");
await owner.waitForFunction(() => document.querySelector("#groups .log + p a.button") || document.querySelector("#groups .error")?.textContent, { timeout: 90000 });
check("…which brings it up to date", grp.version === SITE_VERSION && /Brought Book club up to/.test(await text("#groups")), await text("#groups"));
// A run still going (its lock fresh): the button waits.
latestRow("99.0.11");
release("99.0.11", { signedAgo: 3600 });
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_lock', '${Math.floor(Date.now() / 1000)}')`);
await owner.goto(`${BASE}/_admin/update`);
check("while a run is under way the page says so, and the button waits", (await text("#auto")).includes("It's looking for an update now")
  && await owner.$eval("button[data-install-now]", (b) => b.disabled));
sql("DELETE FROM settings WHERE key = 'auto_lock'");
drop("99.0.11");
await owner.goto(`${BASE}/_admin/update`);
check("a release that isn't signed: it says it'll wait for that, with nothing to press", (await text()).includes("once it's been signed")
  && !(await owner.$("button[data-install-now]")));
latestRow(SITE_VERSION);
cf.versions.length = 0; cf.deployments.length = 0;

// --- revoked in Cloudflare, then turned off ----------------------------------------------------------------------
release("99.0.8", { signedAgo: 5 * 86400 });
const currentRefresh = `ref-auto-${token.n}`;
token.revoked.add(currentRefresh);
s = await dailyRun();
check("a grant revoked in Cloudflare stops the run, and says so", /no longer allows background access/.test(s.problem ?? "") && cf.versions.length === 0, s.problem);
await owner.goto(`${BASE}/_admin/update`);
check("…and the Update page says when they turned themselves off", (await text("#auto")).includes("They turned themselves off on"));
await turnOn("good.code-3");
check("turning it on again works", state().on === true);
check("…and the page still says Cloudflare stopped allowing it once", /On since .*Cloudflare stopped allowing their access on/.test(await text("#auto")), await text("#auto"));
const refreshesBeforeHand = token.refreshes.length;
const handStep = await owner.evaluate(async () => {
  // (The site's own steps only work at a workers.dev address; a group's pick their token first, so they show it here.)
  const res = await fetch("/_admin/update/group-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: 1 }) });
  return (await res.json()).error ?? "ok";
});
check("while they're on, updating by hand uses their access instead of asking to connect",
  !/Connect Cloudflare first/.test(handStep) && token.refreshes.length === refreshesBeforeHand + 1, handStep);
// Turned off while a run holds the lock: off at once, but the grant stays until the run has finished with it.
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_lock', '${Math.floor(Date.now() / 1000)}:testrun')`);
const refreshesMidRun = token.refreshes.length;
await owner.goto(`${BASE}/_admin/update`);
await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_admin/update/auto-off'] button")]);
check("turned off mid-run, it's off at once but the run's access isn't touched", !state().on && state().offPending === true
  && token.refreshes.length === refreshesMidRun, JSON.stringify(state()).slice(0, 200));
sql("DELETE FROM settings WHERE key = 'auto_lock'");
await turnOn("good.code-4");
check("(on again)", state().on === true && !state().offPending);
const schedulesBefore = cf.schedules.length;
await owner.goto(`${BASE}/_admin/update`);
await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_admin/update/auto-off'] button")]);
check("turning it off clears the schedule", cf.schedules.length === schedulesBefore + 1 && Array.isArray(cf.schedules.at(-1).body) && cf.schedules.at(-1).body.length === 0);
check("…and says how to remove it in Cloudflare too", (await text("#auto")).includes("Keep afterwrd up to date by itself") && !state().on);
const refreshesBefore = token.refreshes.length;
s = await dailyRun();
check("once off, the run does nothing at all", token.refreshes.length === refreshesBefore && cf.versions.length === 0);

// --- what the site keeps about its updates (migrate.js) -----------------------------------------------------------
const history = sql("SELECT version, from_version FROM updates ORDER BY id");
check("this version noted itself once, when it first ran", history.length === 1 && history[0].from_version === null, JSON.stringify(history));
await owner.goto(`${BASE}/_admin/update`);
check("…and the Update page lists it", (await text("#history")).includes(`afterwrd ${history[0].version}`));
// A newer version whose database update failed (it notes why, as the database is left as it was).
const problem = { version: "99.0.7", migration: "0099_example", error: "UNIQUE constraint failed: posts.key", at: Math.floor(Date.now() / 1000) };
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('update_problem', '${JSON.stringify(problem)}')`);
await owner.goto(`${BASE}/_admin/update`);
check("the Update page says a newer version couldn't update the database, and why", (await text("#update-problem"))
  .includes("afterwrd 99.0.7 couldn't update your site's database") && (await text("#update-problem")).includes("0099_example: UNIQUE constraint failed"));
sql("UPDATE settings SET value = json_set(value, '$.version', '0.0.1') WHERE key = 'update_problem'");
await owner.goto(`${BASE}/_admin/update`);
check("…but not one from an older version", !(await owner.$("#update-problem")));
sql("DELETE FROM settings WHERE key = 'update_problem'");

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
