// Groups: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's own Worker (G, 8790, in group
// mode). Ann claims the group (making the Worker in Cloudflare can't happen locally, so the test starts it), invites
// Bob and Cat with a link, lets them in and makes Bob an admin. They read it from their own sites, post (photos are
// copied to the group) and comment; comments reach only those who wrote or commented on the post; the group can't put
// words in a member's mouth; keys open nothing else; the group's Worker serves nothing else; then renaming, moderating,
// events (adding one, answering, changing it, calling it off: only those going hear, and only of changes), leaving,
// removing, and deleting the group.
//   node groups.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled } from "./helpers.mjs";
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
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
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
    text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under .delete")) })),
})));
async function postInGroup(page, words, files = []) {
  await page.type("#composer textarea", words);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
let inPlaceChecked = false;
async function comment(page, card, words) {
  await page.type(`#${card} form.say textarea`, words);
  await page.evaluate(() => { window.samePage = true; });
  await Promise.all([settled(page, { timeout: 30_000 }), page.click(`#${card} form.say button`)]);
  if (!inPlaceChecked) {
    inPlaceChecked = true;
    check("a comment in a group is sent without a new page", await page.evaluate((id) => window.samePage === true
      && [...document.querySelectorAll(`#${id} .comment .said`)].some((s) => s.textContent.length > 0), card));
  }
}
// Joining the way the page suggests (pasting the link into Groups on your own site), or by opening the link and
// typing your site's address.
async function join(page, site, link, { typed = false } = {}) {
  if (typed) {
    await page.goto(link);
    page.joinPage = await page.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
    page.joinFolded = await page.$eval("#site", (f) => !f.closest("details").open);
    await page.$eval("#site", (f) => { f.closest("details").open = true; });
    await page.type("#site input", site);
    await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  } else {
    await page.goto(`${site}/groups`);
    page.joinBoxFirst = await page.$eval("main form", (f) => f.id === "join");
    await page.type("#join input[name=link]", link);
    await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
  }
  const asked = (await page.$eval("h1", (h) => h.textContent).catch(() => "")) === "Join Book club?";
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
  return asked;
}
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
async function addEvent(page, fields) {
  await page.$eval("details.add-event", (d) => { d.open = true; });
  await page.$eval("form.event-form", (f, v) => { for (const [k, x] of Object.entries(v)) f.elements[k].value = x; }, fields);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("form.event-form button.primary")]);
}
async function answer(page, card, value) {
  await Promise.all([settled(page, { timeout: 30_000 }), page.click(`#${card} .answers button[value=${value}]`)]);
}
const pressed = (page, card) => page.$eval(`#${card} .answers [aria-pressed=true]`, (b) => b.value).catch(() => null);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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
check("Bob pastes the link into Groups on his own site (the box comes first there), and is asked to confirm", await join(bob, B, link) && bob.joinBoxFirst);
check("Bob waits to be let in", (await text(bob)).includes("Waiting for Ann Example to let you in"), await text(bob));
const bobKey = sql(stateB, "SELECT their_key FROM groups")[0]?.their_key;
check("Bob's key can't read the group yet", (await call(G, "/_group/posts", bobKey)).status === 403);
check("…nor anything on Ann's site", (await call(A, "/_peer/feed", bobKey)).status === 401 && (await call(A, "/_group/posts", bobKey)).status !== 200);
check("Cat opens the link instead: it says to paste it into Groups on her site, with the address box folded away, which still works",
  await join(cat, C, link, { typed: true }) && cat.joinPage.includes("paste it into Groups") && cat.joinFolded);
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
await postInGroup(bob, "Started the first book", [`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`]);
const photo = sql(stateG, "SELECT hash, thumb_hash FROM group_photos")[0];
check("Bob's photo is kept on the group's Worker", Boolean(photo));
check("…and not left behind on his site", (await bob.evaluate((h) => fetch(`/files/${h}`, { cache: "no-store" }).then((r) => r.status), photo?.hash)) === 404);
bobCards = await cards(bob);
check("Bob's post shows as his, with the photos", bobCards[0]?.who === "You" && bobCards[0].photos === 2 && bobCards[0].canDelete, JSON.stringify(bobCards[0]));
check("Bob, an admin, isn't offered deleting Ann's post", bobCards[1]?.who === "Ann Example" && !bobCards[1].canDelete);
await bob.waitForFunction(() => document.querySelector("article.in-group .collage img")?.complete, { timeout: 15_000 });
check("the photo loads from the group's Worker", await bob.$eval("article.in-group .collage img", (i) => i.naturalWidth > 0 && i.src.startsWith("http://localhost:8790/files/")));
await bob.screenshot({ path: `${OUT}/group-desktop.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.screenshot({ path: `${OUT}/group-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });
const bobPost = sql(stateG, `SELECT id FROM group_posts WHERE origin = '${B}'`)[0].id;
const annPost = sql(stateG, `SELECT id FROM group_posts WHERE origin = '${A}'`)[0].id;
// A photo opened from a group's post is among that post's photos, and ✕ goes back to the post where it was.
await bob.goto(`${B}/groups/${bobGroup}`);
await Promise.all([bob.waitForNavigation(), bob.click(`#gp${bobPost} .collage a.tile:nth-of-type(2)`)]);
const groupInPost = await bob.evaluate(() => ({ counter: document.querySelector(".counter")?.textContent, close: document.getElementById("close").getAttribute("href"),
  prev: document.getElementById("prev")?.getAttribute("href"), next: Boolean(document.getElementById("next")),
  shown: document.querySelector(".stage img")?.naturalWidth > 0, post: document.querySelector(".info article.in-group .text")?.textContent }));
check("a photo opened from a group's post is among that post's photos", groupInPost.counter === "2 / 2" && !groupInPost.next
  && groupInPost.prev?.startsWith(`/groups/${bobGroup}/posts/${bobPost}/photos/`) && groupInPost.prev.includes("?back=")
  && groupInPost.post === "Started the first book", JSON.stringify(groupInPost));
check("…and ✕ goes back to the post where it was", groupInPost.close === `/groups/${bobGroup}#gp${bobPost}`, groupInPost.close);
await Promise.all([bob.waitForNavigation(), bob.click("#prev")]);
check("…and stays with the post going back a photo", (await bob.$eval(".counter", (c) => c.textContent)) === "1 / 2"
  && (await bob.$eval("#close", (a) => a.getAttribute("href"))) === groupInPost.close);
await bob.goto(`${B}${groupInPost.prev.replace(/back=[^&]*/, `back=${encodeURIComponent("//evil.example/")}`)}`);
check("…but never back to another site", (await bob.$eval("#close", (a) => a.getAttribute("href"))) === "/");

// Changing words in a group (edits.js, on the group's Worker): only the writer, for 15 minutes, and until someone else
// comments. The writer's site keeps its own record.
const annKey = sql(stateA, "SELECT their_key FROM groups")[0].their_key;
// `item` is the post or comment; `v` where its V is: "> header" for a post, ".under" for a comment.
const edit = async (page, item, v, words) => {
  await page.click(`${item} ${v} details.more summary`);
  await page.click(`${item} ${v} details.more a[href^="#edit"]`);
  await page.$eval(`${item} div.edit textarea`, (t, w) => { t.value = w; }, words);
  await Promise.all([settled(page), page.click(`${item} div.edit button`)]);
};
await bob.goto(`${B}/groups/${bobGroup}`);
check("Bob's new post offers Edit", Boolean(await bob.$(`#gp${bobPost} > div.edit`)));
await edit(bob, `#gp${bobPost}`, "> header", "Started the first book: The Hobbit");
check("…changed on the group's Worker, keeping what it said before", sql(stateG, `SELECT text, edited_at FROM group_posts WHERE id = ${bobPost}`)
  .some((p) => p.text === "Started the first book: The Hobbit" && p.edited_at)
  && sql(stateG, "SELECT text FROM group_post_versions").map((v) => v.text).join() === "Started the first book");
check("…and in Bob's own copy", sql(stateB, "SELECT text FROM group_mine WHERE kind = 'post'")[0]?.text === "Started the first book: The Hobbit"
  && n(stateB, "group_mine_versions") === 1);
await ann.goto(`${A}/groups/${annGroup}`);
check("Ann sees it Edited, with what it said before", (await ann.$eval(`#gp${bobPost} > details.edited`, (d) => d.textContent).catch(() => ""))
  .includes("Started the first book"));
check("Ann can't change Bob's post", (await call(G, `/_group/posts/${bobPost}/edit`, annKey, { type: "Note", content: "Ann's words" })).status === 404
  && !sql(stateG, "SELECT text FROM group_posts").some((p) => p.text === "Ann's words"));

// Comments go only to those who wrote or commented on the post.
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;
await cat.goto(`${C}/groups/${catGroup}`);
check("Cat sees both posts, and can only delete her own", (await cards(cat)).length === 2 && (await cards(cat)).every((c) => !c.canDelete));
await comment(cat, `gp${bobPost}`, "Which book?");
const catComment = sql(stateG, "SELECT id FROM group_comments WHERE text = 'Which book?'")[0].id;
check("Cat's comment locks Bob's post", (await call(G, `/_group/posts/${bobPost}/edit`, bobKey, { type: "Note", content: "too late" })).status === 403);
await cat.goto(`${C}/groups/${catGroup}`);
await edit(cat, `#g${bobPost}-${catComment}`, ".under", "Which book was it?");
check("Cat changes her comment", sql(stateG, `SELECT text FROM group_comments WHERE id = ${catComment}`)[0]?.text === "Which book was it?"
  && sql(stateC, "SELECT text FROM group_mine WHERE kind = 'comment'")[0]?.text === "Which book was it?");
check("Bob, an admin, still can't change Cat's words", (await call(G, `/_group/comments/${catComment}/edit`, bobKey, { type: "Note", content: "Bob's words" })).status === 404);
check("Bob is told about Cat's comment on his post", await waitFor(() => n(stateB, "group_inbox") === 1));
check("Ann isn't: it's not her post and she hasn't commented", n(stateA, "group_inbox") === 0);
await ann.goto(`${A}/groups/${annGroup}`);
await comment(ann, `gp${bobPost}`, "The one we picked!");
check("Bob and Cat are told about Ann's comment", await waitFor(() => n(stateB, "group_inbox") === 2 && n(stateC, "group_inbox") === 1));
check("Ann's comment after Cat's locks Cat's", (await call(G, `/_group/comments/${catComment}/edit`, catKey, { type: "Note", content: "changed later" })).status === 403);
await cat.goto(`${C}/groups/${catGroup}`);
check("…and Cat's site stops offering Edit, showing it Edited", !(await cat.$(`#g${bobPost}-${catComment} div.edit`))
  && (await cat.$eval(`#g${bobPost}-${catComment} details.edited`, (d) => d.textContent).catch(() => "")).includes("Which book?"));
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
const bobControls = await bob.$$eval(".member-list form:not(.friendship) button", (l) => l.map((b) => b.textContent));
check("Bob, an admin, can remove Cat but not Ann, nor make admins", bobControls.join() === "Remove", bobControls.join());
await bob.goto(`${B}/groups/${bobGroup}/posts/${bobPost}`);
const before = n(stateG, "group_comments");
await bob.click("article.in-group .comment:nth-of-type(3) .under details.more summary");
await Promise.all([settled(bob), bob.click("article.in-group .comment:nth-of-type(3) .under .delete")]);
check("Bob deletes his own comment", n(stateG, "group_comments") === before - 1);
await ann.goto(`${A}/groups/${annGroup}`);
annCards = await cards(ann);
check("Ann, its owner, can delete anything in the group", annCards.every((c) => c.canDelete && c.comments.every((x) => x.canDelete)));
await ann.click(`#gp${bobPost} .comment .under details.more summary`);
await Promise.all([settled(ann), ann.click(`#gp${bobPost} .comment .under .delete`)]);
check("…and does: Cat's first comment", !sql(stateG, "SELECT text FROM group_comments").some((c) => c.text === "Which book was it?")
  && n(stateG, "group_comment_versions") === 0);
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.$eval('form[action$="/about"] input[name=name]', (i) => { i.value = "Book club (2026)"; });
await Promise.all([ann.waitForNavigation(), ann.click('form[action$="/about"] button')]);
await cat.goto(`${C}/groups/${catGroup}`);
check("renaming reaches members' sites", (await cat.$eval("h1", (h) => h.textContent)) === "Book club (2026)");

// Events. Ann adds one; nobody is sent anything about it.
for (const page of [ann, bob, cat]) await page.emulateTimezone("Europe/London");
const notes = (state) => n(state, "group_inbox WHERE kind IS NOT NULL");
const inboxes = () => [stateA, stateB, stateC].map((st) => n(st, "group_inbox")).join();
const quiet = inboxes();
await ann.goto(`${A}/groups/${annGroup}/calendar`);
check("the Calendar starts empty, with adding an event open", (await text(ann)).includes("Nothing this month.") && await ann.$eval("details.add-event", (d) => d.open)
  && Boolean(await ann.$(".calendar .cal-grid")));
await addEvent(ann, { title: "Book swap", start_date: "2027-06-12", start_time: "19:00", end_time: "21:00", place: "Ann's house", text: "Bring a book" });
const swap = sql(stateG, "SELECT * FROM group_events")[0];
check("Ann adds an event, in her time zone", swap?.title === "Book swap" && swap.time_zone === "Europe/London"
  && swap.starts_at === Date.UTC(2027, 5, 12, 18) / 1000 && swap.ends_at === Date.UTC(2027, 5, 12, 20) / 1000, JSON.stringify(swap));
check("…lands on its page, saying when and where", (await text(ann)).includes("Sat 12 Jun 2027, 19:00–21:00") && (await text(ann)).includes("Ann's house"), (await text(ann)).slice(0, 400));
check("…and she's going", await pressed(ann, `gp${swap.post_id}`) === "going" && n(stateA, "events_elsewhere WHERE answer = 'going'") === 1);
await pause(2500);
check("no one is sent anything about a new event", inboxes() === quiet, `${quiet} -> ${inboxes()}`);

await bob.goto(`${B}/groups/${bobGroup}/calendar?month=2027-06`);
check("Bob's Calendar lists it under its month", (await text(bob)).includes("June 2027") && (await text(bob, ".calendar")).includes("Book swap"));
await answer(bob, `gp${swap.post_id}`, "going");
check("Bob says he's going", await pressed(bob, `gp${swap.post_id}`) === "going" && n(stateG, `group_answers WHERE origin = '${B}' AND answer = 'going'`) === 1);
await cat.goto(`${C}/groups/${catGroup}`);
check("the event shows in Posts too", (await text(cat)).includes("Book swap") && (await text(cat)).includes("2 going"));
await answer(cat, `gp${swap.post_id}`, "maybe");
check("Cat might go", n(stateC, "events_elsewhere WHERE answer = 'maybe'") === 1);
await pause(2500);
check("…and no one is told who's going", inboxes() === quiet);
await bob.goto(`${B}/events?month=2027-06`);
check("Bob's Events calendar shows it, as a group's", (await bob.$$eval(".cal-event.cal-group", (es) => es.map((e) => e.textContent).join())).includes("Book swap"));
await cat.goto(`${C}/groups/${catGroup}/posts/${swap.post_id}`);
const who = await text(cat, ".event .answered");
check("the event's page names who's going", who.includes("Ann Example") && who.includes("Bob Example") && who.includes("You"), who);

// Changing it: words only, quietly; the time, and those going (or who might) are told.
await ann.goto(`${A}/groups/${annGroup}/posts/${swap.post_id}/edit`);
check("Ann's form shows the event as it is", await ann.$eval("form.event-form", (f) => f.elements.start_time.value === "19:00" && f.elements.end_time.value === "21:00"));
await ann.$eval("form.event-form", (f) => { f.elements.text.value = "Bring a book or two"; });
await Promise.all([ann.waitForNavigation(), ann.click("form.event-form button.primary")]);
await pause(2500);
check("changing only the words tells no one", notes(stateB) + notes(stateC) === 0 && (await text(ann)).includes("Bring a book or two"));
await ann.goto(`${A}/groups/${annGroup}/posts/${swap.post_id}/edit`);
await ann.$eval("form.event-form", (f) => { f.elements.start_time.value = "20:00"; f.elements.end_time.value = "22:00"; });
await Promise.all([ann.waitForNavigation(), ann.click("form.event-form button.primary")]);
check("changing the time tells Bob and Cat", await waitFor(() => notes(stateB) === 1 && notes(stateC) === 1));
check("…and not Ann, who changed it", notes(stateA) === 0);
check("changing it again straight away is refused", (await call(G, `/_group/events/${swap.post_id}/edit`, sql(stateA, "SELECT their_key FROM groups")[0].their_key,
  { type: "Note", content: "", "afterwrd:event": { type: "Event", name: "Book swap", startTime: "2027-06-12T20:00:00Z", "afterwrd:timeZone": "Europe/London" } })).status === 400);
check("Bob's copy of his plans is brought up to date", sql(stateB, "SELECT starts_at FROM events_elsewhere")[0]?.starts_at === Date.UTC(2027, 5, 12, 19) / 1000);
await bob.goto(`${B}/activity`);
check("Bob's Notifications say what changed", (await text(bob)).includes("Ann Example changed an event you're going to in Book club (2026)")
  && (await text(bob)).includes("Sat 12 Jun 2027, 20:00–22:00"), (await text(bob)).slice(0, 400));
await cat.goto(`${C}/groups/${catGroup}/posts/${swap.post_id}`);
await answer(cat, `gp${swap.post_id}`, "no");
check("Cat can't go after all: her plans drop it", n(stateC, "events_elsewhere") === 0);
const ics = await bob.evaluate((p) => fetch(p).then(async (r) => ({ type: r.headers.get("Content-Type"), body: await r.text() })),
  `/groups/${bobGroup}/posts/${swap.post_id}/event.ics`);
check("Add to my calendar gives a calendar file", ics.type.startsWith("text/calendar") && ics.body.includes("SUMMARY:Book swap")
  && ics.body.includes("DTSTART:20270612T190000Z") && ics.body.includes("LOCATION:Ann's house"), ics.body.slice(0, 300));

// Only whoever added an event can change it; an admin can't call off the owner's; the group can't reword Ann's.
const evPath = `/_group/events/${swap.post_id}`;
const edited = { type: "Note", content: "x", "afterwrd:event": { type: "Event", name: "Hijacked", startTime: "2027-06-12T19:00:00Z", "afterwrd:timeZone": "Europe/London" } };
check("Bob can't change Ann's event", (await call(G, `${evPath}/edit`, bobAdminKey, edited)).status === 400
  && sql(stateG, "SELECT title FROM group_events")[0].title === "Book swap");
check("Bob, an admin, can't call off the owner's event", (await call(G, `${evPath}/cancel`, bobAdminKey, {})).status === 400);
check("a made-up answer is refused", (await call(G, `${evPath}/answer`, bobAdminKey, { answer: "definitely" })).status === 400);
check("an event with a made-up time zone is refused", (await call(G, "/_group/posts", bobAdminKey, { type: "Note", content: "",
  "afterwrd:event": { ...edited["afterwrd:event"], "afterwrd:timeZone": "Mars/Olympus" } })).status === 400);
check("…or one that's already over", (await call(G, "/_group/posts", bobAdminKey, { type: "Note", content: "",
  "afterwrd:event": { ...edited["afterwrd:event"], startTime: "2020-01-01T19:00:00Z" } })).status === 400);
sql(stateG, "UPDATE group_events SET title = 'Forged swap'");
await ann.goto(`${A}/groups/${annGroup}/posts/${swap.post_id}`);
check("Ann sees her event as she wrote it, not the group's version", (await text(ann)).includes("Book swap") && !(await text(ann)).includes("Forged swap"));
sql(stateG, "UPDATE group_events SET title = 'Book swap'");
const catNoted = notes(stateC);
const forged = { type: "Update", "afterwrd:change": "changed", actor: { name: "x" },
  object: { type: "Note", id: `${G}/groups/1/posts/${swap.post_id}`, "afterwrd:event": edited["afterwrd:event"] } };
const groupKeyForCat = sql(stateG, `SELECT their_key FROM group_members WHERE origin = '${C}'`)[0].their_key;
await call(C, "/_member/notify", groupKeyForCat, forged);
check("a group can't send notes about an event Cat isn't going to", notes(stateC) === catNoted);
check("…nor one that isn't an event", (await call(B, "/_member/notify", groupKeyForBob, { ...forged, object: { ...forged.object, "afterwrd:event": { type: "Event" } } })).status === 400);
// Only Cat's own answer, given from her site, puts an event in her plans: the group saying she's going doesn't.
sql(stateG, `INSERT INTO group_answers (post_id, origin, answer, answered_at) VALUES (${swap.post_id}, '${C}', 'going', 1)
  ON CONFLICT (post_id, origin, date) DO UPDATE SET answer = 'going'`);
await cat.goto(`${C}/groups/${catGroup}/calendar`);
check("a group saying Cat's going doesn't put it in her plans", n(stateC, "events_elsewhere") === 0);
sql(stateG, `UPDATE group_answers SET answer = 'no' WHERE origin = '${C}' AND post_id = ${swap.post_id}`);
// A post Bob wrote that wasn't an event isn't made one of his by the group.
sql(stateG, `INSERT INTO group_events (post_id, title, starts_at, all_day, time_zone) VALUES (${bobPost}, 'Forged party', ${Date.UTC(2027, 7, 1) / 1000}, 1, 'Europe/London')`);
await bob.goto(`${B}/groups/${bobGroup}/posts/${bobPost}`);
check("the group can't turn Bob's post into an event of his", !(await text(bob)).includes("Forged party"));
sql(stateG, `DELETE FROM group_events WHERE post_id = ${bobPost}`);
check("Ann can't move her event into the past", (await call(G, `${evPath}/edit`, sql(stateA, "SELECT their_key FROM groups")[0].their_key,
  { type: "Note", content: "", "afterwrd:event": { type: "Event", name: "Book swap", startTime: "2020-06-12T19:00:00Z", "afterwrd:timeZone": "Europe/London" } })).status === 400);

// Bob adds one; Ann, the owner, calls it off; Bob is told.
await bob.goto(`${B}/groups/${bobGroup}/calendar`);
await addEvent(bob, { title: "Pub quiz", start_date: "2027-07-01", start_time: "", place: "The Crown" });
const quiz = sql(stateG, "SELECT * FROM group_events WHERE title = 'Pub quiz'")[0];
check("Bob adds an all-day event", quiz?.all_day === 1 && (await text(bob)).includes("Thu 1 Jul 2027"), JSON.stringify(quiz));
await ann.goto(`${A}/groups/${annGroup}/posts/${quiz.post_id}`);
await Promise.all([settled(ann), ann.click(".event form[action$='/cancel'] button")]);
check("Ann calls it off", Boolean(sql(stateG, `SELECT cancelled_at FROM group_events WHERE post_id = ${quiz.post_id}`)[0].cancelled_at)
  && (await text(ann)).includes("Called off"));
check("…and Bob is told", await waitFor(() => notes(stateB) === 2));
check("…and his plans say so", Boolean(sql(stateB, `SELECT cancelled_at FROM events_elsewhere WHERE post_id = ${quiz.post_id}`)[0]?.cancelled_at));
await bob.goto(`${B}/activity`);
check("Bob's Notifications say it's off", (await text(bob)).includes("Ann Example called off an event you were going to"));
await ann.setViewport({ width: 390, height: 844 });
await ann.goto(`${A}/groups/${annGroup}/calendar`);
await ann.screenshot({ path: `${OUT}/group-calendar-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 800 });

// Asking to be friends from a group's members, and introductions by friends. Nobody here is friends yet.
const ask = (page, from) => Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click(`li[data-from="${from}"] .friendship button`)]);
const friendship = (page, from) => page.$eval(`li[data-from="${from}"] .friendship`, (e) => e.innerText.trim()).catch(() => "");
const remoteGroup = sql(stateB, "SELECT remote_id FROM groups")[0].remote_id;
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("in a group, Bob can ask Ann and Cat to be friends", (await friendship(bob, A)) === "Ask to be friends"
  && (await friendship(bob, C)) === "Ask to be friends" && (await friendship(bob, B)) === "");
await ask(bob, C);
check("Bob asks Cat: his side is done, hers waits for her", n(stateB, `connections WHERE origin = '${C}' AND approved_at IS NOT NULL`) === 1
  && n(stateC, `connections WHERE origin = '${B}' AND approved_at IS NULL AND via_kind = 'group' AND via_name = 'Book club (2026)'`) === 1);
check("…and his page says he's asked", (await friendship(bob, C)) === "Asked", await friendship(bob, C));
const probe = await call(C, "/_connect/ask", null, { origin: B, key: "k".repeat(43), via: { group: G, id: remoteGroup } });
check("asking for a site you can't prove is yours says nothing about it (Bob's already asking)", probe.status === 403
  && (await probe.json()).error.startsWith("Without a friend link"));
check("a site that isn't in the group can't ask", (await call(C, "/_connect/ask", null,
  { origin: "http://localhost:8795", key: "k".repeat(43), via: { group: G, id: remoteGroup } })).status === 403);
check("…nor can one that wasn't introduced", (await call(C, "/_connect/ask", null, { origin: A, key: "k".repeat(43), via: { introduction: true } })).status === 403);
check("…and nothing was kept for them", n(stateC, "connections") === 1);
await cat.goto(`${C}/`);
check("Cat's Home says Bob is asking, from Book club", (await text(cat, "form.notice.asking")).includes("in Book club (2026) with you"), await text(cat, "form.notice.asking"));
await Promise.all([cat.waitForNavigation(), cat.click("form.notice.asking button.primary")]);
check("Cat approves: they're friends", n(stateC, `connections WHERE origin = '${B}' AND approved_at IS NOT NULL`) === 1);
await bob.goto(`${B}/`);
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("…and Bob's group page says so", (await friendship(bob, C)) === "Friends");

await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, C);
await cat.goto(`${C}/groups/${catGroup}/members`);
check("Cat's group page offers to approve Ann", (await friendship(cat, A)).includes("Approve"), await friendship(cat, A));
await Promise.all([cat.waitForNavigation(), cat.click(`li[data-from="${A}"] .friendship button`)]);
check("…which she does, staying on the page", n(stateC, `connections WHERE origin = '${A}' AND approved_at IS NOT NULL`) === 1
  && new URL(cat.url()).pathname === `/groups/${catGroup}/members`);

// Cat, friends with both, introduces Ann and Bob.
const catsAnn = sql(stateC, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
const catsBob = sql(stateC, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
await cat.goto(`${C}/`); // her site hears from Ann's, so she knows Ann approved her too
await cat.goto(`${C}/friend`);
check("Cat's friends each have an Introduce link", Boolean(await cat.$(`a[href="/_admin/connections/${catsAnn}/introduce"]`)));
await cat.goto(`${C}/_admin/connections/${catsAnn}/introduce`);
check("…offering her other friends", (await cat.$$eval("select[name=to] option", (l) => l.map((o) => o.textContent.trim()))).join() === "Bob Example");
await cat.select("select[name=to]", String(catsBob));
await cat.type("textarea[name=note]", "You both run book clubs");
await Promise.all([cat.waitForNavigation({ timeout: 30_000 }), cat.click("#introduce")]);
check("both are told", n(stateA, `introductions WHERE origin = '${B}' AND name = 'Bob Example' AND note = 'You both run book clubs'`) === 1
  && n(stateB, `introductions WHERE origin = '${A}' AND name = 'Ann Example'`) === 1, await text(cat, "body"));
const catKeyAtAnn = sql(stateC, `SELECT their_key FROM connections WHERE origin = '${A}'`)[0].their_key;
check("introducing again changes nothing", (await call(A, "/_peer/introduce", catKeyAtAnn, { origin: B, name: "Someone else" })).status === 200
  && n(stateA, `introductions WHERE name = 'Bob Example'`) === 1);
check("only friends can introduce", (await call(A, "/_peer/introduce", "x".repeat(43), { origin: C, name: "Cat" })).status === 401);
await ann.goto(`${A}/`);
check("Ann's Home mentions it", (await text(ann, ".notice.introduction")).includes("Cat Example introduced you to localhost:8788, who they call Bob Example"), await text(ann, ".notice.introduction"));
await ann.goto(`${A}/friend`);
check("…and her Friends, with Cat's note", (await text(ann, "#introductions")).includes("You both run book clubs"));
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#introductions button.primary")]);
check("Ann asks Bob from the introduction", n(stateB, `connections WHERE origin = '${A}' AND approved_at IS NULL
  AND via_kind = 'introduction' AND via_name = 'Cat Example'`) === 1 && n(stateA, "introductions") === 0);
await bob.goto(`${B}/friend`);
check("Bob's Friends says Cat introduced them", (await text(bob, ".requests")).includes("Introduced by Cat Example"), await text(bob, ".requests"));
check("…in place of the introduction itself", !(await bob.$("#introductions")));
await Promise.all([bob.waitForNavigation(), bob.click('.requests button[formaction$="/decline"]')]);
check("Bob declines: Ann's site is told", await waitFor(() => n(stateA, `connections WHERE origin = '${B}'`) === 0)
  && n(stateB, `declined_asks WHERE origin = '${A}'`) === 1 && n(stateB, "introductions") === 0);
await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, B);
check("Ann can't ask again another way", (await text(ann, "body")).includes("already asked") && n(stateB, `connections WHERE origin = '${A}'`) === 0
  && n(stateA, `connections WHERE origin = '${B}'`) === 0);

// Several friends introduced to each other at once: Cat ticks Ann and Bob (finding Bob by typing), with a note.
await cat.goto(`${C}/_admin/connections/together`);
check("Introduce friends to each other lists Cat's friends to tick", (await cat.$$eval("input[name=friend]", (l) => l.map((b) => b.dataset.name))).join() === "Ann Example,Bob Example"
  && await cat.$eval("#together-go", (b) => b.disabled));
await cat.type("#together-filter", "an");
check("…typing narrows the list", (await cat.$$eval(".together-friend:not([hidden])", (l) => l.map((x) => x.textContent.trim()))).join() === "Ann Example");
await cat.click(`input[name=friend][value="${catsAnn}"]`);
await cat.$eval("#together-filter", (i) => { i.value = ""; });
await cat.type("#together-filter", "bo");
check("…keeping anyone ticked", (await cat.$$eval(".together-friend:not([hidden])", (l) => l.map((x) => x.textContent.trim()))).join() === "Ann Example,Bob Example"
  && (await cat.$$eval(".together-friend[hidden]", (l) => l.length)) === 0);
await cat.click(`input[name=friend][value="${catsBob}"]`);
await cat.type("textarea[name=note]", "Book club, all of you");
await cat.click("#together-go");
await cat.waitForFunction(() => document.querySelectorAll("#together-log li").length === 2 && ![...document.querySelectorAll("#together-log li")].some((l) => l.textContent.endsWith("…")), { timeout: 30_000 })
  .catch(async () => { throw new Error(`Introducing stuck: ${await cat.$eval("main", (m) => m.textContent.replace(/\s+/g, " ").slice(-400))} / go disabled: ${await cat.$eval("#together-go", (b) => b.disabled)} / url: ${cat.url()} / errors: ${errors.join(" | ")}`); });
const togetherLog = await cat.$$eval("#together-log li", (l) => l.map((x) => x.textContent));
check("…each is told about the others, one at a time", togetherLog.join() === "Told Ann Example ✓,Told Bob Example ✓", togetherLog.join(" | "));
check("…as introductions with the note (Bob, who declined Ann, isn't bothered again)", n(stateA, `introductions WHERE origin = '${B}' AND note = 'Book club, all of you'`) === 1
  && n(stateB, `introductions WHERE origin = '${A}'`) === 0);
check("…and only friends can be introduced", (await cat.evaluate(() => fetch("/_admin/connections/together", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to: 999, others: [1] }) }).then((r) => r.status))) === 400);
await bob.goto(`${B}/groups/${bobGroup}/members`);
await ask(bob, A);
check("Bob can still ask Ann himself", n(stateA, `connections WHERE origin = '${B}' AND approved_at IS NULL`) === 1 && n(stateB, "declined_asks") === 0);
await ann.goto(`${A}/friend`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("…and Ann approves", n(stateA, `connections WHERE origin = '${B}' AND approved_at IS NOT NULL`) === 1);
await bob.goto(`${B}/`);
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/groups/${bobGroup}/members`);
await bob.screenshot({ path: `${OUT}/group-members-friends-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });
const annAtBob = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
check("Bob removes Ann", (await post(bob, `/_admin/connections/${annAtBob}/disconnect`, {})).ok === true && n(stateA, `connections WHERE origin = '${B}'`) === 0);
await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, B);
check("…and she can't ask again from the group", (await text(ann, "body")).includes("already asked") && n(stateB, `connections WHERE origin = '${A}'`) === 0);

// Leaving and removing.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${bobMember}/member"]`)]);
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("Ann takes Bob's admin role back", (await bob.$$eval(".member-list form:not(.friendship) button", (l) => l.length)) === 0);
await Promise.all([bob.waitForNavigation(), bob.click('form[action$="/leave"] button')]);
check("Bob leaves", n(stateB, "groups") === 0 && n(stateG, `group_members WHERE origin = '${B}'`) === 0);
check("…keeping his own copies of his posts", sql(stateB, "SELECT kind FROM group_mine").every((r) => r.kind === "post"));
check("…and forgetting his plans there", n(stateB, "events_elsewhere") === 0);
check("…and the group forgets his answers, so rejoining starts afresh", n(stateG, `group_answers WHERE origin = '${B}'`) === 0);
check("…which stays in the group", n(stateG, `group_posts WHERE id = ${bobPost}`) === 1);
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('button[formaction$="/remove"]')]);
check("Ann removes Cat, and Cat's site forgets the group", n(stateC, "groups") === 0);
check("Cat's key no longer works", (await call(G, "/_group/posts", catKey)).status === 401);
check("the owner can't just leave", (await ann.evaluate((p) => fetch(p, { method: "POST" }).then((r) => r.status), `/_groups/${annGroup}/leave`)) === 400);

// Deleting the group empties it, and Ann's site forgets it.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click("#delete-go")]);
check("deleting the group empties its Worker", n(stateG, "groups") + n(stateG, "group_posts") + n(stateG, "group_photos") + n(stateG, "group_members")
  + n(stateG, "group_events") + n(stateG, "group_answers") === 0);
check("…and Ann's site forgets it", n(stateA, "groups") === 0 && new URL(ann.url()).pathname === "/groups");
check("the invite link stops working", (await fetch(link)).status === 404);

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
