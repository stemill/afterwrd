// What's changed since an open page loaded, for public/static/live.js to say quietly ("2 new posts · Show"):
//   GET /_live?since=<time>&targets=<key>,…&remote=<connection>:<key>,…
//   -> { notifications, requests, posts, comments }
// notifications and requests are the header's counts. posts counts friends' new posts (from the notes their sites
// send, notify.js). comments counts new comments by others on the posts and photos the page shows: those here
// (`targets`) and friends' (`remote`, from their notes). Only reads this site's own database. Times are in seconds, so
// anything from the second the page was made counts: at worst, offering something the page already shows.
import { newCount } from "./archive/comments.js";
import { INBOX_JOIN } from "./notify.js";
import { json, now } from "./util.js";

const KEY_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;
const MAX_TARGETS = 80;

export async function handleLive(request, env, url, user) {
  if (request.method !== "GET" || !user.is_owner) return new Response("Not found", { status: 404 });
  const db = env.DB;
  const since = Math.min(now(), Math.max(0, Number.parseInt(url.searchParams.get("since"), 10) || now()));
  const list = (name) => (url.searchParams.get(name) ?? "").split(",").filter(Boolean).slice(0, MAX_TARGETS);
  const targets = list("targets").filter((k) => KEY_RE.test(k));
  const remote = list("remote").map((r) => /^(\d+):(.+)$/.exec(r)).filter((m) => m && KEY_RE.test(m[2]));

  const [requests, posts, here, there] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL"),
    db.prepare(`SELECT COUNT(*) AS n FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'post' AND i.created_at >= ?`).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM site_comments WHERE created_at >= ? AND (author_id IS NULL OR author_id != ?)
      AND target IN (${targets.map(() => "?").join(",") || "NULL"})`).bind(since, user.id, ...targets),
    db.prepare(`SELECT COUNT(*) AS n FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment' AND i.created_at >= ?
      AND (${remote.map(() => "(i.connection_id = ? AND i.target = ?)").join(" OR ") || "0"})`)
      .bind(since, ...remote.flatMap((m) => [Number(m[1]), m[2]])),
  ]);
  return json({
    notifications: await newCount(db, user),
    requests: requests.results[0].n,
    posts: posts.results[0].n,
    comments: here.results[0].n + there.results[0].n,
  }, 200);
}
