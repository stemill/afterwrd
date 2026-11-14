// The frame every signed-in page is drawn in (routes in archive/routes.js): the header, the main column and, for
// the Facebook download's pages, the Memories tabs. Views only draw: they read nothing and change nothing.


import { asset, FAVICON, initial, ownerMain, ownerMenu, siteHeader } from "./nav.js";
import { html, raw } from "./html.js";

// Memories: everything from the Facebook download, each shown if the owner published that section.
export const MEMORIES = [
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
    face: { initial: initial(ctx.user.name), picture: picture && `/files/${picture.thumb_hash ?? picture.hash}` } });
}

export function layout(ctx, { title, bodyClass = "", main }) {
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
  ${mentionData("mention-people", ctx.people ?? [])}
</body>
</html>`;
}

/**
 * Data for the browser's scripts, in the page: `value` as JSON in a <script type="application/json">, which never
 * runs. "<" is written as \u003c, so nothing in it (friends' names come from their sites) can end the script early.
 */
export const mentionData = (id, value) => raw(`<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`);

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
