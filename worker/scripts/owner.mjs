// The site's owner, from the terminal, for sites deployed with wrangler rather than the installer (and for tests).
// Runs SQL against the Worker's D1 database through wrangler.
//
//   npm run owner -- "Your Name"     makes you the owner of a new site, and prints a link to add your first device
//   npm run owner                    a new link to add another device, once you're the owner
//
// Add --local to work against `npm run dev` instead of the deployed site. Links use the site address from --url,
// or AFTERWRD_URL, or http://localhost:8787 with --local. Day to day, Your devices (/_admin) does the same.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const LINK_SECONDS = 3600; // a device link gives owner access, so it's short-lived

const args = process.argv.slice(2);
const local = take("--local");
const siteUrl = (option("--url") ?? process.env.AFTERWRD_URL ?? (local ? "http://localhost:8787" : "")).replace(/\/$/, "");
const [name] = args;
const now = Math.floor(Date.now() / 1000);
if (!siteUrl) fail("Where is the site? Pass --url https://afterwrd.<you>.workers.dev or set AFTERWRD_URL.");

const [owner] = sql("SELECT id, name FROM users LIMIT 1");
if (name && owner) fail(`This site already has an owner, ${owner.name}. For another device: npm run owner`);
if (!name && !owner) fail('No owner yet. Start with: npm run owner -- "Your Name"');
const user = owner ?? sql(`INSERT INTO users (name, created_at) VALUES (${quote(name.trim().slice(0, 100))}, ${now}) RETURNING id, name`)[0];

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
sql(`INSERT INTO device_links (token_hash, user_id, expires_at) VALUES ('${hash}', ${user.id}, ${now + LINK_SECONDS})`);
console.log(`Device link for ${user.name} (works once, for one hour, and gives owner access):\n\n  ${siteUrl}/_auth/device/${token}\n`);
console.log("Open it only on your own phone or computer; whoever opens it first gets in.");

function sql(command) {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "afterwrd", local ? "--local" : "--remote", "--json",
    "--command", command], { encoding: "utf8" });
  if (result.status !== 0) fail(`wrangler failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout).flatMap((r) => r.results ?? []);
}

function quote(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

function take(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
