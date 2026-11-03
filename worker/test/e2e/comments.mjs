// Comments end to end: the owner imports a tiny export and comments on a post and a photo, their own comments aren't
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
const cli = (...a) => execFileSync("node", ["scripts/invite.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// These suites share one database, so each starts with an owner of its own: the last suite's is revoked first
// (a site has only one).
const newOwner = (name) => {
  for (const line of cli("list").split("\n")) { const id = /^\s*(\d+)\s.*owner$/.exec(line)?.[1]; if (id) cli("revoke", id); }
  return cli("add", name, "--owner").match(/http\S+\/_auth\/invite\/\S+/)[0];
};
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

const ownerName = `Owner <b>${Date.now()}</b>`;
const owner = await person(newOwner(ownerName));
check("tiny export imports", !(await importZip(owner)));

// The owner comments on their first post, including some HTML and a link.
await owner.goto(`${BASE}/posts`);
const firstCard = "article.card:first-of-type";
check("each post has a comment box", (await owner.$$("article.card .say textarea")).length === 2);
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

// A comment on a photo.
await owner.goto(`${BASE}/photos/album/other`);
const photoHref = await owner.$eval(".justified a.tile", (a) => a.getAttribute("href"));
await owner.goto(BASE + photoHref);
await say(owner, ".info", "Great photo");
check("photo comment shows in the info panel", (await bubbles(owner, ".info")).map((c) => c.text).join() === "Great photo");

// The owner's own comments aren't news to them (friends' are; see feed.mjs).
await owner.goto(`${BASE}/posts`);
check("own comments don't count as new", (await badge(owner)) === "", await badge(owner));
await owner.goto(`${BASE}/activity`);
const items = await owner.$$eval(".activity", (l) => l.map((a) => ({ isNew: a.classList.contains("new"), href: a.querySelector(".what a")?.getAttribute("href") })));
check("Activity lists both, newest first, linking to the comment", items.length === 2 && !items.some((i) => i.isNew)
  && items[0].href.startsWith(photoHref + "#c") && items[1].href.startsWith(postHref + "#c"), JSON.stringify(items));

// Refused: another site, an unknown target, too long, an off-site redirect, and nobody signed in.
const cookie = (await owner.cookies()).find((c) => c.name === "__Host-hb_session").value;
const post = (body, origin = BASE) => fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body) });
await owner.goto(`${BASE}/posts`);
const target = await owner.$eval(`${firstCard} .say input[name=target]`, (i) => i.value);
check("comment from another site refused", (await post({ target, text: "x", back: "/posts" }, "https://evil.example")).status === 403);
check("unknown target refused", (await post({ target: "post-1-deadbeef", text: "x", back: "/posts" })).status === 404);
check("made-up target refused", (await post({ target: "../../x", text: "x", back: "/posts" })).status === 404);
check("over 2000 characters refused", (await post({ target, text: "x".repeat(2001), back: "/posts" })).status === 400);
const offsite = await post({ target, text: "redirect test", back: "https://evil.example/" });
check("back can't leave the site", new URL(offsite.headers.get("location"), BASE).origin === new URL(BASE).origin, offsite.headers.get("location"));
check("signed-out comment refused", (await fetch(`${BASE}/_comments`, { method: "POST", redirect: "manual", headers: { Origin: BASE },
  body: new URLSearchParams({ target, text: "x" }) })).status === 401);
const forgedDelete = await fetch(`${BASE}/_comments/1/delete`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-hb_session=${cookie}`, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "back=/posts" });
check("delete from another site refused", forgedDelete.status === 403);

// A runaway script is stopped after 30 comments in ten minutes (a few have been made already).
// Sent all at once, as a script would, so a check-then-insert limit would let them all through.
const made = Number(JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--json", "--command",
  "SELECT COUNT(*) AS n FROM site_comments WHERE created_at > strftime('%s','now') - 600 AND author_name LIKE 'Owner%'"],
  { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results[0].n);
const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => post({ target, text: `burst ${i}`, back: "/posts" }).then((r) => r.status)));
const accepted = statuses.filter((s) => s === 303).length;
check("no more than 30 comments in ten minutes, even sent all at once", statuses.includes(429) && made + accepted <= 30,
  `${made} earlier + ${accepted} of 40 at once`);
execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local", "--command", "DELETE FROM site_comments WHERE text LIKE 'burst %' OR text = 'redirect test'"],
  { cwd: WORKER, stdio: "ignore" });

// A second comment, deleted again; the rest survive a re-import.
await owner.goto(`${BASE}/posts`);
await say(owner, firstCard, "Thanks!");
const before = (await bubbles(owner, firstCard)).length;
const last = (await bubbles(owner, firstCard)).at(-1).id;
await Promise.all([owner.waitForNavigation(), owner.click(`#${last} .under button`)]);
check("owner deletes a comment", (await bubbles(owner, firstCard)).length === before - 1);
const beforeImport = (await bubbles(owner, firstCard)).length;
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
check("post comments survive a re-import", beforeImport > 0 && (await bubbles(owner, firstCard)).length === beforeImport, `${(await bubbles(owner, firstCard)).length} after, page had ${beforeImport}`);
await owner.goto(BASE + photoHref);
check("photo comment survives a re-import", (await bubbles(owner, ".info")).length === 1);

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
