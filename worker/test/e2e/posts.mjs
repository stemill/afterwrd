// The owner's new posts end to end: composer, photos resized and stripped of hidden details, album, comments,
// surviving a re-import, delete (files and comments go too), and who may do what.
//   node posts.mjs <zip> <fixtures dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath, fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/invite.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// These suites share one database, so each starts with an owner of its own: the last suite's is revoked first
// (a site has only one).
const newOwner = (name) => {
  for (const line of cli("list").split("\n")) { const id = /^\s*(\d+)\s.*owner$/.exec(line)?.[1]; if (id) cli("revoke", id); }
  return cli("add", name, "--owner").match(/http\S+\/_auth\/invite\/\S+/)[0];
};
const sql = (q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", q],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
sql("DELETE FROM site_comments");
sql("DELETE FROM site_photos");
sql("DELETE FROM site_posts"); // the import below rebuilds the archive's copy

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person(link) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  return page;
}
async function importZip(page) {
  await page.goto(`${BASE}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes) => boxes.forEach((b) => { b.checked = ["posts", "photos"].includes(b.value); }));
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}
const cookieOf = async (page) => (await page.cookies()).find((c) => c.name === "__Host-hb_session").value;
const cards = (page) => page.$$eval("main article.card", (l) => l.map((a) => ({
  badge: a.querySelector(".badge")?.textContent, what: a.querySelector(".what")?.textContent.trim(),
  text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
  canDelete: Boolean(a.querySelector("header .delete")),
})));

const owner = await person(newOwner(`Poster ${Date.now()}`));
check("tiny export imports", !(await importZip(owner)));

await owner.goto(`${BASE}/posts`);
check("owner sees the composer on Posts", Boolean(await owner.$("#composer")));
await owner.goto(`${BASE}/posts?page=1&q=test`);
check("composer only on the plain first page", !(await owner.$("#composer")));

// A text-only post.
await owner.goto(`${BASE}/posts`);
await owner.type("#composer textarea", "First post written on the site\nwith two lines");
await Promise.all([owner.waitForNavigation(), owner.click("#composer button.post")]);
let first = (await cards(owner))[0];
check("text post appears first, as yours", first.text === "First post written on the site\nwith two lines" && !first.badge
  && first.what === "You", JSON.stringify(first));
check("owner can delete it", first.canDelete);

// A photo post: one 4000×3000 photo with a hidden location, one small one.
await owner.type("#composer textarea", "Two photos");
await (await owner.$("#composer input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`, `${fixtures}/photo1.jpg`);
check("picked photos preview, removable", (await owner.$$("#composer .picked li")).length === 2 && Boolean(await owner.$("#composer .picked button")));
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#composer button.post")]);
first = (await cards(owner))[0];
check("photo post appears first with both photos", first.text === "Two photos" && first.what === "You" && first.photos === 2, JSON.stringify(first));
const stored = sql("SELECT id, hash, thumb_hash, width, height FROM media WHERE id >= 1000000000 ORDER BY id");
const cookie = await cookieOf(owner);
const get = (hash, c = cookie) => fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-hb_session=${c}` } });
const big = Buffer.from(await (await get(stored[0].hash)).arrayBuffer());
check("the original really had a hidden detail", readFileSync(`${fixtures}/big-secret.jpg`).includes("SECRET-LOCATION"));
check("stored photo is shrunk to 2560 and stripped of hidden details", stored[0].width === 2560 && stored[0].height === 1920
  && big[0] === 0xff && big[1] === 0xd8 && !big.includes("SECRET-LOCATION") && !big.includes("Exif"), `${stored[0].width}×${stored[0].height}, ${big.length} bytes`);
check("photos kept in the order chosen", stored.length === 2 && stored[1].width < 2560);
const thumb = await get(stored[0].thumb_hash);
check("thumbnail stored", thumb.ok && thumb.headers.get("content-type") === "image/jpeg");

await owner.goto(`${BASE}/photos`);
const albums = await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
check("photos appear in a 'Posted on afterwrd' album", albums.includes("Posted on afterwrd"), albums.join(", "));
await owner.goto(`${BASE}/photos/${stored[0].id}`);
check("photo page shows it, with the post", (await owner.$eval(".info .album-link", (a) => a.textContent)) === "Posted on afterwrd"
  && (await owner.$eval(".info article.card .text", (t) => t.textContent)) === "Two photos");

// Comments on the post and on a photo; everything survives a re-import.
await owner.goto(`${BASE}/posts`);
await owner.type("main article.card:first-of-type .say textarea", "Nice ones");
await Promise.all([owner.waitForNavigation(), owner.click("main article.card:first-of-type .say button")]);
await owner.goto(`${BASE}/photos/${stored[0].id}`);
await owner.type(".info .say textarea", "Love this");
await Promise.all([owner.waitForNavigation(), owner.click(".info .say button")]);
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
const after = await cards(owner);
check("both new posts survive a re-import", after[0].text === "Two photos" && after[1].text?.startsWith("First post"), after.slice(0, 2).map((c) => c.text).join(" | "));
check("their photos are still stored", (await get(stored[0].hash)).ok && (await get(stored[1].thumb_hash)).ok);
check("comments on them survive too", sql("SELECT COUNT(*) AS n FROM site_comments")[0].n === 2
  && (await owner.$$eval("main article.card:first-of-type .comment", (l) => l.length)) === 1);

// Who may do what.
const api = (path, body, c, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${c}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("signed out, nobody can post", ![200, 201].includes((await api("/_admin/posts", { text: "sneaky" }, "nobody")).status));
check("…or delete", ![200, 201, 303].includes((await api(`/_admin/posts/${1000000000 + 1}/delete`, {}, "nobody")).status));
check("another site can't post as the owner", (await api("/_admin/posts", { text: "csrf" }, cookie, "https://evil.example")).status === 403);
check("empty post refused", (await api("/_admin/posts", { text: "  " }, cookie)).status === 400);
check("photo that was never uploaded refused", (await api("/_admin/posts", { text: "x", photos: [{ hash: "a".repeat(64),
  thumb_hash: "b".repeat(64), width: 10, height: 10, size: 10 }] }, cookie)).status === 400);
check("made-up photo details refused", (await api("/_admin/posts", { text: "x", photos: [{ hash: stored[0].hash,
  thumb_hash: stored[0].thumb_hash, width: "<b>", height: 10, size: 10 }] }, cookie)).status === 400);
check("only the two real posts exist", sql("SELECT COUNT(*) AS n FROM site_posts")[0].n === 2);

// The owner deletes the photo post: post, photos, files, album and comments all go.
await owner.goto(`${BASE}/posts`);
await Promise.all([owner.waitForNavigation(), owner.click("main article.card:first-of-type header .delete")]);
const left = await cards(owner);
check("photo post deleted", left[0].text?.startsWith("First post"), left[0].text);
const shared = sql(`SELECT COUNT(*) AS n FROM media WHERE thumb_hash = '${stored[1].thumb_hash}'`)[0].n;
check("its own files are gone", [stored[0].hash, stored[0].thumb_hash, stored[1].hash].every(Boolean)
  && (await Promise.all([stored[0].hash, stored[0].thumb_hash, stored[1].hash].map(async (h) => (await get(h)).status))).every((s) => s === 404));
check("a file an imported photo shares is kept", shared === 0 || (await get(stored[1].thumb_hash)).ok, `${shared} imported photo(s) use it`);
check("its comments are gone", sql("SELECT COUNT(*) AS n FROM site_comments")[0].n === 0);
await owner.goto(`${BASE}/photos`);
check("the empty album is gone", !(await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent))).includes("Posted on afterwrd"));
check("imported photos untouched", (await owner.$$eval(".albums a.album", (l) => l.length)) >= 1);

// Phone: composer with photos picked.
await owner.setViewport({ width: 375, height: 800, isMobile: true });
await owner.goto(`${BASE}/posts`);
await owner.type("#composer textarea", "Trying it on a phone");
await (await owner.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
check("no sideways scrolling on a phone", await owner.evaluate(() => document.documentElement.scrollWidth <= 375));
await owner.screenshot({ path: `${OUT}/composer-phone.png` });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
