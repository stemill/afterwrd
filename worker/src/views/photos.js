// Adding photos to an album made here, or choosing a profile picture or cover (photos.js; the page's script is
// public/static/add-photos.js).
import { escape } from "../util.js";
import { asset, FAVICON, ownerHeader } from "./nav.js";

export function addPage({ albums, chosen, role, max, me = null }) {
  const title = role === "profile" ? "Choose a profile picture" : role === "cover" ? "Choose a cover photo" : "Add photos";
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
</head>
<body>
${ownerHeader("photos", me)}
<main class="add-photos">
<p class="crumbs"><a href="${role ? "/posts" : "/photos"}">${role ? "Posts" : "Photos"}</a> /</p>
<h1>${title}</h1>
${role ? `<p class="meta">Upload one here, or open any of your photos and press <b>Make ${role === "profile" ? "profile picture" : "cover"}</b>.</p>` : ""}
<form class="card composer" id="add" data-role="${role ?? ""}" data-max="${max}">
  ${role ? "" : `<label>Album
    <select name="album" data-search="Type an album's name" aria-label="Album">
      <option value="new">New album…</option>
      ${albums.map((a) => `<option value="${a.id}" ${a.id === chosen ? "selected" : ""}>${escape(a.name)}</option>`).join("")}
    </select></label>
  <div class="new-album">
    <input name="name" maxlength="200" placeholder="Album name, e.g. Summer 2026" aria-label="Album name">
    <textarea name="description" rows="2" maxlength="2000" placeholder="What's it about? (optional)" aria-label="Album description"></textarea>
  </div>`}
  <ul class="picked" hidden></ul>
  <label class="chip pick"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>
    <span>${role ? "Choose a photo" : "Choose photos"}</span><input type="file" accept="image/*" ${role ? "" : "multiple"} class="hidden"></label>
  <label class="check"><input type="checkbox" name="share" ${role ? "" : "checked"}> <span>Also share it as a post, so friends see it on their Home</span></label>
  <textarea name="text" rows="2" maxlength="5000" placeholder="Say something about it (optional)" aria-label="Say something"></textarea>
  <p class="error" role="alert"></p>
  <div class="actions"><span class="status meta" role="status"></span><button class="post">${role ? "Use this photo" : "Add photos"}</button></div>
</form>
</main>
<script type="module" src="${asset("/static/add-photos.js")}"></script>
</body>
</html>`;
}
