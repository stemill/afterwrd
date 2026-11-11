// Messages (src/messages.js, src/views/messages.js). Times are shown in this device's own time. In an
// open chat: Send without leaving the page, Try again and Delete in place, and every few seconds while the chat is in
// view, anything new is added at the bottom, and "Sending…" turns to "Delivered" (or "Not delivered") when it does.
// Nothing pops up and nothing makes a sound; nothing runs while the chat is hidden.
const EVERY = 3000;
const PROBLEMS = { // as in src/views/messages.js
  unreachable: "their site couldn't be reached",
  "no-messages": "their site doesn't take messages yet",
  "not-friends": "you're not friends on their site any more",
  refused: "their site wouldn't take it",
};
const GROUP_PROBLEMS = { // the same, in a group chat
  unreachable: "the group's site couldn't be reached",
  "no-messages": "the group's site doesn't have a chat yet (its owner can update it)",
  "not-friends": "you're not in the group any more",
  refused: "the group wouldn't take it",
};
const STATES = { sending: "Sending…", delivered: "Delivered" };
const stateWords = (m, kind) => (m.state === "failed"
  ? `Not delivered: ${(kind === "group" ? GROUP_PROBLEMS : PROBLEMS)[m.problem] ?? "it didn't go"}` : STATES[m.state] ?? "");

function showTime(el) {
  const when = new Date(el.dateTime);
  if (Number.isNaN(when.getTime())) return;
  const today = when.toDateString() === new Date().toDateString();
  el.textContent = today ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
document.querySelectorAll(".chats time, #chat time").forEach(showTime);

const list = document.getElementById("chat");
if (list) openChat(list);

function openChat(list) {
  const chat = list.dataset.chat;
  const kind = list.dataset.kind;
  const paged = list.hasAttribute("data-paged");
  const form = document.getElementById("say");
  const error = document.getElementById("say-error");
  let after = Number(list.dataset.after) || 0;

  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });

  function action(m, what, label, confirm, everywhere = false) {
    const f = document.createElement("form");
    f.method = "post";
    f.action = `/_messages/${chat}/${m.id}/${what}`;
    if (confirm) Object.assign(f.dataset, { confirm, confirmOk: "Delete" });
    if (everywhere) f.append(Object.assign(document.createElement("input"), { type: "hidden", name: "everywhere", value: "1" }));
    f.append(Object.assign(document.createElement("button"), { className: "link", textContent: label }));
    return f;
  }

  // The same as bubble() in src/views/messages.js.
  function bubble(m) {
    const li = document.createElement("li");
    li.className = `msg ${m.mine ? "mine" : "theirs"}`;
    Object.assign(li.dataset, { id: m.id, state: m.state ?? "" });
    const said = Object.assign(document.createElement("p"), { className: "said", textContent: m.text });
    if (m.author) {
      const who = Object.assign(document.createElement("p"), { className: "sender", textContent: m.author });
      if (m.authorSite) who.append(" ", Object.assign(document.createElement("span"), { className: "site", textContent: m.authorSite }));
      li.append(who);
    }
    const under = Object.assign(document.createElement("div"), { className: "under" });
    const time = document.createElement("time");
    time.dateTime = new Date(m.sent_at * 1000).toISOString();
    showTime(time);
    under.append(time);
    if (m.mine) under.append(Object.assign(document.createElement("span"), { className: "state", textContent: stateWords(m, kind) }));
    if (m.state === "failed") under.append(action(m, "retry", "Try again"));
    under.append(action(m, "delete", "Delete", "Delete this message? It's only deleted here."));
    if (m.everywhere) under.append(action(m, "delete", "Delete for everyone", "Delete this message for everyone in the group?", true));
    li.append(said, under);
    return li;
  }

  const find = (id) => list.querySelector(`li[data-id="${Number(id)}"]`);
  function show(m) {
    const there = find(m.id);
    if (there) { there.replaceWith(bubble(m)); return; }
    const follow = nearBottom() || m.mine;
    list.append(bubble(m));
    after = Math.max(after, m.id);
    if (follow) toBottom();
  }

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
    return data;
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = form.elements.text.value.trim();
      if (!text) return;
      const button = form.querySelector("button");
      button.disabled = true;
      error.textContent = "";
      try {
        const { message } = await post(form.action, { text });
        form.elements.text.value = "";
        show(message);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        button.disabled = false;
        form.elements.text.focus();
      }
    });
    // With a keyboard, Enter sends (Shift+Enter for a new line). On a phone, Enter is a new line and Send sends.
    form.elements.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  // Mute, and a group chat's Notify me, in place: the buttons are at the top, so a reload (which goes to the newest
  // message) would hide the change.
  const mute = document.querySelector('form[action$="/mute"]');
  mute?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await post(mute.action, { muted: mute.elements.muted.value === "1" });
      mute.elements.muted.value = result.muted ? "0" : "1";
      mute.querySelector("button").textContent = result.muted ? "Unmute" : "Mute";
      document.getElementById("muted-note").hidden = !result.muted;
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });
  const notify = document.querySelector('form[action$="/notify"]');
  notify?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await post(notify.action, { notify: notify.elements.notify.value === "1" });
      notify.elements.notify.value = result.notify ? "0" : "1";
      notify.querySelector("button").textContent = result.notify ? "Stop notifications" : "Notify me";
      document.getElementById("notify-words").textContent = result.notify ? "This chat notifies you." : "This chat doesn't notify you.";
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });

  // Try again and Delete (after ui.js has asked), in place.
  list.addEventListener("submit", async (e) => {
    const f = e.target;
    const what = /\/(\d+)\/(retry|delete)$/.exec(new URL(f.action).pathname);
    if (!what) return;
    e.preventDefault();
    try {
      const result = await post(f.action, Object.fromEntries(new FormData(f)));
      if (what[2] === "delete") find(what[1])?.remove();
      else show(result.message);
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });

  async function check() {
    if (document.hidden) return;
    const pending = [...list.querySelectorAll('li.mine[data-state="sending"]')].map((li) => li.dataset.id);
    try {
      const res = await fetch(`/_messages/${chat}/since?after=${after}&pending=${pending.join(",")}`, { cache: "no-store" });
      if (!res.ok) return;
      const news = await res.json();
      for (const m of news.states) show(m);
      for (const m of news.messages) show(m);
    } catch {} // offline for a moment: next time
  }

  if (!paged) {
    toBottom();
    check(); // straight away: it's how the site knows this chat is open on screen, and doesn't notify about it
    setInterval(check, EVERY);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  }
}

// Notifications on this device (Messages; src/push.js). On an iPhone or iPad this needs afterwrd added to the home
// screen first; Android and computers can do it in the browser too.
const notify = document.getElementById("notify");
if (notify) notifications(notify).catch((err) => { document.getElementById("notify-status").textContent = `Couldn't check this device: ${err.message}`; });

async function notifications(box) {
  const status = document.getElementById("notify-status");
  const problem = document.getElementById("notify-error");
  const on = box.querySelector('[data-do="on"]');
  const off = box.querySelector('[data-do="off"]');
  const previewBox = document.getElementById("notify-preview");
  const preview = previewBox.querySelector("input");
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const apple = /iPhone|iPad/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const say = (text) => { status.textContent = text; };

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    if (apple && !installed) {
      status.textContent = "On an iPhone or iPad, add afterwrd to your home screen first, then open it from there and come back here. ";
      status.append(Object.assign(document.createElement("a"), { href: "/app", textContent: "Show me how" }));
    } else {
      say("This browser can't show notifications.");
    }
    return;
  }

  await navigator.serviceWorker.register("/static/app/push-sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
    return data;
  }
  async function show() {
    const subscription = await registration.pushManager.getSubscription();
    // The site may have forgotten this device (its notifications stopped reaching it): then it's off, and can be asked again.
    const state = subscription ? await post("/_push/devices/state", { endpoint: subscription.endpoint }) : { on: false };
    const blocked = Notification.permission === "denied";
    say(state.on ? "Notifications are on for this device."
      : blocked ? "Notifications are blocked for afterwrd in this device's settings. Allow them there, then come back."
      : "Notifications are off for this device.");
    on.hidden = state.on || blocked;
    off.hidden = !state.on;
    previewBox.hidden = !state.on;
    preview.checked = state.preview !== false;
    document.getElementById("notify-android").hidden = !(state.on && /Android/.test(navigator.userAgent));
  }
  const keyBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const deviceName = () => {
    const ua = navigator.userAgent;
    const kind = /iPhone/.test(ua) ? "iPhone" : apple ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac"
      : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "A device";
    return `${kind}${installed ? " (home screen)" : " (browser)"}`;
  };

  // Straight from the tap: some phones only ask for permission in answer to one.
  on.addEventListener("click", async () => {
    problem.textContent = "";
    try {
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !(await post("/_push/devices/state", { endpoint: subscription.endpoint })).on) {
        await subscription.unsubscribe(); // made for a key this site no longer has, or forgotten: start again
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(box.dataset.key) });
      await post("/_push/devices", { ...subscription.toJSON(), name: deviceName(), preview: true });
    } catch (err) {
      if (Notification.permission !== "denied") problem.textContent = err.message;
    }
    await show();
  });
  off.addEventListener("click", async () => {
    problem.textContent = "";
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await post("/_push/devices/forget", { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    await show();
  });
  preview.addEventListener("change", async () => {
    problem.textContent = "";
    const subscription = await registration.pushManager.getSubscription();
    try {
      await post("/_push/devices/preview", { endpoint: subscription?.endpoint, preview: preview.checked });
    } catch (err) {
      problem.textContent = err.message;
      await show();
    }
  });
  await show();
}
