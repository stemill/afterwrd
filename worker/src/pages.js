// The only pages served to people who aren't signed in. Styles and script are inline because /static is
// behind the login too (apart from the fonts, which are public: see index.js).
import { FAVICON, LOGO } from "./nav.js";
import { escape } from "./util.js";

const STYLE = `
  @font-face { font-family: "Nunito"; src: url("/static/fonts/nunito.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  @font-face { font-family: "Nunito Sans"; src: url("/static/fonts/nunito-sans.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  :root { --bg: #16201b; --surface: #1f2b25; --sunken: #121a16; --text: #ede6da; --muted: #a9a092; --border: #2e3d35;
          --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; --button: #ede6da; --on-button: #16201b; color-scheme: dark;
          --round: "Nunito", ui-rounded, system-ui, sans-serif; }
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
  button:hover, .button:hover { background: #ffffff; }
  button:disabled { opacity: 0.6; cursor: default; }
  :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; }
  #error { color: #ff8070; margin: 12px 0 0; min-height: 1.5em; }
  input { width: 100%; font: inherit; min-height: 3rem; padding: 11px 18px; border: 1px solid var(--border); border-radius: 999px;
          background: var(--sunken); color: var(--text); }
`;

// Turns WebAuthn's binary fields into base64url JSON and back; @simplewebauthn/server expects this shape.
const CLIENT = `
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
export function invitePage(name) {
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
    location.replace("/");
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
  return page("afterwrd", `<p>${escape(message)}</p><a class="button" href="${link.href}">${escape(link.label)}</a>`);
}

// Opened from a Connect link (connect.js). Sends the friend on to their own site to confirm, carrying the link.
export function connectLinkPage(name) {
  return page("Connect", `
<h1>Connect with ${escape(name)}</h1>
<p>${escape(name)} would like to connect their afterwrd site with yours, so you're friends: you each see the other's
posts and photos on your own site, and can comment on them. Where is your afterwrd site?</p>
<form id="site">
  <input name="site" placeholder="e.g. jo.example.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">
  <p id="error" role="alert"></p>
  <button>Continue on my site</button>
</form>
<p style="margin-top: 20px">No afterwrd site yet? <a href="https://afterwrd.app/">Set one up</a>, then open this link again.</p>`, `
  document.getElementById("site").addEventListener("submit", (e) => {
    e.preventDefault();
    let site = e.target.site.value.trim();
    if (!/^https?:\\/\\//.test(site)) site = "https://" + site;
    try {
      const origin = new URL(site).origin;
      location.assign(origin + "/_admin/connections/new?link=" + encodeURIComponent(location.href));
    } catch {
      document.getElementById("error").textContent = "That doesn't look like a web address.";
    }
  });`);
}
