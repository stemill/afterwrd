// Groups, from a person's site. Each group is its own Worker (groups.js); this site reads it from there when its page
// opens, with the key the group gave when this site joined, and sends what the owner posts and says there, and, if
// they run the group, their decisions. Copies of what they post and say are kept here (group_mine), so a group can't
// put words in their mouth, and so notes are only taken about posts they're part of. Everything a group sends is
// checked here and turned into plain shapes for the pages, as with friends' sites (friends.js).
//
// Joining: the owner opens an invite link (/_join/<token> on the group's site), which brings them to
// /groups/join?link=… here to confirm; this site then keeps a new key for the group to call it with, sends it to the
// group's /_join/<token>/accept, and the group checks it by calling /_member/hello, below, before answering with a key
// for calling it. Starting a group (groupsites.js) ends the same way, with /_group/claim instead.
//
// What a group's site may ask of this one, with that key:
//   GET  /_member/hello?from=<origin>&group=<n>  only mid-join, to prove to <origin> the key is ours, for that group
//   POST /_member/notify      a comment on a post the owner here wrote or commented on, or a change to an event
//                             they're going to (notify.js; a change also tells the owner's devices: push.js)
//   POST /_member/removed     the group removed this site, turned down its request, or closed
// The owner's own actions, from their pages (views.js); forms land back where they came from:
//   POST /_groups/join                    {link}
//   POST /_groups/create/…                starting a group (groupsites.js)
//   POST /_groups/<id>/posts              {text, photos} (compose.js)
//   POST /_groups/<id>/comments           post, text, back
//   POST /_groups/<id>/(posts|comments)/<n>/delete    back
//   POST /_groups/<id>/(posts|comments)/<n>/edit      text, back: their own words, while the group still lets them
//   POST /_groups/<id>/leave
//   POST /_groups/<id>/events             an event (the form in views.js): they're going, to start with
//   POST /_groups/<id>/events/<m>/(answer|edit|cancel)    answer: going, maybe or no; edit: their own; cancel: as delete
//   POST /_groups/<id>/polls/<m>/(vote|close)              vote: choice…; close: a poll they asked (polls.js)
//   Running a group (its admins): POST /_groups/<id>/link (JSON), /_groups/<id>/about (name, about),
//   /_groups/<id>/members/<m>/(approve|decline|remove|admin|member); its owner: /_groups/<id>/delete (groupsites.js)
import { CONTEXT, fileUrl, groupId, groupPostId, seconds } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { ANSWERS, eventObject, hasDate, onDate, readEventForm, ruleDates } from "./calendar.js";
import { parseSharedEvent } from "./events.js";
import { parseEdits, parseMedia } from "./friends.js";
import { EDIT_SECONDS, mineVersions, mineVersionsGone } from "./edits.js";
import { cleanName, cleanText, MAX_GROUP_ABOUT, MAX_GROUP_NAME, MAX_GROUP_PHOTOS, MAX_GROUP_TEXT } from "./groups.js";
import { handleGroupSites } from "./groupsites.js";
import { notifyLater } from "./push.js";
import { parsePoll, questionFor, readPoll } from "./polls.js";
import { receiveGroupNote } from "./notify.js";
import { messagePage } from "./views/pages.js";
import { callSite, KEY_RE, ownerName, PROTOCOL, siteOrigin } from "./peers.js";
import { checkPhotos, removeUnusedFiles } from "./posts.js";
import { signedFile } from "./share.js";
import { html, json, now, randomToken, Refusal, sha256 } from "./util.js";
import { cleanMentions, HERE, mentionTags, noteMentions } from "./mentions.js";

const PENDING_SECONDS = 600; // a join half made is given up after this
const MAX_PLANS = 200; // events in one group the owner's said they're going to and that aren't long over
const LINK_RE = /^\/_join\/([\w-]{40,100})$/;
const ROLES = ["owner", "admin", "member"];
const unexpected = () => new Error("Their site sent something unexpected.");
export const isAdmin = (group) => group.role === "owner" || group.role === "admin";

// --- reading what a group's site sends -----------------------------------------------------------------------------------

const text = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);

/** Someone, as a group names them: a name, and the site they're from (if it's a proper site address). */
function person(p, env) {
  const name = text(p?.name, 100)?.trim() || null;
  const from = typeof p?.id === "string" ? siteOrigin(p.id.replace(/\/$/, ""), env) : null;
  return { name, from };
}

function parseComments(collection, base, env) {
  const items = Array.isArray(collection?.items) ? collection.items.slice(0, 500) : [];
  return items.flatMap((c) => {
    const n = /^#c(\d{1,15})$/.exec((typeof c?.id === "string" && c.id.startsWith(base) && c.id.slice(base.length)) || "");
    const { name, from } = person(c?.attributedTo, env);
    const at = seconds(c?.published);
    return c?.type === "Note" && n && name && text(c.content, MAX_COMMENT) && at !== null
      ? [{ id: Number(n[1]), name, from, text: c.content, created_at: at, mentions: noteMentions(c, c.content, env, { here: true }),
        ...parseEdits(c, at, MAX_COMMENT) }] : [];
  });
}


/** A post in the group `n` on `site`, or null. */
export function parseGroupNote(note, site, n, env) {
  const prefix = groupPostId(site, n, "");
  const id = typeof note?.id === "string" && note.id.startsWith(prefix) ? note.id.slice(prefix.length) : "";
  const { name, from } = person(note?.attributedTo, env);
  const at = seconds(note?.published);
  if (note?.type !== "Note" || !/^\d{1,15}$/.test(id) || !name || at === null) return null;
  const attachments = Array.isArray(note.attachment) ? note.attachment.slice(0, 20) : [];
  return {
    id: Number(id), created_at: at, text: text(note.content, MAX_GROUP_TEXT * 2) || null, name, from,
    mentions: noteMentions(note, text(note.content, MAX_GROUP_TEXT * 2) ?? "", env, { here: true }),
    ...parseEdits(note, at, MAX_GROUP_TEXT * 2),
    photos: attachments.map((m) => parseMedia(m, site)).filter(Boolean),
    comments: parseComments(note.replies, note.id, env),
    commentCount: count(note.replies?.totalItems) ?? 0, // the group sends only the newest with a page of posts
    event: note["afterwrd:event"] === undefined ? null : parseSharedEvent(note["afterwrd:event"], env),
    // Who chose what is read here, but markMine keeps it only on the owner's own polls.
    poll: note["afterwrd:poll"] === undefined ? null : parsePoll(note["afterwrd:poll"], env, { names: true }),
  };
}

/** The group itself, from the context of what its site sends; it must be the group asked for. */
function parseGroup(g, site, n, env) {
  if (g?.type !== "Group" || g.id !== groupId(site, n)) throw unexpected();
  const waiting = g["afterwrd:waiting"];
  const owner = person(g.attributedTo, env);
  return {
    name: text(g.name, 300)?.trim() || "A group", about: text(g.about ?? g.summary, 2000),
    owner: owner.name, ownerFrom: owner.from, members: count(g["afterwrd:members"]) ?? 1,
    role: ROLES.includes(g["afterwrd:role"]) ? g["afterwrd:role"] : "member",
    waiting: Number.isSafeInteger(waiting) && waiting >= 0 ? waiting : 0,
    // Mentions (mentions.js): its members, to pick from, and whether the owner here may use @here, and anyone may.
    people: (Array.isArray(g["afterwrd:people"]) ? g["afterwrd:people"].slice(0, 200) : [])
      .map((p) => person(p, env)).filter((p) => p.name && p.from).map((p) => ({ name: p.name, origin: p.from })),
    mayHere: g["afterwrd:mayHere"] === true,
    hereAnyone: g["afterwrd:hereAnyone"] === true,
  };
}

/** A page of a group's posts, from its site. */
export function parseGroupPage(data, site, n, env) {
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 100) : [];
  return {
    group: parseGroup(data?.context, site, n, env),
    posts: items.map((note) => parseGroupNote(note, site, n, env)).filter(Boolean),
    paging: { page: count(data?.["afterwrd:page"]) ?? 1, total: count(data?.totalItems) ?? 0, hasNext: data?.["afterwrd:hasNext"] === true },
  };
}

/** Who's in a group; for an admin, with requests to join and the numbers to act on everyone by. */
export function parseGroupMembers(data, site, n, env) {
  const items = Array.isArray(data?.items) ? data.items.slice(0, 200) : [];
  return {
    group: parseGroup(data?.context, site, n, env),
    members: items.map((m) => ({
      ...person(m, env), role: ROLES.includes(m?.["afterwrd:role"]) ? m["afterwrd:role"] : "member",
      id: Number.isSafeInteger(m?.["afterwrd:member"]) ? m["afterwrd:member"] : null, waiting: m?.["afterwrd:waiting"] === true,
    })).filter((m) => m.name),
  };
}

/**
 * Marks what the owner here wrote: only what this site sent (group_mine), shown as it was sent: the words and time kept
 * here, a comment only under the post it was made on, and a post with only the photos it was sent with. Anything else
 * claiming to be from this site is left out.
 */
export async function markMine(db, group, posts, ownOrigin) {
  const { results } = await db.prepare(`SELECT id, kind, post_id, remote_id, text, photos, event, poll, created_at, edited_at FROM group_mine
    WHERE site = ? AND remote_group = ?`).bind(group.origin, group.remote_id).all();
  // Their own record of changing their words (never what the group says they said before).
  const earlier = await mineVersions(db, results.filter((r) => r.edited_at).map((r) => r.id));
  const edits = (sent) => ({ edited_at: sent.edited_at, earlier: earlier.get(sent.id) ?? [] });
  // Whether they can still change it, as the group will decide (edits.js), so the page only offers what works: new
  // enough, not an event, and nobody else has commented after it (or answered it).
  const fresh = (sent) => sent.created_at > now() - EDIT_SECONDS;
  const posted = new Map(results.filter((r) => r.kind === "post").map((r) => [r.remote_id, r]));
  const said = new Map(results.filter((r) => r.kind === "comment").map((r) => [`${r.post_id}:${r.remote_id}`, r]));
  const hashes = (sent) => { try { return new Set(JSON.parse(sent.photos ?? "[]")); } catch { return new Set(); } };
  // An event they added, as they last said it (who's going, and whether it's off, are the group's to say).
  const event = (sent, e) => {
    let kept = null;
    try { kept = JSON.parse(sent.event ?? "null"); } catch {}
    if (!e || !kept) return null; // a post of theirs that wasn't an event isn't made one by the group
    const { title, starts_at, ends_at, all_day, time_zone, place, rrule = null } = kept;
    // Its dates called off one at a time are the group's to say, but only of the dates the writer gave it.
    const own = { ...e, title, starts_at, ends_at, all_day, time_zone, place, rrule };
    const dates = new Set(rrule ? ruleDates(own) : []);
    return { ...own, skipped: (e.skipped ?? []).filter((d) => dates.has(d)), dates: (e.dates ?? []).filter((d) => dates.has(d.date)) };
  };
  // A poll they asked, with its options as they asked them (how many chose what, and who, are the group's to say).
  const poll = (sent, q) => {
    let kept = null;
    try { kept = JSON.parse(sent.poll ?? "null"); } catch {}
    if (!q || !kept || kept.options?.length !== q.options.length) return null;
    return { ...q, multiple: Boolean(kept.multiple), closes_at: kept.closes_at ?? null,
      options: q.options.map((o, i) => ({ ...o, name: kept.options[i] })) };
  };
  // Anyone else's: never who chose what, whatever the group says.
  const theirs = (q) => q && { ...q, options: q.options.map((o) => ({ ...o, voters: null })) };
  return posts.flatMap((p) => {
    const sent = posted.get(p.id);
    if (!sent && p.from === ownOrigin) return [];
    const others = p.comments.filter((c) => !said.has(`${p.id}:${c.id}`));
    const answeredByOthers = p.poll && p.poll.voters > (p.poll.answered ? 1 : 0);
    const post = sent ? { ...p, mine: true, text: sent.text, created_at: sent.created_at, photos: p.photos.filter((m) => hashes(sent).has(m.hash)),
      event: event(sent, p.event), poll: poll(sent, p.poll), ...edits(sent),
      editable: fresh(sent) && !p.event && !others.length && p.commentCount <= p.comments.length && !answeredByOthers }
      : { ...p, mine: false, poll: theirs(p.poll) };
    return [{ ...post, comments: p.comments.flatMap((c) => {
      const kept = said.get(`${p.id}:${c.id}`);
      if (kept) {
        return [{ ...c, mine: true, text: kept.text, created_at: kept.created_at, ...edits(kept),
          editable: fresh(kept) && !others.some((o) => o.id > c.id) }];
      }
      return c.from === ownOrigin ? [] : [{ ...c, mine: false }];
    }) }];
  });
}

// --- loading a group for its pages -----------------------------------------------------------------------------------------

const call = (group, path, body) => callSite(group.origin, path, { key: group.their_key, body });

/** Keeps a group's name, owner and our role up to date, from what it just said. */
async function refresh(db, group, info) {
  if (info.name === group.name && info.about === group.about && info.role === group.role && (info.owner ?? group.host_name) === group.host_name) return;
  Object.assign(group, { name: info.name, about: info.about, role: info.role, host_name: info.owner ?? group.host_name });
  await db.prepare("UPDATE groups SET name = ?, about = ?, role = ?, host_name = ? WHERE id = ?")
    .bind(group.name, group.about, group.role, group.host_name, group.id).run();
}

/**
 * One date of an event as the owner's copy keeps it: its title, times and place, and whether it's off ('' is a
 * one-off's only date). Null if the event no longer has that date: the copy has nothing left to be a copy of.
 */
export function dateCopy(event, date) {
  if (!hasDate(event, date)) return null;
  return date ? onDate(event, date) : event;
}

const PLAN_FIELDS = ["title", "starts_at", "ends_at", "all_day", "time_zone", "place", "cancelled_at"];
/** Whether a kept copy already says what `fresh` would. */
export const sameCopy = (old, fresh) => PLAN_FIELDS.every((k) => (old[k] ?? null) === (fresh[k] ?? null));

/**
 * Keeps the owner's copies of the events they're going to (or might): one for each date of a repeating one. Only
 * their own answer, given here (`answered`: {id, answer, date}), makes or drops one: the group's say-so about who's
 * going never does. Otherwise copies already kept are brought up to date with what the group just showed (`posts`,
 * already marked as theirs or not), and dropped for events no longer there (`gone`).
 */
export async function keepPlans(db, group, posts, gone = [], answered = null) {
  const events = posts.filter((p) => p.event);
  if (!events.length && !gone.length && !answered) return;
  const { results } = await db.prepare("SELECT * FROM events_elsewhere WHERE group_id = ?").bind(group.id).all();
  const key = (id, date) => `${id}:${date}`;
  const had = new Map(results.map((r) => [key(r.post_id, r.date), r]));
  const same = sameCopy;
  const drop = (id, date = null) => db.prepare(`DELETE FROM events_elsewhere WHERE group_id = ? AND post_id = ?${date === null ? "" : " AND date = ?"}`)
    .bind(group.id, id, ...(date === null ? [] : [date]));
  const writes = [];
  for (const { id, event } of events) {
    // Copies already kept, brought up to date, if they've changed; a date it no longer has is let go.
    for (const old of results.filter((r) => r.post_id === id)) {
      if (answered?.id === id && answered.date === old.date) continue;
      const fresh = dateCopy(event, old.date);
      if (!fresh) writes.push(db.prepare("DELETE FROM events_elsewhere WHERE id = ?").bind(old.id));
      else if (!same(old, fresh)) {
        writes.push(db.prepare(`UPDATE events_elsewhere SET ${PLAN_FIELDS.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
          .bind(...PLAN_FIELDS.map((k) => fresh[k] ?? null), now(), old.id));
      }
    }
    if (answered?.id !== id) continue;
    const date = answered.date ?? "";
    const old = had.get(key(id, date));
    if (answered.answer === "no") { if (old) writes.push(drop(id, date)); continue; }
    const copy = dateCopy(event, date);
    if (!copy) continue; // not one of its dates
    if (old && old.answer === answered.answer && same(old, copy)) continue;
    if (!old && had.size >= MAX_PLANS) continue;
    writes.push(db.prepare(`INSERT INTO events_elsewhere (group_id, post_id, date, answer, ${PLAN_FIELDS.join(", ")}, updated_at)
      VALUES (?, ?, ?, ?, ${PLAN_FIELDS.map(() => "?").join(", ")}, ?)
      ON CONFLICT (group_id, post_id, date) WHERE group_id IS NOT NULL DO UPDATE SET answer = excluded.answer,
      ${PLAN_FIELDS.map((k) => `${k} = excluded.${k}`).join(", ")}, updated_at = excluded.updated_at`)
      .bind(group.id, id, date, answered.answer, ...PLAN_FIELDS.map((k) => copy[k] ?? null), now()));
  }
  // Can't go, about an event the group no longer shows: the copy goes all the same.
  if (answered?.answer === "no" && !events.some((p) => p.id === answered.id)) writes.push(drop(answered.id, answered.date ?? ""));
  for (const id of gone) writes.push(drop(id));
  if (writes.length) await db.batch(writes);
}

/** A page of a group's posts, read from its site, with the owner's own marked. */
export async function loadGroup(env, site, group, page) {
  const data = parseGroupPage(await call(group, `/_group/posts?page=${page}`), group.origin, group.remote_id, env);
  await refresh(env.DB, group, data.group);
  const posts = await markMine(env.DB, group, data.posts, site);
  await keepPlans(env.DB, group, posts);
  return { ...data, posts };
}

/**
 * A group's calendar: events still to come, and (unless `past` is false, saving a request) recent ones. `outdated` if
 * the group's site is from before events (its owner can update it).
 */
export async function loadEvents(env, site, group, { past: withPast = true } = {}) {
  let upcoming;
  let past;
  try {
    [upcoming, past] = await Promise.all([call(group, "/_group/events"), withPast ? call(group, "/_group/events?when=past") : null]);
  } catch (error) {
    if (error.message === "Not found.") return { outdated: true, group: null, upcoming: [], past: [] };
    throw error;
  }
  const read = (data) => {
    const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 200) : [];
    return items.map((note) => parseGroupNote(note, group.origin, group.remote_id, env)).filter((p) => p?.event);
  };
  const info = parseGroup(upcoming?.context, group.origin, group.remote_id, env);
  await refresh(env.DB, group, info);
  const mine = async (posts) => markMine(env.DB, group, posts, site);
  const [soon, before] = [await mine(read(upcoming)), await mine(read(past))];
  await keepPlans(env.DB, group, [...soon, ...before]);
  return { outdated: false, group: info, upcoming: soon, past: before };
}

/** One post in a group, or null if it's gone. */
export async function loadGroupPost(env, site, group, id) {
  let note;
  try {
    note = await call(group, `/_group/posts/${Number(id)}`);
  } catch (error) {
    if (!/isn't there any more/.test(error.message)) throw error;
    await keepPlans(env.DB, group, [], [Number(id)]);
    return null;
  }
  const info = parseGroup(note.context, group.origin, group.remote_id, env);
  const post = parseGroupNote(note, group.origin, group.remote_id, env);
  if (!post || post.id !== Number(id)) throw unexpected();
  await refresh(env.DB, group, info);
  const posts = await markMine(env.DB, group, [post], site);
  await keepPlans(env.DB, group, posts);
  return { group: info, post: posts[0] ?? null };
}

/** Who's in a group, as it says; for an admin, everyone, with requests to join. */
export async function loadMembers(env, group) {
  const data = parseGroupMembers(await call(group, isAdmin(group) ? "/_group/admin/members" : "/_group/members"),
    group.origin, group.remote_id, env);
  await refresh(env.DB, group, data.group);
  return data;
}

// --- joining ---------------------------------------------------------------------------------------------------------

function parseLink(link, url, env) {
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    throw new Error("That isn't a group invite link. It should look like https://…/_join/…");
  }
  const origin = siteOrigin(parsed.origin, env);
  const match = LINK_RE.exec(parsed.pathname);
  if (!origin || !match) throw new Error("That isn't a group invite link. It should look like https://…/_join/…");
  if (origin === url.origin) throw new Error("That link is to this site, not a group.");
  return { origin, token: match[1] };
}

/** What the group an invite link is for says about itself, to show before joining. */
export async function linkInfo(env, url, link) {
  const target = parseLink(link, url, env);
  const info = await callSite(target.origin, `/_join/${target.token}/info`);
  const id = Number(info.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw unexpected();
  const joined = await env.DB.prepare("SELECT id FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NOT NULL")
    .bind(target.origin, id).first();
  return { ...target, id, name: cleanName(info.name, "A group"), about: text(info.about, 2000), owner: cleanName(info.owner), joined: joined?.id ?? null };
}

/**
 * The end of joining (or claiming) a group: this site's key for the group to call it with is `key` (the row is
 * waiting, with its hash); `ask` sends it, and must answer with the group's number and a key for calling it.
 */
async function finishJoining(db, origin, remoteId, ask) {
  const reply = await ask();
  if (!KEY_RE.test(reply.key ?? "") || Number(reply.id) !== remoteId) throw unexpected();
  const row = await db.prepare(`UPDATE groups SET name = ?, about = ?, host_name = ?, their_key = ?, joined_at = ?
    WHERE origin = ? AND remote_id = ? AND joined_at IS NULL RETURNING id`)
    .bind(cleanName(reply.name, "A group"), text(reply.about, 2000), cleanName(reply.owner), reply.key, now(), origin, remoteId).first();
  if (!row) throw unexpected();
  return row.id;
}

/** Asks to join the group an invite link is for; returns the group's id here. */
export async function joinGroup(env, url, link) {
  const db = env.DB;
  const info = await linkInfo(env, url, link);
  if (info.joined) return info.joined;
  const key = randomToken();
  await db.batch([
    db.prepare(`DELETE FROM groups WHERE origin IS NOT NULL AND joined_at IS NULL AND script IS NULL
      AND (created_at < ? OR (origin = ? AND remote_id = ?))`).bind(now() - PENDING_SECONDS, info.origin, info.id),
    db.prepare("INSERT INTO groups (name, about, created_at, origin, remote_id, host_name, key_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?, 'member')")
      .bind(info.name, info.about, now(), info.origin, info.id, info.owner, await sha256(key)),
  ]);
  try {
    // Long enough for the group to call this site back (see /_member/hello) before answering.
    return await finishJoining(db, info.origin, info.id,
      () => callSite(info.origin, `/_join/${info.token}/accept`, { body: { origin: url.origin, key }, timeout: 25_000 }));
  } catch (error) {
    await db.prepare("DELETE FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NULL").bind(info.origin, info.id).run();
    throw error;
  }
}

/**
 * Claims a group whose Worker this site has just made (groupsites.js): its row here holds the GROUP_KEY the Worker
 * was made with, until the group answers with the key for calling it. Returns the group's id here.
 */
export async function claimGroup(env, url, id) {
  const db = env.DB;
  const group = await db.prepare("SELECT * FROM groups WHERE id = ? AND joined_at IS NULL AND origin IS NOT NULL AND their_key IS NOT NULL")
    .bind(Number(id)).first();
  if (!group) throw new Error("That group isn't waiting to be set up.");
  const key = randomToken();
  await db.prepare("UPDATE groups SET key_hash = ?, role = 'owner' WHERE id = ?").bind(await sha256(key), group.id).run();
  return finishJoining(db, group.origin, group.remote_id, () => callSite(group.origin, "/_group/claim", {
    body: { origin: url.origin, key, setup: group.their_key, name: group.name, about: group.about }, timeout: 25_000,
  }));
}

// --- the owner's part in a group (actions: see util.js Refusal) -----------------------------------------------------------

/**
 * One of the owner's groups by its id here (or, `unfinished`, one whose Worker this site made but didn't set up).
 * @returns {Promise<Row<"groups"> | null>}
 */
export async function findGroup(db, id, { unfinished = false } = {}) {
  const also = unfinished ? "OR (joined_at IS NULL AND script != '')" : "";
  return db.prepare(`SELECT * FROM groups WHERE id = ? AND (joined_at IS NOT NULL ${also})`).bind(Number(id)).first();
}

/**
 * Sends a post to a group; its photos (already uploaded here) go as signed links, and are copied there. Returns
 * { id }, its number there.
 */
export async function postToGroup(env, site, group, { text: words, photos, poll: asking = undefined, mentions: given = null }) {
  const db = env.DB;
  const trouble = await checkPhotos(env, photos, MAX_GROUP_PHOTOS);
  if (trouble) throw new Refusal(trouble);
  if (words.length > MAX_GROUP_TEXT) throw new Refusal(`Posts can be up to ${MAX_GROUP_TEXT} characters.`);
  const { poll, error } = readPoll(asking);
  if (error) throw new Refusal(error);
  if (poll && !words) throw new Refusal("Write the question your poll asks.");
  if (!words && !photos.length) throw new Refusal("Write something or add a photo.");
  const attachment = await Promise.all(photos.map(async (f) => ({
    type: "Image", url: fileUrl(site, f.hash), mediaType: "image/jpeg", width: f.width, height: f.height, "afterwrd:size": f.size,
    "afterwrd:fetch": await signedFile(env, site, f.hash),
    preview: { type: "Image", url: fileUrl(site, f.thumb_hash), mediaType: "image/jpeg", "afterwrd:fetch": await signedFile(env, site, f.thumb_hash) },
  })));
  try {
    const reply = await call(group, "/_group/posts", { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words, attachment,
      ...(poll && { "afterwrd:poll": questionFor(poll) }), ...mentionFields(given, words, env) });
    const prefix = groupPostId(group.origin, group.remote_id, "");
    const id = typeof reply.id === "string" && reply.id.startsWith(prefix) ? reply.id.slice(prefix.length) : "";
    if (!/^\d{1,15}$/.test(id)) throw unexpected();
    // A group's site from before polls keeps the post without one: take it back, and say why.
    if (poll && reply["afterwrd:poll"] !== true) {
      await call(group, `/_group/posts/${Number(id)}/delete`, {}).catch(() => {});
      throw new Error("its site needs updating before it can take polls. Its owner can update it from their Update page");
    }
    await db.prepare(`INSERT INTO group_mine (group_id, site, remote_group, kind, post_id, remote_id, text, photos, poll, created_at)
      VALUES (?, ?, ?, 'post', ?, ?, ?, ?, ?, ?)`).bind(group.id, group.origin, group.remote_id, Number(id), Number(id), words || null,
      JSON.stringify(photos.map((f) => f.hash)), poll && JSON.stringify(poll), now()).run();
    return { id: Number(id) };
  } catch (error) {
    throw new Refusal(`Couldn't post in ${group.name}: ${error.message}`);
  } finally {
    // The group has its own copies now; these were only uploaded to be sent.
    await removeUnusedFiles(env, photos.flatMap((f) => [f.hash, f.thumb_hash]));
  }
}

/**
 * Who a post or comment to a group mentions (mentions.js), as the note says it: Mention tags, and @here as
 * "afterwrd:here". The group decides who's told, and whether @here is allowed.
 */
function mentionFields(given, words, env) {
  const list = cleanMentions(given, words, env, { here: true });
  const tags = mentionTags(list);
  return { ...(tags.length && { tag: tags }), ...(list.some((m) => m.origin === HERE) && { "afterwrd:here": true }) };
}

/** Comments on post `postId` in a group. Returns { id }, its number there, or null if there's nothing to say. */
export async function commentInGroup(env, group, postId, words, given = null) {
  if (!words) return null;
  if (!/^\d{1,15}$/.test(postId)) throw new Refusal("That isn't a post in this group.");
  if (words.length > MAX_COMMENT) throw new Refusal(`Comments can be up to ${MAX_COMMENT} characters.`);
  const post = groupPostId(group.origin, group.remote_id, postId);
  let reply;
  try {
    reply = await call(group, "/_group/comments", { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words, inReplyTo: post,
      ...mentionFields(given, words, env) });
  } catch (error) {
    throw new Refusal(`Couldn't send your comment: ${error.message}`);
  }
  const n = /^#c(\d{1,15})$/.exec(typeof reply.id === "string" && reply.id.startsWith(post) ? reply.id.slice(post.length) : "");
  if (!n) throw new Refusal("Couldn't send your comment: the group sent something unexpected.");
  await env.DB.prepare(`INSERT INTO group_mine (group_id, site, remote_group, kind, post_id, remote_id, text, created_at)
    VALUES (?, ?, ?, 'comment', ?, ?, ?, ?)`).bind(group.id, group.origin, group.remote_id, Number(postId), Number(n[1]), words, now()).run();
  return { id: Number(n[1]) };
}

/**
 * The event in a group's reply (its post, as it is now), checked, kept in the owner's copies of their plans; with
 * `answer`, the owner's own answer, just given here, which is what makes or drops their copy.
 */
async function keepReply(env, site, group, reply, id, answer = null, date = "") {
  const post = parseGroupNote(reply, group.origin, group.remote_id, env);
  const ok = post?.event && post.id === Number(id);
  const posts = ok ? await markMine(env.DB, group, [post], site) : [];
  await keepPlans(env.DB, group, posts, [], answer && { id: Number(id), answer, date });
  return posts[0] ?? null;
}

const keptEvent = (e) => JSON.stringify({ title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day,
  time_zone: e.time_zone, place: e.place, rrule: e.rrule ?? null });

/**
 * Adds an event to a group: a post with the event; the owner here is going to start with (to its first date, if it
 * repeats). Returns { id }.
 */
export async function addEvent(env, site, group, { text: words, event }) {
  if (words.length > MAX_GROUP_TEXT) throw new Refusal(`Posts can be up to ${MAX_GROUP_TEXT} characters.`);
  let id;
  try {
    const reply = await call(group, "/_group/posts", { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words,
      "afterwrd:event": eventObject(event) });
    const prefix = groupPostId(group.origin, group.remote_id, "");
    id = typeof reply.id === "string" && reply.id.startsWith(prefix) ? reply.id.slice(prefix.length) : "";
    if (!/^\d{1,15}$/.test(id)) throw unexpected();
    // A group's site from before repeating events keeps it as a one-off: take it back, and say why.
    if (event.rrule && reply["afterwrd:rrule"] !== true) {
      await call(group, `/_group/posts/${Number(id)}/delete`, {}).catch(() => {});
      throw new Error("its site needs updating before it can take events that repeat. Its owner can update it from their Update page");
    }
  } catch (error) {
    throw new Refusal(`Couldn't add the event to ${group.name}: ${error.message}`);
  }
  await env.DB.prepare(`INSERT INTO group_mine (group_id, site, remote_group, kind, post_id, remote_id, text, photos, event, created_at)
    VALUES (?, ?, ?, 'post', ?, ?, ?, '[]', ?, ?)`).bind(group.id, group.origin, group.remote_id, Number(id), Number(id), words || null,
    keptEvent(event), now()).run();
  // The event's added even if its answer couldn't be sent.
  await answerEvent(env, site, group, id, "going", ruleDates(event)[0]).catch((error) => {
    if (!(error instanceof Refusal)) throw error;
  });
  return { id: Number(id) };
}

/** The owner's answer to an event (to one `date` of a repeating one): going, maybe or no. */
export async function answerEvent(env, site, group, id, answer, date = "") {
  if (!ANSWERS.includes(answer)) throw new Refusal("Going, maybe, or can't go?");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Refusal("That isn't one of its dates.");
  try {
    await keepReply(env, site, group, await call(group, `/_group/events/${Number(id)}/answer`, { answer, date: date || undefined }), id, answer, date);
  } catch (error) {
    throw new Refusal(`Couldn't send your answer: ${error.message}`);
  }
}

/** The owner answers a poll in a group (`choices`: the options' numbers; none takes it back). */
export async function voteInGroup(env, group, id, choices) {
  const list = choices.slice(0, 20).map((c) => (/^\d{1,2}$/.test(c) ? Number(c) : -1));
  try {
    await call(group, `/_group/polls/${Number(id)}/vote`, { "afterwrd:choices": list });
  } catch (error) {
    throw new Refusal(`Couldn't send your answer: ${error.message}`);
  }
}

/** The owner closes a poll they asked in a group. */
export async function closePollInGroup(env, group, id) {
  try {
    await call(group, `/_group/polls/${Number(id)}/close`, {});
  } catch (error) {
    throw new Refusal(`Couldn't close the poll: ${error.message}`);
  }
}

/** Changes an event the owner here added. */
export async function editEvent(env, site, group, id, { text: words, event }) {
  if (words.length > MAX_GROUP_TEXT) throw new Refusal(`Posts can be up to ${MAX_GROUP_TEXT} characters.`);
  let reply;
  try {
    reply = await call(group, `/_group/events/${Number(id)}/edit`, { "@context": CONTEXT, type: "Note", mediaType: "text/plain",
      content: words, "afterwrd:event": eventObject(event) });
  } catch (error) {
    throw new Refusal(`Couldn't change the event: ${error.message}`);
  }
  // A group's site from before repeating events changes the rest and drops the repeat: say so, and keep what it kept.
  const kept = parseGroupNote(reply, group.origin, group.remote_id, env)?.event;
  const repeatLost = event.rrule && kept && kept.rrule !== event.rrule;
  await env.DB.prepare("UPDATE group_mine SET text = ?, event = ? WHERE site = ? AND remote_group = ? AND kind = 'post' AND remote_id = ?")
    .bind(words || null, keptEvent(repeatLost ? { ...event, rrule: null } : event), group.origin, group.remote_id, Number(id)).run();
  await keepReply(env, site, group, reply, id);
  if (repeatLost) throw new Refusal(`The rest is changed, but ${group.name}'s site needs updating before its events can repeat. Its owner can update it from their Update page.`);
}

/** Calls off an event (the writer's, or, running the group, anyone's): all of it, or one `date` of a repeating one. */
export async function cancelEvent(env, site, group, id, date = "") {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Refusal("That isn't one of its dates.");
  try {
    await keepReply(env, site, group, await call(group, `/_group/events/${Number(id)}/cancel`, { date: date || undefined }), id);
  } catch (error) {
    throw new Refusal(`Couldn't call it off: ${error.message}`);
  }
}

/**
 * Changes the words of the owner's own post or comment in a group (`kind`: posts or comments). The group decides
 * whether it still can be (edits.js there); then the owner's own copy changes too, keeping what it said before.
 */
export async function editInGroup(env, group, kind, id, words) {
  const db = env.DB;
  const mine = await db.prepare("SELECT * FROM group_mine WHERE site = ? AND remote_group = ? AND kind = ? AND remote_id = ?")
    .bind(group.origin, group.remote_id, kind === "posts" ? "post" : "comment", Number(id)).first();
  if (!mine) throw new Refusal("That isn't yours.");
  const max = kind === "posts" ? MAX_GROUP_TEXT : MAX_COMMENT;
  if (words.length > max) throw new Refusal(`That can be up to ${max} characters.`);
  if (words === (mine.text ?? "")) return;
  try {
    await call(group, `/_group/${kind}/${Number(id)}/edit`, { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words });
  } catch (error) {
    // A group's site from before editing answers an unknown address with "Not found.".
    if (error.status === 404 && error.message === "Not found.") {
      throw new Refusal(`${group.name}'s site can't change posts or comments yet. Its owner can update it from their Update page.`);
    }
    throw new Refusal(`Couldn't change it: ${error.message}`);
  }
  const at = now();
  await db.batch([
    db.prepare("INSERT INTO group_mine_versions (mine_id, text, replaced_at) VALUES (?, ?, ?)").bind(mine.id, mine.text, at),
    db.prepare("UPDATE group_mine SET text = ?, edited_at = ? WHERE id = ?").bind(words || null, at, mine.id),
  ]);
}

/** Deletes a post or comment (`kind`: posts or comments): the owner's own, or, running the group, anyone's. */
export async function deleteInGroup(env, group, kind, id) {
  try {
    await call(group, `/_group/${kind}/${Number(id)}/delete`, {});
  } catch (error) {
    throw new Refusal(`Couldn't delete it: ${error.message}`);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM group_mine WHERE site = ? AND remote_group = ? AND kind = ? AND remote_id = ?")
      .bind(group.origin, group.remote_id, kind === "posts" ? "post" : "comment", Number(id)),
    ...(kind === "posts" ? [env.DB.prepare("DELETE FROM events_elsewhere WHERE group_id = ? AND post_id = ?").bind(group.id, Number(id))] : []),
    mineVersionsGone(env.DB),
  ]);
}

/** Leaves a group (its owner can't: they delete it instead), and forgets it here. */
export async function leaveGroup(env, group) {
  if (group.role === "owner") throw new Refusal("You own this group: delete it instead.");
  await call(group, "/_group/leave", {}).catch(() => {});
  await forgetGroup(env.DB, group);
}

/** Forgets a group here (its notes and plans too). The owner's copies of what they said stay. */
export const forgetGroup = (db, group) => db.batch([
  db.prepare("DELETE FROM group_inbox WHERE group_id = ?").bind(group.id),
  db.prepare("DELETE FROM events_elsewhere WHERE group_id = ?").bind(group.id),
  db.prepare("DELETE FROM groups WHERE id = ?").bind(group.id),
]);

/** An admin's request to the group (its invite link, its name and about, deciding on members); returns its answer. */
export async function admin(group, path, body = {}) {
  let reply;
  try {
    reply = await call(group, `/_group/admin/${path}`, body);
  } catch (error) {
    throw new Refusal(error.message);
  }
  // A group saying no in its answer, rather than with its status, is a no too.
  if (reply?.error) throw new Refusal(reply.error);
  return reply;
}

export async function handleGroupActions(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const db = env.DB;
  const site = url.origin;
  const path = url.pathname.slice("/_groups".length);
  if (path.startsWith("/create/")) return handleGroupSites(request, env, url);
  if (path === "/join") {
    const body = await request.json().catch(() => ({}));
    try {
      return json({ id: await joinGroup(env, url, String(body.link ?? "")) });
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }

  const match = /^\/(\d{1,15})(\/.*)$/.exec(path);
  // A group whose Worker this site made but couldn't finish setting up can still be deleted.
  const group = match && await findGroup(db, match[1], { unfinished: match[2] === "/delete" });
  if (!group) return problem("That group isn't here any more.", new URL("/groups", site), 404);
  const action = match[2];
  if (action === "/delete") return handleGroupSites(request, env, url, group);
  try {
    if (action === "/posts") {
      const body = await request.json().catch(() => ({}));
      await postToGroup(env, site, group, { text: cleanText(body.text), photos: Array.isArray(body.photos) ? body.photos : [], poll: body.poll,
        mentions: body.mentions });
      return json({ ok: true });
    }
    if (action === "/link") return json({ link: (await admin(group, "link")).link });
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.message }, error.status);
    throw error;
  }

  // Everything else is a form, landing back where it came from.
  const form = await request.formData().catch(() => new FormData());
  const home = `/groups/${group.id}`;
  let back = new URL(safeNext(String(form.get("back") ?? home), url), site);
  const members = new URL(`${home}/members`, site);
  const del = /^\/(posts|comments)\/(\d{1,15})\/delete$/.exec(action);
  const change = /^\/(posts|comments)\/(\d{1,15})\/edit$/.exec(action);
  const ev = /^\/events\/(\d{1,15})\/(answer|edit|cancel)$/.exec(action);
  const polled = /^\/polls\/(\d{1,15})\/(vote|close)$/.exec(action);
  const decision = /^\/members\/(\d{1,15})\/(approve|decline|remove|admin|member)$/.exec(action);
  try {
    if (action === "/comments") {
      const post = String(form.get("post") ?? "");
      const made = await commentInGroup(env, group, post, cleanText(String(form.get("text") ?? "")), form.get("mentions"));
      if (made) back.hash = `g${post}-${made.id}`;
    } else if (del) {
      await deleteInGroup(env, group, del[1], del[2]);
    } else if (change) {
      await editInGroup(env, group, change[1], change[2], cleanText(String(form.get("text") ?? "")));
      back.hash = change[1] === "posts" ? `gp${change[2]}` : `g${String(form.get("post") ?? "")}-${change[2]}`;
    } else if (action === "/events" || ev?.[2] === "edit") {
      const read = readEventForm(form, request.cf?.timezone, { repeats: true });
      if (read.error) return problem(read.error, back);
      const words = cleanText(String(form.get("text") ?? ""));
      if (ev) await editEvent(env, site, group, ev[1], { text: words, event: read.event });
      const id = ev ? ev[1] : (await addEvent(env, site, group, { text: words, event: read.event })).id;
      back = new URL(`${home}/posts/${id}`, site);
    } else if (ev?.[2] === "answer") {
      await answerEvent(env, site, group, ev[1], String(form.get("answer") ?? ""), String(form.get("date") ?? ""));
    } else if (ev?.[2] === "cancel") {
      await cancelEvent(env, site, group, ev[1], String(form.get("date") ?? ""));
    } else if (polled) {
      if (polled[2] === "vote") await voteInGroup(env, group, polled[1], form.getAll("choice").map(String));
      else await closePollInGroup(env, group, polled[1]);
      back.hash = `poll-g${polled[1]}`;
    } else if (action === "/leave") {
      try {
        await leaveGroup(env, group);
      } catch (error) {
        if (error instanceof Refusal) return problem(error.message, members);
        throw error;
      }
      return Response.redirect(`${site}/groups`, 303);
    } else if (action === "/here") {
      // Whether anyone in it may use @here, or only its owner and admins (mentions.js).
      back.pathname = members.pathname;
      await admin(group, "here", { on: form.get("anyone") === "1" });
    } else if (action === "/about") {
      back.pathname = members.pathname;
      await admin(group, "about", {
        name: String(form.get("name") ?? "").slice(0, MAX_GROUP_NAME), about: String(form.get("about") ?? "").slice(0, MAX_GROUP_ABOUT),
      });
    } else if (decision) {
      back.pathname = members.pathname;
      await admin(group, `members/${decision[1]}/${decision[2]}`);
    } else {
      return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    if (error instanceof Refusal) return problem(error.message, back, error.status);
    throw error;
  }
  return Response.redirect(back.href, 303);
}

const problem = (message, back, status = 400) =>
  html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), status);

// --- calls from groups' sites ------------------------------------------------------------------------------------------

export async function handleMember(request, env, url, work) {
  const route = `${request.method} ${url.pathname}`;
  const db = env.DB;
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  /** @type {Row<"groups"> | null} */
  const group = match && KEY_RE.test(match[1])
    ? await db.prepare("SELECT * FROM groups WHERE key_hash = ? AND origin IS NOT NULL").bind(await sha256(match[1])).first() : null;

  // Mid-join, the group asks whether this key is ours. Only for a join still being made, and only to that very
  // site, about that very group: otherwise a group could show our key to another site and pass itself off as us.
  if (route === "GET /_member/hello") {
    const asker = siteOrigin(url.searchParams.get("from"), env);
    if (!group || group.joined_at || !asker || group.origin !== asker || String(group.remote_id) !== url.searchParams.get("group")) {
      return json({ error: "Not joining." }, 401);
    }
    return json({ name: await ownerName(db), protocol: PROTOCOL });
  }
  if (!group?.joined_at) return json({ error: "Not a member." }, 401);
  if (route === "POST /_member/notify") {
    const [body, status] = await receiveGroupNote(db, group, await request.json().catch(() => ({})),
      (notice) => notifyLater(env, url.origin, work, notice));
    return json(body, status);
  }
  if (route === "POST /_member/removed") {
    // A group this site made is only forgotten when its owner deletes it here, so its Worker is never lost track of.
    if (!group.script) await forgetGroup(db, group);
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
