// A brand-new site, nothing imported: the owner can post straight away. Then imports with only Photos, and only
// Posts, ticked: Posts and Photos stay for afterwrd posts, while imported material follows what was ticked.
// Needs a fresh local database with SETUP_CODE=local-test-setup-code.
//   node fresh.mjs <zip> <fixtures dir>
import { execFileSync } from "node:child_process";
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
const broughtLink = `http://localhost:8788/_connect/${"x".repeat(43)}`; // a friend's link, as the installer hands it on
await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code#${new URLSearchParams({ name: "New Owner", invite: broughtLink })}`);
check("the name given to the installer is ready on the setup page", (await page.$eval("#name", (i) => i.value)) === "New Owner");
await Promise.all([page.waitForNavigation(), page.click("#go")]);
await Promise.all([page.waitForNavigation(), page.click("#go")]);
const landed = new URL(page.url());
check("a friend's link brought from the installer opens straight after the passkey", landed.pathname === "/_admin/connections/new"
  && landed.searchParams.get("link") === broughtLink, page.url());
await page.goto(`${BASE}/`);

const nav = () => page.$$eval("header.site nav.main a", (l) => l.map((a) => a.querySelector("span").textContent).join(","));
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
check("a new site opens on Home", new URL(page.url()).pathname === "/", page.url());
check("menu has Home, Messages, Photos, Friends, Groups, Events and Notifications before any import", (await nav()) === "Home,Messages,Photos,Friends,Groups,Events,Notifications", await nav());
check("composer is there", Boolean(await page.$("#composer")));
check("empty Home says so kindly", (await page.$eval("main .empty", (e) => e.textContent.trim())) === "Nothing here yet. Write your first post above.");
await page.type("#composer textarea", "My very first post");
await (await page.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
check("post appears", (await texts())[0] === "My very first post");
const tile = await page.$eval("main .collage a.tile", (a) => a.getAttribute("href"));
await page.goto(BASE + tile);
check("its photo opens, as one of the post's", (await page.$eval(".info .album-link", (a) => a.textContent)) === "Your post");
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
// Nothing imported points at a row the import didn't bring (albums, with Photos left out): a later album can't pick
// Facebook's photos up.
const rows = (q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", q],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
check("imported photos don't point at albums that weren't imported", rows(`SELECT COUNT(*) AS n FROM media WHERE source = 'facebook'
  AND album_id IS NOT NULL AND album_id NOT IN (SELECT id FROM albums WHERE source = 'facebook')`)[0].n === 0
  && rows("SELECT COUNT(*) AS n FROM media WHERE source = 'facebook'")[0].n > 0);

// With no picture chosen here, Facebook's profile picture and cover (from the download) are used.
const sql = (q) => execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--command", q],
  { cwd: WORKER, stdio: "ignore" });
sql("UPDATE facebook_people SET profile_media_id = (SELECT MIN(id) FROM media WHERE hash IS NOT NULL), cover_media_id = (SELECT MIN(id) FROM media WHERE hash IS NOT NULL) WHERE is_me = 1");
await page.goto(`${BASE}/posts`);
check("Facebook's picture and cover head the profile", Boolean(await page.$("section.profile .avatar img")) && Boolean(await page.$("section.profile .cover img"))
  && !(await page.$(".profile-prompt")));
check("…and the picture is in the header", Boolean(await page.$("header.site .face img")));

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
