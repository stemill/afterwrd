// A connected friend's posts and photos, read from their site (friends.js, feed.js), and Friends. Views only draw:
// they read nothing and change nothing.
import { verdict } from "../checks.js";
import { resultHtml } from "./checks.js";
import { MAX_COMMENT } from "../archive/comments.js";
import { aspect, dateRange, fmtAgo, fmtDate, fmtDatetime, linkify, number, safeUrl, summary } from "./format.js";

import { icon, initial } from "./nav.js";
import { gone } from "../feed.js";
import { host } from "../peers.js";
import { now } from "../util.js";
import { html, raw } from "./html.js";
import { friendEventBlock } from "./events.js";
import { layout, page } from "./layout.js";
import { editBox, edited, feed, has, menuDelete, menuEdit, moreMenu, ownerFace, pager, pollBlock, said } from "./parts.js";

// --- a connected friend's posts and photos, read from their site (friends.js) ----------------------------------

export const friendBase = (c) => `/friend/${c.id}`;

/** A photo or video from a friend's site: its signed link loads straight from there. */
export function remoteMedia(m, { full = false } = {}) {
  if (m.kind === "video") {
    return full ? html`<video src="${m.src}" controls autoplay playsinline preload="metadata"></video>`
      : html`<video src="${m.src}#t=0.5" preload="metadata" muted playsinline></video><span class="play" aria-hidden="true"></span>`;
  }
  return html`<img src="${full ? m.src : m.thumbSrc}" ${full && html`style="background-image: url('${m.thumbSrc}')"`} loading="${full ? "eager" : "lazy"}"
    alt="${m.description || ""}" ${m.width && html`width="${m.width}" height="${m.height}"`}>`;
}

/** Comments on a friend's post or photo; yours are sent to their site (feed.js), which keeps them. */
function remoteThread(ctx, c, target, comments, { region = false } = {}) {
  if (!comments) return ""; // from their Facebook download: no comments
  const back = ctx.url.pathname + ctx.url.search;
  return html`<section class="thread" id="t-${target}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((r) => html`<div class="comment" id="r${c.id}-${r.id}"${!r.mine && r.from && html` data-who="${r.from}" data-name="${r.name}"`}>
    ${r.mine ? ownerFace(ctx) : r.from ? faceFor(ctx, r.from, r.name, r.id) : friendFace(ctx, c)}
    <div class="bubble"><strong>${r.mine ? ctx.user.name : r.name}</strong>${!r.mine && notFriend(ctx, r.from)}<span class="said">${linkify(r.text, said(r))}</span></div>
    <div class="under">
      <time title="${fmtDatetime(r.created_at)}">${fmtAgo(r.created_at)}</time>
      ${r.mine && moreMenu([r.editable && menuEdit(`edit-r${c.id}-${r.id}`),
        menuDelete(`/_feed/comments/${c.id}/${r.id}/delete`, "Delete this comment?", { back, inplace: "refresh" })])}
    </div>
    ${edited(r)}
    ${r.mine && r.editable && editBox(`edit-r${c.id}-${r.id}`, `r${c.id}-${r.id}`, `/_feed/comments/${c.id}/${r.id}/edit`, r.text, back, MAX_COMMENT)}
  </div>`)}
  <form class="say" method="post" action="/_feed/comments" data-inplace data-me="${ctx.user.name}"
    data-owner-who="${c.origin}" data-owner-name="${c.name}">
    <input type="hidden" name="connection" value="${c.id}">
    <input type="hidden" name="target" value="${target}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="comment:${c.id}:${target}" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

/** A post from a friend's site, on Home or on their posts page. */
/** A friend's profile picture, or the first letter of their name. */
export const friendFace = (ctx, c) => faceFor(ctx, c.origin, c.name, c.id, c.avatar?.thumbSrc);

/**
 * The site of someone who isn't a friend, beside their name on a post or comment, so a look-alike of a friend's name
 * stands out. Friends' addresses are left off (they're on their page) to keep things uncluttered.
 */
export function notFriend(ctx, origin, cls = "from") {
  return origin && !Object.hasOwn(ctx.friendFaces ?? {}, origin) ? html`<span class="${cls}">${host(origin)}</span>` : "";
}

/** Someone from another site: the picture their site gave (just now, or remembered), or their initial. */
export function faceFor(ctx, origin, name, n, fresh = null) {
  const picture = fresh ?? ctx.friendFaces?.[origin];
  return picture ? html`<img class="who" src="${picture}" alt="" aria-hidden="true">`
    : html`<span class="who who-${n % 6}" aria-hidden="true">${initial(name)}</span>`;
}

/** `back`: where ✕ on one of its photos comes back to (this page and the post on it, unless said otherwise). */
export function remoteCard(ctx, c, p, { thread = true, back = `${ctx.url.pathname}${ctx.url.search}#f${c.id}-${p.key}` } = {}) {
  const n = p.photos.length;
  const stay = `?${new URLSearchParams({ in: "post", back })}`;
  const what = p.title && p.title !== "Posted on afterwrd." ? summary(p.title, c.name) : "";
  // An event's card comes back from its own page (only sites new enough for events have one).
  return html`<article class="card social from-friend" id="f${c.id}-${p.key}" data-region="${friendBase(c)}/posts${p.event ? `/${p.key}` : ""}"
  data-who="${c.origin}" data-name="${c.name}">
  <header>
    ${friendFace(ctx, c)}
    <span class="what"><a href="${friendBase(c)}/posts"><strong>${c.name}</strong></a>
      ${what && html`<span class="meta">${what}</span>`}</span>
    <time title="${fmtDatetime(p.created_at)}">${fmtAgo(p.created_at)}</time>
  </header>
  ${p.text && html`<div class="text">${linkify(p.text, said(p))}</div>`}
  ${edited(p)}
  ${p.poll && pollBlock(ctx, p.poll, { id: `poll-f${c.id}-${p.key}`, action: "/_feed/vote", hidden: { connection: c.id, target: p.key } })}
  ${p.event && friendEventBlock(ctx, c, p, { full: ctx.url.pathname === `${friendBase(c)}/posts/${p.key}` })}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${p.photos.slice(0, 4).map((m, i) => html`
      <a href="${friendBase(c)}/photos/${m.hash}${stay}" class="tile" ${n === 1 && m.kind === "photo" && html`style="--bg-img: url('${m.thumbSrc}')"`}>
        ${remoteMedia(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`}
  ${safeUrl(p.link_url) && !(p.text || "").includes(p.link_url) &&
    html`<p class="link"><a href="${p.link_url}" target="_blank" rel="noopener noreferrer">${p.link_url}</a></p>`}
  ${p.place && html`<p class="meta">📍 ${p.place}</p>`}
  ${p.tags?.length > 0 && html`<p class="meta">With ${p.tags.join(", ")}</p>`}
  ${thread && remoteThread(ctx, c, p.key, p.comments)}
</article>`;
}

/** Why someone's asking to be friends: a group they're both in, a friend's introduction, or a link the owner made. */
export function askedBecause(r) {
  if (r.via_kind === "group") return html`They're in <strong>${r.via_name}</strong> with you.`;
  if (r.via_kind === "introduction") return html`Introduced by <strong>${r.via_name}</strong>.`;
  return r.invited_as ? html`Used the invite you made for <strong>${r.invited_as}</strong>.` : "Used a friend link you made.";
}

/** A friend introducing the owner to someone, with a way to ask them (or not), landing back on `back`. */
export function introductionCard(i, back, tag = "li") {
  return html`<${raw(tag)} class="${tag === "li" ? "card" : "notice introduction"}">
    <span><strong>${i.by_name}</strong> introduced you to <strong>${host(i.origin)}</strong>, who they call ${i.name}${i.note && html`:
      “${i.note}”`}</span>
    <form method="post" class="row actions-row">
      <input type="hidden" name="origin" value="${i.origin}"><input type="hidden" name="introduction" value="1">
      <input type="hidden" name="back" value="${back}">
      <button class="chip primary" formaction="/_admin/connections/ask">Ask to be friends</button>
      <button class="chip" formaction="/_admin/connections/introductions/${i.id}/dismiss${back === "/" ? "?back=home" : ""}">Not now</button>
    </form>
  </${raw(tag)}>`;
}

/** The owner's Friends: friends on afterwrd first, then everyone from the Facebook download, in one list. */
export function friendsIndexPage(ctx, { friends, facebook, requests = [], introductions = [], checks = [] }) {
  const people = has(ctx, "friends"); // Facebook people have pages only if the friends list is published
  const fbLink = (p) => (people && p.id ? html`<a href="/people/${p.id}">${p.name}</a>` : p.name);
  const linkForm = (c, body) => html`<form method="post" action="/_admin/connections/${c.id}/facebook" class="fb-link">${body}</form>`;
  return page(ctx, "Friends", html`
<div class="feed-head">
  <h1>Friends</h1>
  <a class="chip primary" href="/_admin/connections">${raw(icon("connections"))}<span>Add a friend</span></a>
</div>
<p class="meta">Only you see this page.${friends.filter((f) => f.reached_at).length >= 3
  ? html` <a href="/_admin/connections/together">Introduce friends to each other</a>.` : ""}</p>

${requests.length > 0 && html`
<h2>Asking to be friends</h2>
<p class="meta">Nothing is shared until you approve. Links can be passed on, and anyone can call their site anything,
so check the address is one you expect; if not, decline.</p>
<ul class="friend-list requests">
  ${requests.map((r) => html`<li class="card">
    <span class="friend-link"><span class="who who-${r.id % 6}" aria-hidden="true">${initial(r.name)}</span>
      <span><strong>${host(r.origin)}</strong><span class="meta">says they're ${r.name}</span></span></span>
    <p class="meta">${askedBecause(r)}
      ${r.invited_as && r.invited_as.toLowerCase() !== r.name.toLowerCase() && html`<strong class="warn">That's not the name you invited.</strong>`}</p>
    <form method="post" class="fb-link">
      <button class="chip primary" formaction="/_admin/connections/${r.id}/approve">Approve</button>
      <button class="chip danger" formaction="/_admin/connections/${r.id}/decline" data-confirm="Decline? Their site will be told no." data-confirm-ok="Decline">Decline</button>
    </form>
  </li>`)}
</ul>`}

${introductions.length > 0 && html`<section id="introductions">
<h2>Introductions</h2>
<p class="meta">Friends who think you'd like to know someone. Only you see these, and the other person can't ask
you to be friends unless you ask them first or they were introduced to you too.</p>
<ul class="friend-list">${introductions.map((i) => introductionCard(i, "/friend"))}</ul>
</section>`}

<h2>On afterwrd</h2>
${friends.length ? html`<ul class="friend-list">
  ${friends.map((c) => html`<li class="card">
    <a class="friend-link" href="${friendBase(c)}/posts">
      ${friendFace(ctx, c)}
      <span><strong>${c.name}</strong><span class="meta">Friends since ${fmtDate(c.connected_at)}</span></span>
    </a>
    <nav class="friend-tabs"><a href="${friendBase(c)}/posts">Posts</a><a href="${friendBase(c)}/photos">Photos</a>${friends.length > 1
      && html`<a href="/_admin/connections/${c.id}/introduce">Introduce</a>`}</nav>
    ${friendSilence(c) && html`<div class="meta silent">${friendSilence(c)} ${removeFriend(c, "chip")}</div>`}
    ${c.person ? linkForm(c, html`<span class="meta">On Facebook as ${fbLink(c.person)}</span>
        <input type="hidden" name="unlink" value="1"><button class="link">Unlink</button>`)
      : c.suggestion ? linkForm(c, html`<span>Is this <strong>${c.suggestion.name}</strong> from your Facebook download?</span>
        <input type="hidden" name="name" value="${c.suggestion.name}"><button class="chip">Yes</button>
        <button class="chip" name="none" value="1">No</button>`)
      : facebook.length > 0 && html`<details class="fb-pick"><summary class="meta">Link to someone from your Facebook download</summary>
        ${linkForm(c, html`<input name="name" list="fb-names" required placeholder="Their name on Facebook" aria-label="Their name on Facebook">
          <button class="chip">Link</button>`)}</details>`}
  </li>`)}
</ul>` : html`<div class="empty">
  <p>No friends on afterwrd yet. When a friend has their own afterwrd site, connect with them to see each other's posts and photos.</p>
  <a class="chip primary" href="/_admin/connections">${raw(icon("connections"))}<span>Add a friend</span></a>
</div>`}

<h2 id="checks">Checking a friend's site</h2>
<p class="meta">When a friend on afterwrd asks you to check their site, their request shows on <a href="/">Home</a>, with a
button that makes the link to send back to them. If someone asks by message instead, paste it, or just their site's
address, here. They open the link and allow read-only access in Cloudflare, and your site checks theirs is exactly the
published afterwrd, with nothing else done in their account. You both see what it found. The link goes back by message,
not between the sites, so a site that had been tampered with couldn't swap it for a fake.</p>
<form class="check-form" onsubmit="return false">
  <input id="check-site" placeholder="Their message, or their site's address" aria-label="Their message, or their site's address">
  <button class="chip" data-check="">Make a check link</button>
</form>
<section class="card invite-panel" id="check-panel" hidden>
  <h2>Send this to your friend</h2>
  <textarea id="check-message" readonly rows="6" aria-label="Check message"></textarea>
  <p class="row"><button class="chip primary" id="check-copy">Copy message</button>
    <button class="chip" id="check-done">Done</button></p>
</section>
<p class="error" id="check-error" role="alert"></p>
${checks.length > 0 && html`<ul class="friend-list checks">
  ${checks.map((k) => html`<li class="card">
    <div class="check-head"><strong>${k.site ? host(k.site) : "Not opened yet"}</strong>
      <span class="meta">${k.friend ? html`${k.friend} · ` : ""}${k.checked_at ? html`checked ${fmtDate(k.checked_at)}`
        : k.result ? "check not finished" : k.expires_at > now() ? html`link made ${fmtDate(k.created_at)}, not used yet` : "link expired unused"}</span>
      ${verdict(k.result) && html`<span class="badge ${verdict(k.result) === "all good" ? "" : "badge-new"}">${verdict(k.result)}</span>`}</div>
    ${k.result && html`<details><summary class="meta">What it found</summary><div class="check-result">${raw(resultHtml(k.result))}</div></details>`}
    <form method="post" action="/_admin/checks/${k.id}/delete"><button class="link">Forget</button></form>
  </li>`)}
</ul>`}
<script>
  // Check a friend's site: make a one-time link (for that friend, or for whoever it's sent to) and a message to send.
  const checkPanel = document.getElementById("check-panel");
  document.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-check]");
    if (!button) return;
    button.disabled = true;
    document.getElementById("check-error").textContent = "";
    try {
      const res = await fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: document.getElementById("check-site").value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      document.getElementById("check-message").value = data.message;
      checkPanel.hidden = false;
      checkPanel.scrollIntoView({ block: "center" });
    } catch (err) {
      document.getElementById("check-error").textContent = err.message;
    }
    button.disabled = false;
  });
  document.getElementById("check-copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(document.getElementById("check-message").value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy message"; }, 1500);
  });
  document.getElementById("check-done").addEventListener("click", () => location.reload());
</script>

${facebook.length > 0 && html`
<h2>From your Facebook download</h2>
<form class="filters" onsubmit="return false">
  <input type="search" id="fb-filter" placeholder="Search names" aria-label="Search names">
</form>
<table class="numbers people" id="fb-people">
  <thead><tr><th>Name</th><th>Friends since</th><th>afterwrd</th></tr></thead>
  <tbody>
    ${facebook.map((p) => html`<tr>
      <th>${fbLink(p)}</th>
      <td>${fmtDate(p.friend_since)}</td>
      <td>${p.friend ? html`<a class="badge as-written" href="${friendBase(p.friend)}/posts">On afterwrd</a>`
        : p.asking ? html`<span class="badge badge-new as-written">Asking to be friends</span>`
          : p.invited ? html`<span class="meta">Invited ${fmtDate(p.invited)}</span> <button class="link" data-invite="${p.name}">New link</button>`
            : html`<button class="chip" data-invite="${p.name}">Invite</button>`}</td>
    </tr>`)}
  </tbody>
</table>
<section class="card invite-panel" id="invite" hidden>
  <h2>Invite <span id="invite-name"></span> to afterwrd</h2>
  <p class="meta">Send this however you like. Their link works once, for 30 days; when they use it you'll be asked to
  approve, and they'll be linked to this name here.</p>
  <textarea id="invite-message" readonly rows="5" aria-label="Invitation message"></textarea>
  <p class="row"><button class="chip primary" id="invite-copy">Copy message</button>
    <button class="chip" id="invite-share" hidden>Share…</button>
    <button class="chip" id="invite-done">Done</button></p>
  <p class="error" id="invite-error" role="alert"></p>
</section>
<datalist id="fb-names">${facebook.map((p) => html`<option value="${p.name}">`)}</datalist>
<script>
  document.getElementById("fb-filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const row of document.querySelectorAll("#fb-people tbody tr")) row.hidden = q && !row.cells[0].textContent.toLowerCase().includes(q);
  });
  // Invite: make a friend link for that person and show a message to send them.
  const panel = document.getElementById("invite");
  const message = document.getElementById("invite-message");
  document.getElementById("fb-people").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-invite]");
    if (!button) return;
    button.disabled = true;
    document.getElementById("invite-error").textContent = "";
    try {
      const res = await fetch("/_admin/connections/invite", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: button.dataset.invite }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      document.getElementById("invite-name").textContent = data.name;
      message.value = data.message;
      panel.hidden = false;
      panel.scrollIntoView({ block: "center" });
      message.select();
    } catch (err) {
      document.getElementById("invite-error").textContent = err.message;
      panel.hidden = false;
    }
    button.disabled = false;
  });
  document.getElementById("invite-copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(message.value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy message"; }, 1500);
  });
  const share = document.getElementById("invite-share");
  if (navigator.share) {
    share.hidden = false;
    share.addEventListener("click", () => navigator.share({ text: message.value }).catch(() => {}));
  }
  document.getElementById("invite-done").addEventListener("click", () => location.reload());
</script>`}`);
}

/** Remove a friend: both sites forget each other (connect.js). `look` is the button's class. */
function removeFriend(c, look) {
  return html`<form method="post" action="/_admin/connections/${c.id}/disconnect" class="inline"
    data-confirm="Remove ${c.name} as a friend? You'll stop seeing each other's posts and photos. Comments already made stay where they are."
    data-confirm-ok="Remove"><button class="${look}">Remove friend</button></form>`;
}

/** Why a friend's site isn't being heard from, once it's gone quiet (feed.js), or null. */
function friendSilence(c) {
  if (c.said_no) return html`Their site says you're no longer connected, so ${c.name} may have removed you as a friend.`;
  if (!gone(c)) return null;
  return html`Their site hasn't answered since ${fmtDate(c.reached_at ?? c.connected_at)}. It may be offline, or gone for good.`;
}

function friendHead(ctx, c, tab) {
  return html`
<p class="crumbs"><a href="/friend">Friends</a> /</p>
${c.cover && html`<section class="profile"><div class="cover"><img src="${c.cover.src}" alt=""></div></section>`}
<div class="feed-head">
  <h1 class="friend-name">${c.avatar && html`<img class="avatar-small" src="${c.avatar.thumbSrc}" alt="">`}${c.name}</h1>
  ${c.facebook && has(ctx, "friends") && html`<a class="chip" href="/people/${c.facebook.id}">${raw(icon("friends"))}<span>Your Facebook history together</span></a>`}
</div>
<div class="meta">${host(c.origin)} · a friend you're connected with. Only you see this here. ${removeFriend(c, "link")}</div>
<nav class="tabs">
  ${[["posts", "Posts"], ["photos", "Photos"]].map(([key, label]) =>
    html`<a href="${friendBase(c)}/${key}" ${key === tab && raw('aria-current="page"')}>${label}</a>`)}
</nav>`;
}

/** One of a friend's posts, on its own: an event they invited the owner to, say. */
export function friendPostPage(ctx, { friend: c, post: p }) {
  return page(ctx, p.event?.title ?? c.name, html`
${friendHead(ctx, c, "posts")}
<div class="feed">${remoteCard(ctx, c, p)}</div>`);
}

export function friendPostsPage(ctx, { friend: c, posts, paging }) {
  return page(ctx, c.name, html`
${friendHead(ctx, c, "posts")}
${feed(posts, (p) => remoteCard(ctx, c, p), "Nothing posted yet.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

export function friendPhotosPage(ctx, { friend: c, albums }) {
  return page(ctx, `${c.name}: photos`, html`
${friendHead(ctx, c, "photos")}
${albums.length ? html`<div class="albums">
  ${albums.map((a) => html`
  <a class="album" href="${friendBase(c)}/photos/album/${a.key}">
    <div class="cover">${a.cover && (a.cover.kind === "video"
      ? html`<video src="${a.cover.src}#t=0.5" preload="metadata" muted playsinline></video>`
      : html`<img src="${a.cover.thumbSrc}" loading="lazy" alt="">`)}</div>
    <div class="label">
      <strong>${a.name}</strong>
      <span>${number(a.count)} · ${dateRange(a.first_ts, a.last_ts)}</span>
    </div>
  </a>`)}
</div>` : html`<p class="empty">No photos yet.</p>`}`, "wide");
}

export function friendAlbumPage(ctx, { friend: c, album }) {
  return page(ctx, album.name, html`
<p class="crumbs"><a href="${friendBase(c)}/photos">${c.name}'s photos</a> /</p>
<header class="album-head">
  <h1>${album.name}</h1>
  <p class="meta">${number(album.total)} · ${dateRange(album.first_ts, album.last_ts)}</p>
  ${album.description && html`<p>${album.description}</p>`}
</header>
<div class="justified">
  ${album.media.map((m) => html`<a href="${friendBase(c)}/photos/${m.hash}" class="tile" style="--r: ${aspect(m)}" title="${fmtDate(m.created_at)}">${remoteMedia(m)}</a>`)}
</div>
${(album.paging.page > 1 || album.paging.hasNext) && pager(ctx, album.paging)}`, "wide");
}

/** A friend's photo: among its album, or (m.inPost, opened from their post) among that post's photos. */
export function friendPhotoPage(ctx, { friend: c, photo: m }) {
  const album = m.album ? `${friendBase(c)}/photos/album/${m.album.key}` : `${friendBase(c)}/photos`;
  const set = m.inPost ?? { ...m.album, prev: m.prev, next: m.next, back: album, stay: "" };
  const main = html`
<main class="theatre">
  <section class="stage">
    ${remoteMedia(m, { full: true })}
    <a class="close" id="close" href="${set.back}" title="Back (Esc)" aria-label="${m.inPost ? "Back to the post" : "Back to album"}">✕</a>
    ${set.total && html`<span class="counter">${set.index} / ${set.total}</span>`}
    ${set.prev && html`<a class="nav prev" id="prev" href="${friendBase(c)}/photos/${set.prev}${set.stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${set.next && html`<a class="nav next" id="next" href="${friendBase(c)}/photos/${set.next}${set.stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="${album}">${m.album?.name ?? `${c.name}'s photos`}</a>
    <time class="when">${fmtDatetime(m.created_at)}</time>
    <p class="meta"><a href="${friendBase(c)}/posts">${c.name}</a></p>
    ${m.description && !(m.post && m.post.text === m.description) && html`<div class="caption">${linkify(m.description)}</div>`}
    <h2>Comments</h2>
    ${remoteThread(ctx, c, `photo-${m.hash}`, m.comments, { region: true })}
    ${m.post && html`<h2>Posted with</h2>${remoteCard(ctx, c, m.post, { thread: false, back: m.inPost?.back ?? `${friendBase(c)}/posts#f${c.id}-${m.post.key}` })}`}
  </aside>
</main>
<script>
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: m.album?.name ?? c.name, bodyClass: "viewer", main });
}

export function friendProblem(ctx, { friend: c, message }) {
  return page(ctx, c.name, html`
${friendHead(ctx, c, "")}
<p class="notice">${friendSilence(c) ?? html`Couldn't load this from ${c.name}'s site: ${message}`}</p>`);
}
