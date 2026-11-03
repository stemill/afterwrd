// Page templates, ported from afterwrd/templates. `ctx` carries me, the published sections, the signed-in user
// and the request URL.
import { MAX_COMMENT } from "./comments.js";
import {
  aspect, dateRange, EMOJI, fmtAgo, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl,
} from "./format.js";
import { asset, icon, OWNER_ITEMS, siteHeader } from "../nav.js";
import { host } from "../peers.js";
import { SITE_ID } from "../posts.js";
import { html, raw } from "./html.js";

const NAV = [["", "Overview", "overview"], ["timeline", "Timeline", "timeline"], ["posts", "Posts", "posts"],
  ["photos", "Photos", "photos"], ["comments", "Comments", "comments"], ["likes", "Likes", "likes"],
  ["friends", "Friends", "friends"]];

// --- layout ------------------------------------------------------------------

function layout(ctx, { title, bodyClass = "", main }) {
  const top = ctx.url.pathname.split("/")[1];
  const currentSection = ctx.user.is_owner
    ? { "": "overview", people: "connected", friends: "connected", friend: "connected" }[top] ?? top
    : { "": "overview", people: "friends" }[top] ?? top;
  return html`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · afterwrd</title>
  <link rel="stylesheet" href="${asset("/static/style.css")}">
  <link rel="icon" href="data:,">
</head>
<body class="${bodyClass}">
  ${raw(siteHeader(navItems(ctx), currentSection))}
  ${main}
</body>
</html>`;
}

function navItems(ctx) {
  const items = NAV.filter(([, , s]) => ctx.sections.includes(s)).map(([path, label, key]) => ({ key, label, href: `/${path}` }));
  items.push({ key: "activity", label: "Activity", href: "/activity", badge: ctx.newComments });
  if (ctx.user.is_owner) {
    // One Friends for the owner: friends on afterwrd and from Facebook together (/friend). Visitors keep the
    // published Facebook list.
    const tools = OWNER_ITEMS.map((i) => (i.key === "update" && ctx.updateWaiting ? { ...i, label: "Update available", badge: true } : i));
    return [{ key: "feed", label: "Feed", href: "/feed" }, { key: "connected", label: "Friends", href: "/friend" },
      ...items.filter((i) => i.key !== "friends"), ...tools];
  }
  return items;
}

const page = (ctx, title, content, bodyClass = "") =>
  layout(ctx, { title, bodyClass, main: html`<main>${content}</main>` });

// --- pieces (_macros.html) ---------------------------------------------------

const has = (ctx, section) => ctx.sections.includes(section);

function personLink(ctx, id, name) {
  if (id === ctx.me.id) return "you";
  if (id && has(ctx, "friends")) return html`<a href="/people/${id}">${name}</a>`;
  return name;
}

function ownerPhrase(ctx, ownerId, ownerName, authorId = null) {
  if (ownerId && (ownerId === ctx.me.id || ownerId === authorId)) return "your own";
  if (ownerId && has(ctx, "friends")) return html`<a href="/people/${ownerId}">${ownerName}</a>'s`;
  if (ownerId) return `${ownerName}'s`;
  return "a";
}

function mediaImg(m) {
  if (m.kind === "video") {
    return html`<video src="${mediaUrl(m)}#t=0.5" preload="metadata" muted playsinline></video><span class="play" aria-hidden="true"></span>`;
  }
  return html`<img src="${thumbUrl(m)}" loading="lazy" alt="${m.description || ""}" ${m.width && html`width="${Number(m.width)}" height="${Number(m.height)}"`}>`;
}

/** Rows of photos at a shared height, each keeping its own shape (like Google Photos). */
function justified(items) {
  return html`<div class="justified">
  ${items.map((m) => html`<a href="/photos/${m.id}" class="tile" style="--r: ${aspect(m)}" title="${fmtDate(m.timestamp)}">${mediaImg(m)}</a>`)}
</div>`;
}

/** Facebook-style layout for the photos attached to a post or comment. */
function collage(items) {
  if (!items?.length) return "";
  const n = items.length;
  return html`<div class="collage collage-${Math.min(n, 4)}">
    ${items.slice(0, 4).map((m, i) => html`
      <a href="/photos/${m.id}" class="tile" ${n === 1 && m.kind === "photo" && html`style="--bg-img: url('${thumbUrl(m)}')"`}>
        ${mediaImg(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`;
}

const initial = (name) => [...String(name).trim()][0]?.toUpperCase() ?? "?";

/** The comments written here on a post or photo, then a box to add one. Forms work without JavaScript. */
function thread(ctx, key, comments) {
  const back = ctx.url.pathname + ctx.url.search;
  const canDelete = (c) => c.author_id === ctx.user.id || Boolean(ctx.user.is_owner);
  return html`<section class="thread" id="t-${key}" aria-label="Comments">
  ${comments.map((c) => html`<div class="comment" id="c${c.id}">
    <span class="who who-${(c.author_id ?? 0) % 6}" aria-hidden="true">${initial(c.name)}</span>
    <div class="bubble"><strong>${c.name}</strong>${c.origin && c.origin !== "site" && html`<span class="from">${host(c.origin)}</span>`}<span class="said">${linkify(c.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${canDelete(c) && html`<form method="post" action="/_comments/${c.id}/delete" onsubmit="return confirm('Delete this comment?')">
        <input type="hidden" name="back" value="${back}"><button>Delete</button>
      </form>`}
    </div>
  </div>`)}
  <form class="say" method="post" action="/_comments">
    <input type="hidden" name="target" value="${key}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

function postCard(ctx, p) {
  let what;
  if (p.kind === "wall") what = html`Wrote on ${personLink(ctx, p.target_id, p.target_name)}'s profile`;
  else if (p.kind === "group") what = html`Posted in <em>${p.group_name}</em>`;
  else what = summary(p.title, ctx.me.name);
  return html`<article class="card">
  <header>
    <span class="badge badge-${p.kind}">${p.kind}</span>
    <span class="what">${what}</span>
    ${p.thread ? html`<a class="when" href="/posts/${p.key}" title="Link to this post"><time>${fmtDatetime(p.timestamp)}</time></a>`
      : html`<time>${fmtDatetime(p.timestamp)}</time>`}
    ${ctx.user.is_owner && p.id >= SITE_ID && p.thread && html`<form method="post" action="/_admin/posts/${p.id}/delete"
      onsubmit="return confirm('Delete this post, its photos and its comments? This can’t be undone.')"><button class="delete">Delete</button></form>`}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${collage(p.media)}
  ${safeUrl(p.link_url) && !(p.text || "").includes(p.link_url) &&
    html`<p class="link"><a href="${p.link_url}" target="_blank" rel="noopener noreferrer">${p.link_url}</a></p>`}
  ${p.place_name && html`<p class="meta">📍 ${p.place_name}${p.place_address && `, ${p.place_address}`}</p>`}
  ${p.tags?.length > 0 && html`<p class="meta">With ${p.tags.map((t, i) => html`${personLink(ctx, t.id, t.name)}${i < p.tags.length - 1 && ", "}`)}</p>`}
  ${p.thread && thread(ctx, p.key, p.thread)}
</article>`;
}

function commentCard(ctx, c) {
  const what = c.target_kind
    ? html`${c.action === "replied" ? "Replied to" : "Commented on"} ${ownerPhrase(ctx, c.target_owner_id, c.owner_name, c.author_id)} ${c.target_kind}${c.group_name && html` in <em>${c.group_name}</em>`}`
    : summary(c.title, ctx.me.name);
  return html`<article class="card">
  <header>
    <span class="badge badge-comment">${c.action === "replied" ? "reply" : "comment"}</span>
    <span class="what">${what}</span>
    <time>${fmtDatetime(c.timestamp)}</time>
  </header>
  ${!c.author_is_me && c.author_name && html`<p class="meta">Posted anonymously as ${c.author_name}</p>`}
  ${c.text ? html`<div class="text">${linkify(c.text)}</div>`
    : html`<p class="meta">Facebook didn't include the text of this comment in the export.</p>`}
  ${collage(c.media)}
  ${safeUrl(c.link_url) && !(c.text || "").includes(c.link_url) &&
    html`<p class="link"><a href="${c.link_url}" target="_blank" rel="noopener noreferrer">${c.link_url}</a></p>`}
</article>`;
}

function reactionRow(ctx, r) {
  const verb = { Like: "Liked", Love: "Loved" }[r.reaction] ?? `Reacted ${r.reaction} to`;
  return html`<li class="reaction">
  <span class="emoji" title="${r.reaction}">${EMOJI[r.reaction] ?? "👍"}</span>
  <span class="what">${verb} ${ownerPhrase(ctx, r.target_owner_id, r.owner_name)} ${r.target_kind || "post"}${r.group_name && html` in <em>${r.group_name}</em>`}</span>
  <time>${fmtDatetime(r.timestamp)}</time>
  ${safeUrl(r.url) && html`<a class="out" href="${r.url}" target="_blank" rel="noopener noreferrer" title="Open on Facebook">↗</a>`}
</li>`;
}

function pageUrl(ctx, n) {
  const url = new URL(ctx.url);
  url.searchParams.set("page", n);
  return url.pathname + url.search;
}

function pager(ctx, { page, hasNext, total }) {
  return html`<nav class="pager">
  ${page > 1 ? html`<a href="${pageUrl(ctx, page - 1)}">← Previous</a>` : raw("<span></span>")}
  <span class="meta">${number(total)} total · page ${page}</span>
  ${hasNext ? html`<a href="${pageUrl(ctx, page + 1)}">Next →</a>` : raw("<span></span>")}
</nav>`;
}

// Like the original templates: a value attribute only when the label differs from it.
function options(values, selected, label = null) {
  return values.map((v) => (label
    ? html`<option value="${v}" ${v === selected && raw("selected")}>${label(v)}</option>`
    : html`<option ${v === selected && raw("selected")}>${v}</option>`));
}

function yearSelect(years, year, label = "All years") {
  return html`<select name="year" onchange="this.form.submit()">
  <option value="">${label}</option>
  ${options(years, year)}
</select>`;
}

const feed = (items, render, empty) =>
  html`<div class="feed">${items.length ? items.map(render) : html`<p class="empty">${empty}</p>`}</div>`;

// --- pages -------------------------------------------------------------------

export function overviewPage(ctx, { counts, byYear, topPeople }) {
  const link = (section, href, content) => (has(ctx, section) ? html`<a href="${href}">${content}</a>` : content);
  const me = ctx.me;
  return page(ctx, "Overview", html`
<section class="profile">
  ${me.cover_hash ? html`<a class="cover" href="/photos/${me.cover_media_id}"><img src="/files/${me.cover_hash}" alt="Cover photo"></a>`
    : raw('<div class="cover"></div>')}
  <div class="identity">
    ${me.profile_hash && html`<a class="avatar" href="/photos/${me.profile_media_id}"><img src="/files/${me.profile_hash}" alt="Profile picture"></a>`}
    <h1>${me.name}</h1>
  </div>
</section>

<ul class="counts">
  ${[["friends", "/friends", counts.friends, "friends"], ["posts", "/posts", counts.posts, "posts"],
    ["photos", "/photos", counts.media, raw("photos &amp; videos")], ["comments", "/comments", counts.comments, "comments"],
    ["likes", "/likes", counts.reactions, raw("likes &amp; reactions")],
    ["photos", "/photos/tagged", counts.tagged_photos, raw("photos you're tagged in")]]
    .map(([section, href, n, label]) => html`<li>${link(section, href, html`<strong>${number(n)}</strong> ${label}`)}</li>`)}
</ul>

<div class="columns">
  <section>
    <h2>By year</h2>
    <table class="numbers">
      <thead><tr><th>Year</th><th>Posts</th><th>Comments</th><th>Likes</th><th>Photos</th></tr></thead>
      <tbody>
        ${byYear.map((y) => html`<tr>
          <th>${link("timeline", `/timeline?year=${y.year}`, y.year)}</th>
          <td>${link("posts", `/posts?year=${y.year}`, y.posts || "")}</td>
          <td>${link("comments", `/comments?year=${y.year}`, y.comments || "")}</td>
          <td>${link("likes", `/likes?year=${y.year}`, y.reactions || "")}</td>
          <td>${y.photos || ""}</td>
        </tr>`)}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Who you interact with most</h2>
    <p class="meta">Comments and likes on their posts, photos and comments.</p>
    <table class="numbers">
      <thead><tr><th>Person</th><th>Comments</th><th>Likes</th></tr></thead>
      <tbody>
        ${topPeople.map((p) => html`<tr>
          <th>${personLink(ctx, p.id, p.name)}${!p.friend_since && has(ctx, "friends") && raw(' <span class="meta">not a friend</span>')}</th>
          <td>${p.comments}</td>
          <td>${p.reactions}</td>
        </tr>`)}
      </tbody>
    </table>
  </section>
</div>`);
}

export function timelinePage(ctx, { items, paging, years, year }) {
  return page(ctx, "Timeline", html`
<h1>Timeline</h1>
<form class="filters">${yearSelect(years, year)}</form>
<div class="feed">
  ${items.length ? items.map(([type, item]) =>
    type === "post" ? postCard(ctx, item)
      : type === "comment" ? commentCard(ctx, item)
        : html`<ul class="reactions">${reactionRow(ctx, item)}</ul>`) : raw('<p class="empty">Nothing here.</p>')}
</div>
${pager(ctx, paging)}`);
}

/** The owner's box for a new post, top of Posts. compose.js does the work; without it, it does nothing. */
function composer() {
  return html`<form class="card composer" id="composer">
  <textarea name="text" rows="2" maxlength="5000" placeholder="Write something, or add photos" aria-label="New post"></textarea>
  <ul class="picked" hidden></ul>
  <p class="error" role="alert"></p>
  <div class="actions">
    <label class="chip">${raw(icon("photos"))}<span>Add photos</span><input type="file" accept="image/*" multiple class="hidden"></label>
    <span class="status meta" role="status"></span>
    <button class="post">Post</button>
  </div>
</form>
<script type="module" src="${asset("/static/compose.js")}"></script>`;
}

/** The top of Posts, which is the owner's profile: cover, picture and name (with ways to change them, for the owner). */
function profileHeader(ctx) {
  const { profile, cover } = ctx.profile;
  const owner = ctx.user.is_owner;
  if (!profile && !cover) {
    return owner ? html`<p class="card profile-prompt">Make this page yours:
  <a class="chip" href="/_admin/photos/add?for=profile">Add a profile picture</a>
  <a class="chip" href="/_admin/photos/add?for=cover">Add a cover photo</a></p>` : "";
  }
  return html`<section class="profile">
  <div class="cover-wrap">
    ${cover ? html`<a class="cover" href="/photos/${cover.id}"><img src="/files/${cover.hash}" alt="Cover photo"></a>` : raw('<div class="cover"></div>')}
    ${owner && html`<a class="chip change-cover" href="/_admin/photos/add?for=cover">${cover ? "Change cover" : "Add a cover"}</a>`}
  </div>
  <div class="identity">
    ${profile ? html`<a class="avatar" href="/photos/${profile.id}"><img src="/files/${profile.thumb_hash ?? profile.hash}" alt="Profile picture"></a>`
      : owner && html`<a class="avatar empty" href="/_admin/photos/add?for=profile" title="Add a profile picture" aria-label="Add a profile picture">+</a>`}
    <div><p class="name">${ctx.me.name}</p>
      ${owner && profile && html`<a class="meta" href="/_admin/photos/add?for=profile">Change picture</a>`}</div>
  </div>
</section>`;
}

export function postsPage(ctx, { posts, paging, q, year, kind, years, kinds }) {
  const fresh = paging.page === 1 && !q && !year && !kind;
  return page(ctx, "Posts", html`
${fresh && profileHeader(ctx)}
<h1>Posts</h1>
${ctx.user.is_owner && fresh && composer()}
<form class="filters">
  <input type="search" name="q" value="${q}" placeholder="Search posts">
  <select name="kind" onchange="this.form.submit()">
    <option value="">All kinds</option>
    ${options(kinds, kind)}
  </select>
  ${yearSelect(years, year)}
  <button>Search</button>
</form>
${feed(posts, (p) => postCard(ctx, p), fresh ? "No posts yet." : "No posts match.")}
${pager(ctx, paging)}`);
}

export function commentsPage(ctx, { comments, paging, q, year, kind, years, kinds }) {
  return page(ctx, "Comments", html`
<h1>Comments</h1>
<p class="meta">Everything you've commented, including on other people's posts and photos that aren't in this export.</p>
<form class="filters">
  <input type="search" name="q" value="${q}" placeholder="Search text, people or groups">
  <select name="kind" onchange="this.form.submit()">
    <option value="">On anything</option>
    ${options(kinds, kind, (k) => `On a ${k}`)}
  </select>
  ${yearSelect(years, year)}
  <button>Search</button>
</form>
${feed(comments, (c) => commentCard(ctx, c), "No comments match.")}
${pager(ctx, paging)}`);
}

export function likesPage(ctx, { reactions, paging, q, year, reaction, years, reactionTypes }) {
  return page(ctx, "Likes", html`
<h1>Likes &amp; reactions</h1>
<form class="filters">
  <input type="search" name="q" value="${q}" placeholder="Search people or groups">
  <select name="reaction" onchange="this.form.submit()">
    <option value="">All reactions</option>
    ${options(reactionTypes, reaction, (r) => `${EMOJI[r] ?? ""} ${r}`)}
  </select>
  ${yearSelect(years, year)}
  <button>Search</button>
</form>
<ul class="reactions">
  ${reactions.length ? reactions.map((r) => reactionRow(ctx, r)) : raw('<li class="empty">No reactions match.</li>')}
</ul>
${pager(ctx, paging)}`);
}

export function photosPage(ctx, { byYear, collections, tagged }) {
  const cover = (m) => m.kind === "video"
    ? html`<video src="${mediaUrl(m)}#t=0.5" preload="metadata" muted playsinline></video>`
    : html`<img src="${thumbUrl(m)}" loading="lazy" alt="">`;
  return page(ctx, "Photos", html`
<div class="feed-head">
  <h1>Photos &amp; videos</h1>
  ${ctx.user.is_owner && html`<a class="chip primary" href="/_admin/photos/add">${raw(icon("photos"))}<span>Add photos</span></a>`}
</div>

<div class="albums">
  ${collections.map((c) => html`
  <a class="album" href="/photos/album/${c.key}">
    <div class="cover">${cover(c.cover)}</div>
    <div class="label">
      <strong>${c.title}</strong>
      <span>${number(c.count)} · ${dateRange(c.first_ts, c.last_ts)}</span>
    </div>
  </a>`)}
  ${tagged > 0 && html`
  <a class="album album-tagged" href="/photos/tagged">
    <div class="cover"><span>🏷️</span></div>
    <div class="label">
      <strong>Photos you're tagged in</strong>
      <span>${tagged} · links to Facebook</span>
    </div>
  </a>`}
</div>

${byYear.map(([year, albums]) => html`
<h2 class="year">${year}</h2>
<div class="albums">
  ${albums.map((a) => html`
  <a class="album" href="/photos/album/${a.id}">
    <div class="cover">${a.hash && html`<img src="${thumbUrl(a)}" loading="lazy" alt="">`}</div>
    <div class="label">
      <strong>${a.name}</strong>
      <span>${a.count} · ${dateRange(a.first_ts, a.last_ts)}</span>
    </div>
  </a>`)}
</div>`)}`, "wide");
}

export function albumPage(ctx, { key, title, info, stats, groups, paging }) {
  const mine = ctx.user.is_owner && Number(key) > SITE_ID; // an album made here, not imported or "Posted on afterwrd"
  return page(ctx, title, html`
<p class="crumbs"><a href="/photos">Photos</a> /</p>
<header class="album-head">
  <h1>${title}</h1>
  <p class="meta">${number(stats.count)} ${key === "videos" ? "videos" : "photos"} · ${dateRange(stats.first_ts, stats.last_ts)}</p>
  ${info?.description && html`<p>${info.description}</p>`}
  ${mine && html`<div class="album-tools">
    <a class="chip primary" href="/_admin/photos/add?album=${key}">${raw(icon("photos"))}<span>Add photos</span></a>
    <details class="edit-album"><summary class="chip">Edit</summary>
      <form class="card" method="post" action="/_admin/albums/${key}/edit">
        <input name="name" value="${title}" maxlength="200" required aria-label="Album name">
        <textarea name="description" rows="2" maxlength="2000" placeholder="What's it about? (optional)" aria-label="Album description">${info?.description ?? ""}</textarea>
        <button class="chip primary">Save</button>
      </form>
    </details>
    <form method="post" action="/_admin/albums/${key}/delete"
      onsubmit="return confirm('Delete this album and its photos? Photos that are also in a post stay, under Posted on afterwrd.')">
      <button class="chip danger">Delete album</button>
    </form>
  </div>`}
</header>
${groups.map(([month, items]) => html`${month && html`<h2 class="month">${month}</h2>`}${justified(items)}`)}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`, "wide");
}

export function taggedPage(ctx, { tagged, paging }) {
  return page(ctx, "Photos you're tagged in", html`
<p class="crumbs"><a href="/photos">Photos</a> /</p>
<h1>Photos you're tagged in</h1>
<p class="meta">Facebook exports links to these rather than the images themselves; they'll open on Facebook if you can still see them.</p>
<ul class="reactions">
  ${tagged.map((t) => html`<li class="reaction">
    <span class="emoji">🏷️</span>
    <span class="what">Tagged in ${ownerPhrase(ctx, t.owner_id, t.owner_name)} photo</span>
    <time>${fmtDatetime(t.timestamp)}</time>
    ${safeUrl(t.url) && html`<a class="out" href="${t.url}" target="_blank" rel="noopener noreferrer" title="Open on Facebook">↗</a>`}
  </li>`)}
</ul>
${pager(ctx, paging)}`);
}

export function photoPage(ctx, { m, setKey, setTitle, prev, next, index, total, albumPage, post, comment, key, thread: comments }) {
  const back = `/photos/album/${setKey}${albumPage > 1 ? `?page=${albumPage}` : ""}`;
  const main = html`
<main class="theatre">
  <section class="stage">
    ${m.kind === "video" ? html`<video src="${mediaUrl(m)}" controls autoplay playsinline preload="metadata"></video>`
      : html`<img src="${mediaUrl(m)}" alt="${m.description || ""}" ${m.width && html`width="${Number(m.width)}" height="${Number(m.height)}"`}
           style="background-image: url('${thumbUrl(m)}')">`}

    <a class="close" id="close" href="${back}" title="Back to ${setTitle} (Esc)" aria-label="Back to album">✕</a>
    <span class="counter">${index} / ${total}</span>
    ${prev && html`<a class="nav prev" id="prev" href="/photos/${prev.id}" title="Previous (←)" aria-label="Previous"></a>`}
    ${next && html`<a class="nav next" id="next" href="/photos/${next.id}" title="Next (→)" aria-label="Next"></a>`}
  </section>

  <aside class="info">
    <a class="album-link" href="${back}">${setTitle}</a>
    <time class="when">${fmtDatetime(m.taken_at || m.timestamp)}</time>

    ${m.description && !(post && post.text === m.description) && html`<div class="caption">${linkify(m.description)}</div>`}

    <dl class="details">
      ${m.taken_at && m.taken_at !== m.timestamp && html`<dt>Taken</dt><dd>${fmtDatetime(m.taken_at)}</dd>`}
      <dt>Uploaded</dt><dd>${fmtDatetime(m.timestamp)}</dd>
      ${m.width && html`<dt>Size</dt><dd>${m.width} × ${m.height}</dd>`}
      ${m.latitude && m.longitude && html`
        <dt>Where</dt>
        <dd><a href="https://www.openstreetmap.org/?mlat=${m.latitude}&amp;mlon=${m.longitude}#map=15/${m.latitude}/${m.longitude}" target="_blank" rel="noopener noreferrer">View on map ↗</a></dd>`}
    </dl>

    ${ctx.user.is_owner && m.hash && html`<div class="photo-tools">
      ${m.kind === "photo" && ["profile", "cover"].map((role) => html`<form method="post" action="/_admin/profile">
        <input type="hidden" name="role" value="${role}"><input type="hidden" name="hash" value="${m.hash}">
        <input type="hidden" name="back" value="${ctx.url.pathname}">
        <button class="chip">${role === "profile" ? "Make profile picture" : "Make cover"}</button>
      </form>`)}
      ${m.id >= SITE_ID && html`<form method="post" action="/_admin/photos/${m.id}/delete"
        onsubmit="return confirm('Delete this photo and its comments? This can’t be undone.')"><button class="chip danger">Delete photo</button></form>`}
    </div>`}
    ${key && html`<h2>Comments</h2>${thread(ctx, key, comments)}`}
    ${post && html`<h2>Posted with</h2>${postCard(ctx, post)}`}
    ${comment && html`<h2>Attached to your comment</h2>${commentCard(ctx, comment)}`}

    <p class="original"><a href="${mediaUrl(m)}" target="_blank">Open original ↗</a></p>
  </aside>
</main>

${[next, prev].filter((n) => n && n.kind === "photo").map((n) => html`<link rel="prefetch" href="${mediaUrl(n)}">`)}
<script>
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: setTitle, bodyClass: "viewer", main });
}

export function friendsPage(ctx, { people, q, show, sort }) {
  return page(ctx, "Friends", html`
<h1>Friends</h1>
<form class="filters">
  <input type="search" name="q" value="${q}" placeholder="Search names">
  <select name="show" onchange="this.form.submit()">
    ${[["friends", "Current friends"], ["removed", "Removed friends"], ["everyone", "Everyone you've interacted with"]]
      .map(([v, label]) => html`<option value="${v}" ${v === show && raw("selected")}>${label}</option>`)}
  </select>
  <select name="sort" onchange="this.form.submit()">
    ${[["name", "By name"], ["since", "By friends since"], ["activity", "By interactions"]]
      .map(([v, label]) => html`<option value="${v}" ${v === sort && raw("selected")}>${label}</option>`)}
  </select>
  <button>Search</button>
</form>

<p class="meta">${number(people.length)} people</p>
<table class="numbers people">
  <thead><tr><th>Name</th><th>Friends since</th><th>Comments</th><th>Likes</th><th>Wall posts</th><th>Tagged you</th></tr></thead>
  <tbody>
    ${people.map((p) => html`<tr>
      <th><a href="/people/${p.id}">${p.name}</a></th>
      <td>${p.friend_since ? fmtDate(p.friend_since) : p.unfriended_at && html`<span class="meta">removed ${fmtDate(p.unfriended_at)}</span>`}</td>
      <td>${p.comments || ""}</td>
      <td>${p.reactions || ""}</td>
      <td>${p.wall || ""}</td>
      <td>${p.tagged || ""}</td>
    </tr>`)}
  </tbody>
</table>`);
}

export function personPage(ctx, { person, tabs, counts, tab, rows, paging }) {
  let body;
  if (tab === "comments") body = feed(rows, (c) => commentCard(ctx, c), "No comments on their things.");
  else if (tab === "likes") {
    body = html`<ul class="reactions">${rows.length ? rows.map((r) => reactionRow(ctx, r)) : raw('<li class="empty">No likes.</li>')}</ul>`;
  } else if (tab === "wall" || tab === "tags") body = feed(rows, (p) => postCard(ctx, p), "No posts.");
  else {
    body = html`<ul class="reactions">
    ${rows.length ? rows.map((t) => html`<li class="reaction">
      <span class="emoji">🏷️</span>
      <span class="what">Tagged you in a photo</span>
      <time>${fmtDatetime(t.timestamp)}</time>
      ${safeUrl(t.url) && html`<a class="out" href="${t.url}" target="_blank" rel="noopener noreferrer" title="Open on Facebook">↗</a>`}
    </li>`) : raw('<li class="empty">No photos.</li>')}
  </ul>`;
  }
  const status = person.is_me ? "This is you."
    : person.friend_since ? `Friends since ${fmtDate(person.friend_since)}`
      : person.unfriended_at ? `Removed as a friend ${fmtDate(person.unfriended_at)}` : "Not in your friends list";
  return page(ctx, person.name, html`
<p class="crumbs"><a href="/friends">Friends</a> /</p>
<h1>${person.name}</h1>
<p class="meta">${status}</p>

<nav class="tabs">
  ${Object.entries(tabs).map(([key, label]) =>
    html`<a href="?tab=${key}" ${key === tab && raw('aria-current="page"')}>${label} <span class="meta">${counts[key]}</span></a>`)}
</nav>
${body}
${pager(ctx, paging)}`);
}

export function postPage(ctx, p) {
  return page(ctx, summary(p.title, ctx.me.name) || "Post", html`
${has(ctx, "posts") && html`<p class="crumbs"><a href="/posts">Posts</a> /</p>`}
<div class="feed">${postCard(ctx, p)}</div>`);
}

export function activityPage(ctx, { items, paging }) {
  const whose = ctx.user.is_owner ? "your" : `${ctx.me.name}'s`;
  return page(ctx, "Activity", html`
<h1>Activity</h1>
<p class="meta">The latest comments on ${whose} posts and photos, from everyone who can see this site.</p>
${feed(items, (c) => activityItem(ctx, c, whose), "No comments yet. Write one under any post or photo.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

function activityItem(ctx, c, whose) {
  const { photo, post } = c.on ?? {};
  const href = photo ? `/photos/${photo.id}#c${c.id}` : post ? `/posts/${c.target}#c${c.id}` : null;
  const what = photo ? photo.kind : "post";
  const snippet = post && (post.text ? post.text.slice(0, 140) + (post.text.length > 140 ? "…" : "") : summary(post.title, ctx.me.name));
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  ${photo && html`<a class="thumb" href="${href}" aria-hidden="true" tabindex="-1">${mediaImg(photo)}</a>`}
  <div class="body">
    <header>
      <span class="what"><strong>${c.author_id === ctx.user.id ? "You" : c.name}</strong>
        ${href ? html`commented on <a href="${href}">${whose} ${what}</a>` : "commented on something that's no longer in the archive"}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    <div class="text">${linkify(c.text)}</div>
    ${snippet && html`<p class="meta on">On “${snippet}”</p>`}
  </div>
</article>`;
}

export function feedPage(ctx, { posts, connections, unreachable }) {
  return page(ctx, "Feed", html`
<div class="feed-head">
  <h1>Feed</h1>
  <a class="chip" href="/_admin/connections">${raw(icon("connections"))}<span>Connections</span></a>
</div>
<p class="meta">New posts from friends' afterwrd sites you're connected with. Only you see this page.</p>
${unreachable.map((u) => html`<p class="notice">Couldn't load ${u.connection.name}'s posts: ${u.error}</p>`)}
${connections.length
    ? feed(posts, (p) => remoteCard(ctx, p.connection, p), "No posts from your connections yet. New ones will appear here.")
    : html`<div class="empty">
  <p>Connect with friends who have their own afterwrd site to see their new posts here.</p>
  <a class="chip primary" href="/_admin/connections">${raw(icon("connections"))}<span>Connect with a friend</span></a>
</div>`}`);
}

// --- a connected friend's posts and photos, read from their site (friends.js) ----------------------------------

const friendBase = (c) => `/friend/${c.id}`;

/** A photo or video from a friend's site: its signed link loads straight from there. */
function remoteMedia(m, { full = false } = {}) {
  if (m.kind === "video") {
    return full ? html`<video src="${m.src}" controls autoplay playsinline preload="metadata"></video>`
      : html`<video src="${m.src}#t=0.5" preload="metadata" muted playsinline></video><span class="play" aria-hidden="true"></span>`;
  }
  return html`<img src="${full ? m.src : m.thumbSrc}" ${full && html`style="background-image: url('${m.thumbSrc}')"`} loading="${full ? "eager" : "lazy"}"
    alt="${m.description || ""}" ${m.width && html`width="${m.width}" height="${m.height}"`}>`;
}

/** Comments on a friend's post or photo; yours are sent to their site (feed.js), which keeps them. */
function remoteThread(ctx, c, target, comments) {
  const back = ctx.url.pathname + ctx.url.search;
  return html`<section class="thread" id="t-${target}" aria-label="Comments">
  ${comments.map((r) => html`<div class="comment" id="r${c.id}-${r.id}">
    <span class="who who-${r.mine ? ctx.user.id % 6 : r.id % 6}" aria-hidden="true">${initial(r.mine ? ctx.user.name : r.name)}</span>
    <div class="bubble"><strong>${r.mine ? ctx.user.name : r.name}</strong>${!r.mine && r.from && html`<span class="from">${host(r.from)}</span>`}<span class="said">${linkify(r.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(r.created_at)}">${fmtAgo(r.created_at)}</time>
      ${r.mine && html`<form method="post" action="/_feed/comments/${c.id}/${r.id}/delete" onsubmit="return confirm('Delete this comment?')">
        <input type="hidden" name="back" value="${back}"><button>Delete</button>
      </form>`}
    </div>
  </div>`)}
  <form class="say" method="post" action="/_feed/comments">
    <input type="hidden" name="connection" value="${c.id}">
    <input type="hidden" name="target" value="${target}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

/** A post from a friend's site, in Feed or on their posts page. */
/** A friend's profile picture, or the first letter of their name. */
const friendFace = (c) => (c.avatar
  ? html`<img class="who" src="${c.avatar.thumbSrc}" alt="" aria-hidden="true">`
  : html`<span class="who who-${c.id % 6}" aria-hidden="true">${initial(c.name)}</span>`);

function remoteCard(ctx, c, p, { thread = true } = {}) {
  const n = p.photos.length;
  const what = p.title && p.title !== "Posted on afterwrd." ? summary(p.title, c.name) : "";
  return html`<article class="card from-friend">
  <header>
    ${friendFace(c)}
    <span class="what"><a href="${friendBase(c)}/posts"><strong>${c.name}</strong></a>
      <span class="meta">${what || host(c.origin)}</span></span>
    <time title="${fmtDatetime(p.created_at)}">${fmtAgo(p.created_at)}</time>
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${p.photos.slice(0, 4).map((m, i) => html`
      <a href="${friendBase(c)}/photos/${m.hash}" class="tile" ${n === 1 && m.kind === "photo" && html`style="--bg-img: url('${m.thumbSrc}')"`}>
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

/** The owner's Friends: friends on afterwrd first, then everyone from the Facebook download, in one list. */
export function friendsIndexPage(ctx, { friends, facebook }) {
  const people = has(ctx, "friends"); // Facebook people have pages only if the friends list is published
  const fbLink = (p) => (people && p.id ? html`<a href="/people/${p.id}">${p.name}</a>` : p.name);
  const linkForm = (c, body) => html`<form method="post" action="/_admin/connections/${c.id}/facebook" class="fb-link">${body}</form>`;
  return page(ctx, "Friends", html`
<div class="feed-head">
  <h1>Friends</h1>
  <a class="chip primary" href="/_admin/connections">${raw(icon("connections"))}<span>Connect with a friend</span></a>
</div>
<p class="meta">Only you see this page.</p>

<h2>On afterwrd</h2>
${friends.length ? html`<ul class="friend-list">
  ${friends.map((c) => html`<li class="card">
    <a class="friend-link" href="${friendBase(c)}/posts">
      <span class="who who-${c.id % 6}" aria-hidden="true">${initial(c.name)}</span>
      <span><strong>${c.name}</strong><span class="meta">${host(c.origin)} · friends since ${fmtDate(c.connected_at)}</span></span>
    </a>
    <nav class="friend-tabs"><a href="${friendBase(c)}/posts">Posts</a><a href="${friendBase(c)}/photos">Photos</a></nav>
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
  <a class="chip primary" href="/_admin/connections">${raw(icon("connections"))}<span>Connect with a friend</span></a>
</div>`}

${facebook.length > 0 && html`
<h2>From your Facebook download</h2>
<form class="filters" onsubmit="return false">
  <input type="search" id="fb-filter" placeholder="Search names" aria-label="Search names">
</form>
<table class="numbers people" id="fb-people">
  <thead><tr><th>Name</th><th>Friends since</th><th>On afterwrd</th></tr></thead>
  <tbody>
    ${facebook.map((p) => html`<tr>
      <th>${fbLink(p)}</th>
      <td>${fmtDate(p.friend_since)}</td>
      <td>${p.friend ? html`<a class="badge" href="${friendBase(p.friend)}/posts">On afterwrd</a>` : raw('<span class="meta">Not on afterwrd</span>')}</td>
    </tr>`)}
  </tbody>
</table>
<datalist id="fb-names">${facebook.map((p) => html`<option value="${p.name}">`)}</datalist>
<script>
  document.getElementById("fb-filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const row of document.querySelectorAll("#fb-people tbody tr")) row.hidden = q && !row.cells[0].textContent.toLowerCase().includes(q);
  });
</script>`}`);
}

function friendHead(ctx, c, tab) {
  return html`
<p class="crumbs"><a href="/friend">Friends</a> /</p>
${c.cover && html`<section class="profile"><div class="cover"><img src="${c.cover.src}" alt=""></div></section>`}
<div class="feed-head">
  <h1 class="friend-name">${c.avatar && html`<img class="avatar-small" src="${c.avatar.thumbSrc}" alt="">`}${c.name}</h1>
  ${c.facebook && has(ctx, "friends") && html`<a class="chip" href="/people/${c.facebook.id}">${raw(icon("friends"))}<span>Your Facebook history together</span></a>`}
</div>
<p class="meta">${host(c.origin)} · a friend you're connected with. Only you see this here.</p>
<nav class="tabs">
  ${[["posts", "Posts"], ["photos", "Photos"]].map(([key, label]) =>
    html`<a href="${friendBase(c)}/${key}" ${key === tab && raw('aria-current="page"')}>${label}</a>`)}
</nav>`;
}

export function friendPostsPage(ctx, c, { posts, paging }) {
  return page(ctx, c.name, html`
${friendHead(ctx, c, "posts")}
${feed(posts, (p) => remoteCard(ctx, c, p), "Nothing posted yet.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

export function friendPhotosPage(ctx, c, albums) {
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

export function friendAlbumPage(ctx, c, album) {
  return page(ctx, album.name, html`
<p class="crumbs"><a href="${friendBase(c)}/photos">${c.name}'s photos</a> /</p>
<header class="album-head">
  <h1>${album.name}</h1>
  <p class="meta">${number(album.total)} · ${dateRange(album.first_ts, album.last_ts)}</p>
  ${album.description && html`<p>${album.description}</p>`}
</header>
<div class="justified">
  ${album.media.map((m) => html`<a href="${friendBase(c)}/photos/${m.hash}" class="tile" style="--r: ${aspect(m)}" title="${fmtDate(m.timestamp)}">${remoteMedia(m)}</a>`)}
</div>
${(album.paging.page > 1 || album.paging.hasNext) && pager(ctx, album.paging)}`, "wide");
}

export function friendPhotoPage(ctx, c, m) {
  const back = m.album ? `${friendBase(c)}/photos/album/${m.album.key}` : `${friendBase(c)}/photos`;
  const main = html`
<main class="theatre">
  <section class="stage">
    ${remoteMedia(m, { full: true })}
    <a class="close" id="close" href="${back}" title="Back (Esc)" aria-label="Back to album">✕</a>
    ${m.album && html`<span class="counter">${m.album.index} / ${m.album.total}</span>`}
    ${m.prev && html`<a class="nav prev" id="prev" href="${friendBase(c)}/photos/${m.prev}" title="Previous (←)" aria-label="Previous"></a>`}
    ${m.next && html`<a class="nav next" id="next" href="${friendBase(c)}/photos/${m.next}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="${back}">${m.album?.name ?? `${c.name}'s photos`}</a>
    <time class="when">${fmtDatetime(m.timestamp)}</time>
    <p class="meta"><a href="${friendBase(c)}/posts">${c.name}</a> · ${host(c.origin)}</p>
    ${m.description && !(m.post && m.post.text === m.description) && html`<div class="caption">${linkify(m.description)}</div>`}
    <h2>Comments</h2>
    ${remoteThread(ctx, c, `photo-${m.hash}`, m.comments)}
    ${m.post && html`<h2>Posted with</h2>${remoteCard(ctx, c, m.post, { thread: false })}`}
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

export function friendProblem(ctx, c, message) {
  return page(ctx, c.name, html`
${friendHead(ctx, c, "")}
<p class="notice">Couldn't load this from ${c.name}'s site: ${message}</p>`);
}


