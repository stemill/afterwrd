// Polls: a post that asks a question (its words) with 2 to 10 options. Used by both kinds of site: a person's own posts
// (posts.js keeps them, friends answer through /_peer/vote, peers.js) and groups (groups.js keeps them, members answer
// through /_group/polls/<m>/vote). Wherever a poll is kept, it decides who sees what:
//   - everyone who can see the post sees how many chose each option, and which they chose themselves;
//   - only whoever asked sees who chose what (their own site shows it; a group tells only the writer's site).
// Answers notify no one. A poll closes when its writer closes it, or by itself at the time they picked.
//
// Between sites a poll is an ActivityStreams Question on the post (as Mastodon's polls are, so it reads as one):
//   "afterwrd:poll": { type: "Question", oneOf | anyOf: [{ type: "Note", name, replies: { totalItems } }, …],
//                      endTime?, closed?, votersCount, "afterwrd:chosen": [the asker's options] }
// anyOf when more than one may be chosen. An older site ignores it, and shows the post's words alone.
import { actorId, iso, seconds } from "../public/static/activity.js";
import { siteOrigin } from "./peers.js";
import { now } from "./util.js";
import { ALLOWED_SQL, answerAllowance, TOO_MANY_ANSWERS, wasAllowed } from "./limits.js";

export const MAX_OPTIONS = 10;
export const MAX_OPTION = 100;
const LONGEST = 366 * 86400; // a closing time can be up to a year away
const MAX_VOTERS = 500; // names a writer's site will take for one option

const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * A new poll, as the composer sends it: { options: [text…], multiple, closes_at (seconds, or nothing) }. Returns
 * { poll } (null if there's none) or { error }.
 */
export function readPoll(input, at = now()) {
  if (input === undefined || input === null) return { poll: null };
  if (typeof input !== "object" || !Array.isArray(input.options)) return { error: "Unexpected poll details." };
  const options = input.options.slice(0, MAX_OPTIONS + 1).map(clean).filter(Boolean);
  if (options.length < 2) return { error: "A poll needs at least two options." };
  if (options.length > MAX_OPTIONS) return { error: `A poll can have up to ${MAX_OPTIONS} options.` };
  if (options.some((o) => o.length > MAX_OPTION)) return { error: `Options can be up to ${MAX_OPTION} characters.` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: "Each option needs to be different." };
  const closes = input.closes_at === undefined || input.closes_at === null || input.closes_at === "" ? null : Number(input.closes_at);
  if (closes !== null && (!Number.isSafeInteger(closes) || closes <= at || closes > at + LONGEST)) {
    return { error: "Pick a closing date within the next year." };
  }
  return { poll: { options, multiple: input.multiple === true || input.multiple === 1 ? 1 : 0, closes_at: closes } };
}

/** A new poll as a Question, to send to a group (no counts yet). */
export const questionFor = (poll) => ({
  type: "Question", [poll.multiple ? "anyOf" : "oneOf"]: poll.options.map((name) => ({ type: "Note", name })),
  endTime: iso(poll.closes_at ?? undefined),
});

/** The poll a member's site sent with a new post (questionFor), for readPoll to check. */
export function pollFromQuestion(o) {
  if (o?.type !== "Question") return { options: null };
  const list = Array.isArray(o.anyOf) ? o.anyOf : o.oneOf;
  return { options: Array.isArray(list) ? list.slice(0, MAX_OPTIONS + 1).map((x) => x?.name) : null,
    multiple: Array.isArray(o.anyOf) ? 1 : 0, closes_at: o.endTime === undefined ? null : seconds(o.endTime) ?? -1 };
}

/** Whether a kept poll (a polls or group_polls row) is still taking answers. */
export const isOpen = (row, at = now()) => !row.closed_at && (!row.closes_at || row.closes_at > at);

/** SQL: the poll on post ?1 is still open at ?2 (for the table `table`), so an answer can't slip in after it closes. */
export const OPEN_SQL = (table) => `EXISTS (SELECT 1 FROM ${table} WHERE post_id = ?1 AND closed_at IS NULL
  AND (closes_at IS NULL OR closes_at > ?2))`;

const bitCount = (n) => n.toString(2).replace(/0/g, "").length;

/**
 * The options someone chose (their numbers) as bits, if that's a fair answer to this poll: options it has, and only
 * one unless it takes more. 0 takes their answer back. Null if it isn't fair.
 */
export function choicesMask(list, row) {
  if (!Array.isArray(list) || list.length > MAX_OPTIONS) return null;
  const n = JSON.parse(row.options).length;
  let mask = 0;
  for (const value of list) {
    const i = typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(i) || i < 0 || i >= n) return null;
    mask |= 1 << i;
  }
  return !row.multiple && bitCount(mask) > 1 ? null : mask;
}

/**
 * A kept poll as pages show it: each option with how many chose it, whether `viewer` did, and (`names`, for whoever
 * asked) who did. `votes`: [{ voter, name, choices }].
 */
export function tally(row, votes, { viewer = null, names = false } = {}) {
  const mine = votes.find((v) => v.voter === viewer)?.choices ?? 0;
  return {
    options: JSON.parse(row.options).map((name, i) => {
      const chose = votes.filter((v) => v.choices & (1 << i));
      return { name, count: chose.length, chosen: Boolean(mine & (1 << i)),
        voters: names ? chose.map((v) => ({ name: v.name, from: v.voter === "site" ? null : v.voter })) : null };
    }),
    multiple: Boolean(row.multiple), closes_at: row.closes_at ?? null, closed_at: row.closed_at ?? null, open: isOpen(row),
    voters: votes.length, answered: Boolean(mine),
  };
}

/** A poll (as tally gives it) as a Question, for another site. Names go only where tally put them. */
export function pollObject(p) {
  return {
    type: "Question",
    [p.multiple ? "anyOf" : "oneOf"]: p.options.map((o) => ({
      type: "Note", name: o.name, replies: { type: "Collection", totalItems: o.count },
      "afterwrd:voters": o.voters?.map((v) => ({ type: "Person", id: v.from ? actorId(v.from) : undefined, name: v.name })),
    })),
    endTime: iso(p.closes_at ?? undefined),
    closed: iso(p.closed_at ?? (p.open ? undefined : p.closes_at ?? undefined)),
    votersCount: p.voters,
    "afterwrd:chosen": p.options.flatMap((o, i) => (o.chosen ? [i] : [])),
  };
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

/**
 * A poll another site sent (pollObject), checked, as pages show it; null if it isn't one. Who chose what is only
 * read with `names` (a group telling the writer's site about their own poll): otherwise none is shown.
 */
export function parsePoll(o, env, { names = false } = {}) {
  if (o?.type !== "Question") return null;
  const multiple = Array.isArray(o.anyOf);
  const list = multiple ? o.anyOf : o.oneOf;
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_OPTIONS) return null;
  const chosen = new Set(Array.isArray(o["afterwrd:chosen"]) ? o["afterwrd:chosen"].slice(0, MAX_OPTIONS) : []);
  const options = list.map((x, i) => {
    const name = typeof x?.name === "string" && x.name.length <= MAX_OPTION * 2 ? clean(x.name) : "";
    const n = count(x?.replies?.totalItems) ?? 0;
    const voters = names && Array.isArray(x?.["afterwrd:voters"]) ? x["afterwrd:voters"].slice(0, MAX_VOTERS).flatMap((p) => {
      const who = typeof p?.name === "string" ? clean(p.name).slice(0, 100) : "";
      const from = typeof p?.id === "string" ? siteOrigin(p.id.replace(/\/$/, ""), env) : null;
      return who ? [{ name: who, from }] : [];
    }) : null;
    return name && { name, count: n, chosen: chosen.has(i), voters };
  });
  if (!options.every(Boolean)) return null;
  // One choice only, unless it takes more: a site saying otherwise is believed for the first.
  if (!multiple) options.forEach((x, i) => { x.chosen &&= options.findIndex((y) => y.chosen) === i; });
  const closes = o.endTime === undefined ? null : seconds(o.endTime);
  const closed = o.closed === undefined || o.closed === false ? null : seconds(o.closed) ?? now();
  return {
    options, multiple, closes_at: closes, closed_at: closed, open: !closed && (!closes || closes > now()),
    voters: count(o.votersCount) ?? Math.max(0, ...options.map((x) => x.count)), answered: options.some((x) => x.chosen),
  };
}

// --- the owner's own polls (in their posts here) -------------------------------------------------------------------------

/** The polls in some of the owner's posts (posts ids), as `viewer` ('site', the owner; or a friend's site) sees them. */
export async function sitePolls(db, ids, viewer) {
  if (!ids.length) return new Map();
  const marks = ids.map(() => "?").join(",");
  const [polls, votes] = await db.batch([
    db.prepare(`SELECT * FROM polls WHERE post_id IN (${marks})`).bind(...ids),
    db.prepare(`SELECT post_id, voter, name, choices FROM poll_votes WHERE post_id IN (${marks}) ORDER BY voted_at`).bind(...ids),
  ]);
  return new Map(polls.results.map((row) => [row.post_id,
    tally(row, votes.results.filter((v) => v.post_id === row.post_id), { viewer, names: viewer === "site" })]));
}

/**
 * Someone answers a poll in the owner's posts: the owner here (`voter` 'site') or a friend's site, within their
 * allowance of answers (limits.js; the owner has none). `list`: the options they chose (none takes their answer back).
 * Post ids are never used twice, so an answer meant for a post deleted just now can't land on another. Returns null
 * if that went, or the reason it didn't (TOO_MANY_ANSWERS, if that's why).
 */
export async function answerHere(db, postId, voter, name, list) {
  const row = await db.prepare("SELECT * FROM polls WHERE post_id = ?").bind(postId).first();
  if (!row) return "That post doesn't have a poll.";
  if (!isOpen(row)) return "That poll has closed.";
  const mask = choicesMask(list, row);
  if (mask === null) return row.multiple ? "Those aren't options in this poll." : "Pick one of the options.";
  const at = now();
  // A friend's answer counts towards their allowance; the owner's own doesn't (its SQL holds: "1").
  const allowance = voter === "site" ? null : answerAllowance(db, voter, at);
  const allowed = allowance ? ALLOWED_SQL("?6") : "1";
  // D1 wants exactly as many values as a statement uses: the token only when it's asked about.
  const binds = [postId, at, voter, name, mask, ...(allowance ? [allowance.token] : [])];
  const tooMany = async () => (allowance && !(await wasAllowed(db, allowance.token)) ? TOO_MANY_ANSWERS : null);
  if (!mask) {
    // Taking an answer back, too, only while it's open: an answer still there afterwards means it had closed.
    await db.batch([...(allowance?.statements ?? []),
      db.prepare(`DELETE FROM poll_votes WHERE post_id = ?1 AND voter = ?3 AND ${OPEN_SQL("polls")} AND ${allowed}`)
        .bind(...(allowance ? binds : binds.slice(0, 3)))]);
    const left = await db.prepare("SELECT 1 FROM poll_votes WHERE post_id = ? AND voter = ?").bind(postId, voter).first();
    return left ? (await tooMany()) ?? "That poll has closed." : null;
  }
  const results = await db.batch([...(allowance?.statements ?? []), db.prepare(`INSERT INTO poll_votes (post_id, voter, name, choices, voted_at)
    SELECT ?1, ?3, ?4, ?5, ?2 WHERE ${OPEN_SQL("polls")} AND ${allowed}
    ON CONFLICT (post_id, voter) DO UPDATE SET name = excluded.name, choices = excluded.choices, voted_at = excluded.voted_at
    RETURNING post_id`).bind(...binds)]);
  return results.at(-1).results.length ? null : (await tooMany()) ?? "That poll has closed.";
}
