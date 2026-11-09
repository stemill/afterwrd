// Checking a friend's site (src/checks.js), end to end on one local site, with stand-ins on 8799 for Cloudflare's
// token endpoint, Cloudflare's API and GitHub's release downloads. run.sh starts the site with ALLOW_LOCAL_SITES=1,
// OAUTH_TOKEN_URL, CLOUDFLARE_API_URL and RELEASES_URL pointing there. The relay page (afterwrd.app/connect/) is
// stood in for as in update-ui.mjs: the test reads where the site sent the browser, and comes back the way it would.
// Which "account" the stand-in shows depends on the code Cloudflare would have sent: match, tampered or missing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8787";
const FRIEND_SITE = "http://localhost:8788"; // the site being checked: its Worker is "localhost" to the stand-in
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sql = (command) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", command],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- the stand-ins -----------------------------------------------------------------------------------------------
const INDEX = `// package.json\nvar package_default = {\n  name: "afterwrd-worker",\n  version: "9.9.9",\n  private: true\n};\nexport default {};\n`;
const SQL = "CREATE TABLE t (x);";
const MANIFEST = { version: "9.9.9", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  modules: [{ name: "index.js", sha256: sha(INDEX) }, { name: "0001_schema.sql", sha256: sha(SQL) }],
  assets: [{ path: "/static/style.css" }, { path: "/static/fonts/nunito.woff2" }] };
const BINDINGS = [{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", id: "x" },
  { type: "durable_object_namespace", name: "MEDIA", class_name: "MediaStore" }, { type: "durable_object_namespace", name: "OUTBOX", class_name: "Outbox" },
  { type: "secret_text", name: "SETUP_CODE" }, { type: "version_metadata", name: "VERSION" }];
const exchanges = [];
const asked = [];
const auditFor = (token) => [
  { action: { type: "create", time: "2026-11-07T18:01:50Z", description: "Create Workers Subdomain" }, actor: { context: "oauth" }, resource: { product: "workers", type: "subdomain" } },
  ...(token === "tok-tampered" ? [{ action: { type: "update", time: "2026-11-07T19:10:00Z", description: "Update Workers Subdomain" },
    actor: { context: "oauth" }, resource: { product: "workers", type: "subdomain" } }] : []),
  { action: { type: "view", time: "2026-11-07T18:00:00Z", description: "View" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts" } },
  { action: { type: "update", time: "2026-11-07T18:01:00Z", description: "LOGIN" }, actor: { context: "api" }, resource: { product: "", type: "user" } },
  { action: { type: "create", time: "2026-11-07T18:02:00Z", description: "Create D1 Database" }, actor: { context: "oauth" }, resource: { product: "d1", type: "database" } },
  { action: { type: "update", time: "2026-11-07T18:02:30Z", description: "Upload Worker" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts", id: "localhost" } },
  { action: { type: "delete", time: "2026-11-07T18:03:00Z", description: "Delete Worker" }, actor: { context: "dash" }, resource: { product: "workers", type: "scripts", id: "mine" } },
  { action: { type: "create", time: "2026-11-07T18:01:30Z", description: "Create Worker Assets Upload Session" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts.assets-upload-session", id: "localhost" } },
  // Someone deploying another Worker in the account by hand (wrangler), twice: listed apart, not against the site.
  { action: { type: "create", time: "2026-11-07T18:20:00Z", description: "Upload Version" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts.versions", id: "afterwrd-install" } },
  { action: { type: "create", time: "2026-11-07T18:40:00Z", description: "Upload Version" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts.versions", id: "afterwrd-install" } },
  // An update removing the token an older version kept (afterwrd's own), and a sign-in (changes nothing).
  { action: { type: "delete", time: "2026-11-07T18:30:00Z", description: "Delete Worker script secret" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts.secrets", id: "localhost" } },
  { action: { type: "update", time: "2026-11-07T18:31:00Z", description: "SSO_LOGIN" }, actor: { context: "api" }, resource: { product: "", type: "user" } },
  ...(token === "tok-tampered" ? [{ action: { type: "create", time: "2026-11-07T19:20:00Z", description: "Query D1 Database" },
    actor: { context: "oauth" }, resource: { product: "d1", type: "database", id: "x" } }] : []),
  ...(token === "tok-tampered" ? [{ action: { type: "create", time: "2026-11-07T19:00:00Z", description: "Create DNS Record <img src=x onerror=alert(1)>" },
    actor: { context: "oauth" }, resource: { product: "dns", type: "records", id: "secret.example" } },
    { action: { type: "update", time: "2026-11-07T19:05:00Z", description: "Upload Worker" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts", id: "someone-else" } }] : []),
];
// A second page of the log, newest first: the install, an hour before (afterwrd's own, so expected).
const OLDER = [{ action: { type: "delete", time: "2026-11-07T18:03:30Z", description: "Delete Worker" }, actor: { context: "oauth" }, resource: { product: "workers", type: "scripts", id: "afterwrd-installer-old-pine-1234" } }];
const audits = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8799");
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, data, type = "application/json") => { res.statusCode = status; res.setHeader("Content-Type", type); res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  if (url.pathname === "/token") {
    const params = Object.fromEntries(new URLSearchParams(body));
    exchanges.push(params);
    if (params.code.startsWith("bad.")) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: `tok-${params.code.split(".")[0]}`, token_type: "bearer", expires_in: 3600 });
  }
  if (url.pathname === "/releases/v9.9.9/manifest.json") return send(200, MANIFEST);
  if (url.pathname.startsWith("/releases/")) return send(404, "Not found", "text/plain");
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  asked.push(`${token} ${url.pathname}`);
  const api = url.pathname.replace(/^\/client\/v4/, "");
  if (api === "/accounts") return send(200, { success: true, result: [{ id: ACCOUNT, name: "someone@example.com's Account" }] });
  if (api === `/accounts/${ACCOUNT}/workers/scripts`) {
    const list = [{ id: "other", etag: "x", created_on: "2026-11-01T00:00:00Z", modified_on: "2026-11-01T00:00:00Z" }];
    if (token !== "tok-missing") list.push({ id: "localhost", etag: "y", created_on: "2026-11-07T18:02:00Z",
      modified_on: token === "tok-recent" ? new Date(Date.now() - 600000).toISOString() : "2026-11-07T18:02:30Z" });
    return send(200, { success: true, result: list });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/subdomain`) return send(200, { success: true, result: { enabled: true, previews_enabled: false } });
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost`) {
    const form = new FormData();
    form.set("index.js", new Blob([token === "tok-tampered" ? INDEX.replace("export default {};", "export default { evil: true };") : INDEX]), "index.js");
    form.set("0001_schema.sql", new Blob([SQL]), "0001_schema.sql");
    const response = new Response(form);
    return send(200, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/script-settings`) {
    return send(200, { success: true, result: { logpush: false, tags: [], observability: { enabled: false },
      tail_consumers: token === "tok-setup" ? [{ service: "copy-everything" }] : [] } });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/other/deployments`) {
    return send(200, { success: true, result: { deployments: [{ id: "d2", versions: [{ version_id: "v-other", percentage: 100 }] }] } });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/other/versions/v-other`) {
    return send(200, { success: true, result: { id: "v-other", resources: { bindings: [{ type: "d1", name: "DB", id: token === "tok-backdoor" ? "x" : "its-own" }] } } });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/deployments`) {
    return send(200, { success: true, result: { deployments: [{ id: "d1", versions: [{ version_id: token === "tok-elsewhere" ? "v-2" : "v-1", percentage: 100 }] }] } });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/versions/v-1` || api === `/accounts/${ACCOUNT}/workers/scripts/localhost/versions/v-2`) {
    const bindings = token === "tok-setup" ? [...BINDINGS, { type: "plain_text", name: "OAUTH_TOKEN_URL", text: "https://evil.example/token" }] : BINDINGS;
    return send(200, { success: true, result: { id: "v-1", resources: { bindings, script_runtime: { compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"] } } } });
  }
  if (api === `/accounts/${ACCOUNT}/logs/audit`) {
    audits.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get("cursor") === "page-2") return send(200, { success: true, result: OLDER, result_info: { cursor: "page-3" } });
    if (url.searchParams.get("cursor") === "page-3") return send(200, { success: true, result: [], result_info: {} });
    return send(200, { success: true, result: auditFor(token).reverse(), result_info: { cursor: "page-2" } });
  }
  return send(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));
const direct = createServer((req, res) => {
  if (req.url === "/_version") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "v-1" })); }
  res.statusCode = req.url.startsWith("/static/") ? 200 : 404; res.end();
});
const toldChecked = []; // what this site told the friend's site after its checks (POST /_peer/checked)
const friendSite = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/_peer/checked") {
    let body = "";
    req.on("data", (c) => { body += c; });
    return req.on("end", () => { toldChecked.push({ auth: req.headers.authorization, body: JSON.parse(body) }); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
  }
  if (req.url === "/_version") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "v-1" })); }
  res.statusCode = 302; res.setHeader("Location", "/_auth/login"); res.end();
});
await new Promise((r) => friendSite.listen(8788, "127.0.0.1", r));
await new Promise((r) => direct.listen(8798, "127.0.0.1", r));

// --- the owner, and the friend's browser -------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person(withPasskeys) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  if (withPasskeys) {
    const cdp = await page.createCDPSession();
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  return page;
}
const owner = await person(true);
const link = execFileSync("node", ["scripts/owner.mjs", "Ann Example", "--local"], { cwd: WORKER, encoding: "utf8" }).match(/http\S+\/_auth\/device\/\S+/)[0];
await owner.goto(link);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
const cookie = (await owner.cookies()).find((c) => c.name === "__Host-session").value;
const asOwner = (path, body, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function makeLink(what = {}) {
  const res = await asOwner("/_admin/checks/new", what);
  const body = await res.text();
  if (!res.ok) throw new Error(`Making a check link: HTTP ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

// One check, the friend's way: open the link, give their site, (relay), come back with Cloudflare's code.
async function runCheck(code, site = FRIEND_SITE, fixed = false) {
  const { link: checkLink, message } = await makeLink(fixed ? { site } : {});
  const friend = await person(false);
  let relay = null;
  await friend.setRequestInterception(true);
  friend.on("request", (req) => {
    const at = new URL(req.url());
    if (at.hostname !== "afterwrd.app") return req.continue();
    if (at.pathname === "/connect/") relay = at;
    req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" });
  });
  await friend.goto(checkLink);
  const before = await friend.$eval("main", (m) => m.textContent);
  if (!fixed) await friend.type("input[name=site]", site);
  await Promise.all([friend.waitForFunction(() => document.title === "relay stand-in"), friend.click("#check button")]);
  if (!relay?.searchParams.get("to")) throw new Error(`relay: ${relay}`);
  await friend.goto(`${relay.searchParams.get("to")}#${new URLSearchParams({ code: `${code}.one-time-code`, state: relay.searchParams.get("state") })}`);
  await friend.waitForFunction(() => location.pathname.startsWith("/_check/") && location.pathname !== "/_check/done", { timeout: 15000 })
    .catch(async () => { throw new Error(`Stuck at ${friend.url()}: ${await friend.$eval("body", (b) => b.textContent.replace(/\s+/g, " ").slice(0, 300))}`); });
  const after = await friend.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
  return { checkLink, message, before, relay, friend, after };
}

// --- before any check: Home, Add a friend and Update suggest one ---------------------------------------------------
const textOf = async (path, selector = "main") => { await owner.goto(BASE + path); return owner.$eval(selector, (m) => m.textContent.replace(/\s+/g, " ")); };
check("an unchecked site suggests a check on Home", (await textOf("/")).includes("Your site hasn't been checked yet"));
check("…and on Add a friend", (await textOf("/_admin/connections")).includes("hasn't been checked yet"));
check("…and Update says it hasn't been", (await textOf("/_admin/update", "#last-checked")) === "Your site hasn't been checked yet.");

// The site being checked is a friend's: once a check passes, its site is told (and only then).
const THEIR_KEY = "k".repeat(43); // what this site sends when calling theirs
const OUR_KEY = "o".repeat(43); // what theirs sends when calling this one
sql(`INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, approved_at)
  VALUES ('${FRIEND_SITE}', 'Bob Example', '${THEIR_KEY}', '${sha(OUR_KEY)}', 1, 1, 1)`);

// --- a genuine site ----------------------------------------------------------------------------------------------
const good = await runCheck("match");
check("a friend's site that passes is told it was checked, with this site's key for it", toldChecked.length === 1
  && toldChecked[0].auth === `Bearer ${THEIR_KEY}` && JSON.stringify(toldChecked[0].body) === JSON.stringify({ type: "Checked", site: FRIEND_SITE, version: "9.9.9" }),
  JSON.stringify(toldChecked));
check("the owner's message carries a one-time check link", /\/_check\/[\w-]{43}$/.test(good.checkLink) && good.message.includes("read-only"));
check("the friend's page says what will happen, without signing in", good.before.includes("Ann Example would like to check your site") && good.before.includes("can't change anything"));
check("the site sends the friend to the relay, to come back to /_check/done", good.relay.searchParams.get("to") === `${BASE}/_check/done`
  && /^[\w-]{20,}$/.test(good.relay.searchParams.get("challenge") ?? ""));
const exchange = exchanges.at(-1);
check("the code is swapped with the PKCE secret that matches the challenge", exchange?.code === "match.one-time-code"
  && b64url(createHash("sha256").update(exchange.code_verifier ?? "").digest()) === good.relay.searchParams.get("challenge"));
check("a genuine site is reported as exactly the release", good.after.includes("running exactly afterwrd 9.9.9"), good.after.slice(0, 300));
check("…connected to exactly what afterwrd uses", good.after.includes("connected to exactly what afterwrd uses"), good.after.slice(0, 500));
check("…and its account as only doing what afterwrd does, over both pages of the log", good.after.includes("did only what installing, updating and groups do (6 changes)"), good.after.slice(0, 600));
check("…counting an update removing an old secret as afterwrd's, and skipping sign-ins", !good.after.includes("script secret") && !good.after.includes("SSO_LOGIN")
  && !good.after.includes("isn't something afterwrd does"), good.after.slice(0, 900));
check("…and listing other Workers' changes apart, grouped, without counting them against the site", good.after.includes("2 changes to other things in your account")
  && good.after.includes("Upload Version · afterwrd-install (app) × 2") && good.after.includes("2026-11-07 18:20 to 2026-11-07 18:40"), good.after.slice(0, 1200));
check("the audit log is read newest first, page by page", audits.some((a) => a.direction === "desc" && a.cursor === "page-3"));
check("the result names the Worker and the end of the account id, not the account's name", good.after.includes("Worker localhost") && good.after.includes("abcdef")
  && !good.after.includes("someone@example.com"));
check("…and says first which site was checked, and which site checked it", good.after.includes("Ann Example's site checked yours")
  && good.after.includes("Site checked: localhost:8788") && good.after.includes("Checked by: Ann Example's site (localhost:8787)"), good.after.slice(0, 300));
check("the token was used only against the stand-in API", asked.filter((a) => a.startsWith("tok-match ")).length >= 8);
check("no cookie holds the token afterwards", !(await good.friend.cookies()).some((c) => c.name === "cf_check" || c.name === "cf_check_run"));
const again = await fetch(`${good.checkLink}/start`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ site: FRIEND_SITE }) });
check("a used link can't start another check", again.status === 409);

// --- asking for a check, by message ---------------------------------------------------------------------------
// This site has only just been installed (as a local site always looks): asking is held back for the hour.
await owner.goto(`${BASE}/_admin/update`);
const wait = await owner.$eval("#check-wait", (p) => p.textContent.replace(/\s+/g, " ")).catch(() => "");
check("for an hour after an update, Update says a check can't count yet, and offers no way to ask", wait.includes("updated less than an hour ago")
  && (await owner.$$("button[data-ask]")).length === 0 && await owner.$eval("#ask-other", (d) => d.hidden), wait);
check("…and the site won't send a request then either", (await asOwner("/_admin/checks/ask", { connection: 1 })).status === 409);
await owner.goto(`${BASE}/friend`);
check("Friends has the checker's side only", (await owner.$("#ask-check")) === null && (await owner.$("#check-site")) !== null
  && !(await owner.$eval("main", (m) => m.textContent)).includes("Check their site"));
const pasted = await makeLink({ site: "Could you check that my afterwrd site is genuine? It's at afterwrd.bob-example.workers.dev. Thank you!" });
const pastedPage = await (await fetch(pasted.link)).text();
check("a link made from a pasted message is for the site it names", pastedPage.includes("Your site: <b>afterwrd.bob-example.workers.dev</b>")
  && !pastedPage.includes('name="site"'));
await fetch(`${pasted.link}/start`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ site: FRIEND_SITE }) });
check("…and the person opening it can't point it at another site", sql("SELECT site FROM site_checks ORDER BY id DESC LIMIT 1")[0].site === "https://afterwrd.bob-example.workers.dev");
check("a message without an afterwrd address is refused", (await asOwner("/_admin/checks/new", { site: "Could you check my site please?" })).status === 400);
check("…as is a preview or lookalike address", (await asOwner("/_admin/checks/new", { site: "v2.afterwrd.bob.workers.dev or afterwrd.bob.workers.dev.evil.example" })).status === 400);
const fixedRun = await runCheck("match", FRIEND_SITE, true);
check("a check through a link made for a site runs on that site", fixedRun.after.includes("running exactly afterwrd 9.9.9"), fixedRun.after.slice(0, 200));

// --- a tampered site, with other things done in the account -------------------------------------------------------
const toldBeforeBad = toldChecked.length;
const bad = await runCheck("tampered");
check("a site whose check finds problems isn't told it was checked", toldChecked.length === toldBeforeBad);
check("tampered code is reported", bad.after.includes("is not the published afterwrd 9.9.9") && bad.after.includes("index.js: different"), bad.after.slice(0, 300));
check("a query on the site's own database is flagged, saying why it matters", bad.after.includes("Query D1 Database · x (its database) (app)")
  && bad.after.includes("add someone else's passkey"), bad.after.slice(0, 1500));
check("…and changes afterwrd doesn't make, escaped", bad.after.includes("Create DNS Record <img src=x onerror=alert(1)>") && bad.after.includes("someone-else")
  && (await bad.friend.$$("main img")).length === 0, bad.after.slice(0, 900));
check("…without keeping the names of other things in their account", !bad.after.includes("secret.example"));

check("…including a later change to the account's workers.dev name", bad.after.includes("Update Workers Subdomain"), bad.after.slice(0, 900));

// --- another Worker on the site's database ------------------------------------------------------------------------
const backdoor = await runCheck("backdoor");
check("another Worker connected to the site's database is reported, whatever it's called", backdoor.after.includes("Another Worker in the account is connected to its database")
  && backdoor.after.includes(": other."), backdoor.after.slice(0, 600));

// --- a Worker that isn't the one at the address -------------------------------------------------------------------
const elsewhere = await runCheck("elsewhere");
check("a Worker that isn't the one answering at the address is reported", elsewhere.after.includes("isn't the Worker that was checked"), elsewhere.after.slice(0, 500));

// --- genuine code, set up to leak ----------------------------------------------------------------------------------
const setup = await runCheck("setup", "http://localhost:8798");
check("a Worker whose requests are copied elsewhere is reported", setup.after.includes("copied to another Worker"), setup.after.slice(0, 600));
check("…as is a setting afterwrd doesn't use, named but not shown", setup.after.includes("plain_text OAUTH_TOKEN_URL") && !setup.after.includes("evil.example/token"));
check("…and files handed out without the code checking them", setup.after.includes("without its code checking them first (/static/style.css)"));

// --- changed within the hour ---------------------------------------------------------------------------------------
const recent = await runCheck("recent");
check("a site changed less than an hour ago is asked to be checked again later", recent.after.includes("less than an hour before this check")
  && recent.after.includes("ask for another check after"), recent.after.slice(0, 500));

// --- out of date ------------------------------------------------------------------------------------------------
const latest = JSON.stringify({ version: "10.0.0", checked: Math.floor(Date.now() / 1000),
  latest: { tag: "v10.0.0", version: "10.0.0", notes: "", page: "https://example.com/", securityFix: "10.0.0" } });
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${latest}')`);
const old = await runCheck("match");
check("a site older than a security fix needs updating", old.after.includes("older than afterwrd 10.0.0, which fixed a security problem"), old.after.slice(0, 400));
sql("UPDATE settings SET value = '{}' WHERE key = 'latest_release'");

// --- the wrong account, and a step that fails ---------------------------------------------------------------------
const missing = await runCheck("missing");
check("a Worker that isn't in the account allowed is reported", missing.after.includes("No Worker called localhost"), missing.after.slice(0, 200));
const failed = await makeLink();
const tryIt = await person(false);
await tryIt.setRequestInterception(true);
let failedRelay = null;
tryIt.on("request", (req) => {
  const at = new URL(req.url());
  if (at.hostname !== "afterwrd.app") return req.continue();
  if (at.pathname === "/connect/") failedRelay = at;
  req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" });
});
await tryIt.goto(failed.link);
await tryIt.type("input[name=site]", FRIEND_SITE);
await Promise.all([tryIt.waitForFunction(() => document.title === "relay stand-in"), tryIt.click("#check button")]);
await tryIt.goto(`${failedRelay.searchParams.get("to")}#${new URLSearchParams({ code: "bad.one-time-code", state: failedRelay.searchParams.get("state") })}`);
await tryIt.waitForFunction(() => document.getElementById("error")?.textContent.length > 0);
check("a failed step says so", (await tryIt.$eval("#error", (e) => e.textContent)).includes("couldn't finish"));
check("…and leaves the link usable", (await fetch(`${failed.link}/start`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" },
  body: JSON.stringify({ site: FRIEND_SITE }) })).status === 200);

// --- the owner's side ---------------------------------------------------------------------------------------------
await owner.goto(`${BASE}/friend`);
const listed = await owner.$$eval(".checks > li", (l) => l.map((li) => li.textContent.replace(/\s+/g, " ")));
const count = (word) => listed.filter((t) => t.includes(word)).length;
check("Friends lists the checks with a verdict each", count("check again later") === 1 && count("all good") === 2 && count("needs a look") === 5 && count("couldn't check") === 1,
  `${listed.length}: ${listed.map((t) => t.slice(0, 60)).join(" | ")}`);
check("…with no image injected from Cloudflare's answers", (await owner.$$(".checks img")).length === 0);

// --- refusals -----------------------------------------------------------------------------------------------------
check("another site can't make check links", (await asOwner("/_admin/checks/new", {}, "https://evil.example")).status === 403);
check("a check link can't be made for someone who isn't a friend", (await asOwner("/_admin/checks/new", { connection: 999 })).status === 404);
const fresh = (await makeLink()).link;
check("another site can't start a check", (await fetch(`${fresh}/start`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status === 403);
check("only workers.dev addresses (or this computer, in tests) can be checked", (await fetch(`${fresh}/start`, { method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ site: "https://example.com" }) })).status === 400);
check("finishing without the start cookie is refused", (await fetch(`${BASE}/_check/finish`, { method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ code: "match.one-time-code", state: "x".repeat(32) }) })).status === 400);
check("a made-up link says so", (await fetch(`${BASE}/_check/${"a".repeat(43)}`)).status === 404);


// --- this site being told it was checked -------------------------------------------------------------------------
const tell = (body, key = OUR_KEY) => fetch(`${BASE}/_peer/checked`, { method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("only a friend can say they checked this site", (await tell({ type: "Checked", site: BASE, version: "9.9.9" }, "x".repeat(43))).status === 401);
check("…and only of this site", (await tell({ type: "Checked", site: "http://localhost:8789", version: "9.9.9" })).status === 400
  && (await textOf("/")).includes("hasn't been checked yet"));
check("a friend's site saying it checked this one is kept", (await tell({ type: "Checked", site: BASE, version: "9.9.9" })).status === 200);
check("…and Home stops suggesting a check", !(await textOf("/")).includes("hasn't been checked yet"));
check("…as does Add a friend", !(await textOf("/_admin/connections")).includes("hasn't been checked yet"));
const lastLine = await textOf("/_admin/update", "#last-checked");
check("…and Update says who checked it last, and when", /^Last checked by Bob Example's site on \d{1,2} \w{3} \d{4} \(afterwrd 9\.9\.9\)\.$/.test(lastLine), lastLine);
await Promise.all([owner.waitForNavigation(), owner.click("#check form button.link")]);
const mine = await owner.$eval("#last-checked", (p) => p.textContent);
check("the owner can say they checked it themselves, from Update", owner.url().endsWith("/_admin/update#check")
  && /^You last checked it yourself, on \d{1,2} \w{3} \d{4}\.$/.test(mine), mine);
check("another site can't say the owner checked it", (await asOwner("/_admin/checks/myself", {}, "https://evil.example")).status === 403);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
direct.close();
friendSite.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
