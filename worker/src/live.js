// What's changed since an open page loaded, for public/static/live.js to say quietly ("2 new posts · Show"):
//   GET /_live?since=<time>&targets=<key>,…&remote=<connection>:<key>,…&groups=<group>:<post>,…
//   -> { notifications, requests, posts, comments, update, messages }
// notifications and requests are the header's counts. posts counts friends' new posts (from the notes their sites
// send, notify.js). comments counts new comments by others on the posts and photos the page shows: those here
// (`targets`), friends' (`remote`, from their notes) and in groups (`groups`, from theirs). Only reads this site's own database. Times are in seconds, so
// anything from the second the page was made counts: at worst, offering something the page already shows.
// update is the newer afterwrd release that's out, if any (update.js), for the mark on the Update button. messages: chats
// with something unread and not muted (messages.js).
import { newCount } from "./archive/comments.js";
import { unreadChats } from "./messages.js";
import { INBOX_JOIN } from "./notify.js";
import { waitingRelease } from "./update.js";
import { json, now } from "./util.js";

const KEY_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;
const MAX_TARGETS = 80;

export async function handleLive(request, env, url, user, work) {
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const db = env.DB;
  const since = Math.min(now(), Math.max(0, Number.parseInt(url.searchParams.get("since"), 10) || now()));
  const list = (name) => (url.searchParams.get(name) ?? "").split(",").filter(Boolean).slice(0, MAX_TARGETS);
  const targets = list("targets").filter((k) => KEY_RE.test(k));
  const remote = list("remote").map((r) => /^(\d+):(.+)$/.exec(r)).filter((m) => m && KEY_RE.test(m[2]));
  const grouped = list("groups").map((r) => /^(\d{1,15}):(\d{1,15})$/.exec(r)).filter(Boolean);
  const pairs = (a, b) => grouped.map(() => `(${a} = ? AND ${b} = ?)`).join(" OR ") || "0";
  const pairValues = grouped.flatMap((m) => [Number(m[1]), Number(m[2])]);

  const [requests, posts, here, there, groups] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL"),
    db.prepare(`SELECT COUNT(*) AS n FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'post' AND i.created_at >= ?`).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM site_comments WHERE created_at >= ? AND (author_id IS NULL OR author_id != ?)
      AND target IN (${targets.map(() => "?").join(",") || "NULL"})`).bind(since, user.id, ...targets),
    db.prepare(`SELECT COUNT(*) AS n FROM inbox i ${INBOX_JOIN} WHERE i.kind = 'comment' AND i.created_at >= ?
      AND (${remote.map(() => "(i.connection_id = ? AND i.target = ?)").join(" OR ") || "0"})`)
      .bind(since, ...remote.flatMap((m) => [Number(m[1]), m[2]])),
    db.prepare(`SELECT COUNT(*) AS n FROM group_inbox WHERE kind IS NULL AND created_at >= ? AND (${pairs("group_id", "post_id")})`).bind(since, ...pairValues),
  ]);
  return json({
    notifications: await newCount(db, user),
    requests: requests.results[0].n,
    posts: posts.results[0].n,
    comments: here.results[0].n + there.results[0].n + groups.results[0].n,
    update: await waitingRelease(env, work),
    messages: await unreadChats(db),
  }, 200);
}
