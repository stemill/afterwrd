// Checks the browser importer against the Python one: runs public/static/import/ingest.js over an export folder
// in Node and compares every row with data/afterwrd.db, built from the same export by `uv run afterwrd-ingest`.
//
//   node --disable-warning=ExperimentalWarning test/compare-ingest.mjs ~/Downloads/facebook-<you>-<date>-<id>
//
// Photo sizes aren't compared: the browser works them out while uploading.
import { openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ingest } from "../public/static/import/ingest.js";

const root = process.argv[2];
if (!root) throw new Error("Give the export folder.");
const dbPath = fileURLToPath(new URL("../../data/afterwrd.db", import.meta.url));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(root, join(dir, e.name))]);
}
const files = walk(root);
const present = new Set(files);
const source = {
  files,
  has: (p) => present.has(p),
  size: (p) => statSync(join(root, p)).size,
  text: async (p) => readFileSync(join(root, p), "utf8"),
  head: async (p, n) => {
    const buf = Buffer.alloc(n);
    readSync(openSync(join(root, p)), buf, 0, n, 0);
    return buf;
  },
};

const { tables } = await ingest(source);
const db = new DatabaseSync(dbPath, { readOnly: true });
let problems = 0;
for (const [table, rows] of Object.entries(tables)) {
  const expected = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const columns = Object.keys(expected[0] ?? {}).filter((c) => !["width", "height"].includes(c));
  const differences = [];
  if (rows.length !== expected.length) differences.push(`${rows.length} rows, expected ${expected.length}`);
  for (let i = 0; i < Math.min(rows.length, expected.length); i++) {
    for (const c of columns) {
      if ((rows[i][c] ?? null) !== (expected[i][c] ?? null)) {
        differences.push(`row ${i + 1} ${c}: ${JSON.stringify(rows[i][c])} vs ${JSON.stringify(expected[i][c])}`);
      }
    }
  }
  problems += differences.length;
  console.log(`${differences.length ? "DIFF" : "same"}  ${table.padEnd(14)} ${rows.length} rows`);
  for (const d of differences.slice(0, 5)) console.log(`      ${d}`);
}
console.log(problems ? `\n${problems} differences` : "\nAll tables identical to the Python import.");
process.exit(problems ? 1 : 0);
