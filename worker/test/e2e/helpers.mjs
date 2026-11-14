// Small things several suites share.

/**
 * Waits for a form sent by a click: in place (ui.js fires "afterwrd-inplace" when it's done) or the old way, with a
 * new page, whichever happens. Resolves with whether it went (a new page counts as having gone). Start it before the
 * click: `await Promise.all([settled(page), page.click(…)])`.
 * @param {import("puppeteer-core").Page} page
 * @param {import("puppeteer-core").WaitForOptions} [options] for the new page, if there is one
 * @returns {Promise<boolean>}
 */
export const settled = (page, options) => Promise.race([
  page.waitForNavigation(options).then(() => true),
  page.evaluate(() => new Promise((resolve) => document.addEventListener("afterwrd-inplace", (e) => resolve(e.detail.sent), { once: true })))
    .catch(() => new Promise(() => {})), // the page went away: the new page is the answer
]);

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Rows from a local test site's database: `state`, its --persist-to folder (each site in a multi-site suite has one),
 * or null for a suite's only site. Tried again once after a moment: wrangler sometimes can't read while the site is
 * busy writing.
 * @param {string | null} state
 * @param {string} query
 * @returns {any[]}
 */
export function siteSql(state, query) {
  const args = ["d1", "execute", "afterwrd", "--local", ...(state ? ["--persist-to", state] : []), "--json", "--command", query];
  const run = () => JSON.parse(execFileSync("./node_modules/.bin/wrangler", args, { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
  try {
    return run();
  } catch {
    execFileSync("sleep", ["1"]);
    return run();
  }
}

/** Rows from a suite's only test site. */
export const sql = (query) => siteSql(null, query);

/** How many rows `from` (a table, and perhaps WHERE …) has on the site at `state`. */
export const count = (state, from) => siteSql(state, `SELECT COUNT(*) AS n FROM ${from}`)[0].n;
