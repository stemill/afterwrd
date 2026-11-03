// Packages a afterwrd release for the installer:
//
//   npm run release -- --base https://github.com/<owner>/afterwrd/releases/download/v<version>
//
// writes release/<version>/, a flat folder so every file can be a GitHub release asset:
//   manifest.json    the code modules and site files, each with its SHA-256, plus the Worker settings
//   <sha256>         every file, named by its hash
//   installer.js     the installer people paste into a new Worker, with the manifest's hash built in
// Publish every file in the folder at --base unchanged; the installer refuses anything that doesn't match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build as bundle } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

const TYPES = {
  ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm",
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

const manifest = {
  name: "afterwrd",
  version,
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

// The install page (published to GitHub Pages by the release workflow), with this installer in it to copy.
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(base)?.[1];
const escapeHtml = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const site = join(worker, "release", "site");
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
writeFileSync(join(site, "index.html"), readFileSync(join(worker, "installer", "page.html"), "utf8")
  .replaceAll("__INSTALLER_HTML__", () => escapeHtml(installer)) // a function, so "$" in the code stays literal
  .replaceAll("__VERSION__", version)
  .replaceAll("__MANIFEST_SHORT__", sha256(manifestBytes).slice(0, 12))
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
