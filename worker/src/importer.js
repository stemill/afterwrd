// The owner's import, driven by the browser (public/static/import/main.js), which reads the Facebook export
// and sends only what the chosen sections need:
//   POST /_admin/import/start      empty <table>_next copies of the archive's tables
//   POST /_admin/import/rows       {table, rows} into <table>_next
//   POST /_admin/import/missing    {hashes} -> which files aren't stored yet
//   PUT  /_admin/import/files/<sha256>   one photo, video or thumbnail
//   POST /_admin/import/finish     {sections}: swap every _next table in at once, then delete unused files
// Visitors keep seeing the previous import until finish swaps the tables in one transaction. Posts, photos and albums
// made on afterwrd share their tables with Facebook's (schema.js `merged`) and are never touched by an import.
import { POST_KEY_RE } from "../public/static/activity.js";
import { ARCHIVE, createTable, MAX_FILE, SERVABLE_TYPES } from "../public/static/import/schema.js";
import { SECTIONS } from "../public/static/import/select.js";
import { importPage } from "./views/import.js";
import { HASH_RE, mediaStore } from "./media.js";
import { html, json, pageData } from "./util.js";
import { headerMe } from "./photos.js";

// D1 limits statements to 100 KB of UTF-8; a JavaScript character is at most 3 bytes of it.
const STATEMENT_CHARS = 30_000;
const MAX_UPLOAD_ID = 100_000_000; // far more rows than any download has
const SHARDS = [..."0123456789abcdef"];

export async function handleImport(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/import".length);
  if (request.method === "GET" && path === "") return html(importPage(pageData(env, { owner: owner.name, me: await headerMe(env.DB, owner) })));

  const file = /^\/files\/([0-9a-f]{64})$/.exec(path);
  if (request.method === "PUT" && file) return storeFile(request, env, file[1]);
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  try {
    if (path === "/start") return await start(env);
    if (path === "/rows") return await rows(env, body);
    if (path === "/missing") return await missing(env, body);
    if (path === "/finish") return await finish(env, body);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return new Response("Not found", { status: 404 });
}

async function start(env) {
  const statements = Object.keys(ARCHIVE).flatMap((table) => [
    `DROP TABLE IF EXISTS ${table}_next`,
    createTable(`${table}_next`, table),
  ]);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  return json({ ok: true });
}

// Values go into the SQL as literals: D1 allows only 100 bound parameters per statement, far fewer than a
// batch of rows needs. Only known columns and plain values are accepted, and strings are quoted.
async function rows(env, { table, rows: list }) {
  const spec = ARCHIVE[table];
  if (!spec || !Array.isArray(list) || !list.length || list.length > 5000) throw new Error("Bad rows.");
  const columns = Object.keys(spec.columns);
  const tuples = list.map((row) => {
    if (!row || typeof row !== "object" || Object.keys(row).some((k) => !columns.includes(k))) {
      throw new Error(`Unexpected columns for ${table}.`);
    }
    return `(${columns.map((c) => literal(checked(table, c, spec.columns[c], row[c]))).join(", ")})`;
  });
  const statements = [];
  let batch = [];
  let chars = 0;
  const flush = () => {
    if (batch.length) statements.push(`INSERT INTO ${table}_next (${columns.join(", ")}) VALUES ${batch.join(", ")}`);
    batch = [];
    chars = 0;
  };
  for (const tuple of tuples) {
    if (chars + tuple.length > STATEMENT_CHARS) flush();
    batch.push(tuple);
    chars += tuple.length;
  }
  flush();
  if (statements.length > 40) throw new Error("Too many rows in one request.");
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  return json({ ok: true });
}

// Every value must suit its column, so nothing unexpected (markup in a number, a fake file address) can reach
// the pages even if the uploader were tampered with.
function checked(table, column, type, value) {
  if (value === null || value === undefined) return null;
  const bad = () => new Error(`Unexpected value for ${table}.${column}.`);
  if (type.startsWith("INTEGER")) {
    if (!Number.isSafeInteger(value)) throw bad();
  } else if (type.startsWith("REAL")) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
  } else if (typeof value !== "string" || value.length > 1_000_000) throw bad();
  if (table === "media" && (column === "hash" || column === "thumb_hash") && !HASH_RE.test(value)) throw bad();
  if (table === "media" && column === "type" && !SERVABLE_TYPES.has(value)) throw bad();
  // Ids count up from 1 in an upload; finish moves them above the ones in use.
  if (type.startsWith("INTEGER") && column.endsWith("id") && (value < 1 || value > MAX_UPLOAD_ID)) throw bad();
  if (table === "posts" && column === "key" && !POST_KEY_RE.test(value)) throw bad();
  return value;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("Unexpected value.");
}

async function missing(env, { hashes }) {
  if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every((h) => HASH_RE.test(h))) {
    throw new Error("Bad hashes.");
  }
  const found = new Set((await Promise.all(SHARDS.map((shard) => {
    const mine = hashes.filter((h) => h[0] === shard);
    return mine.length ? mediaStore(env, shard).has(mine) : [];
  }))).flat());
  return json({ missing: hashes.filter((h) => !found.has(h)) });
}

async function storeFile(request, env, hash) {
  const type = request.headers.get("Content-Type");
  if (!SERVABLE_TYPES.has(type)) return json({ error: `Can't store files of type ${type}.` }, 415);
  if (Number(request.headers.get("Content-Length")) > MAX_FILE) return json({ error: "File too big." }, 413);
  return mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
    method: "PUT",
    headers: { "Content-Type": type },
    body: request.body,
  }));
}

async function finish(env, { sections }) {
  if (!Array.isArray(sections) || !sections.length || !sections.every((s) => SECTIONS.includes(s))) {
    throw new Error("Bad sections.");
  }
  const db = env.DB;
  // How far each merged table's uploaded ids move: above every id it has used, so a Facebook row never takes an
  // afterwrd row's id, or one a deleted row had.
  const shift = {};
  for (const table of Object.keys(ARCHIVE).filter((t) => ARCHIVE[t].merged)) {
    const max = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`).first();
    const used = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM sqlite_sequence WHERE name = ?").bind(table)
      .first().catch(() => ({ n: 0 }));
    shift[table] = Math.max(max.n, used.n);
  }
  // One transaction: if any _next table is missing the whole swap rolls back and the old import stays.
  const statements = Object.entries(ARCHIVE).flatMap(([table, { columns, merged, refs = {}, indexes = {} }]) => {
    const names = Object.keys(columns);
    const values = names.map((c) => (c === "id" && merged ? `id + ${shift[table]}`
      : refs[c] ? `${c} + ${shift[refs[c]]}` : c)).join(", "); // NULL + n stays NULL
    return merged ? [
      `DELETE FROM ${table} WHERE source = 'facebook'`,
      `INSERT OR IGNORE INTO ${table} (source, ${names.join(", ")}) SELECT 'facebook', ${values} FROM ${table}_next`,
      `DROP TABLE ${table}_next`,
    ] : [
      `DROP TABLE IF EXISTS ${table}`,
      createTable(table, table),
      `INSERT OR IGNORE INTO ${table} (${names.join(", ")}) SELECT ${values} FROM ${table}_next`,
      `DROP TABLE ${table}_next`,
      ...Object.entries(indexes).map(([name, column]) => `CREATE INDEX ${name} ON ${table}(${column})`),
    ];
  });
  // Then no link to a row this import didn't bring (a section left out) or didn't keep: unlinked, so a row made later
  // and given that number (an album of the owner's, say) can't pick up Facebook's photos, or share them.
  const kept = (target) => (ARCHIVE[target].merged ? `(SELECT id FROM ${target} WHERE source = 'facebook')` : `(SELECT id FROM ${target})`);
  const unlinked = Object.entries(ARCHIVE).flatMap(([table, { columns, merged, refs = {} }]) => Object.entries(refs).map(([column, target]) =>
    (columns[column].includes("NOT NULL") ? `DELETE FROM ${table} WHERE ${column} NOT IN ${kept(target)}`
      : `UPDATE ${table} SET ${column} = NULL WHERE ${merged ? "source = 'facebook' AND " : ""}${column} IS NOT NULL
        AND ${column} NOT IN ${kept(target)}`)));
  await db.batch([
    ...statements.map((s) => db.prepare(s)),
    ...unlinked.map((s) => db.prepare(s)),
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', ?)").bind(JSON.stringify(sections)),
  ]);

  const { results } = await env.DB.prepare(`
    SELECT hash FROM media WHERE hash IS NOT NULL
    UNION SELECT thumb_hash FROM media WHERE thumb_hash IS NOT NULL`).all();
  const live = results.map((r) => r.hash);
  const removed = await Promise.all(SHARDS.map((shard) =>
    mediaStore(env, shard).keepOnly(live.filter((h) => h[0] === shard))));
  return json({ ok: true, removed: removed.reduce((a, b) => a + b, 0) });
}
