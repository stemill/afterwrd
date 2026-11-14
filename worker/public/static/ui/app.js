// The home-screen app. The service worker (public/static/app/push-sw.js) lets afterwrd be installed as an app, and
// notify about events. "Add to home screen" (the menu, /app, and a note on Home until it's installed or "Not now")
// uses the browser's own Install where it has one (Chrome), and shows how where it hasn't (Safari).

const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/app/push-sw.js", { scope: "/" }).catch(() => {});
const note = document.getElementById("install-note");
let offer = null; // the browser's own Install, where it has one
const showOffers = () => {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-install]")).forEach((b) => { b.hidden = !offer; });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-install-how]")).forEach((a) => { a.hidden = Boolean(offer); });
};
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // offered here, quietly, instead of the browser's own banner
  offer = e;
  showOffers();
});
window.addEventListener("appinstalled", () => { offer = null; note?.remove(); showOffers(); });
document.addEventListener("click", async (e) => {
  if (/** @type {Element} */ (e.target).closest("[data-install]") && offer) {
    const asked = offer;
    offer = null;
    await asked.prompt();
    if ((await asked.userChoice).outcome === "accepted") note?.remove();
    showOffers();
  }
  if (/** @type {Element} */ (e.target).closest("[data-install-later]")) {
    try { localStorage.setItem("afterwrd-install-later", "1"); } catch {}
    note?.remove();
  }
});
let later = false;
try { later = localStorage.getItem("afterwrd-install-later") === "1"; } catch {}
if (installed) {
  document.querySelectorAll('.menu a[href="/app"]').forEach((a) => a.remove());
  note?.remove();
} else if (note && !later) {
  note.hidden = false;
}
showOffers();

// Add to home screen (/app): only the steps for this device, with the rest a tap away. On an iPhone or iPad it has
// to be Safari itself: other browsers, and apps that open links inside themselves, say so in their user agent
// (an app showing Safari's own view can't be told apart, so the Safari steps mention that too).
const cards = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-device]"));
if (cards.length) {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const notSafari = !/Safari\//.test(ua) || /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\//.test(ua);
  const device = apple ? (notSafari ? "iphone-elsewhere" : "iphone") : /Android/.test(ua) ? "android" : "computer";
  const mine = device === "iphone-elsewhere" ? ["iphone-elsewhere", "iphone"] : [device];
  cards.forEach((c) => { c.hidden = !mine.includes(c.dataset.device); });
  const others = /** @type {HTMLElement | null} */ (document.querySelector("[data-device-others]"));
  if (others) others.hidden = false;
  document.addEventListener("click", async (e) => {
    if (/** @type {Element} */ (e.target).closest("[data-show-devices]")) {
      cards.forEach((c) => { if (c.dataset.device !== "iphone-elsewhere") c.hidden = false; });
      if (others) others.hidden = true;
    }
    const copy = /** @type {Element} */ (e.target).closest("[data-copy-address]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(location.href);
        copy.textContent = "Copied";
      } catch {
        copy.replaceWith(Object.assign(document.createElement("strong"), { textContent: location.href }));
      }
    }
  });
}
