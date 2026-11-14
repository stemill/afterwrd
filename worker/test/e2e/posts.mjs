// The owner's new posts end to end: composer, photos resized and stripped of hidden details, album, comments,
// surviving a re-import, delete (files and comments go too), and who may do what.
//   node posts.mjs <zip> <fixtures dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled, sql } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath, fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/owner.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// Each suite starts on a new site (run.sh), and makes its owner from the terminal: the link to add their first device.
const newOwner = (name) => cli(name).match(/http\S+\/_auth\/device\/\S+/)[0];
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person(link) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
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
const cookieOf = async (page) => (await page.cookies()).find((c) => c.name === "__Host-session").value;
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

// Changing its words (edits.js): for 15 minutes, keeping what it said before.
const firstCard = "main article.card:first-of-type";
const shown = (selector) => owner.$eval(selector, (e) => e.checkVisibility()).catch(() => false);
const editPost = async (words) => {
  // Where a person could tap it: not tucked under the sticky header, where a test's click would land on the header.
  await owner.$eval(firstCard, (c) => c.scrollIntoView({ block: "center" }));
  await owner.click(`${firstCard} > header details.more summary`);
  await owner.click(`${firstCard} > header details.more a[href^="#edit"]`);
  await owner.$eval(`${firstCard} > div.edit textarea`, (t, w) => { t.value = w; }, words);
  await Promise.all([settled(owner), owner.click(`${firstCard} > div.edit button`)]);
};
check("a new post offers Edit", Boolean(await owner.$(`${firstCard} > div.edit`)));
// Edit and Delete wait behind the small V; Edit opens the words, ready to type, and Cancel puts them away.
check("…behind the small V, with Delete", !(await shown(`${firstCard} > div.edit`)) && !(await shown(`${firstCard} > header .delete`))
  && Boolean(await owner.$(`${firstCard} > header details.more .delete`)));
await owner.click(`${firstCard} > header details.more summary`);
check("the V opens a menu: Edit, Delete", (await owner.$eval(`${firstCard} > header details.more .menu`, (m) => m.innerText.replace(/\s+/g, " ").trim())) === "Edit Delete");
await owner.click(`${firstCard} > header details.more a[href^="#edit"]`);
check("Edit shows the words, ready to change, and closes the menu", await owner.waitForFunction((card) => {
  const box = document.querySelector(`${card} > div.edit`);
  return box.checkVisibility() && document.activeElement === box.querySelector("textarea") && !document.querySelector(`${card} > header details.more`).open;
}, { timeout: 3000 }, firstCard).then(() => true, () => false));
await owner.click(`${firstCard} > div.edit a.chip`);
check("Cancel puts them away", !(await shown(`${firstCard} > div.edit`)));
await owner.click(`${firstCard} > header details.more summary`);
await owner.click("main h1");
check("a tap elsewhere closes the menu", await owner.waitForFunction((card) => !document.querySelector(`${card} > header details.more`).open,
  { timeout: 3000 }, firstCard).then(() => true, () => false));
const postId = await owner.$eval(firstCard, (c) => c.id);
await editPost("First post written on the site\nwith two lines, now changed");
check("the new words show", (await cards(owner))[0].text === "First post written on the site\nwith two lines, now changed");
check("…marked Edited", (await owner.$eval(`${firstCard} > details.edited summary`, (s) => s.textContent).catch(() => "")) === "Edited");
check("…with what it said before", (await owner.$eval(`${firstCard} .versions`, (l) => l.textContent)).includes("First post written on the site\nwith two lines"));
check("…and it keeps its address, with no new page", (await owner.$eval(firstCard, (c) => c.id)) === postId && !new URL(owner.url()).hash);
await editPost("   ");
check("a post with no photos can't lose all its words", (await owner.$eval("body", (m) => m.textContent)).includes("needs words"));
// At most 10 changes to any one post: a limit on what anyone can make the site keep.
await owner.evaluate(() => fetch("/_admin/posts", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Change number 1" }) }));
const [capped] = sql("SELECT id FROM posts WHERE text = 'Change number 1'");
const tries = [];
for (let i = 2; i <= 11; i++) {
  tries.push(await owner.evaluate((id, w) => fetch(`/_admin/posts/${id}/edit`, { method: "POST", redirect: "manual",
    body: new URLSearchParams({ text: w, back: "/posts" }) }).then((r) => (r.type === "opaqueredirect" ? 303 : r.status)), capped.id, `Change number ${i}`));
}
check("a post can be changed 10 times, and no more", tries.slice(0, 9).every((st) => st === 303) && tries[9] === 403
  && sql(`SELECT COUNT(*) AS n FROM post_versions WHERE post_id = ${capped.id}`)[0].n === 10, tries.join(","));
await owner.evaluate((id) => fetch(`/_admin/posts/${id}/delete`, { method: "POST" }), capped.id);
check("…and deleting it deletes its versions", sql(`SELECT COUNT(*) AS n FROM post_versions WHERE post_id = ${capped.id}`)[0].n === 0);
await owner.goto(`${BASE}/posts`);

// Fifteen minutes on, it can't be changed.
const [textPost] = sql("SELECT id, key FROM posts WHERE source = 'afterwrd' ORDER BY id DESC LIMIT 1");
sql(`UPDATE posts SET created_at = created_at - 901 WHERE id = ${textPost.id}`);
await owner.goto(`${BASE}/posts`);
check("after 15 minutes there's no Edit", !(await owner.$(`${firstCard} > div.edit`)) && Boolean(await owner.$(`${firstCard} > details.edited`)));
const late = await owner.evaluate((id) => fetch(`/_admin/posts/${id}/edit`, { method: "POST", redirect: "manual",
  body: new URLSearchParams({ text: "too late", back: "/posts" }) }).then((r) => r.status), textPost.id);
check("…and the site refuses it", late === 403 && sql(`SELECT text FROM posts WHERE id = ${textPost.id}`)[0].text.endsWith("now changed"));
sql(`UPDATE posts SET created_at = created_at + 901 WHERE id = ${textPost.id}`);
await owner.goto(`${BASE}/posts`);

// A photo post: one 4000×3000 photo with a hidden location, one small one.
await owner.type("#composer textarea", "Two photos");
await (await owner.$("#composer input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`, `${fixtures}/photo1.jpg`);
check("picked photos preview, removable", (await owner.$$("#composer .picked li")).length === 2 && Boolean(await owner.$("#composer .picked button")));
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#composer button.post")]);
first = (await cards(owner))[0];
check("photo post appears first with both photos", first.text === "Two photos" && first.what === "You" && first.photos === 2, JSON.stringify(first));
const stored = sql("SELECT id, hash, thumb_hash, width, height FROM media WHERE source = 'afterwrd' ORDER BY id");
const cookie = await cookieOf(owner);
const get = (hash, c = cookie) => fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-session=${c}` } });
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
// Opened from the post, a photo is among the post's photos (not in the middle of "Posted on afterwrd"), and ✕ goes
// back to the post where it was.
await owner.goto(`${BASE}/posts`);
await Promise.all([owner.waitForNavigation(), owner.click("main article.card:first-of-type .collage a.tile:nth-of-type(2)")]);
const inPost = await owner.evaluate(() => ({ counter: document.querySelector(".counter").textContent, album: document.querySelector(".info .album-link").textContent,
  close: document.getElementById("close").getAttribute("href"), prev: document.getElementById("prev")?.getAttribute("href"), next: Boolean(document.getElementById("next")) }));
check("a photo opened from its post is among that post's photos", inPost.counter === "2 / 2" && inPost.album === "Your post" && !inPost.next
  && /^\/photos\/\d+\?in=post&back=/.test(inPost.prev), JSON.stringify(inPost));
check("…and ✕ goes back to the post where it was", /^\/posts#p-post-\d+-[0-9a-f]{8}$/.test(inPost.close), inPost.close);
await owner.goto(`${BASE}/photos/${stored[1].id}?in=post&back=${encodeURIComponent("//evil.example/")}`);
check("…but never to another site", (await owner.$eval("#close", (a) => a.getAttribute("href"))) === "/");

// Comments on the post and on a photo; everything survives a re-import.
await owner.goto(`${BASE}/posts`);
await owner.type("main article.card:first-of-type .say textarea", "Nice ones");
await Promise.all([settled(owner), owner.click("main article.card:first-of-type .say button")]);
await owner.goto(`${BASE}/photos/${stored[0].id}`);
await owner.type(".info .say textarea", "Love this");
await Promise.all([settled(owner), owner.click(".info .say button")]);
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
const after = await cards(owner);
check("both new posts survive a re-import", after[0].text === "Two photos" && after[1].text?.startsWith("First post"), after.slice(0, 2).map((c) => c.text).join(" | "));
check("their photos are still stored", (await get(stored[0].hash)).ok && (await get(stored[1].thumb_hash)).ok);
check("comments on them survive too", sql("SELECT COUNT(*) AS n FROM comments")[0].n === 2
  && (await owner.$$eval("main article.card:first-of-type .comment", (l) => l.length)) === 1);

// Who may do what.
const api = (path, body, c, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${c}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("signed out, nobody can post", ![200, 201].includes((await api("/_admin/posts", { text: "sneaky" }, "nobody")).status));
const [ownPost] = sql("SELECT id FROM posts WHERE source = 'afterwrd' LIMIT 1");
check("…or delete", ![200, 201, 303].includes((await api(`/_admin/posts/${ownPost.id}/delete`, {}, "nobody")).status));
check("another site can't post as the owner", (await api("/_admin/posts", { text: "csrf" }, cookie, "https://evil.example")).status === 403);
check("empty post refused", (await api("/_admin/posts", { text: "  " }, cookie)).status === 400);
check("photo that was never uploaded refused", (await api("/_admin/posts", { text: "x", photos: [{ hash: "a".repeat(64),
  thumb_hash: "b".repeat(64), width: 10, height: 10, size: 10 }] }, cookie)).status === 400);
check("made-up photo details refused", (await api("/_admin/posts", { text: "x", photos: [{ hash: stored[0].hash,
  thumb_hash: stored[0].thumb_hash, width: "<b>", height: 10, size: 10 }] }, cookie)).status === 400);
check("only the two real posts exist", sql("SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'")[0].n === 2);

// The owner deletes the photo post: post, photos, files, album and comments all go.
await owner.goto(`${BASE}/posts`);
await owner.click("main article.card:first-of-type header details.more summary");
await Promise.all([settled(owner), owner.click("main article.card:first-of-type header .delete")]);
const left = await cards(owner);
check("photo post deleted", left[0].text?.startsWith("First post"), left[0].text);
const shared = sql(`SELECT COUNT(*) AS n FROM media WHERE thumb_hash = '${stored[1].thumb_hash}'`)[0].n;
check("its own files are gone", [stored[0].hash, stored[0].thumb_hash, stored[1].hash].every(Boolean)
  && (await Promise.all([stored[0].hash, stored[0].thumb_hash, stored[1].hash].map(async (h) => (await get(h)).status))).every((s) => s === 404));
check("a file an imported photo shares is kept", shared === 0 || (await get(stored[1].thumb_hash)).ok, `${shared} imported photo(s) use it`);
check("its comments are gone", sql("SELECT COUNT(*) AS n FROM comments")[0].n === 0);
await owner.goto(`${BASE}/photos`);
check("the empty album is gone", !(await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent))).includes("Posted on afterwrd"));
check("imported photos untouched", (await owner.$$eval(".albums a.album", (l) => l.length)) >= 1);

// A post with words and one photo: deleting the photo keeps the post, its address and its comments.
await owner.goto(`${BASE}/posts`);
await owner.type("#composer textarea", "Words and a photo");
await (await owner.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#composer button.post")]);
const address = await owner.$eval("main article.card:first-of-type a.when", (a) => a.getAttribute("href"));
await owner.type("main article.card:first-of-type .say textarea", "Still here?");
await Promise.all([settled(owner), owner.click("main article.card:first-of-type .say button")]);
const [lone] = sql("SELECT m.id FROM media m JOIN posts p ON p.id = m.post_id WHERE p.text = 'Words and a photo'");
await owner.goto(`${BASE}/photos/${lone.id}`);
await Promise.all([owner.waitForNavigation(), owner.click(".photo-tools .danger")]);
await owner.goto(BASE + address);
check("deleting a post's only photo keeps the post, at the same address, with its comments",
  (await owner.$eval("article.card .text", (t) => t.textContent).catch(() => null)) === "Words and a photo"
  && (await owner.$$eval("article.card .comment", (l) => l.length)) === 1, address);

// Ids are never used twice: a post written after the newest is deleted doesn't take its number.
const newest = sql("SELECT MAX(id) AS id FROM posts")[0].id;
await owner.goto(`${BASE}/posts`);
await owner.click("main article.card:first-of-type header details.more summary");
await Promise.all([settled(owner), owner.click("main article.card:first-of-type header .delete")]);
await owner.type("#composer textarea", "After a delete");
await Promise.all([owner.waitForNavigation(), owner.click("#composer button.post")]);
check("a new post never takes a deleted one's id", sql("SELECT id FROM posts WHERE text = 'After a delete'")[0]?.id > newest);

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
