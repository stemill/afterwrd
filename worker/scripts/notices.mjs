// Writes public/static/licenses.txt: afterwrd's own licence, then the licence of every other project whose code or
// fonts are installed with it, which their licences (MIT, BSD, Apache, OFL) ask to travel with every copy:
//
//   npm run notices
//
// The list is the Worker's runtime dependencies in package-lock.json (everything not marked dev), plus the files in
// public/static that came from elsewhere (zip.js, the Nunito fonts). The release refuses to build if licenses.txt is
// out of date, or if the built Worker contains a package it doesn't cover, so run this after changing dependencies.
// The file is served at /static/licenses.txt and linked from every page's menu.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
export const NOTICES_PATH = join(worker, "public", "static", "licenses.txt");
const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyrightnotice)(\.(md|txt))?$/i;
const RULE = "=".repeat(78);

// Files in public/static that aren't afterwrd's own, with the licence file kept beside each.
const VENDORED = [
  { name: "zip.js 2.24.0 (static/vendor/zip-2.24.0.min.js)", licence: "BSD-3-Clause", url: "https://github.com/gildas-lormeau/zip.js",
    files: ["public/static/vendor/zip-2.24.0.LICENSE"] },
  { name: "Nunito (static/fonts/nunito.woff2)", licence: "OFL-1.1", url: "https://github.com/googlefonts/nunito",
    files: ["public/static/fonts/OFL-nunito.txt"] },
  { name: "Nunito Sans (static/fonts/nunito-sans.woff2)", licence: "OFL-1.1", url: "https://github.com/Fonthausen/NunitoSans",
    files: ["public/static/fonts/OFL-nunito-sans.txt"] },
];

const repoUrl = (repository) => {
  const url = typeof repository === "string" ? repository : repository?.url;
  return url ? url.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://") : "";
};

/** The runtime packages in package-lock.json, as { dir, name, version, licence, url, files }. */
export function runtimePackages() {
  const lock = JSON.parse(readFileSync(join(worker, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([dir, info]) => dir && !info.dev && !info.devOptional)
    .map(([dir]) => {
      const pkg = JSON.parse(readFileSync(join(worker, dir, "package.json"), "utf8"));
      const files = readdirSync(join(worker, dir)).filter((f) => LICENCE_FILE.test(f)).sort().map((f) => join(dir, f));
      if (!files.length) throw new Error(`${pkg.name} has no licence file in ${dir}: add its licence to VENDORED by hand.`);
      return { dir, name: `${pkg.name} ${pkg.version}`, licence: pkg.license, url: repoUrl(pkg.repository), files };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The text of licenses.txt. Projects with word-for-word the same licence text share one copy of it. */
export function notices() {
  const { version, afterwrd: project } = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
  const entries = [...runtimePackages(), ...VENDORED].map((entry) => {
    for (const f of entry.files) if (!existsSync(join(worker, f))) throw new Error(`Missing licence file ${f}`);
    return { ...entry, text: entry.files.map((f) => readFileSync(join(worker, f), "utf8").trim()).join("\n\n") };
  });
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.text)) groups.set(entry.text, []);
    groups.get(entry.text).push(entry);
  }
  const sections = [...groups].map(([text, group]) => [
    RULE,
    ...group.map((e) => `${e.name}  (${e.licence})${e.url ? `  ${e.url}` : ""}`),
    RULE,
    "",
    text,
  ].join("\n"));
  return `afterwrd ${version}
Copyright (C) 2026 Ste Millington

afterwrd is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option)
any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
for more details: https://www.gnu.org/licenses/agpl-3.0.html

Its source code, and the full licence, are at https://github.com/${project.releases}

afterwrd also includes the work of the projects below, under their own licences, which follow.

${sections.join("\n\n\n")}
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(NOTICES_PATH, notices());
  console.log(`Wrote ${NOTICES_PATH}`);
}
