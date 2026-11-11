// Notes waiting to go to other sites (notify.js), sent a batch at a time by this Durable Object's alarm (and, apart
// from them, in a separate object of this class named "vault", the few secrets the site keeps for automatic updates:
// auto.js, the vault table below): to friends'
// sites (POST /_peer/notify) and, in a group's Worker, to its members' sites (POST /_member/notify). Also messages
// to friends (messages.js, POST /_peer/message) that couldn't be delivered straight away: those go first, and the
// message here is marked delivered, or not delivered and why, when that's known. One request
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
const FRIENDS = "SELECT id, origin, their_key FROM connections WHERE approved_at IS NOT NULL AND id IN";
const MEMBERS = "SELECT id, origin, their_key FROM group_members WHERE approved_at IS NOT NULL AND id IN";
// `track`: a message of the owner's (messages.js), marked delivered here, or not delivered and why, when that's known.
const KINDS = {
  messages: { column: "connection_id", more: "message_id INTEGER NOT NULL,", path: "/_peer/message", sql: FRIENDS, track: true },
  // A message in a group's chat, to the group's site; and, in a group's Worker, passed on to its members' sites.
  group_messages: { column: "group_id", more: "message_id INTEGER NOT NULL,", path: "/_group/chat", track: true,
    sql: "SELECT id, origin, their_key FROM groups WHERE joined_at IS NOT NULL AND origin IS NOT NULL AND id IN" },
  notes: { column: "connection_id", path: "/_peer/notify", sql: FRIENDS },
  member_notes: { column: "member_id", path: "/_member/notify", sql: MEMBERS },
  // Last, so a busy chat can't hold up a group's comments and event changes, which are few.
  member_messages: { column: "member_id", path: "/_member/message", sql: MEMBERS },
};

export class Outbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const [table, { column, more = "" }] of Object.entries(KINDS)) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ${column} INTEGER NOT NULL, ${more} body TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
      )`);
    }
    // Secrets the site keeps for itself (auto.js), only ever in the object named "vault", never the "outbox" one: the
    // background grant's refresh token, which changes at every use (so it can't be a Worker secret: changing one makes
    // a new version), and the key its own update steps carry. Here rather than in D1, so they're never in an export, a
    // restored database or anything a page reads.
    this.sql.exec("CREATE TABLE IF NOT EXISTS vault (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  /** A secret kept here (auto.js), or null. */
  secret(name) {
    return this.sql.exec("SELECT value FROM vault WHERE name = ?", name).toArray()[0]?.value ?? null;
  }

  /** Keeps a secret here, replacing any of that name; null deletes it. */
  keepSecret(name, value) {
    if (value === null) this.sql.exec("DELETE FROM vault WHERE name = ?", name);
    else this.sql.exec("INSERT INTO vault (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);
  }

  /** Queues `body` for each connection id (friends' sites), and sees that the alarm will send it. */
  send(connectionIds, body) {
    return this.queue("notes", connectionIds, body);
  }

  /** Queues `body` for each group member id (in a group's Worker, members' sites). */
  sendToMembers(memberIds, body) {
    return this.queue("member_notes", memberIds, body);
  }

  /**
   * Queues a message (messages.js) that couldn't be delivered straight away, to try again in `delay` seconds: to a
   * friend (`table` messages, `to` their connection) or a group (group_messages, the group).
   */
  async sendMessage(table, to, messageId, body, delay) {
    if (!KINDS[table]?.track) throw new Error(`Not a kind of message: ${table}`);
    const due = Date.now() + delay * 1000;
    this.sql.exec(`INSERT INTO ${table} (${KINDS[table].column}, message_id, body, due) VALUES (?, ?, ?, ?)`, to, messageId, JSON.stringify(body), due);
    await this.wake(due);
  }

  /** In a group's Worker: passes a message in its chat, or its deletion, on to members' sites (`memberIds`, group_members ids). */
  sendChatToMembers(memberIds, body) {
    return this.queue("member_messages", memberIds, body);
  }

  async queue(table, ids, body) {
    const text = JSON.stringify(body);
    const at = Date.now();
    for (const id of ids) this.sql.exec(`INSERT INTO ${table} (${KINDS[table].column}, body, due) VALUES (?, ?, ?)`, id, text, at);
    await this.wake(at);
  }

  /** Sees that the alarm goes off by `at`, even if it was set for later (a retry hours away). */
  async wake(at) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
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
    // A message the owner has deleted here since (or that's been delivered after all) isn't sent.
    const waiting = !KINDS[table].track ? null : due.length ? new Set((await this.env.DB.prepare(
      `SELECT id FROM messages WHERE delivered_at IS NULL AND id IN (${due.map(() => "?").join(",")})`)
      .bind(...due.map((n) => n.message_id)).all()).results.map((m) => m.id)) : new Set();

    await Promise.all(due.map(async (note) => {
      if (waiting && !waiting.has(note.message_id)) {
        this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, note.id);
        return;
      }
      const to = recipients.get(note[column]);
      let delivered = false;
      let again = Boolean(to);
      let status = to ? 0 : 403; // 0: unreachable
      if (to) {
        try {
          const response = await fetch(`${to.origin}${path}`, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Authorization: `Bearer ${to.their_key}`, "Content-Type": "application/json" }, body: note.body,
          });
          await response.body?.cancel();
          status = response.status;
          delivered = response.ok;
          again = response.status >= 500 || response.status === 429; // anything else won't change by asking again
        } catch {} // unreachable: try again later
      }
      const finished = delivered || !again || note.tries >= RETRY_SECONDS.length;
      if (finished) this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, note.id);
      else this.sql.exec(`UPDATE ${table} SET tries = tries + 1, due = ? WHERE id = ?`, at + RETRY_SECONDS[note.tries] * 1000, note.id);
      if (waiting && finished) {
        const when = Math.floor(Date.now() / 1000);
        await (delivered
          ? this.env.DB.prepare("UPDATE messages SET delivered_at = ?, failed_at = NULL, problem = NULL WHERE id = ?").bind(when, note.message_id)
          : this.env.DB.prepare("UPDATE messages SET failed_at = ?, problem = ? WHERE id = ? AND delivered_at IS NULL")
            .bind(when, messageProblem(status), note.message_id)).run();
      }
    }));
    return due.length;
  }
}

/**
 * Why a message wasn't delivered, from what the friend's site answered (0: it couldn't be reached), as messages.problem.
 * Shown in words by the chat page (views/messages.js).
 */
export function messageProblem(status) {
  if (status === 0 || status >= 500 || status === 429) return "unreachable";
  if (status === 404) return "no-messages"; // a site without messages (an older afterwrd, or switched off)
  if (status === 401 || status === 403) return "not-friends";
  return "refused";
}
