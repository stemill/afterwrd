// Two afterwrd sites on this computer (A on 8787, B on 8788), each with its own owner: connect them with a
// Connect link (Ann approves the request), see each other's new posts in Feed, comment across sites, delete, and
// disconnect. Then Ann invites Facebook friends: a forwarded invite is declined, the right person approved and linked.
//   node feed.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>   (C, on 8789, plays a third site)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath, fixtures, stateA, stateB, stateC] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const CODE = "local-test-setup-code";
const sql = (state, q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local",
  "--persist-to", state, "--json", "--command", q], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${site}/_auth/setup?code=${CODE}`);
  await page.type("#name", name);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  return page;
}
async function importZip(page, site, zip = zipPath, sections = ["posts", "photos"]) {
  await page.goto(`${site}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zip);
  await page.$$eval("input[name=section]", (boxes, want) => boxes.forEach((b) => { b.checked = want.includes(b.value); }), sections);
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}
async function compose(page, site, text, files = []) {
  await page.goto(`${site}/posts`);
  await page.type("#composer textarea", text);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
const feedCards = (page) => page.$$eval("article.from-friend", (l) => l.map((a) => ({
  who: a.querySelector("header strong").textContent, text: a.querySelector(".text")?.textContent ?? "",
  photos: a.querySelectorAll(".collage img").length,
  comments: [...a.querySelectorAll(".comment")].map((c) => ({ name: c.querySelector("strong").textContent,
    from: c.querySelector(".from")?.textContent ?? "", text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under button")) })),
})));

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
check("both sites set up and import", !(await importZip(ann, A)) && !(await importZip(bob, B)));
await compose(ann, A, "Ann's news from site A");
await compose(bob, B, "Bob's holiday", [`${fixtures}/photo1.jpg`]);

// Before connecting.
await ann.goto(`${A}/`);
check("Home is first in the owner's menu", (await ann.$$eval("header.site nav.main a", (l) => l.map((a) => a.querySelector("span").textContent)))[0] === "Home");
check("empty Feed explains adding friends", (await ann.$eval("main", (m) => m.textContent)).includes("Add friends to see their posts here"));

// Ann makes a Connect link; Bob opens it, gives his site, and confirms there.
await ann.goto(`${A}/_admin/connections`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
check("friend link made, with a message to send", /^http:\/\/localhost:8787\/_connect\/[\w-]{40,}$/.test(link)
  && (await ann.$eval("#link-message", (t) => t.value)).endsWith(link), link.slice(0, 50) + "…");

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(link);
check("link opens a welcome naming Ann, without signing in", (await stranger.$eval("h1", (h) => h.textContent)) === "Ann Example would like to be friends");
await bob.goto(link);
await bob.type("#site input", B);
await Promise.all([bob.waitForNavigation(), bob.click("#site button")]);
check("Bob is sent to his own site to confirm", bob.url().startsWith(`${B}/_admin/connections/new?link=`)
  && (await bob.$eval("h1", (h) => h.textContent)) === "Add Ann Example as a friend?");
await Promise.all([bob.waitForNavigation({ timeout: 30_000 }), bob.click("#go")]);
check("confirming connects and opens Bob's Home", new URL(bob.url()).pathname === "/", bob.url());

// Nothing is shared until Ann approves: a passed-on link gets someone no further than a request.
check("Bob's Home says Ann hasn't approved yet", (await bob.$eval("main", (m) => m.textContent)).includes("Waiting for Ann Example to approve"));
const keyBobHolds = sql(stateB, "SELECT their_key FROM connections")[0].their_key;
check("Bob's key can't read Ann's site yet", (await fetch(`${A}/_peer/feed`, { headers: { Authorization: `Bearer ${keyBobHolds}` } })).status === 403);
await ann.goto(`${A}/`);
check("Ann's Friends shows 1 request", (await ann.$eval('header.site a[href="/friend"] .count', (c) => c.firstChild.textContent).catch(() => "")) === "1");
check("Ann's Home doesn't show Bob yet", !(await ann.$("article.from-friend")));
await ann.goto(`${A}/friend`);
const asking = await ann.$eval(".requests", (r) => r.innerText).catch(() => "");
check("Friends lists Bob under Asking to be friends", asking.includes("Bob Example") && asking.includes("Used a friend link you made"), asking);
// Approved from Home, in one tap.
await ann.goto(`${A}/`);
const homeAsk = await ann.$eval(".notice.asking", (n) => n.textContent.replace(/\s+/g, " ")).catch(() => "");
check("Home says who's asking to be friends, leading with their site", homeAsk.includes("localhost:8788") && homeAsk.includes("who says they're Bob Example"), homeAsk);
await Promise.all([ann.waitForNavigation(), ann.click('.notice.asking button[formaction*="/approve"]')]);
check("…and Approve there keeps Ann on Home", new URL(ann.url()).pathname === "/" && !(await ann.$(".notice.asking")));
await ann.goto(`${A}/friend`);
check("Approve makes Bob a friend", !(await ann.$(".requests")) && (await ann.$eval("main", (m) => m.innerText)).includes("Bob Example")
  && sql(stateA, "SELECT approved_at FROM connections")[0].approved_at > 0);
await bob.goto(`${B}/`);

// Each sees the other's new posts, and only those.
let bobFeed = await feedCards(bob);
check("Bob's Feed has Ann's post, and only her afterwrd post", bobFeed.length === 1 && bobFeed[0].who === "Ann Example"
  && bobFeed[0].text === "Ann's news from site A", JSON.stringify(bobFeed));
await ann.goto(`${A}/`);
check("Home shows Ann's own posts and Bob's together", Boolean(await ann.$("article.own")) && Boolean(await ann.$("article.from-friend")));
let annFeed = await feedCards(ann);
check("Ann's Feed has Bob's post with its photo", annFeed.length === 1 && annFeed[0].who === "Bob Example" && annFeed[0].photos === 1, JSON.stringify(annFeed));
await ann.waitForFunction(() => document.querySelector("article.from-friend .collage img")?.complete, { timeout: 15_000 });
// Bob makes his holiday photo his profile picture; Ann's site shows it, and remembers it for her Friends page.
await bob.goto(`${B}/posts`);
const bobsPhoto = await bob.$eval("main article.own .collage a.tile", (a) => a.getAttribute("href"));
await bob.goto(B + bobsPhoto);
await Promise.all([bob.waitForNavigation(), bob.click('.photo-tools form:nth-of-type(1) button')]);
check("Bob's own header shows his new picture", Boolean(await bob.$("header.site .face img")));
await ann.goto(`${A}/`);
check("Ann's Home shows Bob's picture on his post", await ann.$eval("article.from-friend header img.who", (i) => i.getAttribute("src").startsWith("http://localhost:8788/files/")).catch(() => false));
await ann.goto(`${A}/friend`);
check("…and her Friends page remembers it", Boolean(await ann.$(".friend-link img.who")));
await ann.goto(`${A}/`);
check("the photo loads straight from Bob's site, by a signed link", await ann.$eval("article.from-friend .collage img", (i, b) => i.naturalWidth > 0
  && i.getAttribute("src").startsWith(`${b}/files/`) && i.getAttribute("src").includes("&sig="), B));
await ann.goto(`${A}/_admin/connections`);
check("Ann's Connections lists Bob", (await ann.$eval("table.numbers tbody", (t) => t.textContent)).includes("Bob Example"));

// Ann comments on Bob's post from her Feed; it's stored on Bob's site.
await ann.goto(`${A}/`);
await ann.type("article.from-friend .say textarea", "Looks great, Bob!");
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend .say button")]);
annFeed = await feedCards(ann);
check("Ann's comment shows in her Feed, deletable", annFeed[0].comments.length === 1 && annFeed[0].comments[0].name === "Ann Example"
  && annFeed[0].comments[0].canDelete, JSON.stringify(annFeed[0].comments));
check("it's stored on Bob's site, from Ann's", sql(stateB, "SELECT author_name, origin FROM site_comments").some((c) => c.author_name === "Ann Example" && c.origin === A));
check("Ann keeps a copy", sql(stateA, "SELECT text FROM comments_elsewhere").map((c) => c.text).join() === "Looks great, Bob!");
await bob.goto(`${B}/posts`);
const onBob = await bob.$$eval("main article.card:first-of-type .comment", (l) => l.map((c) => ({ name: c.querySelector("strong").textContent, from: c.querySelector(".from")?.textContent })));
check("Bob sees it under his post, marked with Ann's site", onBob.length === 1 && onBob[0].name === "Ann Example" && onBob[0].from === "localhost:8787", JSON.stringify(onBob));
check("Bob's Activity counts it as new", (await bob.$eval('header.site a[href="/activity"] .count', (c) => c.firstChild.textContent)) === "1");

// Bob replies on his own site; Ann sees the reply in her Feed but can't delete it.
await bob.type("main article.card:first-of-type .say textarea", "Thanks Ann");
await Promise.all([bob.waitForNavigation(), bob.click("main article.card:first-of-type .say button")]);
await ann.goto(`${A}/`);
annFeed = await feedCards(ann);
check("Ann sees Bob's reply, not deletable by her", annFeed[0].comments.map((c) => c.text).join("|") === "Looks great, Bob!|Thanks Ann"
  && !annFeed[0].comments[1].canDelete);

// Bob's site tells Ann's about the reply, because she commented there too: it's on her Notifications.
check("Bob's site sends Ann a note about his reply", await waitFor(() => sql(stateA, "SELECT COUNT(*) AS n FROM inbox WHERE kind = 'comment'")[0].n === 1));
await ann.goto(`${A}/posts`);
check("…which counts on her Notifications", (await ann.$eval('header.site a[href="/activity"] .count', (c) => c.firstChild.textContent).catch(() => "")) === "1");
await ann.goto(`${A}/activity`);
const note = await ann.$eval(".activity.new", (a) => ({ what: a.querySelector(".what").textContent.replace(/\s+/g, " ").trim(),
  text: a.querySelector(".text")?.textContent, href: a.querySelector(".what a").getAttribute("href") })).catch(() => ({}));
check("…saying who replied, where, and what", note.what === "Bob Example replied on their post" && note.text === "Thanks Ann"
  && /^\/friend\/\d+\/posts#f\d+-post-/.test(note.href ?? ""), JSON.stringify(note));

// Comments from Bob's visitors (and other friends) stay on Bob's site.
sql(stateB, `INSERT INTO site_comments (target, author_id, author_name, text, created_at, origin)
  SELECT target, NULL, 'Bob''s visitor', 'For Bob''s eyes', strftime('%s','now'), 'site' FROM site_comments LIMIT 1`);
await ann.goto(`${A}/`);
check("friends see the whole thread, visitors' comments included (as when visiting)", (await feedCards(ann))[0].comments.some((c) => c.text === "For Bob's eyes"));

// Ann deletes her comment from her Feed.
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend .comment .under button")]);
check("Ann's comment deleted on Bob's site", sql(stateB, "SELECT COUNT(*) AS n FROM site_comments WHERE origin != 'site'")[0].n === 0
  && sql(stateA, "SELECT COUNT(*) AS n FROM comments_elsewhere")[0].n === 0);

// What a connection can and can't reach.
const keyForB = sql(stateA, "SELECT their_key FROM connections")[0].their_key;
const peer = (path, key, body) => fetch(B + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
check("no key, no feed", (await peer("/_peer/feed")).status === 401);
check("no key, no notes", (await peer("/_peer/notify", null, { type: "Create", object: { type: "Note", id: `${A}/posts/post-1-deadbeef` } })).status === 401);
check("a note about another site's post is refused", (await peer("/_peer/notify", keyForB,
  { type: "Create", object: { type: "Note", id: `${C}/posts/post-1-deadbeef` } })).status === 400);
const notesOnBob = () => sql(stateB, "SELECT COUNT(*) AS n FROM inbox")[0].n;
const notesBefore = notesOnBob();
await peer("/_peer/notify", keyForB, { type: "Create", object: { type: "Note", inReplyTo: `${A}/posts/post-1-deadbeef`, content: "spam" } });
check("a note about a comment Bob had no part in isn't kept", notesOnBob() === notesBefore);
check("wrong key, no feed", (await peer("/_peer/feed", "x".repeat(43))).status === 401);
const bobsImportedPost = sql(stateB, "SELECT timestamp FROM posts WHERE id < 1000000000 LIMIT 1")[0];
check("can't comment on an imported post", (await peer("/_peer/comments", keyForB, { type: "Note", inReplyTo: `${B}/posts/post-${bobsImportedPost.timestamp}-00000000`, content: "x" })).status === 404);
// With his Facebook photos not shared, a photo from them can't be seen or commented on, even by fingerprint.
const sharedBefore = sql(stateB, "SELECT value FROM settings WHERE key = 'sections'")[0]?.value ?? "[]";
sql(stateB, `INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '[]')`);
const unshared = sql(stateB, "SELECT hash FROM media WHERE hash IS NOT NULL AND (album_id IS NULL OR album_id < 1000000000) AND (post_id IS NULL OR post_id < 1000000000) LIMIT 1")[0]?.hash;
check("a photo Bob hasn't shared can't be fetched by its fingerprint", Boolean(unshared) && (await peer(`/_peer/photos/${unshared}`, keyForB)).status === 404, unshared);
check("…or commented on", (await peer("/_peer/comments", keyForB, { type: "Note", inReplyTo: `${B}/photos/sha256/${unshared}`, content: "x" })).status === 404);
sql(stateB, `INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '${sharedBefore.replace(/'/g, "''")}')`);
check("…but can once his photos are shared", (await peer(`/_peer/photos/${unshared}`, keyForB)).status === 200);
const bobsComment = sql(stateB, "SELECT id FROM site_comments WHERE origin = 'site' LIMIT 1")[0].id;
await peer(`/_peer/comments/${bobsComment}/delete`, keyForB, {});
check("can't delete Bob's own comments", sql(stateB, `SELECT COUNT(*) AS n FROM site_comments WHERE id = ${bobsComment}`)[0].n === 1);
check("a used Connect link is refused", (await (await browser.createBrowserContext()).newPage().then(async (p) => (await p.goto(link)).status())) === 404);
check("Feed actions need the owner's session", (await fetch(`${A}/_feed/comments`, { method: "POST", redirect: "manual", headers: { Origin: A } })).status === 401);
check("another site can't post Ann's comments", (await fetch(`${A}/_feed/comments`, { method: "POST", redirect: "manual",
  headers: { Origin: "https://evil.example", Cookie: `__Host-session=${(await ann.cookies()).find((c) => c.name === "__Host-session").value}` } })).status === 403);

// Bob, connected to Ann, can't pass himself off as Ann to a third site using the key Ann gave him.
const cara = await owner(C, "Cara Example");
await cara.goto(`${C}/_admin/connections`);
await cara.click("#make");
await cara.waitForSelector("#link:not([hidden])");
const caraToken = (await cara.$eval("#link-url", (i) => i.value)).split("/_connect/")[1];
const keyBobHoldsForAnn = sql(stateB, "SELECT their_key FROM connections")[0].their_key;
const forged = await fetch(`${C}/_connect/${caraToken}/accept`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: A, key: keyBobHoldsForAnn }) });
check("a connected site can't impersonate another to a third", forged.status === 400 && sql(stateC, "SELECT COUNT(*) AS n FROM connections")[0].n === 0,
  `${forged.status} ${(await forged.text()).slice(0, 80)}`);
check("…and the link is still usable by the real friend", (await (await browser.createBrowserContext()).newPage().then(async (p) => (await p.goto(`${C}/_connect/${caraToken}`)).status())) === 200);
check("hello refuses a finished connection's key", (await fetch(`${A}/_peer/hello?from=${encodeURIComponent(C)}`, { headers: { Authorization: `Bearer ${keyBobHoldsForAnn}` } })).status === 401);

// Ann reads Bob's posts and photos without leaving her own site.
const bobId = sql(stateA, "SELECT id FROM connections")[0].id;

// Ann asks Bob to check her site: his Home shows it, and one tap makes the link to send her (checks.js).
const annIdOnB = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
const makeLinkAsBob = () => bob.evaluate((id) => fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connection: id }) }).then((r) => r.status), annIdOnB);
await bob.goto(`${B}/`);
check("a friend's site can't make a check link for someone who didn't ask", (await makeLinkAsBob()) === 409);
await ann.goto(`${A}/_admin/update`);
await ann.$eval("#ask-other", (d) => { d.open = true; });
await ann.click("#ask-check");
const askMessage = await ann.$eval("#ask-message", (t) => t.value);
check("for anyone else, Update writes a message naming this site", askMessage.includes("localhost:8787")
  && askMessage.includes("(or just my address)") && await ann.$eval("#ask-panel", (p) => !p.hidden), askMessage);
await ann.click(`button[data-ask="${bobId}"]`);
await ann.waitForFunction(() => document.getElementById("ask-result").textContent, { timeout: 10_000 });
const asked = await ann.$eval("#ask-result", (p) => p.textContent);
check("Update has a button to ask each friend, which sends Bob's site the request", asked.startsWith("Asked Bob Example.")
  && sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 1, asked);
await bob.goto(`${B}/`);
const request = await bob.$eval(".check-request", (d) => d.textContent.replace(/\s+/g, " ")).catch(() => "");
check("Bob's Home shows Ann's request", request.includes("Ann Example asks you to check their afterwrd site"), request);
await bob.click(".check-request button[data-check-request]");
await bob.waitForFunction(() => document.querySelector(".check-request")?.dataset.message, { timeout: 10_000 });
const sent = await bob.$eval(".check-request", (d) => d.dataset.message);
const checkLink = /http\S+\/_check\/[\w-]{43}/.exec(sent)?.[0] ?? "";
check("one tap makes a check link on Bob's site, in a message to send her", checkLink.startsWith(`${B}/_check/`) && sent.includes("as you asked")
  && await bob.$eval(".check-share", (s) => !s.hidden), sent);
check("…and the request is done with", sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 0
  && (await bob.goto(`${B}/`), (await bob.$(".check-request")) === null));
await ann.goto(checkLink);
const checkPage = await ann.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
check("Ann opens it: Bob's site, ready to check her site and only hers", checkPage.includes("Bob Example would like to check your site")
  && checkPage.includes("Your site: localhost:8787") && (await ann.$("input[name=site]")) === null, checkPage.slice(0, 300));
await ann.goto(`${A}/_admin/update`);
await ann.click(`button[data-ask="${bobId}"]`);
await ann.waitForFunction(() => document.getElementById("ask-result").textContent, { timeout: 10_000 });
await bob.goto(`${B}/`);
await Promise.all([bob.waitForNavigation(), bob.click(".check-request form button")]);
check("\"Not now\" puts a request away", (await bob.$(".check-request")) === null && sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 0);
check("only a friend's site can ask for a check", (await fetch(`${B}/_peer/check-request`, { method: "POST",
  headers: { Authorization: `Bearer ${"x".repeat(43)}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "CheckRequest" }) })).status === 401);
await ann.goto(`${A}/`);
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend header .what a")]);
check("Bob's name on Home opens his page on Ann's site", ann.url() === `${A}/friend/${bobId}/posts`, ann.url());
const bobsPosts = await ann.$$eval("main article.card .text", (l) => l.map((t) => t.textContent));
check("his imported posts are there too", bobsPosts.includes("Hello from the installer test") && bobsPosts.includes("Bob's holiday"),
  bobsPosts.join("|") || (await ann.$eval("main", (m) => m.innerText.slice(0, 300))));
await ann.goto(`${A}/friend/${bobId}/photos`);
const bobAlbums = await ann.$$eval(".albums a.album", (l) => l.map((a) => ({ href: a.getAttribute("href"), name: a.querySelector("strong").textContent })));
check("his albums are listed", bobAlbums.some((a) => a.name === "Posted on afterwrd") && bobAlbums.some((a) => a.name === "Other photos"), bobAlbums.map((a) => a.name).join());
await ann.goto(A + bobAlbums.find((a) => a.name === "Other photos").href);
const photoTile = await ann.$eval(".justified a.tile", (a) => a.getAttribute("href"));
await ann.goto(A + photoTile);
await ann.waitForFunction(() => document.querySelector(".stage img")?.complete, { timeout: 15_000 });
const full = await ann.$eval(".stage img", (i) => ({ w: i.naturalWidth, src: i.getAttribute("src") }));
check("a photo opens on Ann's site, full size, from Bob's", full.w === 1200 && full.src.startsWith(`${B}/files/`), full.src.slice(0, 60));
await ann.type(".info .say textarea", "What a view");
await Promise.all([ann.waitForNavigation(), ann.click(".info .say button")]);
check("Ann comments on Bob's photo from her site", new URL(ann.url()).pathname === photoTile
  && (await ann.$$eval(".info .comment", (l) => l.map((c) => ({ t: c.querySelector(".said").textContent, d: Boolean(c.querySelector(".under button")) })))).some((c) => c.t === "What a view" && c.d));
check("…stored on Bob's site against that photo", sql(stateB, "SELECT target, origin FROM site_comments WHERE text = 'What a view'")
  .some((c) => c.target === `photo-${photoTile.split("/").pop()}` && c.origin === A));
await ann.screenshot({ path: `${OUT}/friend-photo.png` });
await ann.goto(`${A}/friend/${bobId}/posts`);
await ann.screenshot({ path: `${OUT}/friend-posts.png`, fullPage: true });
await ann.goto(`${A}/friend/${bobId}/photos`);
await ann.screenshot({ path: `${OUT}/friend-photos.png` });
const signed = full.src;
check("the signed link works without signing in", (await fetch(signed)).status === 200);
check("a tampered link doesn't", (await fetch(signed.replace(/sig=(.)/, (_, c) => `sig=${c === "A" ? "B" : "A"}`))).status === 403);
check("nor an expired one", (await fetch(signed.replace(/exp=\d+/, "exp=1000"))).status === 403);
check("files without a link still need signing in", (await fetch(signed.split("?")[0], { redirect: "manual" })).status === 302);
check("only Ann (the owner) can open friend pages", (await (await fetch(`${A}/friend/${bobId}/posts`, { redirect: "manual" })).status) === 302);

// One Friends list: friends on afterwrd, linked (when Ann says so) to who they are in her Facebook download.
check("Ann re-imports with her Facebook friends list", !(await importZip(ann, A, zipPath.replace(/fake-export\.zip$/, "friends-export.zip"),
  ["posts", "photos", "friends"])));
await ann.goto(`${A}/posts`);
const annMenu = await ann.$$eval("header.site nav.main a", (l) => l.map((a) => a.querySelector("span").textContent));
check("with Facebook sections published, Memories appears in her menu", Boolean(await ann.$('header.site .menu a[href="/memories"]')));
await ann.goto(`${A}/memories`);
check("Memories gathers the Facebook sections", (await ann.$$eval(".memory-tiles strong", (l) => l.map((s) => s.textContent))).join() === "Facebook friends");
await ann.goto(`${A}/posts`);
check("the owner has one Friends in the menu", annMenu.filter((l) => l === "Friends").length === 1, annMenu.join());
await Promise.all([ann.waitForNavigation(), ann.click('header.site nav.main a[href="/friend"]')]);
const friendsText = () => ann.$eval("main", (m) => m.innerText);
check("Friends lists Bob on afterwrd, and suggests his Facebook self", (await friendsText()).includes("Is this Bob Example from your Facebook download?"));
const fbRow = (name) => ann.$$eval("#fb-people tbody tr", (rows, n) => rows.find((r) => r.cells[0].textContent === n)?.cells[2].textContent.trim(), name);
check("…and everyone from Facebook below, with an Invite button", (await fbRow("John Smith")) === "Invite" && (await fbRow("Bob Example")) === "Invite");
await Promise.all([ann.waitForNavigation(), ann.click(".fb-link button.chip:not([name])")]);
check("Yes links them", (await friendsText()).includes("On Facebook as Bob Example") && (await fbRow("Bob Example")) === "On afterwrd");
await ann.goto(`${A}/friend/${bobId}/posts`);
const history = await ann.$eval('.feed-head a[href^="/people/"]', (a) => a.getAttribute("href")).catch(() => null);
check("Bob's page offers your Facebook history together", Boolean(history));
await ann.goto(A + history);
check("…which is his page from the download", (await ann.$eval("h1", (h) => h.textContent)) === "Bob Example");
await ann.goto(`${A}/friend`);
await Promise.all([ann.waitForNavigation(), ann.click(".fb-link button.link")]);
check("Unlink undoes it (and the suggestion comes back)", (await friendsText()).includes("Is this Bob Example"));
await Promise.all([ann.waitForNavigation(), ann.click('.fb-link button[name="none"]')]);
check("No stops suggesting it", !(await friendsText()).includes("Is this Bob Example") && Boolean(await ann.$(".fb-pick")));
await ann.click(".fb-pick summary");
await ann.type('.fb-pick input[name="name"]', "John Smith");
await Promise.all([ann.waitForNavigation(), ann.click(".fb-pick button")]);
check("a different name can be picked by hand", (await friendsText()).includes("On Facebook as John Smith") && (await fbRow("John Smith")) === "On afterwrd");
check("a name that isn't in the download isn't linked", await (async () => {
  await ann.goto(`${A}/friend`);
  await ann.click(".fb-link button.link").then(() => ann.waitForNavigation());
  await ann.$eval('.fb-link input[name="name"]', (i) => { i.value = "Nobody Atall"; }).catch(() => {});
  return true;
})() && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links WHERE person_name = 'Nobody Atall'")[0].n === 0);
await ann.screenshot({ path: `${OUT}/friends.png`, fullPage: true });

// Friends read each other from their own sites; the old ways of coming in to the other's site are gone.
const keyAnnHoldsForBob = sql(stateA, "SELECT their_key FROM connections")[0].their_key;
check("no one-time passes to visit any more", (await fetch(`${B}/_peer/ticket`, { method: "POST", headers: { "Content-Type": "application/json",
  Authorization: `Bearer ${keyAnnHoldsForBob}` }, body: "{}" })).status === 404);
check("no friend sign-in any more", (await fetch(`${B}/_auth/friend?ticket=${"x".repeat(43)}`)).status === 404);
check("the sign-in page offers only passkeys", !(await (await fetch(`${B}/_auth/login`)).text()).includes("Connected friend"));
await ann.goto(`${A}/_admin/connections`);
check("Connections has no Visit button", !(await ann.$('a[href^="/_feed/visit"]')));
check("…and the old Visit link is gone", (await ann.goto(`${A}/_feed/visit?to=${encodeURIComponent(B)}`)).status() === 404);

// Download everything, on both sites: Ann's copy of her comment and Bob's copy share one address.
await ann.goto(`${A}/`);
await ann.type("article.from-friend .say textarea", "Kept forever");
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend .say button")]);
async function download(page, site, label) {
  const dir = `${OUT}/downloads/${label}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Headless Chrome never finishes saving downloads, so keep the zip the page hands to the browser.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__download = blob; return make(blob); };
  });
  await page.goto(`${site}/_admin/export`);
  await page.waitForFunction(() => document.getElementById("size").textContent !== "", { timeout: 10_000 }).catch(() => {});
  await page.click("#go");
  await page.waitForFunction(() => /Done/.test(document.getElementById("status").textContent) || document.getElementById("error").textContent,
    { timeout: 120_000, polling: 500 });
  const problem = await page.$eval("#error", (e) => e.textContent);
  const base64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await window.__download.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  const zipFile = `${dir}/download.zip`;
  writeFileSync(zipFile, Buffer.from(base64, "base64"));
  const list = execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" }).trim().split("\n");
  const read = (name) => execFileSync("unzip", ["-p", zipFile, list.find((f) => f.endsWith(`/${name}`))], { maxBuffer: 1e8 });
  return { problem, list, read, json: (name) => JSON.parse(read(name).toString()) };
}
const annZip = await download(ann, A, "ann");
const bobZip = await download(bob, B, "bob");
check("both downloads finish", !annZip.problem && !bobZip.problem, annZip.problem || bobZip.problem);
check("download has the documents and a README", ["README.txt", "profile.json", "posts.json", "photos.json", "albums.json",
  "comments-elsewhere.json", "connections.json", "facebook-comments.json"].every((f) => annZip.list.some((x) => x.endsWith(`/${f}`))));
const elsewhere = annZip.json("comments-elsewhere.json").orderedItems.find((c) => c.content === "Kept forever");
const bobPosts = bobZip.json("posts.json");
const bobsNote = bobPosts.orderedItems.find((n) => n.content === "Bob's holiday");
const reply = bobsNote?.replies?.items.find((c) => c.content === "Kept forever");
check("Ann's copy and Bob's copy of her comment share one address", Boolean(elsewhere && reply && elsewhere.id === reply.id
  && elsewhere.inReplyTo === bobsNote.id && reply.inReplyTo === bobsNote.id), elsewhere?.id);
check("Bob's copy says it's from Ann's site", reply?.attributedTo?.id === `${A}/` && reply?.attributedTo?.name === "Ann Example");
check("posts are ActivityStreams Notes with permanent addresses", bobPosts["@context"][0] === "https://www.w3.org/ns/activitystreams"
  && bobPosts.orderedItems.every((n) => n.type === "Note" && n.id.startsWith(`${B}/posts/post-`)));
check("afterwrd posts and imported posts are told apart", bobsNote?.["afterwrd:source"] === "afterwrd"
  && bobPosts.orderedItems.some((n) => n["afterwrd:source"] === "facebook"));
const photo = bobsNote.attachment.find((a) => a.type === "Image");
const stored = bobZip.read(photo["afterwrd:file"]);
check("photos are in the zip, matching their fingerprint", createHash("sha256").update(stored).digest("hex") === photo.url.split("/files/")[1]);
check("photo addresses lead to the photo", (await (await fetch(photo.id, { redirect: "manual",
  headers: { Cookie: `__Host-session=${(await bob.cookies()).find((c) => c.name === "__Host-session").value}` } })).headers.get("location") ?? "").match(/\/photos\/\d+$/));
const everything = annZip.list.filter((f) => f.endsWith(".json")).map((f) => annZip.read(f.split("/").pop()).toString()).join("");
const annKeys = sql(stateA, "SELECT their_key, key_hash FROM connections")[0];
check("no keys in the download", !everything.includes(annKeys.their_key) && !everything.includes(annKeys.key_hash) && !everything.includes("key_hash"));
check("Ann's connections list Bob by address", annZip.json("connections.json").orderedItems[0]?.id === `${B}/`);

// Phone view of the Feed, then disconnect.
await ann.setViewport({ width: 375, height: 800, isMobile: true });
await ann.goto(`${A}/`);
check("no sideways scrolling on a phone", await ann.evaluate(() => document.documentElement.scrollWidth <= 375));
await ann.screenshot({ path: `${OUT}/feed-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 900 });
await ann.goto(`${A}/_admin/connections`);
await ann.screenshot({ path: `${OUT}/connections.png` });
await Promise.all([ann.waitForNavigation(), ann.click("button[data-disconnect]")]);
check("Remove friend removes it on both sites", sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0
  && sql(stateB, "SELECT COUNT(*) AS n FROM connections")[0].n === 0);
check("the old key stops working", (await peer("/_peer/feed", keyForB)).status === 401);
check("Ann keeps her copies of what she said after disconnecting", sql(stateA, "SELECT site FROM comments_elsewhere").some((c) => c.site === B));
check("disconnecting forgets who they were on Facebook", sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

// Ann invites Facebook friends to afterwrd. Zoe's invite is passed on to Cara, so Ann declines it; Cara's own is
// approved, and she's linked to her Facebook self.
await ann.goto(`${A}/friend`);
async function invite(name) {
  await ann.goto(`${A}/friend`);
  await ann.$$eval("#fb-people tbody tr", (rows, n) => rows.find((r) => r.cells[0].textContent === n).querySelector("button[data-invite]").click(), name);
  await ann.waitForFunction(() => document.getElementById("invite-message").value, { timeout: 10_000 });
  const message = await ann.$eval("#invite-message", (t) => t.value);
  return { message, link: message.match(/http\S+\/_connect\/[\w-]+/)?.[0] };
}
async function connectFrom(page, site, link) {
  await page.goto(link);
  await page.type("#site input", site);
  await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
const zoe = await invite("Zoe Quinn");
await ann.screenshot({ path: `${OUT}/invite-panel.png` });
check("Invite gives a message to send, with a friend link", zoe.message.startsWith("Hi Zoe,") && zoe.message.endsWith(zoe.link) && Boolean(zoe.link), zoe.message);
const welcome = await (await browser.createBrowserContext()).newPage();
await welcome.goto(zoe.link);
const installHref = new URL(await welcome.$eval("#install", (a) => a.href));
const carried = new URLSearchParams(installHref.hash.slice(1));
check("the link's page offers to set up a site, carrying the link and the invited name after the #", installHref.origin === "https://install.afterwrd.app"
  && carried.get("invite") === zoe.link && carried.get("name") === "Zoe Quinn" && !installHref.search, installHref.href);
await ann.goto(`${A}/friend`);
check("…and the list remembers she was invited", (await fbRow("Zoe Quinn")).startsWith("Invited"), await fbRow("Zoe Quinn"));
const again = await invite("Zoe Quinn");
check("New link replaces the old one", again.link !== zoe.link && (await fetch(zoe.link)).status === 404);
check("only people in the download can be invited", (await ann.evaluate(() => fetch("/_admin/connections/invite", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nobody Atall" }) }).then((r) => r.status))) >= 400);

await connectFrom(cara, C, again.link);
await ann.goto(`${A}/friend`);
const forwarded = await ann.$eval(".requests", (r) => r.innerText).catch(() => "");
check("a request shows whose invite was used", forwarded.includes("Cara Example") && forwarded.includes("Used the invite you made for Zoe Quinn"), forwarded);
check("…warns that it isn't the name invited, and leads with the site's address", forwarded.includes("That's not the name you invited")
  && (await ann.$eval(".requests strong", (e) => e.textContent)) === "localhost:8789");
check("nothing is loaded from a site that hasn't been approved", !(await ann.$(".requests img")));
check("…and Zoe's row says someone's asking", (await fbRow("Zoe Quinn")) === "Asking to be friends");
await ann.screenshot({ path: `${OUT}/friends-request.png`, fullPage: true });
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/decline"]')]);
check("Decline forgets the request on both sites", sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0
  && sql(stateC, "SELECT COUNT(*) AS n FROM connections")[0].n === 0 && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

const caraInvite = await invite("Cara Example");
await connectFrom(cara, C, caraInvite.link);
await ann.goto(`${A}/friend`);
check("Cara's request names her invite", (await ann.$eval(".requests", (r) => r.innerText)).includes("Used the invite you made for Cara Example"));
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("approving links her to her Facebook self", (await fbRow("Cara Example")) === "On afterwrd"
  && (await ann.$eval("main", (m) => m.innerText)).includes("On Facebook as Cara Example"));
await cara.goto(`${C}/`);
check("Cara's Home now has Ann's post", (await feedCards(cara)).some((c) => c.who === "Ann Example"));
await ann.screenshot({ path: `${OUT}/friends-invited.png`, fullPage: true });

// Ann has Home open when Cara posts: Cara's site sends a note, and Ann's page offers it without moving anything.
await ann.goto(`${A}/`);
await compose(cara, C, "Cara's first post");
check("Cara's site tells Ann about the post", await waitFor(() => sql(stateA, "SELECT COUNT(*) AS n FROM inbox WHERE kind = 'post'")[0].n === 1));
check("…but nothing on Ann's page has moved yet", !(await ann.$(".live-bar")) && !(await feedCards(ann)).some((c) => c.text === "Cara's first post"));
await ann.evaluate(() => window.afterwrdLive.check());
check("Ann's open Home quietly offers it", (await ann.$eval(".live-bar span", (s) => s.textContent).catch(() => "")) === "1 new post from friends");
await ann.screenshot({ path: `${OUT}/live-bar.png` });
await Promise.all([ann.waitForNavigation(), ann.click(".live-bar button")]);
check("Show brings it in", (await feedCards(ann)).some((c) => c.who === "Cara Example" && c.text === "Cara's first post"));
check("…and friends' new posts don't count as notifications", !(await ann.$('header.site a[href="/activity"] .count')));

// More friends than one page may ask: 45 more connections, to sites that don't exist, ahead of Cara in line.
sql(stateA, `INSERT INTO connections (id, origin, name, their_key, key_hash, created_at, connected_at, approved_at) VALUES
  ${Array.from({ length: 45 }, (_, i) => `(${-(i + 1)}, 'https://friend${i + 1}.invalid', 'Made-up friend ${i + 1}', '${"k".repeat(43)}',
  'hash-${i + 1}', strftime('%s','now'), strftime('%s','now'), strftime('%s','now'))`).join(",")}`);
const caraPostsBefore = sql(stateC, "SELECT COUNT(*) AS n FROM inbox WHERE kind = 'post'")[0].n;
await compose(ann, A, "Ann to all 46 friends");
check("a post reaches a friend 46th in line (the outbox sends in batches)",
  await waitFor(() => sql(stateC, "SELECT COUNT(*) AS n FROM inbox WHERE kind = 'post'")[0].n === caraPostsBefore + 1, 20_000));
await ann.goto(`${A}/`);
check("Home asks at most 40 sites, Cara first as she's posted lately",
  sql(stateA, "SELECT COUNT(*) AS n FROM connections WHERE feed_checked_at IS NOT NULL")[0].n <= 40
  && (await feedCards(ann)).some((c) => c.who === "Cara Example"));
const notices = await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent));
const reachNotices = notices.filter((n) => /Couldn't (reach|load)/.test(n));
check("sites that can't be reached are summed up in one line", reachNotices.length === 1 && /Couldn't reach 39 friends' sites/.test(reachNotices[0]), notices.join(" | "));
const checkNotice = await ann.$eval("form.checked-notice", (f) => f.textContent.replace(/\s+/g, " ")).catch(() => "");
check("a site nobody has checked suggests getting it checked", checkNotice.startsWith("Your site hasn't been checked yet") && checkNotice.includes("check it yourself"), checkNotice);
await Promise.all([ann.waitForNavigation(), ann.click("form.checked-notice button.link")]);
check("…until the owner says they've checked it themselves", new URL(ann.url()).pathname === "/" && (await ann.$("form.checked-notice")) === null
  && sql(stateA, "SELECT COUNT(*) AS n FROM checked WHERE connection_id IS NULL")[0].n === 1);
check("the friends column shows a dozen, then a link to the rest", (await ann.$$(".mini-friends li")).length === 12
  && (await ann.$eval('aside.side a[href="/friend"]', (a) => a.textContent).catch(() => "")) === "All 46 friends");
sql(stateA, "DELETE FROM connections WHERE id < 0");

// Friends whose sites stop answering. Gail's hasn't for two days (and was asked just now); Ned's only just stopped.
sql(stateA, `INSERT INTO connections (id, origin, name, their_key, key_hash, created_at, connected_at, approved_at, reached_at,
  missing_since, feed_checked_at) VALUES
  (9001, 'https://gail.invalid', 'Gone Gail', '${"k".repeat(43)}', 'hash-gail', 1700000000, 1700000000, 1700000000, 1760000000,
    strftime('%s','now') - 172800, strftime('%s','now')),
  (9002, 'https://ned.invalid', 'New Ned', '${"k".repeat(43)}', 'hash-ned', 1700000000, 1700000000, 1700000000, NULL, NULL, NULL)`);
const gailAsked = sql(stateA, "SELECT feed_checked_at AS t FROM connections WHERE id = 9001")[0].t;
await ann.goto(`${A}/`);
const homeNotices = (await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent))).join(" | ");
check("Home mentions a friend's site that's just stopped answering", homeNotices.includes("Couldn't load New Ned's posts"), homeNotices);
check("…but not one that's been quiet for a day", !homeNotices.includes("Gail"), homeNotices);
check("…which is asked at most once an hour", sql(stateA, "SELECT feed_checked_at AS t FROM connections WHERE id = 9001")[0].t === gailAsked);
check("Ned's site is noted as not answering", sql(stateA, "SELECT missing_since FROM connections WHERE id = 9002")[0].missing_since > 0);
await ann.goto(`${A}/friend`);
const gailCard = await ann.$$eval(".friend-list li", (l) => l.find((li) => li.textContent.includes("Gone Gail"))?.querySelector(".silent")?.textContent ?? "");
check("Friends says Gail's site has gone quiet, and since when", /hasn't answered since/.test(gailCard) && gailCard.includes("2025"), gailCard);
check("…with Remove friend beside it, and nothing like it for Cara",
  (await ann.$$eval(".friend-list li", (l) => l.filter((li) => li.querySelector(".silent button")).length)) === 1);
await ann.screenshot({ path: `${OUT}/friends-quiet.png`, fullPage: true });
await Promise.all([ann.waitForNavigation(), ann.$$eval(".friend-list li", (l) => l.find((li) => li.textContent.includes("Gone Gail")).querySelector(".silent button").click())]);
check("Remove friend forgets Gail, back on Friends", new URL(ann.url()).pathname === "/friend"
  && sql(stateA, "SELECT COUNT(*) AS n FROM connections WHERE id = 9001")[0].n === 0);
sql(stateA, "DELETE FROM connections WHERE id >= 9000");

// Cara removed Ann while Ann's site couldn't be told: Cara's site now says Ann's isn't connected.
const caraId = sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id;
sql(stateC, "DELETE FROM connections");
await ann.goto(`${A}/`);
check("Home says nothing about a friend who's removed you",
  !(await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent).join(" "))).includes("Cara"));
check("…and remembers their site said no", sql(stateA, `SELECT said_no FROM connections WHERE id = ${caraId}`)[0].said_no === 1);
await ann.goto(`${A}/friend/${caraId}/posts`);
const caraNotice = await ann.$eval("p.notice", (p) => p.textContent).catch(() => "");
check("her page says she may have removed you", caraNotice.includes("Cara Example may have removed you as a friend"), caraNotice);
await ann.screenshot({ path: `${OUT}/friend-removed-you.png` });
await Promise.all([ann.waitForNavigation(), ann.click("main form.inline button")]);
check("Remove friend on her page forgets her", new URL(ann.url()).pathname === "/friend"
  && sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0 && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
