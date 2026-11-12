// Messages between friends' sites (src/messages.js), their notifications (src/push.js), and Add to home screen. Ann
// (A, 8787) and Sam (B, 8788) are friends. Run here too: a stand-in friend's site (8796) that's down, or doesn't take
// messages, when told to; and a stand-in push service (8795) that decrypts what it's sent, as a phone would.
// Sending and receiving through the pages, new messages appearing in an open chat, the menu's count, text kept as
// text, refusals, each message kept once, limits, a friend removed, the download, and notifications: only for
// messages, never for a muted chat or one that's open, with or without the words.
//   node messages.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>
import { execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const FAKE = "http://localhost:8796";
const PUSH = "http://localhost:8795";
const CODE = "local-test-setup-code";
const sql = (state, q) => JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "afterwrd", "--local",
  "--persist-to", state, "--json", "--command", q], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await test()) return true;
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
// A call from the owner's own signed-in page, as the pages' scripts make them.
const call = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, b === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}, path, body);
const mainText = (page) => page.$eval("main", (m) => m.textContent);
const bubbles = (page) => page.$$eval("#chat li.msg", (l) => l.map((li) => ({ id: Number(li.dataset.id), mine: li.classList.contains("mine"),
  text: li.querySelector(".said").textContent, html: li.querySelector(".said").innerHTML, state: li.querySelector(".state")?.textContent ?? "" })));
const menuCount = (page) => page.$eval('header.site a[href="/messages"]', (a) => a.querySelector(".count")?.firstChild?.textContent ?? "").catch(() => null);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = () => randomBytes(32).toString("base64url");

// Friends, as a finished Connect leaves them: each site holds the key for calling the other.
function befriend(stateX, originX, nameX, stateY, originY, nameY) {
  const [xy, yx] = [key(), key()]; // x calls y with xy, y calls x with yx
  const row = (origin, name, theirs, ours) => `INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, approved_at, reached_at)
    VALUES ('${origin}', '${name}', '${theirs}', '${hash(ours)}', 1, 1, 1, 1)`;
  sql(stateX, row(originY, nameY, xy, yx));
  if (stateY) sql(stateY, row(originX, nameX, yx, xy));
  return { xy, yx };
}

const ann = await owner(A, "Ann Example");
const sam = await owner(B, "Sam Taylor");
const { xy: keyAnnHolds } = befriend(stateA, A, "Ann Example", stateB, B, "Sam Taylor");

// Messages is in the menu, and a friend's page has a Message button.
await ann.goto(`${A}/`);
check("Messages is in the menu", (await ann.$('header.site a[href="/messages"]')) !== null);
const [samHere] = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`);
await ann.goto(`${A}/friend/${samHere.id}/posts`);
check("a friend's page has a Message button", (await ann.$(`a[href="/friend/${samHere.id}/message"]`)) !== null);
await Promise.all([ann.waitForNavigation(), ann.click(`a[href="/friend/${samHere.id}/message"]`)]);
const annChat = ann.url();
const annChatId = annChat.split("/").pop();
check("…which opens a chat with them", /\/messages\/\d+$/.test(annChat) && (await ann.$eval("h1", (h) => h.textContent)) === "Sam Taylor", annChat);

// Ann sends; Sam's site has it straight away.
await ann.type("#say textarea", "Are you coming tonight?");
await ann.click("#say button");
check("Ann's message shows, delivered, without leaving the page", await waitFor(async () => {
  const list = await bubbles(ann);
  return list.length === 1 && list[0].mine && list[0].text === "Are you coming tonight?" && list[0].state === "Delivered";
}) && ann.url() === annChat);
check("…and it's on Sam's site", sql(stateB, "SELECT text, mine FROM messages").some((m) => m.text === "Are you coming tonight?" && m.mine === 0));

await sam.goto(`${B}/`);
check("Sam's menu counts one chat with something unread", (await menuCount(sam)) === "1", await menuCount(sam));
await sam.goto(`${B}/messages`);
check("Messages lists the chat with Ann, unread, without her site's address", await sam.$eval(".chat-row", (a) => a.classList.contains("unread") && a.textContent.includes("Ann Example")
  && !a.textContent.includes("localhost:8787")
  && a.textContent.includes("Are you coming tonight?")));
await Promise.all([sam.waitForNavigation(), sam.click(".chat-row")]);
const samChat = sam.url();
const samChatId = samChat.split("/").pop();
check("Sam's chat shows Ann's message", (await bubbles(sam)).some((m) => !m.mine && m.text === "Are you coming tonight?"));
check("…and opening it counts it as read", (await menuCount(sam)) === "", await menuCount(sam));

// While Sam's chat is open, Ann's next messages arrive in it without a reload: words, never HTML.
const tricky = "Yes! <b>bold</b> & <img src=x onerror=alert(1)>\nsecond line";
await call(ann, `/_messages/${annChatId}/send`, { text: tricky });
check("a new message appears in Sam's open chat by itself", await waitFor(async () => (await bubbles(sam)).some((m) => m.text === tricky), 10_000)
  && sam.url() === samChat);
const shownTricky = (await bubbles(sam)).find((m) => m.text === tricky);
check("…as text, not HTML, with its line break", shownTricky && !/<b>|<img/.test(shownTricky.html) && shownTricky.text.includes("\nsecond line"));
await sam.reload();
check("…and the same when the page is made by the site", (await bubbles(sam)).some((m) => m.text === tricky && !/<img/.test(m.html)));

// Sam answers through the form without a script (as a phone with scripts off would).
await sam.setJavaScriptEnabled(false);
await sam.reload();
await sam.type("#say textarea", "See you at 8");
await Promise.all([sam.waitForNavigation(), sam.click("#say button")]);
await sam.setJavaScriptEnabled(true);
await sam.reload();
check("sending works without the page's script too", (await bubbles(sam)).some((m) => m.mine && m.text === "See you at 8" && m.state === "Delivered"));
check("…and Ann's open chat gets it", await waitFor(async () => (await bubbles(ann)).some((m) => !m.mine && m.text === "See you at 8")));

// Refusals.
let r = await call(ann, `/_messages/${annChatId}/send`, { text: "x".repeat(4001) });
check("a message that's too long is refused", r.status === 400 && /1 to 4000/.test(r.json?.error ?? ""), r.text);
r = await call(ann, `/_messages/${annChatId}/send`, { text: "   " });
check("…and an empty one", r.status === 400, r.text);
const cookies = (await ann.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
const forged = await fetch(`${A}/_messages/${annChatId}/send`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookies, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "forged" }) });
check("another site can't send as Ann", forged.status === 403, String(forged.status));
check("…nor read her chat", (await fetch(`${A}/_messages/${annChatId}/since?after=0`, { redirect: "manual" })).status === 302);
check("…nor mark it read by linking to it", (await fetch(`${A}/_messages/${annChatId}/since?after=0`, { headers: { Cookie: cookies, "Sec-Fetch-Site": "cross-site" } })).status === 403);

// Straight to Sam's site with the key Ann's site holds: kept once, addresses checked, clocks not trusted.
const toSam = (note) => fetch(`${B}/_peer/message`, { method: "POST", headers: { Authorization: `Bearer ${keyAnnHolds}`,
  "Content-Type": "application/json" }, body: JSON.stringify(note) });
const note = (id, content, published = new Date().toISOString()) => ({ type: "Create", object: { type: "Note", id, content, published } });
const once = `${A}/messages/${"r".repeat(22)}`;
const first = await toSam(note(once, "only once"));
const again = await toSam(note(once, "only once"));
check("a message sent twice is kept once", first.status === 201 && again.status === 200
  && sql(stateB, "SELECT COUNT(*) AS n FROM messages WHERE text = 'only once'")[0].n === 1, `${first.status} ${again.status}`);
r = await toSam(note(`http://localhost:8789/messages/${"s".repeat(22)}`, "pretending to be someone else"));
check("a message claiming another site's address is refused", r.status === 400, String(r.status));
r = await toSam(note(`${A}/messages/${"t".repeat(22)}`, "from the future", "2099-01-01T00:00:00Z"));
const future = sql(stateB, "SELECT sent_at, received_at FROM messages WHERE text = 'from the future'")[0];
check("a time in the future is brought back to when it arrived", r.status === 201 && future?.sent_at <= future?.received_at, JSON.stringify(future));
r = await toSam(note(`${A}/messages/${"v".repeat(22)}`, "from long ago", "2000-01-01T00:00:00Z"));
const past = sql(stateB, "SELECT sent_at, received_at FROM messages WHERE text = 'from long ago'")[0];
check("…and one long ago to a week before it arrived", r.status === 201 && past?.sent_at === past?.received_at - 7 * 86400, JSON.stringify(past));
r = await fetch(`${B}/_peer/message`, { method: "POST", headers: { Authorization: "Bearer not-a-real-key-not-a-real-key-not-a-real-key", "Content-Type": "application/json" },
  body: JSON.stringify(note(`${A}/messages/${"u".repeat(22)}`, "no key")) });
check("…and one without a friend's key", r.status === 401, String(r.status));

// A stand-in friend's site: one that doesn't take messages (an older afterwrd), then one that's down for a bit.
const received = [];
let mode = "old"; // old: 404, as a site without messages answers; down: 503; up: takes it
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (mode === "old") { res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"Not found."}'); return; }
    if (mode === "down") { res.writeHead(503).end(); return; }
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
  });
}).listen(8796);
const { xy: fakeKey, yx: fakeAnnKey } = befriend(stateA, A, "Ann Example", null, FAKE, "Test Site");
const [fakeHere] = sql(stateA, `SELECT id FROM connections WHERE origin = '${FAKE}'`);
await ann.goto(`${A}/friend/${fakeHere.id}/message`);
const fakeChat = ann.url().split("/").pop();
r = await call(ann, `/_messages/${fakeChat}/send`, { text: "Hello old site" });
check("a message to a site that doesn't take messages isn't delivered, and says why", r.json?.message?.state === "failed"
  && r.json.message.problem === "no-messages", r.text);
await ann.reload();
check("…on the page too, with Try again", (await mainText(ann)).includes("Not delivered: their site doesn't take messages yet")
  && (await ann.$('#chat form[action$="/retry"]')) !== null);
mode = "up";
await ann.$eval('#chat form[action$="/retry"] button', (b) => b.click());
check("Try again delivers it once their site takes messages", await waitFor(async () => (await bubbles(ann)).some((m) => m.text === "Hello old site" && m.state === "Delivered")));
mode = "down";
r = await call(ann, `/_messages/${fakeChat}/send`, { text: "Are you there?" });
check("a message to a site that's down says Sending…", r.json?.message?.state === "sending", r.text);
mode = "up";
const sent = await waitFor(async () => (await call(ann, `/_messages/${fakeChat}/since?after=0&pending=${r.json.message.id}`)).json?.states?.[0]?.state === "delivered", 30_000);
check("…and the outbox gets it there, and says Delivered", sent);
const got = received.find((g) => g.body.object?.content === "Are you there?");
check("…as a Note addressed to that one friend, with the key for that site", got?.path === "/_peer/message" && got.auth === `Bearer ${fakeKey}`
  && got.body.type === "Create" && got.body.object.type === "Note" && got.body.object.id.startsWith(`${A}/messages/`)
  && got.body.object.to?.[0] === `${FAKE}/` && got.body.actor === `${A}/`, JSON.stringify(got?.body).slice(0, 200));
fake.close();

// A friend can't fill the site: no more than 1 MB of messages a day.
const big = "€".repeat(4000); // 12 KB once stored
let bigRefused = 0;
for (let i = 0; i < 90; i += 1) {
  const res = await fetch(`${A}/_peer/message`, { method: "POST", headers: { Authorization: `Bearer ${fakeAnnKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(note(`${FAKE}/messages/big-${String(i).padStart(16, "0")}`, big)) });
  if (res.status === 429) bigRefused += 1;
}
const stored = sql(stateA, `SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM messages WHERE text LIKE '€%'`)[0].bytes;
check("a friend's messages are limited to 1 MB a day", bigRefused > 0 && stored <= 1_000_000, `${bigRefused} refused, ${stored} bytes`);
await ann.goto(`${A}/messages/${fakeChat}`); // read, so the counts below are only Sam's

// Notifications. A stand-in push service, and a "phone" whose keys only this test has: what reaches it is decrypted
// as a phone would, and the site's signature checked.
const pushes = [];
const pushService = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    if (req.url === "/push/gone") { res.writeHead(410).end(); return; }
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(201).end();
  });
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
  while (end > 0 && plain[end] === 0) end -= 1; // padding
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}
function signedBySite(push, siteKey) {
  const [, token, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(push.headers.authorization ?? "") ?? [];
  if (!token || k !== siteKey) return false;
  const [h, c, s] = token.split(".");
  const raw = Buffer.from(k, "base64url");
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  return JSON.parse(Buffer.from(c, "base64url")).aud === PUSH && verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
}

await ann.goto(`${A}/messages`);
const siteKey = await ann.$eval("#notify", (s) => s.dataset.key);
check("Messages has a section for notifications on this device", /^[\w-]{87}$/.test(siteKey) && (await mainText(ann)).includes("Notifications on this device"));
check("…which says they're only for messages", (await mainText(ann)).includes("never posts, comments or anything else"));
check("…and it checks this device", await waitFor(async () => /off for this device|can't show/.test(await ann.$eval("#notify-status", (p) => p.textContent))),
  await ann.$eval("#notify-status", (p) => p.textContent));
const device = { endpoint: `${PUSH}/push/phone`, keys: { p256dh: phone.getPublicKey().toString("base64url"), auth: phoneAuth.toString("base64url") } };
r = await call(ann, "/_push/devices", { ...device, endpoint: "https://evil.example/push", name: "Phone" });
check("a device at something that isn't a push service is refused", r.status === 400, r.text);
r = await call(ann, "/_push/devices", { ...device, keys: { p256dh: "AAAA", auth: device.keys.auth } });
check("…and one with bad keys", r.status === 400, r.text);
r = await call(ann, "/_push/devices", { ...device, name: "Android (home screen)", preview: true });
check("a device can say yes", r.json?.on === true && (await call(ann, "/_push/devices/state", { endpoint: device.endpoint })).json?.on === true, r.text);
const crossPush = await fetch(`${A}/_push/devices`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookies, "Content-Type": "application/json" },
  body: JSON.stringify({ ...device, endpoint: `${PUSH}/push/evil` }) });
check("…but another site can't add one", crossPush.status === 403, String(crossPush.status));
await ann.goto(`${A}/_admin`);
check("Your devices lists it, without its address", (await ann.$eval("#notifying", (l) => l.textContent)).includes("Android (home screen)")
  && !(await ann.content()).includes(device.endpoint));
await ann.goto(`${A}/`);
check("Home says a new device has notifications on", (await mainText(ann)).includes("Notifications about your messages were turned on for a new device (Android (home screen))"));
await Promise.all([settled(ann), ann.$eval('form[action="/_admin/notifications/seen"] button', (b) => b.click())]);
check("…until Ann says that was her", !(await mainText(ann)).includes("were turned on for a new device"));

// Sam's chat with Ann is unmuted and not open on Ann's screen: a message notifies.
await ann.goto(`${A}/`);
await sleep(26_000); // until Ann's chat no longer counts as open (push.js OPEN_SECONDS)
await call(sam, `/_messages/${samChatId}/send`, { text: "Running late, sorry!" });
check("a message from a friend notifies Ann's device", await waitFor(() => pushes.length === 1, 10_000), String(pushes.length));
const push = pushes[0];
const shown = push && decrypt(push.body);
check("…encrypted for that device, saying who it's from and what they said", shown?.title === "Sam Taylor" && shown.body === "Running late, sorry!"
  && shown.url === `/messages/${annChatId}` && shown.tag === `chat-${annChatId}` && shown.badge === 1, JSON.stringify(shown));
check("…signed by Ann's site, urgent, and kept a day at most", push && signedBySite(push, siteKey) && push.headers.urgency === "high"
  && Number(push.headers.ttl) <= 86400 && push.headers["content-encoding"] === "aes128gcm");

// Nothing for posts, comments or anything else: only messages.
const [keySamHolds] = sql(stateB, `SELECT their_key FROM connections WHERE origin = '${A}'`);
await fetch(`${A}/_peer/notify`, { method: "POST", headers: { Authorization: `Bearer ${keySamHolds.their_key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "Create", object: { type: "Note", id: `${B}/posts/post-1700000000-abcdef12`, content: "A new post" } }) });
await sleep(3000);
check("a friend's new post doesn't notify", pushes.length === 1, String(pushes.length));

// Not while the chat's open on screen.
await ann.goto(annChat);
await waitFor(() => sql(stateA, `SELECT viewing_at FROM chats WHERE id = ${annChatId}`)[0].viewing_at > 0);
await call(sam, `/_messages/${samChatId}/send`, { text: "Are you reading this?" });
await sleep(3000);
check("a message in the chat Ann has open doesn't notify", pushes.length === 1 && await waitFor(async () => (await bubbles(ann)).some((m) => m.text === "Are you reading this?")),
  String(pushes.length));

// Lock screen without the words.
await ann.goto(`${A}/`);
r = await call(ann, "/_push/devices/preview", { endpoint: device.endpoint, preview: false });
await sleep(26_000);
await call(sam, `/_messages/${samChatId}/send`, { text: "Secret plans" });
check("with the preview off, the lock screen says only who it's from", await waitFor(() => pushes.length === 2, 10_000)
  && decrypt(pushes[1].body).body === "New message" && decrypt(pushes[1].body).title === "Sam Taylor" && !pushes[1].body.includes("Secret"), r.text);
check("every notification is the same size, whatever it says", pushes[0].body.length === pushes[1].body.length, `${pushes[0].body.length} ${pushes[1].body.length}`);
check("a chat's next notification within the minute comes quietly", decrypt(pushes[0].body).quiet === false && decrypt(pushes[1].body).quiet === true);

// Muted: nothing.
await call(ann, `/_messages/${annChatId}/mute`, { muted: true });
await call(sam, `/_messages/${samChatId}/send`, { text: "Hello?" });
await sleep(3000);
check("a muted chat doesn't notify", pushes.length === 2, String(pushes.length));
await ann.goto(`${A}/`);
check("…or add to the menu's count", (await menuCount(ann)) === "", await menuCount(ann));
await ann.goto(`${A}/messages`);
check("…but Messages still shows it's unread", await ann.$$eval(".chat-row", (l) => l.find((a) => a.textContent.includes("Sam Taylor"))?.classList.contains("unread")));
await ann.goto(annChat);
check("…and the chat says what muting does", await ann.$eval("#muted-note", (p) => !p.hidden && p.textContent.includes("don't add to the Messages count")));
const muteButton = () => ann.$eval('form[action$="/mute"] button', (b) => b.textContent);
await ann.$eval('form[action$="/mute"] button', (b) => b.click()); // (a click at its place could land on the sticky header)
const unmuted = await waitFor(async () => (await muteButton()) === "Mute" && await ann.$eval("#muted-note", (p) => p.hidden));
check("Unmute works in place, without leaving the page", unmuted && ann.url() === annChat
  && sql(stateA, `SELECT muted FROM chats WHERE id = ${annChatId}`)[0].muted === 0);
await ann.$eval('form[action$="/mute"] button', (b) => b.click());
check("…and so does Mute", await waitFor(async () => (await muteButton()) === "Unmute") && sql(stateA, `SELECT muted FROM chats WHERE id = ${annChatId}`)[0].muted === 1);
await call(ann, `/_messages/${annChatId}/mute`, { muted: false });

// A device whose notifications stopped working is forgotten; one that says no, too.
r = await call(ann, "/_push/devices", { ...device, endpoint: `${PUSH}/push/gone`, name: "Old phone" });
await ann.goto(`${A}/`);
await sleep(26_000);
await call(sam, `/_messages/${samChatId}/send`, { text: "One more thing" });
check("a device the push service says is gone is forgotten", await waitFor(() => sql(stateA, "SELECT COUNT(*) AS n FROM push_devices")[0].n === 1, 10_000)
  && pushes.length === 3, String(pushes.length));
await ann.goto(`${A}/_admin`);
await Promise.all([ann.waitForNavigation(), ann.$eval('#notifying form[action$="/forget"] button', (b) => b.click())]);
check("a device can be turned off from Your devices", sql(stateA, "SELECT COUNT(*) AS n FROM push_devices")[0].n === 0
  && (await ann.$eval("#notifying", (l) => l.textContent)).includes("None"));
// Ann on a second device: it turns notifications on, then signs out there, which turns them off.
const linkToken = key();
sql(stateA, `INSERT INTO device_links (token_hash, user_id, expires_at) VALUES ('${hash(linkToken)}', 1, ${Math.floor(Date.now() / 1000) + 600})`);
const laptop = await (await browser.createBrowserContext()).newPage();
const laptopCdp = await laptop.createCDPSession();
await laptopCdp.send("WebAuthn.enable");
await laptopCdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
  hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await laptop.goto(`${A}/_auth/device/${linkToken}`);
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
await call(laptop, "/_push/devices", { ...device, endpoint: `${PUSH}/push/laptop`, name: "Mac (browser)" });
const before = sql(stateA, "SELECT COUNT(*) AS n FROM push_devices")[0].n;
await laptop.evaluate(() => fetch("/_auth/logout", { method: "POST" }));
check("signing out on a device turns its notifications off", before === 1 && sql(stateA, "SELECT COUNT(*) AS n FROM push_devices")[0].n === 0, String(before));
r = await call(ann, "/_push/devices/forget", { endpoint: device.endpoint });
check("…and a device can say no itself", r.json?.on === false);
pushService.close();

// A chat opened and left empty isn't listed; that friend stays under Start a chat.
befriend(stateA, A, "Ann Example", null, "http://localhost:8789", "Cat Example");
const [catHere] = sql(stateA, "SELECT id FROM connections WHERE origin = 'http://localhost:8789'");
await ann.goto(`${A}/friend/${catHere.id}/message`);
await ann.goto(`${A}/messages`);
check("an empty chat isn't listed, and its friend stays under Start a chat", !(await ann.$$eval(".chat-row", (l) => l.some((a) => a.textContent.includes("Cat Example"))))
  && (await ann.$$eval(".row a.chip", (l) => l.some((a) => a.textContent === "Cat Example"))));

// Delete one message (here only), and Messages in order.
await ann.goto(`${A}/messages`);
check("Messages puts the newest chat first", (await ann.$eval(".chat-row strong", (s) => s.textContent)) === "Sam Taylor");
await ann.goto(annChat);
const mineFirst = (await bubbles(ann)).find((m) => m.mine && m.text === "Are you coming tonight?");
await ann.$eval(`#chat li.msg[data-id="${mineFirst.id}"] form[action$="/delete"] button`, (b) => b.click());
check("deleting a message removes it here", await waitFor(async () => !(await bubbles(ann)).some((m) => m.id === mineFirst.id)));
check("…but not from Sam's site", sql(stateB, "SELECT COUNT(*) AS n FROM messages WHERE text = 'Are you coming tonight?'")[0].n === 1);

// Limits: a flood from one friend's site is cut off.
let limited = 0;
for (let i = 0; i < 125; i += 1) {
  const res = await toSam(note(`${A}/messages/flood-${String(i).padStart(16, "0")}`, `flood ${i}`));
  if (res.status === 429) limited += 1;
}
check("a flood of messages from one site is limited", limited > 0 && sql(stateB, "SELECT COUNT(*) AS n FROM messages WHERE text LIKE 'flood %'")[0].n < 125, String(limited));

// Sam removes Ann: both keep the chat, read-only.
const [annThere] = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`);
await sam.evaluate(async (id) => fetch(`/_admin/connections/${id}/disconnect`, { method: "POST" }), annThere.id);
check("Sam removes Ann as a friend", await waitFor(async () => sql(stateA, `SELECT COUNT(*) AS n FROM connections WHERE origin = '${B}'`)[0].n === 0));
await ann.goto(annChat);
check("after being removed, Ann still has the chat", (await bubbles(ann)).some((m) => m.text === "See you at 8"));
check("…but can't send in it", (await ann.$("#say")) === null && (await mainText(ann)).includes("not friends with Sam Taylor any more"));
r = await call(ann, `/_messages/${annChatId}/send`, { text: "hello?" });
check("…even by asking the site", r.status === 403, r.text);
await sam.goto(samChat);
check("Sam keeps it too", (await bubbles(sam)).some((m) => m.text === "See you at 8") && (await sam.$("#say")) === null);
await ann.goto(`${A}/messages`);
check("Messages says they're no longer friends", (await ann.$$eval(".chat-row", (l) => l.find((a) => a.textContent.includes("Sam Taylor"))?.textContent ?? ""))
  .includes("no longer friends"));

// Download everything has the messages, and nothing secret.
r = await call(ann, "/_admin/export/rows?table=messages");
const r2 = await call(ann, "/_admin/export/rows?table=chats");
const r3 = await call(ann, "/_admin/export/rows?table=settings");
check("Download everything includes messages and chats", r.json?.rows?.some((m) => m.text === "See you at 8") && r2.json?.rows?.length >= 2);
check("…with nothing secret in them, nor the site's notification key", !/their_key|key_hash|token|read_up_to|muted|viewing_at/.test(r.text + r2.text)
  && !/push_vapid|privateJwk/.test(r3.text));
check("…and nothing about devices", (await call(ann, "/_admin/export/rows?table=push_devices")).status === 400);

// Deleting a whole chat.
r = await call(ann, `/_messages/${annChatId}/delete`, {});
check("a whole chat can be deleted, here only", r.json?.deleted === true && (await ann.goto(annChat)).status() === 404
  && sql(stateB, "SELECT COUNT(*) AS n FROM messages WHERE text = 'See you at 8'")[0].n === 1);

// Add to home screen: a note on Home until it's installed or put off, the menu, and how to.
await sam.goto(`${B}/`);
check("every page links the app's manifest", (await sam.$eval('link[rel="manifest"]', (l) => l.href)) === `${B}/static/app/manifest.webmanifest`);
check("Home suggests adding afterwrd to the home screen", await waitFor(() => sam.$eval("#install-note", (n) => !n.hidden)));
check("…as does the menu", (await sam.$('header.site .menu a[href="/app"]')) !== null);
check("…and the service worker is ready for it", await waitFor(() => sam.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration("/")))));
await sam.$eval("#install-note [data-install-later]", (b) => b.click());
await sam.reload();
check("\"Not now\" puts it away for good on this device", await sam.$eval("#install-note", (n) => n.hidden));
await sam.goto(`${B}/app`);
check("the Add to home screen page says how, for Android and iPhone", /Install app/.test(await mainText(sam)) && /Add to Home Screen/.test(await mainText(sam)));
// What shows depends on the device: only its own steps, with the rest a tap away.
const visible = (page) => page.$eval("main", (m) => m.innerText);
let steps = await visible(sam);
check("…a computer sees only a computer's steps", /right-hand end of the address bar/.test(steps) && !/Install app/.test(steps) && !/Add to Home Screen/.test(steps));
await sam.$eval("[data-show-devices]", (b) => b.click());
steps = await visible(sam);
check("…and the others when asked", /Install app/.test(steps) && /Add to Home Screen/.test(steps) && !/open this page in Safari first/.test(steps));
const desktop = await browser.userAgent();
await sam.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1");
await sam.goto(`${B}/app`);
steps = await visible(sam);
check("an iPhone in Safari sees Safari's steps: ⋯, Share, Add to Home Screen", /⋯/.test(steps) && /Add to Home Screen/.test(steps)
  && /Open as Web App/.test(steps) && !/Install app/.test(steps) && !/open this page in Safari first/.test(steps));
await sam.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1");
await sam.goto(`${B}/app`);
steps = await visible(sam);
check("an iPhone in Chrome is told to open the page in Safari first", /open this page in Safari first/.test(steps) && /Add to Home Screen/.test(steps));
await sam.setUserAgent(desktop);
const manifest = await (await fetch(`${B}/static/app/manifest.webmanifest`)).json();
check("the app opens on Home, full screen", manifest.start_url === "/" && manifest.display === "standalone");

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
