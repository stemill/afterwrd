// Brings the database up to date on the first request each Worker instance handles, so a site set up from the
// installer (or updated) never needs wrangler. Uses wrangler's own bookkeeping table, so `wrangler d1
// migrations apply` and this agree on what's been applied.
import m0001 from "../migrations/0001_schema.sql";
import m0002 from "../migrations/0002_groups.sql";
import m0003 from "../migrations/0003_events.sql";
import m0004 from "../migrations/0004_friend_answers.sql";
import m0005 from "../migrations/0005_site_checks.sql";
import m0006 from "../migrations/0006_check_site_fixed.sql";

// Every file in migrations/, in order. A new migration needs adding here too.
const MIGRATIONS = [
  ["0001_schema.sql", m0001],
  ["0002_groups.sql", m0002],
  ["0003_events.sql", m0003],
  ["0004_friend_answers.sql", m0004],
  ["0005_site_checks.sql", m0005],
  ["0006_check_site_fixed.sql", m0006],
];

let ready = null;

export function ensureSchema(env) {
  ready ??= migrate(env).catch((error) => {
    ready = null; // try again on the next request
    throw error;
  });
  return ready;
}

async function migrate(env) {
  const db = env.DB;
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all();
  const applied = new Set(results.map((r) => r.name));

  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      // One transaction per migration, recorded in the same batch.
      await db.batch([
        ...statements(sql).map((s) => db.prepare(s)),
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
      ]);
    } catch (error) {
      // Another instance may have applied it at the same moment; that's fine.
      const done = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(name).first();
      if (!done) throw error;
    }
  }
}

// Migration files hold plain DDL: no semicolons inside strings, so splitting on them is safe once comments
// (which can contain semicolons) are gone.
function statements(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
