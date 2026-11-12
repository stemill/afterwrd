// The Chrome the end-to-end tests drive: exactly the version this Puppeteer is made for, downloaded once into
// test/e2e/chrome/ (ignored by git), and printed as a path. run.sh uses it unless CHROME is set.
// Why not the Chrome on the computer: it updates itself, and once it's ahead of Puppeteer the tests lose track of a
// page now and then ("detached Frame", in any suite, at random). A pinned copy changes only when Puppeteer does.
//   node test/e2e/chrome.mjs
import { Browser, detectBrowserPlatform, install } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import { fileURLToPath } from "node:url";

const cacheDir = fileURLToPath(new URL("./chrome/", import.meta.url));
const buildId = PUPPETEER_REVISIONS.chrome;
const platform = detectBrowserPlatform();
if (!platform) {
  console.error("Can't tell which Chrome this computer needs: set CHROME to a Chrome to test with.");
  process.exit(1);
}
let said = false;
const installed = await install({
  browser: Browser.CHROME, buildId, cacheDir, platform,
  // Only when it's actually downloading (the first time, or after Puppeteer moves on), and on stderr: stdout is the path.
  downloadProgressCallback: (done, total) => {
    if (!said) console.error(`Downloading Chrome ${buildId} for the tests (once, about ${Math.round(total / 1e6)} MB)…`);
    said = true;
    if (done === total) console.error("Done.");
  },
});
console.log(installed.executablePath);
