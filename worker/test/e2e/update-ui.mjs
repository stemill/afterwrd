// The Update page's three states, against a fresh local site with SETUP_CODE=local-test-setup-code:
//   node update-ui.mjs behind     (package.json version older than the latest release; the site started with
//                                  ALLOW_LOCAL_SITES=1 and OAUTH_TOKEN_URL=http://127.0.0.1:8799/token, a stand-in for
//                                  Cloudflare's token endpoint that this test runs)
//   node update-ui.mjs remembered (older, and UPDATE_TOKEN set: a token a version before 0.20.0 kept)
//   node update-ui.mjs current    (up to date)
// Local sites aren't on workers.dev, so the actual update stops at "Updating works from the site's workers.dev address".
// Connecting Cloudflare is run end to end with the relay page (afterwrd.app/connect/) stood in for: the test answers
// for it, reads the state from the address the site sent the browser to, and comes back the way the real page would.
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const mode = process.argv[2];
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  [${mode}] ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

// A stand-in for Cloudflare's token endpoint: records what the site sends, answers with an hour's token.
const exchanges = [];
const tokenServer = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  exchanges.push({ url: req.url, params: Object.fromEntries(new URLSearchParams(body)) });
  res.setHeader("Content-Type", "application/json");
  if (exchanges.at(-1).params.code === "bad-code") { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
  res.end(JSON.stringify({ access_token: "stand-in-access-token", token_type: "bearer", expires_in: 3600 }));
});
await new Promise((r) => tokenServer.listen(8799, "127.0.0.1", r));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
// afterwrd asks in its own box (ui.js): say yes, as a person would.
await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
  .observe(document, { childList: true, subtree: true }));
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

// The relay page, stood in for: any request to afterwrd.app gets a plain page, and the address it was sent to is kept.
let relayUrl = null;
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (new URL(req.url()).hostname === "afterwrd.app") { relayUrl = new URL(req.url()); req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" }); }
  else req.continue();
});
const post = (path, body) => page.evaluate((path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body) }).then((r) => r.json()), path, body);

await page.goto(`${BASE}/_admin/update`);
const text = await page.$eval("main", (m) => m.innerText);
if (mode === "behind") {
  check("offers the update with Connect Cloudflare, and no Remember", /is available/.test(text) && Boolean(await page.$("#connect")) && !(await page.$("#remember")));
  check("the token box is the folded-away fallback", Boolean(await page.$("details.other #token")));
  check("no Forget (nothing remembered)", !(await page.$("#forget")));
  check("Update without connecting says so", await page.evaluate(() => { document.getElementById("go").click(); return document.getElementById("error").textContent; }) === "Connect Cloudflare first.");

  // Connect: off to the relay with the state and challenge, and a cookie holding the PKCE secret.
  await Promise.all([page.waitForNavigation(), page.click("#connect")]);
  check("Connect sends the browser to afterwrd.app/connect/ with where to come back to", relayUrl?.origin === "https://afterwrd.app" && relayUrl.pathname === "/connect/"
    && relayUrl.searchParams.get("to") === `${BASE}/_cloudflare/done`, String(relayUrl));
  const state = relayUrl.searchParams.get("state") ?? "";
  const challenge = relayUrl.searchParams.get("challenge") ?? "";
  check("with a state and a PKCE challenge", /^[\w-]{24,}$/.test(state) && /^[\w-]{43}$/.test(challenge));
  check("a back path on another site is refused", (await page.goto(`${BASE}/_cloudflare/start?back=//evil.example/`)).status() === 400);
  const session = (await page.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  const crossSite = await fetch(`${BASE}/_cloudflare/start?back=/_admin/update?go=update`, { redirect: "manual",
    headers: { Cookie: session, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
  check("a link on another site can't start a connection", crossSite.status === 403, String(crossSite.status));
  await page.goto(`${BASE}/_cloudflare/done#error=access_denied`);
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
  check("not allowing it is explained, and nothing is exchanged", /didn't allow it/.test(await page.$eval("#error", (e) => e.textContent)) && exchanges.length === 0);

  // Back from Cloudflare the way the relay would send us, with the wrong state first. (A fresh page load: a change
  // of fragment alone wouldn't be one.)
  await page.goto(`${BASE}/_admin/update`);
  await page.goto(`${BASE}/_cloudflare/done#code=the-code&state=not-the-state`);
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
  check("a code with the wrong state is refused, and nothing is exchanged", /isn't the connection/.test(await page.$eval("#error", (e) => e.textContent)) && exchanges.length === 0);
  // Refusing clears the started connection, so a fresh one is needed.
  await page.goto(`${BASE}/_admin/update`);
  await Promise.all([page.waitForNavigation(), page.click("#connect")]);
  const state2 = relayUrl.searchParams.get("state");
  const challenge2 = relayUrl.searchParams.get("challenge");
  await page.goto(`${BASE}/_cloudflare/done#code=the-code&state=${state2}`);
  await page.waitForFunction(() => location.pathname === "/_admin/update", { timeout: 15_000 });
  const sent = exchanges.at(-1);
  check("the code goes to the token endpoint with the PKCE secret, the client id and the relay as redirect", exchanges.length === 1 && sent.params.grant_type === "authorization_code"
    && sent.params.code === "the-code" && sent.params.redirect_uri === "https://afterwrd.app/connect/" && /^[0-9a-f]{32}$/.test(sent.params.client_id)
    && /^[\w-]{43,128}$/.test(sent.params.code_verifier), JSON.stringify(sent));
  const verifierHash = await page.evaluate(async (v) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }, sent.params.code_verifier);
  check("the secret matches the challenge sent out", verifierHash === challenge2);
  const cookies = await page.cookies(BASE);
  const tokenCookie = cookies.find((c) => c.name === "cf_token");
  check("the hour's token is kept in an HttpOnly cookie, and the start cookie is gone", tokenCookie?.httpOnly === true && tokenCookie.value === "stand-in-access-token"
    && tokenCookie.expires - Date.now() / 1000 < 3600 && !cookies.some((c) => c.name === "cf_connect"), JSON.stringify(cookies.map((c) => c.name)));
  await page.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 30_000 }).catch(async () => {
    console.log("DIAG url", page.url(), "\nDIAG text", await page.$eval("body", (b) => b.innerText.slice(0, 1500)), "\nDIAG cookies", JSON.stringify((await page.cookies(BASE)).map((c) => c.name)));
    await page.screenshot({ path: `${OUT}/update-diag.png`, fullPage: true });
  });
  check("back on the Update page, connected, and the update runs by itself (stops off workers.dev)",
    /Connected to Cloudflare/.test(await page.$eval("main", (m) => m.innerText)) && /workers\.dev/.test(await page.$eval("#error", (e) => e.textContent)));
  check("the token endpoint being refused is reported", /didn't finish connecting/.test((await (async () => {
    await page.goto(`${BASE}/_admin/update`);
    await post("/_cloudflare/disconnect", {});
    await page.goto(`${BASE}/_admin/update`);
    await Promise.all([page.waitForNavigation(), page.click("#connect")]);
    await page.goto(`${BASE}/_cloudflare/done#code=bad-code&state=${relayUrl.searchParams.get("state")}`);
    await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
    return page.$eval("#error", (e) => e.textContent);
  })())));
  check("Disconnect dropped the token", !(await page.cookies(BASE)).some((c) => c.name === "cf_token"));

  // The fallback: a pasted token.
  await page.goto(`${BASE}/_admin/update`);
  await page.click("details.other summary");
  await page.type("#token", "x".repeat(40));
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 15_000 });
  check("a pasted token runs the update (and stops off workers.dev)", /workers\.dev/.test(await page.$eval("#error", (e) => e.textContent)));
} else if (mode === "remembered") {
  check("an old remembered token is pointed out, with Forget", /earlier version kept/.test(text) && Boolean(await page.$("#forget")));
  check("updating still goes through Connect", Boolean(await page.$("#connect")));
  check("Update without connecting says so, old token or not", await page.evaluate(() => { document.getElementById("go").click(); return document.getElementById("error").textContent; }) === "Connect Cloudflare first.");
  const forgot = await post("/_admin/update/forget", {});
  check("Forget runs (and stops off workers.dev)", /workers\.dev/.test(forgot.error ?? ""), forgot.error);
} else {
  check("says it's up to date, with nothing to remember", /latest version/.test(text) && !(await page.$("#save")) && !(await page.$("#forget")));
  const downgrade = await post("/_admin/update/check", { tag: "v0.1.0", token: "x" });
  check("won't update to an older version", /isn't newer/.test(downgrade.error ?? ""), downgrade.error);
  const unstarted = await post("/_cloudflare/finish", { code: "the-code", state: "x" });
  check("a code arriving without a connection started here is refused", /expired\. Start again/.test(unstarted.error ?? ""), unstarted.error);
  const settings = await page.evaluate(() => fetch("/_admin/export/rows?table=settings").then((r) => r.json()));
  check("Download everything only takes the published sections from settings", settings.rows.every((r) => r.key === "sections"),
    settings.rows.map((r) => r.key).join());
}
await page.screenshot({ path: `${OUT}/update-${mode}.png`, fullPage: true });
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
tokenServer.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
