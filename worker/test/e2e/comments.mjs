// Comments end to end: owner imports a tiny export, a friend comments on a post and a photo, Activity counts and
// clears, permissions on delete, cross-site and bad input refused, and comments survive a re-import.
//   node comments.mjs <zip>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/invite.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
// Start from no comments, so counts are this run's.
execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--command", "DELETE FROM site_comments; DELETE FROM site_photos; DELETE FROM site_posts"],
  { cwd: WORKER, stdio: "ignore" });

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
async function say(page, scope, text) {
  await page.type(`${scope} .say textarea`, text);
  await Promise.all([page.waitForNavigation(), page.click(`${scope} .say button`)]);
}
const bubbles = (page, scope) => page.$$eval(`${scope} .comment`, (l) => l.map((c) => ({
  id: c.id, name: c.querySelector(".bubble strong").textContent, text: c.querySelector(".said").textContent,
  canDelete: Boolean(c.querySelector(".under button")),
})));
const badge = (page) => page.$eval('header.site a[href="/activity"]', (a) => a.querySelector(".count")?.firstChild.textContent ?? "");

const ownerName = `Owner ${Date.now()}`;
const owner = await person(cli("add", ownerName, "--owner").match(/http\S+\/_auth\/invite\/\S+/)[0]);
check("tiny export imports", !(await importZip(owner)));

const friendName = `Friend <b>${Date.now()}</b>`;
const friend = await person(cli("add", friendName).match(/http\S+\/_auth\/invite\/\S+/)[0]);
const nav = await friend.$$eval("header.site nav.main a", (a) => a.map((x) => x.querySelector("span").textContent).join(","));
check("friend's menu has Notifications", nav === "Home,Photos,Notifications", nav);
await friend.goto(`${BASE}/`);
check("an invited friend's Home is the owner's posts", (await friend.$$("main article.card")).length === 2 && !(await friend.$("#composer")));

// The friend comments on the first post, including some HTML and a link.
await friend.goto(`${BASE}/posts`);
const firstCard = "article.card:first-of-type";
check("each post has a comment box", (await friend.$$("article.card .say textarea")).length === 2);
await say(friend, firstCard, "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("posting lands back on the comment", /^\/posts#c\d+$/.test(new URL(friend.url()).pathname + new URL(friend.url()).hash), friend.url());
let shown = await bubbles(friend, firstCard);
check("comment shows straight away, text kept as typed", shown.length === 1 && shown[0].text === "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("names and text are escaped, link is a link", !(await friend.$(`${firstCard} .said script`)) && !(await friend.$(`${firstCard} .bubble strong b`))
  && (await friend.$eval(`${firstCard} .said a`, (a) => a.href)) === "https://example.com/");
check("friend can delete their own", shown[0].canDelete);

// The post's own page.
const postHref = await friend.$eval(`${firstCard} a.when`, (a) => a.getAttribute("href"));
await friend.goto(BASE + postHref);
check("post has its own page with the thread", (await bubbles(friend, "article.card")).length === 1, postHref);

// The friend comments on a photo.
await friend.goto(`${BASE}/photos/album/other`);
const photoHref = await friend.$eval(".justified a.tile", (a) => a.getAttribute("href"));
await friend.goto(BASE + photoHref);
await say(friend, ".info", "Great photo");
check("photo comment shows in the info panel", (await bubbles(friend, ".info")).map((c) => c.text).join() === "Great photo");

// The owner sees two new comments, then Activity clears it.
await owner.goto(`${BASE}/posts`);
check("owner's menu shows 2 new", (await badge(owner)) === "2", await badge(owner));
check("owner can delete the friend's comment", (await bubbles(owner, firstCard))[0].canDelete);
await owner.goto(`${BASE}/activity`);
const items = await owner.$$eval(".activity", (l) => l.map((a) => ({ isNew: a.classList.contains("new"), what: a.querySelector(".what").textContent.replace(/\s+/g, " ").trim(), href: a.querySelector(".what a")?.getAttribute("href") })));
check("Activity lists both, newest first, marked new", items.length === 2 && items.every((i) => i.isNew) && items[0].what.endsWith("commented on your photo"), JSON.stringify(items[0]));
check("Activity links to the comment", items[0].href.startsWith(photoHref + "#c") && items[1].href.startsWith(postHref + "#c"));
await owner.goto(`${BASE}/posts`);
check("badge cleared after opening Activity", (await badge(owner)) === "", await badge(owner));

// The owner replies; the friend sees one new and can't delete the owner's.
await say(owner, firstCard, "Thanks!");
await friend.goto(`${BASE}/posts`);
check("friend sees 1 new", (await badge(friend)) === "1");
shown = await bubbles(friend, firstCard);
check("thread in order, friend can't delete the owner's", shown.map((c) => c.text).join("|").endsWith("|Thanks!") && !shown[1].canDelete);
const cookie = (await friend.cookies()).find((c) => c.name === "__Host-hb_session").value;
const ownersId = shown[1].id.slice(1);
const forced = await fetch(`${BASE}/_comments/${ownersId}/delete`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${cookie}`, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: "back=/posts" });
await friend.reload();
check("friend's forged delete of the owner's comment does nothing", forced.status === 303 && (await bubbles(friend, firstCard)).length === 2);

// Refused: another site, an unknown target, too long, and an off-site redirect.
const post = (body, origin = BASE) => fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body) });
const target = await friend.$eval(`${firstCard} .say input[name=target]`, (i) => i.value);
check("comment from another site refused", (await post({ target, text: "x", back: "/posts" }, "https://evil.example")).status === 403);
check("unknown target refused", (await post({ target: "post-1-deadbeef", text: "x", back: "/posts" })).status === 404);
check("made-up target refused", (await post({ target: "../../x", text: "x", back: "/posts" })).status === 404);
check("over 2000 characters refused", (await post({ target, text: "x".repeat(2001), back: "/posts" })).status === 400);
const offsite = await post({ target, text: "redirect test", back: "https://evil.example/" });
check("back can't leave the site", new URL(offsite.headers.get("location"), BASE).origin === new URL(BASE).origin, offsite.headers.get("location"));
check("signed-out comment refused", (await fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual", headers: { Origin: BASE },
  body: new URLSearchParams({ target, text: "x" }) })).status === 401);

// A runaway script is stopped after 30 comments in ten minutes (the friend has made a few already).
// Sent all at once, as a script would, so a check-then-insert limit would let them all through.
const made = Number(JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command",
  "SELECT COUNT(*) AS n FROM site_comments WHERE created_at > strftime('%s','now') - 600 AND author_name LIKE 'Friend%'"],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results[0].n);
const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => post({ target, text: `burst ${i}`, back: "/posts" }).then((r) => r.status)));
const accepted = statuses.filter((s) => s === 303).length;
check("no more than 30 comments in ten minutes, even sent all at once", statuses.includes(429) && made + accepted <= 30,
  `${made} earlier + ${accepted} of 40 at once`);
execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--command", "DELETE FROM site_comments WHERE text LIKE 'burst %' OR text = 'redirect test'"],
  { cwd: WORKER, stdio: "ignore" });

// The friend deletes their own; comments survive a re-import.
await friend.goto(`${BASE}/posts`);
const before = (await bubbles(friend, firstCard)).length;
const mine = (await bubbles(friend, firstCard)).filter((c) => c.canDelete).at(-1).id;
await Promise.all([friend.waitForNavigation(), friend.click(`#${mine} .under button`)]);
check("friend deletes their own comment", (await bubbles(friend, firstCard)).length === before - 1);
await owner.goto(`${BASE}/posts`);
const beforeImport = (await bubbles(owner, firstCard)).length;
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
check("post comments survive a re-import", beforeImport > 0 && (await bubbles(owner, firstCard)).length === beforeImport, `${(await bubbles(owner, firstCard)).length} after, page had ${beforeImport}`);
await owner.goto(BASE + photoHref);
check("photo comment survives a re-import", (await bubbles(owner, ".info")).length === 1);

// Phone layout: nothing wider than the screen.
await friend.setViewport({ width: 375, height: 800, isMobile: true });
await friend.goto(`${BASE}/posts`);
check("no sideways scrolling on a phone", await friend.evaluate(() => document.documentElement.scrollWidth <= 375));
await friend.screenshot({ path: `${OUT}/comments-phone.png`, fullPage: true });
await owner.setViewport({ width: 1280, height: 900 });
await owner.goto(`${BASE}/activity`);
await owner.screenshot({ path: `${OUT}/activity.png`, fullPage: true });
await owner.goto(BASE + photoHref);
await owner.screenshot({ path: `${OUT}/photo-comments.png` });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
