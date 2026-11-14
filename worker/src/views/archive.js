// The archive's pages (routes in archive/routes.js): the Facebook download (Overview, Timeline, Comments, Likes,
// Photos, albums, Facebook friends and people), Posts, and Notifications. The other signed-in pages are by area beside
// this: home.js, friends.js, groups.js, events.js; layout.js and parts.js are what they share. Each view is given `ctx`,
// the page's frame (routes.js frame(): who's signed in, the request URL, their picture, the published sections and the
// menu's counts), and the data its loader gathered. Views only draw: they read nothing and change nothing.
import {
  dateRange, EMOJI, fmtAgo, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl } from "./format.js";

import { icon } from "./nav.js";
import { html, raw } from "./html.js";
import { layout, page } from "./layout.js";
import { commentCard, composer, feed, has, justified, mediaImg, options, ownerPhrase, pager, personLink, postCard, reactionRow, thread, yearSelect } from "./parts.js";
import { readMentions } from "../mentions.js";

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
    ${options(kinds, kind, (k) => (k === "afterwrd" ? "Written on afterwrd" : k))}
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
  const mine = info?.source === "afterwrd" && info.role !== "posts"; // an album made here, not imported or "Posted on afterwrd"
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
      data-confirm="Delete this album and its photos? Photos that are also in a post stay, under Posted on afterwrd." data-confirm-ok="Delete">
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
    <time>${fmtDatetime(t.created_at)}</time>
    ${safeUrl(t.url) && html`<a class="out" href="${t.url}" target="_blank" rel="noopener noreferrer" title="Open on Facebook">↗</a>`}
  </li>`)}
</ul>
${pager(ctx, paging)}`);
}

export function photoPage(ctx, { m, setKey, setTitle, prev, next, index, total, albumPage, post, comment, key, thread: comments, back: from = null, stay = "" }) {
  const back = from ?? `/photos/album/${setKey}${albumPage > 1 ? `?page=${albumPage}` : ""}`;
  const main = html`
<main class="theatre">
  <section class="stage">
    ${m.kind === "video" ? html`<video src="${mediaUrl(m)}" controls autoplay playsinline preload="metadata"></video>`
      : html`<img src="${mediaUrl(m)}" alt="${m.description || ""}" ${m.width && html`width="${Number(m.width)}" height="${Number(m.height)}"`}
           style="background-image: url('${thumbUrl(m)}')">`}

    <a class="close" id="close" href="${back}" title="Back to ${setTitle} (Esc)" aria-label="Back to ${from ? "the post" : "album"}">✕</a>
    <span class="counter">${index} / ${total}</span>
    ${prev && html`<a class="nav prev" id="prev" href="/photos/${prev.id}${stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${next && html`<a class="nav next" id="next" href="/photos/${next.id}${stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>

  <aside class="info">
    <a class="album-link" href="${back}">${setTitle}</a>
    <time class="when">${fmtDatetime(m.taken_at || m.created_at)}</time>

    ${m.description && !(post && post.text === m.description) && html`<div class="caption">${linkify(m.description)}</div>`}

    <dl class="details">
      ${m.taken_at && m.taken_at !== m.created_at && html`<dt>Taken</dt><dd>${fmtDatetime(m.taken_at)}</dd>`}
      <dt>Uploaded</dt><dd>${fmtDatetime(m.created_at)}</dd>
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
      ${m.source === "afterwrd" && html`<form method="post" action="/_admin/photos/${m.id}/delete"
        data-confirm="Delete this photo and its comments? This can’t be undone." data-confirm-ok="Delete"><button class="chip danger">Delete photo</button></form>`}
    </div>`}
    ${key && html`<h2>Comments</h2>${thread(ctx, key, comments, { region: true })}`}
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
      <time>${fmtDatetime(t.created_at)}</time>
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

export function postPage(ctx, { post: p }) {
  return page(ctx, summary(p.title, ctx.me.name) || "Post", html`
${has(ctx, "posts") && html`<p class="crumbs"><a href="/posts">Posts</a> /</p>`}
<div class="feed">${postCard(ctx, p)}</div>`);
}

export function activityPage(ctx, { items, paging }) {
  return page(ctx, "Notifications", html`
<h1>Notifications</h1>
<p class="meta">Comments on your posts and photos, on friends' posts and photos you've commented on too, and on
posts in groups that you wrote or commented on; when someone mentions you; friends' invitations; and changes to events
you're invited or going to.</p>
${feed(items, (c) => (c.source === "friend" ? friendActivityItem(c) : c.source === "group" ? groupActivityItem(c)
    : activityItem(ctx, c)), "Nothing yet. Comments on your posts and photos will show here.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

/**
 * A comment on a friend's post or photo that the owner commented on too, or an invitation to a friend's event or a
 * change to it, as the friend's site told us.
 */
function friendActivityItem(c) {
  if (c.kind === "mention") return friendMentionItem(c);
  if (c.kind) return friendEventItem(c);
  const isPhoto = c.target.startsWith("photo-");
  // Their page of posts, not the post's own page: a friend's site from before events (0.46.0) has none.
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

/** Someone mentioning the owner in a friend's post, or in a comment on it (mentions.js), as the friend's site told us. */
function friendMentionItem(c) {
  const isPhoto = c.target.startsWith("photo-");
  const href = isPhoto ? `/friend/${c.connection_id}/photos/${c.target.slice(6)}` : `/friend/${c.connection_id}/posts/${c.target}`;
  const thing = isPhoto ? "photo" : "post";
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  <div class="body">
    <header>
      <span class="what"><strong>${c.name}</strong>
        ${c.name === c.friend ? html`mentioned you on <a href="${href}">their ${thing}</a>` : html`mentioned you on <a href="${href}">${c.friend}'s ${thing}</a>`}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    ${c.text && html`<div class="text">${c.text}</div>`}
  </div>
</article>`;
}

/** A friend's invitation to their event, or a change to it. */
function friendEventItem(c) {
  const href = `/friend/${c.connection_id}/posts/${c.target}`;
  const what = c.kind === "invite" ? html`invited you to <a href="${href}">an event</a>`
    : c.kind === "changed" ? html`changed <a href="${href}">an event you're invited to</a>`
    : html`called off <a href="${href}">an event you were invited to</a>`;
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  <div class="body">
    <header>
      <span class="what"><strong>${c.friend}</strong> ${what}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    ${c.text && html`<div class="text">${c.text}</div>`}
  </div>
</article>`;
}

/** A comment in a group on a post the owner wrote or commented on, or a change to an event they're going to. */
function groupActivityItem(c) {
  const href = `/groups/${c.connection_id}/posts/${c.target}${c.date ? `?date=${encodeURIComponent(c.date)}` : ""}`;
  const what = c.kind === "changed" ? html`changed <a href="${href}">an event you're going to</a>`
    : c.kind === "cancelled" && c.date ? html`called off <a href="${href}">one date of an event you're going to</a>`
    : c.kind === "cancelled" ? html`called off <a href="${href}">an event you were going to</a>`
    : c.kind === "mention" ? html`mentioned you in <a href="${href}">a post</a>`
    : c.kind === "here" ? html`wrote to everyone (@here) in <a href="${href}">a post</a>`
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
  const mentions = readMentions(c.mentions);
  const mentionsMe = c.author_id !== ctx.user.id && mentions.some((m) => m.origin === ctx.url.origin);
  return html`<article class="card activity${c.isNew ? " new" : ""}">
  ${photo && html`<a class="thumb" href="${href}" aria-hidden="true" tabindex="-1">${mediaImg(photo)}</a>`}
  <div class="body">
    <header>
      <span class="what"><strong>${c.author_id === ctx.user.id ? "You" : c.name}</strong>
        ${!href ? "commented on something that's no longer in the archive"
          : mentionsMe ? html`mentioned you on <a href="${href}">your ${what}</a>` : html`commented on <a href="${href}">your ${what}</a>`}</span>
      ${c.isNew && raw('<span class="badge badge-new">New</span>')}
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </header>
    <div class="text">${linkify(c.text, mentions)}</div>
    ${snippet && html`<p class="meta on">On “${snippet}”</p>`}
  </div>
</article>`;
}
