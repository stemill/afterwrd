// The owner's page for managing who can see the archive: invite someone, send a fresh link, revoke access.
// Same rules as scripts/invite.mjs, which is still needed to invite the owner on a brand-new site.
import { handleImport } from "./importer.js";
import { escape, html, json, now, randomToken, sha256 } from "./util.js";

const INVITE_SECONDS = 7 * 24 * 3600;

export async function handleAdmin(request, env, url, owner) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Request from another site" }, 403);
  }
  if (url.pathname === "/_admin/import" || url.pathname.startsWith("/_admin/import/")) {
    return handleImport(request, env, url, owner);
  }
  if (request.method === "GET" && url.pathname === "/_admin") return html(adminPage(await people(env), owner));
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (url.pathname === "/_admin/invite") {
    const name = String(body.name ?? "").trim().slice(0, 100);
    if (!name) return json({ error: "Give their name." }, 400);
    const existing = await env.DB.prepare("SELECT 1 FROM users WHERE name = ? COLLATE NOCASE AND revoked_at IS NULL")
      .bind(name).first();
    if (existing && !body.sameNameOk) {
      return json({ error: `${name} already has access. To add a device, use New link on their row.`, sameName: true }, 409);
    }
    const user = await env.DB.prepare("INSERT INTO users (name, created_at) VALUES (?, ?) RETURNING id")
      .bind(name, now()).first();
    return json({ name, link: await createInvite(env, url, user.id) });
  }

  const match = /^\/_admin\/people\/(\d+)\/(invite|revoke)$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const person = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND revoked_at IS NULL")
    .bind(Number(match[1])).first();
  if (!person) return json({ error: "No one with access has that number." }, 404);

  if (match[2] === "invite") return json({ name: person.name, link: await createInvite(env, url, person.id) });
  if (person.is_owner) return json({ error: "You can't revoke the owner." }, 400);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET revoked_at = ? WHERE id = ?").bind(now(), person.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(person.id),
    env.DB.prepare("DELETE FROM credentials WHERE user_id = ?").bind(person.id),
    env.DB.prepare("DELETE FROM invites WHERE user_id = ? AND used_at IS NULL").bind(person.id),
  ]);
  return json({ ok: true });
}

// Only a hash is stored, so the link can be shown once and never again.
export async function createInvite(env, url, userId) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now() + INVITE_SECONDS).run();
  return `${url.origin}/_auth/invite/${token}`;
}

async function people(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys,
      (SELECT MAX(last_used_at) FROM credentials c WHERE c.user_id = u.id) AS last_sign_in,
      (SELECT COUNT(*) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?) AS open_invites
    FROM users u ORDER BY u.revoked_at IS NOT NULL, u.is_owner DESC, u.name COLLATE NOCASE`).bind(now()).all();
  return results;
}

function day(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

function status(p) {
  if (p.revoked_at) return `Revoked ${day(p.revoked_at)}`;
  if (p.last_sign_in) return `Signed in ${day(p.last_sign_in)}`;
  if (p.passkeys) return "Has a passkey";
  return p.open_invites ? "Invite not used yet" : "Invite expired";
}

function personRow(p) {
  const actions = p.revoked_at ? "" : `
      <button data-action="invite" data-id="${p.id}">${p.passkeys ? "New link" : "Resend link"}</button>
      ${p.is_owner ? "" : `<button class="danger" data-action="revoke" data-id="${p.id}" data-name="${escape(p.name)}">Revoke</button>`}`;
  return `
  <tr class="${p.revoked_at ? "revoked" : ""}">
    <th>${escape(p.name)}${p.is_owner ? ' <span class="meta">owner</span>' : ""}
      <span class="meta status-inline">${status(p)}</span></th>
    <td class="status">${status(p)}</td>
    <td class="actions">${actions}</td>
  </tr>`;
}

function adminPage(list, owner) {
  const current = list.filter((p) => !p.revoked_at);
  const revoked = list.filter((p) => p.revoked_at);
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>People · heybert</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="data:,">
<style>
  .actions { white-space: nowrap; }
  .actions button, #link button { font: inherit; font-size: 0.85rem; padding: 0.25rem 0.6rem; margin-left: 0.25rem;
    border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; }
  .actions button.danger { color: #d93025; }
  tr.revoked th, tr.revoked td { color: var(--muted); }
  table.numbers th, table.numbers td { text-align: left; vertical-align: middle; }
  table.numbers td.actions { text-align: right; }
  .status-inline { display: none; }
  #link { margin: 0 0 1.5rem; }
  #link[hidden] { display: none; }
  #link input { width: 100%; font: inherit; font-size: 0.9rem; padding: 0.4rem 0.6rem; margin: 0.5rem 0;
    border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
  #link button { margin: 0 0.4rem 0 0; }
  #link button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  #error { color: #d93025; margin: 0 0 1rem; }
  #error:empty { display: none; }
  /* On a phone the status moves under the name, leaving room for the buttons. */
  @media (max-width: 560px) {
    table.numbers .status { display: none; }
    .status-inline { display: block; font-weight: 400; }
  }
</style>
</head>
<body>
<header class="site">
  <a class="brand" href="/">heybert</a>
  <nav><a href="/">← Back to the archive</a><a href="/_admin" aria-current="page">People</a><a href="/_admin/import">Import</a><a href="/_auth/logout">Sign out</a></nav>
</header>
<main>
<h1>Who can see your archive</h1>
<p class="meta">Signed in as ${escape(owner.name)}. Each invite link works once, for 7 days, and lets one person create a
passkey on their phone or computer. Send it somewhere only they will see it. To add another device for someone,
including you, use <strong>New link</strong> on their row rather than inviting them again.</p>

<form class="filters" id="invite">
  <input type="search" name="name" placeholder="Their name, e.g. Jo Bloggs" autocomplete="off" required maxlength="100">
  <button>Create invite link</button>
</form>
<p id="error" role="alert"></p>

<section class="card" id="link" hidden>
  <strong id="link-title"></strong>
  <input id="link-url" readonly aria-label="Invite link">
  <button class="primary" id="copy">Copy link</button>
  <button id="share" hidden>Share…</button>
  <button id="done">Done</button>
</section>

<table class="numbers">
  <thead><tr><th>Person</th><th class="status">Status</th><th></th></tr></thead>
  <tbody>${current.map(personRow).join("")}</tbody>
</table>
${revoked.length ? `
<h2>Revoked</h2>
<table class="numbers"><tbody>${revoked.map(personRow).join("")}</tbody></table>` : ""}
</main>
<script>
  const error = document.getElementById("error");
  const panel = document.getElementById("link");
  const linkUrl = document.getElementById("link-url");

  async function post(path, body) {
    error.textContent = "";
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { sameName: data.sameName });
    return data;
  }

  function showLink({ name, link }) {
    document.getElementById("link-title").textContent = "Invite link for " + name;
    linkUrl.value = link;
    panel.hidden = false;
    linkUrl.select();
  }

  document.getElementById("invite").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      showLink(await post("/_admin/invite", { name: form.name.value }));
      form.reset();
    } catch (err) {
      if (err.sameName && confirm(err.message + "\\n\\nOr is this a different person with the same name? OK to invite them anyway.")) {
        showLink(await post("/_admin/invite", { name: form.name.value, sameNameOk: true }));
        form.reset();
      } else error.textContent = err.message;
    }
  });

  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const { action, id, name } = button.dataset;
    if (action === "revoke" && !confirm("Revoke access for " + name + "? They'll be signed out straight away and their passkeys deleted.")) return;
    try {
      const result = await post("/_admin/people/" + id + "/" + action);
      if (action === "revoke") location.reload();
      else showLink(result);
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
    share.addEventListener("click", () => navigator.share({ title: "heybert invite", url: linkUrl.value }).catch(() => {}));
  }
  document.getElementById("done").addEventListener("click", () => location.reload());
</script>
</body>
</html>`;
}
