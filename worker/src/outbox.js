// Notes waiting to go to friends' sites (notify.js), sent a batch at a time by this Durable Object's alarm. One
// request may only call 50 other sites on Cloudflare's free plan; batches of 40, one after another, let a post reach
// any number of friends. A site that can't be reached is tried again later (after 1, 5 and 30 minutes, then 2 and 6
// hours) and then given up on; a site that says no (it's disconnected, or doesn't want the note) isn't asked again.
// Notes hold the connection, not its key: the key is looked up in D1 when sending, so a disconnect stops them at once.
import { DurableObject } from "cloudflare:workers";

const BATCH = 40;
const TIMEOUT_MS = 5000;
const RETRY_SECONDS = [60, 300, 1800, 7200, 21600];

export const outbox = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("outbox"));

export class Outbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id INTEGER NOT NULL, body TEXT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    )`);
  }

  /** Queues `body` for each connection id, and sees that the alarm will send it. */
  async send(connectionIds, body) {
    const text = JSON.stringify(body);
    const at = Date.now();
    for (const id of connectionIds) this.sql.exec("INSERT INTO notes (connection_id, body, due) VALUES (?, ?, ?)", id, text, at);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const at = Date.now();
    const due = this.sql.exec("SELECT * FROM notes WHERE due <= ? ORDER BY id LIMIT ?", at, BATCH).toArray();
    const ids = [...new Set(due.map((n) => n.connection_id))];
    const { results } = ids.length ? await this.env.DB.prepare(`SELECT id, origin, their_key FROM connections
      WHERE approved_at IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all() : { results: [] };
    const connections = new Map(results.map((c) => [c.id, c]));

    await Promise.all(due.map(async (note) => {
      const to = connections.get(note.connection_id);
      let delivered = false;
      let again = Boolean(to);
      if (to) {
        try {
          const response = await fetch(`${to.origin}/_peer/notify`, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Authorization: `Bearer ${to.their_key}`, "Content-Type": "application/json" }, body: note.body,
          });
          await response.body?.cancel();
          delivered = response.ok;
          again = response.status >= 500 || response.status === 429; // anything else won't change by asking again
        } catch {} // unreachable: try again later
      }
      if (delivered || !again || note.tries >= RETRY_SECONDS.length) this.sql.exec("DELETE FROM notes WHERE id = ?", note.id);
      else this.sql.exec("UPDATE notes SET tries = tries + 1, due = ? WHERE id = ?", at + RETRY_SECONDS[note.tries] * 1000, note.id);
    }));

    const next = this.sql.exec("SELECT MIN(due) AS due FROM notes").one().due;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}
