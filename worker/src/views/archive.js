// The signed-in pages (routes in archive/routes.js). Each view is given `ctx`, the page's frame (routes.js frame():
// who's signed in, the request URL, their picture, the published sections and the menu's counts), and the data its
// loader gathered. Views only draw: they read nothing and change nothing.
import { verdict } from "../checks.js";
import { resultHtml } from "./checks.js";
import { connectLink } from "../cloudflare.js";
import { MAX_COMMENT } from "../archive/comments.js";
import { MAX_POST_TEXT } from "../edits.js";
import { MAX_GROUP_TEXT } from "../groups.js";
import { MAX_OPTION } from "../polls.js";
import {
  aspect, dateRange, EMOJI, fmtAgo, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl,
} from "./format.js";
import { dateKey, datesOf, dayName, eventDay, eventDays, eventFormValues, eventTime, eventWhen, finishedAt, monthAround, monthWeeks, repeatChoices, repeatWords, today, weekAround } from "../calendar.js";
import { asset, FAVICON, icon, ownerMain, ownerMenu, siteHeader } from "./nav.js";
import { gone } from "../feed.js";
import { host } from "../peers.js";
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
  if (top === "app") return "app";
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

export const page = (ctx, title, content, bodyClass = "") =>
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
  ${items.map((m) => html`<a href="/photos/${m.id}" class="tile" style="--r: ${aspect(m)}" title="${fmtDate(m.created_at)}">${mediaImg(m)}</a>`)}
</div>`;
}

/**
 * Facebook-style layout for the photos attached to a post or comment. A post's (`back`: where the post is shown) open
 * among that post's photos, and ✕ comes back here; a comment's open in their album.
 */
function collage(items, { back = null } = {}) {
  if (!items?.length) return "";
  const n = items.length;
  const stay = back ? `?${new URLSearchParams({ in: "post", back })}` : "";
  return html`<div class="collage collage-${Math.min(n, 4)}">
    ${items.slice(0, 4).map((m, i) => html`
      <a href="/photos/${m.id}${stay}" class="tile" ${n === 1 && m.kind === "photo" && html`style="--bg-img: url('${thumbUrl(m)}')"`}>
        ${mediaImg(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`;
}

const initial = (name) => [...String(name).trim()][0]?.toUpperCase() ?? "?";

/**
 * "Edited", opening onto what a post or comment said before (oldest first), each with when it was replaced
 * (src/edits.js). `item` has edited_at and earlier: [{text, replaced_at}]. Nothing if it was never edited.
 */
function edited(item) {
  if (!item?.edited_at) return "";
  const earlier = item.earlier ?? [];
  if (!earlier.length) return html`<span class="edited" title="${fmtDatetime(item.edited_at)}">Edited</span>`;
  return html`<details class="edited"><summary title="${fmtDatetime(item.edited_at)}">Edited</summary>
  <ol class="versions">${earlier.map((v) => html`<li><span class="meta">Until ${fmtDatetime(v.replaced_at)}</span>
    <span class="was">${v.text ? linkify(v.text) : html`<em>(no words)</em>`}</span></li>`)}</ol>
</details>`;
}

/**
 * The small V on something you wrote: Edit (while it can still be changed) and Delete, folded away until wanted, so a
 * page of posts isn't a page of Delete buttons. It's a <details>, and Edit is a link to the edit box (editBox), which
 * shows while it's the page's #target, so both work without scripts; ui.js closes the menu on a tap elsewhere.
 * `items` are menuEdit / menuDelete entries (false ones left out); nothing at all if there are none.
 */
export function moreMenu(items) {
  const shown = items.filter(Boolean);
  if (!shown.length) return "";
  return html`<details class="more"><summary aria-label="Edit or delete" title="Edit or delete">${raw(icon("more"))}</summary>
  <div class="menu">${shown}</div></details>`;
}
export const menuEdit = (id) => html`<a href="#${id}">Edit</a>`;
/**
 * A Delete in the menu: asks first (ui.js). `fields` are extra hidden fields, `back` where to go afterwards. `inplace`:
 * done without a new page (ui.js), "refresh" (what it's in is drawn again: a comment's post) or "remove" (a post).
 */
export function menuDelete(action, confirm, { back = null, label = "Delete", fields = {}, inplace = null } = {}) {
  return html`<form method="post" action="${action}" data-confirm="${confirm}" data-confirm-ok="Delete"${inplace && raw(inplace === "remove" ? ' data-inplace="remove"' : " data-inplace")}>
    ${back !== null && html`<input type="hidden" name="back" value="${back}">`}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="delete">${label}</button></form>`;
}

/**
 * A way to change words that can still be changed (src/edits.js): the words, ready to edit. Hidden until the menu's
 * Edit makes it the page's #target; Cancel goes back to `home`, the post or comment itself.
 */
function editBox(id, home, action, text, back, max, { required = true, post = null } = {}) {
  return html`<div class="edit" id="${id}">
  <form method="post" action="${action}" data-inplace>
    <input type="hidden" name="back" value="${back}">
    ${post !== null && html`<input type="hidden" name="post" value="${post}">`}
    <textarea name="text" data-draft="${action}" rows="3" maxlength="${max}" ${required && "required"} aria-label="New words">${text ?? ""}</textarea>
    <div class="edit-buttons"><button class="chip primary">Save</button><a class="chip" href="#${home}">Cancel</a></div>
    <span class="meta">Anyone who can see it can see what it said before.</span>
  </form>
</div>`;
}

/**
 * The comments written here on a post or photo, then a box to add one. Forms work without JavaScript; with it, they
 * work in place (ui.js), redrawing the post they're in, or, with `region` (a photo's page), just the comments.
 */
function thread(ctx, key, comments, { region = false } = {}) {
  const back = ctx.url.pathname + ctx.url.search;
  return html`<section class="thread" id="t-${key}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((c) => html`<div class="comment" id="c${c.id}">
    ${c.author_is_owner ? ownerFace(ctx)
      : c.origin && c.origin !== "site" && ctx.friendFaces?.[c.origin] ? html`<img class="who" src="${ctx.friendFaces[c.origin]}" alt="" aria-hidden="true">`
        : html`<span class="who who-${(c.author_id ?? 0) % 6}" aria-hidden="true">${initial(c.name)}</span>`}
    <div class="bubble"><strong>${c.name}</strong>${c.origin !== "site" && notFriend(ctx, c.origin)}<span class="said">${linkify(c.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${moreMenu([c.author_is_owner && c.editable && menuEdit(`edit-c${c.id}`),
        menuDelete(`/_comments/${c.id}/delete`, "Delete this comment?", { back, inplace: "refresh" })])}
    </div>
    ${edited(c)}
    ${c.author_is_owner && c.editable && editBox(`edit-c${c.id}`, `c${c.id}`, `/_comments/${c.id}/edit`, c.text, back, MAX_COMMENT)}
  </div>`)}
  <form class="say" method="post" action="/_comments" data-inplace>
    <input type="hidden" name="target" value="${key}">
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="comment:${key}" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
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

/**
 * A poll (polls.js): each option with how many chose it. While it's open, choosing is one tap (or, when it takes
 * several, ticks and Save). `action` takes the answer, with `hidden` fields; `closeAction`, for whoever asked, closes
 * it. Who chose what shows only where the poll says (to whoever asked), folded away.
 */
function pollBlock(ctx, poll, { id, action, hidden = {}, closeAction = null, whoNote = "Only you can see this.", whoLink = null }) {
  const back = ctx.url.pathname + ctx.url.search;
  const share = (o) => (poll.voters ? Math.round((o.count / poll.voters) * 100) : 0);
  const facts = [
    !poll.voters ? "Nobody's answered yet" : poll.voters === 1 ? "1 person answered" : `${poll.voters} people answered`,
    poll.open && poll.multiple && "Pick as many as you like",
    !poll.open ? "Closed" : poll.closes_at && `Closes ${fmtDate(poll.closes_at)}`,
  ].filter(Boolean).join(" · ");
  const inside = (o) => html`<span class="fill" aria-hidden="true"></span>
    <span class="name">${o.name}</span><span class="tally">${o.count}<span class="hidden"> (${share(o)}%)</span></span>`;
  const fields = html`<input type="hidden" name="back" value="${back}">
    ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}`;
  let options;
  if (!poll.open) {
    options = poll.options.map((o) => html`<div class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%">${inside(o)}</div>`);
  } else if (poll.multiple) {
    options = html`<form method="post" action="${action}" class="poll-form" data-inplace>${fields}
      ${poll.options.map((o, i) => html`<label class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%">
        <input type="checkbox" name="choice" value="${i}" ${o.chosen && "checked"}>${inside(o)}</label>`)}
      <button class="chip">${poll.answered ? "Change my answer" : "Answer"}</button>
    </form>`;
  } else {
    options = html`<form method="post" action="${action}" class="poll-form" data-inplace>${fields}
      ${poll.options.map((o, i) => html`<button class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%"
        name="choice" value="${i}" aria-pressed="${o.chosen ? "true" : "false"}">${inside(o)}</button>`)}
    </form>`;
  }
  const named = poll.options.some((o) => o.voters?.length);
  const who = (v) => (!v.from || v.from === ctx.url.origin ? "You" : v.name);
  return html`<div class="poll" id="${id}">
  ${options}
  <p class="meta">${facts}</p>
  ${named ? html`<details class="poll-who"><summary>Who chose what</summary>
    <p class="meta">${whoNote}</p>
    <dl>${poll.options.filter((o) => o.voters?.length).map((o) => html`<dt>${o.name}</dt><dd>${o.voters.map(who).join(", ")}</dd>`)}</dl>
  </details>` : whoLink && poll.voters > 0 && html`<p class="meta"><a href="${whoLink}">See who chose what</a></p>`}
  ${closeAction && poll.open && html`<form method="post" action="${closeAction}" data-inplace data-confirm="Close this poll? Nobody will be able to answer any more." data-confirm-ok="Close it">
    <input type="hidden" name="back" value="${back}"><button class="chip">Close poll</button></form>`}
</div>`;
}

function postCard(ctx, p) {
  // Posts written here look like friends' posts: who, when, and what they did if it's more than writing. `thread` is
  // undefined where comments weren't loaded (no link, no box), null where the post takes none (Facebook's, for now).
  if (p.source === "afterwrd") {
    const did = p.title && p.title !== "Posted on afterwrd." ? p.title : "";
    const back = ctx.url.pathname + ctx.url.search;
    return html`<article class="card social own" id="p-${p.key}" data-region="/posts/${p.key}">
  <header>
    ${ownerFace(ctx)}
    <span class="what"><strong>You</strong>${did && html`<span class="meta">${did}</span>`}</span>
    ${p.thread !== undefined ? html`<a class="when" href="/posts/${p.key}" title="${fmtDatetime(p.created_at)}"><time>${fmtAgo(p.created_at)}</time></a>`
      : html`<time title="${fmtDatetime(p.created_at)}">${fmtAgo(p.created_at)}</time>`}
    ${p.thread !== undefined && moreMenu([p.editable && menuEdit(`edit-p-${p.key}`),
      menuDelete(`/_admin/posts/${p.id}/delete`, p.event ? "Delete this event and its comments? If it's still to come, everyone invited who hasn't said no will be told it's off. This can’t be undone."
        : "Delete this post, its photos and its comments? This can’t be undone.", { inplace: "remove" })])}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${edited(p)}
  ${p.editable && p.thread !== undefined && editBox(`edit-p-${p.key}`, `p-${p.key}`, `/_admin/posts/${p.id}/edit`, p.text, back, MAX_POST_TEXT,
    { required: Boolean(p.poll) || !p.media?.length })}
  ${p.poll && pollBlock(ctx, p.poll, { id: `poll-${p.id}`, action: `/_admin/posts/${p.id}/vote`, closeAction: `/_admin/posts/${p.id}/close` })}
  ${p.event && ownEventBlock(ctx, p, { full: ctx.url.pathname === `/posts/${p.key}` })}
  ${p.event && ctx.url.pathname === `/posts/${p.key}` && guestsBlock(ctx, p)}
  ${collage(p.media, { back: `${back}#p-${p.key}` })}
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
    ${p.thread !== undefined ? html`<a class="when" href="/posts/${p.key}" title="Link to this post"><time>${fmtDatetime(p.created_at)}</time></a>`
      : html`<time>${fmtDatetime(p.created_at)}</time>`}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${collage(p.media, { back: ctx.url.pathname + ctx.url.search })}
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
    <time>${fmtDatetime(c.created_at)}</time>
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
  <time>${fmtDatetime(r.created_at)}</time>
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
  return html`<select name="year" onchange="this.form.submit()" data-search="Type a year" aria-label="Year">
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
  <textarea name="text" data-draft="post:${action ?? "here"}" rows="2" maxlength="5000" placeholder="${placeholder}" aria-label="New post"></textarea>
  <ul class="picked" hidden></ul>
  <fieldset class="poll-maker" hidden>
    <legend class="hidden">Poll</legend>
    <ol class="poll-options">
      ${[1, 2].map((n) => html`<li><input name="option" maxlength="${MAX_OPTION}" placeholder="Option ${n}" aria-label="Option ${n}"></li>`)}
    </ol>
    <button type="button" class="chip add-option">Add an option</button>
    <label class="tick"><input type="checkbox" name="multiple"> Let people pick more than one</label>
    <label class="closes"><span>Closes on <span class="meta">(if you like)</span></span><input type="date" name="closes"></label>
    <button type="button" class="chip remove-poll">Remove the poll</button>
  </fieldset>
  <p class="error" role="alert"></p>
  <div class="actions">
    <label class="chip">${raw(icon("photos"))}<span>Add photos</span><input type="file" accept="image/*" multiple class="hidden"></label>
    <button type="button" class="chip add-poll">${raw(icon("poll"))}<span>Poll</span></button>
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
posts in groups that you wrote or commented on; friends' invitations; and changes to events you're invited or going to.</p>
${feed(items, (c) => (c.source === "friend" ? friendActivityItem(c) : c.source === "group" ? groupActivityItem(c)
    : activityItem(ctx, c)), "Nothing yet. Comments on your posts and photos will show here.")}
${(paging.page > 1 || paging.hasNext) && pager(ctx, paging)}`);
}

/**
 * A comment on a friend's post or photo that the owner commented on too, or an invitation to a friend's event or a
 * change to it, as the friend's site told us.
 */
function friendActivityItem(c) {
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
function remoteThread(ctx, c, target, comments, { region = false } = {}) {
  if (!comments) return ""; // from their Facebook download: no comments
  const back = ctx.url.pathname + ctx.url.search;
  return html`<section class="thread" id="t-${target}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((r) => html`<div class="comment" id="r${c.id}-${r.id}">
    ${r.mine ? ownerFace(ctx) : r.from ? faceFor(ctx, r.from, r.name, r.id) : friendFace(ctx, c)}
    <div class="bubble"><strong>${r.mine ? ctx.user.name : r.name}</strong>${!r.mine && notFriend(ctx, r.from)}<span class="said">${linkify(r.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(r.created_at)}">${fmtAgo(r.created_at)}</time>
      ${r.mine && moreMenu([r.editable && menuEdit(`edit-r${c.id}-${r.id}`),
        menuDelete(`/_feed/comments/${c.id}/${r.id}/delete`, "Delete this comment?", { back, inplace: "refresh" })])}
    </div>
    ${edited(r)}
    ${r.mine && r.editable && editBox(`edit-r${c.id}-${r.id}`, `r${c.id}-${r.id}`, `/_feed/comments/${c.id}/${r.id}/edit`, r.text, back, MAX_COMMENT)}
  </div>`)}
  <form class="say" method="post" action="/_feed/comments" data-inplace>
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
const friendFace = (ctx, c) => faceFor(ctx, c.origin, c.name, c.id, c.avatar?.thumbSrc);

/**
 * The site of someone who isn't a friend, beside their name on a post or comment, so a look-alike of a friend's name
 * stands out. Friends' addresses are left off (they're on their page) to keep things uncluttered.
 */
function notFriend(ctx, origin, cls = "from") {
  return origin && !Object.hasOwn(ctx.friendFaces ?? {}, origin) ? html`<span class="${cls}">${host(origin)}</span>` : "";
}

/** Someone from another site: the picture their site gave (just now, or remembered), or their initial. */
function faceFor(ctx, origin, name, n, fresh = null) {
  const picture = fresh ?? ctx.friendFaces?.[origin];
  return picture ? html`<img class="who" src="${picture}" alt="" aria-hidden="true">`
    : html`<span class="who who-${n % 6}" aria-hidden="true">${initial(name)}</span>`;
}

/** `back`: where ✕ on one of its photos comes back to (this page and the post on it, unless said otherwise). */
function remoteCard(ctx, c, p, { thread = true, back = `${ctx.url.pathname}${ctx.url.search}#f${c.id}-${p.key}` } = {}) {
  const n = p.photos.length;
  const stay = `?${new URLSearchParams({ in: "post", back })}`;
  const what = p.title && p.title !== "Posted on afterwrd." ? summary(p.title, c.name) : "";
  // An event's card comes back from its own page (only sites new enough for events have one).
  return html`<article class="card social from-friend" id="f${c.id}-${p.key}" data-region="${friendBase(c)}/posts${p.event ? `/${p.key}` : ""}">
  <header>
    ${friendFace(ctx, c)}
    <span class="what"><a href="${friendBase(c)}/posts"><strong>${c.name}</strong></a>
      ${what && html`<span class="meta">${what}</span>`}</span>
    <time title="${fmtDatetime(p.created_at)}">${fmtAgo(p.created_at)}</time>
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
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
    <div class="bubble"><strong>${c.mine ? ctx.user.name : c.name}</strong>${!c.mine && notFriend(ctx, c.from)}<span class="said">${linkify(c.text)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
      ${moreMenu([c.mine && c.editable && menuEdit(`edit-g${p.id}-${c.id}`),
        mayDelete(g, c) && menuDelete(`/_groups/${g.id}/comments/${c.id}/delete`, "Delete this comment?", { back, inplace: "refresh" })])}
    </div>
    ${edited(c)}
    ${c.mine && c.editable && editBox(`edit-g${p.id}-${c.id}`, `g${p.id}-${c.id}`, `/_groups/${g.id}/comments/${c.id}/edit`, c.text, back, MAX_COMMENT, { post: p.id })}
  </div>`)}
  <form class="say" method="post" action="/_groups/${g.id}/comments" data-group="${g.id}" data-post="${p.id}" data-inplace>
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
  return html`<article class="card social in-group" id="gp${p.id}" data-region="${groupBase(g)}/posts/${p.id}">
  <header>
    ${groupFace(ctx, p)}
    <span class="what"><strong>${p.mine ? "You" : p.name}</strong>${!p.mine && notFriend(ctx, p.from, "meta")}</span>
    <a class="when" href="${groupBase(g)}/posts/${p.id}" title="${fmtDatetime(p.created_at)}"><time>${fmtAgo(p.created_at)}</time></a>
    ${moreMenu([p.mine && p.editable && menuEdit(`edit-gp${p.id}`),
      mayDelete(g, p) && menuDelete(`/_groups/${g.id}/posts/${p.id}/delete`,
        "Delete this post, its photos and its comments? This can’t be undone.", { back: groupBase(g), inplace: "remove" })])}
  </header>
  ${p.event && groupEventBlock(ctx, g, p, { full: ctx.url.pathname.includes("/posts/") })}
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
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

// --- events in groups (calendar.js) ---------------------------------------------------------------------------------

const ANSWER_LABELS = [["going", "Going"], ["maybe", "Maybe"], ["no", "Can't go"]];

function dateTile(e) {
  const d = eventDay(e);
  return html`<span class="date-tile" aria-hidden="true"><span>${d.month}</span><strong>${d.day}</strong></span>`;
}

/**
 * An event (in a group's post, a friend's, or the owner's own): when and where, who's coming, and the owner's answer.
 * `href`: its own page. `full` (on that page): who's coming by name, adding it to a calendar (`ics`), changing it
 * (`edit`) and calling it off (`cancel`: the form's action), as allowed. `answer`: where an answer goes ({ action,
 * hidden }), or null for the host, who has none. `note`: who can see it, under the title.
 */
function eventBlock(ctx, e, { href, full = false, answer = null, ics = null, edit = null, cancel = null, cancelNote = "", note = "" }) {
  const over = finishedAt(e) < Date.now() / 1000;
  const back = ctx.url.pathname + ctx.url.search;
  const names = (list) => list.map((x, i) => (x.from === ctx.url.origin ? (i ? "you" : "You") : x.name)).join(", ");
  const counts = [e.going.length && `${e.going.length} going`, e.maybe.length && `${e.maybe.length} maybe`,
    e.invited && `${e.invited} invited`].filter(Boolean).join(" · ");
  const lists = [["Going", e.going], ["Maybe", e.maybe], ["Can't go", e.cantGo ?? []], ["Not answered yet", e.waiting ?? []]];
  return html`<div class="event${e.cancelled_at ? " cancelled" : ""}">
  <div class="event-head">
    ${dateTile(e)}
    <div class="event-what">
      <a class="event-title" href="${href}">${e.title}</a>
      ${e.cancelled_at ? html`<span class="badge as-written">Called off</span>` : over ? html`<span class="badge as-written">Over</span>` : ""}
      <p class="meta"><time>${eventWhen(e, ctx.zone)}</time>${e.place && html`<br>${e.place}`}</p>
      ${counts && html`<p class="meta">${counts}</p>`}
      ${note && html`<p class="meta">${note}</p>`}
    </div>
  </div>
  ${answer && !e.cancelled_at && !over && html`<form method="post" action="${answer.action}" class="answers" aria-label="Are you going?" data-inplace>
    <input type="hidden" name="back" value="${back}">
    ${Object.entries(answer.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${ANSWER_LABELS.map(([value, label]) => html`<button class="chip${e.answer === value ? " primary" : ""}" name="answer" value="${value}"
      aria-pressed="${e.answer === value ? "true" : "false"}">${label}</button>`)}
  </form>`}
  ${full && html`<dl class="answered">
    ${lists.filter(([, list]) => list.length).map(([label, list]) => html`<dt>${label}</dt><dd>${names(list)}</dd>`)}
  </dl>
  <div class="actions-row">
    ${ics && !e.cancelled_at && html`<a class="chip" href="${ics}" download>${raw(icon("calendar"))}<span>Add to my calendar</span></a>`}
    ${edit && !e.cancelled_at && !over && html`<a class="chip" href="${edit}">Change it</a>`}
    ${cancel && !e.cancelled_at && !over && html`<form method="post" action="${cancel}" data-inplace
      data-confirm="${cancelNote}" data-confirm-ok="Call it off">
      <input type="hidden" name="back" value="${back}"><button class="chip">Call it off</button></form>`}
  </div>`}
</div>`;
}

/**
 * Friends to tick, to invite to an event, with a box to find one by name when there are many. `none`: what to say if
 * there's nobody to invite.
 */
function guestPicker(friends, { none = "" } = {}) {
  if (!friends.length) return none && html`<p class="meta">${none}</p>`;
  return html`<fieldset class="guest-picker">
  <legend>Who's invited</legend>
  ${friends.length > 8 && html`<input type="search" class="guest-filter" placeholder="Find a friend" aria-label="Find a friend">`}
  <div class="guest-options">${friends.map((f) => html`<label><input type="checkbox" name="guest" value="${f.id}"><span>${f.name}</span></label>`)}</div>
  <p class="meta">Only the friends you invite see the event. Everyone invited sees who's going and who might.</p>
</fieldset>
<script>
  for (const box of document.querySelectorAll(".guest-filter")) {
    box.addEventListener("input", () => {
      const want = box.value.trim().toLowerCase();
      for (const label of box.parentElement.querySelectorAll(".guest-options label")) label.hidden = !label.textContent.toLowerCase().includes(want);
    });
  }
</script>`;
}

/** On the owner's own event's page: who's invited, taking an invitation back, and inviting more. */
function guestsBlock(ctx, p) {
  const e = p.event;
  const back = ctx.url.pathname + ctx.url.search;
  const over = finishedAt(e) < Date.now() / 1000;
  const answers = { going: "Going", maybe: "Maybe", no: "Can't go" };
  // What became of an invitation not yet answered: their site may be too old to take it, or not answering.
  const waiting = (g) => (g.delivery === "refused" ? "Their site didn't take the invitation: it may need updating"
    : g.delivery === "unreachable" ? "Their site couldn't be reached, so they haven't been told" : "Not answered yet");
  const guests = [...e.going.map((g) => [g, "going"]), ...e.maybe.map((g) => [g, "maybe"]), ...e.cantGo.map((g) => [g, "no"]),
    ...e.waiting.map((g) => [g, null])];
  return html`<details class="guests" id="guests-${p.id}" open>
  <summary>Who's invited (${guests.length})</summary>
  ${guests.length ? html`<ul class="guest-list">${guests.map(([g, answer]) => html`<li>
    <span class="name">${g.name}</span> <span class="meta">${answer ? answers[answer] : waiting(g)}</span>
    <form method="post" action="/_admin/events/${p.id}/uninvite" data-inplace
      data-confirm="Take back ${g.name}'s invitation? They won't see this event any more, and they aren't told." data-confirm-ok="Take it back">
      <input type="hidden" name="back" value="${back}"><input type="hidden" name="guest" value="${g.id}">
      <button class="chip">Take back</button></form>
  </li>`)}</ul>` : html`<p class="meta">Nobody yet.</p>`}
  ${!e.cancelled_at && !over && html`<form method="post" action="/_admin/events/${p.id}/invite" class="stack invite-more">
    <input type="hidden" name="back" value="${back}">
    ${guestPicker(p.invitable ?? [], { none: guests.length ? "You've invited all your friends." : "You have no friends on afterwrd to invite yet." })}
    ${p.invitable?.length > 0 && html`<div class="actions-row"><button class="chip primary">Invite them</button></div>`}
  </form>`}
</details>`;
}

/** An event in a group post (see eventBlock; one that repeats, repeatingBlock). */
function groupEventBlock(ctx, g, p, { full = false } = {}) {
  const base = `${groupBase(g)}/posts/${p.id}`;
  if (p.event.rrule) return repeatingBlock(ctx, g, p, { full });
  return eventBlock(ctx, p.event, { href: base, full, answer: { action: `/_groups/${g.id}/events/${p.id}/answer` }, ics: `${base}/event.ics`,
    edit: p.mine && `${base}/edit`, cancel: mayDelete(g, p) && `/_groups/${g.id}/events/${p.id}/cancel`,
    cancelNote: "Call this event off? Everyone going will be told." });
}

/**
 * A repeating event in a group post: how it repeats, and its next date (or the one asked for, ?date=) with who's
 * coming and the owner's answer to it. `full` (its own page): every date still to come, each answered on its own, with
 * who's coming and, for whoever may, calling off that date; then adding it to a calendar, changing it, calling it all
 * off.
 */
function repeatingBlock(ctx, g, p, { full = false }) {
  const e = p.event;
  const base = `${groupBase(g)}/posts/${p.id}`;
  const back = ctx.url.pathname + ctx.url.search;
  const at = Date.now() / 1000;
  const asked = ctx.url.searchParams.get("date");
  // On its own page, every date; on a card, only those still to come (or the one asked for) are worked out.
  const dates = datesOf(e, full || asked ? {} : { from: at }).map((d) => ({ ...d, over: finishedAt(d) < at }));
  if (!dates.length) dates.push(...datesOf(e).slice(-1).map((d) => ({ ...d, over: true })));
  const next = dates.find((d) => d.date === asked) ?? dates.find((d) => !d.over && !d.cancelled_at) ?? dates.at(-1);
  const over = dates.every((d) => d.over);
  const names = (list) => list.map((x, i) => (x.from === ctx.url.origin ? (i ? "you" : "You") : x.name)).join(", ");
  const counts = (d) => [d.going.length && `${d.going.length} going`, d.maybe.length && `${d.maybe.length} maybe`].filter(Boolean).join(" · ");
  const answers = (d, label) => html`<form method="post" action="/_groups/${g.id}/events/${p.id}/answer" class="answers" aria-label="${label}" data-inplace>
    <input type="hidden" name="back" value="${back}"><input type="hidden" name="date" value="${d.date}">
    ${ANSWER_LABELS.map(([value, words]) => html`<button class="chip${d.answer === value ? " primary" : ""}" name="answer" value="${value}"
      aria-pressed="${d.answer === value ? "true" : "false"}">${words}</button>`)}
  </form>`;
  const open = (d) => !e.cancelled_at && !d.cancelled_at && !d.over;
  return html`<div class="event repeating${e.cancelled_at ? " cancelled" : ""}">
  <div class="event-head">
    ${dateTile(next)}
    <div class="event-what">
      <a class="event-title" href="${base}">${e.title}</a>
      ${e.cancelled_at ? html`<span class="badge as-written">Called off</span>` : over ? html`<span class="badge as-written">Over</span>` : ""}
      <p class="meta">${repeatWords(e)}${e.place && html`<br>${e.place}`}</p>
      ${!over && !e.cancelled_at && html`<p class="meta">${next.date === asked ? "" : "Next: "}<time>${eventWhen(next, ctx.zone)}</time>${next.cancelled_at ? " · called off" : ""}
        ${counts(next) && ` · ${counts(next)}`}</p>`}
    </div>
  </div>
  ${!full && open(next) && answers(next, `Are you going on ${dayName(eventDayParts(next))}?`)}
  ${full && html`<ol class="event-dates">${dates.filter((d) => !d.over).map((d) => html`<li id="d-${d.date}" class="${d.cancelled_at ? "off" : ""}">
    <div class="date-line"><time>${eventWhen(d, ctx.zone)}</time>
      ${d.cancelled_at ? html`<span class="badge as-written">Called off</span>` : counts(d) && html`<span class="meta">${counts(d)}</span>`}</div>
    ${open(d) && answers(d, `Are you going on ${dayName(eventDayParts(d))}?`)}
    ${(d.going.length > 0 || d.maybe.length > 0 || d.cantGo.length > 0) && html`<dl class="answered">
      ${[["Going", d.going], ["Maybe", d.maybe], ["Can't go", d.cantGo]].filter(([, list]) => list.length)
        .map(([label, list]) => html`<dt>${label}</dt><dd>${names(list)}</dd>`)}</dl>`}
    ${open(d) && mayDelete(g, p) && html`<form method="post" action="/_groups/${g.id}/events/${p.id}/cancel" data-inplace class="call-off-date"
      data-confirm="Call off ${dayName(eventDayParts(d))}? Everyone going that day will be told. The other dates stay." data-confirm-ok="Call it off">
      <input type="hidden" name="back" value="${back}"><input type="hidden" name="date" value="${d.date}"><button class="chip">Call off this date</button></form>`}
  </li>`)}</ol>
  <div class="actions-row">
    ${!e.cancelled_at && html`<a class="chip" href="${base}/event.ics" download>${raw(icon("calendar"))}<span>Add to my calendar</span></a>`}
    ${p.mine && !e.cancelled_at && !over && html`<a class="chip" href="${base}/edit">Change it</a>`}
    ${mayDelete(g, p) && !e.cancelled_at && !over && html`<form method="post" action="/_groups/${g.id}/events/${p.id}/cancel" data-inplace
      data-confirm="Call off every date of this event? Everyone going to any of them will be told." data-confirm-ok="Call it all off">
      <input type="hidden" name="back" value="${back}"><button class="chip">Call it all off</button></form>`}
  </div>`}
</div>`;
}

/** The day one date of an event is on, where it's held: { year, month, day }. */
const eventDayParts = (e) => { const [year, month, day] = eventDays(e)[0].split("-").map(Number); return { year, month, day }; };

/** A friend's event, in their post (see eventBlock): only those they invited see it. */
function friendEventBlock(ctx, c, p, { full = false } = {}) {
  const base = `${friendBase(c)}/posts/${p.key}`;
  return eventBlock(ctx, p.event, { href: base, full, answer: { action: "/_feed/answer", hidden: { connection: c.id, target: p.key } },
    ics: `${base}/event.ics`, note: `${c.name}'s event. Only the people ${c.name} invited can see it.` });
}

/** The owner's own event, in their post (see eventBlock). */
function ownEventBlock(ctx, p, { full = false } = {}) {
  return eventBlock(ctx, p.event, { href: `/posts/${p.key}`, full, ics: `/posts/${p.key}/event.ics`, edit: `/posts/${p.key}/event`,
    cancel: `/_admin/events/${p.id}/cancel`, cancelNote: "Call this event off? Everyone invited who hasn't said no will be told.",
    note: "Your event. Only the people you invite can see it." });
}

/**
 * Adding or changing an event. Its times are in `values.zone`, or, for a new one, the browser's own time zone.
 * @param {{ action: string, back: string, values?: Record<string, string>, text?: string, submit: string, guests?: any, repeats?: boolean }} options
 */
function eventForm({ action, back, values = {}, text = "", submit, guests = "", repeats = false }) {
  return html`<form class="stack event-form" method="post" action="${action}">
  <input type="hidden" name="back" value="${back}">
  <input type="hidden" name="zone" value="${values.zone ?? ""}" data-zone>
  <label><span class="field">What's happening</span><input name="title" required maxlength="200" value="${values.title ?? ""}"></label>
  <div class="when-row">
    <label><span class="field">Day</span><input type="date" name="start_date" required value="${values.start_date ?? ""}"></label>
    <label><span class="field">Time <span class="meta">(none for all day)</span></span><input type="time" name="start_time" value="${values.start_time ?? ""}"></label>
  </div>
  <div class="when-row">
    <label><span class="field">Ends <span class="meta">(if it runs on)</span></span><input type="date" name="end_date" value="${values.end_date ?? ""}"></label>
    <label><span class="field">Until <span class="meta">(optional)</span></span><input type="time" name="end_time" value="${values.end_time ?? ""}"></label>
  </div>
  <label><span class="field">Where <span class="meta">(optional)</span></span><input name="place" maxlength="300" value="${values.place ?? ""}"></label>
  ${repeats && html`<div class="when-row repeat-row">
    <label><span class="field">Repeats</span><select name="repeat">
      <option value="">Doesn't repeat</option>
      ${repeatChoices(values.start_date ?? "").map(([value, words]) => html`<option value="${value}" ${values.repeat === value && raw("selected")}>${words}</option>`)}
    </select></label>
    <label><span class="field">Until <span class="meta">(a year if blank)</span></span><input type="date" name="repeat_until" value="${values.repeat_until ?? ""}"></label>
  </div>`}
  <label><span class="field">More about it <span class="meta">(optional)</span></span><textarea name="text" rows="3" maxlength="5000">${text}</textarea></label>
  ${guests}
  <div class="actions-row"><button class="chip primary">${submit}</button></div>
</form>
<script>
  for (const input of document.querySelectorAll("input[data-zone]")) {
    try { input.value ||= Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  }
  // The ways it can repeat say which day: "Every week on Tuesday", "the second Tuesday", "the last Friday".
  for (const form of document.querySelectorAll("form.event-form")) {
    const day = form.querySelector("input[name=start_date]");
    const pick = form.querySelector("select[name=repeat]");
    if (!pick) continue;
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const nths = ["first", "second", "third", "fourth"];
    const th = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
    const ways = (y, m, d) => {
      const wd = names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      const n = Math.ceil(d / 7);
      return { weekly: "Every week on " + wd, fortnightly: "Every two weeks on " + wd, "monthly-date": "Every month on the " + th(d),
        "monthly-day": n <= 4 ? "Every month on the " + nths[n - 1] + " " + wd : null,
        "monthly-last": d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate() ? "Every month on the last " + wd : null };
    };
    const label = () => {
      const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(day.value); // \\d: this is inside a template string
      if (!m) return;
      const words = ways(Number(m[1]), Number(m[2]), Number(m[3]));
      for (const [value, text] of Object.entries(words)) {
        let option = pick.querySelector('option[value="' + value + '"]');
        if (!option) { option = document.createElement("option"); option.value = value; pick.append(option); }
        option.textContent = text || "";
        option.hidden = option.disabled = !text;
      }
      if (pick.selectedOptions[0]?.disabled) pick.value = "";
    };
    day.addEventListener("change", label);
    label();
  }
</script>`;
}

// --- calendars: the owner's (Events) and each group's ----------------------------------------------------------------

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ANSWER_WORDS = { going: "You're going", maybe: "You might go", no: "You can't go" };

/**
 * A month as a grid, Monday first: each day with its events (on a wide screen, the start of each; on a phone, a dot
 * each), linking to that day's list under it. `items`: events as the calendar shows them, each with `href`, `kind`
 * (own, friend or group) and `answer`. `base`: the page's own address, for the month and day links.
 */
function calendarGrid(ctx, items, { month, day, base }) {
  const around = monthAround(month);
  const now = today(ctx.zone);
  const byDay = new Map();
  for (const e of items) for (const key of eventDays(e)) byDay.set(key, [...(byDay.get(key) ?? []), e]);
  const link = (q) => `${base}?${q}`;
  const cls = (e) => ["cal-event", `cal-${e.kind}`, e.cancelled_at && "off", !e.answer && e.kind !== "own" && "unanswered"].filter(Boolean).join(" ");
  return html`<section class="calendar" aria-labelledby="cal-month">
  <header class="cal-head">
    <a class="chip" href="${link(`month=${around.prev}`)}" aria-label="The month before">‹</a>
    <h2 id="cal-month">${around.name}</h2>
    <a class="chip" href="${link(`month=${around.next}`)}" aria-label="The month after">›</a>
    ${(now.year !== month.year || now.month !== month.month || day) && html`<a class="chip" href="${base}">Today</a>`}
  </header>
  <table class="cal-grid">
    <thead><tr>${WEEK.map((d) => html`<th scope="col"><abbr title="${d}">${d[0]}</abbr><span>${d.slice(1)}</span></th>`)}</tr></thead>
    <tbody>${monthWeeks(month).map((week) => html`<tr>${week.map((d) => {
      const list = byDay.get(d.key) ?? [];
      const classes = ["cal-day", !d.inMonth && "out", d.key === dateKey(now) && "today", day && d.key === dateKey(day) && "chosen", list.length && "busy"]
        .filter(Boolean).join(" ");
      return html`<td class="${classes}">
        <a class="cal-num" href="${link(`month=${around.key}&day=${d.key}`)}"${d.key === dateKey(now) && raw(' aria-current="date"')}
          aria-label="${d.day} ${around.name.split(" ")[0]}${list.length ? `, ${list.length} event${list.length > 1 ? "s" : ""}` : ""}">${d.day}</a>
        ${list.length > 0 && html`<ul class="cal-events">${list.slice(0, 3).map((e) => html`<li class="${cls(e)}"><a href="${e.href}">
          ${eventTime(e) && html`<span class="cal-time">${eventTime(e)}</span> `}${e.title}</a></li>`)}
          ${list.length > 3 && html`<li class="cal-more"><a href="${link(`month=${around.key}&day=${d.key}`)}">+${list.length - 3} more</a></li>`}</ul>
        <span class="cal-dots" aria-hidden="true">${list.slice(0, 4).map((e) => html`<span class="${cls(e)}"></span>`)}</span>`}
      </td>`;
    })}</tr>`)}</tbody>
  </table>
  <p class="cal-key meta"><span class="cal-own">Yours</span> <span class="cal-friend">A friend's</span> <span class="cal-group">A group's</span>
    <span class="unanswered">Not answered</span></p>
</section>`;
}

/** Month, Week or List, for a calendar at `base`, `view` being the one shown. */
function calendarSwitch(base, view) {
  return html`<nav class="tabs cal-views" aria-label="Show the calendar by">
  ${[["month", "Month"], ["week", "Week"], ["list", "List"]].map(([key, label]) =>
    html`<a href="${key === "month" ? base : `${base}?view=${key}`}" ${key === view && raw('aria-current="page"')}>${label}</a>`)}
</nav>`;
}

/** A week's heading, with the weeks either side and back to this one. */
function weekHead(ctx, week, base) {
  const around = weekAround(week);
  const now = dateKey(today(ctx.zone));
  return html`<header class="cal-head">
  <a class="chip" href="${base}?view=week&week=${around.prev}" aria-label="The week before">‹</a>
  <h2 id="cal-week">${around.name}</h2>
  <a class="chip" href="${base}?view=week&week=${around.next}" aria-label="The week after">›</a>
  ${!around.days.some((d) => d.key === now) && html`<a class="chip" href="${base}?view=week">This week</a>`}
</header>`;
}

/**
 * The days of a week (from its Monday), each with what's on it: `entry(e)` draws each one (a row on Events, a card
 * on a group's calendar).
 */
function weekDays(ctx, items, week, entry) {
  const now = dateKey(today(ctx.zone));
  return html`<ol class="cal-week">${weekAround(week).days.map((d) => {
    const list = items.filter((e) => eventDays(e).includes(d.key));
    return html`<li class="cal-week-day${d.key === now ? " today" : ""}">
      <h3>${dayName(d)}${d.key === now && html` <span class="badge">Today</span>`}</h3>
      ${list.length ? entry(list) : html`<p class="meta">Nothing on.</p>`}
    </li>`;
  })}</ol>`;
}

/** Everything still to come, by the month it starts in: `entry(list)` draws each month's. */
function upcomingByMonth(items, entry, empty = "Nothing coming up.") {
  const months = [];
  for (const e of items) {
    const d = eventDay(e);
    if (months.at(-1)?.[0] !== d.monthKey) months.push([d.monthKey, d.monthName, []]);
    months.at(-1)[2].push(e);
  }
  return months.length ? months.map(([, name, list]) => html`<h2 class="month">${name}</h2>${entry(list)}`) : html`<p class="empty">${empty}</p>`;
}

/** Events as rows: date tile, title, when, where, whose, and the owner's answer. */
function eventRows(ctx, list) {
  return html`<ul class="plan-list">${list.map((e) => html`<li class="${e.cancelled_at ? "off" : ""}"><a href="${e.href}">
    ${dateTile(e)}
    <span class="what"><strong>${e.title}</strong>
      <span class="meta">${eventWhen(e, ctx.zone)}${e.place && ` · ${e.place}`}</span>
      <span class="meta">${e.who}${e.kind !== "own" && ` · ${ANSWER_WORDS[e.answer] ?? (e.kind === "friend" ? "Invited: not answered yet" : "Not answered")}`}</span></span>
    ${e.cancelled_at && html`<span class="badge as-written">Called off</span>`}
  </a></li>`)}</ul>`;
}

/** The events on a calendar's chosen day, or in its month, as a list: date tile, title, when, where and whose. */
function calendarList(ctx, items, { month, day }) {
  const want = day ? [dateKey(day)] : null;
  const prefix = monthAround(month).key;
  const shown = items.filter((e) => eventDays(e).some((k) => (want ? want.includes(k) : k.startsWith(prefix))));
  const heading = day ? dayName(day) : monthAround(month).name;
  return html`<section class="cal-list" aria-label="Events: ${heading}">
  <h2>${heading}</h2>
  ${shown.length ? eventRows(ctx, shown) : html`<p class="empty">${day ? "Nothing on that day." : "Nothing this month."}</p>`}
</section>`;
}

/** An invitation still to answer, with the three answers right there. */
function invitationCard(ctx, e) {
  return html`<li class="card invitation" id="inv-${e.connection}-${e.key}" data-region="">
  <a class="what" href="${e.href}">${dateTile(e)}<span><strong>${e.title}</strong>
    <span class="meta">${eventWhen(e, ctx.zone)}${e.place && ` · ${e.place}`}</span>
    <span class="meta">${e.who} invited you</span></span></a>
  <form method="post" action="/_feed/answer" class="answers" aria-label="Are you going to ${e.title}?">
    <input type="hidden" name="back" value="/events"><input type="hidden" name="connection" value="${e.connection}">
    <input type="hidden" name="target" value="${e.key}">
    ${ANSWER_LABELS.map(([value, label]) => html`<button class="chip" name="answer" value="${value}">${label}</button>`)}
  </form>
</li>`;
}

/** Events: invitations to answer, the owner's calendar, and making an event. */
export function eventsPage(ctx, { view, month, day, week, items, invitations, friends, unreachable, notAsked = 0, pushKey }) {
  return page(ctx, "Events", html`
<div class="feed-head">
  <h1>Events</h1>
  <a class="chip primary" href="#make">${raw(icon("calendar"))}<span>Make an event</span></a>
</div>
${invitations.length > 0 && html`<section class="invitations">
  <h2>Invitations</h2>
  <ul class="invitation-list">${invitations.map((e) => invitationCard(ctx, e))}</ul>
</section>`}
${unreachable.length > 0 && html`<p class="notice">Couldn't reach ${unreachable.join(", ")} just now: only the events you've said
you'll go to there are shown.</p>`}
${notAsked > 0 && html`<p class="meta">You're in a lot of groups: for ${notAsked} of them, only the events you've said you'll go to
are shown here. Each group's own calendar shows them all.</p>`}
${calendarSwitch("/events", view)}
${view === "month" ? html`${calendarGrid(ctx, items, { month, day, base: "/events" })}${calendarList(ctx, items, { month, day })}`
    : view === "week" ? html`<section class="calendar" aria-labelledby="cal-week">${weekHead(ctx, week, "/events")}
      ${weekDays(ctx, items, week, (list) => eventRows(ctx, list))}</section>`
    : html`<section class="cal-upcoming" aria-label="Coming up">${upcomingByMonth(items, (list) => eventRows(ctx, list))}</section>`}
<details class="card add-event" id="make">
  <summary>Make an event</summary>
  <p class="meta">Only the friends you invite see it, on their own sites. They're told you've invited them, and those who
  haven't said no are told if it changes or is called off. Nothing else is sent.</p>
  ${eventForm({ action: "/_admin/events", back: "/events", submit: "Make the event",
    guests: guestPicker(friends, { none: "You have no friends on afterwrd to invite yet. You can still make it, and invite people later." }) })}
</details>
${notificationsSwitch(pushKey)}
<script>
  // "Make an event" opens the form.
  if (location.hash === "#make") document.getElementById("make").open = true;
  document.querySelector('a[href="#make"]').addEventListener("click", () => { document.getElementById("make").open = true; });
</script>`);
}

/**
 * Notifications on this device (push.js; public/static/notifications.js does the asking): only for invitations, and
 * for changes to events the owner hasn't said no to. Without scripts it only says it's checking.
 */
function notificationsSwitch(pushKey) {
  return html`<section class="card notify" id="notify" data-key="${pushKey}">
  <h2>Notifications on this device</h2>
  <p class="meta">Only when a friend invites you to an event, or an event you haven't said no to changes or is called
  off: never for posts, comments or anything else.</p>
  <p id="notify-status">Checking this device…</p>
  <div class="row">
    <button class="chip primary" data-do="on" hidden>Turn on notifications</button>
    <button class="chip" data-do="off" hidden>Turn them off</button>
  </div>
  <label id="notify-preview" hidden><input type="checkbox"> Show the event on the lock screen (otherwise just who it's from)</label>
  <p class="meta" id="notify-android" hidden>If they only turn up when you unlock your phone, Android is saving battery: set
  Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's notifications
  come through Chrome.</p>
  <p class="error" id="notify-error" role="alert"></p>
</section>
<script src="${asset("/static/notifications.js")}" type="module"></script>`;
}

/**
 * A group's calendar: a month of its events on the grid, the month's (or a chosen day's) events under it to answer,
 * and adding one. The group lists 100 to come and the 30 most recent; earlier months may be missing some.
 */
export function groupCalendarPage(ctx, { membership: g, outdated, group: info, upcoming, past, view, month, day, week, from, to }) {
  if (info) g.ownerFrom = info.ownerFrom;
  const base = `${groupBase(g)}/calendar`;
  const posts = [...past.slice().reverse(), ...upcoming];
  // Every date, a repeating event's each on its own, with the owner's answer to it.
  // Only the dates this view shows are worked out: a group may hold many events that repeat.
  const items = posts.flatMap((p) => datesOf(p.event, { from, to }).map((d) => ({ ...d, kind: "group", who: info?.name ?? g.name,
    href: `${groupBase(g)}/posts/${p.id}${d.date ? `?date=${d.date}` : ""}` })));
  const want = (p) => datesOf(p.event, { from, to }).flatMap(eventDays).some((k) => (day ? k === dateKey(day) : k.startsWith(monthAround(month).key)));
  const shown = posts.filter(want);
  // A month before the oldest event the group still lists (past is newest first) may have had others.
  const missing = past.length >= 30 && monthAround(month).key < eventDays(past.at(-1).event)[0].slice(0, 7);
  const card = (p) => html`<article class="card social in-group" id="gp${p.id}" data-region="">${groupEventBlock(ctx, g, p)}</article>`;
  const at = Date.now() / 1000;
  // The month: the grid, then its events as cards to answer; a week, or what's to come: each date as a row.
  const shownView = view === "week" ? html`<section class="calendar" aria-labelledby="cal-week">${weekHead(ctx, week, base)}
      ${weekDays(ctx, items, week, (list) => eventRows(ctx, list))}</section>`
    : view === "list" ? html`<section class="cal-upcoming" aria-label="Coming up">${upcomingByMonth(items.filter((e) => finishedAt(e) >= at),
      (list) => eventRows(ctx, list))}</section>`
    : html`${calendarGrid(ctx, items, { month, day, base })}
${missing && html`<p class="meta">The group only lists its 30 most recent events: older ones aren't shown.</p>`}
<h2 class="month">${day ? dayName(day) : monthAround(month).name}</h2>
${shown.length ? html`<div class="feed">${shown.map(card)}</div>` : html`<p class="empty">${day ? "Nothing on that day." : "Nothing this month."}</p>`}`;
  return page(ctx, `${info?.name ?? g.name}: calendar`, html`
${groupHead(ctx, g, info, "calendar")}
${outdated ? html`<p class="notice">This group's site needs updating before it can have a calendar. ${g.role === "owner"
    ? html`You can update it from your <a href="/_admin/update">Update</a> page.` : "Its owner can update it from their Update page."}</p>` : html`
<details class="card add-event" ${!upcoming.length && raw("open")}>
  <summary>Add an event</summary>
  <p class="meta">Everyone in the group will see it here. No one is sent anything about it; those who say they're
  going, or might, are told if it changes or is called off.</p>
  ${eventForm({ action: `/_groups/${g.id}/events`, back: base, submit: "Add the event", repeats: true })}
</details>
${calendarSwitch(base, view)}
${shownView}`}`);
}

/** Changing the owner's own event. */
export function ownEventEditPage(ctx, { post }) {
  return page(ctx, "Change the event", html`
<p class="crumbs"><a href="/events">Events</a> /</p>
<section class="card">
  <h2>Change the event</h2>
  <p class="meta">If you change its name, time or place, everyone invited who hasn't said no is told. Its times are in
  ${post.event.time_zone.replace(/_/g, " ")} time.</p>
  ${eventForm({ action: `/_admin/events/${post.id}/edit`, back: `/posts/${post.key}`, values: eventFormValues(post.event),
    text: post.text ?? "", submit: "Save" })}
</section>`);
}

/** Changing an event the owner here added. */
export function groupEventEditPage(ctx, { membership: g, group: info, post }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, `${info.name}: change the event`, html`
${groupHead(ctx, g, info, "calendar")}
<section class="card">
  <h2>Change the event</h2>
  <p class="meta">If you change its name, time or place, those going, or who might, are told. Times are in
  ${post.event.time_zone.replace(/_/g, " ")} time.</p>
  ${eventForm({ action: `/_groups/${g.id}/events/${post.id}/edit`, back: `${groupBase(g)}/posts/${post.id}`,
    values: eventFormValues(post.event), text: post.text ?? "", submit: "Save", repeats: true })}
</section>`);
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
      <span class="year">${new Date(p.created_at * 1000).getUTCFullYear()}</span>
      <span>${words}</span>
    </a>`;
  })}
</section>`;
}

const SIDE_FRIENDS = 12; // on Home; the rest are on Friends

/** "a", "a and b", "a, b and c". */
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The owner's Home: write something, then your posts and your friends' together, newest first.
 * @param {any} ctx
 * @param {Record<string, any> & { auto?: AutoState, checkGrant?: CheckGrant }} data
 */
export function homePage(ctx, { own, feed, onThisDay, friends, newDevices = { devices: [], canConfirm: false }, newNotifying = [], securityFix = null, asking = [], introductions = [], unchecked = false, checkRequests = [], auto = { on: false }, checkFailure = null, friendChecks = [], checkGrant = {} }) {
  const stream = [
    ...own.map((p) => ({ at: p.created_at, card: postCard(ctx, p) })),
    ...feed.posts.map((p) => ({ at: p.created_at, card: remoteCard(ctx, p.connection, p) })),
  ].sort((a, b) => b.at - a.at);
  return page(ctx, "Home", html`
<div class="home">
  <section class="stream" aria-label="Posts">
    <h1 class="hidden">Home</h1>
    ${securityFix && html`<p class="notice alert">afterwrd ${securityFix} fixes a security problem, and this site is older.
      <a href="/_admin/update">Update now</a>.</p>`}
    ${(auto.problem || auto.on && (auto.last?.result && auto.last.result !== "done" || auto.waiting?.needsHand)) && html`<p class="notice alert">
      ${auto.waiting?.needsHand ? html`afterwrd ${auto.waiting.version} has to be installed by hand.`
        : auto.problem ? html`An automatic update couldn't run.`
        : auto.last.result === "kept" ? html`afterwrd ${auto.last.version} failed its checks after updating your site's database, so it was kept.`
        : html`afterwrd ${auto.last.version} didn't work on this site, so it was put back as it was.`}
      <a href="/_admin/update#auto">See what happened</a>.</p>`}
    ${!auto.on && !auto.later && !auto.problem && html`<form class="notice" method="post" action="/_admin/update/auto-later" data-region="" data-inplace="remove">
      afterwrd can keep itself up to date, so you never have to update it, and let your friends' afterwrd sites check it
      now and then, so you'd hear if anything were ever wrong with it. Cloudflare asks you to allow each.
      <a href="/_cloudflare/auto-start?then=checks" id="auto-offer">Turn them on</a>
      <button class="link">Not now</button></form>`}
    ${checkFailure && html`<p class="notice alert" id="check-failure"><strong>${checkFailure.name}'s site checked yours</strong> on
      ${fmtDate(checkFailure.checked_at)} and found something that needs a look: ${checkFailure.problems[0]}
      <a href="/_admin/update#check">See what it found</a>.</p>`}
    ${friendChecks.map((f) => html`<form class="notice alert friend-check" method="post" action="/_admin/checks/found/${f.id}/seen" data-region="" data-inplace="remove">
      ${f.verdict === "needs a look"
        ? html`<span>Your site checked <strong>${f.name}'s site</strong> and found something that needs a look. It's told their
          site too, but it's worth telling ${f.name}.</span>`
        : html`<span><strong>${f.name}'s site</strong> hasn't let yours check it the last ${f.refusals} times it tried. It may just
          be switched off, but it's worth asking ${f.name}.</span>`}
      <a href="/_admin/update#checking">See what it found</a> <button class="link">Put it away</button></form>`)}
    ${checkGrant.problem && html`<p class="notice alert">Your friends' sites can't check yours by themselves any more:
      ${checkGrant.problem} <a href="/_admin/update#check">Let them again</a>.</p>`}
    ${auto.on && !checkGrant.on && !checkGrant.later && !checkGrant.problem && html`<form class="notice" id="checks-offer" method="post" action="/_admin/checks/let-later" data-region="" data-inplace="remove">
      Let your friends' afterwrd sites check yours by themselves now and then, so you'd hear if anything were ever wrong with it.
      <a href="/_admin/update#check">Let them</a> <button class="link">Not now</button></form>`}
    ${newDevices.devices.length > 0 && html`<form class="notice alert" method="post" action="/_admin/devices/seen" data-region="" data-inplace="remove">
      ${newDevices.devices.length === 1
        ? html`A new device was added to your site on ${fmtDate(newDevices.devices[0].created_at)}.`
        : html`${newDevices.devices.length} new devices were added to your site, on ${listed([...new Set(newDevices.devices.map((d) => fmtDate(d.created_at)))])}.`}
      Not you? <a href="/_admin">Remove ${newDevices.devices.length === 1 ? "it" : "them"} in Your devices</a>.
      ${newDevices.canConfirm
        ? html`<button class="link">${newDevices.devices.length === 1 ? "That was me" : "They were all me"}</button>`
        : html`If it was you, say so from one of your older devices.`}</form>`}
    ${newNotifying.length > 0 && html`<form class="notice alert" method="post" action="/_admin/notifications/seen" data-region="" data-inplace="remove">
      Notifications about events were turned on for ${newNotifying.length === 1
        ? html`a new device (${newNotifying[0].name}) on ${fmtDate(newNotifying[0].created_at)}`
        : html`${newNotifying.length} new devices, on ${listed([...new Set(newNotifying.map((d) => fmtDate(d.created_at)))])}`}.
      Not you? <a href="/_admin">Turn ${newNotifying.length === 1 ? "it" : "them"} off in Your devices</a>.
      <button class="link">That was me</button></form>`}
    ${asking.map((r) => html`<form class="notice asking" method="post">
      <strong>${host(r.origin)}</strong>, who says they're ${r.name}, is asking to be friends. ${r.via_kind && askedBecause(r)}
      ${r.invited_as && r.invited_as.toLowerCase() !== r.name.toLowerCase() && html`<strong class="warn">That's not the name you invited (${r.invited_as}).</strong>`}
      <span class="row"><button class="chip primary" formaction="/_admin/connections/${r.id}/approve?back=home">Approve</button>
        <button class="chip" formaction="/_admin/connections/${r.id}/decline?back=home" data-confirm="Decline? Their site will be told no." data-confirm-ok="Decline">Decline</button></span>
    </form>`)}
    ${introductions.map((i) => introductionCard(i, "/", "div"))}
    <div class="notice install-note" id="install-note" hidden>
      <span><strong>Put afterwrd on your home screen.</strong> It opens like an app, in one tap, and can tell you when a
        friend invites you to an event.</span>
      <span class="row actions-row"><button class="chip primary" data-install hidden>Install</button>
        <a class="chip primary" href="/app" data-install-how>Show me how</a>
        <button class="chip" data-install-later>Not now</button></span>
    </div>
    ${checkRequests.map((r) => html`<div class="notice check-request" data-region="">
      <span><strong>${r.name}</strong> asks you to check their afterwrd site. Make a link, and send it to them by message.</span>
      <span class="row actions-row"><button class="chip primary" data-check-request="${r.id}">Make a check link</button>
        <form method="post" action="/_admin/checks/requests/${r.id}/dismiss" class="inline" data-inplace="remove"><button class="chip">Not now</button></form></span>
      <span class="check-share row actions-row" hidden><button class="chip primary" data-share>Send it to ${r.name}…</button>
        <button class="chip" data-copy>Copy the link</button></span>
      <span class="error" role="alert"></span>
    </div>`)}
    ${checkRequests.length > 0 && html`<script>
      // A friend asked for a check: make the link here, then hand it to the phone's share sheet (or copy it).
      document.addEventListener("click", async (e) => {
        const card = e.target.closest(".check-request");
        if (!card) return;
        const make = e.target.closest("button[data-check-request]");
        const error = card.querySelector(".error");
        const send = () => navigator.share({ text: card.dataset.message }).catch(() => {});
        if (make) {
          make.disabled = true;
          error.textContent = "";
          try {
            const res = await fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ connection: Number(make.dataset.checkRequest) }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Something went wrong.");
            card.dataset.message = data.message;
            make.parentElement.hidden = true;
            card.querySelector(".check-share").hidden = false;
            card.querySelector("[data-share]").hidden = !navigator.share;
            if (navigator.share) send();
          } catch (err) {
            error.textContent = err.message;
            make.disabled = false;
          }
        }
        if (e.target.closest("[data-share]")) send();
        const copy = e.target.closest("[data-copy]");
        if (copy) {
          await navigator.clipboard.writeText(card.dataset.message);
          copy.textContent = "Copied: paste it into a message";
        }
      });
    </script>`}
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

/**
 * Add to home screen: the browser's own Install where it has one (ui.js), and how to do it on each kind of device.
 * ui.js shows only the steps for the device it's looking at (data-device), with the rest a tap away; without
 * scripts, all of them show.
 */
export function appPage(ctx) {
  return page(ctx, "Add to home screen", html`
<h1>Add afterwrd to your home screen</h1>
<p>Then it opens like an app: full screen, in one tap, and you don't need to remember your site's address. It can
also tell you when a friend invites you to an event, or one you're going to changes: turn that on in
<a href="/events#notify">Events</a>.</p>
<p><button class="chip primary" data-install hidden>Install afterwrd</button></p>
<section class="card" data-device="iphone-elsewhere" hidden>
  <h2>iPhone or iPad: open this page in Safari first</h2>
  <p>On an iPhone or iPad, afterwrd goes on the home screen from <strong>Safari</strong>, and this page is open
    somewhere else: another browser, or inside another app such as WhatsApp or an email app.</p>
  <ol>
    <li><button class="chip" data-copy-address>Copy this page's address</button></li>
    <li>Open <strong>Safari</strong>, tap the address bar, paste it, and go.</li>
    <li>Then follow the steps for Safari.</li>
  </ol>
</section>
<section class="card" data-device="iphone">
  <h2>iPhone or iPad (Safari)</h2>
  <ol>
    <li>Tap <strong>Share</strong>: a square with an arrow pointing up. Where it is depends on how Safari is set out:
      <ul>
        <li>With a row of buttons along the bottom of the screen, it's the one in the middle.</li>
        <li>Otherwise, tap <strong>⋯</strong> (three dots) next to the address, then <strong>Share</strong>.</li>
      </ul></li>
    <li>Under the row of apps, scroll down the list and tap <strong>Add to Home Screen</strong>.</li>
    <li>If you see <strong>Open as Web App</strong>, leave it switched on. Tap <strong>Add</strong>.</li>
    <li>Open afterwrd from its new icon on your home screen, and sign in once more: the app keeps its own sign-in,
      separate from Safari's.</li>
  </ol>
  <p class="meta">If a link to afterwrd opened inside another app (WhatsApp, or an email app), there's no
    <strong>Add to Home Screen</strong> there: open the page in Safari first.</p>
  <p class="meta">On an iPhone or iPad, notifications only work in the app on the home screen.</p>
</section>
<section class="card" data-device="android">
  <h2>Android (Chrome)</h2>
  <ol>
    <li>Tap <strong>⋮</strong>, at the top right.</li>
    <li>Tap <strong>Install app</strong> (on some phones, <strong>Add to Home screen</strong>).</li>
    <li>Open afterwrd from its new icon.</li>
  </ol>
  <p class="meta">If notifications only turn up when you unlock your phone, Android is saving battery:
  set Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's
  notifications come through Chrome.</p>
</section>
<section class="card" data-device="computer">
  <h2>A computer (Chrome or Edge)</h2>
  <p>Look for <strong>Install</strong> at the right-hand end of the address bar, or in the browser's menu.</p>
</section>
<p data-device-others hidden><button class="chip" data-show-devices>Steps for another phone or computer</button></p>`);
}
