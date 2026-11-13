// Notifications on this device (the Events page; src/push.js): turning them on and off, and whether the lock screen
// shows the event or only who it's from. They're only for invitations, and for changes to events the owner hasn't said
// no to. On an iPhone or iPad this needs afterwrd added to the home screen first; Android and computers can do it in
// the browser too.
const box = document.getElementById("notify");
if (box) notifications(box).catch((err) => { document.getElementById("notify-status").textContent = `Couldn't check this device: ${err.message}`; });

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
