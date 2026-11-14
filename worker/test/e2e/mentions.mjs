// Mentions (src/mentions.js, docs/mentions-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a
// group's Worker (G, 8790). Ann is friends with Bob and with Cat, who aren't friends with each other. Typing @ offers
// people to mention; a post or comment that mentions someone tells them (Notifications, and their phone if it takes
// mentions), but only if they can see it, as the site holding the post decides. Names typed by hand mention nobody.
// In a group: members only, and @here (everyone) for its owner and admins, or anyone if they allow it, a few a day.
// A stand-in push service on 8796 counts what reaches each "phone".
//   node mentions.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { count as n, settled, siteSql as sql } from "./helpers.mjs";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const PUSH = "http://localhost:8796";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

// --- people, friends, phones ------------------------------------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
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
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

async function befriend(inviter, site, friend, friendSite) {
  await inviter.goto(`${site}/_admin/connections`);
  await inviter.click("#make");
  await inviter.waitForSelector("#link:not([hidden])");
  const link = await inviter.$eval("#link-url", (i) => i.value);
  await friend.goto(`${friendSite}/_admin/connections`);
  await friend.type("#paste input[name=link]", link);
  await Promise.all([friend.waitForNavigation(), friend.click("#paste button:not([type=button])")]);
  await Promise.all([friend.waitForNavigation({ timeout: 30_000 }), friend.click("#go")]);
  await inviter.goto(`${site}/`);
  await Promise.all([inviter.waitForNavigation(), inviter.click('.notice.asking button[formaction*="/approve"]')]);
}

// A stand-in push service: what reaches each phone is counted (notifications.mjs checks what's in them).
const pushes = [];
const pushService = createServer((req, res) => {
  req.resume();
  req.on("end", () => { pushes.push(req.url); res.writeHead(201).end(); });
}).listen(8796);
const toPhone = (who) => pushes.filter((p) => p === `/push/${who}`).length;
/** Turns on notifications for `page`'s owner, at /push/<who>, as their phone would. */
async function phone(page, site, who) {
  await page.goto(`${site}/events`);
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  return post(page, "/_push/devices", { endpoint: `${PUSH}/push/${who}`, name: `Phone (${who})`, preview: true,
    keys: { p256dh: keys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
}

/** Types into `box` and picks the first person the @ list offers; returns what it offered. */
async function mention(page, box, typed) {
  await page.type(box, typed);
  await page.waitForSelector("#mention-list:not([hidden]) li", { timeout: 5000 }).catch(() => {});
  const offered = await page.$$eval("#mention-list:not([hidden]) li", (l) => l.map((li) => li.firstChild.textContent));
  if (offered.length) await page.keyboard.press("Enter");
  return offered;
}
const mentionsField = (page, form) => page.$eval(`${form} input[name=mentions]`, (i) => JSON.parse(i.value)).catch(() => []);
const inbox = (state, kind) => n(state, `inbox WHERE kind = '${kind}'`);
const groupInbox = (state, kind) => n(state, `group_inbox WHERE kind = '${kind}'`);
/** Home opened until a friend's card has `words`, as its copy of their posts catches up (feed.js). */
async function friendCard(page, site, words) {
  let id = null;
  await waitFor(async () => {
    await page.goto(`${site}/`);
    id = await page.$$eval("article.from-friend", (l, w) => l.find((a) => a.innerText.includes(w))?.id ?? null, words);
    return Boolean(id);
  });
  return id && `#${id}`;
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat, who aren't friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2
  && n(stateB, `connections WHERE origin = '${C}'`) === 0);
check("Bob's and Cat's phones say yes to notifications", (await phone(bob, B, "bob")).on === true && (await phone(cat, C, "cat")).on === true);
check("…and to mentions, unless they say otherwise", (await post(cat, "/_push/devices/state", { endpoint: `${PUSH}/push/cat` })).mentions === true);

// --- a post that mentions a friend ---------------------------------------------------------------------------------------

await ann.goto(`${A}/posts`);
const offered = await mention(ann, "#composer textarea", "Walk on Saturday, @Bo");
check("typing @ offers friends, narrowing as you type", offered.join() === "@Bob Example", offered.join());
check("…and picking one writes their whole name", (await ann.$eval("#composer textarea", (t) => t.value)) === "Walk on Saturday, @Bob Example ");
check("…noting who that is", JSON.stringify(await mentionsField(ann, "#composer")) === JSON.stringify([{ name: "Bob Example", origin: B }]));
await ann.type("#composer textarea", "who's in?");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("Ann's post shows the mention", (await ann.$eval("article.own .text strong.mention", (s) => s.textContent).catch(() => "")) === "@Bob Example");
check("Bob's site is told he's mentioned", await waitFor(() => inbox(stateB, "mention") === 1));
check("…and his phone", await waitFor(() => toPhone("bob") === 1), String(toPhone("bob")));
check("…but not Cat, who isn't mentioned", inbox(stateC, "mention") === 0 && toPhone("cat") === 0);
await bob.goto(`${B}/activity`);
check("Bob's Notifications says Ann mentioned him", (await text(bob)).includes("Ann Example mentioned you on their post"));

// Names typed by hand, or not in the words, mention nobody.
await ann.goto(`${A}/posts`);
await ann.$eval("#composer textarea", (t) => { t.value = "Hi @Cat Example, typed by hand"; });
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("a name typed by hand isn't a mention", !(await ann.$eval("article.own", (a) => Boolean(a.querySelector("strong.mention")))));
check("…the site says the same of one whose name isn't in the words", (await post(ann, "/_admin/posts", { text: "Hello", mentions: [{ name: "Cat Example", origin: C }] })).status === 200);
await new Promise((r) => setTimeout(r, 3000));
check("…and neither tells anyone", inbox(stateC, "mention") === 0);

// --- comments: on a friend's post, and passed on by the site that holds the post --------------------------------------------

check("Bob posts", (await post(bob, "/_admin/posts", { text: "Anyone for tennis?" })).status === 200);
const tennis = await friendCard(ann, A, "Anyone for tennis?");
check("…and it reaches Ann's Home", Boolean(tennis));
const notThere = await mention(ann, `${tennis} .say textarea`, "@Ca");
check("on a friend's post, the @ list doesn't offer your other friends", notThere.length === 0, notThere.join());
await ann.$eval(`${tennis} .say textarea`, (t) => { t.value = ""; });
const asked = await mention(ann, `${tennis} .say textarea`, "@Bo");
check("…only its writer and those already in its thread", asked.join() === "@Bob Example", asked.join());
await ann.type(`${tennis} .say textarea`, "count me in");
await Promise.all([settled(ann), ann.click(`${tennis} .say button`)]);
check("Ann's comment on Bob's post mentions him, on his site", sql(stateB, "SELECT mentions FROM comments WHERE origin != 'site'")
  .some((c) => (c.mentions ?? "").includes(B)));
check("…which tells Bob's phone, as its owner", await waitFor(() => toPhone("bob") === 2), String(toPhone("bob")));
check("…and shows as a mention under his post, on Ann's Home", await ann.$eval(`${tennis} .comment strong.mention`, (s) => s.textContent).catch(() => "") === "@Bob Example");

// Cat comments on Ann's post; Bob, who can see it but isn't Cat's friend, mentions her there. Ann's site holds the
// post, and Cat can see it, so Ann's site tells her.
const walkCat = await friendCard(cat, C, "Walk on Saturday");
await cat.type(`${walkCat} .say textarea`, "Count me in");
await Promise.all([settled(cat), cat.click(`${walkCat} .say button`)]);
const catComments = inbox(stateC, "comment");
sql(stateB, "UPDATE connections SET copy_until = 0"); // so Bob's Home has Cat's comment (no note tells his site)
const walkBob = await friendCard(bob, B, "Walk on Saturday");
const fromThread = await mention(bob, `${walkBob} .say textarea`, "@Ca");
check("the @ list has people already on the post, friends or not", fromThread.join() === "@Cat Example", fromThread.join());
await bob.type(`${walkBob} .say textarea`, "see you there");
await Promise.all([settled(bob), bob.click(`${walkBob} .say button`)]);
check("Ann's site tells Cat, who can see the post", await waitFor(() => inbox(stateC, "mention") === 1));
check("…and her phone", await waitFor(() => toPhone("cat") === 1), String(toPhone("cat")));
check("…once: not a comment note as well", inbox(stateC, "comment") === catComments);
// On someone else's post, its site only takes mentions of its writer and of those already in the thread, whatever's sent.
const hello = sql(stateA, "SELECT key FROM posts WHERE text = 'Hello'")[0].key;
const annForBob = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
await bob.evaluate(async (connection, target, c) => {
  const body = new URLSearchParams({ connection: String(connection), target, text: "@Cat Example look at this", back: "/",
    mentions: JSON.stringify([{ name: "Cat Example", origin: c }]) });
  await fetch("/_feed/comments", { method: "POST", body, redirect: "manual" });
}, annForBob, hello, C);
await new Promise((r) => setTimeout(r, 3000));
check("…so mentioning someone who isn't there tells no one", inbox(stateC, "mention") === 1
  && sql(stateA, `SELECT mentions FROM comments WHERE target = '${hello}'`).every((c) => !(c.mentions ?? "").includes(C)));
await cat.goto(`${C}/activity`);
check("Cat's Notifications says who mentioned her, and where", (await text(cat)).includes("Bob Example mentioned you on Ann Example's post"));

// Cat says no to mentions on her phone: she's still told, but her phone isn't.
check("a phone can turn mentions off", (await post(cat, "/_push/devices/mentions", { endpoint: `${PUSH}/push/cat`, mentions: false })).ok === true
  && (await post(cat, "/_push/devices/state", { endpoint: `${PUSH}/push/cat` })).mentions === false);
await bob.goto(`${B}/`);
const again = await friendCard(bob, B, "Walk on Saturday");
await mention(bob, `${again} .say textarea`, "@Ca");
await bob.type(`${again} .say textarea`, "bring a flask");
await Promise.all([settled(bob), bob.click(`${again} .say button`)]);
check("…then she's told on her site", await waitFor(() => inbox(stateC, "mention") === 2));
await new Promise((r) => setTimeout(r, 2000));
check("…but her phone isn't", toPhone("cat") === 1, String(toPhone("cat")));

// A friend's site can only say its own posts mention someone.
const bobsKeyForAnn = sql(stateB, `SELECT their_key FROM connections WHERE origin = '${A}'`)[0].their_key;
const forged = await call(A, "/_peer/notify", bobsKeyForAnn, { type: "Create", object: { type: "Note", "afterwrd:mention": true,
  inReplyTo: `${C}/posts/post-1762164000-0b918c1b`, content: "forged" } });
check("a mention note about someone else's post is refused", forged.status === 400, String(forged.status));
check("…and nothing's kept", inbox(stateA, "mention") === 0);

// A friend's notes can't make Ann's site fetch their posts over and over (feed.js BACKGROUND_DAILY): 48 times a day.
const bobAtAnn = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
const today = Math.floor(Date.now() / 86_400_000);
const refreshes = () => sql(stateA, `SELECT refreshes FROM connections WHERE id = ${bobAtAnn}`)[0].refreshes;
let made = 0;
const postNotes = async (count) => {
  for (let i = 0; i < count; i++, made++) {
    await call(A, "/_peer/notify", bobsKeyForAnn, { type: "Create", object: { type: "Note",
      id: `${B}/posts/post-${1762164000 + made}-0b918c1b`, content: "news" } });
  }
  await new Promise((r) => setTimeout(r, 4000));
};
sql(stateA, `UPDATE connections SET refreshes = 0, refresh_day = ${today} WHERE id = ${bobAtAnn}`);
await postNotes(2);
check("a friend's note fetches their posts, counted for the day", refreshes() >= 1 && refreshes() <= 2, String(refreshes()));
sql(stateA, `UPDATE connections SET refreshes = 48 WHERE id = ${bobAtAnn}`);
const before = sql(stateA, `SELECT copied_at FROM connections WHERE id = ${bobAtAnn}`)[0].copied_at;
await postNotes(2);
check("…and not past the day's allowance", refreshes() === 48 && sql(stateA, `SELECT copied_at FROM connections WHERE id = ${bobAtAnn}`)[0].copied_at === before);

// --- in a group ---------------------------------------------------------------------------------------------------------

const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Walkers", about: "" });
const annGroup = (await post(ann, "/_groups/create/claim", { id: waiting.id })).id;
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
for (const [page, site] of [[bob, B], [cat, C]]) {
  await page.goto(`${site}/groups`);
  await page.type("#join input[name=link]", link);
  await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("the group has three members", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;

await cat.goto(`${C}/groups/${catGroup}`);
const catOffered = await mention(cat, "#composer textarea", "@");
check("in a group, the @ list is its members, without @here for a member", catOffered.includes("@Bob Example") && catOffered.includes("@Ann Example")
  && !catOffered.includes("@here"), catOffered.join());
const refused = await post(cat, `/_groups/${catGroup}/posts`, { text: "Hello @here", mentions: [{ name: "here", origin: "here" }] });
check("…and the group refuses @here from a member", refused.status === 400 && /Only the group's admins can use @here/.test(refused.error ?? ""), JSON.stringify(refused));

await ann.goto(`${A}/groups/${annGroup}`);
const annOffered = await mention(ann, "#composer textarea", "@he");
check("its owner is offered @here", annOffered.join() === "@here", annOffered.join());
await ann.type("#composer textarea", "the walk's moved to 7");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("@here tells everyone else in the group", await waitFor(() => groupInbox(stateB, "here") === 1 && groupInbox(stateC, "here") === 1));
check("…on Bob's phone, and not Cat's (mentions off)", await waitFor(() => toPhone("bob") === 3) && toPhone("cat") === 1, `${toPhone("bob")} ${toPhone("cat")}`);
check("…and not the writer", groupInbox(stateA, "here") === 0);
await bob.goto(`${B}/groups/${bobGroup}`);
check("…shown as a mention in the group", (await bob.$eval("article.in-group strong.mention", (s) => s.textContent).catch(() => "")) === "@here");
await bob.goto(`${B}/activity`);
check("…and on Notifications", (await text(bob)).includes("Ann Example wrote to everyone (@here) in a post in Walkers"));

// Ann lets anyone use it; Cat can then, a few times a day.
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#here input[name=anyone]");
await Promise.all([ann.waitForNavigation(), ann.click("#here button")]);
check("the owner can let anyone use @here", n(stateG, "groups WHERE here_anyone = 1") === 1 && await ann.$eval("#here input[name=anyone]", (i) => i.checked));
const heres = [];
for (let i = 0; i < 4; i++) heres.push(await post(cat, `/_groups/${catGroup}/posts`, { text: `Lifts? @here (${i})`, mentions: [{ name: "here", origin: "here" }] }));
check("…then a member can, three times a day", heres.slice(0, 3).every((r) => r.status === 200), JSON.stringify(heres.slice(0, 3)));
check("…and no more", heres[3].status === 400 && /used a lot today/.test(heres[3].error ?? ""), JSON.stringify(heres[3]));
check("…each telling the others", await waitFor(() => groupInbox(stateB, "here") === 4));

// Mentioning by name in a group: members only.
const gPost = sql(stateG, "SELECT id FROM group_posts ORDER BY id LIMIT 1")[0].id;
const named = await bob.evaluate(async (g, p, c) => {
  const body = new URLSearchParams({ post: String(p), text: "@Cat Example and @Zed Stranger, thoughts?", back: `/groups/${g}`,
    mentions: JSON.stringify([{ name: "Cat Example", origin: c }, { name: "Zed Stranger", origin: "https://zed.example" }]) });
  return (await fetch(`/_groups/${g}/comments`, { method: "POST", body, redirect: "manual" })).type;
}, bobGroup, gPost, C);
check("a group comment can mention a member by name", named === "opaqueredirect" && await waitFor(() => groupInbox(stateC, "mention") === 1));
check("…and the group keeps only members' mentions", sql(stateG, "SELECT mentions FROM group_comments").every((c) => !(c.mentions ?? "").includes("zed.example"))
  && sql(stateG, "SELECT mentions FROM group_comments").some((c) => (c.mentions ?? "").includes(C)));

// One member mentioning the same person tells them a few times a day at most (notify.js MENTION_PAIR_DAILY).
const catMentionsBefore = groupInbox(stateC, "mention");
for (let i = 0; i < 7; i++) {
  await bob.evaluate(async (g, p, c, n) => {
    const body = new URLSearchParams({ post: String(p), text: `@Cat Example again (${n})`, back: `/groups/${g}`,
      mentions: JSON.stringify([{ name: "Cat Example", origin: c }]) });
    await fetch(`/_groups/${g}/comments`, { method: "POST", body, redirect: "manual" });
  }, bobGroup, gPost, C, i);
}
await new Promise((r) => setTimeout(r, 4000));
check("one member can't keep telling the same person", groupInbox(stateC, "mention") - catMentionsBefore === 4,
  String(groupInbox(stateC, "mention") - catMentionsBefore));
// The group's @here allowance holds back ordinary members only: with it used up, Ann (its owner) can still.
sql(stateG, `INSERT INTO here_log (member_id, at) VALUES ${Array.from({ length: 10 }, () => "(999, strftime('%s','now'))").join(",")}`);
const bobHere = await post(bob, `/_groups/${bobGroup}/posts`, { text: "Again @here", mentions: [{ name: "here", origin: "here" }] });
const annHere = await post(ann, `/_groups/${annGroup}/posts`, { text: "Admins can still @here", mentions: [{ name: "here", origin: "here" }] });
check("with the group's @here allowance used, members can't, but its admins can", bobHere.status === 400 && annHere.status === 200,
  `${JSON.stringify(bobHere)} ${JSON.stringify(annHere)}`);

check("no script errors", errors.length === 0, errors.join("; "));
pushService.close();
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
