// The owner's area (/_admin): Your devices is here (passkeys for the owner's phones and computers, links to add
// another, signing out everywhere), and every other owner page is routed from here. Only the owner signs in, so
// there's no one else to invite: friends see each other from their own sites (connect.js).
// scripts/invite.mjs makes the first device link for a new site from the terminal.
import { handleConnections } from "./connect.js";
import { handleExport } from "./export.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { handleImport } from "./importer.js";
import { handlePhotos } from "./photos.js";
import { handlePosts } from "./posts.js";
import { handleUpdate } from "./update.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

// A device link grants owner access to whoever opens it, so it's short-lived.
export const OWNER_INVITE_SECONDS = 3600;

export async function handleAdmin(request, env, url, owner, work) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Request from another site" }, 403);
  }
  if (url.pathname === "/_admin/import" || url.pathname.startsWith("/_admin/import/")) {
    return handleImport(request, env, url, owner);
  }
  if (url.pathname === "/_admin/update" || url.pathname.startsWith("/_admin/update/")) {
    return handleUpdate(request, env, url, owner);
  }
  if (url.pathname === "/_admin/posts" || url.pathname.startsWith("/_admin/posts/")) return handlePosts(request, env, url, work);
  if (/^\/_admin\/(photos|albums|profile)(\/|$)/.test(url.pathname)) return handlePhotos(request, env, url, work);
  if (url.pathname === "/_admin/export" || url.pathname.startsWith("/_admin/export/")) return handleExport(request, env, url);
  if (url.pathname === "/_admin/connections" || url.pathname.startsWith("/_admin/connections/")) {
    return handleConnections(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/_admin") {
    const [{ results: passkeys }, links, sessions] = await env.DB.batch([
      env.DB.prepare("SELECT id, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY created_at").bind(owner.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ?").bind(owner.id, now()),
      env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(owner.id, now()),
    ]);
    return html(devicesPage(owner, passkeys, links.results[0].n, sessions.results[0].n));
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  const action = /^\/_admin\/devices\/(link|cancel-links|sign-out|delete-passkey)$/.exec(url.pathname)?.[1];
  switch (action) {
    case "link":
      return json({ link: await createInvite(env, url, owner.id) });
    case "cancel-links":
      await env.DB.prepare("DELETE FROM invites WHERE user_id = ? AND used_at IS NULL").bind(owner.id).run();
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

// Only a hash is stored, so the link can be shown once and never again.
export async function createInvite(env, url, userId, seconds = OWNER_INVITE_SECONDS) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now() + seconds).run();
  return `${url.origin}/_auth/invite/${token}`;
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
${ownerHeader("people")}
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
