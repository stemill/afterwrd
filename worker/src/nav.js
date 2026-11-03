// The site header shared by every signed-in page: the logo and a row of chips, each an icon and a label.
// Icons are inline SVG so nothing is fetched.
import pkg from "../package.json";
import { escape } from "./util.js";

// Site files are fetched by a versioned address, so a browser holding an old copy fetches each release's afresh.
// (heybert 0.1 let browsers keep the stylesheet for a week without checking.)
export const asset = (path) => `${path}?v=${pkg.version}`;

const ICONS = {
  overview: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  timeline: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  posts: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 16h4"/>',
  photos: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  comments: '<path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"/>',
  likes: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  friends: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3 3 0 0 1 0 6M21 20c0-2.6-1.6-4.8-4-5.6"/>',
  archive: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 1h13v-3"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M19 8v6M16 11h6"/>',
  import: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  update: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  feed: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  connections: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  export: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  activity: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
};

export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// The logo: a bookmark (somewhere kept) on a jade tile, beside the name.
export const LOGO = `<span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/></svg></span>afterwrd`;

/**
 * items: [{ key, label, href, badge? }], each key one of ICONS; `current` is the key to mark as the page you're on;
 * `badge` is a count to show on the chip, such as new comments.
 * Sign out is always last, as a small form (so another site can't sign people out with a link).
 */
export function siteHeader(items, current) {
  const chip = ({ key, label, href, tool, badge }) =>
    `<a href="${escape(href)}" class="chip${tool ? " tool" : ""}"${key === current ? ' aria-current="page"' : ""}${tool ? ` title="${escape(label)}" aria-label="${escape(label)}"` : ""}>${icon(key)}<span>${escape(label)}</span>${badge ? `<span class="count">${Number(badge)}<span class="hidden"> new</span></span>` : ""}</a>`;
  const main = items.filter((i) => !i.tool).map(chip).join("");
  const tools = items.filter((i) => i.tool).map(chip).join("");
  return `<header class="site">
  <a class="brand" href="/">${LOGO}</a>
  <nav>${main}</nav>
  <div class="tools">${tools}<form method="post" action="/_auth/logout"><button class="chip tool" title="Sign out" aria-label="Sign out">${icon("signout")}<span>Sign out</span></button></form></div>
</header>`;
}

// The owner's pages, shown as compact icon buttons beside Sign out so the archive's sections keep the menu to one row.
export const OWNER_ITEMS = [
  { key: "people", label: "People", href: "/_admin", tool: true },
  { key: "import", label: "Import", href: "/_admin/import", tool: true },
  { key: "export", label: "Download everything", href: "/_admin/export", tool: true },
  { key: "update", label: "Update", href: "/_admin/update", tool: true },
];

/** The header for the owner's pages: back to the archive, then People, Import, Update (labelled, since they're the subject). */
export function ownerHeader(current) {
  return siteHeader([{ key: "archive", label: "Archive", href: "/" }, ...OWNER_ITEMS.map((i) => ({ ...i, tool: false }))], current);
}
