// Download everything (export.js): the page; the zip is made in the browser (public/static/export/main.js).
import { asset, FAVICON, ownerHeader } from "./nav.js";

export function exportPage() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download everything · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${FAVICON}
</head>
<body>
${ownerHeader("export")}
<main class="export">
<h1>Download everything</h1>
<p>Everything on this site in one zip file: your posts, photos and videos, albums, comments (including the
ones people have written here, and the ones you've written on friends' sites), likes, friends and connections, and
the groups you're in, with what you've posted and said there.
It's yours to keep, move or read with other tools.</p>
<p class="meta">The data is in <a href="https://www.w3.org/TR/activitystreams-core/" target="_blank" rel="noopener noreferrer">ActivityStreams</a>,
the open format the fediverse uses, and everything has a permanent address. So when two friends both download,
a comment one of you left on the other's post has the same address in both, and your conversations can be put
back together. A README in the zip explains the files.</p>

<form class="card" id="export">
  <label class="check"><input type="checkbox" name="media" checked>
    <span>Include photos and videos <span class="meta" id="size"></span></span></label>
  <p class="meta" id="memory" hidden>This browser can't save straight to a file, so it holds the whole download in memory
  first. For a big archive, use Chrome or Edge, or leave out photos and videos.</p>
  <button class="chip primary" id="go">Download everything</button>
  <p class="status meta" id="status" role="status"></p>
  <p class="error" id="error" role="alert"></p>
</form>
</main>
<script src="/static/vendor/zip-2.24.0.min.js"></script>
<script type="module" src="${asset("/static/export/main.js")}"></script>
</body>
</html>`;
}
