// The owner's Update page (update.js): this version, the latest release and its notes, bringing groups up to date,
// and asking a friend to check the site.
import { connectLink } from "../cloudflare.js";
import { TOKEN_URL, TOKENS_PAGE } from "../update.js";
import { escape } from "../util.js";
import { checkedWords } from "./checks.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";

/** The Connect button for a step, or a note that it's done, with the by-hand fallback folded away. */
function connectPart(connected, back, what, background = false) {
  if (connected) return `<p class="meta connected">Connected to Cloudflare for the next hour.</p>`;
  // Automatic updates' background access does it: nothing to connect.
  if (background) return `<p class="meta connected">This uses automatic updates' access, so there's no need to connect.</p>`;
  return `
<p><a class="button" id="connect" href="${escape(connectLink(back))}">Connect Cloudflare</a>
  <span class="meta">Cloudflare asks you to allow afterwrd ${what}, for an hour. Nothing is kept afterwards.</span></p>
<details class="other"><summary>If connecting doesn't work, use an API token</summary>
  <ol class="how">
    <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a> in Cloudflare.
      <span class="meta">The permissions are filled in: scroll down, press <b>Continue to summary</b>, <b>Create Token</b>, and copy it.</span></li>
    <li>Paste it here: <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token" aria-label="Your API token">
      <span class="meta">It's used only now, and then you delete it in Cloudflare (My Profile → API Tokens).</span></li>
  </ol>
</details>`;
}

const day = (seconds) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** Automatic updates (auto.js): on or off, what's next, what last happened, and anything that needs the owner. */
function autoPart(auto) {
  const last = auto.last?.result === "kept" ? `<p class="notice alert">afterwrd ${escape(auto.last.version)} failed its checks on
    ${escape(day(auto.last.at))}, but it had already updated your site's database, which the older version can't use, so it
    was kept. If anything isn't working, please tell whoever looks after afterwrd.</p>`
    : auto.last && auto.last.result !== "done" ? `<p class="notice alert">afterwrd ${escape(auto.last.version)} didn't
    ${auto.last.result === "unhealthy" ? "work" : "start"} on this site on ${escape(day(auto.last.at))}, so it was put back as it was.
    It won't be tried again by itself; a later release will be.</p>`
    : auto.last ? `<p class="meta">Last updated itself to ${escape(auto.last.version)} on ${escape(day(auto.last.at))}.</p>` : "";
  const waiting = auto.waiting?.needsHand ? `<p class="notice alert">afterwrd ${escape(auto.waiting.version)} adds a new kind of
    store, which Cloudflare only lets you install by hand. Update to it above.</p>`
    : auto.waiting?.version && auto.waiting.after ? `<p>afterwrd ${escape(auto.waiting.version)} will install itself after
    ${escape(day(auto.waiting.after))}.</p>` : "";
  const problem = auto.problem ? `<p class="notice alert">The last automatic update couldn't run: ${escape(auto.problem)}</p>` : "";
  const ago = (seconds) => { const m = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60)); return m < 1 ? "just now" : m === 1 ? "a minute ago" : `${m} minutes ago`; };
  const running = auto.running ? `<p class="notice" id="auto-running">It's looking for an update now (started ${escape(ago(auto.running))}).
    This page doesn't need to stay open.</p>` : auto.busy ? `<p class="notice" id="auto-running">It was already looking.</p>` : "";
  const lastCheck = auto.lastCheck && !auto.running ? `<p id="auto-last"><b>Last looked ${escape(ago(auto.lastCheck.at))}:</b> ${escape(auto.lastCheck.words)}</p>` : "";
  const groupLines = Object.values(auto.groups ?? {}).filter((g) => g.result !== "done");
  const groupsDone = groupLines.length ? `<ul class="meta">${groupLines.map((g) => `<li>${escape(g.name)}: ${escape(
    g.result === "needs-hand" ? "has to be updated by hand (below)" : g.result.startsWith("error") ? `couldn't be updated: ${g.result.slice(7)}` : `didn't take ${g.version}, so it was put back`)}
    (${escape(day(g.at))})</li>`).join("")}</ul>` : "";
  if (auto.on) {
    return `
<section class="card" id="auto">
  <h2>Automatic updates are on</h2>
  ${running}${lastCheck}${waiting}${last}${problem}${groupsDone}
  <p class="meta">Once a day this site looks for a new afterwrd release. It installs one only when it's signed by
  afterwrd's own key and has been out for three days (one, for a security fix), and puts itself back as it was if the
  new version doesn't work. Your groups follow.${auto.signed ? "" : " (No release is signed yet, so it's waiting for the first.)"}</p>
  <form method="post" action="/_admin/update/auto-now" id="auto-now-form"><button class="link" id="auto-now"${auto.running ? " disabled" : ""}>Look for an update now</button>
    <span class="meta" id="auto-now-note">(it can take a few minutes if there's one to install)</span></form>
  <script>
    // Once pressed, it says so and can't be pressed again: pressing again would cut the first look short.
    document.getElementById("auto-now-form").addEventListener("submit", (e) => {
      const button = document.getElementById("auto-now");
      if (button.dataset.sent) { e.preventDefault(); return; }
      button.dataset.sent = "1";
      button.textContent = "Looking…";
      document.getElementById("auto-now-note").textContent = "This can take a few minutes if there's something to install. It'll say what happened.";
    });
  </script>
  <form method="post" action="/_admin/update/auto-off"><button class="link">Turn automatic updates off</button>
    <span class="meta">Then, to be sure, remove afterwrd in Cloudflare too: My Profile → Access Management → Connected Applications.</span></form>
</section>`;
  }
  return `
<section class="card" id="auto">
  <h2>Keep afterwrd up to date by itself</h2>
  ${problem}
  <p>Your site can install each new afterwrd release by itself, so you never have to come here. Cloudflare will ask you to
  allow <b>Background Access</b> to change your Workers, and nothing else: it can't touch your databases or your account's
  settings.</p>
  <p><a class="button" href="/_cloudflare/auto-start">Turn on automatic updates</a></p>
</section>`;
}

export function updatePage({ owner, version: VERSION, latest, available, securityFix, site, connected, oldToken, groups, go, checked = null, friends = [], checkWait = 0, auto = { on: false }, history = [], problem = null }) {
  // Groups this site made that are behind it: brought up to this version, with the same connection.
  const groupsPart = groups.length && !available ? `
<section class="card" id="groups">
  <h2>Your groups</h2>
  <p>${groups.map((g) => `${escape(g.name)} (${escape(g.version)})`).join(", ")} ${groups.length === 1 ? "is" : "are"} behind your
  site. Bring ${groups.length === 1 ? "it" : "them"} up to ${escape(VERSION)}:</p>
  ${connectPart(connected, "/_admin/update?go=groups", "to change the groups' Workers", auto.on)}
  <p><button id="groups-go" data-groups="${escape(JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))))}">Update ${groups.length === 1 ? "the group" : "the groups"}</button></p>
  <ol id="group-log"></ol>
  <p id="group-error" role="alert"></p>
</section>` : "";
  // A token kept by a version before 0.20.0, which nothing uses any more.
  const forget = oldToken ? `
<section class="card" id="old-token">
  <p>An earlier version kept a Cloudflare API token on this site. afterwrd no longer needs one: updating now asks Cloudflare
  each time, for an hour. <button class="link" id="forget">Forget it</button>, then delete the token in Cloudflare too
  (<a href="${TOKENS_PAGE}" target="_blank" rel="noopener">My Profile → API Tokens</a>).</p>
  <p id="forget-error" role="alert"></p>
</section>` : "";
  const notes = latest.notes ? `<section class="card notes"><h2>What's new</h2><p>${escape(latest.notes)}</p></section>` : "";
  let body;
  if (latest.error) {
    body = `<p>Couldn't check for a newer version: ${escape(latest.error)}</p>`;
  } else if (!available) {
    body = `<p>You have the latest version.</p>`;
  } else {
    body = `
<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">On GitHub</a></p>
${securityFix ? `<p class="security"><b>It fixes a security problem</b> (in ${escape(securityFix)}), so it's worth updating soon.</p>` : ""}
${notes}
<p class="meta">Updating keeps everyone's access, your archive and your photos.</p>
${connectPart(connected, "/_admin/update?go=update", "to change this site's Worker", auto.on)}
<p><button id="go" data-tag="${escape(latest.tag)}" data-version="${escape(latest.version)}">Update to ${escape(latest.version)}</button>
  <span class="meta">Keep this page open until it says it's done: it checks the new version works, and puts the old one back if not.</span></p>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" class="card" hidden>
  <p><b>Updated to ${escape(latest.version)}.</b></p>
  <p class="meta">If a friend has afterwrd, it's worth <a href="#check">asking them to check your site</a> now.</p>
  <p><a class="button" href="/_admin/update">Done</a></p>
</section>`;
  }
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Update · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
<style>
  .how { padding-left: 1.2rem; }
  .how li { margin: 0.6rem 0; }
  .button, #go, #groups-go { display: inline-block; padding: 0.5rem 1rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .button + .meta { display: block; margin-top: 0.4rem; }
  #go:disabled, #groups-go:disabled { opacity: 0.6; cursor: default; }
  #token { width: 100%; font: inherit; padding: 0.5rem; margin-top: 0.3rem; border: 1px solid var(--border); border-radius: 999px;
    background: var(--bg); color: var(--text); -webkit-text-security: disc; }
  #error, #group-error, #forget-error { color: #d93025; }
  .security { padding: 0.6rem 0.9rem; border-left: 3px solid var(--danger); border-radius: 10px; background: var(--tint-4); }
  #done[hidden], #done [hidden] { display: none; }
  .notes h2, #check h2, #auto h2 { margin: 0 0 0.4rem; font-size: 1rem; }
  #ask-message { width: 100%; font: inherit; padding: 0.6rem; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text); }
  .notes p { margin: 0; white-space: pre-wrap; }
  .other { margin: 1rem 0; }
  .other summary { cursor: pointer; color: var(--muted); }
  button.link { padding: 0; border: 0; background: none; color: var(--accent-strong); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
</head>
<body>
${ownerHeader("update")}
<main>
<h1>Update afterwrd</h1>
<p class="meta">Signed in as ${escape(owner)}. This site is afterwrd ${escape(VERSION)}.</p>
${problem ? `<p class="notice alert" id="update-problem">afterwrd ${escape(problem.version)} couldn't update your site's database on
  ${escape(day(problem.at))}, so your site stayed on ${escape(VERSION)}, as it was. Please send this to whoever looks after
  afterwrd: <code>${escape(problem.migration)}: ${escape(problem.error)}</code></p>` : ""}
${body}
${autoPart(auto)}
${history.length ? `<section class="card" id="history">
  <h2>This site's updates</h2>
  <ul>${history.map((h) => `<li>${escape(day(h.at))}: afterwrd ${escape(h.version)}${h.from_version ? `, from ${escape(h.from_version)}` : ""}</li>`).join("")}</ul>
</section>` : ""}
<section class="card" id="check">
  <h2>Get your site checked</h2>
  <p id="last-checked">${checked ? escape(checkedWords(checked)) : "Your site hasn't been checked yet."}</p>
  <p class="meta">A friend's afterwrd site can check that yours is exactly the published afterwrd, with nothing else done in
  your Cloudflare account. Worth doing when your site is new, and after updates. Ask a friend: they'll send you a link by
  message. Open it and press Allow when Cloudflare asks.</p>
  ${checkWait ? `<p class="notice" id="check-wait">Your site was updated less than an hour ago. Ask for a check after
  <b>${escape(new Date(checkWait * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }))}</b>:
  for an hour after an update, the access it used could still change your site, so a check before then can't count.</p>` : ""}
  ${checkWait ? "" : friends.length ? `<p class="row ask-friends">${friends.map((f) => `<button class="chip" data-ask="${f.id}">Ask ${escape(f.name)}</button>`).join(" ")}</p>
  <p id="ask-result" role="status"></p>` : ""}
  <details id="ask-other"${friends.length ? "" : " open"}${checkWait ? " hidden" : ""}>
  <summary class="meta">${friends.length ? "Someone else, or their site is older? Send them a message instead" : "Ask by message"}</summary>
  <p class="meta">This writes a message for you to send them. Their afterwrd site makes the link to send back.</p>
  <p><button class="chip" id="ask-check">Write the message</button></p>
  <div id="ask-panel" hidden>
    <textarea id="ask-message" readonly rows="5" aria-label="Message asking for a check">Could you check that my afterwrd site is genuine? It's at ${escape(site)}. On your afterwrd site, go to Friends, paste this message (or just my address) under "Checking a friend's site", press "Make a check link", and send me the link it makes. Thank you!</textarea>
    <p class="row"><button class="chip primary" id="ask-copy">Copy message</button>
      <button class="chip" id="ask-share" hidden>Share…</button></p>
  </div>
  </details>
  <form method="post" action="/_admin/checks/myself?back=update" class="meta">Or <a href="https://afterwrd.app/check/">check it
    yourself</a>, and then <button class="link">say you've checked it</button>.</form>
</section>
${groupsPart}
${forget}
</main>
<script>
  const go = document.getElementById("go");
  // Asking a friend for a check: their site is sent the request (it makes the link they send back), or, for anyone
  // else, a message to send them.
  document.querySelectorAll("button[data-ask]").forEach((button) => button.addEventListener("click", async () => {
    const result = document.getElementById("ask-result");
    button.disabled = true;
    result.textContent = "";
    try {
      const res = await fetch("/_admin/checks/ask", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection: Number(button.dataset.ask) }) });
      const data = await res.json().catch(() => ({}));
      if (data.older) {
        document.getElementById("ask-other").open = true;
        document.getElementById("ask-check").click();
      }
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      result.textContent = "Asked " + data.name + ". Their site will show them your request. When their link comes,"
        + " open it and press Allow.";
    } catch (err) {
      result.textContent = err.message;
      button.disabled = false;
    }
  }));
  document.getElementById("ask-check").addEventListener("click", () => {
    document.getElementById("ask-panel").hidden = false;
    document.getElementById("ask-message").select();
  });
  document.getElementById("ask-copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(document.getElementById("ask-message").value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy message"; }, 1500);
  });
  const askShare = document.getElementById("ask-share");
  if (navigator.share) {
    askShare.hidden = false;
    askShare.addEventListener("click", () => navigator.share({ text: document.getElementById("ask-message").value }).catch(() => {}));
  }
  const connected = ${connected || Boolean(auto.on)}; // automatic updates' access counts as connected
  const autoGo = ${JSON.stringify(go === "update" || go === "groups" ? go : null)};
  async function post(path, body) {
    const res = await fetch("/_admin/update/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const pasted = () => document.getElementById("token")?.value.trim() || "";
  const forget = document.getElementById("forget");
  if (forget) forget.addEventListener("click", async () => {
    if (!(await askFirst("Forget the old token? Afterwards, delete it in Cloudflare too.", { ok: "Forget it" }))) return;
    try {
      await post("forget", {});
      location.assign("${TOKENS_PAGE}");
    } catch (err) {
      document.getElementById("forget-error").textContent = "Couldn't forget it: " + err.message
        + " You can also delete the secret UPDATE_TOKEN in the Worker's settings in Cloudflare.";
    }
  });
  const groupsGo = document.getElementById("groups-go");
  if (groupsGo) groupsGo.addEventListener("click", async () => {
    const error = document.getElementById("group-error");
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("group-log").append(li); };
    const token = pasted();
    error.textContent = "";
    if (!token && !connected) { error.textContent = "Connect Cloudflare first."; return; }
    groupsGo.disabled = true;
    try {
      for (const group of JSON.parse(groupsGo.dataset.groups)) {
        log("Updating " + group.name + "…");
        const { jwt } = await post("group-assets", { token, group: group.id });
        await post("group-deploy", { token, group: group.id, jwt });
      }
      log("Done.");
    } catch (err) {
      error.textContent = err.message;
      groupsGo.disabled = false;
    }
  });
  if (go) go.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const token = pasted();
    const { tag, version } = go.dataset;
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
    error.textContent = "";
    if (!token && !connected) { error.textContent = "Connect Cloudflare first."; return; }
    go.disabled = true;
    try {
      log("Checking your Cloudflare account…");
      const { account } = await post("check", { token, tag });
      log("Uploading " + version + "'s site files…");
      const { jwt } = await post("assets", { token, account, tag });
      log("Installing " + version + " and checking it works (this can take a few minutes)…");
      await post("deploy", { token, account, tag, jwt });
      const box = document.getElementById("token");
      if (box) box.value = "";
      log("Waiting for the new version to start…");
      let started = false;
      // Cloudflare can take a few minutes to send visits to a new version (9 Nov 2026: over a minute), so up to three.
      for (let i = 0; i < 90 && !started; i++) {
        const res = await fetch("/_admin/update/version", { cache: "no-store" }).catch(() => null);
        started = Boolean(res && res.ok && (await res.json().catch(() => ({}))).version === version);
        if (!started) await new Promise((r) => setTimeout(r, 2000));
      }
      // Never "done" unless this site is the new version: an update that went somewhere else must say so.
      if (!started) throw new Error("Cloudflare has the update, but hasn't started using it yet. Don't update again:"
        + " reload this page in five minutes or so, and it should say " + version + ".");
      document.getElementById("done").hidden = false;
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false;
    }
  });
  // Back from Connect: carry on with what was asked for.
  if (connected && autoGo) {
    history.replaceState(null, "", "/_admin/update");
    (autoGo === "groups" ? groupsGo : go)?.click();
  }
</script>
</body>
</html>`;
}
