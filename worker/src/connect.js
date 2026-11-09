// Connecting with a friend's afterwrd site. The owner makes a one-time Connect link on /_admin/connections and
// sends it to a friend, who opens it, says where their own site is, and confirms there. Their site then:
//   1. keeps a new key for this site to call it with, and sends it to POST /_connect/<token>/accept here;
//   2. this site proves the key is theirs, and meant for this site, by calling their /_peer/hello?from=<this site>
//      with it; then keeps it and answers with a key for them to call this site with.
// Connections are mutual: both owners read each other's posts and photos from their own sites, on Home and on friend
// pages, and can comment on them (peers.js, friends.js). A link only asks: the site that made it shares nothing
// until its owner approves the request on Friends, so a link passed on to someone else gets them nowhere.
// Links made with "Invite to afterwrd" on Friends (POST …/invite) are for one person in the Facebook download, last
// 30 days, and link the new friend to that person when approved.
//
// Asking without a link (0.32.0): the same handshake, sent to POST /_connect/ask instead of a link's accept, and only
// accepted from someone in a group with this site's owner (checked by asking the group) or introduced to them by one
// of their friends (an introduction this site was sent: POST /_peer/introduce, below). Anyone else needs a link. A
// declined request can't be made again this way; still nothing is shared until the owner approves.
//
// Without a session:   GET /_connect/<token>  (the page the link opens), GET …/info, POST …/accept, POST /_connect/ask
// The owner's:         GET /_admin/connections, POST …/link, GET|POST …/new?link=, POST …/<id>/disconnect,
//                      POST …/<id>/facebook (name, or none=1): which person in the Facebook download they are,
//                      POST …/ask (origin, group or introduction, back), GET|POST …/<id>/introduce (to, note),
//                      POST …/introductions/<n>/dismiss
import { safeNext } from "./auth.js";
import { testingHere } from "./cloudflare.js";
import { loadMembers } from "./membership.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { connectLinkPage, messagePage } from "./pages.js";
import { callSite, host, KEY_RE, ownerName, siteOrigin } from "./peers.js";
import { lastChecked } from "./checks.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

// A friend link lasts 30 days, enough for someone new to set up their own site first (and wait for Facebook's
// download, if they want it). It works once, and only asks: nothing is shared until its owner approves.
const LINK_SECONDS = 30 * 24 * 3600;
const INSTALLER = "https://install.afterwrd.app/";
const PENDING_SECONDS = 600; // a connection half made is given up after this
const LINK_RE = /^\/_connect\/([\w-]{40,100})$/;
const ASKS_WAITING = 20; // requests waiting for the owner, at most
const ASKS = { hour: 30, perSite: 5 }; // requests without a link (with a reason) in an hour, at most: overall, and from one site
const MEMBERS = { trust: 600, recheck: 60 }; // seconds: a group's member list counts this long; asked again no sooner
const MAX_NOTE = 300; // an introduction's note
// Introductions: from one friend a day, and kept, at most; kept overall at most; for how long.
const INTRODUCTIONS = { perFriendDay: 20, perFriend: 20, kept: 100, days: 60 };
const NOT_ALLOWED = "Without a friend link, you can only ask someone you're in a group with, or a friend has introduced you to.";

const cleanName = (name) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : "A friend");

async function openLink(db, token) {
  return db.prepare("SELECT * FROM connect_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(token), now()).first();
}

// --- the link, opened by a friend (no session) ---------------------------------------------------------------

export async function handleConnectLink(request, env, url) {
  if (url.pathname === "/_connect/ask") {
    return request.method === "POST" ? ask(request, env, url) : new Response("Not found", { status: 404 });
  }
  const match = /^\/_connect\/([\w-]{40,100})(\/info|\/accept)?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, token, action] = match;
  const db = env.DB;
  const link = await openLink(db, token);
  if (!link) {
    const message = "This friend link has expired or has already been used. Ask your friend for a new one.";
    return action ? json({ error: message }, 404) : html(messagePage(message, { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
  }
  if (request.method === "GET" && !action) {
    return html(connectLinkPage(await ownerName(db), { invitedAs: link.person_name ?? null,
      installer: (testingHere(env, url.origin) && env.INSTALLER_URL) || INSTALLER }));
  }
  if (request.method === "GET" && action === "/info") return json({ name: await ownerName(db) });
  if (request.method === "POST" && action === "/accept") return accept(request, env, url, token);
  return new Response("Not found", { status: 404 });
}

async function accept(request, env, url, token) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  const origin = siteOrigin(body.origin, env);
  if (!origin || origin === url.origin || !KEY_RE.test(body.key ?? "")) return json({ error: "That doesn't look like an afterwrd site." }, 400);

  // Prove the key belongs to the site it claims to be from, and was made for connecting with this one.
  let them;
  try {
    them = await callSite(origin, `/_peer/hello?from=${encodeURIComponent(url.origin)}`, { key: body.key });
  } catch (error) {
    return json({ error: `Couldn't confirm your site: ${error.message}` }, 400);
  }
  const existing = await db.prepare("SELECT 1 FROM connections WHERE origin = ? AND connected_at IS NOT NULL").bind(origin).first();
  if (existing) return json({ error: "Your sites are already connected." }, 409);
  const link = await openLink(db, token);
  const spent = await db.prepare("UPDATE connect_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(now(), await sha256(token)).run();
  if (!link || !spent.meta.changes) return json({ error: "This friend link has already been used." }, 404);

  // Connected, but waiting for this site's owner to approve (approved_at): nothing is shared until then.
  const key = randomToken();
  await db.batch([
    db.prepare("DELETE FROM connections WHERE origin = ?").bind(origin),
    db.prepare(`INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, invited_as)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(origin, cleanName(them.name), body.key, await sha256(key), now(), now(), link.person_name ?? null),
  ]);
  return json({ name: await ownerName(db), key });
}

/**
 * Someone asking to be friends without a link: only from someone in a group with the owner here, or introduced to
 * them by a friend. Otherwise as accept, above: their key is checked with their site, and the owner here decides.
 */
async function ask(request, env, url) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  const origin = siteOrigin(body.origin, env);
  if (!origin || origin === url.origin || !KEY_RE.test(body.key ?? "")) return json({ error: "That doesn't look like an afterwrd site." }, 400);
  // Until the asker has proved it's that site, every refusal is the same, so nobody can find out from here who the
  // owner is friends with, has turned down, has been introduced to, or shares a group with.
  const notAllowed = () => json({ error: NOT_ALLOWED }, 403);
  const via = await reasonFor(env, origin, body.via);
  if (!via) return notAllowed();
  // Only requests with a reason are counted (in the same statement, so ones sent all at once can't slip past).
  const at = now();
  const [, counted] = await db.batch([
    db.prepare("DELETE FROM ask_log WHERE at < ?").bind(at - 3600),
    db.prepare(`INSERT INTO ask_log (at, origin) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM ask_log WHERE at > ?1 - 3600) < ?3
      AND (SELECT COUNT(*) FROM ask_log WHERE origin = ?2 AND at > ?1 - 3600) < ?4 RETURNING at`).bind(at, origin, ASKS.hour, ASKS.perSite),
  ]);
  if (!counted.results.length) return json({ error: "Lots of people are asking to be friends just now. Try again later." }, 429);
  let them;
  try {
    them = await callSite(origin, `/_peer/hello?from=${encodeURIComponent(url.origin)}`, { key: body.key });
  } catch {
    return notAllowed();
  }
  // Proved: now it may hear how things stand between it and the owner here.
  const existing = await db.prepare("SELECT approved_at FROM connections WHERE origin = ? AND connected_at IS NOT NULL").bind(origin).first();
  if (existing?.approved_at) return json({ error: "You're already friends." }, 409);
  // Already asking, or turned down: the same answer.
  if (existing || await db.prepare("SELECT 1 FROM declined_asks WHERE origin = ?").bind(origin).first()) return json({ error: "You've already asked." }, 409);
  const key = randomToken();
  const [, added] = await db.batch([
    db.prepare("DELETE FROM connections WHERE origin = ? AND connected_at IS NULL").bind(origin),
    // Limits checked in the same statement as the insert, so requests sent all at once can't slip past.
    db.prepare(`INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, via_kind, via_name)
      SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM connections WHERE origin = ?1)
        AND (SELECT COUNT(*) FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL) < ?8 RETURNING id`)
      .bind(origin, cleanName(them.name), body.key, await sha256(key), at, via.kind, via.name, ASKS_WAITING),
  ]);
  if (!added.results.length) return json({ error: `${await ownerName(db)} has a lot of friend requests waiting. Try again later.` }, 429);
  return json({ name: await ownerName(db), key });
}

// Introductions still good: from a friend still here who has also approved the owner here (their site has answered).
const LIVE_INTRODUCTION = `JOIN connections c ON c.id = i.connection_id AND c.approved_at IS NOT NULL AND c.reached_at IS NOT NULL
  WHERE i.origin = ? AND i.created_at > ?`;

/** The introduction to `origin` the owner here holds, as { id, name, by }, or null. */
export const liveIntroduction = (db, origin) => db.prepare(`SELECT i.id, i.name, c.name AS by FROM introductions i ${LIVE_INTRODUCTION}
  ORDER BY i.created_at DESC LIMIT 1`).bind(origin, now() - INTRODUCTIONS.days * 86400).first();

/**
 * Why `origin` may ask without a link, as { kind, name }, or null: an introduction to them from a friend, or a group
 * the owner here is in (never an address the asker chose) that lists them as a member. The group is asked at most
 * once a minute; what it said counts for 10 minutes.
 */
async function reasonFor(env, origin, via) {
  const db = env.DB;
  if (via?.introduction === true) {
    const made = await liveIntroduction(db, origin);
    return made && { kind: "introduction", name: made.by };
  }
  const groupOrigin = siteOrigin(via?.group, env);
  const id = Number(via?.id);
  if (!groupOrigin || !Number.isSafeInteger(id) || id <= 0) return null;
  const group = await db.prepare("SELECT * FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NOT NULL").bind(groupOrigin, id).first();
  if (!group) return null;
  const cached = await db.prepare("SELECT * FROM group_member_cache WHERE group_id = ?").bind(group.id).first();
  const age = cached ? now() - cached.checked_at : Infinity;
  let listed = [];
  try { listed = JSON.parse(cached?.origins ?? "[]"); } catch {}
  if (age < MEMBERS.trust && listed.includes(origin)) return { kind: "group", name: cached.name };
  if (age < MEMBERS.recheck) return null;
  let members;
  let info;
  try {
    ({ group: info, members } = await loadMembers(env, group));
  } catch {
    return null;
  }
  const origins = members.filter((m) => m.from && !m.waiting).map((m) => m.from);
  await db.prepare("INSERT OR REPLACE INTO group_member_cache (group_id, name, origins, checked_at) VALUES (?, ?, ?, ?)")
    .bind(group.id, info.name, JSON.stringify(origins), now()).run();
  return origins.includes(origin) ? { kind: "group", name: info.name } : null;
}

/** A friend's site introducing the owner here to someone else: kept to show on Friends and Home. Returns [body, status]. */
export async function receiveIntroduction(env, url, peer, body) {
  const db = env.DB;
  const origin = siteOrigin(body?.origin, env);
  if (!origin || origin === url.origin || origin === peer.origin) return [{ error: "That isn't someone to be introduced to." }, 400];
  const note = typeof body.content === "string" ? body.content.replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTE) : "";
  // Only from a friend who has approved the owner here too (not just someone the owner asked): their site has
  // answered this one. If it never has, it's asked once now.
  if (!peer.reached_at) {
    try {
      await callSite(peer.origin, "/_peer/feed", { key: peer.their_key });
    } catch {
      return [{ error: `${await ownerName(db)} hasn't approved you as a friend yet.` }, 403];
    }
    await db.prepare("UPDATE connections SET reached_at = ?, missing_since = NULL, said_no = 0 WHERE id = ?").bind(now(), peer.id).run();
  }
  // Already friends (or asking), turned down, or already introduced by them: nothing to do, and nothing said about which.
  const known = await db.prepare(`SELECT 1 FROM connections WHERE origin = ?1 AND connected_at IS NOT NULL
    UNION SELECT 1 FROM declined_asks WHERE origin = ?1 UNION SELECT 1 FROM introductions WHERE origin = ?1 AND connection_id = ?2`)
    .bind(origin, peer.id).first();
  if (known) return [{ ok: true }, 200];
  const at = now();
  // Limits checked in the same statement as the insert.
  const [, kept] = await db.batch([
    db.prepare("DELETE FROM introductions WHERE created_at < ?").bind(at - INTRODUCTIONS.days * 86400),
    db.prepare(`INSERT INTO introductions (connection_id, origin, name, note, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM introductions WHERE connection_id = ?1 AND created_at > ?5 - 86400) < ?6
        AND (SELECT COUNT(*) FROM introductions WHERE connection_id = ?1) < ?7 AND (SELECT COUNT(*) FROM introductions) < ?8
      ON CONFLICT (connection_id, origin) DO NOTHING
      RETURNING id`).bind(peer.id, origin, cleanName(body.name), note || null, at, INTRODUCTIONS.perFriendDay, INTRODUCTIONS.perFriend,
      INTRODUCTIONS.kept),
  ]);
  return kept.results.length ? [{ ok: true }, 200] : [{ error: "That's a lot of introductions for now. Try again later." }, 429];
}

// --- the owner's side ---------------------------------------------------------------------------------------------

export async function handleConnections(request, env, url) {
  const db = env.DB;
  const path = url.pathname.slice("/_admin/connections".length);
  if (request.method === "GET" && path === "") {
    const { results } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY name COLLATE NOCASE`).all();
    return html(connectionsPage(results, !(await lastChecked(db))));
  }
  if (path === "/new") {
    const target = parseLink(url.searchParams.get("link") ?? "", url, env);
    if (request.method === "GET") {
      if (target.error) return html(connectionsMessage(target.error), 400);
      try {
        const info = await callSite(target.origin, `/_connect/${target.token}/info`);
        return html(confirmPage(cleanName(info.name), target.origin));
      } catch (error) {
        return html(connectionsMessage(error.message), 400);
      }
    }
    if (request.method === "POST") return connect(env, url, target);
  }
  if (request.method === "POST" && path === "/link") {
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM connect_links WHERE expires_at < ?").bind(now()),
      db.prepare("INSERT INTO connect_links (token_hash, expires_at, created_at) VALUES (?, ?, ?)").bind(await sha256(token), now() + LINK_SECONDS, now()),
    ]);
    const link = `${url.origin}/_connect/${token}`;
    return json({ link, message: `I'm on afterwrd, a small private social network where each of us has our own site, `
      + `free. Open this to be friends with me: it shows you how to set up your own if you haven't got one yet. ${link}` });
  }
  // An invitation for someone in the Facebook download: a friend link for them alone, and a message to send.
  if (request.method === "POST" && path === "/invite") {
    const body = await request.json().catch(() => ({}));
    const person = await db.prepare("SELECT name FROM people WHERE is_me = 0 AND name = ? COLLATE NOCASE LIMIT 1")
      .bind(String(body.name ?? "").trim()).first();
    if (!person) return json({ error: "That name isn't in your Facebook download." }, 404);
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM connect_links WHERE (person_name = ? AND used_at IS NULL) OR expires_at < ?").bind(person.name, now()),
      db.prepare("INSERT INTO connect_links (token_hash, expires_at, person_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(token), now() + LINK_SECONDS, person.name, now()),
    ]);
    const link = `${url.origin}/_connect/${token}`;
    const first = person.name.split(" ")[0];
    const message = `Hi ${first}, I've moved my posts and photos to afterwrd, a small private social network where each `
      + `of us has our own site, free. Open this to be friends with me: it shows you how to set up your own first. ${link}`;
    return json({ name: person.name, link, message });
  }
  // Someone asked to be friends: approve (share, and link them to who the invite was for) or decline (forget them;
  // if they asked without a link, they can't again that way). From Home's line (?back=home) it goes back to Home,
  // from a group's members to there (?back=<path>); otherwise to Friends.
  const decide = /^\/(\d+)\/(approve|decline)$/.exec(path);
  if (request.method === "POST" && decide) {
    const connection = await db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NULL")
      .bind(Number(decide[1])).first();
    if (connection && decide[2] === "approve") await approve(db, connection);
    else if (connection) {
      await callSite(connection.origin, "/_peer/disconnect", { key: connection.their_key, body: {} }).catch(() => {});
      await db.batch([
        db.prepare("DELETE FROM connections WHERE id = ?").bind(connection.id),
        db.prepare("DELETE FROM introductions WHERE origin = ?").bind(connection.origin),
        ...(connection.via_kind ? [db.prepare("INSERT OR REPLACE INTO declined_asks (origin, declined_at) VALUES (?, ?)").bind(connection.origin, now())] : []),
      ]);
    }
    const back = url.searchParams.get("back");
    return Response.redirect(`${url.origin}${back === "home" ? "/" : back ? safeNext(back, url) : "/friend"}`, 303);
  }
  // Asking someone to be friends without a link: someone in one of the owner's groups, or someone a friend introduced.
  if (request.method === "POST" && path === "/ask") return askFrom(env, url, await request.formData().catch(() => new FormData()));
  // Introducing a friend to another friend: each of their sites is told about the other.
  const introduce = /^\/(\d+)\/introduce$/.exec(path);
  if (introduce) return introduceFriends(request, env, url, Number(introduce[1]));
  const dismiss = /^\/introductions\/(\d+)\/dismiss$/.exec(path);
  if (request.method === "POST" && dismiss) {
    await db.prepare("DELETE FROM introductions WHERE id = ?").bind(Number(dismiss[1])).run();
    return Response.redirect(`${url.origin}${url.searchParams.get("back") === "home" ? "/" : "/friend"}`, 303);
  }
  // Which person in the owner's Facebook download a friend is (a form from Friends); kept by name.
  const facebook = /^\/(\d+)\/facebook$/.exec(path);
  if (request.method === "POST" && facebook) {
    const id = Number(facebook[1]);
    const form = await request.formData().catch(() => new FormData());
    if (await db.prepare("SELECT 1 FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL").bind(id).first()) {
      if (form.get("unlink")) {
        await db.prepare("DELETE FROM friend_links WHERE connection_id = ?").bind(id).run();
      } else {
        // "none" means the suggestion wasn't them; otherwise the name must be someone in the download.
        const person = form.get("none") ? { name: null }
          : await db.prepare("SELECT name FROM people WHERE is_me = 0 AND name = ? COLLATE NOCASE LIMIT 1").bind(String(form.get("name") ?? "").trim()).first();
        if (person) {
          await db.prepare("INSERT OR REPLACE INTO friend_links (connection_id, person_name, created_at) VALUES (?, ?, ?)")
            .bind(id, person.name, now()).run();
        }
      }
    }
    return Response.redirect(`${url.origin}/friend`, 303);
  }
  const disconnect = /^\/(\d+)\/disconnect$/.exec(path);
  if (request.method === "POST" && disconnect) {
    const connection = await db.prepare("SELECT * FROM connections WHERE id = ?").bind(Number(disconnect[1])).first();
    if (connection) {
      // Tell them, if they can be reached; either way this side forgets them.
      await callSite(connection.origin, "/_peer/disconnect", { key: connection.their_key, body: {} }).catch(() => {});
      // The owner's copies of what they said on that site (comments_elsewhere) stay: they're theirs.
      await db.batch([
        db.prepare("DELETE FROM connections WHERE id = ?").bind(connection.id),
        db.prepare("DELETE FROM friend_links WHERE connection_id = ?").bind(connection.id),
        db.prepare("DELETE FROM introductions WHERE connection_id = ? OR origin = ?").bind(connection.id, connection.origin),
        // Someone the owner removed can't ask again without a link (the owner still can).
        db.prepare("INSERT OR REPLACE INTO declined_asks (origin, declined_at) VALUES (?, ?)").bind(connection.origin, now()),
      ]);
    }
    // From a form (Remove friend on their page, or on Friends), back to Friends; from this site's script, JSON.
    const form = /form/.test(request.headers.get("Content-Type") ?? "");
    return form ? Response.redirect(`${url.origin}/friend`, 303) : json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}

function parseLink(link, url, env) {
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    return { error: "That isn't a friend link. It should look like https://…/_connect/…" };
  }
  const origin = siteOrigin(parsed.origin, env);
  const match = LINK_RE.exec(parsed.pathname);
  if (!origin || !match) return { error: "That isn't a friend link. It should look like https://…/_connect/…" };
  if (origin === url.origin) return { error: "That's a link to your own site. Send it to a friend instead." };
  return { origin, token: match[1] };
}

// The friend's side of the handshake: run on their site when they confirm.
async function connect(env, url, target) {
  if (target.error) return json({ error: target.error }, 400);
  const done = await handshake(env, url, target.origin, `/_connect/${target.token}/accept`);
  return done.error ? json({ error: done.error }, done.status) : json({ ok: true, name: done.name });
}

/**
 * Asks the site at `origin` to be friends, at `path` there (a link's accept, or /_connect/ask with `extra`): keeps a
 * key for it to call this site with, sends it, and keeps the key it answers with. Returns { name } or { error, status }.
 */
async function handshake(env, url, origin, path, extra = {}) {
  const db = env.DB;
  const existing = await db.prepare("SELECT * FROM connections WHERE origin = ?").bind(origin).first();
  if (existing?.connected_at) return { error: `You're already connected with ${existing.name}.`, status: 409 };
  const key = randomToken();
  await db.batch([
    db.prepare("DELETE FROM connections WHERE origin = ? OR (connected_at IS NULL AND created_at < ?)").bind(origin, now() - PENDING_SECONDS),
    db.prepare("INSERT INTO connections (origin, name, key_hash, created_at) VALUES (?, ?, ?, ?)").bind(origin, "A friend", await sha256(key), now()),
  ]);
  try {
    // Long enough for their site to call this one back (see accept) before answering.
    const reply = await callSite(origin, path, { body: { origin: url.origin, key, ...extra }, timeout: 25_000 });
    if (!KEY_RE.test(reply.key ?? "")) throw new Error("Their site sent something unexpected.");
    const name = cleanName(reply.name);
    // This side asked, so it's approved here; theirs waits for their owner.
    await db.batch([
      db.prepare("UPDATE connections SET name = ?, their_key = ?, connected_at = ?, approved_at = ? WHERE origin = ?")
        .bind(name, reply.key, now(), now(), origin),
      db.prepare("DELETE FROM declined_asks WHERE origin = ?").bind(origin),
    ]);
    return { name };
  } catch (error) {
    await db.prepare("DELETE FROM connections WHERE origin = ? AND connected_at IS NULL").bind(origin).run();
    return { error: error.message, status: 400, gone: error.status === 404 };
  }
}

/** Approves someone's request: they're friends now. */
async function approve(db, connection) {
  await db.batch([
    db.prepare("UPDATE connections SET approved_at = ? WHERE id = ?").bind(now(), connection.id),
    db.prepare("DELETE FROM introductions WHERE origin = ?").bind(connection.origin),
    db.prepare("DELETE FROM declined_asks WHERE origin = ?").bind(connection.origin),
    ...(connection.invited_as ? [db.prepare("INSERT OR REPLACE INTO friend_links (connection_id, person_name, created_at) VALUES (?, ?, ?)")
      .bind(connection.id, connection.invited_as, now())] : []),
  ]);
}

/** The owner asks someone to be friends without a link (a form: origin, group or introduction, back). */
async function askFrom(env, url, form) {
  const db = env.DB;
  const back = safeNext(String(form.get("back") ?? "/friend"), url);
  const origin = siteOrigin(form.get("origin"), env);
  const fail = (message) => html(messagePage(message, { href: back, label: "Go back" }), 400);
  if (!origin || origin === url.origin) return fail("That isn't someone to ask.");
  // If they've already asked, asking back is saying yes (but a request from an invite is decided on Friends, which
  // warns if the name isn't the one invited).
  const theirs = await db.prepare("SELECT * FROM connections WHERE origin = ? AND connected_at IS NOT NULL").bind(origin).first();
  if (theirs?.invited_as && !theirs.approved_at) return Response.redirect(`${url.origin}/friend`, 303);
  if (theirs && !theirs.approved_at) await approve(db, theirs);
  if (theirs) return Response.redirect(`${url.origin}${back}`, 303);
  let via;
  let name = host(origin);
  if (form.get("group")) {
    const group = await db.prepare("SELECT origin, remote_id FROM groups WHERE id = ? AND joined_at IS NOT NULL").bind(Number(form.get("group"))).first();
    if (!group) return fail("That group isn't here any more.");
    via = { group: group.origin, id: group.remote_id };
  } else {
    const made = await liveIntroduction(db, origin);
    if (!made) return fail("That introduction isn't here any more.");
    via = { introduction: true };
    name = made.name;
  }
  const done = await handshake(env, url, origin, "/_connect/ask", { via });
  if (done.error) {
    return fail(done.gone ? `${name}'s site needs a newer afterwrd before you can ask this way. Send them a friend link instead.`
      : `Couldn't ask ${name}: ${done.error}`);
  }
  // Asking someone answers any introduction to them (and, in handshake, takes back having turned them down).
  await db.prepare("DELETE FROM introductions WHERE origin = ?").bind(origin).run();
  return Response.redirect(`${url.origin}${back}`, 303);
}

/** Introducing friend `id` to another friend (`to`), with a note: GET shows the choice, POST tells both their sites. */
async function introduceFriends(request, env, url, id) {
  const db = env.DB;
  // Friends both ways: their sites have answered this one, so they've approved the owner here too.
  const { results: friends } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
    AND reached_at IS NOT NULL ORDER BY name COLLATE NOCASE`).all();
  const friend = friends.find((c) => c.id === id);
  if (!friend) return html(connectionsMessage("You can introduce friends once you've seen their posts here (they've approved you too)."), 404);
  const others = friends.filter((c) => c.id !== id);
  if (request.method === "GET") return html(introducePage(friend, others));
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const form = await request.formData().catch(() => new FormData());
  const other = others.find((c) => c.id === Number(form.get("to")));
  if (!other) return html(connectionsMessage("Choose who to introduce them to."), 400);
  const note = String(form.get("note") ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTE);
  const tell = (to, about) => callSite(to.origin, "/_peer/introduce", { key: to.their_key,
    body: { type: "Introduce", origin: about.origin, name: about.name, ...(note && { content: note }) } });
  const told = await Promise.allSettled([tell(friend, other), tell(other, friend)]);
  const trouble = told.map((t, i) => t.status === "rejected" && `${[friend, other][i].name}'s site: ${t.reason.status === 404
    ? "it needs a newer afterwrd first" : t.reason.message}`).filter(Boolean);
  return html(introducedPage(friend, other, trouble), trouble.length === 2 ? 400 : 200);
}
// --- pages -------------------------------------------------------------------------------------------------------

function shell(title, body, script = "") {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
</head>
<body>
${ownerHeader("connections")}
<main class="connections">
${body}
</main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

const day = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const POST_SCRIPT = `
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const error = document.getElementById("error");`;

function connectionsPage(connections, unchecked = false) {
  return shell("Add a friend", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Add a friend</h1>
<p class="meta">Send a friend link to someone, whether or not they have an afterwrd site yet: if they haven't, it shows
them how to set one up first. Once you're friends, you'll each see the other's new posts on <a href="/">Home</a>, and
can read each other's posts and photos (everything you've published) on your own site. Your comments are kept on
their site. Removing a friend ends all of it at once.</p>
${unchecked ? `<p class="meta" id="unchecked">Your site hasn't been checked yet. Once a friend with afterwrd is here, it's worth
<a href="/_admin/update#check">asking them to check it</a>, before you invite many others.</p>` : ""}

<div class="actions-row">
  <button class="chip primary" id="make">Make a friend link</button>
</div>
<p id="error" role="alert"></p>
<section class="card" id="link" hidden>
  <strong>Send this to your friend</strong>
  <p class="meta">However you usually would. The link works once, for 30 days; when they use it, you'll be asked to
  approve on Home.</p>
  <textarea id="link-message" readonly rows="5" aria-label="Message with a friend link"></textarea>
  <input id="link-url" readonly aria-label="Friend link" hidden>
  <button class="chip primary" id="copy">Copy message</button>
  <button class="chip" id="share" hidden>Share…</button>
</section>

<form class="filters" id="paste" action="/_admin/connections/new" method="get">
  <input type="search" name="link" placeholder="Got a friend link? Paste it here" required autocomplete="off">
  <button>Add friend</button>
</form>

${connections.length ? `<table class="numbers">
  <thead><tr><th>Friend</th><th>Site</th><th>Since</th><th></th></tr></thead>
  <tbody>${connections.map((c) => `<tr>
    <th><a href="/friend/${c.id}/posts">${escape(c.name)}</a></th>
    <td><a href="${escape(c.origin)}" target="_blank" rel="noopener noreferrer">${escape(host(c.origin))}</a></td>
    <td>${day(c.connected_at)}</td>
    <td><button class="chip" data-disconnect="${c.id}" data-name="${escape(c.name)}">Remove friend</button></td>
  </tr>`).join("")}</tbody>
</table>` : `<p class="empty">You're not connected with anyone yet.</p>`}`, `${POST_SCRIPT}
  const panel = document.getElementById("link");
  const linkUrl = document.getElementById("link-url");
  document.getElementById("make").addEventListener("click", async () => {
    try {
      const made = await post("/_admin/connections/link");
      linkUrl.value = made.link;
      document.getElementById("link-message").value = made.message;
      panel.hidden = false;
      document.getElementById("link-message").select();
    } catch (err) { error.textContent = err.message; }
  });
  document.getElementById("copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(document.getElementById("link-message").value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy message"; }, 1500);
  });
  const share = document.getElementById("share");
  if (navigator.share) {
    share.hidden = false;
    share.addEventListener("click", () => navigator.share({ text: document.getElementById("link-message").value }).catch(() => {}));
  }
  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-disconnect]");
    if (!button || !confirm("Remove " + button.dataset.name + " as a friend? You'll stop seeing each other's posts and photos. Comments already made stay where they are.")) return;
    try {
      await post("/_admin/connections/" + button.dataset.disconnect + "/disconnect");
      location.reload();
    } catch (err) { error.textContent = err.message; }
  });`);
}

function confirmPage(name, origin) {
  return shell("Connect", `
<p class="crumbs"><a href="/_admin/connections">Add a friend</a> /</p>
<h1>Add ${escape(name)} as a friend?</h1>
<p>Their site is <strong>${escape(host(origin))}</strong>. Once they approve, you're friends: you'll each see the other's
posts and photos on your own site, and can comment on them. Either of you can remove the other at any time, which ends all of it.</p>
<p id="error" role="alert"></p>
<div class="actions-row">
  <button class="chip primary" id="go">Add friend</button>
  <a class="chip" href="/_admin/connections">Not now</a>
</div>`, `${POST_SCRIPT}
  document.getElementById("go").addEventListener("click", async (e) => {
    e.target.disabled = true;
    error.textContent = "";
    try {
      await post(location.pathname + location.search);
      location.assign("/");
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });`);
}

function introducePage(friend, others) {
  return shell("Introduce", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Introduce ${escape(friend.name)}</h1>
${others.length ? `<p class="meta">Choose a friend who'd like to know ${escape(friend.name)}. Both of them are told who you
introduced them to, and that it was you, and either can then ask the other to be friends. Nobody else is told anything.</p>
<form class="stack" method="post">
  <label>Introduce them to <select name="to" required>${others.map((c) => `<option value="${c.id}">${escape(c.name)}</option>`).join("")}</select></label>
  <textarea name="note" rows="2" maxlength="${MAX_NOTE}" placeholder="Why they'd get on (optional)" aria-label="A note for both of them"></textarea>
  <div class="actions-row"><button class="chip primary" id="introduce">Introduce them</button><a class="chip" href="/friend">Not now</a></div>
</form>` : `<p>You'll need at least one other friend on afterwrd to introduce ${escape(friend.name)} to.</p>`}`);
}

function introducedPage(friend, other, trouble) {
  const both = `${escape(friend.name)} and ${escape(other.name)}`;
  return shell("Introduce", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>${trouble.length === 2 ? "Couldn't introduce them" : `Introduced ${both}`}</h1>
${trouble.length ? `<p>Couldn't reach ${trouble.map(escape).join("; ")}.</p>` : ""}
<p class="meta">${trouble.length === 2 ? "Try again later." : trouble.length
  ? "The other one has been told, and can ask to be friends."
  : "Each has been told about the other. It's up to them now."}</p>
<p><a class="chip" href="/friend">Back to Friends</a></p>`);
}

function connectionsMessage(message) {
  return shell("Connect", `
<p class="crumbs"><a href="/_admin/connections">Add a friend</a> /</p>
<h1>Couldn't connect</h1>
<p>${escape(message)}</p>`);
}
