// Two afterwrd sites on this computer (A on 8787, B on 8788), each with its own owner: connect them with a
// Connect link, see each other's new posts in Feed, comment across sites, delete, and disconnect.
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
await ann.goto(`${A}/feed`);
check("Feed is in the owner's menu, first", (await ann.$$eval("header.site nav a", (l) => l.map((a) => a.querySelector("span").textContent)))[0] === "Feed");
check("empty Feed explains connecting", (await ann.$eval("main", (m) => m.textContent)).includes("Connect with friends"));

// Ann makes a Connect link; Bob opens it, gives his site, and confirms there.
await ann.goto(`${A}/_admin/connections`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
check("Connect link made", /^http:\/\/localhost:8787\/_connect\/[\w-]{40,}$/.test(link), link.slice(0, 50) + "…");

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(link);
check("link opens a page naming Ann, without signing in", (await stranger.$eval("h1", (h) => h.textContent)) === "Connect with Ann Example");
await bob.goto(link);
await bob.type("#site input", B);
await Promise.all([bob.waitForNavigation(), bob.click("#site button")]);
check("Bob is sent to his own site to confirm", bob.url().startsWith(`${B}/_admin/connections/new?link=`)
  && (await bob.$eval("h1", (h) => h.textContent)) === "Connect with Ann Example?");
await Promise.all([bob.waitForNavigation({ timeout: 30_000 }), bob.click("#go")]);
check("confirming connects and opens Bob's Feed", new URL(bob.url()).pathname === "/feed", bob.url());

// Each sees the other's new posts, and only those.
let bobFeed = await feedCards(bob);
check("Bob's Feed has Ann's post, and only her afterwrd post", bobFeed.length === 1 && bobFeed[0].who === "Ann Example"
  && bobFeed[0].text === "Ann's news from site A", JSON.stringify(bobFeed));
await ann.goto(`${A}/feed`);
let annFeed = await feedCards(ann);
check("Ann's Feed has Bob's post with its photo", annFeed.length === 1 && annFeed[0].who === "Bob Example" && annFeed[0].photos === 1, JSON.stringify(annFeed));
await ann.waitForFunction(() => document.querySelector("article.from-friend .collage img")?.complete, { timeout: 15_000 });
check("the photo loads straight from Bob's site, by a signed link", await ann.$eval("article.from-friend .collage img", (i, b) => i.naturalWidth > 0
  && i.getAttribute("src").startsWith(`${b}/files/`) && i.getAttribute("src").includes("&sig="), B));
await ann.goto(`${A}/_admin/connections`);
check("Ann's Connections lists Bob", (await ann.$eval("table.numbers tbody", (t) => t.textContent)).includes("Bob Example"));

// Ann comments on Bob's post from her Feed; it's stored on Bob's site.
await ann.goto(`${A}/feed`);
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
await ann.goto(`${A}/feed`);
annFeed = await feedCards(ann);
check("Ann sees Bob's reply, not deletable by her", annFeed[0].comments.map((c) => c.text).join("|") === "Looks great, Bob!|Thanks Ann"
  && !annFeed[0].comments[1].canDelete);

// Comments from Bob's visitors (and other friends) stay on Bob's site.
sql(stateB, `INSERT INTO site_comments (target, author_id, author_name, text, created_at, origin)
  SELECT target, NULL, 'Bob''s visitor', 'For Bob''s eyes', strftime('%s','now'), 'site' FROM site_comments LIMIT 1`);
await ann.goto(`${A}/feed`);
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
check("wrong key, no feed", (await peer("/_peer/feed", "x".repeat(43))).status === 401);
const bobsImportedPost = sql(stateB, "SELECT timestamp FROM posts WHERE id < 1000000000 LIMIT 1")[0];
check("can't comment on an imported post", (await peer("/_peer/comments", keyForB, { type: "Note", inReplyTo: `${B}/posts/post-${bobsImportedPost.timestamp}-00000000`, content: "x" })).status === 404);
const bobsComment = sql(stateB, "SELECT id FROM site_comments WHERE origin = 'site' LIMIT 1")[0].id;
await peer(`/_peer/comments/${bobsComment}/delete`, keyForB, {});
check("can't delete Bob's own comments", sql(stateB, `SELECT COUNT(*) AS n FROM site_comments WHERE id = ${bobsComment}`)[0].n === 1);
check("a used Connect link is refused", (await (await browser.createBrowserContext()).newPage().then(async (p) => (await p.goto(link)).status())) === 404);
check("Feed actions need the owner's session", (await fetch(`${A}/_feed/comments`, { method: "POST", redirect: "manual", headers: { Origin: A } })).status === 401);
check("another site can't post Ann's comments", (await fetch(`${A}/_feed/comments`, { method: "POST", redirect: "manual",
  headers: { Origin: "https://evil.example", Cookie: `__Host-hb_session=${(await ann.cookies()).find((c) => c.name === "__Host-hb_session").value}` } })).status === 403);

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
await ann.goto(`${A}/feed`);
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend header .what a")]);
check("Bob's name in Feed opens his page on Ann's site", ann.url() === `${A}/friend/${bobId}/posts`, ann.url());
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
const annMenu = await ann.$$eval("header.site nav a", (l) => l.map((a) => a.querySelector("span").textContent));
check("the owner has one Friends in the menu", annMenu.filter((l) => l === "Friends").length === 1, annMenu.join());
await Promise.all([ann.waitForNavigation(), ann.click('header.site nav a[href="/friend"]')]);
const friendsText = () => ann.$eval("main", (m) => m.innerText);
check("Friends lists Bob on afterwrd, and suggests his Facebook self", (await friendsText()).includes("Is this Bob Example from your Facebook download?"));
const fbRow = (name) => ann.$$eval("#fb-people tbody tr", (rows, n) => rows.find((r) => r.cells[0].textContent === n)?.cells[2].textContent.trim(), name);
check("…and everyone from Facebook below, not on afterwrd yet", (await fbRow("John Smith")) === "Not on afterwrd" && (await fbRow("Bob Example")) === "Not on afterwrd");
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
await ann.goto(`${A}/feed`);
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
  headers: { Cookie: `__Host-hb_session=${(await bob.cookies()).find((c) => c.name === "__Host-hb_session").value}` } })).headers.get("location") ?? "").match(/\/photos\/\d+$/));
const everything = annZip.list.filter((f) => f.endsWith(".json")).map((f) => annZip.read(f.split("/").pop()).toString()).join("");
const annKeys = sql(stateA, "SELECT their_key, key_hash FROM connections")[0];
check("no keys in the download", !everything.includes(annKeys.their_key) && !everything.includes(annKeys.key_hash) && !everything.includes("key_hash"));
check("Ann's connections list Bob by address", annZip.json("connections.json").orderedItems[0]?.id === `${B}/`);

// Phone view of the Feed, then disconnect.
await ann.setViewport({ width: 375, height: 800, isMobile: true });
await ann.goto(`${A}/feed`);
check("no sideways scrolling on a phone", await ann.evaluate(() => document.documentElement.scrollWidth <= 375));
await ann.screenshot({ path: `${OUT}/feed-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 900 });
await ann.goto(`${A}/_admin/connections`);
await ann.screenshot({ path: `${OUT}/connections.png` });
await Promise.all([ann.waitForNavigation(), ann.click("button[data-disconnect]")]);
check("disconnecting removes it on both sites", sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0
  && sql(stateB, "SELECT COUNT(*) AS n FROM connections")[0].n === 0);
check("the old key stops working", (await peer("/_peer/feed", keyForB)).status === 401);
check("Ann keeps her copies of what she said after disconnecting", sql(stateA, "SELECT site FROM comments_elsewhere").some((c) => c.site === B));
check("disconnecting forgets who they were on Facebook", sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
