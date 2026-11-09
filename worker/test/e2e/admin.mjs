// End-to-end for Your devices: only the owner signs in. The owner adds a second device from the page, removes a
// passkey (never the last), cancels unused links and signs out everywhere; there's no inviting anyone else.
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/owner.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// Each suite starts on a new site (run.sh), and makes its owner from the terminal: the link to add their first device.
const newOwner = (name) => cli(name).match(/http\S+\/_auth\/device\/\S+/)[0];
const sql = (command) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", command],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
// The main menu, then what's behind the person's picture.
const navLabels = (page) => page.$$eval("header.site nav.main a, header.site .menu > a", (a) => a.map((x) => x.querySelector("span").textContent.trim()).join(","));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

async function device() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  return page;
}
async function register(page, link) {
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
}
const passkeys = (page) => page.$$eval(".devices li", (l) => l.map((li) => ({
  id: li.querySelector("button").dataset.credential, disabled: li.querySelector("button").disabled })));

// The owner joins via the terminal, as on a brand-new site.
const ownerName = `Owner ${Date.now()}`;
const phone = await device();
await register(phone, newOwner(ownerName));
let second = "";
try { cli(`Second ${Date.now()}`); } catch (e) { second = String(e.stderr); }
check("the terminal won't make a second owner", second.includes("already has an owner"), second.trim());
check("the menu has Your devices", (await navLabels(phone)) === "Home,Photos,Friends,Groups,Notifications,Your profile,Your devices,Import,Download everything,Update", await navLabels(phone));
await phone.goto(`${BASE}/_admin`);
check("Your devices lists one passkey, which can't be removed", (await phone.$eval("h1", (h) => h.textContent)) === "Your devices"
  && JSON.stringify((await passkeys(phone)).map((k) => k.disabled)) === "[true]");
check("no inviting other people", !(await phone.$("#invite")) && !(await phone.$("button[data-action=revoke]")));

const alerts = async (page) => { await page.goto(`${BASE}/`); return page.$$eval(".notice.alert", (n) => n.map((x) => x.textContent.replace(/\s+/g, " ").trim())); };
check("the first passkey isn't a new device", (await alerts(phone)).length === 0);
// Add a laptop from the page.
await phone.goto(`${BASE}/_admin`);
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
const link = await phone.$eval("#link-url", (i) => i.value);
check("Add a device shows a one-time link", /\/_auth\/device\/[\w-]{40,}$/.test(link), link.slice(0, 60) + "…");
const laptop = await device();
await laptop.goto(link);
check("the link says it's adding a device", (await laptop.title()).startsWith("Add this device") && (await laptop.$eval("main, body", (m) => m.textContent)).includes("Add this phone or computer"));
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
check("the laptop is signed in as the owner", (await navLabels(laptop)).includes("Your devices"), await navLabels(laptop));
const reuse = await (await device()).goto(link);
check("the link only works once", reuse.status() === 404);

// The phone hears that a device was added; the laptop (the new device) doesn't, and can't hide it.
check("Home on the phone says a new device was added", (await alerts(phone)).some((t) => t.startsWith("A new device was added")), (await alerts(phone)).join(" | "));
check("…but not on the new device itself", (await alerts(laptop)).length === 0);
const laptopCookie = (await laptop.cookies()).find((c) => c.name === "__Host-session").value;
const fromLaptop = (path) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${laptopCookie}`, Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
check("the new device can't say it was them", (await fromLaptop("/_admin/devices/seen")).status === 403 && (await alerts(phone)).length === 1);
// An intruder's trick: add a second passkey from the new device, then confirm from the first. Neither can.
const spare = await device();
await register(spare, (await (await fromLaptop("/_admin/devices/link")).json()).link);
const onLaptop = await alerts(laptop);
check("the new device hears of the next one, but can't confirm it", onLaptop.length === 1 && onLaptop[0].includes("say so from one of your older devices")
  && (await laptop.$$(".notice.alert button")).length === 0, onLaptop.join(" | "));
check("…even by asking directly", (await fromLaptop("/_admin/devices/seen")).status === 403);
const onPhone = await alerts(phone);
check("the phone lists both new devices", onPhone.length === 1 && onPhone[0].startsWith("2 new devices were added"), onPhone.join(" | "));
await Promise.all([phone.waitForNavigation(), phone.click(".notice.alert button")]);
check("\"They were all me\" on the phone clears it", new URL(phone.url()).pathname === "/" && (await alerts(phone)).length === 0);
// Put things back as they were: the spare passkey goes (the laptop's stays for the checks below).
const spareKey = sql("SELECT id FROM credentials ORDER BY rowid DESC LIMIT 1")[0].id;
const phoneCookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
await fetch(`${BASE}/_admin/devices/delete-passkey`, { method: "POST", headers: { Cookie: `__Host-session=${phoneCookie}`, Origin: BASE,
  "Content-Type": "application/json" }, body: JSON.stringify({ credential: spareKey }) });
check("the laptop, no longer new, has nothing to hear", (await alerts(laptop)).length === 0);

// A release that fixes a security problem: Home says so, and so does the Update page. (A made-up release, saved as
// if the owner's site had just checked GitHub.)
const nowSeconds = Math.floor(Date.now() / 1000);
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${JSON.stringify({ version: "99.0.1", checked: nowSeconds,
  latest: { tag: "v99.0.1", version: "99.0.1", notes: "Made up.", page: "https://example.com/", securityFix: "99.0.0" } })}')`);
check("Home says an update fixes a security problem", (await alerts(phone)).some((t) => t.includes("99.0.0 fixes a security problem")), (await alerts(phone)).join(" | "));
await phone.goto(`${BASE}/_admin/update`);
check("…and so does the Update page", (await phone.$eval("main", (m) => m.textContent)).includes("It fixes a security problem"));
// An ordinary update: no line on Home (only security fixes get one), just the red dot on the picture and
// "Update available" behind it, on every page, even one that was already open.
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${JSON.stringify({ version: "99.0.2", checked: nowSeconds,
  latest: { tag: "v99.0.2", version: "99.0.2", notes: "Made up.", page: "https://example.com/" } })}')`);
const homeLines = async () => { await phone.goto(`${BASE}/`); return phone.$$eval(".stream > .notice", (n) => n.map((x) => x.textContent.replace(/\s+/g, " ").trim())); };
check("Home doesn't mention an ordinary update", !(await homeLines()).some((t) => t.includes("99.0.2")), (await homeLines()).join(" | "));
check("…but the picture has the dot", (await phone.$$("details.me summary .dot")).length === 1);
const ownerCookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
const live = await (await fetch(`${BASE}/_live?since=0`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).json();
check("the live check reports it", live.update === "99.0.2", JSON.stringify(live));
await phone.goto(`${BASE}/_admin`);
await phone.waitForFunction(() => document.querySelector('.menu a[href="/_admin/update"]')?.textContent.includes("Update available"), { timeout: 10000 })
  .catch(() => {});
check("an owner page gains the mark by itself, dot included", (await phone.$eval('.menu a[href="/_admin/update"]', (a) => a.textContent)).includes("Update available")
  && (await phone.$$("details.me summary .dot")).length === 1);
sql("DELETE FROM settings WHERE key = 'latest_release'");

await phone.goto(`${BASE}/_admin`);
let keys = await passkeys(phone);
check("two passkeys now, both removable", keys.length === 2 && keys.every((k) => !k.disabled));

// Unused links can be cancelled.
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
const unused = await phone.$eval("#link-url", (i) => i.value);
await phone.goto(`${BASE}/_admin`);
await Promise.all([phone.waitForNavigation(), phone.click("button[data-action=cancel-links]")]);
check("cancelled links stop working", (await (await device()).goto(unused)).status() === 404);

// The API refuses another site, other people's passkeys and the last passkey.
const cookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
const api = (path, body, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
check("another site can't make a device link", (await api("/_admin/devices/link", {}, "https://evil.example")).status === 403);
check("the old People actions are gone", (await api("/_admin/invite", { name: "Sneaky" })).status === 404
  && (await api("/_admin/people/1/revoke")).status === 404);
check("a made-up passkey can't be removed", (await api("/_admin/devices/delete-passkey", { credential: "not-a-passkey" })).status === 404);

// Remove the laptop's passkey: the laptop is signed out, the phone isn't; then the phone's is the last and stays.
// Which is which, in the order they were made.
const [phoneKey, laptopKey] = sql(`SELECT c.id FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.name = '${ownerName}' ORDER BY c.rowid`).map((k) => k.id);
check("removing a passkey works", (await api("/_admin/devices/delete-passkey", { credential: laptopKey })).status === 200);
await laptop.goto(`${BASE}/posts`);
await phone.goto(`${BASE}/posts`);
check("…and signs that device out, only that one", new URL(laptop.url()).pathname === "/_auth/login" && new URL(phone.url()).pathname === "/posts");
check("the last passkey can't be removed", (await api("/_admin/devices/delete-passkey", { credential: phoneKey })).status === 400);

// Sign out everywhere.
const tablet = await device();
await phone.goto(`${BASE}/_admin`);
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
await register(tablet, await phone.$eval("#link-url", (i) => i.value));
await phone.goto(`${BASE}/_admin`);
await Promise.all([phone.waitForNavigation(), phone.click("button[data-action=sign-out]")]);
await tablet.goto(`${BASE}/posts`);
check("sign out everywhere signs out every device", new URL(phone.url()).pathname === "/_auth/login"
  && new URL(tablet.url()).pathname === "/_auth/login");

const signedOutAdmin = await fetch(`${BASE}/_admin`, { redirect: "manual" });
check("signed-out /_admin redirects to sign-in", signedOutAdmin.status === 302);

await phone.setViewport({ width: 375, height: 800, isMobile: true });
await phone.goto(`${BASE}/_auth/login`);
await Promise.all([phone.waitForNavigation(), phone.click("#go")]).catch(() => {});
await phone.goto(`${BASE}/_admin`);
await phone.screenshot({ path: `${OUT}/devices-phone.png`, fullPage: true });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
