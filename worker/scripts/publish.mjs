// Export the site, bring the database up to date and deploy, in one go:
//
//   npm run publish                         posts and photos
//   npm run publish -- --sections all       anything `uv run heybert-export --help` accepts
//
// The database is updated before the new code goes live, so the code never runs against old tables. On the
// very first publish the database doesn't exist yet; deploying creates it, and the tables follow straight after.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

step("Exporting the site", "uv", ["run", "heybert-export", ...process.argv.slice(2)], root);

console.log("\n▶ Updating the database");
const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "heybert", "--remote"],
  { cwd: worker, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const output = migrate.stdout + migrate.stderr;
if (migrate.status === 0) {
  console.log(output.trim());
  step("Deploying", "npx", ["wrangler", "deploy"], worker);
} else if (/Couldn't find a D1 DB/.test(output)) {
  console.log("No database yet: this must be the first publish, so deploying first to create it.");
  step("Deploying", "npx", ["wrangler", "deploy"], worker);
  step("Creating the database tables", "npx", ["wrangler", "d1", "migrations", "apply", "heybert", "--remote"], worker);
} else {
  console.error(output.trim());
  process.exit(1);
}
console.log("\n✔ Published.");

function step(title, command, args, cwd) {
  console.log(`\n▶ ${title}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
