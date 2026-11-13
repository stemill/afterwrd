// The service worker for the home-screen app: the small script the phone or computer keeps for this site. It's what
// lets the site be installed as an app, and the phone wakes it, even while asleep, when the site sends a notification
// about an event: an invitation, or a change to one the owner hasn't said no to (src/push.js). It shows the
// notification, and opens that event when it's tapped.
// It also says when the site can't be reached: with no signal or Wi-Fi, a page that won't load gets a short page of its
// own (offlinePage) in place of the browser's error. No pages are kept on the device (a phone may be shared, and pages
// are private), and it never fetches a page itself: the browser does (navigation preload), as it would with no
// service worker, so the site sees exactly where a request came from (its Origin and Sec-Fetch-Site checks).
// A notification is encrypted for this device by its own site (src/webpush.js): { title, body, url, tag }. tag: which
// event it's about, so a change takes the place of the invitation still showing, rather than adding another.

self.addEventListener("install", () => self.skipWaiting());
// Navigation preload: the browser starts fetching a page while this script wakes up, so standing in between costs
// nothing.
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  self.clients.claim(),
  self.registration.navigationPreload?.enable().catch(() => {}),
])));

self.addEventListener("fetch", (event) => {
  // Only opening a page. Not forms being sent (a POST), nor anything a page asks for itself, and nothing at all in a
  // browser without navigation preload: those go to the site as normal, untouched.
  const { request } = event;
  if (request.mode !== "navigate" || request.method !== "GET" || !self.registration.navigationPreload) return;
  event.respondWith((async () => {
    try {
      // The page as the browser fetched it. Preload is switched on before this worker handles anything (activate),
      // so it's always there; if it somehow isn't, this says offline (and loads by itself) rather than fetch the page
      // from here, which would send it as from this site.
      return (await event.preloadResponse) ?? offlinePage();
    } catch {
      return offlinePage();
    }
  })());
});

/**
 * Said when a page can't be reached at all, with its own words and colours (the site's stylesheet may not be on the
 * device), in the look (dark or light) chosen on the site. It tries again by itself until the site answers.
 * Its colours copy style.css's :root and its look script nav.js LOOK: change them together.
 */
function offlinePage() {
  const page = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16201b">
<title>You're offline · afterwrd</title>
<script>
(() => {
  let choice = null;
  try { choice = localStorage.getItem("afterwrd-look"); } catch {}
  const light = choice === "light" || (choice === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.look = light ? "light" : "dark";
  if (light) document.querySelector('meta[name="theme-color"]').content = "#f6f1e8";
  // Loading by itself: when the phone says it's back online, and, as it can't always tell (Wi-Fi with no internet),
  // by asking the site for a tiny public file every few seconds while this is on screen.
  const retry = () => fetch("/static/app/manifest.webmanifest", { cache: "no-store" }).then(() => location.reload(), () => {});
  addEventListener("online", retry);
  setInterval(() => { if (document.visibilityState === "visible") retry(); }, 5000);
})();
</script>
<style>
@font-face { font-family: "Nunito"; src: url("/static/fonts/nunito.woff2") format("woff2"); font-weight: 200 1000; }
@font-face { font-family: "Nunito Sans"; src: url("/static/fonts/nunito-sans.woff2") format("woff2"); font-weight: 200 1000; }
:root { --bg: #16201b; --surface: #1f2b25; --text: #ede6da; --muted: #a9a092; --ember: #ff8a3d; --button: #ede6da; --on-button: #16201b; }
:root[data-look="light"] { --bg: #f6f1e8; --surface: #fffdf8; --text: #1f2a24; --muted: #6b6458; --button: #24332b; --on-button: #f6f1e8; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem 1rem; background: var(--bg); color: var(--text);
  font: 1.05rem/1.55 "Nunito Sans", system-ui, sans-serif; }
main { max-width: 26rem; width: 100%; background: var(--surface); border-radius: 18px; padding: 1.75rem 1.5rem; }
.wordmark { font: 900 1.6rem/1 "Nunito", system-ui, sans-serif; letter-spacing: -0.02em; display: inline-flex; align-items: center; }
.wordmark svg { width: 0.95em; height: 0.95em; color: var(--ember); margin: 0 0.02em; }
h1 { font: 800 1.35rem/1.3 "Nunito", system-ui, sans-serif; margin: 1.25rem 0 0.5rem; }
p { margin: 0 0 1.25rem; color: var(--muted); }
button { font: 800 1rem "Nunito", system-ui, sans-serif; background: var(--button); color: var(--on-button); border: 0; border-radius: 999px;
  padding: 0.7rem 1.4rem; cursor: pointer; }
</style>
</head>
<body>
<main>
<span class="wordmark" aria-label="afterwrd">afterw<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-4.7 14.5L3.8 20l1.2-3.6A8 8 0 0 1 12 4z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>rd</span>
<h1>You're offline</h1>
<p>Check you've got signal or Wi-Fi. This page will load by itself once you're connected.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;
  // The same protections as the site's own pages (src/index.js), as this one never passes through it.
  return new Response(page, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" } });
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  event.waitUntil(show(message, text(message.tag, 200), text));
});

// One notification per event. Phones (Chrome on Android) don't make a sound for a notification that replaces one
// already showing, so a new one takes that event's last one away and comes as new.
async function show(message, about, text) {
  if (about) (await self.registration.getNotifications()).filter((n) => n.data?.about === about).forEach((n) => n.close());
  return self.registration.showNotification(text(message.title, 100) || "afterwrd", {
    body: text(message.body, 500),
    tag: about ? `${about}-${Date.now()}` : undefined,
    icon: "/static/app/icon-192.png",
    data: { url: sameSite(message.url), about },
  });
}

// The device's push service sometimes gives it a new address (Firefox does, now and then). The site is told, so
// notifications carry on there; the browser sends the session's cookie with it, as from a page. Without the old
// subscription to go on, nothing can be done here: Events shows notifications as off, to turn on again.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const key = old?.options?.applicationServerKey;
    if (!old || !key) return;
    const fresh = event.newSubscription ?? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch("/_push/devices/renew", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old: old.endpoint, ...fresh.toJSON() }) });
  })().catch(() => {}));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = sameSite(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    // A window already on Events or Notifications goes to the event; anything else (an import, a download being made)
    // is left alone, and it opens in a window of its own.
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const there = open.find((c) => new URL(c.url).origin === self.location.origin && /^\/(events|activity)\b/.test(new URL(c.url).pathname));
    if (there?.navigate) {
      await there.focus();
      if (await there.navigate(url).catch(() => null)) return null;
    }
    return self.clients.openWindow(url);
  })());
});

/** A page on this site only, as a whole address (a path alone like "//elsewhere" would leave it): anything else is Home. */
function sameSite(value) {
  const home = new URL("/", self.location.origin).href;
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin && !url.pathname.startsWith("//") ? url.href : home;
  } catch {
    return home;
  }
}
