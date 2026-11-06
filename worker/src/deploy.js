// Installing or updating afterwrd in someone's own Cloudflare account, through Cloudflare's API with a token they
// give us. Used by the site's Update page (src/update.js) and by the installer (installer/installer.js, which
// the release script bundles this file into). Nothing here stores the token.
//
// A release is a folder of files published at `base` (a GitHub release): manifest.json lists every code module
// and site file with its SHA-256, and each file is published under its hash. Every file is checked against
// its hash before it's used, so a release can't be swapped piecemeal; the manifest itself is checked against a
// pinned hash when the caller has one (the installer does).

export const API = "https://api.cloudflare.com/client/v4";

export async function api(token, path, init = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Cloudflare said: ${message}`), { status: response.status });
  }
  return data.result;
}

/** A Worker's settings, or null only when Cloudflare says there's no such Worker (any other failure is thrown). */
export async function workerSettings(token, account, script) {
  try {
    return await api(token, `/accounts/${account}/workers/scripts/${script}/settings`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/** The accounts a token can see; the installer warns before remembering a token that spans more than one. */
export const accountIds = async (token) => (await api(token, "/accounts")).map((a) => a.id);

/** The account (of those the token can see) that has a Worker called `script`, and that Worker's settings. */
export async function findWorker(token, script) {
  for (const account of await api(token, "/accounts")) {
    const response = await fetch(`${API}/accounts/${account.id}/workers/scripts/${script}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return { account: account.id, settings: (await response.json()).result };
  }
  throw new Error(`Couldn't find a Worker called "${script}" with that token. Was the token made in the same Cloudflare account?`);
}

// GitHub sometimes answers a download with a 5xx (a 504 once stopped an update) or drops the connection, so
// each download is tried up to 3 times, a second and then 3 seconds apart. Every try is one of the 50 calls the free
// plan allows a request, and a fresh install already makes about 30, so a release gets at most 6 extra tries.
const TRY_AGAIN_MS = [1000, 3000];
const SPARE_TRIES = 6;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function loadRelease(base, manifestSha256 = null) {
  const tries = { spare: SPARE_TRIES };
  const download = (url) => downloadWithRetries(url, tries);
  const bytes = await download(`${base}/manifest.json`);
  if (manifestSha256 && (await sha256(bytes)) !== manifestSha256) {
    throw new Error("The release doesn't match the fingerprint it should have, so nothing was installed.");
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  return {
    manifest,
    async file(hash) {
      const contents = await download(`${base}/${hash}`);
      if ((await sha256(contents)) !== hash) throw new Error("A release file doesn't match its fingerprint, so nothing was installed.");
      return contents;
    },
  };
}

/** Uploads the release's site files (unchanged ones are skipped by Cloudflare); returns the token deploying needs. */
export async function uploadAssets(token, account, script, release) {
  const { manifest } = release;
  const byHash = new Map(manifest.assets.map((a) => [a.hash, a]));
  const session = await api(token, `/accounts/${account}/workers/scripts/${script}/assets-upload-session`, {
    method: "POST",
    body: JSON.stringify({ manifest: Object.fromEntries(manifest.assets.map((a) => [a.path, { hash: a.hash, size: a.size }])) }),
  });
  let jwt = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) {
      const asset = byHash.get(hash);
      form.append(hash, new File([base64(await release.file(asset.sha256))], hash, { type: asset.type }));
    }
    const uploaded = await api(session.jwt, `/accounts/${account}/workers/assets/upload?base64=true`, { method: "POST", body: form });
    jwt = uploaded?.jwt ?? jwt;
  }
  return jwt;
}

export async function findOrCreateDatabase(token, account, name) {
  const found = (await api(token, `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name);
  return found ?? api(token, `/accounts/${account}/d1/database`, { method: "POST", body: JSON.stringify({ name }) });
}

/** The D1 database an existing afterwrd uses, or null for a Worker that isn't afterwrd yet. */
export function existingDatabase(settings) {
  const binding = settings.bindings?.find((b) => b.type === "d1" && b.name === "DB");
  return binding ? binding.id ?? binding.database_id : null;
}

/**
 * Uploads the release's code as a new version of `script`. A fresh install gets `secrets` (the setup code); an
 * update keeps the Worker's existing secrets. The photo store's class is only created if the Worker hasn't got
 * it yet, so photos already stored are untouched.
 */
export async function deployVersion(token, account, script, release, { jwt, databaseId, settings, secrets = {} }) {
  const { manifest } = release;
  const hasStore = (name) => settings.bindings?.some((b) => b.type === "durable_object_namespace" && b.class_name === name);
  const newClasses = manifest.migrations.new_sqlite_classes.filter((name) => !hasStore(name));
  const metadata = {
    main_module: manifest.main_module,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags,
    bindings: [
      { type: "d1", name: "DB", id: databaseId },
      ...manifest.durable_objects.map((d) => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
      { type: "assets", name: "ASSETS" },
      ...Object.entries(secrets).map(([name, text]) => ({ type: "secret_text", name, text })),
    ],
    keep_bindings: ["secret_text"],
    assets: { jwt, config: manifest.assets_config },
  };
  if (newClasses.length) metadata.migrations = { new_tag: manifest.migrations.new_tag, new_sqlite_classes: newClasses };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const module of manifest.modules) {
    form.append(module.name, new File([await release.file(module.sha256)], module.name, { type: module.type }));
  }
  await api(token, `/accounts/${account}/workers/scripts/${script}`, { method: "PUT", body: form });
}

async function downloadWithRetries(url, tries) {
  for (let attempt = 0; ; attempt++) {
    let status = null; // what GitHub answered, if it answered and it wasn't OK
    try {
      const response = await fetch(url, { headers: { "User-Agent": "afterwrd" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      status = response.status;
    } catch {} // no answer, or it broke off part way
    const problem = new Error(status ? `Couldn't download the release (${status}).` : "Couldn't download the release: GitHub didn't answer.");
    // A 404 and the like won't change by asking again; a 5xx, 429 or no answer might.
    if (status && status < 500 && status !== 429) throw problem;
    if (attempt >= TRY_AGAIN_MS.length || tries.spare <= 0) throw problem;
    tries.spare--;
    await new Promise((resolve) => setTimeout(resolve, TRY_AGAIN_MS[attempt]));
  }
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
