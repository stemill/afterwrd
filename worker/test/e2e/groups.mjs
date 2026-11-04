// Groups: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's own Worker (G, 8790, in group
// mode). Ann claims the group (making the Worker in Cloudflare can't happen locally, so the test starts it), invites
// Bob and Cat with a link, lets them in and makes Bob an admin. They read it from their own sites, post (photos are
// copied to the group) and comment; comments reach only those who wrote or commented on the post; the group can't put
// words in a member's mouth; keys open nothing else; the group's Worker serves nothing else; then renaming, moderating,
// leaving, removing, and deleting the group.
//   node groups.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, fixtures, stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const sql = (state, q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local",
  "--persist-to", state, "--json", "--command", q], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const n = (state, q) => sql(state, `SELECT COUNT(*) AS n FROM ${q}`)[0].n;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 400))) if (await test()) return true;
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
const text = (page, selector = "main") => page.$eval(selector, (m) => m.innerText).catch(() => "");
const cards = (page) => page.$$eval("article.in-group", (l) => l.map((a) => ({
  id: a.id, who: a.querySelector("header strong").textContent, text: a.querySelector(".text")?.textContent ?? "",
  photos: a.querySelectorAll(".collage img").length, canDelete: Boolean(a.querySelector("header .delete")),
  comments: [...a.querySelectorAll(".comment")].map((c) => ({ name: c.querySelector("strong").textContent,
    text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under button")) })),
})));
async function postInGroup(page, words, files = []) {
  await page.type("#composer textarea", words);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
async function comment(page, card, words) {
  await page.type(`#${card} form.say textarea`, words);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click(`#${card} form.say button`)]);
}
async function join(page, site, link) {
  await page.goto(link);
  await page.type("#site input", site);
  await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  const asked = (await page.$eval("h1", (h) => h.textContent).catch(() => "")) === "Join Book club?";
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
  return asked;
}
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");

// The group's Worker serves its members' sites and nothing else; people's sites don't serve groups.
check("a group's Worker has no pages, sign-in or friends", (await fetch(`${G}/`)).status === 404
  && (await fetch(`${G}/_auth/setup?code=${CODE}`)).status === 404 && (await call(G, "/_peer/feed", "x".repeat(43))).status === 404);
check("…and says it's a group", (await (await fetch(`${G}/`)).text()).includes("This is an afterwrd group"));
check("a person's site doesn't answer as a group", (await call(A, "/_group/ping")).status !== 200);

// Ann starts the group. (Locally, her site claims a group Worker that's already running.)
await ann.goto(`${A}/groups`);
check("Groups is in the main menu", (await ann.$$eval("header.site nav.main a span", (l) => l.map((s) => s.textContent))).includes("Groups"));
check("no groups yet", (await text(ann)).includes("You're not in any groups yet"));
await ann.goto(`${A}/groups/new`);
check("starting a group explains it's its own site", (await text(ann)).includes("its own small site in your Cloudflare account"));
check("wrong key can't claim the group", (await call(G, "/_group/claim", null, { setup: "nope", origin: A, key: "k".repeat(43), name: "x" })).status === 403);
const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Book club", about: "One book a month" });
const claimed = await post(ann, "/_groups/create/claim", { id: waiting.id });
check("Ann's site claims the group", claimed.status === 200 && n(stateG, "group_members WHERE role = 'owner' AND origin = 'http://localhost:8787'") === 1, JSON.stringify(claimed));
check("…only once", (await call(G, "/_group/claim", null, { setup: GROUP_KEY, origin: C, key: "k".repeat(43), name: "Mine now" })).status === 409);
const annGroup = claimed.id;
await ann.goto(`${A}/groups/${annGroup}/members`);
check("the group's page names it and its site", (await ann.$eval("h1", (h) => h.textContent)) === "Book club" && (await text(ann)).includes("Your group, at localhost:8790"));
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
check("invite link made, on the group's site", /^http:\/\/localhost:8790\/_join\/[\w-]{40,}$/.test(link), link.slice(0, 40));

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(link);
check("the link opens a page naming the group, without signing in", (await stranger.$eval("h1", (h) => h.textContent)) === "Join Book club");

// Bob and Cat ask to join, from their own sites.
check("Bob is sent to his site to confirm", await join(bob, B, link));
check("Bob waits to be let in", (await text(bob)).includes("Waiting for Ann Example to let you in"), await text(bob));
const bobKey = sql(stateB, "SELECT their_key FROM groups")[0]?.their_key;
check("Bob's key can't read the group yet", (await call(G, "/_group/posts", bobKey)).status === 403);
check("…nor anything on Ann's site", (await call(A, "/_peer/feed", bobKey)).status === 401 && (await call(A, "/_group/posts", bobKey)).status !== 200);
check("Cat asks too", await join(cat, C, link));
const catKey = sql(stateC, "SELECT their_key FROM groups")[0]?.their_key;

await ann.goto(`${A}/groups/${annGroup}`);
check("Ann's group shows 2 asking to join", (await ann.$eval(".tabs .count", (c) => c.firstChild.textContent).catch(() => "")) === "2");
await ann.goto(`${A}/groups/${annGroup}/members`);
check("Members lists both asking to join", (await text(ann, ".requests")).includes("Bob Example") && (await text(ann, ".requests")).includes("localhost:8789"));
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("Ann lets them both in", !(await ann.$(".requests")) && n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const bobMember = sql(stateG, `SELECT id FROM group_members WHERE origin = '${B}'`)[0].id;
await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${bobMember}/admin"]`)]);
check("Ann makes Bob an admin", sql(stateG, `SELECT role FROM group_members WHERE id = ${bobMember}`)[0].role === "admin");
check("Cat can't run the group", (await call(G, "/_group/admin/link", catKey, {})).status === 403);
const linkRow = sql(stateG, "SELECT requests FROM group_links")[0];
check("each request counts against the invite link", linkRow?.requests === 2);
sql(stateG, "UPDATE group_links SET requests = 100");
check("a link that's been used too often stops working", (await fetch(link)).status === 404);
sql(stateG, "UPDATE group_links SET requests = 2");

// Posting: everyone from their own site; Bob's photo is copied to the group's Worker.
await ann.goto(`${A}/groups/${annGroup}`);
await postInGroup(ann, "Welcome, everyone");
let annCards = await cards(ann);
check("Ann's post shows as hers", annCards.length === 1 && annCards[0].who === "You", JSON.stringify(annCards));
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
await bob.goto(`${B}/groups/${bobGroup}`);
let bobCards = await cards(bob);
check("Bob reads the group from his site", bobCards.length === 1 && bobCards[0].who === "Ann Example" && bobCards[0].text === "Welcome, everyone", JSON.stringify(bobCards));
check("…with its name and members", (await text(bob)).includes("Book club") && (await text(bob)).includes("3 members"));
await postInGroup(bob, "Started the first book", [`${fixtures}/photo1.jpg`]);
const photo = sql(stateG, "SELECT hash, thumb_hash FROM group_photos")[0];
check("Bob's photo is kept on the group's Worker", Boolean(photo));
check("…and not left behind on his site", (await bob.evaluate((h) => fetch(`/files/${h}`, { cache: "no-store" }).then((r) => r.status), photo?.hash)) === 404);
bobCards = await cards(bob);
check("Bob's post shows as his, with the photo", bobCards[0]?.who === "You" && bobCards[0].photos === 1 && bobCards[0].canDelete, JSON.stringify(bobCards[0]));
check("Bob, an admin, isn't offered deleting Ann's post", bobCards[1]?.who === "Ann Example" && !bobCards[1].canDelete);
await bob.waitForFunction(() => document.querySelector("article.in-group .collage img")?.complete, { timeout: 15_000 });
check("the photo loads from the group's Worker", await bob.$eval("article.in-group .collage img", (i) => i.naturalWidth > 0 && i.src.startsWith("http://localhost:8790/files/")));
await bob.screenshot({ path: `${OUT}/group-desktop.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.screenshot({ path: `${OUT}/group-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });
const bobPost = sql(stateG, `SELECT id FROM group_posts WHERE origin = '${B}'`)[0].id;
const annPost = sql(stateG, `SELECT id FROM group_posts WHERE origin = '${A}'`)[0].id;

// Comments go only to those who wrote or commented on the post.
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;
await cat.goto(`${C}/groups/${catGroup}`);
check("Cat sees both posts, and can only delete her own", (await cards(cat)).length === 2 && (await cards(cat)).every((c) => !c.canDelete));
await comment(cat, `gp${bobPost}`, "Which book?");
check("Bob is told about Cat's comment on his post", await waitFor(() => n(stateB, "group_inbox") === 1));
check("Ann isn't: it's not her post and she hasn't commented", n(stateA, "group_inbox") === 0);
await ann.goto(`${A}/groups/${annGroup}`);
await comment(ann, `gp${bobPost}`, "The one we picked!");
check("Bob and Cat are told about Ann's comment", await waitFor(() => n(stateB, "group_inbox") === 2 && n(stateC, "group_inbox") === 1));
await bob.goto(`${B}/groups/${bobGroup}`);
await comment(bob, `gp${bobPost}`, "Ah, of course");
check("Ann and Cat are told about Bob's", await waitFor(() => n(stateA, "group_inbox") === 1 && n(stateC, "group_inbox") === 2));
await ann.goto(`${A}/activity`);
check("Ann's Notifications show it", (await text(ann)).includes("Bob Example also commented on a post in Book club"), (await text(ann)).slice(0, 300));
await bob.goto(`${B}/activity`);
const bobNews = await text(bob);
check("Bob's say who commented on his post, and where", bobNews.includes("Cat Example commented on your post in Book club")
  && bobNews.includes("Ann Example commented on your post"), bobNews.slice(0, 300));
await bob.click(`a[href="/groups/${bobGroup}/posts/${bobPost}"]`);
await bob.waitForSelector("article.in-group");
check("…and link to the post's own page, with its comments", (await cards(bob))[0]?.comments.length === 3);

// Live: Bob has his group open; Cat comments on his post; a quiet bar offers it.
await bob.goto(`${B}/groups/${bobGroup}`);
await new Promise((r) => setTimeout(r, 1100));
await cat.goto(`${C}/groups/${catGroup}`);
await comment(cat, `gp${bobPost}`, "Lovely photo");
check("Bob's open page offers the new comment", await waitFor(async () => {
  await bob.evaluate(() => window.afterwrdLive.check());
  return (await text(bob, ".live-bar")).includes("1 new comment");
}));

// The group can't put words in a member's mouth, or speak for them.
sql(stateG, "UPDATE group_comments SET text = 'forged words' WHERE text = 'Ah, of course'");
sql(stateG, `INSERT INTO group_comments (post_id, origin, author_name, text, created_at) VALUES (${annPost}, '${B}', 'Bob Example', 'never said this', strftime('%s','now'))`);
await bob.goto(`${B}/groups/${bobGroup}`);
const seen = JSON.stringify(await cards(bob));
check("Bob sees his own words, not the group's version", seen.includes("Ah, of course") && !seen.includes("forged words"));
check("a comment Bob never sent isn't shown as his", !seen.includes("never said this"));
sql(stateG, `UPDATE group_comments SET post_id = ${annPost} WHERE text = 'forged words'`);
await bob.goto(`${B}/groups/${bobGroup}`);
check("…nor one of his moved under another post", !JSON.stringify((await cards(bob)).find((c) => c.id === `gp${annPost}`)).includes("Ah, of course"));
sql(stateG, `UPDATE group_comments SET post_id = ${bobPost} WHERE text = 'forged words'`);
// A long thread: a page of posts carries the newest comments, and links to the rest.
const values = Array.from({ length: 25 }, (_, i) => `(${annPost}, '${B}', 'Bob Example', 'filler ${i}', strftime('%s','now'))`).join(",");
sql(stateG, `INSERT INTO group_comments (post_id, origin, author_name, text, created_at) VALUES ${values}`);
await cat.goto(`${C}/groups/${catGroup}`);
const long = (await cards(cat)).find((c) => c.id === `gp${annPost}`);
check("a long thread shows its newest 20, with a link to all", long?.comments.length === 20 && (await text(cat)).includes("See all 26 comments"), `${long?.comments.length} ${(await text(cat)).slice(0, 400)}`);
await cat.goto(`${C}/groups/${catGroup}/posts/${annPost}`);
check("…which are on the post's own page", (await cards(cat))[0]?.comments.length === 26);
sql(stateG, "DELETE FROM group_comments WHERE text LIKE 'filler %'");

// Keys open only what they're for.
check("a made-up key gets nothing", (await call(G, "/_group/posts", "x".repeat(43))).status === 401);
check("Cat can't delete Bob's post", (await call(G, `/_group/posts/${bobPost}/delete`, catKey, {})).status === 404 && n(stateG, `group_posts WHERE id = ${bobPost}`) === 1);
const claimedPhoto = await call(G, "/_group/posts", catKey, { type: "Note", content: "Bob's photo, claimed",
  attachment: [{ type: "Image", url: `${B}/files/${photo.hash}`, "afterwrd:fetch": `${B}/files/${photo.hash}?exp=9999999999&sig=${"x".repeat(43)}`,
    width: 10, height: 10, "afterwrd:size": 100, preview: { url: `${B}/files/${photo.thumb_hash}`, "afterwrd:fetch": `${B}/files/${photo.thumb_hash}?exp=9999999999&sig=${"x".repeat(43)}` } }] });
check("a member can't post files from someone else's site", claimedPhoto.status === 400);
const fake = (h, size = 100) => ({ type: "Image", url: `${C}/files/${h}`, "afterwrd:fetch": `${C}/files/${h}?exp=9999999999&sig=${"x".repeat(43)}`,
  width: 10, height: 10, "afterwrd:size": size, preview: { url: `${C}/files/${"b".repeat(64)}`, "afterwrd:fetch": `${C}/files/${"b".repeat(64)}?exp=9999999999&sig=${"x".repeat(43)}` } });
check("a photo too big for a group is refused before anything's fetched", (await call(G, "/_group/posts", catKey, { type: "Note", content: "big", attachment: [fake("a".repeat(64), 9_000_000)] })).status === 400);
const postsBefore = n(stateG, "group_posts");
const failed = await call(G, "/_group/posts", catKey, { type: "Note", content: "photo that won't arrive", attachment: [fake("a".repeat(64))] });
check("a post whose photos can't be copied isn't kept, nor its photos", failed.status === 400 && n(stateG, "group_posts") === postsBefore
  && n(stateG, `group_photos WHERE hash = '${"a".repeat(64)}'`) === 0);
const bobAdminKey = sql(stateB, "SELECT their_key FROM groups")[0].their_key;
check("Bob, an admin, can't delete Ann's post (she owns the group)", (await call(G, `/_group/posts/${annPost}/delete`, bobAdminKey, {})).status === 404);
const groupKeyForBob = sql(stateG, `SELECT their_key FROM group_members WHERE origin = '${B}'`)[0].their_key;
const noted = n(stateB, "group_inbox");
await call(B, "/_member/notify", groupKeyForBob, { type: "Create", object: { type: "Note", inReplyTo: `${G}/groups/1/posts/${annPost}`, content: "psst", attributedTo: { name: "x" } } });
check("the group can't send notes about posts Bob isn't part of", n(stateB, "group_inbox") === noted);
check("…nor read anything of Bob's", (await call(B, "/_peer/feed", groupKeyForBob)).status === 401);
check("…nor pretend to be mid-join", (await call(B, `/_member/hello?from=${encodeURIComponent(G)}&group=1`, groupKeyForBob)).status === 401);
check("group actions need the owner's session", (await fetch(`${A}/_groups/${annGroup}/delete`, { method: "POST", redirect: "manual", headers: { Origin: A } })).status === 401);
const exported = await ann.evaluate(() => fetch("/_admin/export/rows?table=groups").then((r) => r.text()));
check("Download everything carries no group keys", !exported.includes("key") && exported.includes("Book club"));

// Bob, an admin, sees the controls a member would; deleting; renaming.
await bob.goto(`${B}/groups/${bobGroup}/members`);
const bobControls = await bob.$$eval(".member-list button", (l) => l.map((b) => b.textContent));
check("Bob, an admin, can remove Cat but not Ann, nor make admins", bobControls.join() === "Remove", bobControls.join());
await bob.goto(`${B}/groups/${bobGroup}/posts/${bobPost}`);
const before = n(stateG, "group_comments");
await Promise.all([bob.waitForNavigation(), bob.click("article.in-group .comment:nth-of-type(3) .under button")]);
check("Bob deletes his own comment", n(stateG, "group_comments") === before - 1);
await ann.goto(`${A}/groups/${annGroup}`);
annCards = await cards(ann);
check("Ann, its owner, can delete anything in the group", annCards.every((c) => c.canDelete && c.comments.every((x) => x.canDelete)));
await Promise.all([ann.waitForNavigation(), ann.click(`#gp${bobPost} .comment .under button`)]);
check("…and does: Cat's first comment", !sql(stateG, "SELECT text FROM group_comments").some((c) => c.text === "Which book?"));
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.$eval('form[action$="/about"] input[name=name]', (i) => { i.value = "Book club (2026)"; });
await Promise.all([ann.waitForNavigation(), ann.click('form[action$="/about"] button')]);
await cat.goto(`${C}/groups/${catGroup}`);
check("renaming reaches members' sites", (await cat.$eval("h1", (h) => h.textContent)) === "Book club (2026)");

// Leaving and removing.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${bobMember}/member"]`)]);
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("Ann takes Bob's admin role back", (await bob.$$eval(".member-list button", (l) => l.length)) === 0);
await Promise.all([bob.waitForNavigation(), bob.click('form[action$="/leave"] button')]);
check("Bob leaves", n(stateB, "groups") === 0 && n(stateG, `group_members WHERE origin = '${B}'`) === 0);
check("…keeping his own copy of his post", sql(stateB, "SELECT kind FROM group_mine").map((r) => r.kind).join() === "post");
check("…which stays in the group", n(stateG, `group_posts WHERE id = ${bobPost}`) === 1);
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('button[formaction$="/remove"]')]);
check("Ann removes Cat, and Cat's site forgets the group", n(stateC, "groups") === 0);
check("Cat's key no longer works", (await call(G, "/_group/posts", catKey)).status === 401);
check("the owner can't just leave", (await ann.evaluate((p) => fetch(p, { method: "POST" }).then((r) => r.status), `/_groups/${annGroup}/leave`)) === 400);

// Deleting the group empties it, and Ann's site forgets it.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click("#delete-go")]);
check("deleting the group empties its Worker", n(stateG, "groups") + n(stateG, "group_posts") + n(stateG, "group_photos") + n(stateG, "group_members") === 0);
check("…and Ann's site forgets it", n(stateA, "groups") === 0 && new URL(ann.url()).pathname === "/groups");
check("the invite link stops working", (await fetch(link)).status === 404);

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
