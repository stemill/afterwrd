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
//   POST /_member/notify      a comment on a post the owner here wrote or commented on (notify.js)
//   POST /_member/removed     the group removed this site, turned down its request, or closed
// The owner's own actions, from their pages (views.js); forms land back where they came from:
//   POST /_groups/join                    {link}
//   POST /_groups/create/…                starting a group (groupsites.js)
//   POST /_groups/<id>/posts              {text, photos} (compose.js)
//   POST /_groups/<id>/comments           post, text, back
//   POST /_groups/<id>/(posts|comments)/<n>/delete    back
//   POST /_groups/<id>/leave
//   Running a group (its admins): POST /_groups/<id>/link (JSON), /_groups/<id>/about (name, about),
//   /_groups/<id>/members/<m>/(approve|decline|remove|admin|member); its owner: /_groups/<id>/delete (groupsites.js)
import { CONTEXT, fileUrl, groupId, groupPostId, seconds } from "../public/static/activity.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { parseMedia } from "./friends.js";
import { cleanName, cleanText, MAX_GROUP_ABOUT, MAX_GROUP_NAME, MAX_GROUP_PHOTOS, MAX_GROUP_TEXT } from "./groups.js";
import { handleGroupSites } from "./groupsites.js";
import { receiveGroupNote } from "./notify.js";
import { messagePage } from "./pages.js";
import { callSite, KEY_RE, ownerName, siteOrigin } from "./peers.js";
import { checkPhotos, removeUnusedFiles } from "./posts.js";
import { signedFile } from "./share.js";
import { html, json, now, randomToken, sha256 } from "./util.js";

const PENDING_SECONDS = 600; // a join half made is given up after this
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
      ? [{ id: Number(n[1]), name, from, text: c.content, created_at: at }] : [];
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
    photos: attachments.map((m) => parseMedia(m, site)).filter(Boolean),
    comments: parseComments(note.replies, note.id, env),
    commentCount: count(note.replies?.totalItems) ?? 0, // the group sends only the newest with a page of posts
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
  const { results } = await db.prepare("SELECT kind, post_id, remote_id, text, photos, created_at FROM group_mine WHERE site = ? AND remote_group = ?")
    .bind(group.origin, group.remote_id).all();
  const posted = new Map(results.filter((r) => r.kind === "post").map((r) => [r.remote_id, r]));
  const said = new Map(results.filter((r) => r.kind === "comment").map((r) => [`${r.post_id}:${r.remote_id}`, r]));
  const hashes = (sent) => { try { return new Set(JSON.parse(sent.photos ?? "[]")); } catch { return new Set(); } };
  return posts.flatMap((p) => {
    const sent = posted.get(p.id);
    if (!sent && p.from === ownOrigin) return [];
    const post = sent ? { ...p, mine: true, text: sent.text, created_at: sent.created_at, photos: p.photos.filter((m) => hashes(sent).has(m.hash)) }
      : { ...p, mine: false };
    return [{ ...post, comments: p.comments.flatMap((c) => {
      const kept = said.get(`${p.id}:${c.id}`);
      if (kept) return [{ ...c, mine: true, text: kept.text, created_at: kept.created_at }];
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

/** A page of a group's posts, read from its site, with the owner's own marked. */
export async function loadGroup(env, site, group, page) {
  const data = parseGroupPage(await call(group, `/_group/posts?page=${page}`), group.origin, group.remote_id, env);
  await refresh(env.DB, group, data.group);
  return { ...data, posts: await markMine(env.DB, group, data.posts, site) };
}

/** One post in a group, or null if it's gone. */
export async function loadGroupPost(env, site, group, id) {
  let note;
  try {
    note = await call(group, `/_group/posts/${Number(id)}`);
  } catch (error) {
    if (/isn't there any more/.test(error.message)) return null;
    throw error;
  }
  const info = parseGroup(note.context, group.origin, group.remote_id, env);
  const post = parseGroupNote(note, group.origin, group.remote_id, env);
  if (!post || post.id !== Number(id)) throw unexpected();
  await refresh(env.DB, group, info);
  return { group: info, post: (await markMine(env.DB, group, [post], site))[0] ?? null };
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

// --- the owner's part in a group -------------------------------------------------------------------------------------------

/** Sends a post to a group; its photos (already uploaded here) go as signed links, and are copied there. */
async function postToGroup(env, site, group, { text: words, photos }) {
  const db = env.DB;
  if (words.length > MAX_GROUP_TEXT) return { error: `Posts can be up to ${MAX_GROUP_TEXT} characters.` };
  if (!words && !photos.length) return { error: "Write something or add a photo." };
  const attachment = await Promise.all(photos.map(async (f) => ({
    type: "Image", url: fileUrl(site, f.hash), mediaType: "image/jpeg", width: f.width, height: f.height, "afterwrd:size": f.size,
    "afterwrd:fetch": await signedFile(env, site, f.hash),
    preview: { type: "Image", url: fileUrl(site, f.thumb_hash), mediaType: "image/jpeg", "afterwrd:fetch": await signedFile(env, site, f.thumb_hash) },
  })));
  try {
    const reply = await call(group, "/_group/posts", { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words, attachment });
    const prefix = groupPostId(group.origin, group.remote_id, "");
    const id = typeof reply.id === "string" && reply.id.startsWith(prefix) ? reply.id.slice(prefix.length) : "";
    if (!/^\d{1,15}$/.test(id)) throw unexpected();
    await db.prepare(`INSERT INTO group_mine (group_id, site, remote_group, kind, post_id, remote_id, text, photos, created_at)
      VALUES (?, ?, ?, 'post', ?, ?, ?, ?, ?)`).bind(group.id, group.origin, group.remote_id, Number(id), Number(id), words || null,
      JSON.stringify(photos.map((f) => f.hash)), now()).run();
    return { id: Number(id) };
  } catch (error) {
    return { error: `Couldn't post in ${group.name}: ${error.message}` };
  } finally {
    // The group has its own copies now; these were only uploaded to be sent.
    await removeUnusedFiles(env, photos.flatMap((f) => [f.hash, f.thumb_hash]));
  }
}

async function commentInGroup(env, group, postId, words) {
  if (!/^\d{1,15}$/.test(postId)) return { error: "That isn't a post in this group." };
  if (words.length > MAX_COMMENT) return { error: `Comments can be up to ${MAX_COMMENT} characters.` };
  const post = groupPostId(group.origin, group.remote_id, postId);
  let reply;
  try {
    reply = await call(group, "/_group/comments", { "@context": CONTEXT, type: "Note", mediaType: "text/plain", content: words, inReplyTo: post });
  } catch (error) {
    return { error: `Couldn't send your comment: ${error.message}` };
  }
  const n = /^#c(\d{1,15})$/.exec(typeof reply.id === "string" && reply.id.startsWith(post) ? reply.id.slice(post.length) : "");
  if (!n) return { error: "Couldn't send your comment: the group sent something unexpected." };
  await env.DB.prepare(`INSERT INTO group_mine (group_id, site, remote_group, kind, post_id, remote_id, text, created_at)
    VALUES (?, ?, ?, 'comment', ?, ?, ?, ?)`).bind(group.id, group.origin, group.remote_id, Number(postId), Number(n[1]), words, now()).run();
  return { id: Number(n[1]) };
}

/** Deletes a post or comment (`kind`: posts or comments): the owner's own, or, running the group, anyone's. */
async function deleteInGroup(env, group, kind, id) {
  try {
    await call(group, `/_group/${kind}/${Number(id)}/delete`, {});
  } catch (error) {
    return { error: `Couldn't delete it: ${error.message}` };
  }
  await env.DB.prepare("DELETE FROM group_mine WHERE site = ? AND remote_group = ? AND kind = ? AND remote_id = ?")
    .bind(group.origin, group.remote_id, kind === "posts" ? "post" : "comment", Number(id)).run();
  return {};
}

/** Forgets a group here (its notes too). The owner's copies of what they said stay. */
export const forgetGroup = (db, group) => db.batch([
  db.prepare("DELETE FROM group_inbox WHERE group_id = ?").bind(group.id),
  db.prepare("DELETE FROM groups WHERE id = ?").bind(group.id),
]);

/** An admin's request to the group; returns { error } if it said no. */
async function admin(group, path, body = {}) {
  try {
    return await call(group, `/_group/admin/${path}`, body);
  } catch (error) {
    return { error: error.message };
  }
}

export async function handleGroupActions(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("Origin") !== url.origin) return new Response("Request from another site", { status: 403 });
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
  const unfinished = match?.[2] === "/delete" ? "OR (joined_at IS NULL AND script != '')" : "";
  const group = match && await db.prepare(`SELECT * FROM groups WHERE id = ? AND (joined_at IS NOT NULL ${unfinished})`).bind(Number(match[1])).first();
  if (!group) return problem("That group isn't here any more.", new URL("/groups", site), 404);
  const action = match[2];
  if (action === "/delete") return handleGroupSites(request, env, url, group);
  if (action === "/posts") {
    const body = await request.json().catch(() => ({}));
    const photos = Array.isArray(body.photos) ? body.photos : [];
    const trouble = await checkPhotos(env, photos, MAX_GROUP_PHOTOS);
    if (trouble) return json({ error: trouble }, 400);
    const made = await postToGroup(env, site, group, { text: cleanText(body.text), photos });
    return made.error ? json({ error: made.error }, 400) : json({ ok: true });
  }
  if (action === "/link") {
    const made = await admin(group, "link");
    return made.error ? json({ error: made.error }, 400) : json({ link: made.link });
  }

  // Everything else is a form, landing back where it came from.
  const form = await request.formData().catch(() => new FormData());
  const home = `/groups/${group.id}`;
  const back = new URL(safeNext(String(form.get("back") ?? home), url), site);
  const members = new URL(`${home}/members`, site);
  let done = {};
  const del = /^\/(posts|comments)\/(\d{1,15})\/delete$/.exec(action);
  const decision = /^\/members\/(\d{1,15})\/(approve|decline|remove|admin|member)$/.exec(action);
  if (action === "/comments") {
    const words = cleanText(String(form.get("text") ?? ""));
    const post = String(form.get("post") ?? "");
    if (!words) return Response.redirect(back, 303);
    done = await commentInGroup(env, group, post, words);
    if (!done.error) back.hash = `g${post}-${done.id}`;
  } else if (del) {
    done = await deleteInGroup(env, group, del[1], del[2]);
  } else if (action === "/leave") {
    if (group.role === "owner") return problem("You own this group: delete it instead.", members);
    await call(group, "/_group/leave", {}).catch(() => {});
    await forgetGroup(db, group);
    return Response.redirect(`${site}/groups`, 303);
  } else if (action === "/about") {
    done = await admin(group, "about", {
      name: String(form.get("name") ?? "").slice(0, MAX_GROUP_NAME), about: String(form.get("about") ?? "").slice(0, MAX_GROUP_ABOUT),
    });
    back.pathname = members.pathname;
  } else if (decision) {
    done = await admin(group, `members/${decision[1]}/${decision[2]}`);
    back.pathname = members.pathname;
  } else {
    return new Response("Not found", { status: 404 });
  }
  return done.error ? problem(done.error, back) : Response.redirect(back, 303);
}

const problem = (message, back, status = 400) =>
  html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), status);

// --- calls from groups' sites ------------------------------------------------------------------------------------------

export async function handleMember(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const db = env.DB;
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  const group = match && KEY_RE.test(match[1])
    ? await db.prepare("SELECT * FROM groups WHERE key_hash = ? AND origin IS NOT NULL").bind(await sha256(match[1])).first() : null;

  // Mid-join, the group asks whether this key is ours. Only for a join still being made, and only to that very
  // site, about that very group: otherwise a group could show our key to another site and pass itself off as us.
  if (route === "GET /_member/hello") {
    const asker = siteOrigin(url.searchParams.get("from"), env);
    if (!group || group.joined_at || !asker || group.origin !== asker || String(group.remote_id) !== url.searchParams.get("group")) {
      return json({ error: "Not joining." }, 401);
    }
    return json({ name: await ownerName(db) });
  }
  if (!group?.joined_at) return json({ error: "Not a member." }, 401);
  if (route === "POST /_member/notify") {
    const [body, status] = await receiveGroupNote(db, group, await request.json().catch(() => ({})));
    return json(body, status);
  }
  if (route === "POST /_member/removed") {
    // A group this site made is only forgotten when its owner deletes it here, so its Worker is never lost track of.
    if (!group.script) await forgetGroup(db, group);
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
