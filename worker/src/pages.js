// The only pages served to people who aren't signed in. Styles and script are inline because /static is
// behind the login too.
import { LOGO } from "./nav.js";
import { escape } from "./util.js";

const STYLE = `
  :root { --bg: #f6f4f0; --surface: #fff; --text: #1d2420; --muted: #69736e; --border: #e5e1da; --accent: #0b8a6c;
          --accent-strong: #08745b; --on-accent: #fff;
          --round: ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111513; --surface: #191f1c; --text: #e8eeea; --muted: #9aa69f; --border: #28302c; --accent: #3fcf9f;
            --accent-strong: #66dbb4; --on-accent: #08251c; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg);
         color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 420px; background: var(--surface); border-radius: 22px; padding: 34px;
         box-shadow: 0 1px 2px rgb(20 30 25 / 0.05), 0 12px 40px rgb(20 30 25 / 0.08); }
  .brand { display: flex; align-items: center; gap: 0.5rem; font: 800 1.3rem var(--round); margin: 0 0 24px; letter-spacing: -0.02em; color: var(--text); }
  .mark { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: 9px;
          background: linear-gradient(140deg, var(--accent), var(--accent-strong)); color: var(--on-accent); }
  .mark svg { width: 1rem; height: 1rem; }
  h1 { font: 800 1.7rem/1.2 var(--round); margin: 0 0 10px; letter-spacing: -0.015em; }
  p { margin: 0 0 20px; color: var(--muted); }
  button, .button { display: block; width: 100%; min-height: 3rem; padding: 12px; border: 0; border-radius: 999px; background: var(--accent);
           color: var(--on-accent); font: inherit; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { background: var(--accent-strong); }
  button:disabled { opacity: 0.6; cursor: default; }
  :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 2px; }
  #error { color: #c0392b; margin: 12px 0 0; min-height: 1.5em; }
  input { width: 100%; font: inherit; min-height: 3rem; padding: 11px 16px; border: 1px solid var(--border); border-radius: 999px;
          background: var(--bg); color: var(--text); }
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
<link rel="icon" href="data:,">
<title>${title} · afterwrd</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">${LOGO}</p>
${body}
</main>
${script && `<script>${CLIENT}\n${script}</script>`}
</body>
</html>`;
}

export function loginPage(next) {
  return page("Sign in", `
<h1>Sign in</h1>
<p>This is a private archive. Use the passkey you set up from your invite.</p>
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

export function invitePage(name) {
  return page("You're invited", `
<h1>Hello, ${escape(name)}</h1>
<p>You've been invited to a private archive. Create a passkey on this device to get in: your phone or computer
will ask for your face, fingerprint or PIN. There's no password, and this link only works once.</p>
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
this device, then you can import your Facebook download and invite people.</p>
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
<p>${escape(name)} would like to connect their afterwrd site with yours, so you each see the other's new posts and can
comment on them. Where is your afterwrd site?</p>
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
