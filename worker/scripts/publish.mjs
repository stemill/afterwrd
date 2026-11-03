// Publish the archive in one go: pick what to publish, bring the database up to date, load the data, deploy.
//
//   npm run publish                         posts and photos
//   npm run publish -- --sections all       or any of: overview, timeline, posts, photos, comments, likes, friends
//   npm run publish -- --local              load into the local database for `npm run dev`; no deploy
//
// Tables are updated before the new code goes live, so the code never runs against old tables. On the very
// first publish the database doesn't exist yet; deploying creates it, and the tables follow straight after.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSections, prepare, SQL_FILE } from "./prepare.mjs";

const worker = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const where = args.includes("--local") ? "--local" : "--remote";

console.log("▶ Choosing what to publish");
let result;
try {
  result = prepare(parseSections(args));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { counts, size, tooBig } = result;
console.log(`  ${Object.entries(counts).map(([t, n]) => `${n.toLocaleString("en-GB")} ${t.replace("_", " ")}`).join(", ")}`);
console.log(`  ${(size / 1e6).toFixed(0)} MB of photos, videos and thumbnails`);
for (const [path, bytes] of tooBig) {
  console.log(`  left out ${path} (${(bytes / 1e6).toFixed(0)} MB): over Cloudflare's 25 MB limit; re-encode it smaller to include it`);
}

const wrangler = (...a) => ["npx", ["wrangler", ...a]];
const migrateArgs = wrangler("d1", "migrations", "apply", "heybert", where);
const loadArgs = wrangler("d1", "execute", "heybert", where, "--yes", "--file", SQL_FILE);
const deployArgs = wrangler("deploy");

console.log("\n▶ Updating the database tables");
const migrate = spawnSync(...migrateArgs, { cwd: worker, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const output = migrate.stdout + migrate.stderr;
if (migrate.status === 0) {
  console.log(output.trim());
  step("Loading the archive into the database", loadArgs);
  if (where === "--remote") step("Deploying", deployArgs);
} else if (where === "--remote" && /Couldn't find a D1 DB/.test(output)) {
  console.log("No database yet: this must be the first publish, so deploying first to create it.");
  step("Deploying", deployArgs);
  step("Creating the database tables", migrateArgs);
  step("Loading the archive into the database", loadArgs);
} else {
  console.error(output.trim());
  process.exit(1);
}
console.log(where === "--local" ? "\n✔ Loaded locally. Run `npm run dev` to try it." : "\n✔ Published.");

function step(title, [command, commandArgs]) {
  console.log(`\n▶ ${title}`);
  const run = spawnSync(command, commandArgs, { cwd: worker, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
