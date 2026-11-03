// Serves the archive to people who have signed in with a passkey: pages are built from D1, photos and videos
// come from the media store (/files/<sha256>), and the stylesheet and import scripts from public/static.
// Everything the owner imports arrives through /_admin/import. Every request comes through here first
// (run_worker_first), so nothing is reachable without a session.
import { handleAdmin } from "./admin.js";
import { renderArchive } from "./archive/routes.js";
import { currentUser, handleAuth } from "./auth.js";
import { HASH_RE, mediaStore } from "./media.js";
import { ensureSchema } from "./migrate.js";

export { MediaStore } from "./media.js";
const HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

async function route(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  if (url.pathname.startsWith("/_auth/")) return handleAuth(request, env, url);

  const reading = request.method === "GET" || request.method === "HEAD";
  const user = await currentUser(request, env);
  if (!user) {
    if (!reading) return new Response("Not signed in", { status: 401 });
    return Response.redirect(`${url.origin}/_auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) {
    return user.is_owner ? handleAdmin(request, env, url, user) : new Response("Not found", { status: 404 });
  }
  if (!reading) return new Response("Method not allowed", { status: 405 });

  const [, top, rest] = url.pathname.split("/");
  if (top === "files" && HASH_RE.test(rest ?? "")) return serveFile(request, env, rest);
  if (top === "static") {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return new Response("Not found", { status: 404 });
    const response = new Response(asset.body, asset);
    response.headers.set("Cache-Control", "private, no-cache");
    return response;
  }
  return renderArchive(request, env, url, user);
}

// A file's address is its contents' hash, so it can be cached for good.
async function serveFile(request, env, hash) {
  const stored = await mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
    method: request.method,
    headers: ["Range", "If-None-Match"].filter((h) => request.headers.has(h)).map((h) => [h, request.headers.get(h)]),
  }));
  const response = new Response(stored.body, stored);
  if (stored.ok || stored.status === 304) response.headers.set("Cache-Control", "private, max-age=31536000, immutable");
  return response;
}
