// Signs a published afterwrd release, so sites install it by themselves (src/signing.js, src/auto.js):
//
//   node scripts/sign.mjs 0.40.0            (on the release's tag, with `npm ci` done: run it after the Action)
//
// 1. Rebuilds the release here, from this checkout, and refuses unless its manifest is byte for byte the one GitHub
//    published: so a release that wasn't built from the tagged source (a tampered Action, a hijacked account) is
//    never signed. This is the rebuild check in SECURITY.md, done every time.
// 2. Asks for the key's passphrase and signs with ~/.afterwrd/release-signing-key.pem
//    (made by scripts/release-key.mjs).
// 3. Writes signatures/index.json at the top of the repository: the whole list of releases sites may take, signed
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

// The text the signature covers: the same as src/signing.js signedText().
const signedText = ({ seq, releases }) =>
  `afterwrd releases\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyOf = (raw) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw ?? "", "base64")]), format: "der", type: "spki" });
const checks = (list, raw) => {
  try { return edVerify(null, Buffer.from(signedText(list)), publicKeyOf(raw), Buffer.from(list.signature ?? "", "base64")); } catch { return false; }
};

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
  const releases = fresh ? [] : current.releases;
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
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })).slice(0, 50);
  }

  // 2. Sign the whole list, with the next sequence number.
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
  // It must check out against the public key sites carry (package.json), or they'd all refuse it.
  if (!checks(list, pkg.afterwrd.releaseKey)) { console.error("This key doesn't match afterwrd.releaseKey in package.json, so nothing was written."); process.exit(1); }

  // 3. Write it down.
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexFile, `${JSON.stringify(list, null, 2)}\n`);
  const what = pulling ? `Pulled ${version}` : `Signed ${version}`;
  console.log(`${what} (list ${list.seq}). Now, on main (git switch main first if this checkout is detached at the tag):`);
  console.log(`  git add signatures && git commit -m "${pulling ? "Pull" : "Signature for"} afterwrd ${version}" && git push origin main`);
  if (!pulling) console.log("(Sites take it by themselves after three days, or one if it fixes a security problem.)");
}
