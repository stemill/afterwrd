// Photos and videos, stored by the SHA-256 of their contents in Durable Objects' built-in SQLite (free, no card,
// and untouched by code deploys). Files are split across 16 objects by the first character of their hash, and
// each file into rows under SQLite's 2 MB limit.
import { DurableObject } from "cloudflare:workers";
import { MAX_FILE } from "../public/static/import/schema.js";

const CHUNK = 1_900_000;
export const HASH_RE = /^[0-9a-f]{64}$/;

export function mediaStore(env, hash) {
  return env.MEDIA.get(env.MEDIA.idFromName(`shard-${hash[0]}`));
}

export class MediaStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        hash TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, chunks INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        hash TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (hash, n)
      );`);
  }

  /** Which of these hashes are stored here. */
  has(hashes) {
    return hashes.filter((h) => this.sql.exec("SELECT 1 FROM files WHERE hash = ?", h).toArray().length);
  }

  /** Delete every file not in `hashes`, and any pieces left by uploads that never finished; returns how many went. */
  keepOnly(hashes) {
    const keep = new Set(hashes);
    let removed = 0;
    for (const { hash } of this.sql.exec("SELECT hash FROM files").toArray()) {
      if (keep.has(hash)) continue;
      this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
      this.sql.exec("DELETE FROM files WHERE hash = ?", hash);
      removed++;
    }
    this.sql.exec("DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM files)");
    return removed;
  }

  /** Delete these files (when the owner deletes a post); returns how many went. */
  remove(hashes) {
    let removed = 0;
    for (const hash of hashes) {
      this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
      removed += this.sql.exec("DELETE FROM files WHERE hash = ?", hash).rowsWritten;
    }
    return removed;
  }

  async fetch(request) {
    const hash = new URL(request.url).pathname.slice(1);
    if (!HASH_RE.test(hash)) return new Response("Bad hash", { status: 400 });
    if (request.method === "PUT") return this.store(hash, request);
    if (request.method === "GET" || request.method === "HEAD") return this.serve(hash, request);
    return new Response("Method not allowed", { status: 405 });
  }

  // Streams the upload into chunks while hashing it; a file whose contents don't match its name is discarded.
  // A file that's already stored is left alone, so a failed or duplicate upload can never damage it.
  async store(hash, request) {
    if (this.sql.exec("SELECT 1 FROM files WHERE hash = ?", hash).toArray().length) {
      await request.body?.cancel();
      return Response.json({ ok: true, existing: true });
    }
    try {
      return await this.receive(hash, request);
    } catch (error) {
      this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
      throw error;
    }
  }

  async receive(hash, request) {
    const type = request.headers.get("Content-Type");
    const digest = new crypto.DigestStream("SHA-256");
    const hasher = digest.getWriter();
    const reader = request.body.getReader();
    const buffer = new Uint8Array(CHUNK);
    let filled = 0;
    let n = 0;
    let size = 0;
    const save = () => {
      this.sql.exec("INSERT OR REPLACE INTO chunks (hash, n, data) VALUES (?, ?, ?)", hash, n++, buffer.slice(0, filled).buffer);
      filled = 0;
    };

    this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await hasher.write(value);
      size += value.length;
      if (size > MAX_FILE) {
        await reader.cancel();
        this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
        return Response.json({ error: "File too big." }, { status: 413 });
      }
      for (let offset = 0; offset < value.length;) {
        const take = Math.min(CHUNK - filled, value.length - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === CHUNK) save();
      }
    }
    if (filled || n === 0) save();
    await hasher.close();

    const actual = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (actual !== hash) {
      this.sql.exec("DELETE FROM chunks WHERE hash = ?", hash);
      return Response.json({ error: "The file arrived damaged; try again." }, { status: 400 });
    }
    this.sql.exec("INSERT OR REPLACE INTO files (hash, size, type, chunks) VALUES (?, ?, ?, ?)", hash, size, type, n);
    return Response.json({ ok: true, size });
  }

  serve(hash, request) {
    const file = this.sql.exec("SELECT * FROM files WHERE hash = ?", hash).toArray()[0];
    if (!file) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "Content-Type": file.type, "Accept-Ranges": "bytes", ETag: `"${hash}"` });
    if (request.headers.get("If-None-Match") === `"${hash}"`) return new Response(null, { status: 304, headers });

    // Byte ranges, which Safari needs to play video at all.
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(file.size - Number(range[2]), 0);
      end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
      if (start > end) {
        headers.set("Content-Range", `bytes */${file.size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    }
    headers.set("Content-Length", String(end - start + 1));
    if (request.method === "HEAD" || file.size === 0) return new Response(null, { status, headers });

    // Read only the chunks the range covers, one at a time as the response is sent.
    const sql = this.sql;
    let n = Math.floor(start / CHUNK);
    const last = Math.floor(end / CHUNK);
    const body = new ReadableStream({
      pull(controller) {
        const row = sql.exec("SELECT data FROM chunks WHERE hash = ? AND n = ?", hash, n).toArray()[0];
        const bytes = new Uint8Array(row.data);
        const from = n === Math.floor(start / CHUNK) ? start % CHUNK : 0;
        const to = n === last ? (end % CHUNK) + 1 : bytes.length;
        controller.enqueue(bytes.subarray(from, to));
        if (n++ === last) controller.close();
      },
    });
    return new Response(body, { status, headers });
  }
}
