// The only pages served to people who aren't signed in. Styles and script are inline because /static is
// behind the login too (apart from the fonts, which are public: see index.js).
import { FAVICON, LOGO } from "./nav.js";
import { escape } from "../util.js";
import { resultHtml } from "./checks.js";

const STYLE = `
  @font-face { font-family: "Nunito"; src: url("/static/fonts/nunito.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  @font-face { font-family: "Nunito Sans"; src: url("/static/fonts/nunito-sans.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  :root { --bg: #16201b; --surface: #1f2b25; --sunken: #121a16; --text: #ede6da; --muted: #a9a092; --border: #2e3d35;
          --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; --button: #ede6da; --button-hover: #ffffff;
          --on-button: #16201b; --moss: #a8d49a; --danger: #ff8070; color-scheme: dark;
          --round: "Nunito", ui-rounded, system-ui, sans-serif; }
  /* The light look, as in style.css (nav.js LOOK picks it). */
  :root[data-look="light"] { --bg: #f6f1e8; --surface: #fffdf8; --sunken: #f1ebe0; --text: #1f2a24; --muted: #6b6458; --border: #e0d6c6;
          --accent-strong: #a8480c; --button: #24332b; --button-hover: #16201b; --on-button: #fffdf8; --moss: #3f7334; --danger: #b3352b;
          color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg);
         color: var(--text); font: 16px/1.55 "Nunito Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 420px; background: var(--surface); border-radius: 26px; padding: 34px; }
  .brand { display: flex; align-items: center; font: 900 1.8rem/1 var(--round); margin: 0 0 26px; letter-spacing: -0.02em; color: var(--text); }
  .wordmark { display: inline-flex; align-items: center; }
  .wordmark .o { width: 0.82em; height: 0.82em; margin: 0.08em 0.01em 0; color: var(--accent); }
  h1 { font: 900 1.75rem/1.2 var(--round); margin: 0 0 10px; letter-spacing: -0.015em; }
  p { margin: 0 0 20px; color: var(--muted); }
  a { color: var(--accent-strong); }
  button, .button { display: block; width: 100%; min-height: 3rem; padding: 12px; border: 0; border-radius: 999px; background: var(--button);
           color: var(--on-button); font: 900 1rem var(--round); text-align: center; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { background: var(--button-hover); }
  button:disabled { opacity: 0.6; cursor: default; }
  :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; }
  #error { color: var(--danger); margin: 12px 0 0; min-height: 1.5em; }
  input { width: 100%; font: inherit; min-height: 3rem; padding: 11px 18px; border: 1px solid var(--border); border-radius: 999px;
          background: var(--sunken); color: var(--text); }
`;

// Turns WebAuthn's binary fields into base64url JSON and back; @simplewebauthn/server expects this shape.
// Also: a friend link brought here by the installer (after the #, so no server sees it) waits in this tab while the
// owner makes their passkey, then opens "Add … as a friend?" (INVITE_RE: a friend link's shape).
const CLIENT = `
  const INVITE_RE = /^(https:\\/\\/[a-z0-9-]+\\.[a-z0-9-]+\\.workers\\.dev|http:\\/\\/localhost:\\d+)\\/_connect\\/[\\w-]{40,100}$/;
  const keepInvite = () => {
    const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
    try { if (invite && INVITE_RE.test(invite)) sessionStorage.setItem("afterwrd-invite", invite); } catch {}
  };
  const afterPasskey = () => {
    let invite = null;
    try { invite = sessionStorage.getItem("afterwrd-invite"); sessionStorage.removeItem("afterwrd-invite"); } catch {}
    location.replace(invite && INVITE_RE.test(invite) ? "/_admin/connections/new?link=" + encodeURIComponent(invite) : "/");
  };
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const ids = (list) => (list || []).map((c) => ({ ...c, id: dec(c.id) }));

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function credentialJSON(c) {
    const r = c.response;
    const response = { clientDataJSON: enc(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = enc(r.attestationObject);
      response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      response.authenticatorData = enc(r.authenticatorData);
      response.signature = enc(r.signature);
      if (r.userHandle) response.userHandle = enc(r.userHandle);
    }
    return { id: c.id, rawId: enc(c.rawId), type: c.type, response,
             clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment };
  }

  function run(button, action) {
    const error = document.getElementById("error");
    if (!window.PublicKeyCredential) {
      error.textContent = "This browser doesn't support passkeys. Try an up-to-date Safari, Chrome, Edge or Firefox.";
      button.disabled = true;
      return;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try { await action(); }
      catch (e) {
        error.textContent = e.name === "NotAllowedError" ? "Cancelled, or no passkey was chosen. Try again." : e.message;
        button.disabled = false;
      }
    });
  }
`;

function page(title, body, script = "") {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${FAVICON}
<title>${title} · afterwrd</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand" aria-label="afterwrd">${LOGO}</p>
${body}
</main>
${script && `<script>${CLIENT}\n${script}</script>`}
</body>
</html>`;
}

export function loginPage(next) {
  return page("Sign in", `
<h1>Sign in</h1>
<p>This is a private afterwrd site. Sign in with your passkey.</p>
<button id="go">Sign in with a passkey</button>
<p id="error" role="alert"></p>`, `
  // Words kept on this device while they were being written (ui.js) go once it's signed out, however that happened:
  // Sign out here, from another device, or the session running out. This may be a shared phone or computer.
  try { Object.keys(localStorage).filter((k) => k.startsWith("afterwrd-draft:")).forEach((k) => localStorage.removeItem(k)); } catch {}
  const next = ${JSON.stringify(next).replace(/</g, "\\u003c")};
  run(document.getElementById("go"), async () => {
    const options = await post("/_auth/login/options");
    const credential = await navigator.credentials.get({ publicKey: {
      ...options, challenge: dec(options.challenge), allowCredentials: ids(options.allowCredentials) } });
    await post("/_auth/login/verify", { response: credentialJSON(credential) });
    location.replace(next);
  });`);
}

// A link to add one of the owner's devices (from Your devices, or setting up a new site).
export function deviceLinkPage(name) {
  return page("Add this device", `
<h1>Hello, ${escape(name)}</h1>
<p>Add this phone or computer to your afterwrd site by creating a passkey on it: it will ask for your face,
fingerprint or PIN. There's no password, and this link only works once.</p>
<button id="go">Create a passkey</button>
<p id="error" role="alert"></p>`, `
  const token = location.pathname.split("/").pop();
  run(document.getElementById("go"), async () => {
    const options = await post("/_auth/register/options", { token });
    const credential = await navigator.credentials.create({ publicKey: {
      ...options, challenge: dec(options.challenge), user: { ...options.user, id: dec(options.user.id) },
      excludeCredentials: ids(options.excludeCredentials) } });
    await post("/_auth/register/verify", { token, response: credentialJSON(credential) });
    afterPasskey();
  });`);
}

export function setupPage() {
  return page("Set up afterwrd", `
<h1>Your archive is ready</h1>
<p>afterwrd is installed in your Cloudflare account. Next, make yourself its owner: you'll create a passkey on
this device, then you can import your Facebook download and invite friends.</p>
<p><input id="name" placeholder="Your name" autocomplete="name" maxlength="100"></p>
<button id="go">Continue</button>
<p id="error" role="alert"></p>`, `
  const code = new URLSearchParams(location.search).get("code");
  keepInvite();
  // The name they gave the installer, brought after the # (so no server saw it on the way): ready to use or correct.
  const given = (new URLSearchParams(location.hash.slice(1)).get("name") ?? "").trim().slice(0, 100);
  if (given) document.getElementById("name").value = given;
  // Off the address bar and out of history, so an abandoned setup doesn't leave the code lying around.
  history.replaceState(null, "", "/_auth/setup");
  run(document.getElementById("go"), async () => {
    const name = document.getElementById("name").value.trim();
    if (!name) throw new Error("Give your name.");
    const { link } = await post("/_auth/setup", { code, name });
    location.replace(link);
  });`);
}

export function signOutPage() {
  return page("Sign out", `
<h1>Sign out?</h1>
<p>You'll need your passkey to sign in again.</p>
<form method="post" action="/_auth/logout"><button>Sign out</button></form>`);
}

export function messagePage(message, link = { href: "/_auth/login", label: "Go to sign in" }) {
  return page("afterwrd", `<p>${escape(message)}</p><a class="button" href="${escape(link.href)}">${escape(link.label)}</a>`);
}

// Opened from a check link (checks.js): a friend's site asking to check this person's site, read-only, through
// Cloudflare. `result` is what a finished check found, and `by` the site that checked.
export function checkLinkPage({ owner, checker, site, fixed, result, by = null, reading = false }) {
  const style = `<style>
  .check-good { color: var(--moss); } .check-bad { color: var(--danger); }
  .check-good, .check-bad { margin: 0 0 14px; } .check-good b, .check-bad b { color: var(--text); }
  .check-files { margin: -6px 0 16px; padding-left: 1.2rem; color: var(--muted); font-size: 0.9rem; word-break: break-word; }
  .meta { font-size: 0.9rem; } main { max-width: 520px; }
  .check-who { color: var(--text); padding: 12px 16px; border-radius: 16px; background: var(--sunken); word-break: break-word; }
</style>`;
  if (result && !reading) return page("Site check", `${style}<h1>${escape(owner)}'s site checked yours</h1>\n${resultHtml(result, "yours", by)}`);
  return page("Check my site", `${style}
${reading ? `<p class="check-bad">This check didn't finish. Start it again:</p>` : ""}
<h1>${escape(owner)} would like to check your site</h1>
<p>${escape(owner)}'s afterwrd site (<b>${escape(checker)}</b>, the site this page is on) will look at your Cloudflare
account, read-only, for a moment. It downloads the code
your afterwrd site is running and compares it with the published release, and reads your account's log of changes
for anything afterwrd doesn't do. Cloudflare asks you to allow this. It can't change anything, and the access isn't kept.</p>
<form id="check">
  ${fixed ? `<p>Your site: <b>${escape(new URL(site).host)}</b></p>`
    : `<input name="site" value="${escape(site ? new URL(site).host : "")}" placeholder="e.g. jo.example.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">`}
  <p id="error" role="alert"></p>
  <button>Check my site</button>
</form>
<p class="meta" style="margin-top: 20px">Best done before you start using a new site, and again after updates.
<a href="https://afterwrd.app/check/">More about checking</a>.</p>`, `
  document.getElementById("check").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    button.disabled = true;
    document.getElementById("error").textContent = "";
    try {
      const { relay } = await post(location.pathname + "/start", { site: e.target.site?.value.trim() });
      location.assign(relay);
    } catch (err) {
      document.getElementById("error").textContent = err.message;
      button.disabled = false;
    }
  });`);
}

// Opened from a friend link (connect.js): someone wants to be friends. With a site already, they say where it is and
// confirm there. Without one, "Set up your own afterwrd" takes them to the installer carrying this link after the #
// (so neither the installer's server nor any other sees it); their new site then opens "Add … as a friend?" as soon
// as they've made their passkey. `installer`: install.afterwrd.app, or a stand-in when testing.
export function connectLinkPage(name, { invitedAs = null, installer = "https://install.afterwrd.app/" } = {}) {
  return page("Be friends", `
<style>main { max-width: 480px; } h2 { font: 900 1.15rem/1.3 var(--round); margin: 26px 0 6px; color: var(--text); }
  .meta { font-size: 0.9rem; } .secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }</style>
<h1>${escape(name)} would like to be friends</h1>
<p>${escape(name)} is on afterwrd: a small, private social network where everyone has their own site, free, in their
own Cloudflare account. Friends see each other's posts and photos, and nobody else does.</p>
<h2>New to afterwrd?</h2>
<p>Set up your own site: it takes a few minutes, on a phone or a computer. Once it's ready, you'll be friends with
${escape(name)} in one step.</p>
<a class="button" id="install" href="${escape(installer)}" data-name="${escape(invitedAs ?? "")}">Set up your own afterwrd</a>
<h2>Already have an afterwrd site?</h2>
<p>Copy this link, then open your own afterwrd site and paste it into <b>Add a friend</b>.</p>
<button id="copy-link">Copy this link</button>
<details class="meta" style="margin-top: 16px"><summary>Or type your site's address</summary>
<form id="site">
  <input name="site" placeholder="e.g. afterwrd.your-name.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">
  <p id="error" role="alert"></p>
  <button class="secondary">Continue on my site</button>
</form>
</details>
<p class="meta" style="margin-top: 16px">Opened this inside an app, like WhatsApp or Instagram? Open it in your
browser instead (usually in the app's ⋯ menu): passkeys often don't work inside apps.</p>`, `
  // The installer gets this link (and the name it was made for, to suggest an address) after the #.
  const install = document.getElementById("install");
  const carry = new URLSearchParams({ invite: location.origin + location.pathname });
  if (install.dataset.name) carry.set("name", install.dataset.name);
  install.href += "#" + carry.toString();
  document.getElementById("copy-link").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      e.target.textContent = "Copied: now paste it into Add a friend on your site";
    } catch {
      e.target.textContent = "Copy this page's address from the address bar instead";
    }
  });
  document.getElementById("site").addEventListener("submit", (e) => {
    e.preventDefault();
    let site = e.target.site.value.trim();
    if (!/^https?:\\/\\//.test(site)) site = "https://" + site;
    try {
      const origin = new URL(site).origin;
      location.assign(origin + "/_admin/connections/new?link=" + encodeURIComponent(location.origin + location.pathname));
    } catch {
      document.getElementById("error").textContent = "That doesn't look like a web address.";
    }
  });`);
}

// Opened from a group's invite link (groups.js). Sends them on to their own site to confirm, carrying the link.
export function groupLinkPage(group, owner) {
  return page("Join a group", `
<h1>Join ${escape(group)}</h1>
<p>${escape(owner)} has invited you to ${escape(group)}, a group on afterwrd. Its members read it from their own
afterwrd sites, and can post and comment there.</p>
<p>Copy this link, then open your own afterwrd site and paste it into <b>Groups</b>.</p>
<button id="copy-link">Copy this link</button>
<details class="meta" style="margin-top: 16px"><summary>Or type your site's address</summary>
<form id="site">
  <input name="site" placeholder="e.g. afterwrd.your-name.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">
  <p id="error" role="alert"></p>
  <button>Continue on my site</button>
</form>
</details>
<p style="margin-top: 20px">No afterwrd site yet? <a href="https://afterwrd.app/">Set one up</a>, then paste this link into
<b>Groups</b> on it.</p>`, `
  document.getElementById("copy-link").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(location.href);
      e.target.textContent = "Copied: now paste it into Groups on your site";
    } catch {
      e.target.textContent = "Copy this page's address from the address bar instead";
    }
  });
  document.getElementById("site").addEventListener("submit", (e) => {
    e.preventDefault();
    let site = e.target.site.value.trim();
    if (!/^https?:\\/\\//.test(site)) site = "https://" + site;
    try {
      const origin = new URL(site).origin;
      location.assign(origin + "/groups/join?link=" + encodeURIComponent(location.href));
    } catch {
      document.getElementById("error").textContent = "That doesn't look like a web address.";
    }
  });`);
}
