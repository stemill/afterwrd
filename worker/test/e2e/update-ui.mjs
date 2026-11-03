// The Update page's three states, against a fresh local site with SETUP_CODE=local-test-setup-code:
//   node update-ui.mjs behind     (package.json version older than the latest release; no remembered token)
//   node update-ui.mjs remembered (older, and UPDATE_TOKEN set)
//   node update-ui.mjs current    (up to date, no remembered token)
// Local sites aren't on workers.dev, so the actual update stops at "Updating works from the site's workers.dev address".
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const mode = process.argv[2];
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  [${mode}] ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const cdp = await page.createCDPSession();
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
await page.type("#name", "Owner");
await Promise.all([page.waitForNavigation(), page.click("#go")]);
await Promise.all([page.waitForNavigation(), page.click("#go")]);

// The mark on the Update button (the first page load fetches the latest version in the background).
await page.goto(`${BASE}/posts`);
await new Promise((r) => setTimeout(r, 2500));
await page.goto(`${BASE}/posts`);
const update = await page.$eval('header.site a[href="/_admin/update"]', (a) => ({ label: a.querySelector("span").textContent, dot: Boolean(a.querySelector(".dot")) }));
const behind = mode !== "current";
check(behind ? "Update button marked when a release is waiting" : "no mark when up to date",
  update.dot === behind && update.label === (behind ? "Update available" : "Update"), JSON.stringify(update));

await page.goto(`${BASE}/_admin/update`);
const text = await page.$eval("main", (m) => m.innerText);
if (mode === "behind") {
  check("offers the update, with a token box and Remember", /is available/.test(text) && Boolean(await page.$("#token")) && Boolean(await page.$("#remember")));
  check("no Forget (nothing remembered)", !(await page.$("#forget")));
  await page.type("#token", "x".repeat(40));
  await page.click("#remember");
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 15_000 });
  check("clicking Update runs (and stops off workers.dev)", /workers\.dev/.test(await page.$eval("#error", (e) => e.textContent)));
} else if (mode === "remembered") {
  check("one click: no token box showing, Forget offered", /remembered/.test(text) && Boolean(await page.$("#forget"))
    && !(await page.$eval("#token", (t) => t.checkVisibility())));
  check("another token can still be used", Boolean(await page.$("details.other #token")));
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 15_000 });
  const error = await page.$eval("#error", (e) => e.textContent);
  check("one-click update runs with the remembered token (stops off workers.dev)", /workers\.dev/.test(error), error);
} else {
  check("says it's up to date and offers to remember a token", /latest version/.test(text) && Boolean(await page.$("#save")));
  await page.click("#save summary");
  await page.type("#token", "x".repeat(40));
  await page.click("#keep");
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 15_000 });
  check("Remember runs (and stops off workers.dev)", /workers\.dev/.test(await page.$eval("#error", (e) => e.textContent)));
  const downgrade = await page.evaluate(() => fetch("/_admin/update/check", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag: "v0.1.0", token: "x" }) }).then((r) => r.json()));
  check("won't update to an older version", /isn't newer/.test(downgrade.error ?? ""), downgrade.error);
  const settings = await page.evaluate(() => fetch("/_admin/export/rows?table=settings").then((r) => r.json()));
  check("Download everything only takes the published sections from settings", settings.rows.every((r) => r.key === "sections"),
    settings.rows.map((r) => r.key).join());
}
await page.screenshot({ path: `${OUT}/update-${mode}.png`, fullPage: true });
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
