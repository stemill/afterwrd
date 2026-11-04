// A group's own Worker: afterwrd in group mode (the secret GROUP_KEY is set; see index.js). It holds one group: its
// members' sites, and its posts, photos and comments. No one signs in here. Everyone, the person who made it
// included, uses it from their own afterwrd site (membership.js), with the key this Worker gave that site when it
// joined; members' sites read it when its page opens (nothing goes out to every member when someone posts), and a
// comment sends a note only to the sites of the post's writer and of the others who've commented on it (notify.js).
// A member's key opens this group and nothing else, and this Worker holds nothing but the group.
//
// Setting up, once, straight after its owner's site has made this Worker (groupsites.js):
//   GET  /_group/ping             that it's running, and its version
//   POST /_group/claim            {origin, key, setup, name, about}: the owner's site, with the GROUP_KEY it made this
//                                 Worker with. This Worker proves the key is that site's (its /_member/hello) and
//                                 answers with a key for calling the group. The owner is its first member.
// Joining, with an invite link (made by an admin; it lasts 14 days and anyone it's sent to can use it, but each use is
// only a request):
//   GET  /_join/<token>           the page the link opens: asks where your site is, and sends you there
//   GET  /_join/<token>/info      the group, for the joiner's site to show before they confirm
//   POST /_join/<token>/accept    {origin, key}: the joiner's site asks to join; proved as with claiming, then an admin
//                                 lets them in, or not
// Members' sites, with their key (one not yet let in may only leave):
//   GET  /_group/posts?page=n     the group, and its newest posts with photos (signed links) and comments
//   GET  /_group/posts/<m>        one post
//   GET  /_group/members          who's in it
//   POST /_group/posts            a Note; its photos are signed links to the member's own site, copied here
//   POST /_group/posts/<m>/delete       their own (an admin: anyone's)
//   POST /_group/comments         a Note inReplyTo a post here
//   POST /_group/comments/<n>/delete    their own (an admin: anyone's)
//   POST /_group/leave            (not the owner, who deletes the group instead)
// Admins (the owner, and members the owner makes admins):
//   GET  /_group/admin/members    everyone, with requests to join
//   POST /_group/admin/members/<id>/(approve|decline|remove)    (the owner also: admin, member)
//   POST /_group/admin/link       a new invite link (the old one stops working)
//   POST /_group/admin/about      {name, about}
// The owner:
//   POST /_group/admin/close      tells every member's site the group's gone, and empties it (the owner's site then
//                                 deletes this Worker)
import { actorId, CONTEXT, fileUrl, groupId, groupPostId, iso, tidy } from "../public/static/activity.js";
import pkg from "../package.json";
import { MAX_COMMENT } from "./archive/comments.js";
import { signedLink } from "./friends.js";
import { mediaStore } from "./media.js";
import { notifyGroupComment } from "./notify.js";
import { groupLinkPage, messagePage } from "./pages.js";
import { callSite, KEY_RE, siteOrigin } from "./peers.js";
import { removeUnusedFiles } from "./posts.js";
import { signedFile } from "./share.js";
import { html, json, now, randomToken, sha256 } from "./util.js";

export const MAX_MEMBERS = 40; // with the requests waiting, few enough that all can be told when the group closes
const MAX_WAITING = 10;
export const MAX_GROUP_PHOTOS = 8; // each is two files to copy from the member's site: within the free plan's 50 calls
export const MAX_GROUP_TEXT = 5000;
export const MAX_GROUP_NAME = 100;
export const MAX_GROUP_ABOUT = 1000;
const POSTS_PAGE = 20;
const PAGE_COMMENTS = 20; // the newest on each post in a page of posts; a post's own page has up to POST_COMMENTS
const POST_COMMENTS = 300;
const LINK_SECONDS = 14 * 86400;
const LINK_REQUESTS = 100; // requests to join one invite link can make
const WAITING_SECONDS = 7 * 86400; // a request to join no one has answered is dropped after this
const COPY_TIMEOUT_MS = 20_000;
// Photos as members' sites make them (2560px JPEGs, upload.js) are well within these.
const PHOTO_BYTES = 8_000_000;
const THUMB_BYTES = 1_000_000;
const GROUP_BYTES = 1_000_000_000; // all the group's photos: free Cloudflare accounts have 5 GB for everything
// From one member's site.
const POST_RATE = { count: 10, seconds: 600, daily: 50, photos: 40 };
const COMMENT_RATE = { count: 30, seconds: 600, daily: 300 };

export const cleanText = (text) => (typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "");
export const cleanName = (name, fallback = "Someone") => (typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : fallback);
const isAdmin = (member) => member.role === "owner" || member.role === "admin";

/** The group this Worker holds, or null before it's claimed. */
const theGroup = (db) => db.prepare("SELECT * FROM groups WHERE origin IS NULL ORDER BY id LIMIT 1").first();
const ownerOf = (db) => db.prepare("SELECT origin, name FROM group_members WHERE role = 'owner' LIMIT 1").first();

// --- what members' sites read ---------------------------------------------------------------------------------------

/** The group as a Group: its owner, how many members it has, and (for the member asking) their role. */
async function groupObject(db, site, group, member) {
  const [owner, members, waiting] = await db.batch([
    db.prepare("SELECT origin, name FROM group_members WHERE role = 'owner' LIMIT 1"),
    db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NOT NULL"),
    db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NULL"),
  ]);
  const o = owner.results[0];
  return {
    type: "Group", id: groupId(site, group.id), name: group.name, summary: group.about || undefined, published: iso(group.created_at),
    attributedTo: o ? { type: "Person", id: actorId(o.origin), name: o.name } : undefined,
    "afterwrd:members": members.results[0].n, "afterwrd:role": member.role,
    "afterwrd:waiting": isAdmin(member) ? waiting.results[0].n : undefined,
  };
}

async function photoObject(env, site, f) {
  return {
    type: "Image", url: fileUrl(site, f.hash), mediaType: "image/jpeg", width: f.width, height: f.height,
    "afterwrd:fetch": await signedFile(env, site, f.hash),
    preview: { type: "Image", url: fileUrl(site, f.thumb_hash), mediaType: "image/jpeg", "afterwrd:fetch": await signedFile(env, site, f.thumb_hash) },
  };
}

/**
 * Posts as Notes, each with its photos and its newest `comments` (and how many there are in all). Whoever wrote each
 * is named with their own site. Comments are limited so a page always fits what members' sites will read (2 MB).
 */
async function groupNotes(env, site, group, posts, comments = PAGE_COMMENTS) {
  const db = env.DB;
  if (!posts.length) return [];
  const marks = posts.map(() => "?").join(",");
  const ids = posts.map((p) => p.id);
  const [photos, newest, counts] = await db.batch([
    db.prepare(`SELECT * FROM group_photos WHERE post_id IN (${marks}) ORDER BY id`).bind(...ids),
    db.prepare(`SELECT * FROM (SELECT c.*, ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at DESC, id DESC) AS n
      FROM group_comments c WHERE post_id IN (${marks})) WHERE n <= ? ORDER BY created_at, id`).bind(...ids, comments),
    db.prepare(`SELECT post_id, COUNT(*) AS n FROM group_comments WHERE post_id IN (${marks}) GROUP BY post_id`).bind(...ids),
  ]);
  const author = (row) => ({ type: "Person", id: actorId(row.origin), name: row.author_name });
  return Promise.all(posts.map(async (p) => {
    const address = groupPostId(site, group.id, p.id);
    const thread = newest.results.filter((c) => c.post_id === p.id);
    return {
      type: "Note", id: address, attributedTo: author(p), context: groupId(site, group.id), published: iso(p.created_at),
      mediaType: "text/plain", content: p.text ?? "",
      attachment: await Promise.all(photos.results.filter((f) => f.post_id === p.id).map((f) => photoObject(env, site, f))),
      replies: {
        type: "Collection", totalItems: counts.results.find((c) => c.post_id === p.id)?.n ?? 0,
        items: thread.map((c) => ({ type: "Note", id: `${address}#c${c.id}`, attributedTo: author(c), inReplyTo: address,
          published: iso(c.created_at), mediaType: "text/plain", content: c.text })),
      },
    };
  }));
}

async function groupPage(env, site, group, member, page) {
  const db = env.DB;
  const [count, rows] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM group_posts WHERE group_id = ?").bind(group.id),
    db.prepare("SELECT * FROM group_posts WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .bind(group.id, POSTS_PAGE, (page - 1) * POSTS_PAGE),
  ]);
  const total = count.results[0].n;
  return tidy({
    "@context": CONTEXT, type: "OrderedCollectionPage", context: await groupObject(db, site, group, member), totalItems: total,
    "afterwrd:page": page, "afterwrd:hasNext": page * POSTS_PAGE < total, orderedItems: await groupNotes(env, site, group, rows.results),
  });
}

async function groupPost(env, site, group, member, id) {
  const post = await env.DB.prepare("SELECT * FROM group_posts WHERE id = ? AND group_id = ?").bind(Number(id), group.id).first();
  if (!post) return null;
  const [note] = await groupNotes(env, site, group, [post], POST_COMMENTS);
  return tidy({ "@context": CONTEXT, ...note, context: await groupObject(env.DB, site, group, member) });
}

/** Who's in the group. For an admin (`all`), requests to join too, with the numbers to act on them by. */
async function groupMembers(db, site, group, member, { all = false } = {}) {
  const { results } = await db.prepare(`SELECT id, origin, name, role, created_at, approved_at FROM group_members
    WHERE group_id = ? ${all ? "" : "AND approved_at IS NOT NULL"} ORDER BY role = 'member', name COLLATE NOCASE`).bind(group.id).all();
  return tidy({
    "@context": CONTEXT, type: "Collection", context: await groupObject(db, site, group, member), totalItems: results.length,
    items: results.map((m) => ({
      type: "Person", id: actorId(m.origin), name: m.name, "afterwrd:role": m.role,
      "afterwrd:joinedAt": iso(m.approved_at), ...(all && { "afterwrd:member": m.id, "afterwrd:waiting": !m.approved_at }),
    })),
  });
}

// --- posting and commenting -----------------------------------------------------------------------------------------

const tooMany = (what) => ({ error: `That's a lot of ${what} for now. Try again later.`, status: 429 });

/**
 * The photos in a member's post: each a signed link to a file on their own site, exactly (see friends.js), with its
 * thumbnail. Returns { photos } or { error }.
 */
export function memberPhotos(attachments, origin) {
  if (attachments === undefined) return { photos: [] };
  if (!Array.isArray(attachments) || attachments.length > MAX_GROUP_PHOTOS) return { error: `Up to ${MAX_GROUP_PHOTOS} photos in a group post.` };
  const side = (n) => Number.isSafeInteger(n) && n > 0 && n <= 20_000;
  const file = (url) => (typeof url === "string" && url.startsWith(`${origin}/files/`) ? url.slice(`${origin}/files/`.length) : "");
  const photos = [];
  for (const a of attachments) {
    const hash = file(a?.url);
    const thumb = file(a?.preview?.url);
    const src = /^[0-9a-f]{64}$/.test(hash) && signedLink(origin, a["afterwrd:fetch"], hash);
    const thumbSrc = /^[0-9a-f]{64}$/.test(thumb) && signedLink(origin, a.preview["afterwrd:fetch"], thumb);
    const size = a?.["afterwrd:size"];
    if (a?.type !== "Image" || !src || !thumbSrc || !side(a.width) || !side(a.height) || !Number.isSafeInteger(size) || size <= 0) {
      return { error: "Unexpected photo details." };
    }
    if (size > PHOTO_BYTES) return { error: "That photo is too big for a group." };
    photos.push({ hash, thumb_hash: thumb, width: a.width, height: a.height, size, src, thumbSrc });
  }
  return { photos };
}

/** A body that stops with an error after `limit` bytes. */
function capped(body, limit) {
  let seen = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) controller.error(new Error("too big"));
      else controller.enqueue(chunk);
    },
  }));
}

/**
 * Copies a member's photos here from their site, one file at a time, each no bigger than it should be; the media
 * store checks each file matches its hash (and keeps one it already has). Two calls out per file: within the free
 * plan's 50 for a post's 8 photos and their thumbnails.
 */
async function copyPhotos(env, photos) {
  const files = [...new Map(photos.flatMap((p) => [[p.hash, [p.src, PHOTO_BYTES]], [p.thumb_hash, [p.thumbSrc, THUMB_BYTES]]])).entries()];
  for (const [hash, [link, limit]] of files) {
    let response;
    try {
      response = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(COPY_TIMEOUT_MS) });
    } catch {
      throw new Error("Couldn't fetch a photo from your site.");
    }
    if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      throw new Error("Couldn't fetch a photo from your site.");
    }
    const stored = await mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
      method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: capped(response.body, limit),
    })).catch(() => null);
    if (!stored?.ok) throw new Error("A photo arrived damaged, or is too big.");
  }
}

/**
 * A member's new post. The post and its photos are saved first, in one statement that checks the member's limits
 * (posts, photos a day) and the group's room for photos; then the photos are copied from the member's site, and if
 * that fails the post goes again, with any files it brought. Returns { id } or { error, status }.
 */
async function createPost(env, group, member, { text, photos }) {
  const db = env.DB;
  if (text.length > MAX_GROUP_TEXT) return { error: `Posts can be up to ${MAX_GROUP_TEXT} characters.`, status: 400 };
  if (!text && !photos.length) return { error: "Write something or add a photo.", status: 400 };
  const at = now();
  const bytes = photos.reduce((n, f) => n + f.size + THUMB_BYTES, 0);
  const saved = await db.prepare(`INSERT INTO group_posts (group_id, origin, author_name, text, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5
      WHERE (SELECT COUNT(*) FROM group_posts WHERE origin = ?2 AND created_at > ?5 - ?6) < ?7
        AND (SELECT COUNT(*) FROM group_posts WHERE origin = ?2 AND created_at > ?5 - 86400) < ?8
        AND (SELECT COUNT(*) FROM group_photos f JOIN group_posts p ON p.id = f.post_id
          WHERE p.origin = ?2 AND p.created_at > ?5 - 86400) + ?9 <= ?10
        AND (SELECT COALESCE(SUM(size), 0) FROM group_photos) + ?11 <= ?12
      RETURNING id`).bind(group.id, member.origin, member.name, text || null, at, POST_RATE.seconds, POST_RATE.count,
      POST_RATE.daily, photos.length, POST_RATE.photos, bytes, GROUP_BYTES).first();
  const id = saved?.id;
  if (!id) return { error: "That's a lot of posts or photos for now, or the group is full of photos. Try again later.", status: 429 };
  // Its photos, referenced before they're copied, so a file can't be cleared away while it's arriving.
  if (photos.length) {
    await db.batch(photos.map((f) => db.prepare(`INSERT INTO group_photos (post_id, hash, thumb_hash, width, height, size)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(id, f.hash, f.thumb_hash, f.width, f.height, f.size + THUMB_BYTES)));
  }
  try {
    await copyPhotos(env, photos);
  } catch (error) {
    await deletePost(env, group, null, id);
    return { error: error.message, status: 400 };
  }
  return { id };
}

/** Deletes a post, its comments and its photos (the files too). Its writer, an admin (not the owner's), or (member null) this Worker. */
async function deletePost(env, group, member, id) {
  const db = env.DB;
  const post = await db.prepare("SELECT * FROM group_posts WHERE id = ? AND group_id = ?").bind(Number(id), group.id).first();
  if (!post || (member && !(await mayDelete(db, member, post.origin)))) return false;
  const { results: photos } = await db.prepare("SELECT hash, thumb_hash FROM group_photos WHERE post_id = ?").bind(post.id).all();
  await db.batch([
    db.prepare("DELETE FROM group_comments WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM group_photos WHERE post_id = ?").bind(post.id),
    db.prepare("DELETE FROM group_posts WHERE id = ?").bind(post.id),
  ]);
  await removeUnusedFiles(env, photos.flatMap((f) => [f.hash, f.thumb_hash]));
  return true;
}

/** Whether `member` may delete something written from `origin`: their own; an admin, anyone's but the owner's; the owner, anything. */
async function mayDelete(db, member, origin) {
  if (origin === member.origin || member.role === "owner") return true;
  if (member.role !== "admin") return false;
  return (await ownerOf(db))?.origin !== origin;
}

/** A comment on a post; tells the members who'll want to know. Returns { id } or { error, status }. */
async function addComment(env, site, group, member, postId, text) {
  const db = env.DB;
  if (!text || text.length > MAX_COMMENT) return { error: `Comments need 1 to ${MAX_COMMENT} characters.`, status: 400 };
  const post = await db.prepare("SELECT * FROM group_posts WHERE id = ? AND group_id = ?").bind(Number(postId), group.id).first();
  if (!post) return { error: "That post isn't there any more.", status: 404 };
  const at = now();
  const row = await db.prepare(`INSERT INTO group_comments (post_id, origin, author_name, text, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE (SELECT COUNT(*) FROM group_comments WHERE origin = ?2 AND created_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM group_comments WHERE origin = ?2 AND created_at > ?5 - 86400) < ?8
    RETURNING id`).bind(post.id, member.origin, member.name, text, at, COMMENT_RATE.seconds, COMMENT_RATE.count, COMMENT_RATE.daily).first();
  if (!row) return tooMany("comments");
  await notifyGroupComment(env, site, group, post, { id: row.id, name: member.name, text, from: member.origin });
  return { id: row.id };
}

async function deleteComment(db, group, member, id) {
  const comment = await db.prepare(`SELECT c.* FROM group_comments c JOIN group_posts p ON p.id = c.post_id
    WHERE c.id = ? AND p.group_id = ?`).bind(Number(id), group.id).first();
  if (!comment || !(await mayDelete(db, member, comment.origin))) return false;
  await db.prepare("DELETE FROM group_comments WHERE id = ?").bind(comment.id).run();
  return true;
}

// --- running the group ------------------------------------------------------------------------------------------------

/** Tells a member's site it's no longer in the group, if it can be reached. */
const tellRemoved = (member) => callSite(member.origin, "/_member/removed", { key: member.their_key, body: {} }).catch(() => {});

/** An admin's decision about someone; returns an error message, or null. */
async function decide(env, group, admin, id, action) {
  const db = env.DB;
  const member = await db.prepare("SELECT * FROM group_members WHERE id = ? AND group_id = ?").bind(Number(id), group.id).first();
  if (!member || member.id === admin.id || member.role === "owner") return "You can't do that.";
  if (!member.approved_at && member.created_at < now() - WAITING_SECONDS) return "That request has expired.";
  // Admins are the owner's choice, and only the owner can remove one.
  if ((member.role === "admin" || action === "admin" || action === "member") && admin.role !== "owner") return "Only the group's owner can do that.";
  if (action === "approve") {
    if (member.approved_at) return null;
    const done = await db.prepare(`UPDATE group_members SET approved_at = ?1 WHERE id = ?2
      AND (SELECT COUNT(*) FROM group_members WHERE group_id = ?3 AND approved_at IS NOT NULL) < ?4`)
      .bind(now(), member.id, group.id, MAX_MEMBERS + 1).run();
    return done.meta.changes ? null : `The group is full: it can have up to ${MAX_MEMBERS} members besides its owner.`;
  }
  if (action === "admin" || action === "member") {
    if (!member.approved_at) return "Let them in first.";
    await db.prepare("UPDATE group_members SET role = ? WHERE id = ?").bind(action, member.id).run();
    return null;
  }
  // Decline a request, or remove someone. What they posted stays, as on Facebook; an admin can delete it.
  await tellRemoved(member);
  await db.prepare("DELETE FROM group_members WHERE id = ?").bind(member.id).run();
  return null;
}

/** Empties the group, then tells its members' sites (last: those calls use up the free plan's 50). */
async function close(env, group, owner) {
  const db = env.DB;
  const { results: members } = await db.prepare("SELECT * FROM group_members WHERE id != ?").bind(owner.id).all();
  const { results: photos } = await db.prepare("SELECT hash, thumb_hash FROM group_photos").all();
  await db.batch([
    ...["group_comments", "group_photos", "group_posts", "group_links", "group_members", "groups"].map((table) => db.prepare(`DELETE FROM ${table}`)),
    // So it can't be claimed again, should its Worker outlast this (its owner's site deletes it next).
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('group_closed', '1')"),
  ]);
  await removeUnusedFiles(env, photos.flatMap((f) => [f.hash, f.thumb_hash]));
  await Promise.all(members.slice(0, MAX_MEMBERS + MAX_WAITING).map(tellRemoved));
}

/** Proves `key` belongs to the site at `origin`, and was made there for joining (or claiming) this group. */
async function proveSite(url, origin, key, groupNumber) {
  try {
    return await callSite(origin, `/_member/hello?from=${encodeURIComponent(url.origin)}&group=${groupNumber}`, { key });
  } catch (error) {
    throw new Error(`Couldn't confirm your site: ${error.message}`);
  }
}

/** The owner's site claims the group, once, with the GROUP_KEY it made this Worker with. */
async function claim(request, env, url) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  if (typeof body.setup !== "string" || (await sha256(body.setup)) !== (await sha256(env.GROUP_KEY))) return json({ error: "Not this group's key." }, 403);
  if (await theGroup(db) || await db.prepare("SELECT 1 FROM settings WHERE key = 'group_closed'").first()) {
    return json({ error: "This group is already set up." }, 409);
  }
  const origin = siteOrigin(body.origin, env);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_GROUP_NAME) : "";
  if (!origin || origin === url.origin || !KEY_RE.test(body.key ?? "") || !name) return json({ error: "That doesn't look like an afterwrd site." }, 400);
  let them;
  try {
    them = await proveSite(url, origin, body.key, 1);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const key = randomToken();
  const about = cleanText(body.about).slice(0, MAX_GROUP_ABOUT) || null;
  // Group 1, always: its addresses are <this site>/groups/1/….
  await db.batch([
    db.prepare("INSERT INTO groups (id, name, about, created_at) VALUES (1, ?, ?, ?)").bind(name, about, now()),
    db.prepare(`INSERT INTO group_members (group_id, origin, name, their_key, key_hash, role, created_at, approved_at)
      VALUES (1, ?, ?, ?, ?, 'owner', ?, ?)`).bind(origin, cleanName(them.name), body.key, await sha256(key), now(), now()),
  ]);
  return json({ key, id: 1, name, about, owner: cleanName(them.name) });
}

// --- the invite link, opened by someone and used by their site ---------------------------------------------------------

async function linkedGroup(db, token) {
  return db.prepare(`SELECT g.*, l.token_hash FROM group_links l JOIN groups g ON g.id = l.group_id AND g.origin IS NULL
    WHERE l.token_hash = ? AND l.expires_at > ? AND l.requests < ?`).bind(await sha256(token), now(), LINK_REQUESTS).first();
}

export async function handleJoinLink(request, env, url) {
  const match = /^\/_join\/([\w-]{40,100})(\/info|\/accept)?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, token, action] = match;
  const db = env.DB;
  const group = await linkedGroup(db, token);
  if (!group) {
    const message = "This invite link has expired. Ask whoever sent it for a new one.";
    return action ? json({ error: message }, 404) : html(messagePage(message, { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
  }
  const owner = await ownerOf(db);
  if (request.method === "GET" && !action) return html(groupLinkPage(group.name, owner?.name ?? "Someone"));
  if (request.method === "GET" && action === "/info") return json({ id: group.id, name: group.name, about: group.about, owner: owner?.name });
  if (request.method !== "POST" || action !== "/accept") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  const origin = siteOrigin(body.origin, env);
  if (!origin || origin === url.origin || !KEY_RE.test(body.key ?? "")) return json({ error: "That doesn't look like an afterwrd site." }, 400);
  // Each request is counted against the link before this Worker calls anyone, and old unanswered requests go.
  const counted = await db.prepare("UPDATE group_links SET requests = requests + 1 WHERE token_hash = ? AND requests < ?")
    .bind(group.token_hash, LINK_REQUESTS).run();
  if (!counted.meta.changes) return json({ error: "This invite link has been used too many times. Ask for a new one." }, 429);
  await db.prepare("DELETE FROM group_members WHERE approved_at IS NULL AND created_at < ?").bind(now() - WAITING_SECONDS).run();
  let them;
  try {
    them = await proveSite(url, origin, body.key, group.id);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const existing = await db.prepare("SELECT approved_at FROM group_members WHERE group_id = ? AND origin = ?").bind(group.id, origin).first();
  if (existing?.approved_at) return json({ error: "You're already in this group." }, 409);
  // A request, waiting for an admin; asking again replaces it. The number waiting is checked as it's saved.
  const key = randomToken();
  const at = now();
  await db.prepare("DELETE FROM group_members WHERE group_id = ? AND origin = ? AND approved_at IS NULL").bind(group.id, origin).run();
  const row = await db.prepare(`INSERT INTO group_members (group_id, origin, name, their_key, key_hash, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ?1 AND approved_at IS NULL) < ?7
    RETURNING id`).bind(group.id, origin, cleanName(them.name), body.key, await sha256(key), at, MAX_WAITING).first();
  if (!row) return json({ error: "Too many people are waiting to join this group. Try again later." }, 429);
  return json({ key, id: group.id, name: group.name, about: group.about, owner: owner?.name });
}

// --- members' sites --------------------------------------------------------------------------------------------------

async function memberFrom(request, env) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || !KEY_RE.test(match[1])) return null;
  return env.DB.prepare("SELECT * FROM group_members WHERE key_hash = ?").bind(await sha256(match[1])).first();
}

export async function handleGroupApi(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const db = env.DB;
  if (route === "GET /_group/ping") return json({ afterwrd: "group", version: pkg.version });
  if (route === "POST /_group/claim") return claim(request, env, url);

  const member = await memberFrom(request, env);
  const group = member && await theGroup(db);
  if (!member || !group) return json({ error: "Not a member of this group." }, 401);
  if (route === "POST /_group/leave") {
    if (member.role === "owner") return json({ error: "You own this group: delete it instead." }, 400);
    await db.prepare("DELETE FROM group_members WHERE id = ?").bind(member.id).run();
    return json({ ok: true });
  }
  if (!member.approved_at) return json({ error: `Waiting for ${(await ownerOf(db))?.name ?? "the group"} to let you in.` }, 403);

  const site = url.origin;
  const one = /^(GET|POST) \/_group\/(posts|comments)\/(\d{1,15})(\/delete)?$/.exec(route);
  if (route === "GET /_group/posts") {
    const page = Math.min(10_000, Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1));
    return json(await groupPage(env, site, group, member, page));
  }
  if (route === "GET /_group/members") return json(await groupMembers(db, site, group, member));
  if (one?.[1] === "GET" && one[2] === "posts" && !one[4]) {
    const post = await groupPost(env, site, group, member, one[3]);
    return post ? json(post) : json({ error: "That post isn't there any more." }, 404);
  }
  if (one?.[1] === "POST" && one[4]) {
    const done = one[2] === "posts" ? await deletePost(env, group, member, one[3]) : await deleteComment(db, group, member, one[3]);
    return done ? json({ ok: true }) : json({ error: "That isn't yours, or it's already gone." }, 404);
  }
  if (route === "POST /_group/posts") {
    const note = await request.json().catch(() => ({}));
    if (note?.type !== "Note") return json({ error: "Expected a Note." }, 400);
    const { photos, error } = memberPhotos(note.attachment, member.origin);
    if (error) return json({ error }, 400);
    const made = await createPost(env, group, member, { text: cleanText(note.content), photos });
    return made.error ? json({ error: made.error }, made.status) : json({ id: groupPostId(site, group.id, made.id) });
  }
  if (route === "POST /_group/comments") {
    const note = await request.json().catch(() => ({}));
    const base = groupPostId(site, group.id, "");
    const reply = typeof note?.inReplyTo === "string" && note.inReplyTo.startsWith(base) ? note.inReplyTo.slice(base.length) : "";
    if (note?.type !== "Note" || !/^\d{1,15}$/.test(reply)) return json({ error: "That isn't a post in this group." }, 404);
    const made = await addComment(env, site, group, member, reply, cleanText(note.content));
    return made.error ? json({ error: made.error }, made.status) : json({ id: `${groupPostId(site, group.id, reply)}#c${made.id}` });
  }

  // Running the group.
  if (!url.pathname.startsWith("/_group/admin/")) return json({ error: "Not found." }, 404);
  if (!isAdmin(member)) return json({ error: "Only the group's admins can do that." }, 403);
  if (route === "GET /_group/admin/members") return json(await groupMembers(db, site, group, member, { all: true }));
  const decision = /^POST \/_group\/admin\/members\/(\d{1,15})\/(approve|decline|remove|admin|member)$/.exec(route);
  if (decision) {
    const trouble = await decide(env, group, member, decision[1], decision[2]);
    return trouble ? json({ error: trouble }, 400) : json({ ok: true });
  }
  if (route === "POST /_group/admin/link") {
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM group_links"),
      db.prepare("INSERT INTO group_links (token_hash, group_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(token), group.id, now() + LINK_SECONDS, now()),
    ]);
    return json({ link: `${site}/_join/${token}` });
  }
  if (route === "POST /_group/admin/about") {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_GROUP_NAME) : "";
    if (!name) return json({ error: "Give the group a name." }, 400);
    await db.prepare("UPDATE groups SET name = ?, about = ? WHERE id = ?")
      .bind(name, cleanText(body.about).slice(0, MAX_GROUP_ABOUT) || null, group.id).run();
    return json({ ok: true });
  }
  if (route === "POST /_group/admin/close") {
    if (member.role !== "owner") return json({ error: "Only the group's owner can delete it." }, 403);
    await close(env, group, member);
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
