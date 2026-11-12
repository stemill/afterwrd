// Three things on every signed-in page (nav.js loads this): two that browsers do plainly, done in afterwrd's look,
// and the home-screen app.
//
//   - Asking first. A form or button with data-confirm="Delete this post?" (and data-confirm-ok="Delete" for the
//     button's word) asks in afterwrd's own box before it's sent, in place of the browser's confirm(). Scripts can ask
//     the same way: `if (!(await askFirst("Leave this group?", { ok: "Leave" }))) return;`
//   - The home-screen app. The service worker (public/static/app/push-sw.js) lets afterwrd be installed as an app, and
//     notify about messages. "Add to home screen" (the menu, /app, and a note on Home until it's installed or "Not
//     now") uses the browser's own Install where it has one (Chrome), and shows how where it hasn't (Safari).
//   - The small V menus (Edit, Delete) on posts, comments and messages: one open at a time, closed by a tap elsewhere,
//     a choice, or Escape. Edit opens the words (the page's #target) with the cursor at the end, ready to change.
//   - The look: the Dark / Light / Auto switch behind your picture, kept in this browser (nav.js LOOK applies it).
//   - What you're writing: comments, posts, messages and edits are kept on the device until they're sent.
//   - In place: comments, edits, deletes, poll and event answers, and notices put away, without a new page.
//   - Drop-downs you can type into. A <select data-search> becomes a box that narrows its list as you type; the
//     select itself stays (hidden) in the form, so what's sent, and any onchange, are as before.
(() => {
  // --- asking first --------------------------------------------------------------------------------------------
  function askFirst(message, { ok = "OK", cancel = "Cancel" } = {}) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "ask";
      dialog.setAttribute("aria-label", "Are you sure?");
      const words = document.createElement("p");
      words.textContent = message;
      const row = document.createElement("div");
      row.className = "ask-buttons";
      const no = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: cancel });
      const yes = Object.assign(document.createElement("button"), { type: "button", className: "chip danger", textContent: ok });
      row.append(no, yes);
      dialog.append(words, row);
      document.body.append(dialog);
      let answered = false;
      const done = (answer) => {
        if (answered) return;
        answered = true;
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      no.addEventListener("click", () => done(false));
      yes.addEventListener("click", () => done(true));
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); done(false); }); // Escape
      dialog.addEventListener("click", (e) => { if (e.target === dialog) done(false); }); // a tap outside the box
      dialog.showModal();
      no.focus(); // the safe choice is the one ready to press
    });
  }
  window.askFirst = askFirst;

  // --- the look --------------------------------------------------------------------------------------------------
  const looks = document.querySelectorAll('input[name="look"]');
  const showChoice = () => looks.forEach((r) => { r.checked = r.value === document.documentElement.dataset.lookChoice; });
  showChoice();
  looks.forEach((r) => r.addEventListener("change", () => {
    try { localStorage.setItem("afterwrd-look", r.value); } catch {}
    dispatchEvent(new Event("afterwrd-look"));
    // If this browser won't keep it (some private windows), show it for this page anyway.
    if (document.documentElement.dataset.lookChoice !== r.value) {
      const light = r.value === "light" || (r.value === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
      document.documentElement.dataset.look = light ? "light" : "dark";
      document.documentElement.dataset.lookChoice = r.value;
    }
  }));
  addEventListener("storage", (e) => { if (e.key === "afterwrd-look") showChoice(); });

  // --- the small V menus ---------------------------------------------------------------------------------------
  const openMenus = () => document.querySelectorAll("details.more[open]");
  document.addEventListener("toggle", (e) => {
    if (!e.target.matches?.("details.more") || !e.target.open) return;
    openMenus().forEach((d) => { if (d !== e.target) d.open = false; });
  }, true);
  document.addEventListener("click", (e) => {
    // After the click has done its work (a Delete's form is on its way to being asked about), so it isn't lost.
    const choice = e.target.closest("details.more .menu a, details.more .menu button");
    setTimeout(() => openMenus().forEach((d) => { if (choice ? d.contains(choice) : !d.contains(e.target)) d.open = false; }));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    openMenus().forEach((d) => { d.open = false; d.querySelector("summary").focus(); });
  });
  /** What the address points at (#c12), if anything; nothing for a mangled address (a stray "%"). */
  const pointedAt = () => {
    try {
      return location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    } catch {
      return null;
    }
  };
  function editing() {
    const box = pointedAt();
    const words = box?.matches("div.edit") ? box.querySelector("textarea") : null;
    if (!words) return;
    words.focus({ preventScroll: true });
    words.setSelectionRange(words.value.length, words.value.length);
  }
  window.addEventListener("hashchange", editing);
  editing();

  // Before any form is sent (in the capture phase, so ahead of the page's own handlers): ask, then send it again,
  // through the same button (which may have its own formaction), if they said yes.
  document.addEventListener("submit", (e) => {
    const form = e.target;
    const by = e.submitter && e.submitter.form === form ? e.submitter : null;
    const message = by?.dataset.confirm || form.dataset.confirm;
    if (!message || form.dataset.asked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    askFirst(message, { ok: by?.dataset.confirmOk || form.dataset.confirmOk || "OK" }).then((yes) => {
      if (!yes) return;
      // On the next turn: a browser ignores sending a form again while it's still handling the first try.
      setTimeout(() => {
        form.dataset.asked = "1";
        try { form.requestSubmit(by ?? undefined); } finally { delete form.dataset.asked; }
      });
    });
  }, true);

  // --- what you're writing --------------------------------------------------------------------------------------
  // A box marked data-draft="<key>" (a comment, a post, a message, an edit) keeps its words in this browser until
  // they're sent, so losing signal, the app being closed, or a tap elsewhere doesn't lose them: they're back in the
  // box next time. Kept for a week at most, and all gone on Sign out (this may be a shared phone or computer).
  // Whatever sends them calls afterwrdSent(box) once the site has them: compose.js, messages.js, and "in place" below.
  const DRAFT = "afterwrd-draft:";
  const WEEK = 7 * 24 * 3600 * 1000;
  const drafts = {
    get(key) { try { return JSON.parse(localStorage.getItem(DRAFT + key) || "null"); } catch { return null; } },
    keep(key, text) { try { localStorage.setItem(DRAFT + key, JSON.stringify({ text, at: Date.now() })); } catch {} },
    drop(key) { try { localStorage.removeItem(DRAFT + key); } catch {} },
    all() { try { return Object.keys(localStorage).filter((k) => k.startsWith(DRAFT)).map((k) => k.slice(DRAFT.length)); } catch { return []; } },
  };
  drafts.all().forEach((key) => { if (!(Date.now() - (drafts.get(key)?.at ?? 0) < WEEK)) drafts.drop(key); });
  const restoreDrafts = (within) => within.querySelectorAll("textarea[data-draft]").forEach((box) => {
    const kept = drafts.get(box.dataset.draft);
    // Only into a box that's as the page made it: never over words the browser itself has put back.
    if (typeof kept?.text === "string" && kept.text !== box.defaultValue && box.value === box.defaultValue) box.value = kept.text;
  });
  restoreDrafts(document);
  document.addEventListener("input", (e) => {
    const box = e.target;
    if (!box.matches?.("textarea[data-draft]")) return;
    if (box.value.trim() && box.value !== box.defaultValue) drafts.keep(box.dataset.draft, box.value);
    else drafts.drop(box.dataset.draft);
  });
  window.afterwrdSent = (box) => { if (box?.dataset.draft) drafts.drop(box.dataset.draft); };
  document.addEventListener("submit", (e) => {
    if (new URL(e.target.action, location.href).pathname === "/_auth/logout") drafts.all().forEach(drafts.drop);
  });

  // --- in place ----------------------------------------------------------------------------------------------------
  // The things you do while reading (a comment, changing or deleting one, answering a poll or an event, editing or
  // deleting a post, putting a notice away) happen where you are: no new page, so nothing jumps, and Home doesn't ask
  // every friend's site again because you commented. A form marked data-inplace is sent from here; when the site has
  // it, the part of the page it's in (the nearest data-region: a post, a photo's comments) is swapped for a fresh copy
  // of that part, drawn by the site as always, from this page; on Home, which asks every friend's site, from the page
  // named in data-region instead (the post's own page, or a friend's posts). data-inplace="remove" takes that part away
  // (a deleted post, a notice put away), unless it's the post this page is about: then the site's answer is followed.
  // Without scripts, the forms send themselves and the page reloads, as before.
  // The same words as the composer's (upload.js OFFLINE); messages.js says it its own way, as its words stay in the box.
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
  /** `region` swapped for a fresh copy from `source`; the copy, or null if it couldn't be had. */
  async function refresh(region, source, here) {
    try {
      const res = await fetch(source, { cache: "no-store" });
      if (!res.ok) return null;
      const fresh = new DOMParser().parseFromString(await res.text(), "text/html").getElementById(region.id);
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
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (e.defaultPrevented || !form.matches("form[data-inplace]")) return;
    const region = form.closest("[data-region]");
    const removing = form.dataset.inplace === "remove";
    const nothingToRedraw = !removing && !region?.id;
    const thisPagesPost = removing && region?.dataset.region === location.pathname; // deleted: the site says where next
    if (!region || nothingToRedraw || thisPagesPost) return; // sent the ordinary way
    e.preventDefault();
    // One thing at a time in each part: each send redraws it, so a second would land on a copy that's gone.
    if (region.dataset.sending) return;
    const here = location.pathname + location.search;
    const source = (location.pathname === "/" && region.dataset.region) || here;
    const body = new FormData(form);
    if (e.submitter?.name) body.append(e.submitter.name, e.submitter.value); // a poll's choice is the button pressed
    // Meanwhile the part waits: its buttons off, and its boxes not taking words that the redraw would lose.
    region.dataset.sending = "1";
    const held = [...region.querySelectorAll("button, textarea")].filter((el) => !el.disabled && !el.readOnly);
    const hold = (on) => held.forEach((el) => { if (el.matches("textarea")) el.readOnly = on; else el.disabled = on; });
    hold(true);
    sayUnder(form, "");
    const failed = (words) => {
      delete region.dataset.sending;
      hold(false);
      sayUnder(form, words); // and any words stay in their box, kept on this device
      finished(false);
    };
    let res;
    try {
      res = await fetch(e.submitter?.getAttribute("formaction") || form.action, { method: "POST", body, redirect: "manual" });
    } catch {
      failed(OFFLINE);
      return;
    }
    // The site answers a form that worked by sending you on (a redirect, which isn't followed here).
    if (res.type !== "opaqueredirect" && !res.ok) {
      failed(await refusal(res));
      return;
    }
    form.querySelectorAll("textarea[data-draft]").forEach((box) => window.afterwrdSent(box));
    let fresh = null;
    if (removing) region.remove();
    else if (!(fresh = await refresh(region, source, here))) {
      location.reload();
      return;
    }
    // An edit box opens as the address's #target (#edit-c12). Off the address now it's done with, so Edit there
    // again changes the address, and opens it afresh.
    if (location.hash) history.replaceState(history.state, "", here);
    if (fresh) focusAgain(fresh, form);
    finished(true);
  });

  // --- arriving at something -------------------------------------------------------------------------------------
  // A page opened at something (#c12, from Notifications say) shows it just below the site's header, however tall
  // the header is on this screen (two rows on a phone), and keeps it there while pictures load, until you scroll.
  const header = document.querySelector("header.site");
  const fitHeader = () => { if (header) document.documentElement.style.scrollPaddingTop = `${header.offsetHeight + 12}px`; };
  fitHeader();
  addEventListener("resize", fitHeader);
  const target = pointedAt();
  if (target && !target.matches("div.edit") && performance.getEntriesByType?.("navigation")[0]?.type === "navigate") {
    let touched = false; // once you scroll yourself, the page is yours
    ["wheel", "touchstart", "keydown", "mousedown"].forEach((type) => addEventListener(type, () => { touched = true; }, { once: true, passive: true }));
    const put = () => { if (!touched) target.scrollIntoView({ block: "start" }); };
    // Once every script has had its say (the Add to home screen note can appear above), and again when pictures
    // have loaded.
    document.addEventListener("DOMContentLoaded", put, { once: true });
    addEventListener("load", put, { once: true });
  }

  // --- drop-downs you can type into ------------------------------------------------------------------------------
  let made = 0;
  function searchable(select) {
    const id = `picker-${++made}`;
    const box = Object.assign(document.createElement("span"), { className: "picker" });
    const input = Object.assign(document.createElement("input"), {
      type: "text", className: "picker-input", autocomplete: "off", spellcheck: false,
      placeholder: select.dataset.search || "Type to search",
    });
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-label", select.getAttribute("aria-label") || select.closest("label")?.textContent.trim() || "Choose");
    const list = Object.assign(document.createElement("ul"), { id, className: "picker-list", hidden: true });
    list.setAttribute("role", "listbox");
    box.append(input, list);
    select.hidden = true;
    select.after(box);

    const options = [...select.options].filter((o) => !o.disabled);
    const label = () => select.selectedOptions[0]?.textContent.trim() ?? "";
    input.value = label();
    let shown = [];
    let active = -1;

    function show(filter) {
      const words = filter.trim().toLowerCase();
      shown = options.filter((o) => !words || o.textContent.toLowerCase().includes(words));
      list.replaceChildren(...shown.map((o, i) => {
        const li = Object.assign(document.createElement("li"), { id: `${id}-${i}`, textContent: o.textContent.trim() });
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(o.selected));
        li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(o); }); // before the box loses focus
        return li;
      }));
      if (!shown.length) list.append(Object.assign(document.createElement("li"), { className: "picker-none", textContent: "Nothing matches" }));
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      move(shown.length ? Math.max(0, shown.findIndex((o) => o.selected)) : -1);
    }
    function hide() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function move(to) {
      active = to;
      [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
      const li = list.children[active];
      if (li && li.id) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    }
    function pick(option) {
      const changed = select.value !== option.value;
      select.value = option.value;
      input.value = label();
      hide();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    input.addEventListener("focus", () => { input.select(); show(""); });
    // Clicked again after choosing (still focused, so no focus event): open afresh, ready to type over.
    input.addEventListener("click", () => { if (list.hidden) { input.select(); show(""); } });
    input.addEventListener("input", () => show(input.value));
    input.addEventListener("blur", () => { hide(); input.value = label(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) show("");
        else if (shown.length) move((active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
      } else if (e.key === "Enter") {
        e.preventDefault(); // choosing, not sending the form
        if (!list.hidden && shown[active]) pick(shown[active]);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault();
        hide();
        input.value = label();
      }
    });
  }
  document.querySelectorAll("select[data-search]").forEach(searchable);

  // --- the home-screen app ---------------------------------------------------------------------------------------
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/app/push-sw.js", { scope: "/" }).catch(() => {});
  const note = document.getElementById("install-note");
  let offer = null; // the browser's own Install, where it has one
  const showOffers = () => {
    document.querySelectorAll("[data-install]").forEach((b) => { b.hidden = !offer; });
    document.querySelectorAll("[data-install-how]").forEach((a) => { a.hidden = Boolean(offer); });
  };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // offered here, quietly, instead of the browser's own banner
    offer = e;
    showOffers();
  });
  window.addEventListener("appinstalled", () => { offer = null; note?.remove(); showOffers(); });
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-install]") && offer) {
      const asked = offer;
      offer = null;
      await asked.prompt();
      if ((await asked.userChoice).outcome === "accepted") note?.remove();
      showOffers();
    }
    if (e.target.closest("[data-install-later]")) {
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
  const cards = document.querySelectorAll("[data-device]");
  if (cards.length) {
    const ua = navigator.userAgent;
    const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const notSafari = !/Safari\//.test(ua) || /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\//.test(ua);
    const device = apple ? (notSafari ? "iphone-elsewhere" : "iphone") : /Android/.test(ua) ? "android" : "computer";
    const mine = device === "iphone-elsewhere" ? ["iphone-elsewhere", "iphone"] : [device];
    cards.forEach((c) => { c.hidden = !mine.includes(c.dataset.device); });
    const others = document.querySelector("[data-device-others]");
    if (others) others.hidden = false;
    document.addEventListener("click", async (e) => {
      if (e.target.closest("[data-show-devices]")) {
        cards.forEach((c) => { if (c.dataset.device !== "iphone-elsewhere") c.hidden = false; });
        if (others) others.hidden = true;
      }
      const copy = e.target.closest("[data-copy-address]");
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
})();
