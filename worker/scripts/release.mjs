// Packages a afterwrd release for the installer:
//
//   npm run release -- --base https://github.com/<owner>/afterwrd/releases/download/v<version>
//
// writes release/<version>/, a flat folder so every file can be a GitHub release asset:
//   manifest.json    the code modules and site files, each with its SHA-256, plus the Worker settings
//   <sha256>         every file, named by its hash
//   installer.js     the installer, with the manifest's hash built in: deployed by the install page's "Install on
//                    Cloudflare" link, or pasted into a new Worker by hand
// and release/site/, the install page (with the Connect page Cloudflare's sign-in comes back to, and How it works).
// Publish every file in the folder at --base unchanged; the installer refuses anything that doesn't match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build as bundle } from "esbuild";
import lz from "lz-string";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTICES_PATH, notices, runtimePackages } from "./notices.mjs";

const worker = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1];
if (!args.includes("--base") || !/^https:\/\/\S+[^/]$/.test(base ?? "")) {
  console.error("Give the https address the release folder will be published at, without a trailing slash: --base https://…");
  process.exit(1);
}

const { version, afterwrd: project } = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
// wrangler.jsonc with its comments removed; no value in it contains "//".
const config = JSON.parse(readFileSync(join(worker, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const out = join(worker, "release", version);
const dist = join(worker, "release", ".build");
rmSync(out, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const build = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", dist], { cwd: worker, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(1);
}

// Every copy must carry the licences of the code inside it (see scripts/notices.mjs): stop if licenses.txt is
// stale, or if the built Worker contains a package it doesn't list.
if (readFileSync(NOTICES_PATH, "utf8") !== notices()) {
  console.error("public/static/licenses.txt is out of date: run npm run notices, check the result and commit it.");
  process.exit(1);
}
const covered = new Set(runtimePackages().map((p) => p.dir));
const PACKAGE_DIR = /^(node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*)\//;
const bundledPackages = new Set(JSON.parse(readFileSync(join(dist, "index.js.map"), "utf8")).sources
  .map((source) => PACKAGE_DIR.exec(relative(worker, resolve(dist, source)).split(sep).join("/"))?.[1])
  .filter(Boolean));
const uncovered = [...bundledPackages].filter((dir) => !covered.has(dir));
if (!bundledPackages.has("node_modules/@simplewebauthn/server")) {
  console.error("Couldn't read which packages the Worker contains from its source map, so can't check licenses.txt.");
  process.exit(1);
}
if (uncovered.length) {
  console.error(`The Worker contains packages licenses.txt doesn't cover: ${uncovered.join(", ")}`);
  process.exit(1);
}

const TYPES = {
  ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".woff2": "font/woff2", ".txt": "text/plain",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function add(bytes) {
  const hash = sha256(bytes);
  writeFileSync(join(out, hash), bytes);
  return { sha256: hash, size: bytes.length };
}

const modules = readdirSync(dist)
  .filter((name) => name.endsWith(".js") || name.endsWith(".sql"))
  .map((name) => ({
    name,
    type: name.endsWith(".js") ? "application/javascript+module" : "text/plain",
    ...add(readFileSync(join(dist, name))),
  }));

const publicDir = join(worker, config.assets.directory);
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const assets = walk(publicDir).map((file) => {
  const bytes = readFileSync(file);
  return {
    path: `/${relative(publicDir, file).split("\\").join("/")}`,
    type: TYPES[extname(file)] ?? "text/plain",
    // The upload session's own identifier for the file (32 hex characters), as in Cloudflare's examples.
    hash: sha256(bytes.toString("base64") + extname(file).slice(1)).slice(0, 32),
    ...add(bytes),
  };
});

// What's new, for the Update page: the tagged commit's message, without its sign-off lines.
const git = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: worker, encoding: "utf8" });
// Commit messages wrap at 72 characters; the page wraps for itself, so lines within a paragraph are joined.
const notes = git.status === 0
  ? git.stdout.replace(/^Co-Authored-By:.*$/gim, "").trim().split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, " ")).join("\n\n").slice(0, 3000)
  : "";

// The newest release that fixed a security problem: set afterwrd.securityFix in package.json to the version being
// released when it fixes one, and leave it as it is otherwise, so sites that skip a release still hear about it.
// Sites older than it show their owner a notice on Home (update.js securityFixWaiting).
const securityFix = project.securityFix;
if (securityFix !== undefined && !(/^\d+\.\d+\.\d+$/.test(securityFix) && !newerThan(securityFix, version))) {
  throw new Error(`afterwrd.securityFix in package.json (${securityFix}) must be a version no newer than ${version}.`);
}

const manifest = {
  name: "afterwrd",
  version,
  notes,
  ...(securityFix ? { security_fix: securityFix } : {}),
  main_module: config.main.split("/").pop(),
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags ?? [],
  modules,
  assets,
  assets_config: {
    html_handling: config.assets.html_handling,
    not_found_handling: config.assets.not_found_handling,
    run_worker_first: config.assets.run_worker_first,
  },
  durable_objects: config.durable_objects.bindings,
  migrations: { new_tag: config.migrations.at(-1).tag, new_sqlite_classes: config.migrations.flatMap((m) => m.new_sqlite_classes ?? []) },
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(join(out, "manifest.json"), manifestBytes);

// The installer and the deploy code it shares with the Update page (src/deploy.js), as one file people can
// paste. Bundling drops comments, so the installer's opening explanation is put back as a header.
const installerPath = join(worker, "installer", "installer.js");
const header = readFileSync(installerPath, "utf8").match(/^(\/\/.*\n)+/)[0];
const bundled = await bundle({
  entryPoints: [installerPath], bundle: true, format: "esm", target: "es2022", write: false, legalComments: "none",
  banner: { js: header },
});
const installer = bundled.outputFiles[0].text
  .replaceAll("__RELEASE_BASE__", base)
  .replaceAll("__MANIFEST_SHA256__", sha256(manifestBytes))
  .replaceAll("__VERSION__", version);
writeFileSync(join(out, "installer.js"), installer);

// "Install on Cloudflare": a link to Cloudflare's own Deploy page with the installer filled in, made the way the Workers
// Playground's Deploy button makes it (the Worker as a form, compressed into the part after "#", which never leaves
// the browser). The page's name for the Worker is the end of the path; Cloudflare adds a random ending to it, so the
// installer asks for the site's address itself and moves afterwrd there (see installer.js).
const playground = new FormData();
playground.set("installer.js", new Blob([installer], { type: "application/javascript+module" }), "installer.js");
playground.set("metadata", new Blob([JSON.stringify({ compatibility_date: config.compatibility_date, main_module: "installer.js" })],
  { type: "application/json" }));
const form = new Response(playground);
const deployLink = "https://dash.cloudflare.com/workers-and-pages/deploy/playground/afterwrd-installer#"
  + lz.compressToEncodedURIComponent(`${form.headers.get("content-type")}:${await form.text()}`);

// The install page (published to GitHub Pages by the release workflow), with this installer in it to copy.
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(base)?.[1];
const escapeHtml = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const site = join(worker, "release", "site");
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
writeFileSync(join(site, "index.html"), readFileSync(join(worker, "installer", "page.html"), "utf8")
  .replaceAll("__INSTALLER_HTML__", () => escapeHtml(installer)) // a function, so "$" in the code stays literal
  .replaceAll("__VERSION__", version)
  .replaceAll("__DEPLOY_LINK__", deployLink)
  .replaceAll("__MANIFEST_SHORT__", sha256(manifestBytes).slice(0, 12))
  .replaceAll("__RELEASE_PAGE__", repo ? `https://github.com/${repo}/releases/tag/v${version}` : base)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// The Connect page, at /connect/: the address Cloudflare's sign-in sends people back to (src/cloudflare.js).
mkdirSync(join(site, "connect"), { recursive: true });
writeFileSync(join(site, "connect", "index.html"), readFileSync(join(worker, "installer", "connect.html"), "utf8")
  .replaceAll("__OAUTH_CLIENT__", project.cloudflareClient));
// "How it works", beside it at /how-it-works/.
mkdirSync(join(site, "how-it-works"), { recursive: true });
writeFileSync(join(site, "how-it-works", "index.html"), readFileSync(join(worker, "installer", "how-it-works.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__RELEASE_PAGE__", repo ? `https://github.com/${repo}/releases/tag/v${version}` : base)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// GitHub Pages keeps a custom domain in a CNAME file beside the page; the release replaces the whole branch, so
// it's written here every time or the domain would be dropped.
if (project?.site) writeFileSync(join(site, "CNAME"), `${project.site}\n`);
rmSync(dist, { recursive: true, force: true });

const total = [...modules, ...assets].reduce((n, f) => n + f.size, 0);
console.log(`afterwrd ${version}: ${modules.length} code modules and ${assets.length} site files (${(total / 1e3).toFixed(0)} KB)`);
console.log(`  ${relative(worker, out)}/  → publish at ${base}/`);
console.log(`  installer: ${relative(worker, join(out, "installer.js"))} (manifest ${sha256(manifestBytes).slice(0, 12)}…)`);

function newerThan(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
