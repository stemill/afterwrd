// Downloads the code an afterwrd site is running, from Cloudflare, and compares it file by file with a release.
// Only reads: it needs an API token with "Workers Scripts: Read" for the account, in CF_TOKEN, and never prints it.
// The code carries the hash of every static file the site serves (src/static.js), so matching code covers those too.
// It doesn't look at how the Worker is set up (bindings, logging, deployments); a friend's check (src/checks.js) does.
//
//   read -rs CF_TOKEN && export CF_TOKEN                     (paste the token, press Enter; nothing shows)
//   node worker/scripts/check-site.mjs <worker name>         (compared with the latest release)
//   node worker/scripts/check-site.mjs <worker name> --version 0.23.0
//   node worker/scripts/check-site.mjs <worker name> --manifest worker/release/0.23.0/manifest.json   (your own rebuild)
//   …add --account <id> if the token can see more than one account.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const version = option("version");
const manifestPath = option("manifest");
let account = option("account");
const [script] = args;
const token = process.env.CF_TOKEN?.trim();
if (!token || !script) {
  console.error("Usage: CF_TOKEN=… node check-site.mjs <worker name> [--version X.Y.Z | --manifest path] [--account id]");
  process.exit(2);
}
const API = "https://api.cloudflare.com/client/v4";
const get = (path) => fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function release() {
  if (manifestPath) return JSON.parse(readFileSync(manifestPath, "utf8"));
  const url = version
    ? `https://github.com/stemill/afterwrd/releases/download/v${version}/manifest.json`
    : "https://github.com/stemill/afterwrd/releases/latest/download/manifest.json";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download the release's manifest (${response.status}).`);
  return response.json();
}

if (!account) {
  const accounts = await (await get("/accounts")).json();
  if (!accounts.success) { console.error("Cloudflare refused the token:", JSON.stringify(accounts.errors)); process.exit(2); }
  if (accounts.result.length !== 1) {
    console.error(`The token can see ${accounts.result.length} accounts; say which with --account <id>.`);
    process.exit(2);
  }
  account = accounts.result[0].id;
}
const manifest = await release();
const code = await get(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}`);
if (!code.ok || !(code.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
  console.error(`Couldn't download ${script}'s code (HTTP ${code.status}).`);
  process.exit(2);
}
const expected = new Map(manifest.modules.map((m) => [m.name, m.sha256]));
const seen = new Set();
let same = true;
console.log(`${script}, compared with ${manifestPath ?? `afterwrd ${manifest.version}`}:`);
for (const [name, value] of (await code.formData()).entries()) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(await value.arrayBuffer());
  const verdict = !expected.has(name) ? "NOT IN THE RELEASE" : expected.get(name) === sha256(bytes) ? "matches" : "DIFFERENT";
  if (verdict !== "matches") same = false;
  seen.add(name);
  console.log(`  ${verdict.padEnd(18)} ${name}`);
}
for (const name of expected.keys()) if (!seen.has(name)) { same = false; console.log(`  ${"MISSING".padEnd(18)} ${name}`); }
console.log(same ? "\nThe site is running exactly this release's code." : "\nThe site's code is NOT this release's. See afterwrd.app/check/ for what to do.");
process.exit(same ? 0 : 1);
