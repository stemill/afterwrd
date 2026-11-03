// Download everything: the owner's whole site as a zip of ActivityStreams documents plus every photo and video,
// built in the browser (public/static/export/main.js) so size and the free plan's limits don't matter. This
// side only hands over rows, a page at a time:
//   GET /_admin/export                         the page
//   GET /_admin/export/rows?table=<t>&after=<n>  up to 1000 rows of one table, after rowid n
// Keys and anything to do with signing in never leave: connections give only who and where, users only names.
import { asset, ownerHeader } from "./nav.js";
import { html, json } from "./util.js";

const PAGE = 1000;
const TABLES = {
  settings: { columns: "key, value" },
  people: { columns: "*" },
  albums: { columns: "*" },
  posts: { columns: "*" },
  post_tags: { columns: "*" },
  comments: { columns: "*" },
  reactions: { columns: "*" },
  media: { columns: "*" },
  tagged_photos: { columns: "*" },
  site_comments: { columns: "*" },
  comments_elsewhere: { columns: "*" },
  connections: { columns: "id, origin, name, connected_at", where: "connected_at IS NOT NULL" },
  users: { columns: "id, name, is_owner, revoked_at, site" },
};

export async function handleExport(request, env, url) {
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  if (url.pathname === "/_admin/export") return html(exportPage());
  if (url.pathname === "/_admin/export/rows") {
    const table = url.searchParams.get("table");
    if (!Object.hasOwn(TABLES, table)) return json({ error: "Unknown table." }, 400);
    const { columns, where } = TABLES[table];
    const after = Number.parseInt(url.searchParams.get("after"), 10) || 0;
    const { results } = await env.DB.prepare(`SELECT rowid AS _rowid, ${columns} FROM ${table}
      WHERE rowid > ? ${where ? `AND ${where}` : ""} ORDER BY rowid LIMIT ?`).bind(after, PAGE).all();
    return json({ rows: results, next: results.length === PAGE ? results.at(-1)._rowid : null });
  }
  return new Response("Not found", { status: 404 });
}

function exportPage() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download everything · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
<link rel="icon" href="data:,">
</head>
<body>
${ownerHeader("export")}
<main class="export">
<h1>Download everything</h1>
<p>Everything on this site in one zip file: your posts, photos and videos, albums, comments (including the
ones people have written here, and the ones you've written on friends' sites), likes, friends and connections.
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
