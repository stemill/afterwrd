// Brings the database up to date on the first request each Worker instance handles, so a site set up from the
// installer (or updated) never needs wrangler. Uses wrangler's own bookkeeping table, so `wrangler d1
// migrations apply` and this agree on what's been applied.
//
// Most migrations are .sql files. One that needs to work something out from the rows (which SQL can't) is a .js
// module instead: its default export takes the database, reads what it needs, and returns the statements to run.
// Either way a migration runs as one batch (one transaction), recorded in the same batch. wrangler only knows the
// .sql files, so apply migrations through the Worker (any request does it), not `wrangler d1 migrations apply`.
//
// Migrations may change anything, not only add: a release can rename, reshape or drop tables. So an older version can
// find itself on a database a newer one has already changed: while an update spreads (Cloudflare takes a few minutes
// to send everyone to the new version), or if an update is undone. It knows, because the database lists a migration
// it has never heard of (databaseIsNewer); it then shows "being updated" and writes nothing (index.js), and an update
// that has got that far is never undone (auto.js switchCarefully).
import m0001 from "../migrations/0001_schema.sql";
import m0002 from "../migrations/0002_groups.sql";
import m0003 from "../migrations/0003_events.sql";
import m0004 from "../migrations/0004_friend_answers.sql";
import m0005 from "../migrations/0005_site_checks.sql";
import m0006 from "../migrations/0006_check_site_fixed.sql";
import m0007 from "../migrations/0007_friend_asks.sql";
import m0008 from "../migrations/0008_checked.sql";
import m0009 from "../migrations/0009_check_requests.sql";
import m0010 from "../migrations/0010_messages.sql";
import m0011 from "../migrations/0011_group_chats.sql";
import m0012 from "../migrations/0012_polls.sql";
import m0013 from "../migrations/0013_one_set_of_tables.js";
import m0014 from "../migrations/0014_updates.sql";
import m0015 from "../migrations/0015_editing.sql";
import m0016 from "../migrations/0016_friend_checks.sql";
import m0017 from "../migrations/0017_personal_events.sql";
import m0019 from "../migrations/0019_no_messages.sql";
import pkg from "../package.json";

// Every file in migrations/, in order. A new migration needs adding here too.
const MIGRATIONS = [
  ["0001_schema.sql", m0001],
  ["0002_groups.sql", m0002],
  ["0003_events.sql", m0003],
  ["0004_friend_answers.sql", m0004],
  ["0005_site_checks.sql", m0005],
  ["0006_check_site_fixed.sql", m0006],
  ["0007_friend_asks.sql", m0007],
  ["0008_checked.sql", m0008],
  ["0009_check_requests.sql", m0009],
  ["0010_messages.sql", m0010],
  ["0011_group_chats.sql", m0011],
  ["0012_polls.sql", m0012],
  ["0013_one_set_of_tables", m0013],
  ["0014_updates.sql", m0014],
  ["0015_editing.sql", m0015],
  ["0016_friend_checks.sql", m0016],
  ["0017_personal_events.sql", m0017],
  ["0019_no_messages.sql", m0019],
];
const VERSION = pkg.version;
// A migration that failed, kept so the version left running can say so (the Update page): {version, migration, error, at}.
export const PROBLEM_KEY = "update_problem";

const KNOWN = new Set(MIGRATIONS.map(([name]) => name));
const RECHECK_MS = 30_000; // how often a version looks again (and every time, once it's found one newer)
let ready = null;
let newer = false;
let checkedAt = 0;

/** Whether the database has had a migration this version doesn't know: a newer version has changed it. */
export async function databaseIsNewer(env) {
  if (newer || Date.now() - checkedAt > RECHECK_MS) await checkNewer(env);
  return newer;
}

/** Asks the database afresh (say, after something failed): has a newer version changed it since this one started? */
export async function checkNewer(env) {
  const { results } = await env.DB.prepare("SELECT name FROM d1_migrations").all().catch(() => ({ results: [] }));
  checkedAt = Date.now();
  newer = results.some((r) => !KNOWN.has(r.name));
  return newer;
}

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
  checkedAt = Date.now();
  newer = [...applied].some((name) => !KNOWN.has(name));
  if (newer) return; // a newer version's database: not ours to change

  for (const [name, migration] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      const work = typeof migration === "function" ? await migration(db) : statements(migration).map((s) => db.prepare(s));
      // One transaction per migration, recorded in the same batch.
      await db.batch([...work, db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    } catch (error) {
      // Another instance may have applied it at the same moment; that's fine.
      const done = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(name).first();
      if (!done) {
        // Nothing of it happened (one transaction), so the database can still note why, for whoever looks after afterwrd.
        await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(PROBLEM_KEY, JSON.stringify({
          version: VERSION, migration: name, error: String(error?.message ?? error).slice(0, 500), at: Math.floor(Date.now() / 1000),
        })).run().catch(() => {});
        throw error;
      }
    }
  }
  // All done: this version notes itself the first time it runs, and a problem an older or this version had is over.
  await db.batch([
    db.prepare(`INSERT INTO updates (version, from_version, at)
      SELECT ?1, (SELECT version FROM updates ORDER BY id DESC LIMIT 1), ?2
      WHERE COALESCE((SELECT version FROM updates ORDER BY id DESC LIMIT 1), '') != ?1`).bind(VERSION, Math.floor(Date.now() / 1000)),
  ]);
  const problem = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(PROBLEM_KEY).first();
  if (problem && !laterVersion(JSON.parse(problem.value).version, VERSION)) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(PROBLEM_KEY).run();
  }
}

/** Whether version a is newer than b (both x.y.z). */
function laterVersion(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
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
