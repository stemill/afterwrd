// Signs a published afterwrd release, so sites install it by themselves (src/signing.js, src/auto.js):
//
//   node scripts/sign.mjs 0.40.0            (on the release's tag, with `npm ci` done: run it after the Action)
//
// 1. Rebuilds the release here, from this checkout, and refuses unless its manifest is byte for byte the one GitHub
//    published: so a release that wasn't built from the tagged source (a tampered Action, a hijacked account) is
//    never signed. This is the rebuild check in SECURITY.md, done every time.
// 2. Works out the release's etag, Cloudflare's fingerprint of its code (the same in every account): uploads the
//    published code, checked against the manifest, as a version of the Worker "afterwrd-etag" in your Cloudflare
//    account (a placeholder that answers nothing; never made live), with wrangler's sign-in (or CLOUDFLARE_API_TOKEN),
//    and reads it back. Releases in the list without one get theirs too. Friends' checks use them (src/signing.js).
// 3. Asks for the key's passphrase and signs with ~/.afterwrd/release-signing-key.pem
//    (made by scripts/release-key.mjs).
// 4. Writes signatures/index.json at the top of the repository: the whole list of releases sites may take, signed
//    together with a sequence number one higher than before (sites never accept a lower one). Commit and push it
//    (with your own key, as for a release); sites read it from the main branch. The three-day wait (one day for a
//    security fix) starts from the time signed.
//
//   node scripts/sign.mjs --pull 0.40.0     takes a release back: signs the list again without it.
//   …--key-change                           only if this release deliberately changes the signing key or repository.
import { createPrivateKey, createPublicKey, createHash, sign as edSign, verify as edVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads a line without showing it (for a passphrase). */
export function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const input = process.stdin;
    let text = "";
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          input.setRawMode?.(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(text);
          return;
        }
        if (c === "\u0003") process.exit(130); // Ctrl-C
        if (c === "\u007f") text = text.slice(0, -1);
        else text += c;
      }
    };
    input.on("data", onData);
  });
}

// The texts the signatures cover: the same as src/signing.js signedText() and signedText2().
const signedText = ({ seq, releases }) =>
  `afterwrd releases\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;
const signedText2 = ({ seq, releases }) =>
  `afterwrd releases 2\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at} ${r.etag ?? "-"}\n`).join("")}`;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyOf = (raw) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw ?? "", "base64")]), format: "der", type: "spki" });
const SIGNATURE2_FROM = 9; // as src/signing.js: from this list on, the second signature must be there
const checks = (list, raw) => {
  try {
    const good = (text, signature) => edVerify(null, Buffer.from(text), publicKeyOf(raw), Buffer.from(signature ?? "", "base64"));
    if (list.seq >= SIGNATURE2_FROM && list.signature2 === undefined) return false;
    return good(signedText(list), list.signature) && (list.signature2 === undefined || good(signedText2(list), list.signature2));
  } catch { return false; }
};

// --- etags: Cloudflare's fingerprint of a release's code ----------------------------------------------------------
const CF = "https://api.cloudflare.com/client/v4";
const ETAG_WORKER = "afterwrd-etag";

export function cloudflareToken(worker) {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  const out = spawnSync(join(worker, "node_modules", ".bin", "wrangler"), ["auth", "token"], { cwd: worker, encoding: "utf8" });
  const token = out.status === 0 ? out.stdout.trim().split("\n").pop().trim() : "";
  if (!token) throw new Error("Couldn't get a Cloudflare sign-in: run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN) and try again.");
  return token;
}

async function cf(token, path, init = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const response = await fetch(CF + path, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw Object.assign(new Error(`Cloudflare said ${response.status}: ${data.errors?.map((e) => e.message).join("; ") ?? ""}`), { status: response.status });
  }
  return data.result;
}

/** The account holding the afterwrd-etag Worker (made, as a placeholder, if the sign-in sees exactly one account). */
export async function etagAccount(token) {
  const accounts = await cf(token, "/accounts");
  for (const account of accounts) {
    try { await cf(token, `/accounts/${account.id}/workers/scripts/${ETAG_WORKER}/settings`); return account.id; } catch (error) { if (error.status !== 404) throw error; }
  }
  if (accounts.length !== 1) throw new Error(`No Worker called ${ETAG_WORKER} in the accounts this sign-in sees, and it sees ${accounts.length}: make one first.`);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: "2026-10-01" })], { type: "application/json" }));
  form.append("index.js", new File(["export default { fetch() { return new Response(null, { status: 404 }); } };\n"], "index.js", { type: "application/javascript+module" }));
  await cf(token, `/accounts/${accounts[0].id}/workers/scripts/${ETAG_WORKER}`, { method: "PUT", body: form });
  await cf(token, `/accounts/${accounts[0].id}/workers/scripts/${ETAG_WORKER}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: false, previews_enabled: false }) });
  console.log(`Made the placeholder Worker ${ETAG_WORKER} (answers nothing, not on workers.dev).`);
  return accounts[0].id;
}

/**
 * A published release's etag: its code downloaded and checked against the manifest whose SHA-256 was signed, then
 * uploaded to afterwrd-etag as a version that's never made live, and the etag Cloudflare gives it read back.
 */
export async function etagOf(token, account, repo, version, manifestSha256) {
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const bytes = Buffer.from(await (await fetch(`${base}/manifest.json`)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== manifestSha256) throw new Error(`${version}'s manifest isn't the one signed.`);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: manifest.main_module, compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags })], { type: "application/json" }));
  for (const m of manifest.modules) {
    const file = Buffer.from(await (await fetch(`${base}/${m.sha256}`)).arrayBuffer());
    if (createHash("sha256").update(file).digest("hex") !== m.sha256) throw new Error(`${version}'s ${m.name} doesn't match its manifest.`);
    form.append(m.name, new File([file], m.name, { type: m.type }));
  }
  const { id } = await cf(token, `/accounts/${account}/workers/scripts/${ETAG_WORKER}/versions`, { method: "POST", body: form });
  const etag = (await cf(token, `/accounts/${account}/workers/scripts/${ETAG_WORKER}/versions/${id}`))?.resources?.script?.etag;
  if (!/^[0-9a-f]{64}$/.test(etag ?? "")) throw new Error(`Cloudflare didn't give ${version} an etag.`);
  return etag;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = fileURLToPath(new URL("..", import.meta.url));
  const root = join(worker, "..");
  const args = process.argv.slice(2);
  const pulling = args.includes("--pull");
  const keyChange = args.includes("--key-change");
  const version = args.find((a) => !a.startsWith("--"));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) { console.error("Usage: node scripts/sign.mjs <version>   or   node scripts/sign.mjs --pull <version>"); process.exit(1); }
  const pkg = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

  // The list as it stands: it must be genuine (signed with this key), or it isn't built on.
  const dir = join(root, "signatures");
  const indexFile = join(dir, "index.json");
  const current = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : [];
  const fresh = Array.isArray(current) && current.length === 0;
  if (!fresh && !checks(current, pkg.afterwrd.releaseKey)) {
    console.error("signatures/index.json isn't signed with the key in package.json, so it won't be built on. Find out why first.");
    process.exit(1);
  }
  // Etags are only carried forward if the second signature covered them; any others (added to the file by someone
  // else, say) are worked out again below.
  const releases = fresh ? [] : current.signature2 === undefined
    ? current.releases.map(({ etag, ...r }) => r) : current.releases;
  const seq = fresh ? 0 : current.seq;

  let next;
  if (pulling) {
    if (!releases.some((r) => r.version === version)) { console.error(`${version} isn't in the signed list.`); process.exit(1); }
    next = releases.filter((r) => r.version !== version);
  } else {
    if (pkg.version !== version) { console.error(`This checkout is ${pkg.version}, not ${version}: check out v${version} first.`); process.exit(1); }
    const head = git("rev-parse", "HEAD").stdout.trim();
    const tagged = git("rev-parse", `v${version}^{commit}`).stdout.trim();
    if (!tagged || head !== tagged) { console.error(`HEAD isn't the commit tagged v${version}.`); process.exit(1); }
    if (git("status", "--porcelain", "--untracked-files=no").stdout.trim()) { console.error("There are uncommitted changes: the rebuild must be the tagged source."); process.exit(1); }
    // A release that changes which key sites trust, or where they update from, is never signed by accident.
    const last = releases[0]?.version;
    if (last) {
      const before = JSON.parse(git("show", `v${last}:worker/package.json`).stdout || "{}").afterwrd ?? {};
      if ((before.releaseKey !== pkg.afterwrd.releaseKey || before.releases !== pkg.afterwrd.releases) && !keyChange) {
        console.error(`Since ${last}, package.json changes the signing key or the release repository. If you meant that, run again with --key-change.`);
        process.exit(1);
      }
    }

    // 1. Rebuild, and compare with what GitHub published.
    const base = `https://github.com/${pkg.afterwrd.releases}/releases/download/v${version}`;
    console.log("Rebuilding the release from this checkout…");
    const build = spawnSync("node", ["scripts/release.mjs", "--base", base], { cwd: worker, encoding: "utf8" });
    if (build.status !== 0) { console.error(build.stderr || build.stdout); process.exit(1); }
    const mine = readFileSync(join(worker, "release", version, "manifest.json"));
    rmSync(join(worker, "release", version), { recursive: true, force: true });
    rmSync(join(worker, "release", "site"), { recursive: true, force: true });
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) { console.error(`Couldn't download the published manifest (${response.status}). Has the Action finished?`); process.exit(1); }
    const published = Buffer.from(await response.arrayBuffer());
    if (!published.equals(mine)) {
      console.error("The published release is NOT what this checkout builds, so it won't be signed.");
      console.error("If you haven't, run `npm ci --ignore-scripts` (the Action's exact packages) and try again; if it still differs, find out why before anything else.");
      process.exit(1);
    }
    const manifestSha = createHash("sha256").update(published).digest("hex");
    console.log(`The published release matches the rebuild (manifest ${manifestSha.slice(0, 12)}…).`);
    const signedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    next = [{ version, manifest_sha256: manifestSha, signed_at: signedAt }, ...releases.filter((r) => r.version !== version)]
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })).slice(0, 200); // as src/signing.js MAX_RELEASES
  }

  // 2. Each release's etag (Cloudflare's fingerprint of its code), for any that hasn't got one yet.
  if (next.some((r) => !r.etag)) {
    console.log("Working out the releases' etags in Cloudflare (uploaded to afterwrd-etag, never live)…");
    try {
      const token = cloudflareToken(worker);
      const account = await etagAccount(token);
      for (const r of next.filter((r) => !r.etag)) {
        try {
          r.etag = await etagOf(token, account, pkg.afterwrd.releases, r.version, r.manifest_sha256);
          console.log(`  ${r.version}: ${r.etag.slice(0, 12)}…`);
        } catch (error) {
          if (r.version === version && !pulling) throw error;
          console.log(`  ${r.version}: none (${error.message})`);
        }
      }
    } catch (error) {
      // A new release must have its etag (friends' checks need it); pulling one never waits on Cloudflare.
      if (!pulling) { console.error(`Couldn't work out ${version}'s etag: ${error.message}`); process.exit(1); }
      console.log(`  (etags skipped: ${error.message})`);
    }
  }

  // 3. Sign the whole list, with the next sequence number.
  const keyFile = join(homedir(), ".afterwrd", "release-signing-key.pem");
  if (!existsSync(keyFile)) { console.error(`No key at ${keyFile}: make one with node scripts/release-key.mjs.`); process.exit(1); }
  let key;
  try {
    key = createPrivateKey({ key: readFileSync(keyFile), passphrase: await askHidden("Passphrase for the signing key: ") });
  } catch {
    console.error("That passphrase doesn't open the key.");
    process.exit(1);
  }
  const list = { seq: seq + 1, releases: next };
  list.signature = edSign(null, Buffer.from(signedText(list)), key).toString("base64");
  list.signature2 = edSign(null, Buffer.from(signedText2(list)), key).toString("base64");
  // It must check out against the public key sites carry (package.json), or they'd all refuse it.
  if (!checks(list, pkg.afterwrd.releaseKey)) { console.error("This key doesn't match afterwrd.releaseKey in package.json, so nothing was written."); process.exit(1); }

  // 4. Write it down.
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexFile, `${JSON.stringify(list, null, 2)}\n`);
  const what = pulling ? `Pulled ${version}` : `Signed ${version}`;
  console.log(`${what} (list ${list.seq}). Now, on main (git switch main first if this checkout is detached at the tag):`);
  console.log(`  git add signatures && git commit -m "${pulling ? "Pull" : "Signature for"} afterwrd ${version}" && git push origin main`);
  if (!pulling) console.log("(Sites take it by themselves after three days, or one if it fixes a security problem.)");
}
