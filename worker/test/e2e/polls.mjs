// Polls: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's Worker (G, 8790). Ann is friends
// with Bob and with Cat, who aren't friends with each other. Ann asks a poll in a post: everyone sees how many chose
// what, and their own choice; only Ann sees who. Answers can change, a poll can take several choices and close by
// itself or when its writer closes it; forged answers are refused. Then the same in a group, where only the writer's
// site is told who chose what, and leaving takes a member's answers with them.
//   node polls.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
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
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

/** `inviter` makes a friend link, `friend` pastes it into their own site and confirms, `inviter` approves. */
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

/** Writes a post with a poll in the composer on the page open now. */
async function ask(page, question, options, { multiple = false, closes = null } = {}) {
  await page.type("#composer textarea", question);
  await page.click("#composer .add-poll");
  for (let i = 2; i < options.length; i++) await page.click("#composer .add-option");
  const boxes = await page.$$("#composer .poll-options input");
  for (const [i, option] of options.entries()) await boxes[i].type(option);
  if (multiple) await page.click("#composer input[name=multiple]");
  if (closes) await page.$eval("#composer input[name=closes]", (i, v) => { i.value = v; }, closes);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
/** The first poll on the page within `card`: its options' names, counts and which are chosen, and what it says. */
const pollIn = (page, card) => page.$eval(`${card} .poll`, (p) => (p.querySelector(".poll-who")?.setAttribute("open", ""), {
  options: [...p.querySelectorAll(".poll-option")].map((o) => ({ name: o.querySelector(".name").textContent,
    count: Number(o.querySelector(".tally").firstChild.textContent), chosen: o.classList.contains("chosen") })),
  facts: p.querySelector(":scope > .meta").textContent, who: p.querySelector(".poll-who")?.innerText ?? null,
  buttons: p.querySelectorAll("button.poll-option").length, ticks: p.querySelectorAll("input[type=checkbox]").length,
  canClose: Boolean([...p.querySelectorAll("button")].find((b) => b.textContent === "Close poll")),
})).catch(() => null);
const counts = (poll) => poll?.options.map((o) => o.count).join(",");
const chosen = (poll) => poll?.options.filter((o) => o.chosen).map((o) => o.name).join(",");
async function choose(page, card, i) {
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click(`${card} .poll button.poll-option:nth-of-type(${i + 1})`)]);
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat, who aren't friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2
  && n(stateB, `connections WHERE origin = '${C}'`) === 0);

// The composer's checks, before anything's sent.
await ann.goto(`${A}/posts`);
check("the composer has a Poll button, its fields folded away", Boolean(await ann.$("#composer .add-poll")) && await ann.$eval("#composer .poll-maker", (f) => f.hidden));
await ann.click("#composer .add-poll");
check("…which opens them, asking for a question", await ann.$eval("#composer textarea", (t) => t.placeholder) === "Ask a question"
  && (await ann.$$("#composer .poll-options input")).length === 2);
await ann.type("#composer .poll-options input", "Only one");
await ann.click("#composer button.post");
check("a poll needs a question", (await text(ann, "#composer .error")) === "Write the question your poll asks.");
await ann.type("#composer textarea", "Is one option enough?");
await ann.click("#composer button.post");
check("…and two options", (await text(ann, "#composer .error")) === "Give your poll at least two options.");
await ann.setViewport({ width: 390, height: 844 });
await ann.screenshot({ path: `${OUT}/poll-composer-phone.png` });
await ann.setViewport({ width: 1280, height: 800 });
check("nothing was posted", n(stateA, "posts WHERE source = 'afterwrd'") === 0);
check("the server says the same", (await post(ann, "/_admin/posts", { text: "Q", poll: { options: ["a"] } })).status === 400
  && (await post(ann, "/_admin/posts", { text: "", poll: { options: ["a", "b"] } })).status === 400
  && (await post(ann, "/_admin/posts", { text: "Q", poll: { options: ["a", "A"] } })).status === 400);

// Ann asks.
await ann.goto(`${A}/posts`);
await ask(ann, "Which Saturday for the walk?", ["Sat 5th", "Sat 12th", "Sat 19th"]);
let annPoll = await pollIn(ann, "article.own");
check("Ann's post shows her poll: three options, nobody's answered", annPoll?.options.map((o) => o.name).join() === "Sat 5th,Sat 12th,Sat 19th"
  && counts(annPoll) === "0,0,0" && annPoll.facts.includes("Nobody's answered yet") && annPoll.buttons === 3 && annPoll.canClose, JSON.stringify(annPoll));
check("…kept with the post", n(stateA, "polls") === 1);
await choose(ann, "article.own", 0);
annPoll = await pollIn(ann, "article.own");
check("one tap answers it", counts(annPoll) === "1,0,0" && chosen(annPoll) === "Sat 5th" && annPoll.facts.includes("1 person answered"), JSON.stringify(annPoll));
check("…and lands back on the poll", new URL(ann.url()).hash === `#poll-${sql(stateA, "SELECT id FROM posts WHERE source = 'afterwrd'")[0].id}`, ann.url());

// Bob answers from his Home; he sees the totals and his own choice, never who.
await bob.goto(`${B}/`);
let bobPoll = await pollIn(bob, "article.from-friend");
check("Bob's Home shows Ann's poll with its totals", counts(bobPoll) === "1,0,0" && !chosen(bobPoll) && bobPoll.who === null && !bobPoll.canClose, JSON.stringify(bobPoll));
await choose(bob, "article.from-friend", 1);
bobPoll = await pollIn(bob, "article.from-friend");
check("Bob answers it from his own site", counts(bobPoll) === "1,1,0" && chosen(bobPoll) === "Sat 12th", JSON.stringify(bobPoll));
check("…Ann's site keeps it, under his name", sql(stateA, "SELECT voter, name, choices FROM poll_votes WHERE voter != 'site'")
  .some((v) => v.voter === B && v.name === "Bob Example" && v.choices === 2));
check("…and his site keeps nothing about it", !JSON.stringify(sql(stateB, "SELECT name FROM sqlite_master WHERE type = 'table'")).includes("vote")
  || n(stateB, "poll_votes") === 0);
await cat.goto(`${C}/`);
await choose(cat, "article.from-friend", 1);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, "article.from-friend");
check("Bob sees Cat's answer counted, but not that it's hers", counts(bobPoll) === "1,2,0" && !(await text(bob, "article.from-friend")).includes("Cat"), JSON.stringify(bobPoll));
const bobKey = sql(stateB, "SELECT their_key FROM connections")[0].their_key;
const feed = await (await call(A, "/_peer/feed", bobKey)).json();
check("…nor anywhere in what Ann's site sends him", !JSON.stringify(feed).includes("Cat Example") && JSON.stringify(feed["orderedItems"][0]["afterwrd:poll"]["afterwrd:chosen"]) === "[1]");
await choose(bob, "article.from-friend", 2);
bobPoll = await pollIn(bob, "article.from-friend");
check("Bob changes his mind", counts(bobPoll) === "1,1,1" && chosen(bobPoll) === "Sat 19th", JSON.stringify(bobPoll));

await ann.goto(`${A}/`);
annPoll = await pollIn(ann, "article.own");
check("Ann, who asked, sees who chose what", annPoll.who?.includes("Only you can see this") && /Sat 5th\s+You/.test(annPoll.who)
  && /Sat 12th\s+Cat Example/.test(annPoll.who) && /Sat 19th\s+Bob Example/.test(annPoll.who), annPoll.who);

// Forged answers.
const key = sql(stateA, "SELECT id FROM posts WHERE source = 'afterwrd'")[0];
const postKey = (await bob.$eval("article.from-friend", (a) => a.id)).replace(/^f\d+-/, "");
const vote = (choices, target = `${A}/posts/${postKey}`, k = bobKey) => call(A, "/_peer/vote", k, { type: "afterwrd:Vote", inReplyTo: target, "afterwrd:choices": choices });
check("two choices on a one-choice poll are refused", (await vote([0, 1])).status === 400);
check("…as are options it doesn't have", (await vote([3])).status === 400 && (await vote(["x"])).status === 400 && (await vote("0")).status === 400);
check("…and posts that aren't there", (await vote([0], `${A}/posts/post-1-00000000`)).status === 404 && (await vote([0], `${B}/posts/${postKey}`)).status === 404);
check("…and anyone who isn't a friend", (await vote([0], undefined, "x".repeat(43))).status === 401);
check("Bob's answer is still his last", sql(stateA, `SELECT choices FROM poll_votes WHERE voter = '${B}'`)[0]?.choices === 4);
check("an answer with nothing chosen takes it back", (await vote([])).status === 200 && n(stateA, `poll_votes WHERE voter = '${B}'`) === 0);
await vote([2]);

// Closing.
await ann.goto(`${A}/`);
await Promise.all([ann.waitForNavigation(), ann.click("article.own .poll form:not(.poll-form) button")]);
annPoll = await pollIn(ann, "article.own");
check("Ann closes her poll: the totals stay, the buttons go", counts(annPoll) === "1,1,1" && annPoll.buttons === 0 && annPoll.facts.includes("Closed") && !annPoll.canClose, JSON.stringify(annPoll));
check("…and no answer is taken after, or taken back", (await vote([0])).status === 400 && (await vote([])).status === 400
  && sql(stateA, `SELECT choices FROM poll_votes WHERE voter = '${B}'`)[0]?.choices === 4);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, "article.from-friend");
check("Bob sees it closed, his answer still marked", bobPoll.facts.includes("Closed") && bobPoll.buttons === 0 && chosen(bobPoll) === "Sat 19th", JSON.stringify(bobPoll));

// Several choices, closing on a day.
const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
await ann.goto(`${A}/posts`);
await ask(ann, "What shall we bring?", ["Sandwiches", "Cake", "Flask of tea"], { multiple: true, closes: tomorrow });
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, "article.from-friend");
check("a poll that takes several shows ticks, and when it closes", bobPoll?.ticks === 3 && bobPoll.facts.includes("Pick as many as you like")
  && bobPoll.facts.includes("Closes"), JSON.stringify(bobPoll));
await bob.click("article.from-friend .poll-option:nth-of-type(1) input");
await bob.click("article.from-friend .poll-option:nth-of-type(3) input");
await Promise.all([bob.waitForNavigation(), bob.click("article.from-friend .poll-form button.chip")]);
bobPoll = await pollIn(bob, "article.from-friend");
check("Bob picks two", counts(bobPoll) === "1,0,1" && chosen(bobPoll) === "Sandwiches,Flask of tea", JSON.stringify(bobPoll));
const multiPost = sql(stateA, "SELECT post_id FROM polls WHERE multiple = 1")[0].post_id;
sql(stateA, `UPDATE polls SET closes_at = ${Math.floor(Date.now() / 1000) - 1} WHERE post_id = ${multiPost}`);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, "article.from-friend");
check("a poll closes by itself at its time", bobPoll.facts.includes("Closed") && bobPoll.ticks === 0, JSON.stringify(bobPoll));

// In the archive and the download; and deleting the post takes the poll with it.
const rows = await ann.evaluate(() => fetch("/_admin/export/rows?table=poll_votes").then((r) => r.json()));
check("Download everything includes polls and answers", rows.rows?.length === 4, JSON.stringify(rows).slice(0, 200));
await ann.goto(`${A}/posts`);
await Promise.all([ann.waitForNavigation(), ann.click("article.own header .delete")]);
check("deleting a post deletes its poll and answers", n(stateA, `polls WHERE post_id = ${multiPost}`) === 0 && n(stateA, `poll_votes WHERE post_id = ${multiPost}`) === 0
  && n(stateA, "polls") === 1);
await ann.screenshot({ path: `${OUT}/poll-own.png`, fullPage: true });

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

await bob.goto(`${B}/groups/${bobGroup}`);
await ask(bob, "Which route?", ["Hills", "Canal"]);
const gPost = sql(stateG, "SELECT post_id FROM group_polls")[0]?.post_id;
check("Bob asks a poll in the group, kept by the group", Boolean(gPost) && n(stateB, "group_mine WHERE poll IS NOT NULL") === 1);
await ann.goto(`${A}/groups/${annGroup}`);
await choose(ann, `#gp${gPost}`, 0);
await cat.goto(`${C}/groups/${catGroup}`);
await choose(cat, `#gp${gPost}`, 1);
let catPoll = await pollIn(cat, `#gp${gPost}`);
check("members answer from their own sites, and see the totals", counts(catPoll) === "1,1" && chosen(catPoll) === "Canal" && catPoll.who === null && !catPoll.canClose, JSON.stringify(catPoll));
await ann.goto(`${A}/groups/${annGroup}`);
check("Ann, the group's owner, doesn't see who chose what either", (await pollIn(ann, `#gp${gPost}`)).who === null);
const catKey = sql(stateC, "SELECT their_key FROM groups")[0].their_key;
check("…and the group doesn't tell anyone but its writer", !JSON.stringify(await (await call(G, "/_group/posts", catKey)).json()).includes("afterwrd:voters"));
await bob.goto(`${B}/groups/${bobGroup}`);
check("Bob's group page links to who chose what, without sending names with every page", (await pollIn(bob, `#gp${gPost}`))?.who === null
  && Boolean(await bob.$(`#gp${gPost} .poll a[href$="/posts/${gPost}#poll-g${gPost}"]`)));
const bobKeyG = sql(stateB, "SELECT their_key FROM groups")[0].their_key;
check("…the group's page of posts names no one", !JSON.stringify(await (await call(G, "/_group/posts", bobKeyG)).json()).includes("afterwrd:voters"));
await bob.goto(`${B}/groups/${bobGroup}/posts/${gPost}`);
let bobGPoll = await pollIn(bob, `#gp${gPost}`);
check("Bob, who asked, sees who", /Hills\s+Ann Example/.test(bobGPoll?.who ?? "") && /Canal\s+Cat Example/.test(bobGPoll?.who ?? "") && bobGPoll.canClose, bobGPoll?.who);
// A group can't change what Bob asked.
sql(stateG, `UPDATE group_polls SET options = '["Bob says vote for me","Canal"]' WHERE post_id = ${gPost}`);
await bob.goto(`${B}/groups/${bobGroup}/posts/${gPost}`);
check("a group can't change the options Bob asked", (await pollIn(bob, `#gp${gPost}`))?.options[0].name === "Hills");
check("…and his note says the group's host could still look it up", bobGPoll.who.includes("Whoever hosts the group could still look it up"));
sql(stateG, `UPDATE group_polls SET options = '["Hills","Canal"]' WHERE post_id = ${gPost}`);
check("only its writer can close it", (await call(G, `/_group/polls/${gPost}/close`, catKey, {})).status === 400);
check("forged answers are refused", (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [0, 1] })).status === 400
  && (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [5] })).status === 400);
await bob.goto(`${B}/groups/${bobGroup}`);
await Promise.all([bob.waitForNavigation(), bob.click(`#gp${gPost} .poll form:not(.poll-form) button`)]);
check("Bob closes it", (await pollIn(bob, `#gp${gPost}`))?.facts.includes("Closed"));
check("…and no answer is taken after", (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [0] })).status === 400);
await cat.goto(`${C}/groups/${catGroup}/members`);
await Promise.all([cat.waitForNavigation(), cat.click('form[action$="/leave"] button')]);
check("leaving a group takes your answers with you", n(stateG, `group_poll_votes WHERE origin = '${C}'`) === 0 && n(stateG, "group_poll_votes") === 1);
await bob.goto(`${B}/groups/${bobGroup}`);
await bob.screenshot({ path: `${OUT}/poll-group.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/`);
await bob.screenshot({ path: `${OUT}/poll-phone.png`, fullPage: true });

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
