// Group chats: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's own Worker (G, 8790). Ann
// starts the group, Bob and Cat join, Bob's an admin. A message goes to the group's site and on to the others' sites,
// each keeping a copy with who wrote it; an open chat shows new ones by itself; the group can't put words in a
// member's mouth; limits; delete for everyone (the writer, or an admin, as for posts); notifications only once asked
// for; messages go after 30 days; a member removed keeps the chat, read-only; and the download.
//   node group-chats.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const PUSH = "http://localhost:8795";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const sql = (state, q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local",
  "--persist-to", state, "--json", "--command", q], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const n = (state, q) => sql(state, `SELECT COUNT(*) AS n FROM ${q}`)[0].n;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(400)) if (await test()) return true;
  return false;
};

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
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const mainText = (page) => page.$eval("main", (m) => m.textContent);
const bubbles = (page) => page.$$eval("#chat li.msg", (l) => l.map((li) => ({ id: Number(li.dataset.id), mine: li.classList.contains("mine"),
  who: li.querySelector(".who")?.firstChild?.textContent.trim() ?? "", text: li.querySelector(".said").textContent, html: li.querySelector(".said").innerHTML,
  site: li.querySelector(".who .site")?.textContent ?? "",
  state: li.querySelector(".state")?.textContent ?? "", everywhere: Boolean(li.querySelector('input[name="everywhere"]')) })));
const menuCount = (page) => page.$eval('header.site a[href="/messages"]', (a) => a.querySelector(".count")?.firstChild?.textContent ?? "").catch(() => null);
async function join(page, site, link) {
  await page.goto(`${site}/groups`);
  await page.type("#join input[name=link]", link);
  await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
async function openGroupChat(page, site, groupId) {
  await page.goto(`${site}/groups/${groupId}`);
  await Promise.all([page.waitForNavigation(), page.$eval(`.tabs a[href="/groups/${groupId}/chat"]`, (a) => a.click())]);
  return page.url();
}
async function say(page, words) {
  await page.type("#say textarea", words);
  await page.click("#say button");
}

// The group, as in groups.mjs: Ann starts it, Bob and Cat join, Bob's an admin.
const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Book club", about: "One book a month" });
const annGroup = (await post(ann, "/_groups/create/claim", { id: waiting.id })).id;
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
await join(bob, B, link);
await join(cat, C, link);
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
const bobMember = sql(stateG, `SELECT id FROM group_members WHERE origin = '${B}'`)[0].id;
await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${bobMember}/admin"]`)]);
check("the group is set up: Ann owns it, Bob's an admin, Cat's a member", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3
  && sql(stateG, `SELECT role FROM group_members WHERE id = ${bobMember}`)[0].role === "admin");
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;
const catKey = sql(stateC, "SELECT their_key FROM groups")[0].their_key; // Cat's site calls the group with this
const groupCallsBob = sql(stateG, `SELECT their_key FROM group_members WHERE origin = '${B}'`)[0].their_key;
const address = `${G}/groups/1`;

// The group's page has a Chat tab; the chat says what it is.
await ann.goto(`${A}/groups/${annGroup}`);
check("a group's page has a Chat tab", (await ann.$(`.tabs a[href="/groups/${annGroup}/chat"]`)) !== null);
const annChat = await openGroupChat(ann, A, annGroup);
check("…which opens the group's chat", /\/messages\/\d+$/.test(annChat) && (await ann.$eval("h1", (h) => h.textContent)) === "Book club", annChat);
check("…which says messages go after 30 days, and to post what's worth keeping", (await mainText(ann)).includes("disappear after 30 days")
  && (await mainText(ann)).includes("make a post"));
check("…and that it doesn't notify, to begin with", (await mainText(ann)).includes("This chat doesn't notify you")
  && (await ann.$eval('form[action$="/notify"] button', (b) => b.textContent)) === "Notify me");

// Ann says something: the group has it, then Bob's and Cat's sites, with who wrote it.
await say(ann, "Hello book club!");
check("Ann's message is delivered to the group", await waitFor(async () => (await bubbles(ann)).some((m) => m.mine && m.state === "Delivered")));
check("…which keeps it, for the chat's limits and deleting", n(stateG, `group_chat WHERE origin = '${A}' AND text = 'Hello book club!'`) === 1);
check("…and passes it on to Bob's and Cat's sites, saying it's from Ann", await waitFor(() =>
  [stateB, stateC].every((s) => sql(s, "SELECT author_name, author_origin FROM messages WHERE text = 'Hello book club!'")
    .some((m) => m.author_name === "Ann Example" && m.author_origin === A))));
check("…in a group chat that doesn't notify, to begin with", sql(stateB, "SELECT kind, notify FROM chats")
  .every((c) => c.kind === "group" && c.notify === 0));
await bob.goto(`${B}/`);
check("it still counts on Bob's Messages", (await menuCount(bob)) === "1", await menuCount(bob));
await bob.goto(`${B}/messages`);
check("Messages lists it as a group", await bob.$eval(".chat-row", (a) => a.textContent.includes("Book club") && a.textContent.includes("group")));
const bobChat = await openGroupChat(bob, B, bobGroup);
check("Bob's chat shows it, with Ann's name", (await bubbles(bob)).some((m) => !m.mine && m.who === "Ann Example" && m.text === "Hello book club!"));

// Cat answers; Ann's and Bob's open chats get it by themselves, as text.
const catChat = await openGroupChat(cat, C, catGroup);
const tricky = "Hi all <b>bold</b> & <img src=x onerror=alert(1)>";
await say(cat, tricky);
check("Cat's message appears in Ann's and Bob's open chats by themselves", await waitFor(async () =>
  (await bubbles(ann)).some((m) => m.text === tricky && m.who === "Cat Example") && (await bubbles(bob)).some((m) => m.text === tricky)));
check("…as text, not HTML", (await bubbles(bob)).filter((m) => m.text === tricky).every((m) => !/<img|<b>/.test(m.html)));
check("…with the writer's site beside their name, so a look-alike name stands out", (await bubbles(bob)).find((m) => m.text === tricky)?.site === "localhost:8789");

// The group can't put words in a member's mouth, or into another group.
const toBob = (note) => call(B, "/_member/message", groupCallsBob, note);
const groupNote = (author, id, content, context = address) => ({ type: "Create", object: { type: "Note", id, content, context,
  attributedTo: { type: "Person", id: `${author}/`, name: "Someone" }, published: new Date().toISOString() } });
let r = await toBob(groupNote(B, `${B}/messages/${"f".repeat(22)}`, "words for Bob"));
check("a message the group says is from Bob himself is refused by his site", r.status === 400 && n(stateB, "messages WHERE text = 'words for Bob'") === 0);
r = await toBob(groupNote(C, `${A}/messages/${"g".repeat(22)}`, "mismatched"));
check("…and one whose address isn't the writer's", r.status === 400);
r = await toBob(groupNote(C, `${C}/messages/${"h".repeat(22)}`, "other group", `${G}/groups/2`));
check("…and one for another group", r.status === 400);
r = await call(B, "/_member/message", "x".repeat(43), groupNote(C, `${C}/messages/${"i".repeat(22)}`, "no key"));
check("…and one without the group's key", r.status === 401);

// On the group's site: members only, their own addresses, each kept once.
const catSays = (uid, content) => call(G, "/_group/chat", catKey, { type: "Create", object: { type: "Note", id: `${C}/messages/${uid}`, content } });
r = await call(G, "/_group/chat", "y".repeat(43), { type: "Create", object: { type: "Note", id: `${C}/messages/${"j".repeat(22)}`, content: "hi" } });
check("the group's chat is for members only", r.status === 401);
r = await call(G, "/_group/chat", catKey, { type: "Create", object: { type: "Note", id: `${B}/messages/${"k".repeat(22)}`, content: "as Bob" } });
check("…and a member can only send from their own site", r.status === 400);
const first = await catSays("l".repeat(22), "only once");
const again = await catSays("l".repeat(22), "only once");
check("a message sent twice is kept, and passed on, once", first.status === 201 && again.status === 200
  && await waitFor(() => n(stateA, "messages WHERE text = 'only once'") === 1) && n(stateG, "group_chat WHERE text = 'only once'") === 1);

// Delete for everyone: the writer, or an admin (but not the owner's).
await cat.reload();
const catsOwn = (await bubbles(cat)).find((m) => m.mine && m.text === tricky);
check("Cat may delete her own message for everyone", catsOwn?.everywhere === true);
await cat.$eval(`#chat li.msg[data-id="${catsOwn.id}"] form input[name="everywhere"]`, (i) => i.closest("form").querySelector("button").click());
check("…which takes it off every site, and the group's", await waitFor(() => n(stateA, "messages WHERE text LIKE 'Hi all%'") === 0
  && n(stateB, "messages WHERE text LIKE 'Hi all%'") === 0 && n(stateC, "messages WHERE text LIKE 'Hi all%'") === 0
  && n(stateG, "group_chat WHERE text LIKE 'Hi all%'") === 0));
check("…leaving a blank in its place, unseen, that still counts towards the limits", n(stateG, `group_chat WHERE origin = '${C}' AND deleted_at IS NOT NULL AND text = '' AND bytes > 0`) === 1
  && n(stateA, "messages WHERE deleted_at IS NOT NULL AND text = ''") === 1 && !(await bubbles(ann)).some((m) => m.text === ""));
await cat.reload();
check("Cat may only delete Ann's message here", (await bubbles(cat)).find((m) => m.text === "Hello book club!")?.everywhere === false);
const annsOnCat = sql(stateC, "SELECT id FROM messages WHERE text = 'Hello book club!'")[0].id;
r = await post(cat, `/_messages/${catChat.split("/").pop()}/${annsOnCat}/delete`, { everywhere: true });
check("…and the group says no if she asks it anyway", r.status === 400 && /writer, or the group's admins/.test(r.error ?? "")
  && n(stateB, "messages WHERE text = 'Hello book club!'") === 1, JSON.stringify(r));
await bob.reload();
const onlyOnceOnBob = (await bubbles(bob)).find((m) => m.text === "only once");
check("Bob, an admin, may delete Cat's message for everyone", onlyOnceOnBob?.everywhere === true);
r = await post(bob, `/_messages/${bobChat.split("/").pop()}/${onlyOnceOnBob.id}/delete`, { everywhere: true });
check("…and does", r.deleted === true && await waitFor(() => n(stateA, "messages WHERE text = 'only once'") === 0 && n(stateC, "messages WHERE text = 'only once'") === 0));
const annsOnBob = sql(stateB, "SELECT id FROM messages WHERE text = 'Hello book club!'")[0].id;
r = await post(bob, `/_messages/${bobChat.split("/").pop()}/${annsOnBob}/delete`, { everywhere: true });
check("…but not the owner's", r.status === 400 && n(stateC, "messages WHERE text = 'Hello book club!'") === 1, JSON.stringify(r));

// Notifications: none until Ann asks for them; then one, titled with the group, saying who wrote it.
const pushes = [];
const pushService = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => { pushes.push(Buffer.concat(parts)); res.writeHead(201).end(); });
}).listen(8795);
const phone = createECDH("prime256v1");
phone.generateKeys();
const phoneAuth = randomBytes(16);
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const ikm = Buffer.from(hkdfSync("sha256", phone.computeSecret(asPublic), phoneAuth, Buffer.concat([Buffer.from("WebPush: info\0"), phone.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const sealed = body.subarray(21 + body[20]);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end -= 1;
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}
await post(ann, "/_push/devices", { endpoint: `${PUSH}/push/phone`, keys: { p256dh: phone.getPublicKey().toString("base64url"),
  auth: phoneAuth.toString("base64url") }, name: "Android (home screen)" });
await ann.goto(`${A}/`);
await sleep(26_000); // until Ann's chat no longer counts as open (push.js)
await say(bob, "Shall we meet on Thursday?");
await waitFor(() => n(stateA, "messages WHERE text = 'Shall we meet on Thursday?'") === 1);
await sleep(2000);
check("a group chat doesn't notify until asked to", pushes.length === 0, String(pushes.length));
await ann.goto(annChat);
await ann.$eval('form[action$="/notify"] button', (b) => b.click());
check("Notify me switches it on, in place", await waitFor(async () => (await ann.$eval("#notify-words", (s) => s.textContent)) === "This chat notifies you.")
  && sql(stateA, `SELECT notify FROM chats WHERE id = ${annChat.split("/").pop()}`)[0].notify === 1);
await ann.goto(`${A}/`);
await sleep(26_000);
await say(bob, "Or Friday?");
check("then a message notifies, titled with the group, saying who wrote it", await waitFor(() => pushes.length === 1, 10_000)
  && decrypt(pushes[0]).title === "Book club" && decrypt(pushes[0]).body === "Bob Example: Or Friday?", pushes[0] && JSON.stringify(decrypt(pushes[0])));
pushService.close();

// After 30 days, gone: on members' sites when the chat's opened, and on the group's when the next message comes.
const annChatId = annChat.split("/").pop();
const old = Math.floor(Date.now() / 1000) - 31 * 86400;
sql(stateA, `INSERT INTO messages (chat_id, mine, uid, text, sent_at, received_at, author_origin, author_name)
  VALUES (${annChatId}, 0, '${C}/messages/${"o".repeat(22)}', 'from last month', ${old}, ${old}, '${C}', 'Cat Example')`);
sql(stateG, `INSERT INTO group_chat (group_id, origin, uid, author_name, text, bytes, created_at) VALUES (1, '${C}', '${"o".repeat(22)}', 'Cat Example', 'from last month', 15, ${old})`);
await ann.goto(annChat);
check("a group chat's messages go after 30 days", n(stateA, "messages WHERE text = 'from last month'") === 0
  && !(await bubbles(ann)).some((m) => m.text === "from last month"));
await say(ann, "New month");
check("…on the group's site too", await waitFor(() => n(stateG, "group_chat WHERE text = 'from last month'") === 0));

// Limits: a flood from one member is cut off by the group.
let limited = 0;
for (let i = 0; i < 125; i += 1) if ((await catSays(`flood-${String(i).padStart(16, "0")}`, `flood ${i}`)).status === 429) limited += 1;
check("a flood from one member is limited", limited > 0 && n(stateG, "group_chat WHERE text LIKE 'flood %'") < 125, String(limited));
// …and a busy group as a whole, before members' sites would turn anything away (so senders hear at once).
const bobKey = sql(stateB, "SELECT their_key FROM groups")[0].their_key;
const annKey = sql(stateA, "SELECT their_key FROM groups")[0].their_key;
for (let i = 0; i < 125; i += 1) await call(G, "/_group/chat", bobKey, { type: "Create", object: { type: "Note", id: `${B}/messages/busy-${String(i).padStart(16, "0")}`, content: `busy ${i}` } });
let groupFull = 0;
for (let i = 0; i < 30; i += 1) {
  if ((await call(G, "/_group/chat", annKey, { type: "Create", object: { type: "Note", id: `${A}/messages/full-${String(i).padStart(16, "0")}`, content: `full ${i}` } })).status === 429) groupFull += 1;
}
check("a busy group is limited as a whole, before any member's own limit", groupFull > 0 && n(stateG, `group_chat WHERE origin = '${A}' AND text LIKE 'full %'`) < 30, String(groupFull));
check("…and members' sites take everything the group lets through", await waitFor(() => [stateA, stateC]
  .every((st) => n(st, "messages WHERE text LIKE 'busy %'") === n(stateG, "group_chat WHERE text LIKE 'busy %'")), 90_000),
  `${n(stateA, "messages WHERE text LIKE 'busy %'")} of ${n(stateG, "group_chat WHERE text LIKE 'busy %'")}`);

// Ann removes Cat: Cat keeps the chat, read-only, and hears nothing more.
const catMember = sql(stateG, `SELECT id FROM group_members WHERE origin = '${C}'`)[0].id;
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${catMember}/remove"]`)]);
check("Ann removes Cat from the group", await waitFor(() => n(stateC, "groups") === 0));
await cat.goto(catChat);
check("Cat keeps the chat, read-only", (await bubbles(cat)).some((m) => m.text === "Hello book club!") && (await cat.$("#say")) === null
  && (await mainText(cat)).includes("You're not in Book club any more"));
r = await post(cat, `/_messages/${catChat.split("/").pop()}/send`, { text: "Let me back in" });
check("…and can't send in it", r.status === 403, JSON.stringify(r));
await ann.goto(annChat);
await say(ann, "Just us now");
await waitFor(() => n(stateB, "messages WHERE text = 'Just us now'") === 1);
await sleep(2000);
check("…nor hears what's said after", n(stateC, "messages WHERE text = 'Just us now'") === 0);

// Download everything has the group chat's messages, with who wrote them.
const rows = await ann.evaluate(async () => (await (await fetch("/_admin/export/rows?table=messages")).json()).rows);
check("Download everything has the group chat, with who wrote each message", rows.some((m) => m.text === "Or Friday?" && m.author_name === "Bob Example"
  && m.author_origin === "http://localhost:8788"));

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
