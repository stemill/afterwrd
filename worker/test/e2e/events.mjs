// Personal events (src/events.js, docs/events-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and
// a group's Worker (G, 8790). Ann is friends with Bob and with Cat. Ann makes an event and invites Bob: only Bob sees
// it, by any route, until she invites Cat too. They answer from their own sites, see who's going, and hear about changes
// unless they said no. Ann takes an invitation back, calls it off, deletes it. Everyone's Events page shows a month's
// calendar of their own, friends' and groups' events. Bob has notifications on (a stand-in push service on 8795, which
// only counts: notifications.mjs looks inside them): his phone hears of each invitation and change, and nothing else.
//   node events.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
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
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateTimezone("Europe/London");
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
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });

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

/** Fills in an event form (the one inside `form`): a title, a day (YYYY-MM-DD), and optionally a time, place and words. */
async function fill(page, form, { title, day, time = "", place = "", words = "" }) {
  await page.$eval(`${form} input[name=title]`, (i, v) => { i.value = v; }, title);
  await page.$eval(`${form} input[name=start_date]`, (i, v) => { i.value = v; }, day);
  await page.$eval(`${form} input[name=start_time]`, (i, v) => { i.value = v; }, time);
  await page.$eval(`${form} input[name=place]`, (i, v) => { i.value = v; }, place);
  await page.$eval(`${form} textarea[name=text]`, (i, v) => { i.value = v; }, words);
}
/** Ticks the friends named in the guest picker inside `form`. */
async function tick(page, form, names) {
  for (const name of names) {
    await page.$$eval(`${form} .guest-options label`, (labels, who) => labels.find((l) => l.textContent.trim() === who)?.querySelector("input").click(), name);
  }
}
/** What an event block on the page says: its title, its lines, and the names in its lists. */
const eventIn = (page, scope = "main") => page.$eval(`${scope} .event`, (e) => ({
  title: e.querySelector(".event-title")?.textContent, meta: [...e.querySelectorAll(".event-what .meta")].map((m) => m.textContent).join(" | "),
  answered: e.querySelector(".answered")?.innerText ?? "", pressed: e.querySelector(".answers [aria-pressed=true]")?.value ?? null,
  answers: e.querySelectorAll(".answers button").length, off: e.classList.contains("cancelled"),
})).catch(() => null);

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2);
const bobId = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
const catId = sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id;
const annOnBob = sql(stateB, "SELECT id FROM connections")[0].id;
const annOnCat = sql(stateC, "SELECT id FROM connections")[0].id;
const bobKey = sql(stateB, "SELECT their_key FROM connections")[0].their_key; // Bob's key for Ann's site
const catKey = sql(stateC, "SELECT their_key FROM connections")[0].their_key;

// Bob's phone, with notifications on. What reaches it is counted.
const bobPhone = [];
const pushService = createServer((req, res) => { req.resume(); req.on("end", () => { bobPhone.push(req.url); res.writeHead(201).end(); }); }).listen(8795);
const phoneKeys = createECDH("prime256v1");
phoneKeys.generateKeys();
const bobDevice = await post(bob, "/_push/devices", { endpoint: "http://localhost:8795/push/bob", name: "Android (home screen)",
  keys: { p256dh: phoneKeys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
check("Bob turns on notifications on his phone", bobDevice.on === true, JSON.stringify(bobDevice));
/** Whether Bob's phone was told one thing more than `before`, by now (and nothing more, after a moment). */
async function phoneTold(before) {
  if (!(await waitFor(() => bobPhone.length > before))) return false;
  await new Promise((r) => setTimeout(r, 1000));
  return bobPhone.length === before + 1;
}

// An ordinary post first, which everyone sees, so the lists below aren't empty.
await post(ann, "/_admin/posts", { text: "Hello, everyone." });

// --- making one -------------------------------------------------------------------------------------------------------

const ahead = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const picnicDay = ahead(10);
const picnicMonth = picnicDay.slice(0, 7);
await ann.goto(`${A}/events`);
check("Events is in the menu", Boolean(await ann.$('nav.main a[href="/events"][aria-current="page"]')));
check("…with a calendar of the month and a form to make an event", Boolean(await ann.$(".calendar .cal-grid")) && Boolean(await ann.$("#make form")));
check("the form lists friends to invite", (await ann.$$eval("#make .guest-options label", (l) => l.map((x) => x.textContent.trim()))).join() === "Bob Example,Cat Example");
await ann.$eval("#make", (d) => { d.open = true; });
await fill(ann, "#make", { title: "Picnic", day: picnicDay, time: "13:00", place: "The park", words: "Bring a blanket." });
await tick(ann, "#make", ["Bob Example"]);
await Promise.all([ann.waitForNavigation(), ann.click("#make button.primary")]);
const key = new URL(ann.url()).pathname.split("/").pop();
check("making it opens its page", /^post-\d+-[0-9a-f]{8}$/.test(key), ann.url());
const postIdA = sql(stateA, `SELECT id FROM posts WHERE key = '${key}'`)[0].id;
check("…a post for those chosen only, with its event and who's invited", sql(stateA, `SELECT audience FROM posts WHERE id = ${postIdA}`)[0].audience === "chosen"
  && n(stateA, `events WHERE post_id = ${postIdA}`) === 1 && sql(stateA, `SELECT connection_id FROM post_audience WHERE post_id = ${postIdA}`).map((r) => r.connection_id).join() === String(bobId));
let annEvent = await eventIn(ann);
check("Ann's page shows her event, as hers, with no answer buttons", annEvent?.title === "Picnic" && annEvent.meta.includes("The park")
  && annEvent.meta.includes("1 invited") && annEvent.meta.includes("Only the people you invite") && annEvent.answers === 0, JSON.stringify(annEvent));
check("…and who's invited, not answered yet", (await text(ann, ".guests")).includes("Bob Example") && (await text(ann, ".guests")).includes("Not answered yet"));
check("…and the words about it", (await text(ann, "article.own .text")).includes("Bring a blanket."));
check("its words change with the event, not the 15-minute edit", (await ann.evaluate((id) => fetch(`/_admin/posts/${id}/edit`, { method: "POST",
  body: new URLSearchParams({ text: "Sneaky" }) }).then((r) => r.status), postIdA)) === 400
  && !(await ann.$('article.own header a[href^="#edit-p-"]')));

// --- Bob is invited -----------------------------------------------------------------------------------------------------

check("Bob's site is told he's invited", await waitFor(() => n(stateB, "inbox WHERE kind = 'invite'") === 1));
check("…and so is his phone (and nothing before: not Ann's post)", await phoneTold(0), String(bobPhone.length));
check("…and Ann's site notes that the invitation got there", await waitFor(() =>
  sql(stateA, `SELECT delivery FROM post_audience WHERE connection_id = ${bobId}`)[0]?.delivery === "delivered"));
check("…and keeps a copy for his calendar, not answered yet", sql(stateB, "SELECT answer, title, post_key FROM events_elsewhere")
  .some((e) => e.answer === null && e.title === "Picnic" && e.post_key === key));
await bob.goto(`${B}/activity`);
check("Bob's Notifications say Ann invited him", (await text(bob)).includes("Ann Example invited you to an event")
  && Boolean(await bob.$(`main a[href="/friend/${annOnBob}/posts/${key}"]`)));
await bob.goto(`${B}/events`);
check("Bob's Events page lists the invitation", (await text(bob, ".invitations")).includes("Picnic") && (await text(bob, ".invitations")).includes("Ann Example invited you"));

// --- Cat isn't: nothing reaches her, by any route -----------------------------------------------------------------------

const asCat = (path, body) => call(A, path, catKey, body);
const feedForCat = await (await asCat("/_peer/feed")).json();
check("Cat's feed from Ann's site leaves the event out", !JSON.stringify(feedForCat).includes(key) && !JSON.stringify(feedForCat).includes("Picnic")
  && feedForCat.orderedItems.length === 1, JSON.stringify(feedForCat).slice(0, 200));
const postsForCat = await (await asCat("/_peer/posts")).json();
check("…as do her pages of Ann's posts, counts included", !JSON.stringify(postsForCat).includes("Picnic") && postsForCat.totalItems === 1);
check("…and asking for it by its address", (await asCat(`/_peer/posts/${key}`)).status === 404);
check("…or commenting on it", (await asCat("/_peer/comments", { type: "Note", content: "Can I come?", inReplyTo: `${A}/posts/${key}` })).status === 404);
check("…or answering it", (await asCat("/_peer/answer", { type: "Accept", object: `${A}/posts/${key}` })).status === 404);
check("…or answering a poll in it", (await asCat("/_peer/vote", { inReplyTo: `${A}/posts/${key}`, "afterwrd:choices": [0] })).status === 404);
check("Cat's site was told nothing", n(stateC, "inbox") === 1 && n(stateC, "events_elsewhere") === 0, JSON.stringify(sql(stateC, "SELECT kind FROM inbox")));
await cat.goto(`${C}/`);
check("…and her Home doesn't show it", !(await text(cat)).includes("Picnic") && (await text(cat)).includes("Hello, everyone."));
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
check("…nor its address on her site", !(await text(cat)).includes("Picnic") && (await text(cat)).includes("isn't there any more"));
const feedForBob = await (await call(A, "/_peer/feed", bobKey)).json();
check("Bob's feed has it, with the event", JSON.stringify(feedForBob).includes('"name":"Picnic"') && feedForBob.orderedItems.length === 2);

// --- Bob answers ----------------------------------------------------------------------------------------------------------

await bob.goto(`${B}/events`);
await Promise.all([bob.waitForNavigation(), bob.click('.invitation button[value="going"]')]);
check("Bob says he's going, from Events", sql(stateA, `SELECT answer FROM event_answers WHERE post_id = ${postIdA} AND connection_id = ${bobId}`)[0]?.answer === "going");
check("…his copy says so, and the invitation's answered", sql(stateB, "SELECT answer FROM events_elsewhere")[0].answer === "going" && !(await bob.$(".invitations")));
await bob.goto(`${B}/events?month=${picnicMonth}`);
const cell = await bob.$$eval(".cal-day", (cells) => cells.filter((c) => c.querySelector(".cal-event")).map((c) => ({
  day: c.querySelector(".cal-num").textContent.trim(), events: [...c.querySelectorAll(".cal-event")].map((e) => e.className + ":" + e.textContent.trim()) })));
check("…and it's on his calendar, on its day, as a friend's", cell.length === 1 && cell[0].day === String(Number(picnicDay.slice(8)))
  && /cal-friend/.test(cell[0].events[0]) && cell[0].events[0].includes("13:00") && cell[0].events[0].includes("Picnic"), JSON.stringify(cell));
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
let bobEvent = await eventIn(bob);
check("Bob's page for it shows his answer, who's going, and who can see it", bobEvent?.pressed === "going" && /Going\s+You/.test(bobEvent.answered)
  && bobEvent.meta.includes("Only the people Ann Example invited"), JSON.stringify(bobEvent));
await Promise.all([settled(bob), bob.click('.event .answers button[value="maybe"]')]);
check("…he can change his mind there, in place", sql(stateA, `SELECT answer FROM event_answers WHERE connection_id = ${bobId}`)[0]?.answer === "maybe"
  && (await eventIn(bob))?.pressed === "maybe");
await bob.type(`#f${annOnBob}-${key} form.say textarea`, "Can't wait!");
await Promise.all([settled(bob), bob.click(`#f${annOnBob}-${key} form.say button`)]);
check("Bob comments on it; Ann's site keeps it", n(stateA, `comments WHERE target = '${key}' AND origin = '${B}'`) === 1);
const ics = await bob.evaluate((p) => fetch(p).then(async (r) => [r.headers.get("content-type"), await r.text()]), `/friend/${annOnBob}/posts/${key}/event.ics`);
check("…and can add it to his own calendar", ics[0]?.startsWith("text/calendar") && ics[1].includes("SUMMARY:Picnic") && ics[1].includes("LOCATION:The park"));
await Promise.all([settled(bob), bob.click('.event .answers button[value="going"]')]);

await ann.goto(`${A}/posts/${key}`);
annEvent = await eventIn(ann);
check("Ann sees Bob's going", /Going\s+Bob Example/.test(annEvent?.answered ?? ""), JSON.stringify(annEvent));

// A friend whose site is from before events refuses the invitation (as 0.45.0's does, with 400): Ann sees why.
sql(stateA, `INSERT INTO post_audience (post_id, connection_id, added_at, delivery) VALUES (${postIdA}, 999, 1, 'refused')`);
sql(stateA, "INSERT INTO connections (id, origin, name, key_hash, created_at, connected_at, approved_at) VALUES (999, 'https://old.example', 'Old Friend', 'x', 1, 1, 1)");
await ann.goto(`${A}/posts/${key}`);
check("an invitation an older site didn't take says so on Ann's guest list", (await text(ann, ".guests")).includes("Their site didn't take the invitation: it may need updating"));
sql(stateA, "DELETE FROM post_audience WHERE connection_id = 999");
sql(stateA, "DELETE FROM connections WHERE id = 999");

// --- inviting Cat too ------------------------------------------------------------------------------------------------------

check("only Cat's left to invite", (await ann.$$eval(".invite-more .guest-options label", (l) => l.map((x) => x.textContent.trim()))).join() === "Cat Example");
await tick(ann, ".invite-more", ["Cat Example"]);
await Promise.all([ann.waitForNavigation(), ann.click(".invite-more button.primary")]);
check("Ann invites Cat too", n(stateA, `post_audience WHERE post_id = ${postIdA}`) === 2);
check("Cat's site is told", await waitFor(() => n(stateC, "inbox WHERE kind = 'invite'") === 1));
check("…and Bob's isn't told again", n(stateB, "inbox WHERE kind = 'invite'") === 1);
check("now Cat can read it", (await asCat(`/_peer/posts/${key}`)).status === 200);
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
await Promise.all([settled(cat), cat.click('.event .answers button[value="maybe"]')]);
check("Cat might go", sql(stateA, `SELECT answer FROM event_answers WHERE connection_id = ${catId}`)[0]?.answer === "maybe");
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
bobEvent = await eventIn(bob);
check("everyone invited sees who's going and who might, by name", /Going\s+You/.test(bobEvent.answered) && /Maybe\s+Cat Example/.test(bobEvent.answered)
  && bobEvent.meta.includes("2 invited"), JSON.stringify(bobEvent));
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
await Promise.all([settled(cat), cat.click('.event .answers button[value="no"]')]);
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
bobEvent = await eventIn(bob);
check("…but not who can't go", !bobEvent.answered.includes("Cat") && !JSON.stringify(await (await call(A, `/_peer/posts/${key}`, bobKey)).json()).includes("Cat Example"),
  JSON.stringify(bobEvent));
await ann.goto(`${A}/posts/${key}`);
check("…which only Ann sees", /Can't go\s+Cat Example/.test((await eventIn(ann)).answered));
await cat.goto(`${C}/events?month=${picnicMonth}`);
check("an event Cat can't go to isn't on her calendar", !(await text(cat, ".calendar")).includes("Picnic"));

// --- changing it -----------------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}/event`);
check("Ann's change form is filled in", (await ann.$eval("input[name=title]", (i) => i.value)) === "Picnic" && (await ann.$eval("input[name=start_time]", (i) => i.value)) === "13:00");
await ann.$eval("input[name=start_time]", (i) => { i.value = "14:00"; });
let phoneBefore = bobPhone.length;
await Promise.all([ann.waitForNavigation(), ann.click(".event-form button.primary")]);
check("Ann moves it an hour later", (await eventIn(ann))?.meta.includes("14:00"));
check("Bob, going, is told", await waitFor(() => n(stateB, "inbox WHERE kind = 'changed'") === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…and his copy moves with it", sql(stateB, "SELECT starts_at FROM events_elsewhere")[0].starts_at
  === sql(stateA, `SELECT starts_at FROM events WHERE post_id = ${postIdA}`)[0].starts_at);
check("Cat, who said no, isn't", n(stateC, "inbox WHERE kind = 'changed'") === 0);
await ann.goto(`${A}/posts/${key}/event`);
await ann.$eval("input[name=place]", (i) => { i.value = "The other park"; });
await Promise.all([ann.waitForNavigation(), ann.click(".event-form button.primary")]);
check("another change straight away is refused", (await text(ann)).includes("You've just changed this event"));
await ann.goto(`${A}/posts/${key}/event`);
await ann.$eval("textarea[name=text]", (i) => { i.value = "Bring a blanket, and a flask."; });
await Promise.all([ann.waitForNavigation(), ann.click(".event-form button.primary")]);
check("…but changing only its words is fine, and tells no one", (await text(ann, "article.own .text")).includes("a flask")
  && n(stateB, "inbox WHERE kind = 'changed'") === 1 && bobPhone.length === phoneBefore + 1);

// --- forged notes and answers ------------------------------------------------------------------------------------------------

const annKeyOnBob = sql(stateA, `SELECT their_key FROM connections WHERE id = ${bobId}`)[0].their_key; // Ann's key for Bob's site
const toBob = (note) => call(B, "/_peer/notify", annKeyOnBob, note);
const fakeEvent = { type: "Event", name: "Fake", startTime: new Date(Date.now() + 5 * 86400_000).toISOString(), "afterwrd:timeZone": "Europe/London" };
check("an invitation to someone else's post is refused", (await toBob({ type: "Invite", object: { type: "Note", id: `${C}/posts/${key}`, "afterwrd:event": fakeEvent } })).status === 400);
check("…as is one without a proper event", (await toBob({ type: "Invite", object: { type: "Note", id: `${A}/posts/post-1-00000000`, "afterwrd:event": { type: "Event" } } })).status === 400);
check("a change to an event Bob wasn't invited to is ignored", (await toBob({ type: "Update", "afterwrd:change": "changed",
  object: { type: "Note", id: `${A}/posts/post-1-00000001`, "afterwrd:event": fakeEvent } })).status === 202 && n(stateB, "events_elsewhere") === 1);
check("Bob's answers must be one of the three", (await call(A, "/_peer/answer", bobKey, { type: "Like", object: `${A}/posts/${key}` })).status === 400);
check("…and about an event", (await call(A, "/_peer/answer", bobKey, { type: "Accept", object: `${A}/posts/post-1-00000000` })).status === 404);
check("…from a friend", (await call(A, "/_peer/answer", "x".repeat(43), { type: "Accept", object: `${A}/posts/${key}` })).status === 401);
const overEvent = { ...fakeEvent, startTime: new Date(Date.now() - 5 * 86400_000).toISOString() };
check("an invitation to something already over is let go, keeping nothing", (await toBob({ type: "Invite",
  object: { type: "Note", id: `${A}/posts/post-1-00000002`, "afterwrd:event": overEvent } })).status === 202
  && n(stateB, "events_elsewhere WHERE post_key = 'post-1-00000002'") === 0);
const invitesBefore = n(stateB, "inbox WHERE kind = 'invite'");
check("an invitation sent again changes nothing", (await toBob({ type: "Invite", object: { type: "Note", id: `${A}/posts/${key}`,
  "afterwrd:event": { ...fakeEvent, name: "Something else" } } })).status === 202 && n(stateB, "inbox WHERE kind = 'invite'") === invitesBefore
  && n(stateB, "events_elsewhere WHERE title = 'Something else'") === 0);

// --- taking an invitation back --------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}`);
await ann.$eval(".guests", (d) => { d.open = true; });
await Promise.all([settled(ann), ann.$$eval(".guest-list li", (lis) => lis.find((li) => li.textContent.includes("Cat Example")).querySelector("button").click())]);
check("Ann takes back Cat's invitation", n(stateA, `post_audience WHERE connection_id = ${catId}`) === 0 && n(stateA, `event_answers WHERE connection_id = ${catId}`) === 0);
check("Cat's site forgets it, and its notification, quietly", await waitFor(() => n(stateC, "events_elsewhere") === 0 && n(stateC, "inbox WHERE kind = 'invite'") === 0));
check("…and Cat can't read it any more", (await asCat(`/_peer/posts/${key}`)).status === 404);

// --- a group's events on the calendar too -----------------------------------------------------------------------------------------

const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Walkers", about: "" });
const annGroup = (await post(ann, "/_groups/create/claim", { id: waiting.id })).id;
await ann.goto(`${A}/groups/${annGroup}/calendar?month=${picnicMonth}`);
check("a group's calendar is a month grid too", Boolean(await ann.$(".calendar .cal-grid")));
await ann.$eval("details.add-event", (d) => { d.open = true; });
await fill(ann, "details.add-event", { title: "Hill walk", day: ahead(12), time: "09:30" });
await Promise.all([ann.waitForNavigation(), ann.click("details.add-event button.primary")]);
await ann.goto(`${A}/groups/${annGroup}/calendar?month=${ahead(12).slice(0, 7)}`);
check("…with the group's event on its day", (await text(ann, ".calendar")).includes("Hill walk"));
await ann.goto(`${A}/events?month=${picnicMonth}`);
const annCal = await ann.$$eval(".cal-event", (es) => es.map((e) => e.className + ":" + e.textContent.trim()));
const sameMonth = ahead(12).slice(0, 7) === picnicMonth;
check("Ann's Events calendar has her own event and her group's", annCal.some((e) => /cal-own/.test(e) && e.includes("Picnic"))
  && (!sameMonth || annCal.some((e) => /cal-group/.test(e) && e.includes("Hill walk"))), JSON.stringify(annCal));
await ann.goto(`${A}/events?month=${picnicMonth}&day=${picnicDay}`);
check("choosing a day lists that day's events", (await text(ann, ".cal-list")).includes("Picnic") && !(await text(ann, ".cal-list")).includes("Hill walk")
  && Boolean(await ann.$(".cal-day.chosen")));
await ann.goto(`${A}/groups`);
check("Groups points to Events instead of its own Coming up", !(await ann.$(".coming-up")) && Boolean(await ann.$('main a[href="/events"]')));
// Week and list views.
await ann.goto(`${A}/events?view=week&week=${picnicDay}`);
check("the Week view shows that week, day by day", (await text(ann, ".cal-week")).includes("Picnic")
  && (await ann.$$(".cal-week-day")).length === 7 && Boolean(await ann.$('.cal-views a[aria-current="page"][href="/events?view=week"]')));
await ann.goto(`${A}/events?view=list`);
check("the List view shows everything coming up", (await text(ann, ".cal-upcoming")).includes("Picnic") && (await text(ann, ".cal-upcoming")).includes("Hill walk"));

// --- repeating events, in a group --------------------------------------------------------------------------------------------------

await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const joinLink = await ann.$eval("#link-url", (i) => i.value);
await bob.goto(`${B}/groups`);
await bob.type("#join input[name=link]", joinLink);
await Promise.all([bob.waitForNavigation(), bob.click("#join button:not([type=button])")]);
await Promise.all([bob.waitForNavigation({ timeout: 30_000 }), bob.click("#go")]);
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
const bobGroupKey = sql(stateB, "SELECT their_key FROM groups")[0].their_key;
check("Bob joins Ann's group", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 2);

const clubDays = [14, 21, 28, 35].map(ahead);
await ann.goto(`${A}/groups/${annGroup}/calendar`);
await ann.$eval("details.add-event", (d) => { d.open = true; });
await fill(ann, "details.add-event", { title: "Book club", day: clubDays[0], time: "19:00", place: "The library" });
await ann.$eval("details.add-event input[name=start_date]", (i) => i.dispatchEvent(new Event("change")));
const choices = await ann.$$eval("details.add-event select[name=repeat] option:not([hidden])", (o) => o.map((x) => x.textContent));
check("the form offers ways to repeat, naming the day", choices[0] === "Doesn't repeat" && /^Every week on \w+day$/.test(choices[1]) && choices.length >= 4, JSON.stringify(choices));
await ann.select("details.add-event select[name=repeat]", "weekly");
await ann.$eval("details.add-event input[name=repeat_until]", (i, v) => { i.value = v; }, clubDays[3]);
const invalid = await ann.$eval("details.add-event form", (f) => [...f.elements].filter((el) => el.willValidate && !el.checkValidity())
  .map((el) => `${el.name}: ${el.validationMessage}`).join("; "));
check("the repeating event's form is complete", !invalid, invalid);
// Sent as its button would (a click can land on the sticky header when the long form scrolls under it).
await Promise.all([ann.waitForNavigation(), ann.$eval("details.add-event form", (f) => f.requestSubmit(f.querySelector("button.primary")))]);
const club = sql(stateG, "SELECT * FROM group_events WHERE title = 'Book club'")[0];
check("Ann adds a weekly event; the group keeps its rule", club?.rrule === `FREQ=WEEKLY;UNTIL=${clubDays[3].replace(/-/g, "")}` && club.last_ends_at > club.starts_at, JSON.stringify(club));
check("…and she's going to its first date", sql(stateG, `SELECT date FROM group_answers WHERE post_id = ${club.post_id}`).map((r) => r.date).join() === clubDays[0]);

await bob.goto(`${B}/groups/${bobGroup}/posts/${club.post_id}`);
check("Bob sees how it repeats, and every date", (await text(bob, ".event")).includes("Every week on") && (await bob.$$(".event-dates li")).length === 4);
await Promise.all([settled(bob), bob.click(`#d-${clubDays[1]} .answers button[value="going"]`)]);
check("Bob says he's going to the second date only", sql(stateG, `SELECT date, answer FROM group_answers WHERE post_id = ${club.post_id} AND origin = '${B}'`)
  .map((r) => `${r.date}:${r.answer}`).join() === `${clubDays[1]}:going`);
check("…his site keeps that date", sql(stateB, `SELECT date FROM events_elsewhere WHERE post_id = ${club.post_id}`).map((r) => r.date).join() === clubDays[1]);
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.post_id}`);
check("…and its guest list names him there, and not on the others", /Going\s+You/.test(await text(bob, `#d-${clubDays[1]}`))
  && !(await text(bob, `#d-${clubDays[2]}`)).includes("You"));
check("an answer to a repeating event without a date is refused", (await call(G, `/_group/events/${club.post_id}/answer`, bobGroupKey, { answer: "going" })).status === 400);
check("…as is one to a date it doesn't have", (await call(G, `/_group/events/${club.post_id}/answer`, bobGroupKey, { answer: "going", date: ahead(15) })).status === 400);
const ics2 = await bob.evaluate((p) => fetch(p).then((r) => r.text()), `/groups/${bobGroup}/posts/${club.post_id}/event.ics`);
// Each later date's moment (RDATE): a rule from a start in UTC would drift by an hour when the clocks change.
const rdates = (ics) => (/^RDATE:(.*)$/m.exec(ics.replace(/\r\n /g, ""))?.[1] ?? "").split(",").filter(Boolean);
check("its calendar file lists every date", rdates(ics2).length === 3 && !/RRULE/.test(ics2), ics2.slice(0, 400));
await bob.goto(`${B}/events?view=list`);
const listed = await bob.$$eval(".cal-upcoming .plan-list li", (l) => l.map((x) => x.innerText.replace(/\s+/g, " ")).filter((t) => t.includes("Book club")));
check("Bob's List shows each date, marked going or not", listed.length === 4 && listed.filter((t) => t.includes("You're going")).length === 1, JSON.stringify(listed));

// Calling off one date.
phoneBefore = bobPhone.length;
check("nothing since reached Bob's phone: not forged notes, answers, comments, or a group's new event", phoneBefore === 2, String(phoneBefore));
await ann.goto(`${A}/groups/${annGroup}/posts/${club.post_id}`);
await Promise.all([settled(ann), ann.click(`#d-${clubDays[1]} .call-off-date button`)]);
check("Ann calls off the second date", n(stateG, `group_event_skips WHERE post_id = ${club.post_id} AND date = '${clubDays[1]}'`) === 1
  && !sql(stateG, `SELECT cancelled_at FROM group_events WHERE post_id = ${club.post_id}`)[0].cancelled_at);
check("Bob, going that day, is told", await waitFor(() => n(stateB, `group_inbox WHERE kind = 'cancelled' AND date = '${clubDays[1]}'`) === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…his copy of that date is off", Boolean(sql(stateB, `SELECT cancelled_at FROM events_elsewhere WHERE post_id = ${club.post_id}`)[0]?.cancelled_at));
await bob.goto(`${B}/activity`);
check("…and Notifications say one date's off", (await text(bob)).includes("called off one date of an event you're going to"));
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.post_id}`);
check("the other dates go on", (await bob.$$(".event-dates li.off")).length === 1 && Boolean(await bob.$(`#d-${clubDays[2]} .answers`)));
check("no answer is taken for the date that's off", (await call(G, `/_group/events/${club.post_id}/answer`, bobGroupKey, { answer: "maybe", date: clubDays[1] })).status === 400);
const icsOff = await bob.evaluate((p) => fetch(p).then((r) => r.text()), `/groups/${bobGroup}/posts/${club.post_id}/event.ics`);
check("…and the calendar file leaves it out", rdates(icsOff).join() === rdates(ics2).slice(1).join(), icsOff.slice(0, 400));
// A group can't pass off a change as calling a date off, or move a series to start on a day that's over.
const groupKeyForBob = sql(stateG, `SELECT their_key FROM group_members WHERE origin = '${B}'`)[0].their_key;
const clubNote = (change, date) => call(B, "/_member/notify", groupKeyForBob, { type: "Update", "afterwrd:change": change, "afterwrd:date": date,
  actor: { type: "Person", name: "Ann Example" }, object: { type: "Note", id: `${G}/groups/1/posts/${club.post_id}`,
    "afterwrd:event": { type: "Event", name: "Book club", startTime: new Date(club.starts_at * 1000).toISOString(),
      endTime: new Date(club.ends_at * 1000).toISOString(), "afterwrd:timeZone": "Europe/London", "afterwrd:rrule": club.rrule } } });
check("a 'changed' note naming one date is refused", (await clubNote("changed", clubDays[2])).status === 400);
const annGroupKey = sql(stateA, "SELECT their_key FROM groups")[0].their_key;
const weekAgo = new Date(Date.now() - 7 * 86400_000);
const pastStart = await call(G, `/_group/events/${club.post_id}/edit`, annGroupKey, { type: "Note", content: "", "afterwrd:event": {
  type: "Event", name: "Book club", startTime: weekAgo.toISOString(), "afterwrd:timeZone": "Europe/London",
  "afterwrd:rrule": `FREQ=WEEKLY;UNTIL=${clubDays[3].replace(/-/g, "")}` } });
check("…and a series can't be moved to start on a day that's over", pastStart.status === 400);

// Changing the time moves every date, and Bob's copies with it.
await Promise.all([settled(bob), bob.click(`#d-${clubDays[2]} .answers button[value="maybe"]`)]);
await ann.goto(`${A}/groups/${annGroup}/posts/${club.post_id}/edit`);
check("the change form keeps how it repeats", (await ann.$eval("select[name=repeat]", (el) => el.value)) === "weekly"
  && (await ann.$eval("input[name=repeat_until]", (i) => i.value)) === clubDays[3]);
await ann.$eval("input[name=start_time]", (i) => { i.value = "19:30"; });
phoneBefore = bobPhone.length;
await Promise.all([ann.waitForNavigation(), ann.click(".event-form button.primary")]);
check("Bob, who might go, is told it changed", await waitFor(() => n(stateB, "group_inbox WHERE kind = 'changed'") >= 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
const copies = sql(stateB, `SELECT date, starts_at FROM events_elsewhere WHERE post_id = ${club.post_id} ORDER BY date`);
const londonTime = (t) => new Date(t * 1000).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
check("…and each of his dates moves to 19:30", copies.length === 2 && copies.every((c) => londonTime(c.starts_at) === "19:30"), JSON.stringify(copies));
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.post_id}`);
await bob.screenshot({ path: `${OUT}/events-repeating-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });

await ann.setViewport({ width: 1280, height: 900 });
await ann.goto(`${A}/events?month=${picnicMonth}`);
await ann.screenshot({ path: `${OUT}/events-calendar.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/events?month=${picnicMonth}`);
check("on a phone, days show dots instead of titles", await bob.$eval(".cal-day .cal-dots", (d) => getComputedStyle(d).display !== "none")
  && await bob.$eval(".cal-events", (d) => getComputedStyle(d).display === "none"));
check("…and the page doesn't scroll sideways", await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await bob.screenshot({ path: `${OUT}/events-calendar-phone.png`, fullPage: true });
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
await bob.screenshot({ path: `${OUT}/events-invited-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });

// --- calling it off, and deleting ------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}`);
phoneBefore = bobPhone.length;
await Promise.all([settled(ann), ann.click('.event form[action$="/cancel"] button')]);
check("Ann calls it off", Boolean(sql(stateA, `SELECT cancelled_at FROM events WHERE post_id = ${postIdA}`)[0].cancelled_at) && (await eventIn(ann))?.off);
check("Bob is told", await waitFor(() => n(stateB, "inbox WHERE kind = 'cancelled'") === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…his copy says so", Boolean(sql(stateB, "SELECT cancelled_at FROM events_elsewhere")[0].cancelled_at));
check("…and answers aren't taken any more", (await call(A, "/_peer/answer", bobKey, { type: "Reject", object: `${A}/posts/${key}` })).status === 400);
await bob.goto(`${B}/activity`);
check("Bob's Notifications say it's off", (await text(bob)).includes("Ann Example called off an event you were invited to"));

// Another, deleted while still to come: those invited are told it's off.
await ann.goto(`${A}/events`);
await ann.$eval("#make", (d) => { d.open = true; });
await fill(ann, "#make", { title: "Quiz night", day: ahead(20), time: "19:30" });
await tick(ann, "#make", ["Bob Example"]);
await Promise.all([ann.waitForNavigation(), ann.click("#make button.primary")]);
const quiz = new URL(ann.url()).pathname.split("/").pop();
const quizId = sql(stateA, `SELECT id FROM posts WHERE key = '${quiz}'`)[0].id;
check("Bob's invited to the quiz", await waitFor(() => n(stateB, `events_elsewhere WHERE post_key = '${quiz}'`) === 1));
const exported = await ann.evaluate(() => Promise.all(["events", "event_answers", "post_audience"].map((t) => fetch(`/_admin/export/rows?table=${t}`).then((r) => r.json()))));
check("Download everything includes events, answers and who they're for", exported.every((r) => r.rows?.length > 0), JSON.stringify(exported).slice(0, 200));
await ann.click("article.own header details.more summary");
await Promise.all([ann.waitForNavigation(), ann.click("article.own header .delete")]);
check("deleting it takes its event and who it was for", n(stateA, `events WHERE post_id = ${quizId}`) === 0 && n(stateA, `post_audience WHERE post_id = ${quizId}`) === 0);
check("…and tells Bob it's off", await waitFor(() => n(stateB, "inbox WHERE kind = 'cancelled'") === 2));

// Removing a friend forgets what they were invited to, on both sides.
await ann.goto(`${A}/friend/${bobId}/posts`);
await ann.$eval('form[action$="/disconnect"]', (f) => f.requestSubmit());
await waitFor(() => n(stateA, `connections WHERE id = ${bobId}`) === 0);
check("removing Bob forgets his invitations and answers", n(stateA, `post_audience WHERE connection_id = ${bobId}`) === 0
  && n(stateA, `event_answers WHERE connection_id = ${bobId}`) === 0);
check("…and his site forgets Ann's events (not the group's)", await waitFor(() => n(stateB, "events_elsewhere WHERE connection_id IS NOT NULL") === 0)
  && n(stateB, "events_elsewhere WHERE group_id IS NOT NULL") > 0);

check("no script errors", errors.length === 0, errors.join("; "));
pushService.close();
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
