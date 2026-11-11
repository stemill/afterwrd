// Comments end to end: the owner imports a tiny export, whose posts and photos take no comments (for now), writes two
// posts (one with a picture that's also in the import) and comments on a post and a photo; their own comments aren't
// counted as new, cross-site and bad input refused, the burst limit, and comments survive a re-import. (Friends'
// comments, which arrive from their own sites, are in feed.mjs.)
//   node comments.mjs <zip>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/owner.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// Each suite starts on a new site (run.sh), and makes its owner from the terminal: the link to add their first device.
const newOwner = (name) => cli(name).match(/http\S+\/_auth\/device\/\S+/)[0];
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sql = (command) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command", command],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;

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
async function say(page, scope, text) {
  await page.type(`${scope} .say textarea`, text);
  await Promise.all([page.waitForNavigation(), page.click(`${scope} .say button`)]);
}
const bubbles = (page, scope) => page.$$eval(`${scope} .comment`, (l) => l.map((c) => ({
  id: c.id, name: c.querySelector(".bubble strong").textContent, text: c.querySelector(".said").textContent,
  canDelete: Boolean(c.querySelector(".under .delete")),
})));
const badge = (page) => page.$eval('header.site a[href="/activity"]', (a) => a.querySelector(".count")?.firstChild.textContent ?? "");

const ownerName = `Owner <b>${Date.now()}</b>`;
const owner = await person(newOwner(ownerName));
check("tiny export imports", !(await importZip(owner)));

// Facebook's posts and photos take no comments, for now: their addresses may not survive a new download.
await owner.goto(`${BASE}/posts`);
check("imported posts have no comment box", (await owner.$$("article.card")).length === 2 && !(await owner.$("article.card .say")));
const [imported] = sql("SELECT id, hash, thumb_hash, width, height, size FROM media WHERE source = 'facebook' AND kind = 'photo' AND thumb_hash IS NOT NULL ORDER BY id LIMIT 1");
await owner.goto(`${BASE}/photos/${imported.id}`);
check("an imported photo has no comment box", Boolean(await owner.$(".info")) && !(await owner.$(".info .say")));
check("…and comments on it are refused", (await owner.evaluate((target) => fetch("/_comments", { method: "POST", redirect: "manual",
  body: new URLSearchParams({ target, text: "x", back: "/posts" }) }).then((r) => r.status), `photo-${imported.hash}`)) === 403);

// Two posts written here: words, then a picture that's also in the import (its file is already stored).
const write = (body) => owner.evaluate((b) => fetch("/_admin/posts", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(b) }).then((r) => r.status), body);
check("a post written here", (await write({ text: "Written on afterwrd" })) === 200);
check("…and one with a picture from the import", (await write({ text: "", photos: [{ hash: imported.hash, thumb_hash: imported.thumb_hash,
  width: imported.width, height: imported.height, size: imported.size }] })) === 200);

// The owner comments on their newest post, including some HTML and a link.
await owner.goto(`${BASE}/posts`);
const firstCard = "article.card:first-of-type";
check("each post written here has a comment box, and only those", (await owner.$$("article.card .say textarea")).length === 2
  && (await owner.$$("article.own .say textarea")).length === 2);
await say(owner, firstCard, "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("posting lands back on the comment", /^\/posts#c\d+$/.test(new URL(owner.url()).pathname + new URL(owner.url()).hash), owner.url());
let shown = await bubbles(owner, firstCard);
check("comment shows straight away, text kept as typed", shown.length === 1 && shown[0].text === "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("names and text are escaped, link is a link", !(await owner.$(`${firstCard} .said script`)) && !(await owner.$(`${firstCard} .bubble strong b`))
  && (await owner.$eval(`${firstCard} .said a`, (a) => a.href)) === "https://example.com/");
check("owner can delete their own", shown[0].canDelete);

// The post's own page.
const postHref = await owner.$eval(`${firstCard} a.when`, (a) => a.getAttribute("href"));
await owner.goto(BASE + postHref);
check("post has its own page with the thread", (await bubbles(owner, "article.card")).length === 1, postHref);

// A comment on the photo posted here.
await owner.goto(`${BASE}/posts`);
const photoHref = await owner.$eval(`${firstCard} .collage a.tile`, (a) => a.getAttribute("href"));
await owner.goto(BASE + photoHref);
await say(owner, ".info", "Great photo");
check("photo comment shows in the info panel", (await bubbles(owner, ".info")).map((c) => c.text).join() === "Great photo");
await owner.goto(`${BASE}/photos/${imported.id}`);
check("…and on the same picture's imported copy", (await bubbles(owner, ".info")).map((c) => c.text).join() === "Great photo");

// The owner's own comments aren't news to them (friends' are; see feed.mjs).
await owner.goto(`${BASE}/posts`);
check("own comments don't count as new", (await badge(owner)) === "", await badge(owner));
await owner.goto(`${BASE}/activity`);
const items = await owner.$$eval(".activity", (l) => l.map((a) => ({ isNew: a.classList.contains("new"), href: a.querySelector(".what a")?.getAttribute("href") })));
check("Activity lists both, newest first, linking to the comment", items.length === 2 && !items.some((i) => i.isNew)
  && items[0].href.startsWith(photoHref + "#c") && items[1].href.startsWith(postHref + "#c"), JSON.stringify(items));

// Refused: another site, an unknown target, too long, an off-site redirect, and nobody signed in.
const cookie = (await owner.cookies()).find((c) => c.name === "__Host-session").value;
const post = (body, origin = BASE) => fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body) });
await owner.goto(`${BASE}/posts`);
const target = await owner.$eval(`${firstCard} .say input[name=target]`, (i) => i.value);
check("comment from another site refused", (await post({ target, text: "x", back: "/posts" }, "https://evil.example")).status === 403);
check("unknown target refused", (await post({ target: "post-1-deadbeef", text: "x", back: "/posts" })).status === 404);
const [facebookPost] = sql("SELECT key FROM posts WHERE source = 'facebook' LIMIT 1");
check("an imported post refused", (await post({ target: facebookPost.key, text: "x", back: "/posts" })).status === 403);
check("made-up target refused", (await post({ target: "../../x", text: "x", back: "/posts" })).status === 404);
check("over 2000 characters refused", (await post({ target, text: "x".repeat(2001), back: "/posts" })).status === 400);
const offsite = await post({ target, text: "redirect test", back: "https://evil.example/" });
check("back can't leave the site", new URL(offsite.headers.get("location"), BASE).origin === new URL(BASE).origin, offsite.headers.get("location"));
check("signed-out comment refused", (await fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual", headers: { Origin: BASE },
  body: new URLSearchParams({ target, text: "x" }) })).status === 401);
const forgedDelete = await fetch(`${BASE}/_comments/1/delete`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "back=/posts" });
check("delete from another site refused", forgedDelete.status === 403);

// A runaway script is stopped after 30 comments in ten minutes (a few have been made already).
// Sent all at once, as a script would, so a check-then-insert limit would let them all through.
const made = sql("SELECT COUNT(*) AS n FROM comments WHERE created_at > strftime('%s','now') - 600 AND author_name LIKE 'Owner%'")[0].n;
const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => post({ target, text: `burst ${i}`, back: "/posts" }).then((r) => r.status)));
const accepted = statuses.filter((s) => s === 303).length;
check("no more than 30 comments in ten minutes, even sent all at once", statuses.includes(429) && made + accepted <= 30,
  `${made} earlier + ${accepted} of 40 at once`);
sql("DELETE FROM comments WHERE text LIKE 'burst %' OR text = 'redirect test'");

// Changing a comment (edits.js): for 15 minutes, and until someone else comments after it.
await owner.goto(`${BASE}/posts`);
const firstComment = `${firstCard} .comment:first-of-type`;
const editComment = async (scope, words) => {
  await owner.click(`${scope} .under details.more summary`);
  await owner.click(`${scope} .under details.more a[href^="#edit"]`);
  await owner.$eval(`${scope} div.edit textarea`, (t, w) => { t.value = w; }, words);
  await Promise.all([owner.waitForNavigation(), owner.click(`${scope} div.edit button`)]);
};
check("the owner's comment offers Edit", Boolean(await owner.$(`${firstComment} div.edit`)));
await editComment(firstComment, "Lovely, changed");
check("the new words show, marked Edited, with what it said before", (await bubbles(owner, firstCard))[0].text === "Lovely, changed"
  && (await owner.$eval(`${firstComment} details.edited .versions`, (l) => l.textContent)).includes("Lovely <script>alert(1)</script>"));
await say(owner, firstCard, "Another thought");
check("the owner's own next comment doesn't stop them changing the first", Boolean(await owner.$(`${firstComment} div.edit`)));
const [mineFirst] = sql("SELECT id, target FROM comments WHERE text = 'Lovely, changed'");
check("…and the owner's own comments don't stop the post being changed", Boolean(await owner.$(`${firstCard} > div.edit`)));
sql(`INSERT INTO comments (target, author_id, author_name, text, created_at, origin)
  VALUES ('${mineFirst.target}', NULL, 'Sam Taylor', 'From a friend', strftime('%s','now'), 'https://friend.example')`);
await owner.goto(`${BASE}/posts`);
check("once someone else has commented after it, it can't be changed", !(await owner.$(`${firstComment} div.edit`)));
const tooLate = await fetch(`${BASE}/_comments/${mineFirst.id}/edit`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ text: "sneaky change", back: "/posts" }) });
check("…and the site refuses it", tooLate.status === 403 && sql(`SELECT text FROM comments WHERE id = ${mineFirst.id}`)[0].text === "Lovely, changed");
check("someone else's comment on a post stops the post being changed", !(await owner.$(`${firstCard} > div.edit`)));
const notTheirs = await fetch(`${BASE}/_comments/${sql("SELECT id FROM comments WHERE text = 'From a friend'")[0].id}/edit`, { method: "POST",
  redirect: "manual", headers: { Cookie: `__Host-session=${cookie}`, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ text: "words they never wrote", back: "/posts" }) });
check("the owner can't change a friend's comment", notTheirs.status === 404);
sql("DELETE FROM comments WHERE text IN ('From a friend', 'Another thought')");

// A second comment, deleted again; the rest survive a re-import.
await owner.goto(`${BASE}/posts`);
await say(owner, firstCard, "Thanks!");
const before = (await bubbles(owner, firstCard)).length;
const last = (await bubbles(owner, firstCard)).at(-1).id;
await owner.click(`#${last} .under details.more summary`);
await Promise.all([owner.waitForNavigation(), owner.click(`#${last} .under .delete`)]);
check("owner deletes a comment", (await bubbles(owner, firstCard)).length === before - 1);
const beforeImport = (await bubbles(owner, firstCard)).length;
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
check("post comments survive a re-import", beforeImport > 0 && (await bubbles(owner, firstCard)).length === beforeImport, `${(await bubbles(owner, firstCard)).length} after, page had ${beforeImport}`);
await owner.goto(BASE + photoHref);
check("photo comment survives a re-import", (await bubbles(owner, ".info")).length === 1);
await owner.goto(`${BASE}/posts`);
check("…and the posts written here keep their addresses", sql("SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'")[0].n === 2
  && (await owner.$eval(`${firstCard} a.when`, (a) => a.getAttribute("href"))) === postHref);

// Phone layout: nothing wider than the screen.
await owner.setViewport({ width: 375, height: 800, isMobile: true });
await owner.goto(`${BASE}/posts`);
check("no sideways scrolling on a phone", await owner.evaluate(() => document.documentElement.scrollWidth <= 375));
await owner.screenshot({ path: `${OUT}/comments-phone.png`, fullPage: true });
await owner.setViewport({ width: 1280, height: 900 });
await owner.goto(`${BASE}/activity`);
await owner.screenshot({ path: `${OUT}/activity.png`, fullPage: true });
await owner.goto(BASE + photoHref);
await owner.screenshot({ path: `${OUT}/photo-comments.png` });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
