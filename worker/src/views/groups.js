// Groups, each its own Worker, read from there (membership.js): a group's posts, photos and members, making and
// joining one. Views only draw: they read nothing and change nothing.
import { connectLink } from "../cloudflare.js";
import { MAX_COMMENT } from "../archive/comments.js";
import { MAX_GROUP_TEXT } from "../groups.js";
import { fmtAgo, fmtDatetime, linkify } from "./format.js";

import { icon } from "./nav.js";
import { host } from "../peers.js";
import { html, raw } from "./html.js";
import { groupEventBlock } from "./events.js";
import { faceFor, notFriend, remoteMedia } from "./friends.js";
import { layout, mentionData, page } from "./layout.js";
import { composer, editBox, edited, feed, menuDelete, menuEdit, moreMenu, ownerFace, pager, pollBlock, said } from "./parts.js";

// --- groups, each its own Worker, read from there (membership.js) -----------------------------------------------------

export const groupBase = (g) => `/groups/${g.id}`;
const runs = (g) => g.role === "owner" || g.role === "admin";
/** Whether the owner here may delete this post or comment: their own; anything, as the group's owner; as an admin, anything but the owner's. */
export const mayDelete = (g, item) => item.mine || g.role === "owner" || (g.role === "admin" && item.from !== g.ownerFrom);
const ROLE_NAMES = { owner: "Owner", admin: "Admin" };

/** Where a group lives and who runs it, in a few words. */
function groupWhere(g) {
  return g.role === "owner" ? html`Your group, at ${host(g.origin)}` : html`${g.host_name}'s group, at ${host(g.origin)}`;
}

/** The owner's groups, starting one, and joining one with an invite link. */
export function groupsIndexPage(ctx, { groups, unfinished = [], connected = false }) {
  return page(ctx, "Groups", html`
<div class="feed-head">
  <h1>Groups</h1>
  <a class="chip primary" href="/groups/new">${raw(icon("groups"))}<span>Start a group</span></a>
</div>
<form class="filters" id="join" action="/groups/join" method="get">
  <input type="search" name="link" placeholder="Got a link to join a group? Paste it here" required autocomplete="off" aria-label="A group's invite link">
  <button type="button" class="chip" id="join-paste" hidden>Paste</button>
  <button>Join</button>
</form>
<script>
  // Paste in one tap where the browser allows reading what was copied (it may ask first).
  const joinPaste = document.getElementById("join-paste");
  if (navigator.clipboard?.readText) {
    joinPaste.hidden = false;
    joinPaste.addEventListener("click", async () => {
      const box = document.querySelector("#join input[name=link]");
      try { box.value = (await navigator.clipboard.readText()).trim(); } catch { box.focus(); return; }
      if (box.value) document.getElementById("join").requestSubmit();
    });
  }
</script>
<p class="meta">Each group is its own small site, in the Cloudflare account of whoever started it. Its members read it
from their own sites, and post and comment there. You're told about comments on posts you wrote or commented on; for
anything else, open the group. What's coming up in your groups is on <a href="/events">Events</a>, with your friends'
events and your own.</p>
${groups.length ? html`<ul class="group-list">
  ${groups.map((g) => html`<li><a class="card" href="${groupBase(g)}">
    <span class="icon-tile" aria-hidden="true">${raw(icon("groups"))}</span>
    <span class="what"><strong>${g.name}</strong><span class="meta">${groupWhere(g)}</span></span>
    ${ROLE_NAMES[g.role] && html`<span class="badge as-written">${ROLE_NAMES[g.role]}</span>`}
    ${g.notes > 0 && html`<span class="badge badge-new as-written">${g.notes} new</span>`}
  </a></li>`)}
</ul>` : html`<p class="empty">You're not in any groups yet.</p>`}
${unfinished.length > 0 && html`<section class="card" id="unfinished">
  <h2>Not finished setting up</h2>
  <p class="meta">Starting ${unfinished.length === 1 ? "this group" : "these groups"} stopped partway. Finish setting up, or
  delete what was made in your Cloudflare account.</p>
  <ul class="member-list">${unfinished.map((g) => html`<li class="card member">
    <span class="what"><strong>${g.name}</strong><span class="meta">${host(g.origin)}</span></span>
    <div class="actions-row"><button class="chip primary" data-finish="${g.id}">Finish setting up</button>
      <button class="chip" data-delete="${g.id}">Delete</button></div>
  </li>`)}</ul>
  ${connectField(connected, "to delete what was made", "/groups")}
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</section>
<script>${raw(STEP_SCRIPT)}
  document.getElementById("unfinished").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-finish], button[data-delete]");
    if (!button || (button.dataset.delete && !(await askFirst("Delete this group's Worker and database from your Cloudflare account?", { ok: "Delete" })))) return;
    button.disabled = true;
    error.textContent = "";
    try {
      if (button.dataset.delete) {
        log("Deleting…");
        await post("/_groups/" + button.dataset.delete + "/delete", { token: token() });
        location.reload();
        return;
      }
      const id = Number(button.dataset.finish);
      log("Waiting for it to answer…");
      for (let i = 0; i < 20 && !(await post("/_groups/create/wait", { id })).ready; i++) await new Promise((r) => setTimeout(r, 2000));
      log("Setting it up as yours…");
      location.assign("/groups/" + (await post("/_groups/create/claim", { id })).id + "/members");
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
</script>`}`);
}

/**
 * What a step that changes the owner's Cloudflare account needs: their connection from Connect (an hour's token,
 * cloudflare.js), coming back to `back` once Cloudflare's said yes; or, if that can't be used, a token pasted here.
 */
function connectField(connected, purpose, back) {
  return connected ? html`<p class="meta">Connected to Cloudflare for the next hour, ${purpose}.</p>`
    : html`<p class="meta"><a class="chip primary connect" href="${connectLink(back)}">Connect Cloudflare</a>
    Cloudflare asks you to allow afterwrd to change Workers and databases in your account, for an hour, ${purpose}. Nothing is kept afterwards.</p>
  <details class="meta"><summary>If connecting doesn't work, use an API token</summary>
    <p><a href="${TOKEN_LINK}" target="_blank" rel="noopener">Create one</a> (the permissions are filled in; scroll down,
    press <b>Continue to summary</b>, then <b>Create Token</b>), copy it, and paste it here. Delete it in Cloudflare afterwards.</p>
    <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Your API token" aria-label="Cloudflare API token">
  </details>`;
}
const TOKEN_LINK = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" + encodeURIComponent(JSON.stringify([
  { key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }, { key: "account_settings", type: "read" }]))
  + "&accountId=*&zoneId=all&name=afterwrd%20groups";

// The small script both group pages that call Cloudflare use: post JSON, and say how it went.
const STEP_SCRIPT = `
  const error = document.getElementById("error");
  const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const token = () => document.getElementById("token")?.value.trim() || "";`;

/** Starting a group: name it, and this site makes its Worker (groupsites.js), step by step. */
export function groupNewPage(ctx, { connected, domain, maxPhotos }) {
  return page(ctx, "Start a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Start a group</h1>
<p>A group is its own small site in your Cloudflare account, separate from yours: it holds the group and nothing else,
and no one signs in to it. You and its members use it from your own afterwrd sites. You decide who's in it (up to 40
people besides you), can make others admins, and can delete it. Members can post photos (up to ${maxPhotos} a post), which
are kept on the group's site.</p>
<p class="meta">A free Cloudflare account can hold about 9 groups besides your site. Your site keeps each group
up to date when you update.</p>
${domain ? html`<form class="card stack" id="start">
  <input name="name" required maxlength="100" placeholder="Its name" aria-label="Group name">
  <textarea name="about" rows="2" maxlength="1000" placeholder="What it's for (optional)" aria-label="What it's for"></textarea>
  ${connectField(connected, "to make the group's site", "/groups/new")}
  <div class="actions-row"><button class="chip primary" id="go">Start the group</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</form>
<script>${raw(STEP_SCRIPT)}
  const form = document.getElementById("start");
  // Connect takes a page away and back: what's typed is kept for the return.
  const kept = "afterwrd-group-start";
  try {
    const saved = JSON.parse(sessionStorage.getItem(kept) || "null");
    if (saved) { form.name.value = saved.name; form.about.value = saved.about; sessionStorage.removeItem(kept); }
  } catch {}
  document.querySelector("a.connect")?.addEventListener("click", () => {
    try { sessionStorage.setItem(kept, JSON.stringify({ name: form.name.value, about: form.about.value })); } catch {}
  });
  let made = null; // a group whose site is made, still to be claimed: trying again carries on from there
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = document.getElementById("go");
    error.textContent = "";
    go.disabled = true;
    try {
      if (!made) {
        const name = form.name.value.trim();
        log("Checking your Cloudflare account…");
        const { account, script, address } = await post("/_groups/create/check", { token: token(), name });
        log("Preparing " + address + "…");
        const { jwt } = await post("/_groups/create/assets", { token: token(), account, script });
        log("Making the group's site…");
        made = (await post("/_groups/create/deploy", { token: token(), account, script, jwt, name, about: form.about.value })).id;
      }
      log("Waiting for it to start…");
      for (let i = 0; i < 40 && !(await post("/_groups/create/wait", { id: made })).ready; i++) await new Promise((r) => setTimeout(r, 2000));
      log("Setting it up as yours…");
      const { id } = await post("/_groups/create/claim", { id: made });
      location.assign("/groups/" + id + "/members");
    } catch (err) {
      error.textContent = err.message + (made ? " Press the button again to carry on." : "");
      go.disabled = false;
    }
  });
</script>` : html`<p class="notice">Groups can be started from your site's workers.dev address.</p>`}`);
}

/** Join the group an invite link is for? (Or why not.) */
export function groupJoinPage(ctx, { info = null, link = "", error = null }) {
  if (error) {
    return page(ctx, "Join a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Couldn't open that invite</h1>
<p>${error}</p>`);
  }
  return page(ctx, "Join a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Join ${info.name}?</h1>
${info.about && html`<p>${info.about}</p>`}
<p class="meta">${info.owner}'s group, at <strong>${host(info.origin)}</strong>. Its members will see your name and your
site's address, and what you post there is kept there. Its admins let people in, so you'll be asking. You can leave
whenever you like, and joining shares nothing else of yours.</p>
<p id="error" role="alert"></p>
<div class="actions-row">
  <button class="chip primary" id="go">Ask to join</button>
  <a class="chip" href="/groups">Not now</a>
</div>
<script>
  document.getElementById("go").addEventListener("click", async (e) => {
    const error = document.getElementById("error");
    e.target.disabled = true;
    error.textContent = "";
    try {
      const res = await fetch("/_groups/join", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link: ${raw(JSON.stringify(link).replace(/</g, "\\u003c"))} }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      location.assign("/groups/" + data.id);
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });
</script>`);
}

export function groupHead(ctx, g, info, tab) {
  const waiting = runs(g) ? info?.waiting ?? 0 : 0;
  return html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<div class="feed-head">
  <h1>${info?.name ?? g.name}</h1>
</div>
${(info?.about ?? g.about) && html`<p>${info?.about ?? g.about}</p>`}
<p class="meta">${groupWhere(g)}${info && ` · ${info.members} ${info.members === 1 ? "member" : "members"}`}. Only its members see it.</p>
${info && mentionData("mention-group", { people: info.people ?? [], here: Boolean(info.mayHere) })}
<nav class="tabs">
  <a href="${groupBase(g)}" ${tab === "posts" && raw('aria-current="page"')}>Posts</a>
  <a href="${groupBase(g)}/calendar" ${tab === "calendar" && raw('aria-current="page"')}>Calendar</a>
  <a href="${groupBase(g)}/members" ${tab === "members" && raw('aria-current="page"')}>${g.role === "owner" ? "Members & settings" : "Members"}${waiting > 0 && html` <span class="count">${waiting}<span class="hidden"> asking to join</span></span>`}</a>
</nav>`;
}

/** Someone in a group: the owner here (their picture), a friend (theirs, if remembered), or an initial. */
function groupFace(ctx, item) {
  return item.mine ? ownerFace(ctx) : faceFor(ctx, item.from, item.name, item.id ?? 0);
}

/** Comments on a group post; the owner here can delete their own, and anyone's in a group they help run. */
function groupThread(ctx, g, p) {
  const back = ctx.url.pathname + ctx.url.search;
  const more = p.commentCount - p.comments.length;
  return html`<section class="thread" id="t-g${p.id}" aria-label="Comments">
  ${more > 0 && !ctx.url.pathname.includes("/posts/") && html`<p class="meta"><a href="${groupBase(g)}/posts/${p.id}">See all ${p.commentCount} comments</a></p>`}
  ${p.comments.map((c) => html`<div class="comment" id="g${p.id}-${c.id}"${!c.mine && c.from && html` data-who="${c.from}" data-name="${c.name}"`}>
    ${groupFace(ctx, c)}
    <div class="bubble"><strong>${c.mine ? ctx.user.name : c.name}</strong>${!c.mine && notFriend(ctx, c.from)}<span class="said">${linkify(c.text, said(c))}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${moreMenu([c.mine && c.editable && menuEdit(`edit-g${p.id}-${c.id}`),
        mayDelete(g, c) && menuDelete(`/_groups/${g.id}/comments/${c.id}/delete`, "Delete this comment?", { back, inplace: "refresh" })])}
    </div>
    ${edited(c)}
    ${c.mine && c.editable && editBox(`edit-g${p.id}-${c.id}`, `g${p.id}-${c.id}`, `/_groups/${g.id}/comments/${c.id}/edit`, c.text, back, MAX_COMMENT, { post: p.id })}
  </div>`)}
  <form class="say" method="post" action="/_groups/${g.id}/comments" data-group="${g.id}" data-post="${p.id}" data-inplace data-me="${ctx.user.name}">
    <input type="hidden" name="post" value="${p.id}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="comment:/_groups/${g.id}:${p.id}" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

/**
 * A post in a group. Its photos come by signed links from the group's site, and open among the post's photos, with ✕
 * coming back to `back` (this page and the post on it, unless said otherwise).
 */
function groupCard(ctx, g, p, { back = `${ctx.url.pathname}${ctx.url.search}#gp${p.id}` } = {}) {
  const n = p.photos.length;
  const stay = `?${new URLSearchParams({ back })}`;
  return html`<article class="card social in-group" id="gp${p.id}" data-region="${groupBase(g)}/posts/${p.id}"${!p.mine && p.from && html`
  data-who="${p.from}" data-name="${p.name}"`}>
  <header>
    ${groupFace(ctx, p)}
    <span class="what"><strong>${p.mine ? "You" : p.name}</strong>${!p.mine && notFriend(ctx, p.from, "meta")}</span>
    <a class="when" href="${groupBase(g)}/posts/${p.id}" title="${fmtDatetime(p.created_at)}"><time>${fmtAgo(p.created_at)}</time></a>
    ${moreMenu([p.mine && p.editable && menuEdit(`edit-gp${p.id}`),
      mayDelete(g, p) && menuDelete(`/_groups/${g.id}/posts/${p.id}/delete`,
        "Delete this post, its photos and its comments? This can’t be undone.", { back: groupBase(g), inplace: "remove" })])}
  </header>
  ${p.event && groupEventBlock(ctx, g, p, { full: ctx.url.pathname.includes("/posts/") })}
  ${p.text && html`<div class="text">${linkify(p.text, said(p))}</div>`}
  ${edited(p)}
  ${p.mine && p.editable && editBox(`edit-gp${p.id}`, `gp${p.id}`, `/_groups/${g.id}/posts/${p.id}/edit`, p.text, ctx.url.pathname + ctx.url.search, MAX_GROUP_TEXT,
    { required: Boolean(p.poll) || !p.photos.length })}
  ${p.poll && pollBlock(ctx, p.poll, { id: `poll-g${p.id}`, action: `/_groups/${g.id}/polls/${p.id}/vote`,
    closeAction: p.mine ? `/_groups/${g.id}/polls/${p.id}/close` : null,
    whoNote: "Only you're shown this. Whoever hosts the group could still look it up.",
    whoLink: p.mine && !ctx.url.pathname.includes("/posts/") ? `${groupBase(g)}/posts/${p.id}#poll-g${p.id}` : null })}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${p.photos.slice(0, 4).map((m, i) => html`
      <a href="${groupBase(g)}/posts/${p.id}/photos/${m.hash}${stay}" class="tile" ${n === 1 && html`style="--bg-img: url('${m.thumbSrc}')"`}>
        ${remoteMedia(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`}
  ${groupThread(ctx, g, p)}
</article>`;
}

export function groupPage(ctx, { membership: g, group: info, posts, paging, maxPhotos }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "posts")}
${composer({ action: `/_groups/${g.id}/posts`, max: maxPhotos, placeholder: `Write something for ${info.name}` })}
${feed(posts, (p) => groupCard(ctx, g, p), "Nothing posted yet. Write the first post above.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

export function groupPostPage(ctx, { membership: g, group: info, post }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "")}
<div class="feed">${groupCard(ctx, g, post)}</div>`);
}

/** A photo in a group's post, among that post's photos; the post beneath, where it can be commented on. */
export function groupPhotoPage(ctx, { membership: g, group: info, post, photo: m, index, total, prev, next, back, stay }) {
  g.ownerFrom = info.ownerFrom;
  const main = html`
<main class="theatre">
  <section class="stage">
    ${remoteMedia(m, { full: true })}
    <a class="close" id="close" href="${back}" title="Back (Esc)" aria-label="Back to the post">✕</a>
    <span class="counter">${index} / ${total}</span>
    ${prev && html`<a class="nav prev" id="prev" href="${groupBase(g)}/posts/${post.id}/photos/${prev}${stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${next && html`<a class="nav next" id="next" href="${groupBase(g)}/posts/${post.id}/photos/${next}${stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="${groupBase(g)}">${info.name}</a>
    <time class="when">${fmtDatetime(post.created_at)}</time>
    <h2>Posted with</h2>
    ${groupCard(ctx, g, post, { back })}
  </aside>
</main>
<script>
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: info.name, bodyClass: "viewer", main });
}

/** Who's in a group. For its admins: requests to join, the invite link, roles, and (its owner) deleting it. */
export function groupMembersPage(ctx, { membership: g, group: info, members, max, connected, friends = [] }) {
  const owner = g.role === "owner";
  const here = `/groups/${g.id}/members`;
  // Friends with them, asked them, asked by them, or a button to ask: everyone in a group can see who's in it.
  const friendship = (m) => {
    if (!m.from || m.waiting || m.from === ctx.url.origin) return "";
    const c = friends.find((f) => f.origin === m.from);
    if (c?.approved_at) {
      return html`<span class="friendship">${c.reached_at ? html`<a class="chip" href="/friend/${c.id}/posts">Friends</a>` : html`<span class="meta">Asked</span>`}</span>`;
    }
    if (c?.invited_as) return html`<span class="friendship"><a class="chip primary" href="/friend">Asking to be friends</a></span>`;
    if (c) {
      return html`<form method="post" class="friendship"><button class="chip primary"
        formaction="/_admin/connections/${c.id}/approve?back=${encodeURIComponent(here)}">Approve friend request</button></form>`;
    }
    return html`<form method="post" action="/_admin/connections/ask" class="friendship">
      <input type="hidden" name="origin" value="${m.from}"><input type="hidden" name="group" value="${g.id}">
      <input type="hidden" name="back" value="${here}"><button class="chip">Ask to be friends</button></form>`;
  };
  const person = (m, actions) => html`<li class="card member" data-from="${m.from ?? ""}">
    ${faceFor(ctx, m.from, m.name, m.id ?? 0)}
    <span class="what"><strong>${m.name}</strong>${m.from && html`<span class="meta">${host(m.from)}</span>`}</span>
    ${ROLE_NAMES[m.role] && html`<span class="badge as-written">${ROLE_NAMES[m.role]}</span>`}
    ${friendship(m)}
    ${actions}
  </li>`;
  // Buttons for an admin: what they can do about someone (only the owner deals with admins).
  const choices = (m) => {
    if (!runs(g) || m.id === null || m.role === "owner" || m.from === ctx.url.origin) return [];
    if (m.waiting) return [["approve", "Let in", true], ["decline", "Decline"]];
    if (m.role === "admin") return owner ? [["member", "Stop being admin"], ["remove", "Remove"]] : [];
    return [...(owner ? [["admin", "Make admin"]] : []), ["remove", "Remove"]];
  };
  const decide = (m) => {
    const list = choices(m);
    return list.length > 0 && html`<form method="post" class="actions-row">
      ${list.map(([action, label, primary]) => html`<button class="chip${primary ? " primary" : ""}" formaction="/_groups/${g.id}/members/${m.id}/${action}"
        ${action === "remove" && raw(`data-confirm="Remove them from the group? What they posted stays." data-confirm-ok="Remove"`)}>${label}</button>`)}
    </form>`;
  };
  const waiting = members.filter((m) => m.waiting);
  const inGroup = members.filter((m) => !m.waiting);
  return page(ctx, `${info.name}: members`, html`
${groupHead(ctx, g, info, "members")}
${owner && html`<p class="meta jump">You started this group: <a href="#about">change its name or description</a> ·
  <a href="#delete">delete it</a>.</p>`}
${runs(g) && html`<section class="card" id="invite">
  <h2>Invite people</h2>
  <p class="meta">Make a link and send it to people who have an afterwrd site: they paste it into <b>Groups</b> on their
  own site. Anyone with it can ask to join for the next 14 days, and the group's admins decide who's in. Making a new
  link stops the old one working.</p>
  <div class="actions-row"><button class="chip primary" id="make">Make an invite link</button></div>
  <div id="link" hidden>
    <input id="link-url" readonly aria-label="Invite link">
    <div class="actions-row"><button class="chip primary" id="copy">Copy link</button></div>
  </div>
  <p id="invite-error" role="alert"></p>
</section>`}
${waiting.length > 0 && html`<section class="requests">
  <h2>Asking to join</h2>
  <ul class="member-list">${waiting.map((m) => person(m, decide(m)))}</ul>
</section>`}
<h2>Members <span class="meta">${inGroup.length}${runs(g) && ` of up to ${max + 1}`}</span></h2>
<ul class="member-list">${inGroup.map((m) => person(m, decide(m)))}</ul>
${runs(g) && html`<section class="card" id="about">
  <h2>Name and description</h2>
  <form class="stack" method="post" action="/_groups/${g.id}/about">
    <input name="name" required maxlength="100" value="${info.name}" aria-label="Group name">
    <textarea name="about" rows="2" maxlength="1000" placeholder="What it's for (optional)" aria-label="What it's for">${info.about ?? ""}</textarea>
    <div class="actions-row"><button class="chip">Save</button></div>
  </form>
</section>
<section class="card" id="here">
  <h2>@here</h2>
  <p class="meta">Writing @here in a post or comment tells everyone in the group, on their phones if they've said yes to
  mentions. A few times a day at most.</p>
  <form method="post" action="/_groups/${g.id}/here">
    <label><input type="checkbox" name="anyone" value="1"${info.hereAnyone && " checked"}> Anyone in the group can use it
      (otherwise only you${g.role === "owner" ? " and the admins" : ", the owner and the other admins"})</label>
    <div class="actions-row"><button class="chip">Save</button></div>
  </form>
</section>`}
${owner ? html`<section class="card" id="delete">
  <h2>Delete the group</h2>
  <p class="meta">Everything in it goes, for everyone: posts, photos and comments, and the group's site itself.
  Members' sites are told. This can't be undone.</p>
  ${g.script ? connectField(connected, "to delete the group's site", `/groups/${g.id}/members`) : ""}
  <div class="actions-row"><button class="chip" id="delete-go">Delete the group</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</section>` : html`<form method="post" action="/_groups/${g.id}/leave" data-confirm="Leave this group? What you posted in it stays there." data-confirm-ok="Leave">
  <button class="chip">Leave the group</button>
</form>`}
<script>${raw(STEP_SCRIPT)}
  const linkUrl = document.getElementById("link-url");
  document.getElementById("make")?.addEventListener("click", async () => {
    const problem = document.getElementById("invite-error");
    problem.textContent = "";
    try {
      linkUrl.value = (await post("/_groups/${raw(String(g.id))}/link")).link;
      document.getElementById("link").hidden = false;
      linkUrl.select();
    } catch (err) { problem.textContent = err.message; }
  });
  document.getElementById("copy")?.addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(linkUrl.value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy link"; }, 1500);
  });
  document.getElementById("delete-go")?.addEventListener("click", async (e) => {
    if (!(await askFirst("Delete this group and everything in it, for everyone? This can’t be undone.", { ok: "Delete" }))) return;
    e.target.disabled = true;
    error.textContent = "";
    try {
      log("Deleting the group…");
      await post("/_groups/${raw(String(g.id))}/delete", { token: token() });
      location.assign("/groups");
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });
</script>`);
}

export function groupProblem(ctx, { membership: g, message }) {
  const waiting = /^Waiting for /.test(message);
  const gone = /^Not a member/.test(message);
  return page(ctx, g.name, html`
${groupHead(ctx, g, null, "")}
<p class="notice">${waiting ? message : gone ? "You're no longer in this group, or it's been deleted."
    : html`Couldn't load this from ${host(g.origin)}: ${message}`}</p>
${g.role !== "owner" && html`<form method="post" action="/_groups/${g.id}/leave">
  <button class="chip">${waiting ? "Cancel the request" : gone ? "Remove it from your groups" : "Leave the group"}</button>
</form>`}`);
}
