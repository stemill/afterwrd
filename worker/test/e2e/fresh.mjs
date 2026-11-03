// A brand-new site, nothing imported: the owner can post straight away. Then imports with only Photos, and only
// Posts, ticked: Posts and Photos stay for afterwrd posts, while imported material follows what was ticked.
// Needs a fresh local database with SETUP_CODE=local-test-setup-code.
//   node fresh.mjs <zip> <fixtures dir>
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath, fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await page.createCDPSession();
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
await page.type("#name", "New Owner");
await Promise.all([page.waitForNavigation(), page.click("#go")]);
await Promise.all([page.waitForNavigation(), page.click("#go")]);

const nav = () => page.$$eval("header.site nav a", (l) => l.map((a) => a.querySelector("span").textContent).join(","));
const texts = () => page.$$eval("main article.card .text", (l) => l.map((t) => t.textContent));
const albums = () => page.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
async function importZip(sections) {
  await page.goto(`${BASE}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes, want) => boxes.forEach((b) => { b.checked = want.includes(b.value); }), sections);
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}

// Nothing imported yet.
await page.goto(BASE);
check("a new site opens on Posts", new URL(page.url()).pathname === "/posts", page.url());
check("menu has Posts and Photos before any import", (await nav()) === "Feed,Friends,Posts,Photos,Activity", await nav());
check("composer is there", Boolean(await page.$("#composer")));
check("empty Posts says so kindly", (await page.$eval("main .empty", (e) => e.textContent)) === "No posts yet.");
await page.type("#composer textarea", "My very first post");
await (await page.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
check("post appears", (await texts())[0] === "My very first post");
const tile = await page.$eval("main .collage a.tile", (a) => a.getAttribute("href"));
await page.goto(BASE + tile);
check("its photo opens", (await page.$eval(".info .album-link", (a) => a.textContent)) === "Posted on afterwrd");
await page.goto(`${BASE}/photos`);
check("Photos shows the afterwrd album", (await albums()).join() === "Posted on afterwrd", (await albums()).join());

// Import with only Photos ticked.
check("import with only Photos", !(await importZip(["photos"])));
await page.goto(`${BASE}/posts`);
check("Posts shows only afterwrd posts (not the photo captions the import brought)", (await texts()).join("|") === "My very first post", (await texts()).join("|"));
await page.goto(`${BASE}/photos`);
check("Photos shows imported albums too", (await albums()).includes("Posted on afterwrd") && (await page.$$(".albums a.album")).length > 1);

// Import with only Posts ticked.
check("import with only Posts", !(await importZip(["posts"])));
await page.goto(`${BASE}/posts`);
check("Posts shows imported and afterwrd posts", (await texts()).includes("My very first post") && (await texts()).length > 1, (await texts()).join("|"));
await page.goto(`${BASE}/photos`);
check("Photos shows only the afterwrd album", (await albums()).join() === "Posted on afterwrd", (await albums()).join());
check("imported photo sets stay hidden", (await page.goto(`${BASE}/photos/album/other`)).status() === 404
  && (await page.goto(`${BASE}/photos/tagged`)).status() === 404);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
