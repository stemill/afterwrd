// Your devices (admin.js): the owner's passkeys, adding a device with a one-hour link, and signing out everywhere.
import { escape } from "../util.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";

function day(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

export function devicesPage({ owner, passkeys, openLinks, sessions, notifying = [] }) {
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
<p class="meta">Signed in as ${escape(owner)}. Each phone or computer you use has its own passkey. To add one, make a
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
<h2>Notifications about events</h2>
<p class="meta">The phones and computers that tell you when a friend invites you to an event, or one you haven't said no
to changes. Turn one on in <a href="/events#notify">Events</a>, on that device. Removing the passkey it was signed in
with, or signing out there, turns it off too.</p>
${notifying.length ? `<ul class="devices" id="notifying">
  ${notifying.map((d) => `<li class="card"><span><strong>${escape(d.name)}</strong><span class="meta"> · on since ${day(d.created_at)}${d.preview ? ", showing events on the lock screen" : ", showing only who they're from"}${d.last_ok_at ? `, last sent ${day(d.last_ok_at)}` : ""}</span></span>
    <form method="post" action="/_admin/notifications/${Number(d.id)}/forget" data-confirm="Turn off notifications on this device?" data-confirm-ok="Turn off"><button class="chip danger">Turn off</button></form></li>`).join("")}
</ul>` : '<p id="notifying">None.</p>'}
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
    if (!button) return;
    const ask = confirmations[button.dataset.action];
    if (ask && !(await askFirst(ask, { ok: button.dataset.action === "sign-out" ? "Sign out" : "Remove" }))) return;
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
