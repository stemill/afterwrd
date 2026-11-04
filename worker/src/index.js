// Serves the archive to people who have signed in with a passkey: pages are built from D1, photos and videos
// come from the media store (/files/<sha256>), and the stylesheet and import scripts from public/static.
// Everything the owner imports arrives through /_admin/import, and comments through /_comments. Every request
// comes through here first (run_worker_first), so nothing is reachable without a session, apart from sign-in, a
// Connect link, and connected friends' sites, which carry a key (connect.js, peers.js).
import { handleAdmin } from "./admin.js";
import { handleComments } from "./archive/comments.js";
import { renderArchive } from "./archive/routes.js";
import { currentUser, handleAuth } from "./auth.js";
import { handleConnectLink } from "./connect.js";
import { handleFeed } from "./feed.js";
import { HASH_RE, mediaStore } from "./media.js";
import { ensureSchema } from "./migrate.js";
import { handlePeer } from "./peers.js";
import { signedFor } from "./share.js";
import { handleLive } from "./live.js";

export { MediaStore } from "./media.js";
const HEADERS = {
  // No framing, plugins, <base> tricks or forms posting elsewhere. (Scripts aren't restricted: the pages use
  // small inline scripts, and everything interpolated into a page is escaped.)
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  // Other sites never learn where a visitor came from. (Not "no-referrer": that makes browsers send
  // "Origin: null" on this site's own forms, which the cross-site check then refuses.)
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env, work) {
    const response = await route(request, env, work);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

async function route(request, env, work) {
  await ensureSchema(env);
  const url = new URL(request.url);
  if (url.pathname.startsWith("/_auth/")) return handleAuth(request, env, url);
  // A friend's Connect link, and their site's calls once connected, which carry a key instead of a session.
  if (url.pathname.startsWith("/_connect/")) return handleConnectLink(request, env, url);
  if (url.pathname.startsWith("/_peer/")) return handlePeer(request, env, url, work);
  const reading = request.method === "GET" || request.method === "HEAD";
  const [, top, rest] = url.pathname.split("/");
  // The fonts are public, so the sign-in pages can use them too; they're open-licensed and say nothing about the site.
  if (reading && /^\/static\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) return serveStatic(request, env);
  // A photo or video a connected friend's site was given a signed link to (share.js): no session needed until it
  // expires, and only that one file.
  if (reading && top === "files" && HASH_RE.test(rest ?? "") && url.searchParams.has("sig")) {
    const left = await signedFor(env, rest, url.searchParams);
    return left ? serveFile(request, env, rest, `private, max-age=${left}`) : new Response("This link has expired", { status: 403 });
  }

  const user = await currentUser(request, env);
  if (!user) {
    if (!reading) return new Response("Not signed in", { status: 401 });
    return Response.redirect(`${url.origin}/_auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) {
    return user.is_owner ? handleAdmin(request, env, url, user, work) : new Response("Not found", { status: 404 });
  }
  if (url.pathname === "/_comments" || url.pathname.startsWith("/_comments/")) return handleComments(request, env, url, user, work);
  if (url.pathname === "/_live") return handleLive(request, env, url, user);
  if (url.pathname.startsWith("/_feed/")) {
    return user.is_owner ? handleFeed(request, env, url) : new Response("Not found", { status: 404 });
  }
  if (!reading) return new Response("Method not allowed", { status: 405 });

  if (top === "files" && HASH_RE.test(rest ?? "")) return serveFile(request, env, rest);
  if (top === "static") return serveStatic(request, env);
  return renderArchive(request, env, url, user, work);
}

async function serveStatic(request, env) {
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return new Response("Not found", { status: 404 });
  const response = new Response(asset.body, asset);
  response.headers.set("Cache-Control", "private, no-cache");
  return response;
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
