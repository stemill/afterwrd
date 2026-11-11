// Before: on an older release (0.17.0 or later; earlier ones started a different database), set up, import the tiny
// Facebook download, post two photos with a comment, a poll with an answer (where the release has polls), an album, a
// profile picture, and comments on an imported post and photo. After: on the new code, with the same database,
// everything made on afterwrd is still there at the same addresses, the comments on imported things are gone (only
// what's made on afterwrd takes comments now), and the album tools work.
//   node upgrade.mjs before|after <fixtures> <zip>
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stage, fixtures, zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const SAVED = `${OUT}/upgrade-state.json`;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  [${stage}] ${name}${extra ? `  (${extra})` : ""}`); if (!ok) process.exitCode = 1; };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
// afterwrd asks in its own box (ui.js): say yes, as a person would.
await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
  .observe(document, { childList: true, subtree: true }));
const say = async (scope, text) => {
  await page.type(`${scope} .say textarea`, text);
  await Promise.all([page.waitForNavigation(), page.click(`${scope} .say button`)]);
};
const said = (scope) => page.$$eval(`${scope} .comment .said`, (l) => l.map((c) => c.textContent));
const own = "main article.card.own";

if (stage === "before") {
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
  await page.type("#name", "Upgrader");
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);

  // The Facebook download, with comments on one of its posts and one of its photos (allowed until now).
  await page.goto(`${BASE}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes) => boxes.forEach((b) => { b.checked = ["posts", "photos"].includes(b.value); }));
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  check("imported on the old release", !(await page.$eval("#error", (e) => e.textContent)));
  // (From 0.41.0, imported posts and photos take no comments: nothing to say there.)
  await page.goto(`${BASE}/posts`);
  if (await page.$("main article.card:last-of-type .say")) await say("main article.card:last-of-type", "On an imported post");
  await page.goto(`${BASE}/photos/album/other`);
  const importedPhoto = await page.$eval(".justified a.tile", (a) => a.getAttribute("href"));
  await page.goto(BASE + importedPhoto);
  if (await page.$(".info .say")) await say(".info", "On an imported photo");

  // Posted here: two photos with a comment, and a poll with an answer.
  await page.goto(`${BASE}/posts`);
  await page.type("#composer textarea", "Before the upgrade");
  await (await page.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
  await say(`${own}:first-of-type`, "Still here?");
  const address = await page.$eval(`${own}:first-of-type a.when`, (a) => a.getAttribute("href"));
  const photo = await page.$eval(`${own}:first-of-type .collage a.tile`, (a) => a.getAttribute("href"));
  await page.goto(BASE + photo);
  await say(".info", "Nice photo");
  check("posted on the old release", (await page.$eval(".info article.card", (a) => a.querySelectorAll(".collage .tile").length)) === 2);
  await page.evaluate(() => fetch("/_admin/posts", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Tea or coffee?", poll: { options: ["Tea", "Coffee"], multiple: false } }) }));
  await page.goto(`${BASE}/posts`);
  const poll = Boolean(await page.$(`${own}:first-of-type .poll-form`));
  if (poll) await Promise.all([page.waitForNavigation(), page.click(`${own}:first-of-type .poll-form button.poll-option`)]);

  // An album of their own, and a profile picture.
  await page.goto(`${BASE}/_admin/photos/add`);
  await page.type("input[name=name]", "Summer");
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  const album = new URL(page.url()).pathname;
  await page.goto(`${BASE}/_admin/photos/add?for=profile`);
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/big.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);

  writeFileSync(SAVED, JSON.stringify({ cookie: (await page.cookies()).find((c) => c.name === "__Host-session").value,
    address, photo, poll, album, importedPhoto }));
} else {
  const was = JSON.parse(readFileSync(SAVED, "utf8"));
  await page.setCookie({ name: "__Host-session", value: was.cookie, domain: "localhost", path: "/", secure: true, httpOnly: true });

  await page.goto(BASE + was.address);
  const card = await page.$eval("main article.card", (a) => ({ text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
    comments: [...a.querySelectorAll(".comment .said")].map((c) => c.textContent) }));
  check("the post keeps its address, with both photos and its comment", card.text === "Before the upgrade" && card.photos === 2
    && card.comments.join() === "Still here?", JSON.stringify(card));
  await page.goto(BASE + was.photo);
  check("its photo keeps its comment, in Posted on afterwrd", (await said(".info")).join() === "Nice photo"
    && (await page.$eval(".info .album-link", (a) => a.textContent)) === "Posted on afterwrd");

  await page.goto(`${BASE}/posts`);
  check("imported posts are still there, with no comments or comment box", (await page.$$("main article.card:not(.own)")).length === 2
    && !(await page.$("main article.card:not(.own) .say")) && !(await page.content()).includes("On an imported post"));
  await page.goto(BASE + was.importedPhoto);
  check("…and imported photos too", Boolean(await page.$(".stage img")) && !(await page.$(".info .say"))
    && !(await page.content()).includes("On an imported photo"));
  await page.goto(`${BASE}/activity`);
  const notes = await page.$$eval(".activity .text", (l) => l.map((t) => t.textContent));
  check("Notifications keep the comments that are still there", notes.length === 2 && notes.includes("Still here?") && notes.includes("Nice photo"), notes.join("|"));

  if (was.poll) {
    await page.goto(`${BASE}/posts`);
    const poll = await page.$$eval(`${own} .poll-option`, (l) => l.map((o) => ({ text: o.textContent.trim(), chosen: o.classList.contains("chosen") })));
    check("the poll keeps its answer", poll.length === 2 && poll[0].chosen && poll[0].text.startsWith("Tea"), JSON.stringify(poll));
    await Promise.all([page.waitForNavigation(), page.click(`${own} .poll-form button.poll-option:nth-of-type(2)`)]);
    check("…and can still be answered", await page.$eval(`${own} .poll-option:nth-of-type(2)`, (o) => o.classList.contains("chosen")).catch(() => false));
  } else console.log(`SKIP  [${stage}] no polls on that release`);

  await page.goto(BASE + was.album);
  check("the album made before is still there", (await page.$eval("h1", (h) => h.textContent)) === "Summer"
    && (await page.$$eval(".justified a.tile", (l) => l.length)) === 1);
  await page.goto(`${BASE}/_admin/photos/add?for=profile`);
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  await page.goto(`${BASE}/photos`);
  const albums = await page.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
  check("a new profile picture joins the same Profile pictures album", albums.filter((a) => a === "Profile pictures").length === 1, albums.join());

  await page.goto(`${BASE}/_admin/photos/add`);
  await page.type("input[name=name]", "After");
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  check("new albums work on the upgraded site", (await page.$$eval(".justified a.tile", (l) => l.length)) === 1);
  await page.goto(`${BASE}/posts`);
  await page.type("#composer textarea", "After the upgrade");
  await Promise.all([page.waitForNavigation(), page.click("#composer button.post")]);
  check("new posts work too", (await page.$eval(`${own}:first-of-type .text`, (t) => t.textContent)) === "After the upgrade");
  // Comments made before the upgrade can be changed like any other (still within their 15 minutes here).
  await page.goto(BASE + was.address);
  await page.click("main article.card .comment .under details.more summary");
  await page.click("main article.card .comment .under details.more a[href^='#edit']");
  await page.$eval("main article.card .comment div.edit textarea", (t) => { t.value = "Still here, after the upgrade"; });
  await Promise.all([page.waitForNavigation(), page.click("main article.card .comment div.edit button")]);
  check("a comment from before the upgrade can be changed", (await said("main article.card")).join() === "Still here, after the upgrade"
    && (await page.$eval("main article.card .comment details.edited", (d) => d.textContent).catch(() => "")).includes("Still here?"));
}
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
