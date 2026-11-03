// Deploy the site's code: bring the database tables up to date, then deploy. The archive itself arrives through
// the import page (/_admin/import), so this never touches it.
//
//   npm run deploy
//
// Tables are updated before the new code goes live, so the code never runs against old tables. On the very
// first deploy the database doesn't exist yet; deploying creates it, and the tables follow straight after.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
const migrateArgs = ["npx", ["wrangler", "d1", "migrations", "apply", "afterwrd", "--remote"]];
const deployArgs = ["npx", ["wrangler", "deploy"]];

console.log("▶ Updating the database tables");
const migrate = spawnSync(...migrateArgs, { cwd: worker, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const output = migrate.stdout + migrate.stderr;
if (migrate.status === 0) {
  console.log(output.trim());
  step("Deploying", deployArgs);
} else if (/Couldn't find a D1 DB/.test(output)) {
  console.log("No database yet: this must be the first deploy, so deploying first to create it.");
  step("Deploying", deployArgs);
  step("Creating the database tables", migrateArgs);
} else {
  console.error(output.trim());
  process.exit(1);
}
console.log("\n✔ Deployed. Import your archive from the Import page (/_admin/import).");

function step(title, [command, args]) {
  console.log(`\n▶ ${title}`);
  const run = spawnSync(command, args, { cwd: worker, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
