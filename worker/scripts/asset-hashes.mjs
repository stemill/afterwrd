// Records the SHA-256 of every static file (public/) in generated/asset-hashes.json, which the Worker's code bundles
// (src/static.js), so the code checks each file before sending it. Wrangler runs this before every build, deploy and
// `wrangler dev` (build.command in wrangler.jsonc), and again when public/ changes during `wrangler dev`.
// The file is only rewritten when something changed, so it doesn't set off another rebuild.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(worker, "public");
const out = join(worker, "generated", "asset-hashes.json");

export function assetHashes() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const entries = walk(publicDir)
    .map((file) => [`/${relative(publicDir, file).split("\\").join("/")}`, createHash("sha256").update(readFileSync(file)).digest("hex")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = assetHashes();
  let current = null;
  try { current = readFileSync(out, "utf8"); } catch {}
  if (current !== text) {
    mkdirSync(join(worker, "generated"), { recursive: true });
    writeFileSync(out, text);
  }
}
