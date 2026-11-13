// Screenshots for the README (docs/screenshots/), from three local sites and a group's Worker, as for groups.mjs
// (Ann on 8787, Ben on 8788, Cath on 8789, the group on 8790), filled with made-up people, painted photos and
// ordinary goings-on. Not a test: nothing is checked beyond each step working. Addresses are shown as workers.dev
// ones, as they would be on real sites; everything else is the real page.
//   node screenshots.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>   (npm run test:e2e -- screenshots)
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settled } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = `${WORKER}../docs/screenshots`;
const PAINTED = `${OUT}/painted`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(PAINTED, { recursive: true });

const [A, B, C, G] = [8787, 8788, 8789, 8790].map((p) => `http://localhost:${p}`);
const HOSTS = { "localhost:8787": "afterwrd.annm.workers.dev", "localhost:8788": "afterwrd.benk.workers.dev",
  "localhost:8789": "afterwrd.cathr.workers.dev", "localhost:8790": "afterwrd-bookclub.annm.workers.dev" };
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const step = (what) => console.log(`·  ${what}`);

// --- painted photos: simple landscapes drawn on a canvas, saved as JPEGs ---------------------------------------------
const SCENES = {
  ridge: { sky: ["#f7c59f", "#f08a5d", "#6a4c93"], sun: ["#ffe8a3", 0.72, 0.42, 0.07], hills: ["#3d405b", "#2b2d42", "#1d1e2c"] },
  lake: { sky: ["#bde0fe", "#a2d2ff", "#cdb4db"], sun: ["#ffffff", 0.25, 0.3, 0.05], hills: ["#52796f", "#354f52", "#2f3e46"], water: "#7fb3d5" },
  beach: { sky: ["#caf0f8", "#90e0ef", "#48cae4"], sun: ["#fff3b0", 0.8, 0.25, 0.06], sea: "#0096c7", sand: "#f4d58d" },
  woods: { sky: ["#e9f5db", "#cfe1b9", "#b5c99a"], trees: ["#718355", "#4f6d3a", "#3a5a40"] },
  dusk: { sky: ["#22223b", "#4a4e69", "#9a8c98"], sun: ["#f2e9e4", 0.65, 0.3, 0.04], hills: ["#2b2d42", "#1b1b2f", "#11111d"] },
  cake: { cake: true },
  face1: { face: ["#ffb4a2", "#e5989b"] }, face2: { face: ["#a8dadc", "#457b9d"] }, face3: { face: ["#cdb4db", "#ffc8dd"] },
};
async function paint() {
  const page = await browser.newPage();
  for (const [name, scene] of Object.entries(SCENES)) {
    const size = scene.face ? [800, 800] : [1600, 1200];
    const data = await page.evaluate((s, [w, h]) => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      let seed = w + h + JSON.stringify(s).length;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const fill = (stops, y0 = 0, y1 = h) => {
        const grad = g.createLinearGradient(0, y0, 0, y1);
        stops.forEach((col, i) => grad.addColorStop(i / (stops.length - 1), col));
        g.fillStyle = grad;
      };
      if (s.face) { // a soft abstract portrait
        fill(s.face); g.fillRect(0, 0, w, h);
        g.fillStyle = "rgba(255,255,255,0.55)"; g.beginPath(); g.arc(w / 2, h * 0.42, w * 0.2, 0, 7); g.fill();
        g.beginPath(); g.ellipse(w / 2, h * 1.0, w * 0.36, h * 0.36, 0, 0, 7); g.fill();
        return c.toDataURL("image/jpeg", 0.9);
      }
      if (s.cake) {
        fill(["#fff1e6", "#fde2e4"]); g.fillRect(0, 0, w, h);
        g.fillStyle = "#e2ece9"; g.beginPath(); g.ellipse(w / 2, h * 0.78, w * 0.36, h * 0.07, 0, 0, 7); g.fill();
        g.fillStyle = "#c08552"; g.fillRect(w * 0.3, h * 0.45, w * 0.4, h * 0.3);
        g.fillStyle = "#fff"; g.fillRect(w * 0.3, h * 0.43, w * 0.4, h * 0.06);
        g.fillStyle = "#f28482"; g.fillRect(w * 0.3, h * 0.58, w * 0.4, h * 0.03);
        for (let i = 0; i < 5; i++) {
          const x = w * (0.36 + i * 0.07);
          g.fillStyle = "#84a59d"; g.fillRect(x - 6, h * 0.33, 12, h * 0.1);
          g.fillStyle = "#f6bd60"; g.beginPath(); g.ellipse(x, h * 0.31, 9, 18, 0, 0, 7); g.fill();
        }
        return c.toDataURL("image/jpeg", 0.9);
      }
      fill(s.sky, 0, h * 0.7); g.fillRect(0, 0, w, h);
      if (s.sun) { const [col, x, y, r] = s.sun; g.fillStyle = col; g.globalAlpha = 0.9; g.beginPath(); g.arc(w * x, h * y, w * r, 0, 7); g.fill(); g.globalAlpha = 1; }
      if (s.sea) {
        g.fillStyle = s.sea; g.fillRect(0, h * 0.55, w, h * 0.45);
        g.fillStyle = "rgba(255,255,255,0.35)";
        for (let i = 0; i < 40; i++) g.fillRect(rand() * w, h * (0.57 + rand() * 0.2), 40 + rand() * 120, 3);
        fill([s.sand, "#e9c46a"], h * 0.75, h); g.beginPath(); g.moveTo(0, h * 0.8);
        g.quadraticCurveTo(w * 0.5, h * 0.72, w, h * 0.82); g.lineTo(w, h); g.lineTo(0, h); g.fill();
      }
      if (s.hills) s.hills.forEach((col, i) => {
        g.fillStyle = col; g.beginPath(); const base = h * (0.55 + i * 0.12); g.moveTo(0, h);
        for (let x = 0; x <= w; x += w / 8) g.lineTo(x, base - (0.04 + rand() * 0.12) * h);
        g.lineTo(w, h); g.fill();
      });
      if (s.water) {
        g.fillStyle = s.water; g.globalAlpha = 0.85; g.fillRect(0, h * 0.78, w, h * 0.22); g.globalAlpha = 1;
        g.fillStyle = "rgba(255,255,255,0.4)"; for (let i = 0; i < 25; i++) g.fillRect(rand() * w, h * (0.8 + rand() * 0.18), 60 + rand() * 160, 2);
      }
      if (s.trees) s.trees.forEach((col, i) => {
        g.fillStyle = col;
        for (let t = 0; t < 14; t++) {
          const x = rand() * w, top = h * (0.25 + i * 0.12 + rand() * 0.1), half = 40 + rand() * 50;
          g.beginPath(); g.moveTo(x, top); g.lineTo(x - half, h * (0.75 + i * 0.08)); g.lineTo(x + half, h * (0.75 + i * 0.08)); g.fill();
        }
      });
      return c.toDataURL("image/jpeg", 0.9);
    }, scene, size);
    writeFileSync(`${PAINTED}/${name}.jpg`, Buffer.from(data.split(",")[1], "base64"));
  }
  await page.close();
}
const photo = (name) => `${PAINTED}/${name}.jpg`;

// --- people and pages -------------------------------------------------------------------------------------------------
async function owner(site, name) {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on("dialog", (d) => d.accept());
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
async function picture(page, site, role, file) {
  await page.goto(`${site}/_admin/photos/add?for=${role}`);
  await (await page.$("#add input[type=file]")).uploadFile(file);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
}
async function compose(page, site, words, files = []) {
  await page.goto(`${site}/posts`);
  await page.type("#composer textarea", words);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
async function connect(host, hostSite, guest, guestSite) {
  await host.goto(`${hostSite}/_admin/connections`);
  await host.click("#make");
  await host.waitForSelector("#link:not([hidden])");
  const link = await host.$eval("#link-url", (i) => i.value);
  await guest.goto(link);
  await guest.$eval("#site", (f) => { f.closest("details").open = true; });
  await guest.type("#site input", guestSite);
  await Promise.all([guest.waitForNavigation(), guest.click("#site button")]);
  await Promise.all([guest.waitForNavigation({ timeout: 30_000 }), guest.click("#go")]);
  await host.goto(`${hostSite}/friend`);
  await Promise.all([host.waitForNavigation(), host.click('.requests button[formaction$="/approve"]')]);
}
async function commentOnFirst(page, selector, words) {
  const form = await page.$(`${selector} form.say`);
  await (await form.$("textarea")).type(words);
  // Sent in place since 0.45.0 (or, the old way, with a new page): whichever happens.
  await Promise.all([settled(page, { timeout: 30_000 }), (await form.$("button")).click()]);
}
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return res.json();
}, path, body);

// Real sites live at workers.dev addresses; local ones at localhost. Swapped in the page's text before each shot.
async function shot(page, url, file, { width = 1200, height = 900, full = true } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.evaluate(async (hosts) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) for (const [from, to] of Object.entries(hosts)) n.nodeValue = n.nodeValue.replaceAll(from, to);
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    // A brand-new site's one-off setup notices (automatic updates, the home screen, checking it) aren't what a site
    // looks like day to day.
    document.querySelectorAll(".live-bar, #live, main .notice").forEach((e) => e.remove());
  }, HOSTS);
  await page.screenshot({ path: `${SHOTS}/${file}`, fullPage: full });
  step(`saved docs/screenshots/${file}`);
}

// --- the story -------------------------------------------------------------------------------------------------------
await paint();
step("painted photos");
const ann = await owner(A, "Ann M.");
const ben = await owner(B, "Ben K.");
const cath = await owner(C, "Cath R.");
await picture(ann, A, "profile", photo("face1"));
await picture(ann, A, "cover", photo("dusk"));
await picture(ben, B, "profile", photo("face2"));
await picture(cath, C, "profile", photo("face3"));
step("three people, with pictures");
await connect(ann, A, ben, B);
await connect(ann, A, cath, C);
await connect(ben, B, cath, C);
step("all friends");

await compose(cath, C, "Lake was like glass this morning. Worth the early start.", [photo("lake")]);
await compose(ben, B, "Up to the ridge for sunrise with the kids. Cold hands, very happy faces.", [photo("ridge"), photo("woods"), photo("beach")]);
await compose(ann, A, "Mum's 70th on Saturday! Thank you all for coming, and for the cake.", [photo("cake")]);
step("posts");
await ann.goto(`${A}/`);
await commentOnFirst(ann, "article.from-friend", "That light! Which ridge was this?");
await ben.goto(`${B}/`);
await commentOnFirst(ben, "article.from-friend", "Happy birthday to your mum! 🎂");
await cath.goto(`${C}/`);
await commentOnFirst(cath, "article.from-friend", "Looks lovely. Say happy birthday from us.");
step("comments");

// A group, with an event.
const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Book club", about: "One book a month, and cake." });
const { id: group } = await post(ann, "/_groups/create/claim", { id: waiting.id });
await ann.goto(`${A}/groups/${group}/members`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const invite = await ann.$eval("#link-url", (i) => i.value);
for (const [page, site] of [[ben, B], [cath, C]]) {
  await page.goto(invite);
  await page.$eval("#site", (f) => { f.closest("details").open = true; });
  await page.type("#site input", site);
  await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
await ann.goto(`${A}/groups/${group}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await ann.goto(`${A}/groups/${group}`);
await ann.type("#composer textarea", "Next month: The Remains of the Day. Copies on my shelf if anyone needs one.");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
await ben.goto(`${B}/groups`);
const benGroupHref = await ben.$eval("a[href^='/groups/']:not([href='/groups/new'])", (a) => a.getAttribute("href"));
await ben.goto(`${B}${benGroupHref}`);
await commentOnFirst(ben, "article.in-group", "I'll take one, thanks Ann.");
const nextMonth = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
const later = new Date(Date.now() + 48 * 86400_000).toISOString().slice(0, 10);
for (const fields of [
  { title: "Book club at Ann's", start_date: nextMonth, start_time: "19:30", end_time: "21:30", place: "Ann's kitchen", text: "Bring a snack." },
  { title: "Picnic in the park", start_date: later, start_time: "12:00", end_time: "16:00", place: "Riverside park", text: "Families welcome." },
]) {
  await ann.goto(`${A}/groups/${group}/calendar`);
  await ann.$eval("details.add-event", (d) => { d.open = true; });
  await ann.$eval("form.event-form", (f, v) => { for (const [k, x] of Object.entries(v)) if (f.elements[k]) f.elements[k].value = x; }, fields);
  await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("form.event-form button.primary")]);
}
await ben.goto(`${B}${benGroupHref}/calendar?month=${nextMonth.slice(0, 7)}`);
await Promise.all([settled(ben, { timeout: 30_000 }), ben.click(".answers button[value=going]")]);
step("a group, with events");

// The pictures.
await shot(ann, `${A}/`, "home-desktop.png", { height: 1250, full: false });
await shot(ann, `${A}/`, "home-phone.png", { width: 390, height: 844, full: false });
await shot(ann, `${A}/posts`, "profile-desktop.png", { full: false });
await ann.goto(`${A}/friend`);
const benPage = await ann.$eval("a[href^='/friend/']", (a) => a.getAttribute("href"));
await shot(ann, `${A}${benPage}`, "friend-desktop.png");
await shot(ann, `${A}/groups/${group}`, "group-desktop.png");
// The month of the first event, so the grid has something on it.
await shot(ann, `${A}/groups/${group}/calendar?month=${nextMonth.slice(0, 7)}`, "calendar-phone.png", { width: 390, height: 844 });
await browser.close();
