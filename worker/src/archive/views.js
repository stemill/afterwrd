// Page templates, ported from afterwrd/templates. `ctx` carries me, the published sections, the signed-in user
// and the request URL.
import { resultHtml, verdict } from "../checks.js";
import { connectLink } from "../cloudflare.js";
import { MAX_COMMENT } from "./comments.js";
import {
  aspect, dateRange, EMOJI, fmtAgo, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl,
} from "./format.js";
import { eventDay, eventFormValues, eventWhen, finishedAt } from "../calendar.js";
import { asset, FAVICON, icon, ownerMain, ownerMenu, siteHeader } from "../nav.js";
import { gone } from "../feed.js";
import { host } from "../peers.js";
import { SITE_ID } from "../posts.js";
import { now } from "../util.js";
import { html, raw } from "./html.js";

// Memories: everything from the Facebook download, each shown if the owner published that section.
const MEMORIES = [
  ["timeline", "Timeline", "Everything, in date order"],
  ["comments", "Comments", "What you said on Facebook"],
  ["likes", "Likes", "What you liked and reacted to"],
  ["friends", "Facebook friends", "Everyone you were friends with"],
  ["overview", "Overview", "Your Facebook years in numbers"],
];
const hasMemories = (ctx) => MEMORIES.some(([s]) => ctx.chosen.includes(s));

// --- layout ------------------------------------------------------------------

/** Which menu item the page belongs under. */
function currentKey(ctx) {
  const top = ctx.url.pathname.split("/")[1];
  if (top === "") return "home";
  if (top === "posts") return "profile";
  if (top === "friend" || top === "people") return "connected";
  if (["memories", ...MEMORIES.map(([s]) => s)].includes(top)) return "memories";
  return top;
}

function header(ctx) {
  const picture = ctx.profile?.profile;
  return siteHeader({
    main: ownerMain(ctx.newComments, ctx.requests),
    menu: ownerMenu({ memories: hasMemories(ctx), updateWaiting: ctx.updateWaiting }),
    current: currentKey(ctx),
    face: { initial: initial(ctx.user.name), picture: picture && `/files/${picture.thumb_hash ?? picture.hash}` },
  });
}

function layout(ctx, { title, bodyClass = "", main }) {
  return html`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#16201b">
  <title>${title} · afterwrd</title>
  <link rel="stylesheet" href="${asset("/static/style.css")}">
  ${raw(FAVICON)}
</head>
<body class="${bodyClass}">
  ${raw(header(ctx))}
  ${main}
</body>
</html>`;
}

/** On the Facebook sections' pages, tabs between them and back to Memories. */
function memoriesTabs(ctx) {
  const top = ctx.url.pathname.split("/")[1];
  if (!MEMORIES.some(([s]) => s === top)) return "";
  return html`<nav class="tabs" aria-label="Memories">
  <a href="/memories">All memories</a>
  ${MEMORIES.filter(([s]) => ctx.chosen.includes(s)).map(([s, label]) =>
    html`<a href="/${s}" ${s === top && raw('aria-current="page"')}>${label}</a>`)}
</nav>`;
}

const page = (ctx, title, content, bodyClass = "") =>
  layout(ctx, { title, bodyClass, main: html`<main>${memoriesTabs(ctx)}${content}</main>` });

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
  return html`<section class="thread" id="t-${key}" aria-label="Comments">
  ${comments.map((c) => html`<div class="comment" id="c${c.id}">
    ${c.author_is_owner ? ownerFace(ctx)
      : c.origin && c.origin !== "site" && ctx.friendFaces?.[c.origin] ? html`<img class="who" src="${ctx.friendFaces[c.origin]}" alt="" aria-hidden="true">`
        : html`<span class="who who-${(c.author_id ?? 0) % 6}" aria-hidden="true">${initial(c.name)}</span>`}
    <div class="bubble"><strong>${c.name}</strong>${c.origin && c.origin !== "site" && html`<span class="from">${host(c.origin)}</span>`}<span class="said">${linkify(c.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${html`<form method="post" action="/_comments/${c.id}/delete" onsubmit="return confirm('Delete this comment?')">
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

/** The owner's picture, or their initial: for posts written here. */
function ownerFace(ctx) {
  const picture = ctx.profile?.profile;
  return picture ? html`<img class="who" src="/files/${picture.thumb_hash ?? picture.hash}" alt="" aria-hidden="true">`
    : html`<span class="who" aria-hidden="true">${initial(ctx.ownerName)}</span>`;
}

function postCard(ctx, p) {
  // Posts written here look like friends' posts: who, when, and what they did if it's more than writing.
  if (p.id >= SITE_ID) {
    const did = p.title && p.title !== "Posted on afterwrd." ? p.title : "";
    return html`<article class="card social own">
  <header>
    ${ownerFace(ctx)}
    <span class="what"><strong>You</strong>${did && html`<span class="meta">${did}</span>`}</span>
    ${p.thread ? html`<a class="when" href="/posts/${p.key}" title="${fmtDatetime(p.timestamp)}"><time>${fmtAgo(p.timestamp)}</time></a>`
      : html`<time title="${fmtDatetime(p.timestamp)}">${fmtAgo(p.timestamp)}</time>`}
    ${p.thread && html`<form method="post" action="/_admin/posts/${p.id}/delete"
      onsubmit="return confirm('Delete this post, its photos and its comments? This can’t be undone.')"><button class="delete">Delete</button></form>`}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${collage(p.media)}
  ${p.thread && thread(ctx, p.key, p.thread)}
</article>`;
  }
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
    ${p.id >= SITE_ID && p.thread && html`<form method="post" action="/_admin/posts/${p.id}/delete"
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
/** Write a post, with photos. In a group, `action` is where it goes, and `max` how many photos it takes. */
function composer({ action = null, max = null, placeholder = "Write something, or add photos" } = {}) {
  return html`<form class="card composer" id="composer" ${action && html`data-action="${action}" data-max="${max}"`}>
  <textarea name="text" rows="2" maxlength="5000" placeholder="${placeholder}" aria-label="New post"></textarea>
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
  if (!profile && !cover) {
    return html`<p class="card profile-prompt">Make this page yours:
  <a class="chip" href="/_admin/photos/add?for=profile">Add a profile picture</a>
  <a class="chip" href="/_admin/photos/add?for=cover">Add a cover photo</a></p>`;
  }
  return html`<section class="profile">
  <div class="cover-wrap">
    ${cover ? html`<a class="cover" href="/photos/${cover.id}"><img src="/files/${cover.hash}" alt="Cover photo"></a>` : raw('<div class="cover"></div>')}
    <a class="chip change-cover" href="/_admin/photos/add?for=cover">${cover ? "Change cover" : "Add a cover"}</a>
  </div>
  <div class="identity">
    ${profile ? html`<a class="avatar" href="/photos/${profile.id}"><img src="/files/${profile.thumb_hash ?? profile.hash}" alt="Profile picture"></a>`
      : html`<a class="avatar empty" href="/_admin/photos/add?for=profile" title="Add a profile picture" aria-label="Add a profile picture">+</a>`}
    <div><p class="name">${ctx.me.name}</p>
      ${profile && html`<a class="meta" href="/_admin/photos/add?for=profile">Change picture</a>`}</div>
  </div>
</section>`;
}

export function postsPage(ctx, { posts, paging, q, year, kind, years, kinds }) {
  const fresh = paging.page === 1 && !q && !year && !kind;
  return page(ctx, "Posts", html`
${fresh && profileHeader(ctx)}
<h1>Posts</h1>
${fresh && composer()}
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
  <a class="chip primary" href="/_admin/photos/add">${raw(icon("photos"))}<span>Add photos</span></a>
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
  const mine = Number(key) > SITE_ID; // an album made here, not imported or "Posted on afterwrd"
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

    ${m.hash && html`<div class="photo-tools">
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
  return page(ctx, "Notifications", html`
<h1>Notifications</h1>
<p class="meta">Comments on your posts and photos, on friends' posts and photos you've commented on too, and on
posts in groups that you wrote or commented on; and changes to events you're going to.</p>
${feed(items, (c) => (c.source === "friend" ? friendActivityItem(c) : c.source === "group" ? groupActivityItem(c)
    : activityItem(ctx, c)), "Nothing yet. Comments on your posts and photos will show here.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

/** A comment on a friend's post or photo that the owner commented on too, as the friend's site told us. */
function friendActivityItem(c) {
  const isPhoto = c.target.startsWith("photo-");
  const href = isPhoto ? `/friend/${c.connection_id}/photos/${c.target.slice(6)}` : `/friend/${c.connection_id}/posts#f${c.connection_id}-${c.target}`;
  const thing = isPhoto ? "photo" : "post";
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  <div class="body">
    <header>
      <span class="what"><strong>${c.name}</strong>
        ${c.name === c.friend ? html`replied on <a href="${href}">their ${thing}</a>` : html`also commented on <a href="${href}">${c.friend}'s ${thing}</a>`}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    ${c.text && html`<div class="text">${c.text}</div>`}
  </div>
</article>`;
}

/** A comment in a group on a post the owner wrote or commented on, or a change to an event they're going to. */
function groupActivityItem(c) {
  const href = `/groups/${c.connection_id}/posts/${c.target}`;
  const what = c.kind === "changed" ? html`changed <a href="${href}">an event you're going to</a>`
    : c.kind === "cancelled" ? html`called off <a href="${href}">an event you were going to</a>`
    : c.own_post ? html`commented on <a href="${href}">your post</a>` : html`also commented on <a href="${href}">a post</a>`;
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  <div class="body">
    <header>
      <span class="what"><strong>${c.name}</strong> ${what} in <a href="/groups/${c.connection_id}">${c.friend}</a></span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    ${c.text && html`<div class="text">${c.text}</div>`}
  </div>
</article>`;
}

function activityItem(ctx, c) {
  const { photo, post } = c.on ?? {};
  const href = photo ? `/photos/${photo.id}#c${c.id}` : post ? `/posts/${c.target}#c${c.id}` : null;
  const what = photo ? photo.kind : "post";
  const snippet = post && (post.text ? post.text.slice(0, 140) + (post.text.length > 140 ? "…" : "") : summary(post.title, ctx.me.name));
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  ${photo && html`<a class="thumb" href="${href}" aria-hidden="true" tabindex="-1">${mediaImg(photo)}</a>`}
  <div class="body">
    <header>
      <span class="what"><strong>${c.author_id === ctx.user.id ? "You" : c.name}</strong>
        ${href ? html`commented on <a href="${href}">your ${what}</a>` : "commented on something that's no longer in the archive"}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    <div class="text">${linkify(c.text)}</div>
    ${snippet && html`<p class="meta on">On “${snippet}”</p>`}
  </div>
</article>`;
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
    ${r.mine ? ownerFace(ctx) : r.from ? faceFor(ctx, r.from, r.name, r.id) : friendFace(ctx, c)}
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

/** A post from a friend's site, on Home or on their posts page. */
/** A friend's profile picture, or the first letter of their name. */
const friendFace = (ctx, c) => faceFor(ctx, c.origin, c.name, c.id, c.avatar?.thumbSrc);

/** Someone from another site: the picture their site gave (just now, or remembered), or their initial. */
function faceFor(ctx, origin, name, n, fresh = null) {
  const picture = fresh ?? ctx.friendFaces?.[origin];
  return picture ? html`<img class="who" src="${picture}" alt="" aria-hidden="true">`
    : html`<span class="who who-${n % 6}" aria-hidden="true">${initial(name)}</span>`;
}

function remoteCard(ctx, c, p, { thread = true } = {}) {
  const n = p.photos.length;
  const what = p.title && p.title !== "Posted on afterwrd." ? summary(p.title, c.name) : "";
  return html`<article class="card social from-friend" id="f${c.id}-${p.key}">
  <header>
    ${friendFace(ctx, c)}
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

/** Why someone's asking to be friends: a group they're both in, a friend's introduction, or a link the owner made. */
function askedBecause(r) {
  if (r.via_kind === "group") return html`They're in <strong>${r.via_name}</strong> with you.`;
  if (r.via_kind === "introduction") return html`Introduced by <strong>${r.via_name}</strong>.`;
  return r.invited_as ? html`Used the invite you made for <strong>${r.invited_as}</strong>.` : "Used a friend link you made.";
}

/** A friend introducing the owner to someone, with a way to ask them (or not), landing back on `back`. */
function introductionCard(i, back, tag = "li") {
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
<p class="meta">Only you see this page.</p>

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
      <button class="chip danger" formaction="/_admin/connections/${r.id}/decline" onclick="return confirm('Decline? Their site will be told no.')">Decline</button>
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
      <span><strong>${c.name}</strong><span class="meta">${host(c.origin)} · friends since ${fmtDate(c.connected_at)}</span></span>
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
<p class="meta">When a friend asks you to check their afterwrd site (from their Update page, by message), paste their
message, or just their site's address, here. Make a link and send it back to them: they open it and allow read-only
access in Cloudflare, and your site checks theirs is exactly the published afterwrd, with nothing else done in their
account. You both see what it found. The request comes by message, not between the sites, so a site that had been
tampered with couldn't fake it.</p>
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
    data-ask="Remove ${c.name} as a friend? You'll stop seeing each other's posts and photos. Comments already made stay where they are."
    onsubmit="return confirm(this.dataset.ask)"><button class="${look}">Remove friend</button></form>`;
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
<p class="notice">${friendSilence(c) ?? html`Couldn't load this from ${c.name}'s site: ${message}`}</p>`);
}



// --- groups, each its own Worker, read from there (membership.js) -----------------------------------------------------

const groupBase = (g) => `/groups/${g.id}`;
const runs = (g) => g.role === "owner" || g.role === "admin";
/** Whether the owner here may delete this post or comment: their own; anything, as the group's owner; as an admin, anything but the owner's. */
const mayDelete = (g, item) => item.mine || g.role === "owner" || (g.role === "admin" && item.from !== g.ownerFrom);
const ROLE_NAMES = { owner: "Owner", admin: "Admin" };

/** Where a group lives and who runs it, in a few words. */
function groupWhere(g) {
  return g.role === "owner" ? html`Your group, at ${host(g.origin)}` : html`${g.host_name}'s group, at ${host(g.origin)}`;
}

/** The owner's groups, starting one, and joining one with an invite link. */
export function groupsIndexPage(ctx, { groups, unfinished = [], plans = [], connected = false }) {
  return page(ctx, "Groups", html`
<div class="feed-head">
  <h1>Groups</h1>
  <a class="chip primary" href="/groups/new">${raw(icon("groups"))}<span>Start a group</span></a>
</div>
<p class="meta">Each group is its own small site, in the Cloudflare account of whoever started it. Its members read it
from their own sites, and post and comment there. You're told about comments on posts you wrote or commented on; for
anything else, open the group.</p>
${plans.length > 0 && html`<section class="card coming-up">
  <h2>Coming up</h2>
  <ul class="plan-list">${plans.map((e) => html`<li><a href="/groups/${e.group_id}/posts/${e.post_id}">
    ${dateTile(e)}
    <span class="what"><strong>${e.title}</strong>
      <span class="meta">${eventWhen(e, ctx.zone)}${e.place && ` · ${e.place}`} · ${e.group_name}${e.answer === "maybe" ? " · You might go" : ""}</span></span>
    ${e.cancelled_at && html`<span class="badge as-written">Called off</span>`}
  </a></li>`)}</ul>
</section>`}
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
    if (!button || (button.dataset.delete && !confirm("Delete this group's Worker and database from your Cloudflare account?"))) return;
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
</script>`}
<form class="filters" action="/groups/join" method="get">
  <input type="search" name="link" placeholder="Got an invite to a group? Paste the link here" required autocomplete="off">
  <button>Join</button>
</form>`);
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

function groupHead(ctx, g, info, tab) {
  const waiting = runs(g) ? info?.waiting ?? 0 : 0;
  return html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<div class="feed-head">
  <h1>${info?.name ?? g.name}</h1>
</div>
${(info?.about ?? g.about) && html`<p>${info?.about ?? g.about}</p>`}
<p class="meta">${groupWhere(g)}${info && ` · ${info.members} ${info.members === 1 ? "member" : "members"}`}. Only its members see it.</p>
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
  ${p.comments.map((c) => html`<div class="comment" id="g${p.id}-${c.id}">
    ${groupFace(ctx, c)}
    <div class="bubble"><strong>${c.mine ? ctx.user.name : c.name}</strong>${!c.mine && c.from && html`<span class="from">${host(c.from)}</span>`}<span class="said">${linkify(c.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${mayDelete(g, c) && html`<form method="post" action="/_groups/${g.id}/comments/${c.id}/delete"
        onsubmit="return confirm('Delete this comment?')"><input type="hidden" name="back" value="${back}"><button>Delete</button></form>`}
    </div>
  </div>`)}
  <form class="say" method="post" action="/_groups/${g.id}/comments" data-group="${g.id}" data-post="${p.id}">
    <input type="hidden" name="post" value="${p.id}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

/** A post in a group. Its photos come by signed links from the group's site. */
function groupCard(ctx, g, p) {
  const n = p.photos.length;
  return html`<article class="card social in-group" id="gp${p.id}">
  <header>
    ${groupFace(ctx, p)}
    <span class="what"><strong>${p.mine ? "You" : p.name}</strong>${!p.mine && p.from && html`<span class="meta">${host(p.from)}</span>`}</span>
    <a class="when" href="${groupBase(g)}/posts/${p.id}" title="${fmtDatetime(p.created_at)}"><time>${fmtAgo(p.created_at)}</time></a>
    ${mayDelete(g, p) && html`<form method="post" action="/_groups/${g.id}/posts/${p.id}/delete"
      onsubmit="return confirm('Delete this post, its photos and its comments? This can’t be undone.')">
      <input type="hidden" name="back" value="${groupBase(g)}"><button class="delete">Delete</button></form>`}
  </header>
  ${p.event && eventBlock(ctx, g, p, { full: ctx.url.pathname.includes("/posts/") })}
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${p.photos.slice(0, 4).map((m, i) => html`
      <a href="${m.src}" target="_blank" rel="noopener" class="tile" ${n === 1 && html`style="--bg-img: url('${m.thumbSrc}')"`}>
        ${remoteMedia(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`}
  ${groupThread(ctx, g, p)}
</article>`;
}

export function groupPage(ctx, g, { group: info, posts, paging }, { maxPhotos }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "posts")}
${composer({ action: `/_groups/${g.id}/posts`, max: maxPhotos, placeholder: `Write something for ${info.name}` })}
${feed(posts, (p) => groupCard(ctx, g, p), "Nothing posted yet. Write the first post above.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

export function groupPostPage(ctx, g, { group: info, post }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "")}
<div class="feed">${groupCard(ctx, g, post)}</div>`);
}

// --- events in groups (calendar.js) ---------------------------------------------------------------------------------

const ANSWER_LABELS = [["going", "Going"], ["maybe", "Maybe"], ["no", "Can't go"]];

function dateTile(e) {
  const d = eventDay(e);
  return html`<span class="date-tile" aria-hidden="true"><span>${d.month}</span><strong>${d.day}</strong></span>`;
}

/**
 * An event in a group post: when and where, who's going, and the owner's answer. `full` (its own page): who's
 * going by name, adding it to their calendar, and changing it or calling it off.
 */
function eventBlock(ctx, g, p, { full = false } = {}) {
  const e = p.event;
  const over = finishedAt(e) < Date.now() / 1000;
  const back = ctx.url.pathname + ctx.url.search;
  const names = (list) => list.map((x, i) => (x.from === ctx.url.origin ? (i ? "you" : "You") : x.name)).join(", ");
  const counts = [e.going.length && `${e.going.length} going`, e.maybe.length && `${e.maybe.length} maybe`].filter(Boolean).join(" · ");
  return html`<div class="event${e.cancelled_at ? " cancelled" : ""}">
  <div class="event-head">
    ${dateTile(e)}
    <div class="event-what">
      <a class="event-title" href="${groupBase(g)}/posts/${p.id}">${e.title}</a>
      ${e.cancelled_at ? html`<span class="badge as-written">Called off</span>` : over ? html`<span class="badge as-written">Over</span>` : ""}
      <p class="meta"><time>${eventWhen(e, ctx.zone)}</time>${e.place && html`<br>${e.place}`}</p>
      ${counts && html`<p class="meta">${counts}</p>`}
    </div>
  </div>
  ${!e.cancelled_at && !over && html`<form method="post" action="/_groups/${g.id}/events/${p.id}/answer" class="answers" aria-label="Are you going?">
    <input type="hidden" name="back" value="${back}">
    ${ANSWER_LABELS.map(([value, label]) => html`<button class="chip${e.answer === value ? " primary" : ""}" name="answer" value="${value}"
      aria-pressed="${e.answer === value ? "true" : "false"}">${label}</button>`)}
  </form>`}
  ${full && html`<dl class="who">
    ${[["Going", e.going], ["Maybe", e.maybe], ["Can't go", e.cantGo]].filter(([, list]) => list.length)
      .map(([label, list]) => html`<dt>${label}</dt><dd>${names(list)}</dd>`)}
  </dl>
  <div class="actions-row">
    ${!e.cancelled_at && html`<a class="chip" href="${groupBase(g)}/posts/${p.id}/event.ics" download>${raw(icon("calendar"))}<span>Add to my calendar</span></a>`}
    ${p.mine && !e.cancelled_at && html`<a class="chip" href="${groupBase(g)}/posts/${p.id}/edit">Change it</a>`}
    ${mayDelete(g, p) && !e.cancelled_at && !over && html`<form method="post" action="/_groups/${g.id}/events/${p.id}/cancel"
      onsubmit="return confirm('Call this event off? Everyone going will be told.')">
      <input type="hidden" name="back" value="${back}"><button class="chip">Call it off</button></form>`}
  </div>`}
</div>`;
}

/** Adding or changing an event. Its times are in `values.zone`, or, for a new one, the browser's own time zone. */
function eventForm({ action, back, values = {}, text = "", submit }) {
  return html`<form class="stack event-form" method="post" action="${action}">
  <input type="hidden" name="back" value="${back}">
  <input type="hidden" name="zone" value="${values.zone ?? ""}" data-zone>
  <label>What's happening<input name="title" required maxlength="200" value="${values.title ?? ""}"></label>
  <div class="when-row">
    <label>Day<input type="date" name="start_date" required value="${values.start_date ?? ""}"></label>
    <label>Time <span class="meta">(none for all day)</span><input type="time" name="start_time" value="${values.start_time ?? ""}"></label>
  </div>
  <div class="when-row">
    <label>Ends <span class="meta">(if it runs on)</span><input type="date" name="end_date" value="${values.end_date ?? ""}"></label>
    <label>Until <span class="meta">(optional)</span><input type="time" name="end_time" value="${values.end_time ?? ""}"></label>
  </div>
  <label>Where <span class="meta">(optional)</span><input name="place" maxlength="300" value="${values.place ?? ""}"></label>
  <label>More about it <span class="meta">(optional)</span><textarea name="text" rows="3" maxlength="5000">${text}</textarea></label>
  <div class="actions-row"><button class="chip primary">${submit}</button></div>
</form>
<script>
  for (const input of document.querySelectorAll("input[data-zone]")) {
    try { input.value ||= Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  }
</script>`;
}

/** A group's calendar: what's coming up, by month, adding an event, and recent ones. */
export function groupCalendarPage(ctx, g, { outdated, group: info, upcoming, past }) {
  if (info) g.ownerFrom = info.ownerFrom;
  const months = [];
  for (const p of upcoming) {
    const d = eventDay(p.event);
    if (months.at(-1)?.[0] !== d.monthKey) months.push([d.monthKey, d.monthName, []]);
    months.at(-1)[2].push(p);
  }
  const card = (p) => html`<article class="card social in-group" id="gp${p.id}">${eventBlock(ctx, g, p)}</article>`;
  return page(ctx, `${info?.name ?? g.name}: calendar`, html`
${groupHead(ctx, g, info, "calendar")}
${outdated ? html`<p class="notice">This group's site needs updating before it can have a calendar. ${g.role === "owner"
    ? html`You can update it from your <a href="/_admin/update">Update</a> page.` : "Its owner can update it from their Update page."}</p>` : html`
<details class="card add-event" ${!upcoming.length && raw("open")}>
  <summary>Add an event</summary>
  <p class="meta">Everyone in the group will see it here. No one is sent anything about it; those who say they're
  going, or might, are told if it changes or is called off.</p>
  ${eventForm({ action: `/_groups/${g.id}/events`, back: `${groupBase(g)}/calendar`, submit: "Add the event" })}
</details>
${months.length ? months.map(([, label, items]) => html`<h2 class="month">${label}</h2><div class="feed">${items.map(card)}</div>`)
    : html`<p class="empty">Nothing coming up.</p>`}
${past.length > 0 && html`<h2 class="month">Before</h2><div class="feed">${past.map(card)}</div>`}`}`);
}

/** Changing an event the owner here added. */
export function groupEventEditPage(ctx, g, { group: info, post }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, `${info.name}: change the event`, html`
${groupHead(ctx, g, info, "calendar")}
<section class="card">
  <h2>Change the event</h2>
  <p class="meta">If you change its name, time or place, those going, or who might, are told. Times are in
  ${post.event.time_zone.replace(/_/g, " ")} time.</p>
  ${eventForm({ action: `/_groups/${g.id}/events/${post.id}/edit`, back: `${groupBase(g)}/posts/${post.id}`,
    values: eventFormValues(post.event), text: post.text ?? "", submit: "Save" })}
</section>`);
}

/** Who's in a group. For its admins: requests to join, the invite link, roles, and (its owner) deleting it. */
export function groupMembersPage(ctx, g, { group: info, members }, { max, connected, friends = [] }) {
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
        ${action === "remove" && raw(`onclick="return confirm('Remove them from the group? What they posted stays.')"`)}>${label}</button>`)}
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
  <p class="meta">Make a link and send it to people who have an afterwrd site. Anyone with it can ask to join for the
  next 14 days, and the group's admins decide who's in. Making a new link stops the old one working.</p>
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
</section>`}
${owner ? html`<section class="card" id="delete">
  <h2>Delete the group</h2>
  <p class="meta">Everything in it goes, for everyone: posts, photos and comments, and the group's site itself.
  Members' sites are told. This can't be undone.</p>
  ${g.script ? connectField(connected, "to delete the group's site", `/groups/${g.id}/members`) : ""}
  <div class="actions-row"><button class="chip" id="delete-go">Delete the group</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</section>` : html`<form method="post" action="/_groups/${g.id}/leave" onsubmit="return confirm('Leave this group? What you posted in it stays there.')">
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
    if (!confirm("Delete this group and everything in it, for everyone? This can’t be undone.")) return;
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

export function groupProblem(ctx, g, message) {
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

// --- Home and Memories ----------------------------------------------------------------------------------------------

/** Posts from this day in past years, from the Facebook download (and anything posted here a year or more ago). */
function onThisDayCard(ctx, memories) {
  if (!memories.length) return "";
  return html`<section class="card onthisday">
  <h2>On this day</h2>
  ${memories.map((p) => {
    const photo = p.media?.find((m) => m.hash && m.kind === "photo");
    const href = photo ? `/photos/${photo.id}` : `/posts/${p.key}`;
    const words = p.text ? p.text.slice(0, 140) + (p.text.length > 140 ? "…" : "") : summary(p.title, ctx.me.name);
    return html`<a class="memory" href="${href}">
      ${photo && html`<img src="${thumbUrl(photo)}" alt="" loading="lazy">`}
      <span class="year">${new Date(p.timestamp * 1000).getUTCFullYear()}</span>
      <span>${words}</span>
    </a>`;
  })}
</section>`;
}

const SIDE_FRIENDS = 12; // on Home; the rest are on Friends

/** The owner's Home: write something, then your posts and your friends' together, newest first. */
/** "a", "a and b", "a, b and c". */
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function homePage(ctx, { own, feed, onThisDay, friends, newDevices = { devices: [], canConfirm: false }, securityFix = null, asking = [], introductions = [], unchecked = false }) {
  const stream = [
    ...own.map((p) => ({ at: p.timestamp, card: postCard(ctx, p) })),
    ...feed.posts.map((p) => ({ at: p.created_at, card: remoteCard(ctx, p.connection, p) })),
  ].sort((a, b) => b.at - a.at);
  return page(ctx, "Home", html`
<div class="home">
  <section class="stream" aria-label="Posts">
    <h1 class="hidden">Home</h1>
    ${securityFix ? html`<p class="notice alert">afterwrd ${securityFix} fixes a security problem, and this site is older.
      <a href="/_admin/update">Update now</a>.</p>`
      : ctx.newRelease && html`<p class="notice">afterwrd ${ctx.newRelease} is out. <a href="/_admin/update">See what's new and update</a>.</p>`}
    ${newDevices.devices.length > 0 && html`<form class="notice alert" method="post" action="/_admin/devices/seen">
      ${newDevices.devices.length === 1
        ? html`A new device was added to your site on ${fmtDate(newDevices.devices[0].created_at)}.`
        : html`${newDevices.devices.length} new devices were added to your site, on ${listed([...new Set(newDevices.devices.map((d) => fmtDate(d.created_at)))])}.`}
      Not you? <a href="/_admin">Remove ${newDevices.devices.length === 1 ? "it" : "them"} in Your devices</a>.
      ${newDevices.canConfirm
        ? html`<button class="link">${newDevices.devices.length === 1 ? "That was me" : "They were all me"}</button>`
        : html`If it was you, say so from one of your older devices.`}</form>`}
    ${asking.map((r) => html`<form class="notice asking" method="post">
      <strong>${host(r.origin)}</strong>, who says they're ${r.name}, is asking to be friends. ${r.via_kind && askedBecause(r)}
      ${r.invited_as && r.invited_as.toLowerCase() !== r.name.toLowerCase() && html`<strong class="warn">That's not the name you invited (${r.invited_as}).</strong>`}
      <span class="row"><button class="chip primary" formaction="/_admin/connections/${r.id}/approve?back=home">Approve</button>
        <button class="chip" formaction="/_admin/connections/${r.id}/decline?back=home" onclick="return confirm('Decline? Their site will be told no.')">Decline</button></span>
    </form>`)}
    ${introductions.map((i) => introductionCard(i, "/", "div"))}
    ${unchecked && html`<form class="notice checked-notice" method="post" action="/_admin/checks/myself">Your site hasn't been checked yet.
      Before you share much, it's worth checking it's exactly the published afterwrd:
      <a href="/_admin/update#check">ask a friend with afterwrd to check it</a>, or
      <a href="https://afterwrd.app/check/">check it yourself</a>. This goes once a friend's site has checked it, or
      <button class="link">you've checked it yourself</button>.</form>`}
    ${composer()}
    ${feed.unreachable.length > 2
      ? html`<p class="notice">Couldn't reach ${feed.unreachable.length} friends' sites just now, so their newest posts may be missing.</p>`
      : feed.unreachable.map((u) => html`<p class="notice">Couldn't load ${u.connection.name}'s posts: ${u.error}</p>`)}
    ${stream.length ? stream.map((s) => s.card) : html`<div class="empty"><p>Nothing here yet. Write your first post above.</p></div>`}
  </section>
  <aside class="side">
    ${onThisDayCard(ctx, onThisDay)}
    <section class="card">
      <h2>Friends</h2>
      ${friends.length ? html`<ul class="mini-friends">
        ${friends.slice(0, SIDE_FRIENDS).map((c) => html`<li><a href="/friend/${c.id}/posts">${friendFace(ctx, c)}${c.name}</a></li>`)}
      </ul>
      ${friends.length > SIDE_FRIENDS && html`<p><a href="/friend">All ${friends.length} friends</a></p>`}`
        : html`<p class="meta">Add friends to see their posts here. Anyone can join: your friend link shows them how.</p>`}
      <p><a class="chip" href="/_admin/connections">${raw(icon("connections"))}<span>Add a friend</span></a></p>
    </section>
  </aside>
</div>`, "wide");
}

/** Memories: the sections of the Facebook download that were published, and what happened on this day. */
export function memoriesPage(ctx, { onThisDay }) {
  const available = MEMORIES.filter(([s]) => ctx.chosen.includes(s));
  return page(ctx, "Memories", html`
<h1>Memories</h1>
<p class="meta">From your Facebook download.</p>
${available.length ? html`<ul class="memory-tiles">
  ${available.map(([s, label, about]) => html`<li><a href="/${s}">${raw(icon(s))}<strong>${label}</strong><span class="meta">${about}</span></a></li>`)}
</ul>` : html`<p class="empty">Nothing from Facebook has been published here.</p>`}
${onThisDayCard(ctx, onThisDay)}`);
}
