// Albums, photos and profile pictures on a fresh site (SETUP_CODE=local-test-setup-code):
//   node albums.mjs <fixtures dir>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person(start) {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await start(page);
  return page;
}
const owner = await person(async (page) => {
  await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
  await page.type("#name", "Alex Owner");
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
});
const cookie = async () => (await owner.cookies()).find((c) => c.name === "__Host-hb_session").value;
const fileStatus = async (hash) => (await fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-hb_session=${await cookie()}` } })).status;
const tiles = () => owner.$$eval(".justified a.tile", (l) => l.length);

await owner.goto(`${BASE}/posts`);
check("Posts invites the owner to add a picture and cover", (await owner.$eval("main", (m) => m.textContent)).includes("Add a profile picture"));

// A new album, shared as a post.
await owner.goto(`${BASE}/photos`);
await Promise.all([owner.waitForNavigation(), owner.click('main a[href="/_admin/photos/add"]')]);
check("new album is the default, with name and description", (await owner.$eval("select[name=album]", (s) => s.value)) === "new"
  && !(await owner.$eval(".new-album", (d) => d.hidden)));
await owner.type("input[name=name]", "Summer");
await owner.type(".new-album textarea", "Days out");
await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
await owner.type("#add textarea[name=text]", "Our summer");
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
const albumPath = new URL(owner.url()).pathname;
check("lands on the new album with both photos", /^\/photos\/album\/\d+$/.test(albumPath) && (await tiles()) === 2
  && (await owner.$eval("h1", (h) => h.textContent)) === "Summer" && (await owner.$eval(".album-head", (h) => h.textContent)).includes("Days out"), albumPath);
await owner.goto(`${BASE}/posts`);
const first = await owner.$eval("main article.card", (a) => ({ what: a.querySelector(".what").textContent.trim(), text: a.querySelector(".text")?.textContent,
  photos: a.querySelectorAll(".collage .tile").length }));
check("shared as a post, saying where they went", first.what.endsWith("Added 2 photos to Summer.") && first.text === "Our summer" && first.photos === 2, JSON.stringify(first));
await owner.type("main article.card:first-of-type .say textarea", "Lovely");
await Promise.all([owner.waitForNavigation(), owner.click("main article.card:first-of-type .say button")]);

// More photos into the same album, not shared.
await owner.goto(BASE + albumPath);
await Promise.all([owner.waitForNavigation(), owner.click('.album-tools a[href^="/_admin/photos/add?album="]')]);
check("Add photos from an album picks that album", (await owner.$eval("select[name=album]", (s) => s.options[s.selectedIndex].text)) === "Summer"
  && (await owner.$eval(".new-album", (d) => d.hidden)));
await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`);
await owner.click("#add input[name=share]");
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
check("album now has three", (await tiles()) === 3);
await owner.goto(`${BASE}/posts`);
check("…and no new post", (await owner.$$eval("main article.card", (l) => l.length)) === 1);

// Rename: the post and its comment stay together.
await owner.goto(BASE + albumPath);
await owner.click(".edit-album summary");
await owner.$eval(".edit-album input[name=name]", (i) => { i.value = ""; });
await owner.type(".edit-album input[name=name]", "Summer 2026");
await Promise.all([owner.waitForNavigation(), owner.click(".edit-album button")]);
check("album renamed", (await owner.$eval("h1", (h) => h.textContent)) === "Summer 2026");
await owner.goto(`${BASE}/posts`);
check("its post keeps its comment after the rename", (await owner.$$eval("main article.card:first-of-type .comment .said", (l) => l.map((c) => c.textContent))).join() === "Lovely");

// Profile picture and cover from existing photos.
await owner.goto(BASE + albumPath);
const photoHrefs = await owner.$$eval(".justified a.tile", (l) => l.map((a) => a.getAttribute("href")));
await owner.goto(BASE + photoHrefs[0]);
await Promise.all([owner.waitForNavigation(), owner.click('.photo-tools form:nth-of-type(2) button')]);
await owner.goto(BASE + photoHrefs[1]);
await Promise.all([owner.waitForNavigation(), owner.click('.photo-tools form:nth-of-type(1) button')]);
await owner.goto(`${BASE}/posts`);
const header = await owner.$eval("section.profile", (s) => ({ cover: s.querySelector(".cover img")?.getAttribute("src"), avatar: s.querySelector(".avatar img")?.getAttribute("src"),
  name: s.querySelector(".name").textContent }));
check("Posts shows the chosen picture and cover, and the name", Boolean(header.cover && header.avatar) && header.name === "Alex Owner", JSON.stringify(header));

// The picture sits on top of the cover where they overlap.
const onTop = await owner.evaluate(() => {
  const r = document.querySelector("section.profile .avatar").getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
  return Boolean(hit?.closest(".avatar"));
});
check("the profile picture is drawn over the cover, not under it", onTop);
await owner.screenshot({ path: `${OUT}/profile-desktop.png` });

// A profile picture uploaded for the purpose goes in "Profile pictures".
await owner.goto(`${BASE}/_admin/photos/add?for=profile`);
check("profile upload page asks for one photo, no album choice", !(await owner.$("select[name=album]")) && !(await owner.$eval("#add input[type=file]", (i) => i.multiple)));
await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
check("back on Posts with the new picture", new URL(owner.url()).pathname === "/posts"
  && (await owner.$eval("section.profile .avatar img", (i) => i.getAttribute("src"))) !== header.avatar);
await owner.goto(`${BASE}/photos`);
check("kept in a Profile pictures album", (await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent))).includes("Profile pictures"));

// Nobody signed out can use the tools.
check("photo tools need the owner", ![200, 201].includes((await fetch(`${BASE}/_admin/photos`, { method: "POST", redirect: "manual",
  headers: { Origin: BASE, "Content-Type": "application/json" }, body: "{}" })).status));

// Delete one photo (album-only), then the album.
await owner.goto(BASE + photoHrefs[2]);
const third = await owner.$eval(".stage img", (i) => i.getAttribute("src").split("/files/")[1]);
await Promise.all([owner.waitForNavigation(), owner.click(".photo-tools button.danger")]);
const stillUsed = JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command",
  `SELECT COUNT(*) AS n FROM media WHERE hash = '${third}'`], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results[0].n;
check("deleting a photo removes it, and its file unless another photo uses it", (await tiles()) === 2
  && (await fileStatus(third)) === (stillUsed ? 200 : 404), `${stillUsed} other use(s)`);
await owner.goto(BASE + albumPath);
await Promise.all([owner.waitForNavigation(), owner.click(".album-tools button.danger")]);
await owner.goto(`${BASE}/photos`);
const albumsLeft = await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
check("deleting the album keeps photos that are in a post, under Posted on afterwrd", !albumsLeft.includes("Summer 2026")
  && albumsLeft.includes("Posted on afterwrd"), albumsLeft.join());
await owner.goto(`${BASE}/posts`);
check("the post still has its photos", (await owner.$$eval("main article.card", (l) => l.at(-1).querySelectorAll(".collage .tile").length)) === 2);

// Phone.
await owner.setViewport({ width: 375, height: 800, isMobile: true });
await owner.goto(`${BASE}/posts`);
check("no sideways scrolling on a phone", await owner.evaluate(() => document.documentElement.scrollWidth <= 375));
await owner.screenshot({ path: `${OUT}/profile-phone.png` });
await owner.setViewport({ width: 1100, height: 900 });
await owner.goto(`${BASE}/_admin/photos/add`);
await owner.screenshot({ path: `${OUT}/add-photos.png` });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
