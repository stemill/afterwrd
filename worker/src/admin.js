// The owner's area (/_admin): Your devices is here (passkeys for the owner's phones and computers, links to add
// another, signing out everywhere), and every other owner page is routed from here. Only the owner signs in, so
// no one else needs a way in: friends see each other from their own sites (connect.js).
// scripts/owner.mjs makes the first device link for a new site from the terminal.
import { handleConnections } from "./connect.js";
import { handleExport } from "./export.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { handleImport } from "./importer.js";
import { handlePhotos } from "./photos.js";
import { handlePosts } from "./posts.js";
import { handleUpdate } from "./update.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

// A device link grants owner access to whoever opens it, so it's short-lived.
export const DEVICE_LINK_SECONDS = 3600;

export async function handleAdmin(request, env, url, owner) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Request from another site" }, 403);
  }
  if (url.pathname === "/_admin/import" || url.pathname.startsWith("/_admin/import/")) {
    return handleImport(request, env, url, owner);
  }
  if (url.pathname === "/_admin/update" || url.pathname.startsWith("/_admin/update/")) {
    return handleUpdate(request, env, url, owner);
  }
  if (url.pathname === "/_admin/posts" || url.pathname.startsWith("/_admin/posts/")) return handlePosts(request, env, url);
  if (/^\/_admin\/(photos|albums|profile)(\/|$)/.test(url.pathname)) return handlePhotos(request, env, url);
  if (url.pathname === "/_admin/export" || url.pathname.startsWith("/_admin/export/")) return handleExport(request, env, url);
  if (url.pathname === "/_admin/connections" || url.pathname.startsWith("/_admin/connections/")) {
    return handleConnections(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/_admin") {
    const [{ results: passkeys }, links, sessions] = await env.DB.batch([
      env.DB.prepare("SELECT id, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY created_at").bind(owner.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM device_links WHERE user_id = ? AND used_at IS NULL AND expires_at > ?").bind(owner.id, now()),
      env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(owner.id, now()),
    ]);
    return html(devicesPage(owner, passkeys, links.results[0].n, sessions.results[0].n));
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  const action = /^\/_admin\/devices\/(link|cancel-links|sign-out|delete-passkey|seen)$/.exec(url.pathname)?.[1];
  switch (action) {
    case "seen": {
      // "That was me" on Home's new-device notice. Only a device whose own passkey isn't new can say so, so an
      // intruder can't hide their passkey's notice, even by adding a second one and confirming from the first.
      if (!(await newDevices(env.DB, owner)).canConfirm) return json({ error: "Confirm this from one of your older devices." }, 403);
      const seen = await env.DB.prepare("SELECT MAX(created_at) AS at FROM credentials WHERE user_id = ?").bind(owner.id).first();
      if (seen?.at) {
        await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('devices_seen', ?1)
          ON CONFLICT (key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), ?1)`).bind(seen.at).run();
      }
      return Response.redirect(`${url.origin}/`, 303);
    }
    case "link":
      return json({ link: await createDeviceLink(env, url, owner.id) });
    case "cancel-links":
      await env.DB.prepare("DELETE FROM device_links WHERE user_id = ? AND used_at IS NULL").bind(owner.id).run();
      return json({ ok: true });
    case "sign-out":
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id).run();
      return json({ ok: true });
    case "delete-passkey": {
      const { results: keys } = await env.DB.prepare("SELECT id FROM credentials WHERE user_id = ?").bind(owner.id).all();
      if (!keys.some((k) => k.id === body.credential)) return json({ error: "That isn't one of your passkeys." }, 404);
      if (keys.length === 1) return json({ error: "That's your only passkey; add another device first, or you'd be locked out." }, 400);
      // Sign out the device it's on too. Sessions from before 0.15.0 don't say which passkey began them, so they go as well.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?").bind(body.credential, owner.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND (credential_id = ? OR credential_id IS NULL)").bind(owner.id, body.credential),
      ]);
      return json({ ok: true });
    }
  }
  return new Response("Not found", { status: 404 });
}

// How long Home mentions a newly added device, unless the owner says it was them sooner.
const NEW_DEVICE_SECONDS = 14 * 86400;

// A passkey is "new" while all of these hold: it was added in the last 14 days, it isn't the first one (made when
// the site was set up), and the owner hasn't since said it was them (settings 'devices_seen').
const IS_NEW = `created_at > ?2
  AND created_at > (SELECT MIN(created_at) FROM credentials WHERE user_id = ?1)
  AND created_at > COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'devices_seen'), 0)`;

/**
 * For a notice on Home ("A new device was added… Not you? Remove it."): someone who got in would add their own
 * passkey to stay in, and this makes that visible. `devices`: the new passkeys other than the one this device signed
 * in with. `canConfirm`: whether this device may say they were all the owner's, which needs its own passkey not to be
 * new (otherwise a new passkey could vouch for itself or for another the same person added).
 */
export async function newDevices(db, owner) {
  const since = now() - NEW_DEVICE_SECONDS;
  const [{ results: devices }, { results: own }] = await db.batch([
    db.prepare(`SELECT id, created_at FROM credentials WHERE user_id = ?1 AND ${IS_NEW} AND id IS NOT ?3 ORDER BY created_at`)
      .bind(owner.id, since, owner.session_credential ?? null),
    db.prepare(`SELECT ${IS_NEW} AS new FROM credentials WHERE user_id = ?1 AND id = ?3`)
      .bind(owner.id, since, owner.session_credential ?? null),
  ]);
  return { devices, canConfirm: own.length === 1 && !own[0].new };
}

// Only a hash is stored, so the link can be shown once and never again.
export async function createDeviceLink(env, url, userId, seconds = DEVICE_LINK_SECONDS) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO device_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now() + seconds).run();
  return `${url.origin}/_auth/device/${token}`;
}

function day(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

function devicesPage(owner, passkeys, openLinks, sessions) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your devices · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
<style>
  .devices { list-style: none; margin: 0 0 1.25rem; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .devices li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .devices strong { font-family: var(--round); }
  #link { display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; margin: 0 0 1.25rem; }
  #link[hidden] { display: none; }
  #link input { width: 100%; font: inherit; font-size: 0.9rem; padding: 0.55rem 0.95rem; border: 1px solid var(--border); border-radius: 999px; background: var(--sunken); color: var(--text); }
  #link p { margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.25rem; }
  #error { color: var(--danger); font-weight: 700; }
  #error:empty { display: none; }
</style>
</head>
<body>
${ownerHeader("devices")}
<main>
<h1>Your devices</h1>
<p class="meta">Signed in as ${escape(owner.name)}. Each phone or computer you use has its own passkey. To add one, make a
link here and open it on that device: it works once, for an hour, and gives owner access, so open it only on your own.</p>
<p id="error" role="alert"></p>
<div class="row"><button class="chip primary" id="new-link">Add a device</button></div>
<section class="card" id="link" hidden>
  <strong>Open this on your other device</strong>
  <input id="link-url" readonly aria-label="Link to add a device">
  <div class="row"><button class="chip primary" id="copy">Copy link</button><button class="chip" id="share" hidden>Share…</button></div>
</section>
<ul class="devices">
  ${passkeys.map((k, i) => `<li class="card"><span><strong>Passkey ${i + 1}</strong><span class="meta"> · added ${day(k.created_at)}${k.last_used_at ? `, last used ${day(k.last_used_at)}` : ""}</span></span>
    <button class="chip danger" data-action="delete-passkey" data-credential="${escape(k.id)}" ${passkeys.length === 1 ? 'disabled title="Your only passkey"' : ""}>Remove</button></li>`).join("")}
</ul>
<div class="row">
  ${openLinks ? `<button class="chip" data-action="cancel-links">Cancel ${openLinks} unused link${openLinks === 1 ? "" : "s"}</button>` : ""}
  ${sessions ? '<button class="chip" data-action="sign-out">Sign out everywhere</button>' : ""}
</div>
</main>
<script>
  const error = document.getElementById("error");
  const linkUrl = document.getElementById("link-url");
  async function post(path, body) {
    error.textContent = "";
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  document.getElementById("new-link").addEventListener("click", async () => {
    try {
      linkUrl.value = (await post("/_admin/devices/link")).link;
      document.getElementById("link").hidden = false;
      linkUrl.select();
    } catch (err) { error.textContent = err.message; }
  });
  const confirmations = {
    "delete-passkey": "Remove this passkey? The device it's on will be signed out and won't be able to sign in again.",
    "sign-out": "Sign out on every device, this one included? You can sign straight back in with a passkey.",
  };
  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button || (confirmations[button.dataset.action] && !confirm(confirmations[button.dataset.action]))) return;
    try {
      await post("/_admin/devices/" + button.dataset.action, { credential: button.dataset.credential });
      location.assign(button.dataset.action === "sign-out" ? "/_auth/login" : "/_admin");
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
    share.addEventListener("click", () => navigator.share({ title: "Add a device to afterwrd", url: linkUrl.value }).catch(() => {}));
  }
</script>
</body>
</html>`;
}
