// The service worker for the home-screen app: the small script the phone or computer keeps for this site. It's what
// lets the site be installed as an app, and the phone wakes it, even while asleep, when the site sends a notification
// about a message (src/push.js). It shows the notification, and opens that chat when it's tapped. It does nothing
// else: no caching, and it never handles the site's own requests.
// A notification is encrypted for this device by its own site (src/webpush.js): { title, body, url, tag, quiet, badge }.
// tag: which chat it's about. quiet: more from a chat that's just made a sound, which bring its notification up to
// date without another.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const chat = text(message.tag, 100);
  const badge = Number.isInteger(message.badge) && message.badge > 0 && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(message.badge).catch(() => {}) : null;
  event.waitUntil(Promise.all([show(message, chat, text), badge]));
});

// One notification per chat. Phones (Chrome on Android) don't make a sound for a notification that replaces one
// already showing, so one that should be heard takes the chat's last one away and comes as new; a quiet one (more
// from the same chat within the minute) brings the one that's showing up to date in its place.
async function show(message, chat, text) {
  const showing = chat ? (await self.registration.getNotifications()).filter((n) => n.data?.chat === chat) : [];
  let tag = chat ? `${chat}-${Date.now()}` : undefined;
  if (message.quiet && showing.length) tag = showing.at(-1).tag;
  else showing.forEach((n) => n.close());
  return self.registration.showNotification(text(message.title, 100) || "afterwrd", {
    body: text(message.body, 500),
    tag,
    renotify: false,
    silent: Boolean(message.quiet && showing.length),
    icon: "/static/app/icon-192.png",
    data: { url: sameSite(message.url), chat },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = sameSite(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    // A window already on Messages goes to the chat; anything else (an import, a download being made) is left alone.
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const chatting = open.find((c) => new URL(c.url).origin === self.location.origin && new URL(c.url).pathname.startsWith("/messages"));
    if (chatting?.navigate) {
      await chatting.focus();
      if (await chatting.navigate(url).catch(() => null)) return null;
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
