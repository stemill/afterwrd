// A person's own events, and their friends' (docs/events-plan.md). An event is a post (posts.js) with an event attached
// (`events`), shared only with the friends invited (posts.audience 'chosen', post_audience: share.js keeps to that).
// Invited friends answer going, maybe or no from their own sites (POST /_peer/answer); those who haven't said no are
// told when it changes or is called off. Events from elsewhere (friends' invitations, and group events the owner's
// going to) are copied into events_elsewhere, for the calendar.
//
// The owner's side (a form each, from the Events page and the event itself):
//   POST /_admin/events                        title, start_date, start_time?, end_date?, end_time?, place?, zone,
//                                              text?, guest… (connection ids): makes it, and invites them
//   POST /_admin/events/<post id>/edit         the same, without guests: changes it
//   POST /_admin/events/<post id>/invite       guest…: invites more
//   POST /_admin/events/<post id>/uninvite     guest: takes an invitation back
//   POST /_admin/events/<post id>/cancel       calls it off
// Deleting it is deleting the post (posts.js deletePost, which calls eventGone first).
//
// Notes to guests' sites (POST /_peer/notify, through the outbox; PROTOCOL.md):
//   {type: "Invite", actor, object: {type: "Note", id: <the post's address>, content, "afterwrd:event"}}
//   {type: "Update", "afterwrd:change": "changed" | "cancelled", actor, object: {type: "Note", id, "afterwrd:event"}}
//   {type: "Undo", actor, object: {type: "Invite", object: <the post's address>}}
import { actorId, CONTEXT, newPostKey, POST_KEY_RE, postId, targetId } from "../public/static/activity.js";
import { ANSWERS, eventChanged, eventObject, eventWhen, FINISHED_SQL, finishedAt, parseEvent, readEventForm, ruleDates } from "./calendar.js";
import { callSite, siteOrigin } from "./peers.js";
import { parseNote } from "./friends.js";
import { safeNext } from "./auth.js";
import { outbox } from "./outbox.js";
import { ALLOWED_SQL, answerAllowance, TOO_MANY_ANSWERS, wasAllowed } from "./limits.js";
import { html, now, Refusal } from "./util.js";
import { MAX_POST_TEXT } from "./edits.js";
import { messagePage } from "./views/pages.js";

export const MAX_GUESTS = 100; // friends invited to one event
const MAX_ELSEWHERE = 200; // a friend's events kept here, as for a group's (membership.js)
// Notes from a friend about their events (invitations, changes): a handful is plenty, counted apart from comments.
const NOTE_RATE = { count: 10, seconds: 600, daily: 30 };
const KEEP_SECONDS = 30 * 86400; // copies of events from elsewhere stay this long after they're over
const MAX_HOSTING = 100; // events the owner has coming up
const CHANGE_SECONDS = 300; // one change a guest is told about, per event, this often
const SNIPPET = 200;
const FIELDS = ["title", "starts_at", "ends_at", "all_day", "time_zone", "place"];

const snippet = (text, size = SNIPPET) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, size) : "");
const APPROVED = (c = "") => `${c}connected_at IS NOT NULL AND ${c}approved_at IS NOT NULL`;

/** Statements forgetting what a removed friend (`connectionId`) was invited to here, their answers, and their events. */
export const friendGone = (db, connectionId) => [
  db.prepare("DELETE FROM post_audience WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM event_answers WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM events_elsewhere WHERE connection_id = ?").bind(connectionId),
];

// --- reading -----------------------------------------------------------------------------------------------------------

/**
 * The events in some of the owner's posts (posts ids), with who's coming, as `peer` (a friend's connection, {id,
 * origin}; null for the owner) may see them: a guest sees who's going and who might, by name, how many were invited,
 * and their own answer; the owner sees everyone invited and every answer.
 * @returns {Promise<Map<number, any>>}
 */
export async function eventsFor(db, ids, peer = null) {
  if (!ids.length) return new Map();
  const list = JSON.stringify(ids);
  const [events, guests] = await db.batch([
    db.prepare("SELECT * FROM events WHERE post_id IN (SELECT value FROM json_each(?))").bind(list),
    db.prepare(`SELECT a.post_id, c.id, c.origin, c.name, a.delivery, x.answer FROM post_audience a JOIN connections c ON c.id = a.connection_id AND ${APPROVED("c.")}
      LEFT JOIN event_answers x ON x.post_id = a.post_id AND x.connection_id = a.connection_id
      WHERE a.post_id IN (SELECT value FROM json_each(?)) ORDER BY x.answered_at, c.name COLLATE NOCASE`).bind(list),
  ]);
  return new Map(events.results.map((e) => {
    const all = guests.results.filter((g) => g.post_id === e.post_id);
    const who = (answer) => all.filter((g) => g.answer === answer).map((g) => ({ id: g.id, name: g.name, from: g.origin }));
    return [e.post_id, {
      ...e, going: who("going"), maybe: who("maybe"), invited: all.length,
      // Only the host sees who can't go, and who hasn't answered.
      cantGo: peer ? [] : who("no"),
      waiting: peer ? [] : all.filter((g) => !g.answer).map((g) => ({ id: g.id, name: g.name, from: g.origin, delivery: g.delivery })),
      answer: peer ? all.find((g) => g.id === peer.id)?.answer ?? null : null,
    }];
  }));
}

/** An event (as eventsFor gives it) as it's sent to a guest's site: the Event, with who's coming. */
export function guestEventObject(e) {
  const people = (list) => list.map((g) => ({ type: "Person", id: actorId(g.from), name: g.name }));
  return { ...eventObject(e), "afterwrd:going": people(e.going), "afterwrd:maybe": people(e.maybe), "afterwrd:invited": e.invited,
    "afterwrd:answer": e.answer ?? undefined };
}

/** Friends the owner can invite (approved), by name, to tick on the form. */
export async function invitable(db) {
  const { results } = await db.prepare(`SELECT id, name, origin FROM connections WHERE ${APPROVED()} ORDER BY name COLLATE NOCASE`).all();
  return results;
}

// --- notes to guests -----------------------------------------------------------------------------------------------------

async function hostActor(db, origin) {
  const owner = await db.prepare("SELECT name FROM users LIMIT 1").first();
  return { type: "Person", id: actorId(origin), name: snippet(owner?.name ?? "Someone", 100) };
}

async function send(env, ids, note) {
  if (ids.length) await outbox(env).send(ids, { "@context": CONTEXT, ...note });
}

/**
 * Invites these friends (connection ids, already in the post's audience) to the event in `post`. What becomes of each
 * invitation is noted with them (post_audience.delivery), so the host can see whose site didn't take it.
 */
async function sendInvites(env, origin, post, event, ids) {
  if (!ids.length) return;
  await outbox(env).sendInvites(ids, post.id, { "@context": CONTEXT, type: "Invite", actor: await hostActor(env.DB, origin),
    object: { type: "Note", id: postId(origin, post.key), content: snippet(post.text), "afterwrd:event": eventObject(event) } });
}

/** Tells everyone invited who hasn't said no that the event in `post` has changed or been called off (`kind`). */
async function sendChange(env, origin, post, event, kind) {
  const { results } = await env.DB.prepare(`SELECT a.connection_id AS id FROM post_audience a JOIN connections c ON c.id = a.connection_id
    WHERE a.post_id = ?1 AND ${APPROVED("c.")} AND NOT EXISTS (SELECT 1 FROM event_answers x
      WHERE x.post_id = ?1 AND x.connection_id = a.connection_id AND x.answer = 'no') ORDER BY a.connection_id`).bind(post.id).all();
  await send(env, results.map((r) => r.id), { type: "Update", "afterwrd:change": kind, actor: await hostActor(env.DB, origin),
    object: { type: "Note", id: postId(origin, post.key), "afterwrd:event": eventObject(event) } });
}

/** Tells these friends their invitation to `post` has been taken back. */
async function sendUndo(env, origin, post, ids) {
  await send(env, ids, { type: "Undo", actor: await hostActor(env.DB, origin), object: { type: "Invite", object: postId(origin, post.key) } });
}

// --- the owner's actions (see util.js Refusal) ---------------------------------------------------------------------------

/** Approved friends among these connection ids (as a form sends them), each once. */
async function guestsFrom(db, list) {
  const ids = [...new Set(list.map((v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : 0)).filter(Boolean))];
  if (ids.length > MAX_GUESTS) throw new Refusal(`You can invite up to ${MAX_GUESTS} friends to an event.`);
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT id FROM connections WHERE ${APPROVED()} AND id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all();
  return results.map((r) => r.id);
}

/** The owner's event `postId` (with its post), or a refusal. */
async function hosted(db, postId) {
  const row = await db.prepare(`SELECT e.*, p.key, p.text FROM events e JOIN posts p ON p.id = e.post_id AND p.source = 'afterwrd'
    WHERE e.post_id = ?`).bind(Number(postId) || 0).first();
  if (!row) throw new Refusal("That event isn't there any more.", 404);
  return row;
}

const cleanText = (words) => {
  const text = typeof words === "string" ? words.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > MAX_POST_TEXT) throw new Refusal(`The words about it can be up to ${MAX_POST_TEXT} characters.`);
  return text || null;
};

/**
 * A new event: `event` (calendar.js readEventForm), the words about it, and the friends invited (connection ids). It's
 * a post only they see. Returns { id, key }.
 */
export async function createEvent(env, origin, { event, text, guests }) {
  const db = env.DB;
  const words = cleanText(text);
  if (finishedAt(event) <= now()) throw new Refusal("That's already over: pick a time still to come.");
  const ids = await guestsFrom(db, guests);
  const upcoming = await db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${FINISHED_SQL} > ?`).bind(now()).first();
  if (upcoming.n >= MAX_HOSTING) throw new Refusal(`You can have up to ${MAX_HOSTING} events coming up.`);
  const at = now();
  const key = newPostKey(at);
  const post = "(SELECT id FROM posts WHERE key = ?)";
  // One transaction: the post, for those chosen only; the event; who's invited.
  const [made] = await db.batch([
    db.prepare("INSERT INTO posts (key, source, created_at, text, audience) VALUES (?, 'afterwrd', ?, ?, 'chosen') RETURNING id")
      .bind(key, at, words),
    db.prepare(`INSERT INTO events (post_id, ${FIELDS.join(", ")}) VALUES (${post}, ?, ?, ?, ?, ?, ?)`)
      .bind(key, ...FIELDS.map((k) => event[k] ?? null)),
    ...ids.map((id) => db.prepare(`INSERT INTO post_audience (post_id, connection_id, added_at) VALUES (${post}, ?, ?)`).bind(key, id, at)),
  ]);
  const id = made.results[0].id;
  await sendInvites(env, origin, { id, key, text: words }, event, ids);
  return { id, key };
}

/** Invites more friends to the owner's event `postId`. Those already invited aren't sent another. */
export async function inviteMore(env, origin, postId, guests) {
  const db = env.DB;
  const e = await hosted(db, postId);
  if (e.cancelled_at) throw new Refusal("That event's been called off.");
  if (finishedAt(e) <= now()) throw new Refusal("That event is over.");
  const ids = await guestsFrom(db, guests);
  if (!ids.length) return;
  const at = now();
  // Each added only while there's room, in the same statement, so forms sent at once can't go past the limit. Those
  // already invited aren't added again (or sent another invitation).
  const added = (await db.batch(ids.map((id) => db.prepare(`INSERT INTO post_audience (post_id, connection_id, added_at)
    SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM post_audience WHERE post_id = ?1) < ?4
    ON CONFLICT DO NOTHING RETURNING connection_id`).bind(e.post_id, id, at, MAX_GUESTS)))).flatMap((r) => r.results.map((x) => x.connection_id));
  await sendInvites(env, origin, { id: e.post_id, key: e.key, text: e.text }, e, added);
  const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM post_audience WHERE post_id = ? AND connection_id IN (SELECT value FROM json_each(?))`)
    .bind(e.post_id, JSON.stringify(ids)).first();
  if (n < ids.length) throw new Refusal(`You can invite up to ${MAX_GUESTS} friends to an event: not everyone you picked could be.`);
}

/** Takes back friend `connectionId`'s invitation to the owner's event `postId`: they no longer see it, quietly. */
export async function uninvite(env, origin, postId, connectionId) {
  const db = env.DB;
  const e = await hosted(db, postId);
  const id = Number(connectionId) || 0;
  const [gone] = await db.batch([
    db.prepare("DELETE FROM post_audience WHERE post_id = ? AND connection_id = ? RETURNING connection_id").bind(e.post_id, id),
    db.prepare("DELETE FROM event_answers WHERE post_id = ? AND connection_id = ?").bind(e.post_id, id),
  ]);
  if (gone.results.length) await sendUndo(env, origin, { key: e.key }, [id]);
}

/**
 * Changes the owner's event `postId`: `event` and the words about it. If anything a guest would want to know about
 * changed (title, time, zone, place), everyone who hasn't said no is told; at most once every few minutes.
 */
export async function editEvent(env, origin, postId, { event, text }) {
  const db = env.DB;
  const e = await hosted(db, postId);
  const words = cleanText(text);
  if (e.cancelled_at) throw new Refusal("That event's been called off.");
  if (finishedAt(e) <= now()) throw new Refusal("That event is over.");
  if (finishedAt(event) <= now()) throw new Refusal("That would be over already: pick a time still to come.");
  const at = now();
  const writes = [];
  if ((words ?? "") !== (e.text ?? "")) {
    writes.push(
      db.prepare("INSERT INTO post_versions (post_id, text, replaced_at) SELECT id, text, ? FROM posts WHERE id = ?").bind(at, e.post_id),
      db.prepare("UPDATE posts SET text = ?, edited_at = ? WHERE id = ?").bind(words, at, e.post_id),
    );
  }
  const changed = eventChanged(e, event);
  if (changed) {
    // Checked and recorded in the one statement, so changes sent together can't each slip past the limit.
    const done = await db.prepare(`UPDATE events SET ${FIELDS.map((k) => `${k} = ?`).join(", ")}, changed_at = ?
      WHERE post_id = ? AND cancelled_at IS NULL AND (changed_at IS NULL OR changed_at <= ?) RETURNING post_id`)
      .bind(...FIELDS.map((k) => event[k] ?? null), at, e.post_id, at - CHANGE_SECONDS).first();
    if (!done) throw new Refusal("You've just changed this event. Try again in a few minutes.");
  }
  if (writes.length) await db.batch(writes);
  if (changed) await sendChange(env, origin, { id: e.post_id, key: e.key }, { ...e, ...event }, "changed");
}

/** Calls off the owner's event `postId`: it stays, marked as off, and everyone who hasn't said no is told. */
export async function cancelEvent(env, origin, postId) {
  const db = env.DB;
  const e = await hosted(db, postId);
  if (e.cancelled_at) return;
  if (finishedAt(e) <= now()) throw new Refusal("That event is over.");
  const done = await db.prepare("UPDATE events SET cancelled_at = ? WHERE post_id = ? AND cancelled_at IS NULL RETURNING cancelled_at")
    .bind(now(), e.post_id).first();
  if (done) await sendChange(env, origin, { id: e.post_id, key: e.key }, { ...e, cancelled_at: done.cancelled_at }, "cancelled");
}

/**
 * Before the post `post` (a posts row) is deleted: if it's an event still to come, its guests are told it's off.
 * Returns the statements that forget the event, its answers and who it was shared with, for deletePost's batch.
 */
export async function eventGone(env, origin, post) {
  const db = env.DB;
  const e = await db.prepare("SELECT * FROM events WHERE post_id = ?").bind(post.id).first();
  if (e && !e.cancelled_at && finishedAt(e) > now()) await sendChange(env, origin, post, { ...e, cancelled_at: now() }, "cancelled");
  return [
    db.prepare("DELETE FROM events WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM event_answers WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM post_audience WHERE post_id = ?").bind(post.id),
  ];
}

// --- a guest answers, from their site ------------------------------------------------------------------------------------

/**
 * Friend `peer` answers the event in the owner's post `postId`: going, maybe or no. Only while they're invited, it's
 * neither off nor over, and they're within their allowance of answers (limits.js), checked in the same transaction as
 * the answer. Returns null, or { error, status }.
 */
export async function answerFromFriend(db, postId, peer, answer) {
  if (!ANSWERS.includes(answer)) return { error: "Answer going, maybe or no.", status: 400 };
  const at = now();
  const allowance = answerAllowance(db, peer.origin, at);
  const results = await db.batch([...allowance.statements, db.prepare(`INSERT INTO event_answers (post_id, connection_id, answer, answered_at)
    SELECT ?1, ?2, ?3, ?4 FROM events e WHERE e.post_id = ?1 AND e.cancelled_at IS NULL AND ${FINISHED_SQL} > ?4
      AND EXISTS (SELECT 1 FROM post_audience a WHERE a.post_id = ?1 AND a.connection_id = ?2) AND ${ALLOWED_SQL("?5")}
    ON CONFLICT (post_id, connection_id) DO UPDATE SET answer = excluded.answer, answered_at = excluded.answered_at
    RETURNING post_id`).bind(postId, peer.id, answer, at, allowance.token)]);
  if (results.at(-1).results.length) return null;
  // Why not: the event first (gone, off or over), then the allowance.
  const e = await db.prepare("SELECT * FROM events WHERE post_id = ?").bind(postId).first();
  if (!e || e.cancelled_at || finishedAt(e) <= at) {
    return { error: !e ? "That isn't an event." : e.cancelled_at ? "That event's been called off." : "That event is over.", status: 400 };
  }
  return { error: TOO_MANY_ANSWERS, status: 429 };
}

// --- the owner's forms ------------------------------------------------------------------------------------------------

export async function handleEvents(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/events"), url), url.origin);
  const guests = form.getAll("guest").map(String);
  try {
    if (url.pathname === "/_admin/events") {
      const read = readEventForm(form, request.cf?.timezone);
      if (read.error) throw new Refusal(read.error);
      const { key } = await createEvent(env, url.origin, { event: read.event, text: form.get("text"), guests });
      return Response.redirect(`${url.origin}/posts/${key}`, 303);
    }
    const action = /^\/_admin\/events\/(\d{1,15})\/(edit|invite|uninvite|cancel)$/.exec(url.pathname);
    if (!action) return new Response("Not found", { status: 404 });
    const [, id, verb] = action;
    if (verb === "edit") {
      const read = readEventForm(form, request.cf?.timezone);
      if (read.error) throw new Refusal(read.error);
      await editEvent(env, url.origin, id, { event: read.event, text: form.get("text") });
    } else if (verb === "invite") await inviteMore(env, url.origin, id, guests);
    else if (verb === "uninvite") await uninvite(env, url.origin, id, guests[0]);
    else await cancelEvent(env, url.origin, id);
    back.hash ||= `ev-${id}`;
    return Response.redirect(back.href, 303);
  } catch (error) {
    if (error instanceof Refusal) {
      return html(messagePage(error.message, { href: back.pathname + back.search, label: "Go back" }), error.status);
    }
    throw error;
  }
}

// --- a friend's events, on the guest's site -------------------------------------------------------------------------------

/** Someone named in an event's lists: their name, and the site they're from (if it's a proper site address). */
function person(p, env) {
  const name = typeof p?.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 100) || null : null;
  const from = typeof p?.id === "string" ? siteOrigin(p.id.replace(/\/$/, ""), env) : null;
  return { name, from };
}

/**
 * An event another site sent with a post (a friend's, or a group's), checked: the event (calendar.js parseEvent), who's
 * going, who might, who can't (a group says; a friend's site doesn't), how many were invited (a friend's), and the
 * owner here's own answer. Null if it isn't one.
 */
export function parseSharedEvent(o, env) {
  const event = parseEvent(o);
  if (!event) return null;
  const people = (list) => (Array.isArray(list) ? list.slice(0, 200) : []).map((p) => person(p, env)).filter((p) => p.name);
  const lists = (x) => ({ going: people(x["afterwrd:going"]), maybe: people(x["afterwrd:maybe"]), cantGo: people(x["afterwrd:cantGo"]),
    answer: ANSWERS.includes(x["afterwrd:answer"]) ? x["afterwrd:answer"] : null });
  const invited = o["afterwrd:invited"];
  // A repeating one (a group's): who's coming to each date, and the owner here's answer for it; only its own dates.
  const own = new Set(event.rrule ? ruleDates(event) : []);
  const dates = event.rrule ? (Array.isArray(o["afterwrd:dates"]) ? o["afterwrd:dates"].slice(0, 60) : [])
    .filter((d) => typeof d?.["afterwrd:date"] === "string" && own.has(d["afterwrd:date"]))
    .map((d) => ({ date: d["afterwrd:date"], ...lists(d) })) : [];
  return { ...event, ...(event.rrule ? { going: [], maybe: [], cantGo: [], answer: null } : lists(o)), dates: [...new Map(dates.map((d) => [d.date, d])).values()],
    invited: Number.isSafeInteger(invited) && invited >= 0 && invited <= 10_000 ? invited : null };
}

const COPY = ["title", "starts_at", "ends_at", "all_day", "time_zone", "place", "cancelled_at"];

// SQL, inside keepCopy (?1 the friend's connection, ?12 now): the friend's site is still within its allowance of event
// notes. Checked in the very statement that writes the copy, so a note over the allowance writes nothing at all.
const NOTE_ALLOWANCE = `(SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND kind IN ('invite', 'changed', 'cancelled')
    AND created_at > ?12 - ${NOTE_RATE.seconds}) < ${NOTE_RATE.count}
  AND (SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND kind IN ('invite', 'changed', 'cancelled')
    AND created_at > ?12 - 86400) < ${NOTE_RATE.daily}`;

/**
 * A statement keeping the owner's copy of friend `connectionId`'s event in post `key`, as their site just showed it.
 * A new copy is made only for an event still to come, and only while the friend has fewer than MAX_ELSEWHERE copies
 * kept here (over or not: they're let go 30 days after they're over); it starts unanswered, unless `answer` is the
 * owner's own, just given. A copy already kept is written only if something's changed, and its answer only changes
 * with the owner's own. `guard`: SQL that must hold too (a note's allowance).
 * @param {any} db
 * @param {number} connectionId
 * @param {string} key
 * @param {any} event
 * @param {{ answer?: string, invited?: boolean, guard?: string }} [options]
 */
function keepCopy(db, connectionId, key, event, options = {}) {
  const { answer, invited = false, guard = "1" } = options;
  const at = now();
  const changed = [...COPY.map((k) => `events_elsewhere.${k} IS NOT excluded.${k}`),
    ...(answer === undefined ? [] : ["events_elsewhere.answer IS NOT excluded.answer"]),
    ...(invited ? ["events_elsewhere.invited_at IS NULL"] : [])].join(" OR ");
  return db.prepare(`INSERT INTO events_elsewhere (connection_id, post_key, answer, ${COPY.join(", ")}, invited_at, updated_at)
    SELECT ?1, ?2, ?3, ${COPY.map((_, i) => `?${i + 4}`).join(", ")}, ?11, ?12
    WHERE (${guard}) AND (EXISTS (SELECT 1 FROM events_elsewhere WHERE connection_id = ?1 AND post_key = ?2)
      OR (?14 = 1 AND (SELECT COUNT(*) FROM events_elsewhere WHERE connection_id = ?1) < ?13))
    ON CONFLICT (connection_id, post_key) WHERE connection_id IS NOT NULL DO UPDATE SET
      ${COPY.map((k) => `${k} = excluded.${k}`).join(", ")}, updated_at = excluded.updated_at,
      answer = ${answer === undefined ? "events_elsewhere.answer" : "excluded.answer"},
      invited_at = COALESCE(events_elsewhere.invited_at, excluded.invited_at)
    WHERE ${changed}`)
    .bind(connectionId, key, answer ?? null, ...COPY.map((k) => event[k] ?? null), invited ? at : null, at, MAX_ELSEWHERE,
      finishedAt(event) > at ? 1 : 0);
}

/**
 * Keeps the owner's copies of friend `connection`'s events up to date with their posts as just read (friends.js
 * parseNote). Their site only shows an event to those it invited, so seeing one means the owner's invited.
 */
export async function keepFriendEvents(db, connection, posts) {
  const events = posts.filter((p) => p.event);
  if (events.length) await db.batch(events.map((p) => keepCopy(db, connection.id, p.key, p.event)));
}

/** The words a note about an event is kept with: its title, when, and where. */
const eventWords = (e) => `${e.title} · ${eventWhen(e)}${e.place ? ` · ${e.place}` : ""}`.slice(0, 400);

/**
 * A note from friend `peer` about one of their events: an invitation, a change, or an invitation taken back. Kept,
 * ignored, or refused; returns [body, status]. Only about their own posts, and changes only to events the owner here
 * was invited to and hasn't said no to.
 * @returns {Promise<import("./util.js").Answer>}
 */
export async function receiveFriendEventNote(db, peer, note) {
  const undo = note.type === "Undo";
  const address = undo ? note.object?.object : note.object?.id;
  const prefix = postId(peer.origin, "");
  const key = typeof address === "string" && address.startsWith(prefix) ? address.slice(prefix.length) : "";
  if (!POST_KEY_RE.test(key) || (undo ? note.object?.type !== "Invite" : note.object?.type !== "Note")) {
    return [{ error: "That isn't about an event on your site." }, 400];
  }
  if (undo) {
    // Taken back: the copy goes, and so does what Notifications said about it. Nothing is shown.
    await db.batch([
      db.prepare("DELETE FROM events_elsewhere WHERE connection_id = ? AND post_key = ?").bind(peer.id, key),
      db.prepare("DELETE FROM inbox WHERE connection_id = ? AND target = ? AND kind IN ('invite', 'changed', 'cancelled')").bind(peer.id, key),
    ]);
    return [{ ok: true }, 202];
  }
  const event = parseEvent(note.object["afterwrd:event"]);
  const kind = note.type === "Invite" ? "invite" : note.type === "Update" ? note["afterwrd:change"] : null;
  if (!event || !["invite", "changed", "cancelled"].includes(kind)) return [{ error: "That isn't about an event on your site." }, 400];
  const at = now();
  if (kind === "cancelled") event.cancelled_at ??= at;
  // An event already over is nothing to anyone now.
  if (finishedAt(event) <= at) return [{ ok: true }, 202];
  const had = await db.prepare("SELECT answer FROM events_elsewhere WHERE connection_id = ? AND post_key = ?").bind(peer.id, key).first();
  // An invitation to something the owner's already invited to changes nothing (a change would say so); a change to an
  // event they weren't invited to, or said no to, is nothing to them.
  if (kind === "invite" ? had : !had || had.answer === "no") return [{ ok: true }, 202];
  // The allowance, and room for a new copy, are checked in the same statements as the writes: over it, nothing's written.
  const [, kept, row] = await db.batch([
    // Their copies long over make room first (they count towards MAX_ELSEWHERE).
    db.prepare(`DELETE FROM events_elsewhere AS e WHERE e.connection_id = ? AND ${FINISHED_SQL} < ?`).bind(peer.id, at - KEEP_SECONDS),
    keepCopy(db, peer.id, key, event, { invited: kind === "invite", guard: NOTE_ALLOWANCE }),
    db.prepare(`INSERT INTO inbox (connection_id, kind, target, actor, text, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM events_elsewhere WHERE connection_id = ?1 AND post_key = ?3)
        AND (SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND kind IN ('invite', 'changed', 'cancelled') AND created_at > ?6 - ?7) < ?8
        AND (SELECT COUNT(*) FROM inbox WHERE connection_id = ?1 AND kind IN ('invite', 'changed', 'cancelled') AND created_at > ?6 - 86400) < ?9
        AND NOT (?2 = 'invite' AND EXISTS (SELECT 1 FROM inbox WHERE connection_id = ?1 AND kind = 'invite' AND target = ?3))
      RETURNING id`).bind(peer.id, kind, key, peer.name, eventWords(event), at, NOTE_RATE.seconds, NOTE_RATE.count, NOTE_RATE.daily),
  ]);
  if (kind === "invite" && !kept.meta.changes) return [{ error: "That's a lot of events for now." }, 429];
  return row.results.length ? [{ ok: true }, 202] : [{ error: "That's a lot of notes for now." }, 429];
}

/**
 * The owner answers friend `connection`'s event in their post `key`: going, maybe or no. Their site keeps it; the
 * owner's copy here is brought up to date from what it answers.
 */
export async function answerFriendEvent(env, connection, key, answer) {
  if (!POST_KEY_RE.test(key)) throw new Refusal("That isn't an event you can answer.");
  const type = { going: "Accept", maybe: "TentativeAccept", no: "Reject" }[answer];
  if (!type) throw new Refusal("Answer going, maybe or can't go.");
  let reply;
  try {
    reply = await callSite(connection.origin, "/_peer/answer", { key: connection.their_key,
      body: { "@context": CONTEXT, type, object: targetId(connection.origin, key) } });
  } catch (error) {
    // A site from before events answers an unknown address with "Not found.".
    if (error.status === 404 && error.message === "Not found.") throw new Refusal(`${connection.name}'s site needs updating before you can answer.`);
    throw new Refusal(`Couldn't send your answer: ${error.message}`);
  }
  const post = parseNote(reply, connection.origin, connection.name, env);
  if (post?.key !== key || !post.event) throw new Refusal("Their site sent something unexpected.");
  await keepCopy(env.DB, connection.id, key, post.event, { answer }).run();
}

/** Lets go of copies of events from elsewhere long over. */
export const oldEventsGone = (db) => db.prepare(`DELETE FROM events_elsewhere AS e WHERE ${FINISHED_SQL} < ?`).bind(now() - KEEP_SECONDS);
