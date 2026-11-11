// Deploy the site's code by hand. The archive itself arrives through the import page (/_admin/import), so this
// never touches it.
//
//   npm run deploy
//
// The Worker brings the database tables up to date itself, on the first request after it starts (src/migrate.js),
// so nothing here applies migrations: wrangler only knows the .sql ones, not those that run code.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));

console.log("▶ Deploying");
const run = spawnSync("npx", ["wrangler", "deploy"], { cwd: worker, stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log("\n✔ Deployed. The database catches up on the site's first request. Import your archive from the Import page (/_admin/import).");
