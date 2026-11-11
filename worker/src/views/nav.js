// The site header shared by every signed-in page: the logo, the main menu (Home, Photos, Friends, Groups, Notifications),
// and the person's picture, behind which sits everything else (profile, Memories, the owner's tools, Sign out).
// Icons are inline SVG so nothing is fetched.
import pkg from "../../package.json";
import { escape, now } from "../util.js";

// Site files are fetched by a versioned address, so a browser holding an old copy fetches each release's afresh.
export const asset = (path) => `${path}?v=${pkg.version}`;

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  overview: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  timeline: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  posts: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 16h4"/>',
  photos: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  comments: '<path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"/>',
  // messages: two speech bubbles, one answering the other
  messages: '<path d="M3 5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-4 3V5z"/><path d="M18 9h2a1 1 0 0 1 1 1v10l-4-3h-6a1 1 0 0 1-1-1v-1"/>',
  likes: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  friends: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3 3 0 0 1 0 6M21 20c0-2.6-1.6-4.8-4-5.6"/>',
  // connected friends (their own afterwrd sites): two people
  connected: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 20c0-2.8 2.2-5 5-5s5 2.2 5 5"/><path d="M12 20c0-2.8 2.2-5 5-5s5 2.2 5 5"/>',
  // groups: three people, one in front
  groups: '<circle cx="12" cy="8" r="3"/><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M5.5 6.5a2.5 2.5 0 0 0 0 5M2 18c0-2 1.2-3.7 3-4.4M18.5 6.5a2.5 2.5 0 0 1 0 5M22 18c0-2-1.2-3.7-3-4.4"/>',
  poll: '<path d="M4 6h9M4 12h16M4 18h6"/>', // answers' bars
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  memories: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  devices: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/>', // a phone
  app: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M12 8v7M8.5 11.5h7"/>', // a phone with a plus
  import: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  update: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  connections: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  export: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  activity: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  more: '<path d="m6 9 6 6 6-6"/>', // a small V: the menu on something you wrote (Edit, Delete)
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
};

export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// The logo: "the missing o". afterwrd drops the o from afterword; the logo puts it back as a speech bubble, so the
// name reads whole. On its own, the bubble on an ember tile is the site's icon.
const BUBBLE = "M12 4a8 8 0 1 1-4.7 14.5L3.8 20l1.2-3.6A8 8 0 0 1 12 4z";
export const LOGO = `<span class="wordmark">afterw<svg class="o" viewBox="0 0 24 24" aria-hidden="true"><path d="${BUBBLE}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>rd</span>`;
// The icon in the browser's tab, and the home-screen app's manifest and icon (public/static/app/), for every page.
export const FAVICON = `<link rel="manifest" href="/static/app/manifest.webmanifest">
<link rel="apple-touch-icon" href="/static/app/icon-180.png">
<meta name="apple-mobile-web-app-title" content="afterwrd">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#ff8a3d"/><path d="${BUBBLE}" transform="translate(2.4 2.2) scale(0.8)" fill="none" stroke="#16201b" stroke-width="3.6" stroke-linejoin="round"/></svg>`,
)}">`;

/**
 * The header. `main`: [{ key, label, href, badge? }] (badge: a count, or true for a dot); `menu`: the same, shown
 * behind the person's picture, with Sign out last (a small form, so another site can't sign people out with a link);
 * `current`: the key of the page you're on; `face`: { initial, picture? } for the picture.
 */
export function siteHeader({ main, menu, current, face = {}, updateKnown = true }) {
  const badge = (b) => (b === true ? '<span class="dot" aria-hidden="true"></span>'
    : b ? `<span class="count">${Number(b)}<span class="hidden"> new</span></span>` : "");
  const link = ({ key, label, href, badge: b }) =>
    `<a href="${escape(href)}"${key === current ? ' aria-current="page"' : ""}>${icon(key)}<span>${escape(label)}</span>${badge(b)}</a>`;
  const waiting = menu.some((i) => i.badge);
  const picture = face.picture
    ? `<img src="${escape(face.picture)}" alt="">`
    : face.initial ? escape(face.initial) : icon("profile");
  // data-now is when the page was made, so live.js can ask what's new since (see live.js).
  // data-ask-soon: this page doesn't know whether an update is waiting, so live.js asks right away.
  return `<header class="site" data-now="${now()}"${updateKnown ? "" : " data-ask-soon"}><div class="bar">
  <a class="brand" href="/" aria-label="afterwrd, home">${LOGO}</a>
  <nav class="main" aria-label="Main">${main.map(link).join("")}</nav>
  <details class="me">
    <summary aria-label="Your menu${waiting ? " (something's waiting)" : ""}"><span class="face">${picture}</span>${waiting ? '<span class="dot" aria-hidden="true"></span>' : ""}</summary>
    <div class="menu">
      ${menu.map(link).join("")}
      ${menu.length ? "<hr>" : ""}
      <form method="post" action="/_auth/logout"><button>${icon("signout")}<span>Sign out</span></button></form>
      <p class="about">afterwrd ${escape(pkg.version)} · free software ·
        <a href="https://github.com/${escape(pkg.afterwrd.releases)}/tree/v${escape(pkg.version)}" target="_blank" rel="noopener">Source</a> ·
        <a href="/static/licenses.txt" target="_blank">Licences</a></p>
    </div>
  </details>
</div></header>
<script src="${asset("/static/live.js")}" defer></script>
<script src="${asset("/static/ui.js")}" defer></script>
<script>
  // Close the menu when clicking anywhere else.
  document.addEventListener("click", (e) => {
    const menu = document.querySelector("details.me[open]");
    if (menu && !menu.contains(e.target)) menu.open = false;
  });
</script>`;
}

/**
 * The owner's main menu. Notifications carries the count of new comments, Friends of requests to connect, and
 * Messages of chats with something unread (and not muted).
 */
export const ownerMain = (newComments = 0, requests = 0, messages = 0) => [
  { key: "home", label: "Home", href: "/" },
  { key: "messages", label: "Messages", href: "/messages", badge: messages },
  { key: "photos", label: "Photos", href: "/photos" },
  { key: "connected", label: "Friends", href: "/friend", badge: requests },
  { key: "groups", label: "Groups", href: "/groups" },
  { key: "activity", label: "Notifications", href: "/activity", badge: newComments },
];

/** What's behind the owner's picture. `memories`: whether there's anything from Facebook to show. */
export const ownerMenu = ({ memories = true, updateWaiting = false } = {}) => [
  { key: "profile", label: "Your profile", href: "/posts" },
  ...(memories ? [{ key: "memories", label: "Memories", href: "/memories" }] : []),
  { key: "devices", label: "Your devices", href: "/_admin" },
  { key: "app", label: "Add to home screen", href: "/app" }, // hidden in the app itself (ui.js)
  { key: "import", label: "Import", href: "/_admin/import" },
  { key: "export", label: "Download everything", href: "/_admin/export" },
  { key: "update", label: updateWaiting ? "Update available" : "Update", href: "/_admin/update", badge: updateWaiting },
];

/** The header for the owner's own pages (People, Import, Update…), which sit behind the picture. */
export function ownerHeader(current) {
  return siteHeader({ main: ownerMain(), menu: ownerMenu(), current, updateKnown: false });
}
