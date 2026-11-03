// Before: on 0.10.0, set up, post two photos and a comment. After: on the new code, with the same database,
// everything is still there and the new album tools work.   node upgrade.mjs before|after <fixtures>
import { readFileSync, writeFileSync } from "node:fs";
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
  check("posted on 0.10.0", (await page.$$eval("main article.card .collage .tile", (l) => l.length)) === 2);
} else {
  await page.setCookie({ name: "__Host-hb_session", value: readFileSync(`${OUT}/upgrade-cookie.txt`, "utf8"), domain: "localhost", path: "/", secure: true, httpOnly: true });
  await page.goto(`${BASE}/posts`);
  const card = await page.$eval("main article.card", (a) => ({ text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
    comments: [...a.querySelectorAll(".comment .said")].map((c) => c.textContent) }));
  check("the post, both photos and the comment survive the upgrade", card.text === "Before the upgrade" && card.photos === 2 && card.comments.join() === "Still here?", JSON.stringify(card));
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
