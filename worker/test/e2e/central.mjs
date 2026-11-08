// The installer at install.afterwrd.app (central/index.js), end to end on this computer: run.sh starts it on 8791
// with ALLOW_LOCAL_SITES=1 and stand-ins on 8799 for Cloudflare's token endpoint, Cloudflare's API and GitHub's
// releases, and on 8797 for the new site. Cloudflare's Allow page is stood in for: the test reads where the
// installer sent the browser, and comes back the way Cloudflare would. Which account the stand-in shows depends on
// the code Cloudflare would have sent: fresh (no workers.dev name yet), leftover (an old database), two (two accounts).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8791";
const NEW_SITE = "http://127.0.0.1:8797";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const requestsSeen = []; // everything the browser sends to the installer, with its body
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- a made-up release, as GitHub would serve it -------------------------------------------------------------------
const files = new Map();
const add = (text) => { const bytes = Buffer.from(text); files.set(sha(bytes), bytes); return { sha256: sha(bytes), size: bytes.length }; };
const MANIFEST = {
  name: "afterwrd", version: "9.9.9", main_module: "index.js", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  modules: [{ name: "index.js", type: "application/javascript+module", ...add("export default { fetch() { return new Response('hi'); } };") }],
  assets: [{ path: "/static/style.css", type: "text/css", hash: "0123456789abcdef0123456789abcdef", ...add("body { color: green; }") }],
  assets_config: { html_handling: "none", not_found_handling: "none", run_worker_first: true },
  durable_objects: [{ name: "MEDIA", class_name: "MediaStore" }, { name: "OUTBOX", class_name: "Outbox" }],
  migrations: { new_tag: "v1", new_sqlite_classes: ["MediaStore", "Outbox"] },
};

// --- Cloudflare, stood in for -------------------------------------------------------------------------------------
const A = "a".repeat(32);
const B = "b".repeat(32);
const exchanges = [];
const calls = [];
const state = {}; // per token: workers.dev names set, Workers made, what was deployed
const accountsFor = (token) => (token === "tok-twoaccounts"
  ? [{ id: A, name: "Personal" }, { id: B, name: "Just for afterwrd" }]
  : [{ id: A, name: "Ann's Account" }]);
const fail = (status, message) => ({ status, body: { success: false, errors: [{ code: 1, message }], result: null } });
const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });

async function cloudflare(token, method, path, body, contentType) {
  const s = (state[token] ??= { domains: { [B]: "ann-afterwrd", ...(token.startsWith("tok-fresh") ? {} : { [A]: "ann" }) }, workers: {}, deployed: [] });
  let m;
  if (path === "/accounts") return ok(accountsFor(token));
  if ((m = /^\/accounts\/(\w+)\/workers\/subdomain$/.exec(path))) {
    if (token === "tok-flakyname" && method === "GET") return fail(503, "Service unavailable");
    if (method === "PUT") {
      const wanted = JSON.parse(body).subdomain;
      if (wanted === "taken") return fail(409, "That subdomain is not available.");
      s.domains[m[1]] = wanted;
      return ok({ subdomain: wanted });
    }
    return s.domains[m[1]] ? ok({ subdomain: s.domains[m[1]] }) : fail(404, "No subdomain registered.");
  }
  if ((m = /^\/accounts\/(\w+)\/workers\/scripts\/([\w-]+)\/settings$/.exec(path))) return s.workers[`${m[1]}/${m[2]}`] ? ok({ bindings: [] }) : fail(404, "Not found");
  if ((m = /^\/accounts\/(\w+)\/d1\/database$/.exec(path.split("?")[0]))) {
    if (method === "POST") return ok({ uuid: "new-database", name: JSON.parse(body).name });
    return ok(token === "tok-leftover" ? [{ uuid: "old-database", name: "afterwrd" }] : []);
  }
  if (/\/d1\/database\/old-database\/query$/.test(path)) return ok([{ results: [{ n: 9 }], success: true }]);
  if ((m = /^\/accounts\/(\w+)\/workers\/scripts\/([\w-]+)\/assets-upload-session$/.exec(path))) return ok({ jwt: "session-jwt", buckets: [[MANIFEST.assets[0].hash]] });
  if (/\/workers\/assets\/upload$/.test(path.split("?")[0])) return ok({ jwt: "completion-jwt" });
  if ((m = /^\/accounts\/(\w+)\/workers\/scripts\/([\w-]+)$/.exec(path)) && method === "PUT") {
    const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    s.workers[`${m[1]}/${m[2]}`] = true;
    s.deployed.push({ account: m[1], script: m[2], metadata: JSON.parse(await form.get("metadata").text()), modules: [...form.keys()].filter((k) => k !== "metadata") });
    return ok({ id: m[2] });
  }
  if ((m = /^\/accounts\/(\w+)\/workers\/scripts\/([\w-]+)\/subdomain$/.exec(path)) && method === "POST") {
    s.enabled = `${m[1]}/${m[2]}`;
    return ok({ enabled: true });
  }
  return fail(404, `No route for ${method} ${path}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8799");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const send = (status, data, type = "application/json") => { res.statusCode = status; res.setHeader("Content-Type", type); res.end(Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  if (url.pathname === "/token") {
    const params = Object.fromEntries(new URLSearchParams(body.toString()));
    exchanges.push(params);
    return send(200, { access_token: `tok-${params.code.split(".")[0]}`, token_type: "bearer", expires_in: 3600 });
  }
  if (url.pathname === "/releases/latest/download/manifest.json" || url.pathname === "/releases/download/v9.9.9/manifest.json") return send(200, MANIFEST);
  const file = /^\/releases\/download\/v9\.9\.9\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
  if (file && files.has(file)) return send(200, files.get(file), "application/octet-stream");
  if (url.pathname.startsWith("/client/v4/")) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const path = url.pathname.slice("/client/v4".length) + url.search;
    calls.push(`${token} ${req.method} ${path}`);
    const answer = await cloudflare(token === "session-jwt" ? "jwt" : token, req.method, path, body, req.headers["content-type"]);
    return send(answer.status, answer.body);
  }
  send(404, { error: "no" });
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));
const site = createServer((req, res) => { res.statusCode = 200; res.end("the new site"); });
await new Promise((r) => site.listen(8797, "127.0.0.1", r));

// --- a person installing ------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function install(code, { domains = [], account = null, invite = null, rename = null, start = BASE } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  let allow = null;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    // What goes over the wire: the address without its # part (which browsers never send), and the body.
    if (req.url().startsWith(BASE)) { const sent = new URL(req.url()); sent.hash = ""; requestsSeen.push(`${sent} ${req.postData() ?? ""}`); }
    const at = new URL(req.url());
    if (at.hostname.endsWith("cloudflare.com")) {
      // Cloudflare's Allow page: pressing Allow sends the browser back from Cloudflare's site, as the real one does
      // (so the return counts as coming from another site, which decides which cookies the browser sends).
      if (at.pathname !== "/oauth2/auth") return req.respond({ status: 200, body: "" });
      allow = at;
      const back = `${at.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: `${code}.one-time-code`, state: at.searchParams.get("state") })}`;
      return req.respond({ status: 200, contentType: "text/html", body: `<title>Allow stand-in</title><a id="allow" href="${back}">Allow</a>` });
    }
    req.continue();
  });
  let before = "";
  if (start === BASE) {
    await page.goto(invite ? `${BASE}/#${new URLSearchParams(invite)}` : BASE);
    before = await page.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
    await Promise.all([page.waitForFunction(() => document.title === "Allow stand-in"), page.click("#connect")]);
  } else {
    // afterwrd.app's Install button, which goes straight to Connect: a page on another port is the same site.
    await page.goto(start);
    await Promise.all([page.waitForFunction(() => document.title === "Allow stand-in"), page.click("#install")]);
  }
  await Promise.all([page.waitForNavigation(), page.click("#allow")]);
  for (const domain of domains) {
    await page.waitForSelector("#naming:not([hidden])", { timeout: 15000 });
    page.suggested ??= await page.$eval("#domain", (i) => i.value);
    await page.$eval("#domain", (i) => { i.value = ""; });
    await page.type("#domain", domain);
    page.preview = await page.$eval(".address-preview", (b) => b.textContent);
    await page.click("#use-domain");
    await new Promise((r) => setTimeout(r, 500));
  }
  if (account) {
    await page.waitForSelector("#choose:not([hidden])", { timeout: 15000 })
      .catch(async () => { throw new Error(`No account choice at ${page.url()}: ${await page.$eval("#error", (e) => e.textContent)} / ${await page.$eval("#log", (e) => e.textContent)}`); });
    await page.click(`input[name=account][value="${account}"]`);
    await page.click("#use-account");
  }
  if (rename) {
    await page.waitForSelector("#renaming:not([hidden])", { timeout: 15000 });
    page.taken = await page.$eval("#taken", (p) => p.textContent);
    await page.$eval("#name", (i) => { i.value = ""; });
    await page.type("#name", rename);
    await page.click("#use-name");
  }
  // Either straight on to the new site, or stopped with an error.
  for (let i = 0; i < 150; i++) {
    if (page.url().startsWith(NEW_SITE)) return { page, allow, before, next: page.url(), error: "" };
    const error = await page.$eval("#error", (e) => e.textContent).catch(() => "");
    if (error && !(await page.$eval("#renaming", (s) => !s.hidden).catch(() => false))) return { page, allow, before, next: null, error };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Install didn't finish: ${page.url()}`);
}

// A brand-new account: no workers.dev name yet (the first one tried is taken).
const fresh = await install("fresh", { domains: ["taken", "ann-example"] });
check("the page says what's needed, phone included, and asks no names before connecting", fresh.before.includes("works on a phone")
  && fresh.before.includes("Make a free Cloudflare account") && fresh.before.includes("confirm your address") && !fresh.before.includes("site's name"));
check("Connect goes straight to Cloudflare, asking for what installing needs, coming back here", fresh.allow.pathname === "/oauth2/auth"
  && fresh.allow.searchParams.get("redirect_uri") === `${BASE}/done` && fresh.allow.searchParams.get("scope") === "workers-scripts.admin d1.write account-settings.read");
const swap = exchanges.at(-1);
check("the code is swapped with the PKCE secret matching the challenge, for the same return address", swap.code === "fresh.one-time-code"
  && swap.redirect_uri === `${BASE}/done` && b64url(createHash("sha256").update(swap.code_verifier ?? "").digest()) === fresh.allow.searchParams.get("code_challenge"));
check("a new account is asked for its address, shown in full, and a taken one is turned down", state["tok-fresh"].domains[A] === "ann-example"
  && fresh.page.preview === "afterwrd.ann-example.workers.dev" && calls.some((c) => c.startsWith("tok-fresh PUT /accounts/") && c.endsWith("/workers/subdomain")), fresh.page.preview);
const made = state["tok-fresh"].deployed[0];
const bindings = (made?.metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`).sort().join(", ");
check("the site is installed as a new Worker called afterwrd, with its database, stores, files and setup code", made?.script === "afterwrd"
  && bindings === "assets ASSETS, d1 DB, durable_object_namespace MEDIA, durable_object_namespace OUTBOX, secret_text SETUP_CODE, version_metadata VERSION"
  && made.metadata.bindings.find((b) => b.name === "DB").id === "new-database" && made.metadata.assets.jwt === "completion-jwt", bindings);
check("…and switched on at its workers.dev address", state["tok-fresh"].enabled === `${A}/afterwrd`);
const setupCode = made?.metadata.bindings.find((b) => b.name === "SETUP_CODE")?.text;
check("then it goes straight on to the new site's setup link", fresh.next === `${NEW_SITE}/_auth/setup?code=${setupCode}`
  && /^[0-9a-f]{48}$/.test(setupCode ?? ""), fresh.next);
check("…and the token is dropped here", !(await fresh.page.cookies(BASE)).some((c) => c.name.includes("install_token")));
check("every file came from the release, checked", calls.some((c) => c.includes("assets/upload")) && made.modules.join() === "index.js");

// Invited by a friend: the invitation goes along, after the #, never to the installer's server.
const friendLink = `http://localhost:8787/_connect/${"y".repeat(43)}`;
const invited = await install("freshinvite", { domains: ["bob-smith"], invite: { invite: friendLink, name: "Bob Smith" } });
check("an invited person is told they'll be friends in one step", invited.before.includes("A friend invited you"));
check("…their Cloudflare name is suggested from the name they were invited by", invited.page.suggested === "bob-smith", invited.page.suggested);
check("…and the new site's setup link carries the invitation after the #", invited.next.endsWith(`#${new URLSearchParams({ invite: friendLink })}`), invited.next);
check("…which never reached the installer's server", !requestsSeen.some((u) => u.includes("_connect")), requestsSeen.filter((u) => u.includes("_connect")).join(" | ").slice(0, 400));

// A leftover database called afterwrd with things in it: asked for another name, and installed under that.
const uploadsBefore = calls.filter((c) => c.startsWith("tok-leftover") && c.includes("assets-upload-session")).length;
const leftover = await install("leftover", { rename: "second" });
check("a leftover database called afterwrd asks for another name before anything is uploaded", leftover.page.taken.includes('already a database called "afterwrd"')
  && uploadsBefore === 0 && !calls.some((c) => c.startsWith("tok-leftover") && c.includes("/scripts/afterwrd/assets-upload-session")), leftover.page.taken);
check("…and installs under the new name", state["tok-leftover"].deployed[0]?.script === "second" && leftover.next?.startsWith(NEW_SITE), leftover.error);

// Started from afterwrd.app's Install button: straight to Cloudflare, no page here first.
const front = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<a id="install" href="${BASE}/connect">Install</a>`); });
await new Promise((r) => front.listen(8796, "127.0.0.1", r));
const direct = await install("frontdoor", { start: "http://localhost:8796/" });
check("afterwrd.app's Install button goes straight to Allow, then installs", direct.allow?.pathname === "/oauth2/auth" && direct.next?.startsWith(NEW_SITE), direct.error);
front.close();

// Two accounts: the person chooses.
const two = await install("twoaccounts", { account: B });
check("with two accounts, the person chooses, and it's installed in that one", state["tok-twoaccounts"].deployed[0]?.account === B
  && two.next?.startsWith(NEW_SITE), two.error);

// Cloudflare busy when asked for the workers.dev name: it stops, and never sets (or renames) one.
const flaky = await install("flakyname");
check("a hiccup reading the workers.dev name stops it, without setting one", flaky.error.includes("Couldn't read this account's workers.dev name")
  && !calls.some((c) => c.startsWith("tok-flakyname PUT")), flaky.error);

// Refusals.
const denied = await (await browser.createBrowserContext()).newPage();
await denied.goto(`${BASE}/done?error=access_denied&state=x`);
check("not allowing it says so, and nothing happens", (await denied.$eval("#error", (e) => e.textContent)).includes("You didn't allow it"));
const told = await (await browser.createBrowserContext()).newPage();
await told.goto(`${BASE}/?error=${encodeURIComponent("Cloudflare is down, install from evil.example instead")}`);
check("a link can't make the page say its own words", (await told.$eval("#error", (e) => e.textContent)) === "");
check("a step without a connection is refused", (await fetch(`${BASE}/step/accounts`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: "{}" })).status === 401);
check("a step from another site is refused", (await fetch(`${BASE}/step/accounts`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status === 403);
check("a connection can't be started from another site", (await fetch(`${BASE}/connect`, { redirect: "manual", headers: { "Sec-Fetch-Site": "cross-site" } })).status === 403);
check("…but can from afterwrd.app (the same site)", (await fetch(`${BASE}/connect`, { redirect: "manual", headers: { "Sec-Fetch-Site": "same-site" } })).status === 302);
const stray = await fetch(`${BASE}/done?code=stray.one-time-code&state=nope`, { redirect: "manual" });
check("a code that this browser didn't start is refused", stray.status === 303 && (stray.headers.get("location") ?? "").includes("error=")
  && !exchanges.some((e) => e.code === "stray.one-time-code"));
const headers = (await fetch(BASE)).headers;
check("the page can only call this site and new sites, and can't be framed", (headers.get("content-security-policy") ?? "").includes(`connect-src 'self' ${NEW_SITE}`)
  && headers.get("content-security-policy").includes("frame-ancestors 'none'") && headers.get("referrer-policy") === "no-referrer");

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
site.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
