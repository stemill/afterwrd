// Checks for the security review's fixes. Run against a fresh local database with SETUP_CODE=local-test-setup-code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const CODE = "local-test-setup-code";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const sql = (q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", q],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const post = (path, body, cookie, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: `__Host-session=${cookie}` } : {}) },
  body: JSON.stringify(body ?? {}) });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("dialog", (d) => d.accept());
  return page;
}
const session = async (page) => (await page.cookies()).find((c) => c.name === "__Host-session");

// --- setup link ------------------------------------------------------------------
check("setup with a wrong code is refused", (await fetch(`${BASE}/_auth/setup?code=wrong`)).status === 403);
check("setup page shows with the right code", (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).status === 200);
const first = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
const again = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
check("an unfinished setup can be resumed (no passkey yet)", Boolean(first.link && again.link && first.link !== again.link)
  && sql("SELECT COUNT(*) AS n FROM users")[0].n === 1);
check("…and only the newest setup link works", (await fetch(first.link)).status === 404
  && sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 1);
const spareSetup = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
const setupPage = await (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).text();
check("the setup page takes the code off the address bar", setupPage.includes('history.replaceState(null, "", "/_auth/setup")'));
const ownerInvite = sql("SELECT MAX(expires_at) - strftime('%s','now') AS left FROM device_links")[0].left;
check("the owner's setup link lasts an hour", ownerInvite > 3500 && ownerInvite <= 3600, `${ownerInvite}s`);
// A stray unused link (as an older release could leave) is cancelled by the first passkey.
sql(`INSERT INTO device_links (token_hash, user_id, expires_at) VALUES ('${"a".repeat(64)}', (SELECT id FROM users), strftime('%s','now') + 3600)`);
const owner = await person();
await owner.goto(spareSetup.link);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
check("owner registers from the resumed link", ["/", "/posts"].includes(new URL(owner.url()).pathname) || (await owner.content()).includes("Nothing has been published"));
check("setup is closed once a passkey exists", (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).status === 409);
check("the first passkey cancels any other setup link", sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 0);

// --- cookies and headers ---------------------------------------------------------------
const cookie = await session(owner);
check("session cookie is __Host-, HttpOnly, Secure", Boolean(cookie && cookie.httpOnly && cookie.secure && cookie.path === "/"));
const csp = (await fetch(`${BASE}/_auth/login`)).headers.get("content-security-policy") ?? "";
check("CSP blocks plugins, <base> and foreign form posts", ["object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].every((d) => csp.includes(d)), csp);

// --- open redirect ------------------------------------------------------------------
for (const [next, expected] of [["/%5Cevil.example", "/"], ["/%09/evil.example", "/"], ["https://evil.example/", "/"], ["/posts?page=2", "/posts?page=2"]]) {
  const body = await (await fetch(`${BASE}/_auth/login?next=${next}`)).text();
  const got = JSON.parse(/const next = ("[^"]*")/.exec(body)[1]);
  check(`sign-in redirect ${decodeURIComponent(next)} goes to ${expected}`, got === expected, got);
}

// --- anonymous sign-in requests don't write --------------------------------------------
// (latest_release is the owner's update check, saved in the background after their page loads.)
const count = () => sql(`SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM used_challenges)
  + (SELECT COUNT(*) FROM settings WHERE key != 'latest_release') AS n`)[0].n;
const before = count();
for (let i = 0; i < 15; i++) await post("/_auth/login/options");
check("15 anonymous sign-in requests write nothing", count() === before);

// --- a sign-in can't be replayed ---------------------------------------------------------
await owner.goto(`${BASE}/_auth/logout`);
await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_auth/logout'] button")]);
check("signed out after the sign-out form", !(await session(owner)));
let captured = null;
await owner.setRequestInterception(true);
const capture = (r) => {
  if (r.url().endsWith("/_auth/login/verify")) captured = { body: r.postData(), cookie: r.headers().cookie };
  r.continue();
};
owner.on("request", capture);
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
owner.off("request", capture);
await owner.setRequestInterception(false);
check("owner signs back in", Boolean(await session(owner)));
const replay = await fetch(`${BASE}/_auth/login/verify`, { method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json", Cookie: captured.cookie }, body: captured.body });
check("replaying that exact sign-in is refused", replay.status === 400 && !(replay.headers.get("set-cookie") ?? "").includes("__Host-session=") , `HTTP ${replay.status}`);
const logout = await post("/_auth/logout", null, (await session(owner)).value);
check("signing out asks the browser to clear cached photos", (logout.headers.get("clear-site-data") ?? "").includes('"cache"'));
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
let ownerCookie = (await session(owner)).value;

// --- Your devices: links, sign-out everywhere, passkeys ------------------------------------
const ownerId = sql("SELECT id FROM users")[0].id;
const deviceLink = (await (await post("/_admin/devices/link", {}, ownerCookie)).json()).link;
const left = sql(`SELECT MAX(expires_at) - strftime('%s','now') AS left FROM device_links WHERE user_id = ${ownerId} AND used_at IS NULL`)[0].left;
check("a device link lasts an hour", left > 3500 && left <= 3600, `${left}s`);
const laptop = await person();
await laptop.goto(deviceLink);
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
check("a second device signs in as the owner", Boolean(await session(laptop)));
const [ownerKey, laptopKey] = sql(`SELECT id FROM credentials WHERE user_id = ${ownerId} ORDER BY created_at, rowid`).map((k) => k.id);
const spare = (await (await post("/_admin/devices/link", {}, ownerCookie)).json()).link;
await post("/_admin/devices/cancel-links", {}, ownerCookie);
check("Cancel unused links removes them", sql(`SELECT COUNT(*) AS n FROM device_links WHERE user_id = ${ownerId} AND used_at IS NULL`)[0].n === 0
  && (await fetch(spare)).status === 404);
await post("/_admin/devices/sign-out", {}, ownerCookie);
await laptop.goto(`${BASE}/posts`);
check("Sign out everywhere ends every session", new URL(laptop.url()).pathname === "/_auth/login"
  && (await fetch(`${BASE}/_admin`, { redirect: "manual", headers: { Cookie: `__Host-session=${ownerCookie}` } })).status === 302);
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
ownerCookie = (await session(owner)).value;
await post("/_admin/devices/delete-passkey", { credential: laptopKey }, ownerCookie);
await laptop.click("#go");
await laptop.waitForFunction(() => document.getElementById("error").textContent.length > 0);
check("a removed passkey can't sign in", (await laptop.$eval("#error", (e) => e.textContent)).includes("isn't recognised"));
check("the last passkey can't be removed", (await post("/_admin/devices/delete-passkey", { credential: ownerKey }, ownerCookie)).status === 400);
check("there's no inviting anyone else", (await post("/_admin/invite", { name: "Viewer" }, ownerCookie)).status === 404);

// --- import validation ------------------------------------------------------------------
await post("/_admin/import/start", {}, ownerCookie);
const media = (over) => ({ table: "media", rows: [{ id: 1, path: "a.jpg", kind: "photo", ...over }] });
check("import refuses markup in a number column", (await post("/_admin/import/rows", media({ width: '1" onerror="alert(1)' }), ownerCookie)).status === 400);
check("import refuses a fake file address", (await post("/_admin/import/rows", media({ hash: "../../etc" }), ownerCookie)).status === 400);
check("import refuses a page as a media type", (await post("/_admin/import/rows", media({ type: "text/html" }), ownerCookie)).status === 400);
check("import accepts a proper row", (await post("/_admin/import/rows", media({ width: 800, height: 600, hash: "a".repeat(64), type: "image/jpeg" }), ownerCookie)).ok);

// --- media store: re-uploading can't damage a stored file -----------------------------------------
const bytes = Buffer.from("not really a jpeg, but bytes are bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const put = (body) => fetch(`${BASE}/_admin/import/files/${hash}`, { method: "PUT", body,
  headers: { Origin: BASE, "Content-Type": "image/jpeg", Cookie: `__Host-session=${ownerCookie}` } });
await put(bytes);
const second = await (await put(Buffer.from("different bytes that would fail the hash check"))).json();
const served = Buffer.from(await (await fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).arrayBuffer());
check("re-uploading a stored file leaves it intact", second.existing === true && served.equals(bytes));

// --- lookups by name can't reach object internals --------------------------------------------
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '["overview","timeline","posts","photos","comments","likes","friends"]');
     INSERT OR REPLACE INTO people (id, name, is_me) VALUES (1, 'Me', 1)`);
for (const path of ["/friends?sort=constructor", "/friends?sort=__proto__", "/people/1?tab=__proto__", "/people/1?tab=constructor"]) {
  const res = await fetch(BASE + path, { headers: { Cookie: `__Host-session=${ownerCookie}` } });
  check(`${path} is handled, not a crash`, res.status === 200, `HTTP ${res.status}`);
}

// --- where sign-in sends you ---------------------------------------------------------------------
for (const trick of ["/.//evil.example", "/..//evil.example", "/%2e//evil.example", "/./%5Cevil.example", "https://evil.example/"]) {
  const loginPage = await (await fetch(`${BASE}/_auth/login?next=${encodeURIComponent(trick)}`)).text();
  const next = JSON.parse(/const next = ("[^"]*")/.exec(loginPage)[1]);
  check(`sign-in won't send you off the site (${trick})`, new URL(next, BASE).origin === BASE && !next.startsWith("//"), next);
}

// --- update page ------------------------------------------------------------------------------
const updatePage = await (await fetch(`${BASE}/_admin/update`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).text();
check("owner's Update page shows this version", updatePage.includes(`This site is afterwrd ${JSON.parse(execFileSync("cat", [`${WORKER}/package.json`], { encoding: "utf8" })).version}`));
const update404 = await fetch(`${BASE}/_admin/update/version`, { redirect: "manual" });
check("Update isn't reachable signed out", update404.status === 302);
check("Update refuses a made-up release name", (await post("/_admin/update/check", { token: "x", tag: "v1;rm" }, ownerCookie)).status === 400);

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
