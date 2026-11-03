// End-to-end for Your devices: only the owner signs in. The owner adds a second device from the page, removes a
// passkey (never the last), cancels unused links and signs out everywhere; there's no inviting anyone else.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/invite.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// These suites share one database, so each starts with an owner of its own: the last suite's is revoked first
// (a site has only one).
const newOwner = (name) => {
  for (const line of cli("list").split("\n")) { const id = /^\s*(\d+)\s.*owner$/.exec(line)?.[1]; if (id) cli("revoke", id); }
  return cli("add", name, "--owner").match(/http\S+\/_auth\/invite\/\S+/)[0];
};
const sql = (command) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", command],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
// The main menu, then what's behind the person's picture.
const navLabels = (page) => page.$$eval("header.site nav.main a, header.site .menu a", (a) => a.map((x) => x.querySelector("span").textContent.trim()).join(","));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

async function device() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("dialog", (d) => d.accept());
  return page;
}
async function register(page, link) {
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
}
const passkeys = (page) => page.$$eval(".devices li", (l) => l.map((li) => ({
  id: li.querySelector("button").dataset.credential, disabled: li.querySelector("button").disabled })));

// Only owners can be added from the terminal.
let refused = "";
try { cli("add", `Someone ${Date.now()}`); } catch (e) { refused = String(e.stderr); }
check("the terminal won't add anyone but the owner", refused.includes("add --owner"), refused.trim());

// The owner joins via the terminal, as on a brand-new site.
const ownerName = `Owner ${Date.now()}`;
const phone = await device();
await register(phone, newOwner(ownerName));
let second = "";
try { cli("add", `Second ${Date.now()}`, "--owner"); } catch (e) { second = String(e.stderr); }
check("the terminal won't make a second owner", second.includes("already has an owner"), second.trim());
check("the menu has Your devices", (await navLabels(phone)) === "Home,Photos,Friends,Notifications,Your profile,Your devices,Import,Download everything,Update", await navLabels(phone));
await phone.goto(`${BASE}/_admin`);
check("Your devices lists one passkey, which can't be removed", (await phone.$eval("h1", (h) => h.textContent)) === "Your devices"
  && JSON.stringify((await passkeys(phone)).map((k) => k.disabled)) === "[true]");
check("no inviting other people", !(await phone.$("#invite")) && !(await phone.$("button[data-action=revoke]")));

// Add a laptop from the page.
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
const link = await phone.$eval("#link-url", (i) => i.value);
check("Add a device shows a one-time link", /\/_auth\/invite\/[\w-]{40,}$/.test(link), link.slice(0, 60) + "…");
const laptop = await device();
await laptop.goto(link);
check("the link says it's adding a device", (await laptop.title()).startsWith("Add this device") && (await laptop.$eval("main, body", (m) => m.textContent)).includes("Add this phone or computer"));
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
check("the laptop is signed in as the owner", (await navLabels(laptop)).includes("Your devices"), await navLabels(laptop));
const reuse = await (await device()).goto(link);
check("the link only works once", reuse.status() === 404);

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
const cookie = (await phone.cookies()).find((c) => c.name === "__Host-hb_session").value;
const api = (path, body, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${cookie}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
check("another site can't make a device link", (await api("/_admin/devices/link", {}, "https://evil.example")).status === 403);
check("the old People actions are gone", (await api("/_admin/invite", { name: "Sneaky" })).status === 404
  && (await api("/_admin/people/1/revoke")).status === 404);
const [otherKey] = sql(`SELECT c.id FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.name != '${ownerName}' LIMIT 1`);
if (otherKey) check("can't remove another account's passkey", (await api("/_admin/devices/delete-passkey", { credential: otherKey.id })).status === 404);

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

// Someone invited by an older version, before only owners signed in, can't use their link.
const token = randomBytes(32).toString("base64url");
const [guest] = sql(`INSERT INTO users (name, is_owner, created_at) VALUES ('Old guest', 0, strftime('%s','now')) RETURNING id`);
sql(`INSERT INTO invites (token_hash, user_id, expires_at) VALUES ('${createHash("sha256").update(token).digest("hex")}', ${guest.id}, strftime('%s','now') + 3600)`);
check("an old guest's invite doesn't work", (await (await device()).goto(`${BASE}/_auth/invite/${token}`)).status() === 404);
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
