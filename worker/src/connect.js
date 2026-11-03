// Connecting with a friend's afterwrd site. The owner makes a one-time Connect link on /_admin/connections and
// sends it to a friend, who opens it, says where their own site is, and confirms there. Their site then:
//   1. keeps a new key for this site to call it with, and sends it to POST /_connect/<token>/accept here;
//   2. this site proves the key is theirs, and meant for this site, by calling their /_peer/hello?from=<this site>
//      with it; then keeps it and answers with a key for them to call this site with.
// Connections are mutual: both owners read each other's posts and photos from their own sites, in Feed and on friend
// pages, and can comment on them (peers.js, friends.js). A link only asks: the site that made it shares nothing
// until its owner approves the request on Friends, so a link passed on to someone else gets them nowhere.
// Links made with "Invite to afterwrd" on Friends (POST …/invite) are for one person in the Facebook download, last
// 30 days, and link the new friend to that person when approved.
//
// Without a session:   GET /_connect/<token>  (the page the link opens), GET …/info, POST …/accept
// The owner's:         GET /_admin/connections, POST …/link, GET|POST …/new?link=, POST …/<id>/disconnect,
//                      POST …/<id>/facebook (name, or none=1): which person in the Facebook download they are
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { connectLinkPage, messagePage } from "./pages.js";
import { callSite, host, KEY_RE, ownerName, siteOrigin } from "./peers.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

const LINK_SECONDS = 7 * 24 * 3600;
const INVITE_SECONDS = 30 * 24 * 3600; // setting up can take a while, waiting for Facebook's download
const PENDING_SECONDS = 600; // a connection half made is given up after this
const LINK_RE = /^\/_connect\/([\w-]{40,100})$/;

const cleanName = (name) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : "A friend");

async function openLink(db, token) {
  return db.prepare("SELECT * FROM connect_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(token), now()).first();
}

// --- the link, opened by a friend (no session) ---------------------------------------------------------------

export async function handleConnectLink(request, env, url) {
  const match = /^\/_connect\/([\w-]{40,100})(\/info|\/accept)?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, token, action] = match;
  const db = env.DB;
  if (!(await openLink(db, token))) {
    const message = "This Connect link has expired or has already been used. Ask your friend for a new one.";
    return action ? json({ error: message }, 404) : html(messagePage(message, { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
  }
  if (request.method === "GET" && !action) return html(connectLinkPage(await ownerName(db)));
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
  if (!link || !spent.meta.changes) return json({ error: "This Connect link has already been used." }, 404);

  // Connected, but waiting for this site's owner to approve (approved_at): nothing is shared until then.
  const key = randomToken();
  await db.batch([
    db.prepare("DELETE FROM connections WHERE origin = ?").bind(origin),
    db.prepare(`INSERT INTO connections (origin, name, their_key, key_hash, created_at, connected_at, invited_as)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(origin, cleanName(them.name), body.key, await sha256(key), now(), now(), link.person_name ?? null),
  ]);
  return json({ name: await ownerName(db), key });
}

// --- the owner's side ---------------------------------------------------------------------------------------------

export async function handleConnections(request, env, url) {
  const db = env.DB;
  const path = url.pathname.slice("/_admin/connections".length);
  if (request.method === "GET" && path === "") {
    const { results } = await db.prepare(`SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY name COLLATE NOCASE`).all();
    return html(connectionsPage(results));
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
    return json({ link: `${url.origin}/_connect/${token}` });
  }
  // An invitation for someone in the Facebook download: a Connect link for them alone, and a message to send.
  if (request.method === "POST" && path === "/invite") {
    const body = await request.json().catch(() => ({}));
    const person = await db.prepare("SELECT name FROM people WHERE is_me = 0 AND name = ? COLLATE NOCASE LIMIT 1")
      .bind(String(body.name ?? "").trim()).first();
    if (!person) return json({ error: "That name isn't in your Facebook download." }, 404);
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM connect_links WHERE (person_name = ? AND used_at IS NULL) OR expires_at < ?").bind(person.name, now()),
      db.prepare("INSERT INTO connect_links (token_hash, expires_at, person_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(token), now() + INVITE_SECONDS, person.name, now()),
    ]);
    const link = `${url.origin}/_connect/${token}`;
    const first = person.name.split(" ")[0];
    const message = `Hi ${first}, I've moved my posts and photos to afterwrd, a small private social network that `
      + `each of us runs for ourselves, free. Set yours up at https://afterwrd.app, then open this link to connect with me: ${link}`;
    return json({ name: person.name, link, message });
  }
  // Someone used a Connect link: approve (share, and link them to who the invite was for) or decline (forget them).
  const decide = /^\/(\d+)\/(approve|decline)$/.exec(path);
  if (request.method === "POST" && decide) {
    const connection = await db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NULL")
      .bind(Number(decide[1])).first();
    if (connection && decide[2] === "approve") {
      await db.batch([
        db.prepare("UPDATE connections SET approved_at = ? WHERE id = ?").bind(now(), connection.id),
        ...(connection.invited_as ? [db.prepare("INSERT OR REPLACE INTO friend_links (connection_id, person_name, created_at) VALUES (?, ?, ?)")
          .bind(connection.id, connection.invited_as, now())] : []),
      ]);
    } else if (connection) {
      await callSite(connection.origin, "/_peer/disconnect", { key: connection.their_key, body: {} }).catch(() => {});
      await db.prepare("DELETE FROM connections WHERE id = ?").bind(connection.id).run();
    }
    return Response.redirect(`${url.origin}/friend`, 303);
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
      ]);
    }
    return json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}

function parseLink(link, url, env) {
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    return { error: "That isn't a Connect link. It should look like https://…/_connect/…" };
  }
  const origin = siteOrigin(parsed.origin, env);
  const match = LINK_RE.exec(parsed.pathname);
  if (!origin || !match) return { error: "That isn't a Connect link. It should look like https://…/_connect/…" };
  if (origin === url.origin) return { error: "That's a link to your own site. Send it to a friend instead." };
  return { origin, token: match[1] };
}

// The friend's side of the handshake: run on their site when they confirm.
async function connect(env, url, target) {
  if (target.error) return json({ error: target.error }, 400);
  const db = env.DB;
  const existing = await db.prepare("SELECT * FROM connections WHERE origin = ?").bind(target.origin).first();
  if (existing?.connected_at) return json({ error: `You're already connected with ${existing.name}.` }, 409);
  const key = randomToken();
  await db.batch([
    db.prepare("DELETE FROM connections WHERE origin = ? OR (connected_at IS NULL AND created_at < ?)")
      .bind(target.origin, now() - PENDING_SECONDS),
    db.prepare("INSERT INTO connections (origin, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(target.origin, "A friend", await sha256(key), now()),
  ]);
  try {
    // Long enough for their site to call this one back (see accept) before answering.
    const reply = await callSite(target.origin, `/_connect/${target.token}/accept`, { body: { origin: url.origin, key }, timeout: 25_000 });
    if (!KEY_RE.test(reply.key ?? "")) throw new Error("Their site sent something unexpected.");
    const name = cleanName(reply.name);
    // This side asked, so it's approved here; theirs waits for their owner.
    await db.prepare("UPDATE connections SET name = ?, their_key = ?, connected_at = ?, approved_at = ? WHERE origin = ?")
      .bind(name, reply.key, now(), now(), target.origin).run();
    return json({ ok: true, name });
  } catch (error) {
    await db.prepare("DELETE FROM connections WHERE origin = ? AND connected_at IS NULL").bind(target.origin).run();
    return json({ error: error.message }, 400);
  }
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

function connectionsPage(connections) {
  return shell("Connections", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Connected sites</h1>
<p class="meta">Connect with friends who have their own afterwrd site, and you become friends: you'll each see the
other's new posts in <a href="/feed">Feed</a>, and can read each other's posts and photos (everything you've published)
on your own site: press their name. Your comments are kept on their site, as part of their archive. Disconnecting
ends all of it at once.</p>

<div class="actions-row">
  <button class="chip primary" id="make">Make a Connect link</button>
</div>
<p id="error" role="alert"></p>
<section class="card" id="link" hidden>
  <strong>Send this to a friend who has an afterwrd site</strong>
  <p class="meta">It works once, for 7 days. They open it, say where their site is, and confirm.</p>
  <input id="link-url" readonly aria-label="Connect link">
  <button class="chip primary" id="copy">Copy link</button>
  <button class="chip" id="share" hidden>Share…</button>
</section>

<form class="filters" id="paste" action="/_admin/connections/new" method="get">
  <input type="search" name="link" placeholder="Got a Connect link from a friend? Paste it here" required autocomplete="off">
  <button>Connect</button>
</form>

${connections.length ? `<table class="numbers">
  <thead><tr><th>Friend</th><th>Site</th><th>Since</th><th></th></tr></thead>
  <tbody>${connections.map((c) => `<tr>
    <th><a href="/friend/${c.id}/posts">${escape(c.name)}</a></th>
    <td><a href="${escape(c.origin)}" target="_blank" rel="noopener noreferrer">${escape(host(c.origin))}</a></td>
    <td>${day(c.connected_at)}</td>
    <td><button class="chip" data-disconnect="${c.id}" data-name="${escape(c.name)}">Disconnect</button></td>
  </tr>`).join("")}</tbody>
</table>` : `<p class="empty">You're not connected with anyone yet.</p>`}`, `${POST_SCRIPT}
  const panel = document.getElementById("link");
  const linkUrl = document.getElementById("link-url");
  document.getElementById("make").addEventListener("click", async () => {
    try {
      linkUrl.value = (await post("/_admin/connections/link")).link;
      panel.hidden = false;
      linkUrl.select();
    } catch (err) { error.textContent = err.message; }
  });
  document.getElementById("copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(linkUrl.value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy link"; }, 1500);
  });
  const share = document.getElementById("share");
  if (navigator.share) {
    share.hidden = false;
    share.addEventListener("click", () => navigator.share({ title: "Connect on afterwrd", url: linkUrl.value }).catch(() => {}));
  }
  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-disconnect]");
    if (!button || !confirm("Disconnect from " + button.dataset.name + "? You'll stop seeing each other's posts. Comments already made stay where they are.")) return;
    try {
      await post("/_admin/connections/" + button.dataset.disconnect + "/disconnect");
      location.reload();
    } catch (err) { error.textContent = err.message; }
  });`);
}

function confirmPage(name, origin) {
  return shell("Connect", `
<p class="crumbs"><a href="/_admin/connections">Connections</a> /</p>
<h1>Connect with ${escape(name)}?</h1>
<p>Their site is <strong>${escape(host(origin))}</strong>. Once connected you're friends: you'll each see the other's
posts and photos on your own site, and can comment on them. Either of you can disconnect at any time, which ends all of it.</p>
<p id="error" role="alert"></p>
<div class="actions-row">
  <button class="chip primary" id="go">Connect</button>
  <a class="chip" href="/_admin/connections">Not now</a>
</div>`, `${POST_SCRIPT}
  document.getElementById("go").addEventListener("click", async (e) => {
    e.target.disabled = true;
    error.textContent = "";
    try {
      await post(location.pathname + location.search);
      location.assign("/feed");
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });`);
}

function connectionsMessage(message) {
  return shell("Connect", `
<p class="crumbs"><a href="/_admin/connections">Connections</a> /</p>
<h1>Couldn't connect</h1>
<p>${escape(message)}</p>`);
}
