// Adding and introducing friends (connect.js): Add a friend, confirming a friend link, and introductions.
import { host } from "../peers.js";
import { escape } from "../util.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";

function shell(me, title, body, script = "") {
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
${ownerHeader("connections", me)}
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

export function connectionsPage({ friends: connections, unchecked = false, me = null }) {
  return shell(me, "Add a friend", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Add a friend</h1>
<h2>Got a link from a friend?</h2>
<form class="filters" id="paste" action="/_admin/connections/new" method="get">
  <input type="search" name="link" placeholder="Paste their friend link here" required autocomplete="off" aria-label="A friend link">
  <button type="button" class="chip" id="paste-clip" hidden>Paste</button>
  <button>Add friend</button>
</form>

<h2>Invite someone</h2>
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

${connections.length ? `<table class="numbers">
  <thead><tr><th>Friend</th><th>Site</th><th>Since</th><th></th></tr></thead>
  <tbody>${connections.map((c) => `<tr>
    <th><a href="/friend/${c.id}/posts">${escape(c.name)}</a></th>
    <td><a href="${escape(c.origin)}" target="_blank" rel="noopener noreferrer">${escape(host(c.origin))}</a></td>
    <td>${day(c.connected_at)}</td>
    <td><button class="chip" data-disconnect="${c.id}" data-name="${escape(c.name)}">Remove friend</button></td>
  </tr>`).join("")}</tbody>
</table>` : `<p class="empty">You're not connected with anyone yet.</p>`}`, `${POST_SCRIPT}
  // Paste in one tap where the browser allows reading what was copied (it may ask first).
  const pasteClip = document.getElementById("paste-clip");
  if (navigator.clipboard?.readText) {
    pasteClip.hidden = false;
    pasteClip.addEventListener("click", async () => {
      const box = document.querySelector("#paste input[name=link]");
      try { box.value = (await navigator.clipboard.readText()).trim(); } catch { box.focus(); return; }
      if (box.value) document.getElementById("paste").requestSubmit();
    });
  }
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
    if (!button || !(await askFirst("Remove " + button.dataset.name + " as a friend? You'll stop seeing each other's posts and photos. Comments already made stay where they are.", { ok: "Remove" }))) return;
    try {
      await post("/_admin/connections/" + button.dataset.disconnect + "/disconnect");
      location.reload();
    } catch (err) { error.textContent = err.message; }
  });`);
}

export function confirmPage({ name, origin, me = null }) {
  return shell(me, "Connect", `
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

export function introducePage({ friend, others, maxNote, me = null }) {
  return shell(me, "Introduce", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Introduce ${escape(friend.name)}</h1>
${others.length ? `<p class="meta">Choose a friend who'd like to know ${escape(friend.name)}. Both of them are told who you
introduced them to, and that it was you, and either can then ask the other to be friends. Nobody else is told anything.</p>
<form class="stack" method="post">
  <label>Introduce them to <select name="to" required data-search="Type a friend's name" aria-label="The friend to introduce them to">${others.map((c) => `<option value="${c.id}">${escape(c.name)}</option>`).join("")}</select></label>
  <textarea name="note" rows="2" maxlength="${maxNote}" placeholder="Why they'd get on (optional)" aria-label="A note for both of them"></textarea>
  <div class="actions-row"><button class="chip primary" id="introduce">Introduce them</button><a class="chip" href="/friend">Not now</a></div>
</form>` : `<p>You'll need at least one other friend on afterwrd to introduce ${escape(friend.name)} to.</p>`}`);
}

export function togetherPage({ friends, max, maxNote, me = null }) {
  return shell(me, "Introduce friends to each other", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>Introduce friends to each other</h1>
${friends.length < 2 ? `<p>You'll need at least two friends on afterwrd who've approved you too.</p>` : `<p class="meta">Choose friends who'd like to know each other: a
book club, a family, old school friends. Each of them is told about all the others, and that it was you; any of them can
then ask another to be friends. Nobody else is told anything, and nothing is kept: it's like introducing each pair.</p>
<form class="stack" id="together">
  <input type="search" id="together-filter" placeholder="Type a name to find them" aria-label="Find a friend" autocomplete="off">
  <fieldset class="together-list"><legend class="hidden">Friends</legend>
    ${friends.map((c) => `<label class="together-friend"><input type="checkbox" name="friend" value="${c.id}" data-name="${escape(c.name)}"> ${escape(c.name)}</label>`).join("")}
  </fieldset>
  <p class="meta" id="together-count">Choose at least two, and up to ${max}.</p>
  <textarea name="note" rows="2" maxlength="${maxNote}" placeholder="Why they'd get on (optional): everyone sees this" aria-label="A note for all of them"></textarea>
  <div class="actions-row"><button class="chip primary" id="together-go" disabled>Introduce them to each other</button><a class="chip" href="/friend">Not now</a></div>
</form>
<ol class="together-log" id="together-log"></ol>
<p id="error" role="alert"></p>`}`, friends.length < 2 ? "" : `
  const form = document.getElementById("together");
  const boxes = [...form.querySelectorAll("input[name=friend]")];
  const go = document.getElementById("together-go");
  const count = document.getElementById("together-count");
  const chosen = () => boxes.filter((b) => b.checked);
  const update = () => {
    const n = chosen().length;
    go.disabled = n < 2 || n > ${max};
    count.textContent = n < 2 ? "Choose at least two, and up to ${max}." : n > ${max}
      ? "That's more than ${max}: untick some, or do it in two goes." : n + " chosen: each will be told about the other " + (n - 1) + ".";
  };
  form.addEventListener("change", update);
  document.getElementById("together-filter").addEventListener("input", (e) => {
    const words = e.target.value.trim().toLowerCase();
    for (const b of boxes) b.closest("label").hidden = Boolean(words) && !b.dataset.name.toLowerCase().includes(words) && !b.checked;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const people = chosen();
    if (people.length < 2) return;
    go.disabled = true;
    const log = document.getElementById("together-log");
    log.textContent = "";
    let trouble = 0;
    for (const person of people) {
      const li = document.createElement("li");
      li.textContent = "Telling " + person.dataset.name + "…";
      log.append(li);
      try {
        const res = await fetch("/_admin/connections/together", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: Number(person.value), others: people.filter((p) => p !== person).map((p) => Number(p.value)),
            note: form.note.value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "something went wrong");
        li.textContent = "Told " + person.dataset.name + " ✓";
      } catch (err) {
        trouble++;
        li.textContent = "Couldn't tell " + person.dataset.name + ": " + err.message;
      }
    }
    document.getElementById("error").textContent = trouble === people.length ? "Nobody could be told. Try again later." : "";
    if (trouble < people.length) {
      const done = document.createElement("p");
      done.className = "meta";
      done.append("Done. It's up to them now. ", Object.assign(document.createElement("a"), { href: "/friend", textContent: "Back to Friends" }));
      log.after(done);
    }
  });`);
}

export function introducedPage({ friend, other, trouble, me = null }) {
  const both = `${escape(friend.name)} and ${escape(other.name)}`;
  return shell(me, "Introduce", `
<p class="crumbs"><a href="/friend">Friends</a> /</p>
<h1>${trouble.length === 2 ? "Couldn't introduce them" : `Introduced ${both}`}</h1>
${trouble.length ? `<p>Couldn't reach ${trouble.map(escape).join("; ")}.</p>` : ""}
<p class="meta">${trouble.length === 2 ? "Try again later." : trouble.length
  ? "The other one has been told, and can ask to be friends."
  : "Each has been told about the other. It's up to them now."}</p>
<p><a class="chip" href="/friend">Back to Friends</a></p>`);
}

export function connectionsMessage({ message, me = null }) {
  return shell(me, "Connect", `
<p class="crumbs"><a href="/_admin/connections">Add a friend</a> /</p>
<h1>Couldn't connect</h1>
<p>${escape(message)}</p>`);
}
