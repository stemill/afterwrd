// Page templates, ported from afterwrd/templates. `ctx` carries me, the published sections, the signed-in user
// and the request URL.
import {
  aspect, dateRange, EMOJI, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl,
} from "./format.js";
import { html, raw } from "./html.js";

const NAV = [["", "Overview", "overview"], ["timeline", "Timeline", "timeline"], ["posts", "Posts", "posts"],
  ["photos", "Photos", "photos"], ["comments", "Comments", "comments"], ["likes", "Likes", "likes"],
  ["friends", "Friends", "friends"]];

// --- layout ------------------------------------------------------------------

function layout(ctx, { title, bodyClass = "", main }) {
  const section = ctx.url.pathname.split("/")[1];
  const current = (path) => section === path || (path === "friends" && section === "people");
  return html`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · afterwrd</title>
  <link rel="stylesheet" href="/static/style.css">
  <link rel="icon" href="data:,">
</head>
<body class="${bodyClass}">
  <header class="site">
    <a class="brand" href="/">afterwrd</a>
    <nav>
      ${NAV.filter(([, , s]) => ctx.sections.includes(s)).map(([path, label]) =>
        html`<a href="/${path}" ${current(path) && raw('aria-current="page"')}>${label}</a>`)}
      ${ctx.user.is_owner ? html`<a href="/_admin">People</a><a href="/_admin/import">Import</a><a href="/_admin/update">Update</a>` : ""}
      <form method="post" action="/_auth/logout"><button class="link">Sign out</button></form>
    </nav>
  </header>
  ${main}
</body>
</html>`;
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

function postCard(ctx, p) {
  let what;
  if (p.kind === "wall") what = html`Wrote on ${personLink(ctx, p.target_id, p.target_name)}'s profile`;
  else if (p.kind === "group") what = html`Posted in <em>${p.group_name}</em>`;
  else what = summary(p.title, ctx.me.name);
  return html`<article class="card">
  <header>
    <span class="badge badge-${p.kind}">${p.kind}</span>
    <span class="what">${what}</span>
    <time>${fmtDatetime(p.timestamp)}</time>
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${collage(p.media)}
  ${safeUrl(p.link_url) && !(p.text || "").includes(p.link_url) &&
    html`<p class="link"><a href="${p.link_url}" target="_blank" rel="noopener noreferrer">${p.link_url}</a></p>`}
  ${p.place_name && html`<p class="meta">📍 ${p.place_name}${p.place_address && `, ${p.place_address}`}</p>`}
  ${p.tags?.length > 0 && html`<p class="meta">With ${p.tags.map((t, i) => html`${personLink(ctx, t.id, t.name)}${i < p.tags.length - 1 && ", "}`)}</p>`}
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

export function postsPage(ctx, { posts, paging, q, year, kind, years, kinds }) {
  return page(ctx, "Posts", html`
<h1>Posts</h1>
<form class="filters">
  <input type="search" name="q" value="${q}" placeholder="Search posts">
  <select name="kind" onchange="this.form.submit()">
    <option value="">All kinds</option>
    ${options(kinds, kind)}
  </select>
  ${yearSelect(years, year)}
  <button>Search</button>
</form>
${feed(posts, (p) => postCard(ctx, p), "No posts match.")}
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
<h1>Photos &amp; videos</h1>

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
  return page(ctx, title, html`
<p class="crumbs"><a href="/photos">Photos</a> /</p>
<header class="album-head">
  <h1>${title}</h1>
  <p class="meta">${number(stats.count)} ${key === "videos" ? "videos" : "photos"} · ${dateRange(stats.first_ts, stats.last_ts)}</p>
  ${info?.description && html`<p>${info.description}</p>`}
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

export function photoPage(ctx, { m, setKey, setTitle, prev, next, index, total, albumPage, post, comment }) {
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

export function emptyPage(ctx, message) {
  return page(ctx, "afterwrd", html`<p class="empty">${message}</p>`);
}

