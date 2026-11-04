// Notes waiting to go to other sites (notify.js), sent a batch at a time by this Durable Object's alarm: to friends'
// sites (POST /_peer/notify) and, in a group's Worker, to its members' sites (POST /_member/notify). One request
// may only call 50 other sites on Cloudflare's free plan; batches of 40, one after another, let a post reach any
// number of friends. A site that can't be reached is tried again later (after 1, 5 and 30 minutes, then 2 and 6
// hours) and then given up on; a site that says no (it's disconnected, or doesn't want the note) isn't asked again.
// Notes hold the connection or member, not its key: the key is looked up in D1 when sending, so a disconnect (or a
// member leaving) stops them at once.
import { DurableObject } from "cloudflare:workers";

const BATCH = 40;
const TIMEOUT_MS = 5000;
const RETRY_SECONDS = [60, 300, 1800, 7200, 21600];

export const outbox = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("outbox"));

// Who each kind of note goes to: its table here, how to find their site and key in D1, and where to send it.
const KINDS = {
  notes: { column: "connection_id", path: "/_peer/notify",
    sql: "SELECT id, origin, their_key FROM connections WHERE approved_at IS NOT NULL AND id IN" },
  member_notes: { column: "member_id", path: "/_member/notify",
    sql: "SELECT id, origin, their_key FROM group_members WHERE approved_at IS NOT NULL AND id IN" },
};

export class Outbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const [table, { column }] of Object.entries(KINDS)) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ${column} INTEGER NOT NULL, body TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
      )`);
    }
  }

  /** Queues `body` for each connection id (friends' sites), and sees that the alarm will send it. */
  send(connectionIds, body) {
    return this.queue("notes", connectionIds, body);
  }

  /** Queues `body` for each group member id (in a group's Worker, members' sites). */
  sendToMembers(memberIds, body) {
    return this.queue("member_notes", memberIds, body);
  }

  async queue(table, ids, body) {
    const text = JSON.stringify(body);
    const at = Date.now();
    for (const id of ids) this.sql.exec(`INSERT INTO ${table} (${KINDS[table].column}, body, due) VALUES (?, ?, ?)`, id, text, at);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    let room = BATCH;
    for (const table of Object.keys(KINDS)) room -= await this.sendDue(table, room);
    const next = Math.min(...Object.keys(KINDS).map((t) => this.sql.exec(`SELECT MIN(due) AS due FROM ${t}`).one().due ?? Infinity));
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /** Sends up to `limit` notes from `table` that are due; returns how many it tried. */
  async sendDue(table, limit) {
    if (limit <= 0) return 0;
    const { column, path, sql } = KINDS[table];
    const at = Date.now();
    const due = this.sql.exec(`SELECT * FROM ${table} WHERE due <= ? ORDER BY id LIMIT ?`, at, limit).toArray();
    const ids = [...new Set(due.map((n) => n[column]))];
    const { results } = ids.length ? await this.env.DB.prepare(`${sql} (${ids.map(() => "?").join(",")})`).bind(...ids).all() : { results: [] };
    const recipients = new Map(results.map((c) => [c.id, c]));

    await Promise.all(due.map(async (note) => {
      const to = recipients.get(note[column]);
      let delivered = false;
      let again = Boolean(to);
      if (to) {
        try {
          const response = await fetch(`${to.origin}${path}`, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Authorization: `Bearer ${to.their_key}`, "Content-Type": "application/json" }, body: note.body,
          });
          await response.body?.cancel();
          delivered = response.ok;
          again = response.status >= 500 || response.status === 429; // anything else won't change by asking again
        } catch {} // unreachable: try again later
      }
      if (delivered || !again || note.tries >= RETRY_SECONDS.length) this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, note.id);
      else this.sql.exec(`UPDATE ${table} SET tries = tries + 1, due = ? WHERE id = ?`, at + RETRY_SECONDS[note.tries] * 1000, note.id);
    }));
    return due.length;
  }
}
