// The only pages served to people who aren't signed in. Styles and script are inline because /static is
// behind the login too.
import { escape } from "./util.js";

const STYLE = `
  :root { --bg: #f6f2eb; --surface: #fcfaf6; --text: #24201b; --muted: #6f675b; --border: #e3dacb; --accent: #a3482a;
          --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #191714; --surface: #221f1b; --text: #ece5d9; --muted: #a69d8f; --border: #38322b; --accent: #e08a62; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg);
         color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border);
         border-radius: 6px; padding: 32px; }
  .brand { font: italic 1.4rem var(--serif); color: var(--text); margin: 0 0 22px; }
  .brand::after { content: "."; color: var(--accent); font-style: normal; }
  h1 { font: 600 1.6rem/1.2 var(--serif); margin: 0 0 10px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: var(--muted); }
  button, .button { display: block; width: 100%; padding: 12px; border: 0; border-radius: 4px; background: var(--text);
           color: var(--bg); font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { background: var(--accent); color: #fff; }
  button:disabled { opacity: 0.6; cursor: default; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #error { color: #b3261e; margin: 12px 0 0; min-height: 1.5em; }
  input { width: 100%; font: inherit; padding: 11px; border: 1px solid var(--border); border-radius: 4px;
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
<p class="brand">afterwrd</p>
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
