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
