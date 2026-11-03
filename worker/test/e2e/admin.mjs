// End-to-end for the People page: owner invites a guest from the page, guest can't manage, owner revokes.
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/invite.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
// The main menu, then what's behind the person's picture.
const navLabels = (page) => page.$$eval("header.site nav.main a, header.site .menu a", (a) => a.map((x) => x.querySelector("span").textContent.trim()).join(","));

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
async function register(page, link) {
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
}

// Owner joins via the CLI, as on a brand-new site.
const ownerName = `Owner ${Date.now()}`;
const ownerLink = cli("add", ownerName, "--owner").match(/http\S+\/_auth\/invite\/\S+/)[0];
const owner = await person();
await register(owner, ownerLink);
check("owner sees People in their menu", (await navLabels(owner)) === "Home,Photos,Friends,Notifications,Your profile,People,Import,Download everything,Update", await navLabels(owner));

await owner.goto(`${BASE}/_admin`);
const ownerRow = await owner.$$eval("tbody tr", (rows, n) => rows.find((r) => r.textContent.includes(n))?.innerHTML ?? "", ownerName);
check("owner listed, marked owner, signed in today, no Revoke button", ownerRow.includes("owner") && ownerRow.includes("Signed in") && !ownerRow.includes("Revoke"));

// Invite a guest from the page; the name tries to inject HTML.
const guestName = `Guest <img src=x onerror=alert(1)> ${Date.now()}`;
await owner.type("#invite input[name=name]", guestName);
await owner.click("#invite button");
await owner.waitForSelector("#link:not([hidden])");
const guestLink = await owner.$eval("#link-url", (i) => i.value);
check("invite form shows a one-time link", /\/_auth\/invite\/[\w-]{40,}$/.test(guestLink), guestLink.slice(0, 60) + "…");

const guest = await person();
await register(guest, guestLink);
check("guest registers from the page's link", ["/", "/posts"].includes(new URL(guest.url()).pathname), guest.url());
check("guest has no People link", (await navLabels(guest)) === "Home,Photos,Notifications", await navLabels(guest));
const guestAdmin = await guest.goto(`${BASE}/_admin`);
check("guest gets 404 on /_admin", guestAdmin.status() === 404);
await guest.goto(`${BASE}/posts`);
const guestPost = await guest.evaluate(() => fetch("/_admin/invite", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Sneaky" }) }).then((r) => r.status));
check("guest can't create invites through the API", guestPost === 404);

// Back to the owner: list shows the guest safely; new link; cross-site and self-revoke refused; revoke guest.
await owner.goto(`${BASE}/_admin`);
check("guest's name is shown as text, not HTML", (await owner.$$("tbody img")).length === 0
  && (await owner.$eval("tbody", (t) => t.textContent)).includes("<img src=x"));
const guestRowId = await owner.$$eval("button[data-action=revoke]", (b, n) => b.find((x) => x.dataset.name === n)?.dataset.id, guestName);
await owner.click(`button[data-action=invite][data-id="${guestRowId}"]`);
await owner.waitForSelector("#link:not([hidden])");
const newLink = await owner.$eval("#link-url", (i) => i.value);
check("New link gives a different link", newLink !== guestLink && newLink.includes("/_auth/invite/"));

const cookie = (await owner.cookies()).find((c) => c.name === "__Host-hb_session").value;
const evil = await fetch(`${BASE}/_admin/people/${guestRowId}/revoke`, { method: "POST",
  headers: { Origin: "https://evil.example", Cookie: `__Host-hb_session=${cookie}`, "Content-Type": "application/json" } });
check("cross-site POST to the admin API is refused", evil.status === 403, `HTTP ${evil.status}`);
const ownerId = cli("list").split("\n").find((l) => l.includes(ownerName)).trim().split(/\s+/)[0];
const selfRevoke = await owner.evaluate((id) => fetch(`/_admin/people/${id}/revoke`, { method: "POST" }).then((r) => r.status), ownerId);
check("owner can't revoke themselves", selfRevoke === 400);

await guest.goto(`${BASE}/posts`);
check("guest still signed in before the owner revokes", new URL(guest.url()).pathname === "/posts");
await owner.goto(`${BASE}/_admin`);
await Promise.all([owner.waitForNavigation(), owner.click(`button[data-action=revoke][data-id="${guestRowId}"]`)]);
await guest.goto(`${BASE}/posts`);
check("revoked guest is signed out straight away", new URL(guest.url()).pathname === "/_auth/login");
await owner.goto(`${BASE}/_admin`);
check("guest appears under Revoked", (await owner.$eval("main", (m) => m.innerHTML)).includes("<h2>Revoked</h2>")
  && (await owner.$$eval("h2 + table tbody tr", (r) => r.map((x) => x.textContent).join("|"))).includes("Guest"));
const signedOutAdmin = await fetch(`${BASE}/_admin`, { redirect: "manual" });
check("signed-out /_admin redirects to sign-in", signedOutAdmin.status === 302);

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
