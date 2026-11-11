// Download everything: the owner's whole site as a zip of ActivityStreams documents plus every photo and video,
// built in the browser (public/static/export/main.js) so size and the free plan's limits don't matter. This
// side only hands over rows, a page at a time:
//   GET /_admin/export                         the page
//   GET /_admin/export/rows?table=<t>&after=<n>  up to 1000 rows of one table, after rowid n
// Keys and anything to do with signing in never leave: connections give only who and where, users only names.
import { html, json } from "./util.js";
import { exportPage } from "./views/export.js";

const PAGE = 1000;
const TABLES = {
  // The rest of settings are the site's own keys.
  settings: { columns: "key, value", where: "key IN ('sections', 'profile_hash', 'cover_hash')" },
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
  // Polls in the owner's posts, and who answered: the owner's own records.
  site_polls: { columns: "*" },
  site_poll_votes: { columns: "post_id, voter, name, choices, voted_at" },
  connections: { columns: "id, origin, name, connected_at", where: "approved_at IS NOT NULL" },
  // Groups: which, and what the owner posted and said in them. No keys.
  groups: { columns: "id, name, about, origin, remote_id, host_name, joined_at, role", where: "joined_at IS NOT NULL" },
  group_mine: { columns: "*" },
  friend_links: { columns: "connection_id, person_name" },
  // Messages with friends: who with, and what was said. Muting and what's been read stay here.
  chats: { columns: "id, origin, name, kind, created_at" },
  messages: { columns: "id, chat_id, mine, uid, text, sent_at, received_at, delivered_at, author_origin, author_name", where: "deleted_at IS NULL" },
  users: { columns: "id, name" },
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
