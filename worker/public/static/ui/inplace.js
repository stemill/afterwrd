import { restoreDrafts } from "./drafts.js";

// The things you do while reading (a comment, changing or deleting one, answering a poll or an event, editing or
// deleting a post, putting a notice away) happen where you are: no new page, so nothing jumps. A form marked
// data-inplace is sent from here; when the site has it, the part of the page it's in (the nearest data-region: a post,
// a photo's comments) is swapped for a fresh copy of that part, drawn by the site as always, from this page; on Home,
// from the page named in data-region instead (the post's own page, or a friend's posts, as their site has it now). data-inplace="remove" takes that part away
// (a deleted post, a notice put away), unless it's the post this page is about: then the site's answer is followed.
// Without scripts, the forms send themselves and the page reloads, as before.
// The same words as the composer's (upload.js OFFLINE).
const OFFLINE = "You're not connected just now, so that hasn't been sent. Try again once you're back online.";
// Said when one's done, for anything that wants to know (the tests do).
const finished = (sent) => document.dispatchEvent(new CustomEvent("afterwrd-inplace", { detail: { sent } }));
/** A note under what was pressed (a menu's Delete: under its menu, which has closed), or none, without words. */
const sayUnder = (form, words) => {
  const under = form.closest("details.more") ?? form;
  let note = under.nextElementSibling?.matches(".form-error") ? under.nextElementSibling : null;
  if (!words) { note?.remove(); return; }
  if (!note) {
    note = Object.assign(document.createElement("p"), { className: "form-error" });
    note.setAttribute("role", "alert");
    under.after(note);
  }
  note.textContent = words;
};
/** What the site said when it refused (its short "message" page), or a plain line if there's nothing to show. */
async function refusal(res) {
  if (res.status === 401) return "You've been signed out. Sign in again (in another tab, so this page stays as it is) and try again.";
  try {
    const page = new DOMParser().parseFromString(await res.text(), "text/html");
    const words = (page.querySelector("main > p:not(.brand)") ?? page.body)?.textContent.trim(); // after the logo
    if (words && words.length < 300) return words;
  } catch {}
  return `That didn't work (the site said ${res.status}). Try again.`;
}
/**
 * A part drawn for another page (Home's posts come from their own page) says to go back there: the forms' "back",
 * and a post's photos' ✕ (?back=, keeping its #anchor). Made to come back to `here` instead.
 */
function backHere(fresh, here) {
  fresh.querySelectorAll('input[name="back"]').forEach((input) => { input.value = here; });
  fresh.querySelectorAll('a[href*="back="]').forEach((a) => {
    const url = new URL(a.getAttribute("href"), location.href);
    const was = url.searchParams.get("back") ?? "";
    url.searchParams.set("back", here + (was.includes("#") ? was.slice(was.indexOf("#")) : ""));
    a.setAttribute("href", url.pathname + url.search);
  });
}
/**
 * `region` swapped for a fresh copy from `source`; the copy, or null if it couldn't be had. `page`: that page
 * already, as the site sent it back with what was sent (Afterwrd-Redrawn), so it isn't asked for again.
 */
async function refresh(region, source, here, page = null) {
  try {
    if (page === null) {
      const res = await fetch(source, { cache: "no-store" });
      if (!res.ok) return null;
      page = await res.text();
    }
    const fresh = new DOMParser().parseFromString(page, "text/html").getElementById(region.id);
    if (!fresh) return null;
    if (source !== here) backHere(fresh, here);
    // The browser would scroll to keep whatever's below still as the post grows (scroll anchoring), so the new
    // comment would seem to push everything up: not while swapping. What's above stays put, and it shows where
    // its box was.
    const root = document.documentElement;
    root.style.overflowAnchor = "none";
    region.replaceWith(document.adoptNode(fresh));
    void fresh.offsetHeight; // laid out now, with anchoring off
    requestAnimationFrame(() => { root.style.overflowAnchor = ""; });
    restoreDrafts(fresh);
    return fresh;
  } catch {
    return null;
  }
}
/**
 * Focus went with the old copy: put it on the same form's button in the new one (the comment box's Post, say), or
 * the part itself, so a keyboard or screen reader carries on from here. Not into a box: that opens a phone's keyboard.
 */
function focusAgain(fresh, form) {
  if (document.activeElement && document.activeElement !== document.body) return;
  const twin = [...fresh.querySelectorAll("form")].find((f) => f.getAttribute("action") === form.getAttribute("action"));
  const button = twin?.querySelector("button:not([disabled])");
  if (button) { button.focus({ preventScroll: true }); return; }
  fresh.tabIndex = -1;
  fresh.focus({ preventScroll: true });
}
/**
 * A comment as it'll look, faded and "Sending…", under the others straight away, while the site and (for a
 * friend's post or a group) the site it goes to take it. Replaced by the real one when the part is redrawn.
 */
function pendingComment(form, text) {
  const make = (tag, props) => Object.assign(document.createElement(tag), props);
  const picture = /** @type {HTMLImageElement | null} */ (document.querySelector("header.site details.me .face img"));
  const name = form.dataset.me ?? "";
  const who = picture ? make("img", { className: "who", src: picture.src, alt: "" }) : make("span", { className: "who", textContent: name.slice(0, 1) });
  who.setAttribute("aria-hidden", "true");
  const bubble = make("div", { className: "bubble" });
  bubble.append(make("strong", { textContent: name }), make("span", { className: "said", textContent: text }));
  const under = make("div", { className: "under" });
  under.append(make("span", { className: "sending", textContent: "Sending…" }));
  const comment = make("div", { className: "comment pending" });
  comment.setAttribute("aria-busy", "true");
  comment.append(who, bubble, under);
  return comment;
}
document.addEventListener("submit", async (e) => {
  const form = /** @type {HTMLFormElement} */ (e.target);
  const submitter = /** @type {HTMLButtonElement | null} */ (e.submitter);
  if (e.defaultPrevented || !form.matches("form[data-inplace]")) return;
  const region = /** @type {HTMLElement | null} */ (form.closest("[data-region]"));
  const removing = form.dataset.inplace === "remove";
  const nothingToRedraw = !removing && !region?.id;
  // Deleted from its own page, or one of its photos': the site says where next.
  const thisPagesPost = removing && Boolean(region?.dataset.region)
    && (location.pathname === region.dataset.region || location.pathname.startsWith(`${region.dataset.region}/`));
  if (!region || nothingToRedraw || thisPagesPost) return; // sent the ordinary way
  e.preventDefault();
  // One thing at a time in each part: each send redraws it, so a second would land on a copy that's gone.
  if (region.dataset.sending) return;
  const here = location.pathname + location.search;
  const source = (location.pathname === "/" && region.dataset.region) || here;
  const body = new FormData(form);
  if (submitter?.name) body.append(submitter.name, submitter.value); // a poll's choice is the button pressed
  // Meanwhile the part waits: its buttons off, and its boxes not taking words that the redraw would lose.
  region.dataset.sending = "1";
  const held = [.../** @type {NodeListOf<HTMLButtonElement | HTMLTextAreaElement>} */ (region.querySelectorAll("button, textarea"))]
    .filter((el) => !el.disabled && !(el instanceof HTMLTextAreaElement && el.readOnly));
  const hold = (on) => held.forEach((el) => { if (el instanceof HTMLTextAreaElement) el.readOnly = on; else el.disabled = on; });
  hold(true);
  sayUnder(form, "");
  // The button pressed shows it's working (style.css .busy); a new comment shows at once, faded, and its box empties.
  const pressed = submitter?.form === form ? submitter : form.querySelector("button");
  pressed?.classList.add("busy");
  const box = form.matches(".say") ? form.querySelector("textarea") : null;
  const words = box?.value.trim() ? box.value : "";
  const pending = words ? pendingComment(form, words) : null;
  if (pending) {
    form.before(pending);
    box.value = "";
  }
  const failed = (said) => {
    delete region.dataset.sending;
    hold(false);
    pressed?.classList.remove("busy");
    pending?.remove();
    if (pending && !box.value) box.value = words;
    sayUnder(form, said); // and any words stay in their box, kept on this device
    finished(false);
  };
  let res;
  try {
    // Afterwrd-Redraw: the page to redraw this part from, which the site sends back with its answer when it worked
    // (index.js redrawn), so it isn't asked for again.
    const headers = removing ? {} : { "Afterwrd-Redraw": source };
    res = await fetch(submitter?.getAttribute("formaction") || form.action, { method: "POST", body, headers, redirect: "manual" });
  } catch {
    failed(OFFLINE);
    return;
  }
  // The site answers a form that worked by sending you on (a redirect, which isn't followed here), or with the page.
  if (res.type !== "opaqueredirect" && !res.ok) {
    failed(await refusal(res));
    return;
  }
  const page = res.ok && res.headers.get("Afterwrd-Redrawn") ? await res.text().catch(() => null) : null;
  form.querySelectorAll("textarea[data-draft]").forEach((sent) => window.afterwrdSent(/** @type {HTMLTextAreaElement} */ (sent)));
  let fresh = null;
  if (removing) region.remove();
  else if (!(fresh = await refresh(region, source, here, page))) {
    location.reload();
    return;
  }
  // An edit box opens as the address's #target (#edit-c12). Off the address now it's done with, so Edit there
  // again changes the address, and opens it afresh.
  if (location.hash) history.replaceState(history.state, "", here);
  if (fresh) focusAgain(fresh, form);
  finished(true);
});
