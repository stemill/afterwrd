// Writes types/rows.d.ts: what a row of each table looks like, for the type checks (`npm run check`). Made from the
// migrations themselves, run here in an empty in-memory SQLite database exactly as src/migrate.js runs them on a site,
// so the types can't drift from the real tables. Made afresh by every check, and git-ignored, like Cloudflare's own
// types/worker-configuration.d.ts.
//
// In the code: /** @type {Row<"connections">} */, or Row<"connections"> | null for .first().
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
const db = new DatabaseSync(":memory:");

// The same split as src/migrate.js statements(): plain DDL, so no semicolons inside strings.
const statements = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  .split(";").map((s) => s.trim()).filter(Boolean);

// Just enough of D1 for a code migration (a .js file): prepare → bind → all/first/run, and the statements it returns.
const prepared = (sql, params = []) => ({
  sql, params,
  bind: (...values) => prepared(sql, values),
  all: async () => ({ results: db.prepare(sql).all(...params) }),
  first: async () => db.prepare(sql).get(...params) ?? null,
  run: async () => db.prepare(sql).run(...params),
});
const d1 = { prepare: (sql) => prepared(sql) };

for (const file of readdirSync(`${worker}migrations`).sort()) {
  if (file.endsWith(".sql")) {
    for (const s of statements(readFileSync(`${worker}migrations/${file}`, "utf8"))) db.exec(s);
  } else if (file.endsWith(".js")) {
    const { default: migration } = await import(pathToFileURL(`${worker}migrations/${file}`).href);
    for (const s of await migration(d1)) db.prepare(s.sql).run(...s.params);
  }
}

const TYPES = { INTEGER: "number", REAL: "number", NUMERIC: "number", TEXT: "string", BLOB: "ArrayBuffer" };
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all();
const lines = tables.map(({ name }) => {
  const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => {
    const type = TYPES[String(c.type).toUpperCase()] ?? "unknown";
    return `    ${c.name}: ${type}${c.notnull || c.pk ? "" : " | null"};`;
  });
  return `  ${name}: {\n${columns.join("\n")}\n  };`;
});

writeFileSync(`${worker}types/rows.d.ts`, `// Made by scripts/row-types.mjs from migrations/ (npm run check): don't edit.

/** A row of each table, as D1 returns it. */
interface Rows {
${lines.join("\n")}
}

/** A row of table \`T\`, as D1 returns it (in the code: @type {Row<"connections">}). */
type Row<T extends keyof Rows> = Rows[T];
`);
