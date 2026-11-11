// The owner's import page. The work happens in the browser (public/static/import/main.js): the export is read
// on this computer and only the ticked sections are uploaded.
import { asset, FAVICON, ownerHeader } from "./nav.js";
import { escape } from "../util.js";

const SECTION_CHOICES = [
  ["posts", "Posts", "Everything you've posted, with photos, links and places."],
  ["photos", "Photos & videos", "Your albums, and photos attached to posts and comments."],
  ["timeline", "Timeline", "Posts, comments and likes in date order."],
  ["comments", "Comments", "What you've said on other people's posts and photos."],
  ["likes", "Likes & reactions", "Whose posts you've liked, and when."],
  ["friends", "Friends", "Everyone you've interacted with, and when you became friends."],
  ["overview", "Overview", "Your profile, counts by year, and who you interact with most."],
];
const DEFAULT_ON = new Set(["posts", "photos"]);

export function importPage({ owner }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
<style>
  .pickers { display: grid; gap: 0.75rem; margin: 1rem 0; }
  .picker { display: block; background: var(--surface); border: 1px dashed var(--border); border-radius: 18px;
    padding: 0.9rem 1rem; cursor: pointer; }
  .picker:hover { border-color: var(--accent); }
  .picker strong { display: block; }
  .picker input { margin-top: 0.5rem; max-width: 100%; }
  fieldset { border: 1px solid var(--border); border-radius: 18px; background: var(--surface); padding: 0.6rem 1rem 0.8rem; margin: 0 0 1rem; }
  legend { font-weight: 600; padding: 0 0.3rem; }
  fieldset label { display: grid; grid-template-columns: auto 1fr; gap: 0 0.6rem; padding: 0.35rem 0; cursor: pointer; }
  fieldset label input { grid-row: span 2; margin-top: 0.25rem; }
  fieldset label span { color: var(--muted); font-size: 0.85rem; }
  #go { font: inherit; font-weight: 600; padding: 0.6rem 1.2rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button); cursor: pointer; }
  #go:disabled { opacity: 0.6; cursor: default; }
  #progress[hidden] { display: none; }
  #progress progress { width: 100%; height: 0.7rem; margin: 0.5rem 0; }
  #steps { padding-left: 1.2rem; margin: 0.5rem 0; }
  #steps li { margin: 0.2rem 0; }
  #steps li.done { color: var(--muted); }
  #notes { color: var(--muted); font-size: 0.85rem; }
  #error { color: #d93025; }
  #error:empty { display: none; }
</style>
</head>
<body>
${ownerHeader("import")}
<main>
<h1>Import your Facebook archive</h1>
<p class="meta">Signed in as ${escape(owner)}. Choose the download Facebook gave you, in JSON format.
Your browser reads it on this computer and uploads only the sections you tick below. Importing replaces
what you imported before (never what you've posted on afterwrd); the old version stays until the new one is complete.</p>

<div class="pickers">
  <label class="picker"><strong>The zip file(s) from Facebook</strong>
    <span class="meta">Big archives come as several zips: choose them all.</span><br>
    <input type="file" id="zips" accept=".zip,application/zip" multiple></label>
  <label class="picker"><strong>…or the unzipped folder</strong>
    <input type="file" id="folder" webkitdirectory></label>
</div>

<fieldset>
  <legend>What to publish</legend>
  ${SECTION_CHOICES.map(([key, label, about]) => `
  <label><input type="checkbox" name="section" value="${key}" ${DEFAULT_ON.has(key) ? "checked" : ""}>
    ${label}<span>${about}</span></label>`).join("")}
  <p class="meta">Comments, likes and friends are mostly about other people, so they're off by default. Whatever
  you leave unticked stays on this computer.</p>
</fieldset>

<fieldset>
  <legend>Privacy</legend>
  <label><input type="checkbox" id="locations">
    Photo locations<span>Where photos were taken, from the map positions your phone saved in them, and the
    coordinates of check-ins. Off by default: they can show where you live. Place names you wrote in posts are kept
    either way.</span></label>
</fieldset>

<button id="go" disabled>Import and publish</button>
<p id="error" role="alert"></p>

<section id="progress" hidden>
  <ol id="steps"></ol>
  <progress id="bar" max="1" value="0"></progress>
  <p id="status" class="meta"></p>
  <ul id="notes"></ul>
</section>
</main>
<script src="/static/vendor/zip-2.24.0.min.js"></script>
<script type="module" src="${asset("/static/import/main.js")}"></script>
</body>
</html>`;
}
