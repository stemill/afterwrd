// Serves the archive to people who have signed in with a passkey: pages are built from D1, photos and videos
// come from the media store (/files/<sha256>), and the stylesheet and import scripts from public/static.
// Everything the owner imports arrives through /_admin/import, and comments through /_comments. Every request
// comes through here first (run_worker_first), so nothing is reachable without a session, apart from sign-in, a
// Connect link, and connected friends' sites and groups the owner's in, which carry a key (connect.js, peers.js,
// membership.js). A group's own Worker (with the secret GROUP_KEY) is afterwrd in group mode: it answers only its
// members' sites and invite links (groups.js), and serves nothing else at all.
import { handleAdmin } from "./admin.js";
import { handleComments } from "./archive/comments.js";
import { renderArchive } from "./archive/routes.js";
import { currentUser, handleAuth } from "./auth.js";
import { handleCloudflare } from "./cloudflare.js";
import { handleConnectLink } from "./connect.js";
import { handleFeed } from "./feed.js";
import { handleGroupApi, handleJoinLink } from "./groups.js";
import { HASH_RE, mediaStore } from "./media.js";
import { handleGroupActions, handleMember } from "./membership.js";
import { checkNewer, databaseIsNewer, ensureSchema } from "./migrate.js";
import { handlePeer } from "./peers.js";
import { messagePage } from "./views/pages.js";
import { signedFor } from "./share.js";
import { serveStatic } from "./static.js";
import { handleCheck } from "./checks.js";
import { html } from "./util.js";
import { handleLive } from "./live.js";
import { handlePush } from "./push.js";
import { autoState, handleAutoConnect, handleAutoStep, health, runAuto } from "./auto.js";
import { handleChecksConnect, runFriendChecks } from "./friendchecks.js";

export { MediaStore } from "./media.js";
export { Outbox } from "./outbox.js";
const HEADERS = {
  // No framing, plugins, <base> tricks or forms posting elsewhere. (Scripts aren't restricted: the pages use
  // small inline scripts, and everything interpolated into a page is escaped.) Pages' own calls (fetch) go only to
  // this site, so a library running in the page, such as zip.js reading a Facebook download, can't send what it
  // reads anywhere else that way. Calls to Cloudflare, GitHub and friends' sites are made by the Worker, not the page.
  "Content-Security-Policy": "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  // Other sites never learn where a visitor came from. (Not "no-referrer": that makes browsers send
  // "Origin: null" on this site's own forms, which the cross-site check then refuses.)
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env, work) {
    let response;
    try {
      response = await route(request, env, work);
    } catch (error) {
      // A newer version may have changed the database under this one (migrate.js): say so, rather than fail.
      if (!(await checkNewer(env))) throw error;
      response = beingUpdated(request);
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  // The daily run of automatic updates (auto.js), at the time set when they were turned on. Group Workers have none.
  // Then this site's checks of its friends' sites that are due (friendchecks.js).
  async scheduled(event, env, work) {
    if (env.GROUP_KEY) return;
    work.waitUntil(runAuto(env).then(async () => {
      const { on, origin } = await autoState(env.DB);
      // (On this computer a test can have every friend checked at once.)
      if (on && origin) await runFriendChecks(env, origin, { everyone: Boolean(env.ALLOW_LOCAL_SITES && env.TEST_CHECK_EVERYONE) });
    }).catch((error) => console.error("Daily run:", error.message)));
  },
};

/**
 * What an older version answers on a database a newer one has changed (migrate.js), while everyone's sent on to the
 * newer one: a page or a JSON error, and nothing written.
 */
function beingUpdated(request) {
  const message = "This site is being updated. Try again in a few minutes.";
  const headers = { "Retry-After": "120", "Cache-Control": "no-store" };
  if ((request.headers.get("Accept") ?? "").includes("text/html")) {
    return new Response(messagePage(message, { href: "/", label: "Try again" }), {
      status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return new Response(JSON.stringify({ error: message }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
}

async function route(request, env, work) {
  await ensureSchema(env);
  const url = new URL(request.url);
  // On a newer version's database, only which version this is, an update's own steps (they only use settings), and the
  // stylesheet and fonts for the page saying so.
  if (url.pathname !== "/_version" && !/^\/(_auto|static)\//.test(url.pathname) && await databaseIsNewer(env)) return beingUpdated(request);
  if (env.GROUP_KEY) return routeGroup(request, env, url);
  // Which uploaded version of the Worker is answering at this address: public, as it says nothing but an ID Cloudflare
  // made up. A friend's check (checks.js) compares it with what Cloudflare says, to be sure it read the right Worker.
  // With ?health=1, also a few typical reads: what an update waits for before it counts (auto.js). The migrations have
  // already run by now, as for every request.
  if (url.pathname === "/_version" && request.method === "GET") {
    const answer = url.searchParams.has("health") ? await health(env) : { id: env.VERSION?.id ?? null };
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  // The steps of an automatic update, asked for by the site's own daily run with a key only it has (auto.js).
  if (url.pathname.startsWith("/_auto/")) return handleAutoStep(request, env, url);
  if (url.pathname.startsWith("/_auth/")) return handleAuth(request, env, url);
  // A friend's Connect link, and their site's calls once connected, which carry a key instead of a session.
  if (url.pathname.startsWith("/_connect/")) return handleConnectLink(request, env, url);
  if (url.pathname.startsWith("/_peer/")) return handlePeer(request, env, url, work);
  // A group the owner's in, calling with the key this site gave it.
  if (url.pathname.startsWith("/_member/")) return handleMember(request, env, url, work);
  // A friend checking their site at this site's invitation (checks.js): they aren't signed in here.
  if (url.pathname.startsWith("/_check/")) return handleCheck(request, env, url);
  const reading = request.method === "GET" || request.method === "HEAD";
  const [, top, rest] = url.pathname.split("/");
  // The fonts are public, so the sign-in pages can use them too; they're open-licensed and say nothing about the site.
  if (reading && /^\/static\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) return serveStatic(request, env);
  // The home-screen app's manifest, icons and service worker are public too: phones fetch them without
  // the session, and they're the same for every site. The service worker may look after the whole site (scope "/").
  if (reading && /^\/static\/app\/(manifest\.webmanifest|icon-(180|192|512)\.png|push-sw\.js)$/.test(url.pathname)) {
    const file = await serveStatic(request, env);
    if (url.pathname === "/static/app/push-sw.js") file.headers.set("Service-Worker-Allowed", "/");
    return file;
  }
  const signed = await signedFile(request, env, url);
  if (signed) return signed;

  const user = await currentUser(request, env);
  if (!user) {
    if (!reading) return new Response("Not signed in", { status: 401 });
    return Response.redirect(`${url.origin}/_auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) return handleAdmin(request, env, url, user);
  // Connecting to Cloudflare, for updating and groups (an hour's token in a cookie; cloudflare.js).
  // Background access for automatic updates is a Connect of its own (auto.js).
  if (url.pathname.startsWith("/_cloudflare/auto-")) return (await handleAutoConnect(request, env, url)) ?? new Response("Not found", { status: 404 });
  // So is the read-only access friends' sites check this one with (friendchecks.js).
  if (url.pathname.startsWith("/_cloudflare/checks-")) return (await handleChecksConnect(request, env, url)) ?? new Response("Not found", { status: 404 });
  if (url.pathname.startsWith("/_cloudflare/")) return (await handleCloudflare(request, env, url)) ?? new Response("Not found", { status: 404 });
  if (url.pathname === "/_comments" || url.pathname.startsWith("/_comments/")) return handleComments(request, env, url, user);
  if (url.pathname === "/_live") return handleLive(request, env, url, user, work);
  if (url.pathname.startsWith("/_feed/")) return handleFeed(request, env, url);
  // This device saying yes or no to notifications about events (push.js).
  if (url.pathname.startsWith("/_push/")) return handlePush(request, env, url, user);
  if (url.pathname.startsWith("/_groups/")) return handleGroupActions(request, env, url);
  if (!reading) return new Response("Method not allowed", { status: 405 });

  if (top === "files" && HASH_RE.test(rest ?? "")) return serveFile(request, env, rest);
  if (top === "static") return serveStatic(request, env);
  return renderArchive(request, env, url, user, work);
}

// A photo or video a connected friend's site (or a group's member) was given a signed link to (share.js): no session
// needed until it expires, and only that one file. Null if the request isn't for one.
async function signedFile(request, env, url) {
  const [, top, rest] = url.pathname.split("/");
  if (!["GET", "HEAD"].includes(request.method) || top !== "files" || !HASH_RE.test(rest ?? "") || !url.searchParams.has("sig")) return null;
  const left = await signedFor(env, rest, url.searchParams);
  return left ? serveFile(request, env, rest, `private, max-age=${left}`) : new Response("This link has expired", { status: 403 });
}

// A group's own Worker: invite links, its members' sites, and its photos by signed link. Nothing else.
async function routeGroup(request, env, url) {
  if (url.pathname.startsWith("/_join/")) return handleJoinLink(request, env, url);
  if (url.pathname.startsWith("/_group/")) return handleGroupApi(request, env, url);
  const signed = await signedFile(request, env, url);
  if (signed) return signed;
  if (request.method === "GET" && /^\/static\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) return serveStatic(request, env);
  return html(messagePage("This is an afterwrd group. Its members open it from their own afterwrd sites.",
    { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
}

// A file's address is its contents' hash, so it can be cached for good (or, through a signed link, while it lasts).
async function serveFile(request, env, hash, cacheControl = "private, max-age=31536000, immutable") {
  const stored = await mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
    method: request.method,
    headers: ["Range", "If-None-Match"].filter((h) => request.headers.has(h)).map((h) => [h, request.headers.get(h)]),
  }));
  const response = new Response(stored.body, stored);
  if (stored.ok || stored.status === 304) response.headers.set("Cache-Control", cacheControl);
  return response;
}
