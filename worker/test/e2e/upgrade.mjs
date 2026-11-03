// Before: on an older release, set up, post two photos and a comment, and (where People can still invite) let a guest
// comment too. After: on the new code, with the same database, everything is still there, the new album tools work,
// and the guest can no longer get in (only the owner signs in since 0.15.0), though their comment stays.   node upgrade.mjs before|after <fixtures>
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stage, fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  [${stage}] ${name}${extra ? `  (${extra})` : ""}`); if (!ok) process.exitCode = 1; };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
if (stage === "before") {
  rmSync(`${OUT}/upgrade-guest-cookie.txt`, { force: true });
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
  await page.type("#name", "Upgrader");
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await page.goto(`${BASE}/posts`);
  await page.type("#composer textarea", "Before the upgrade");
  await (await page.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
  await page.type("main article.card:first-of-type .say textarea", "Still here?");
  await Promise.all([page.waitForNavigation(), page.click("main article.card:first-of-type .say button")]);
  writeFileSync(`${OUT}/upgrade-cookie.txt`, (await page.cookies()).find((c) => c.name === "__Host-hb_session").value);
  const invite = await page.evaluate(() => fetch("/_admin/invite", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Old guest" }) }).then((r) => (r.ok ? r.json() : {})));
  if (invite.link) {
    const guest = await (await browser.createBrowserContext()).newPage();
    const gcdp = await guest.createCDPSession();
    await gcdp.send("WebAuthn.enable");
    await gcdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await guest.goto(invite.link);
    await Promise.all([guest.waitForNavigation(), guest.click("#go")]);
    await guest.goto(`${BASE}/posts`);
    await guest.type("main article.card:first-of-type .say textarea", "From a guest");
    await Promise.all([guest.waitForNavigation(), guest.click("main article.card:first-of-type .say button")]);
    writeFileSync(`${OUT}/upgrade-guest-cookie.txt`, (await guest.cookies()).find((c) => c.name === "__Host-hb_session").value);
    check("a guest signed in and commented", true);
  }
  check("posted on the old release", (await page.$$eval("main article.card .collage .tile", (l) => l.length)) === 2);
} else {
  await page.setCookie({ name: "__Host-hb_session", value: readFileSync(`${OUT}/upgrade-cookie.txt`, "utf8"), domain: "localhost", path: "/", secure: true, httpOnly: true });
  await page.goto(`${BASE}/posts`);
  const card = await page.$eval("main article.card", (a) => ({ text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
    comments: [...a.querySelectorAll(".comment .said")].map((c) => c.textContent) }));
  let guestCookie = "";
  try { guestCookie = readFileSync(`${OUT}/upgrade-guest-cookie.txt`, "utf8"); } catch {}
  const expected = guestCookie ? "Still here?,From a guest" : "Still here?";
  check("the post, both photos and the comments survive the upgrade", card.text === "Before the upgrade" && card.photos === 2 && card.comments.join() === expected, JSON.stringify(card));
  if (guestCookie) {
    const asGuest = await fetch(`${BASE}/posts`, { redirect: "manual", headers: { Cookie: `__Host-hb_session=${guestCookie}` } });
    check("the old guest is signed out for good", asGuest.status === 302 && asGuest.headers.get("location").includes("/_auth/login"), `HTTP ${asGuest.status}`);
  }
  const tile = await page.$eval("main .collage a.tile", (a) => a.getAttribute("href"));
  await page.goto(BASE + tile);
  check("photos still open, in Posted on afterwrd", (await page.$eval(".info .album-link", (a) => a.textContent)) === "Posted on afterwrd");
  await page.goto(`${BASE}/_admin/photos/add`);
  await page.type("input[name=name]", "After");
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  check("new albums work on the upgraded site", (await page.$$eval(".justified a.tile", (l) => l.length)) === 1);
}
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
