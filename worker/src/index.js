// Serves the site exported by `uv run heybert-export` (data/site) to people who have signed in with a passkey.
// Every request comes through here first (run_worker_first), so nothing is reachable without a session.
import { handleAdmin } from "./admin.js";
import { currentUser, handleAuth } from "./auth.js";

const FILE_DIRS = new Set(["static", "media", "thumbs"]);
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

  const path = assetPath(url);
  const isPage = path?.endsWith(".html");
  // Pages differ by viewer (the owner's have a People link), so they're always sent in full: answering "not
  // modified" could leave someone looking at a copy made for a different role.
  const headers = new Headers(request.headers);
  if (isPage) ["If-None-Match", "If-Modified-Since"].forEach((name) => headers.delete(name));
  const asset = path && (await env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: request.method, headers })));
  if (!asset || asset.status === 404) return new Response("Not found", { status: 404 });
  const response = await withRange(request, asset);
  if (isPage) {
    ["ETag", "Last-Modified"].forEach((name) => response.headers.delete(name));
    response.headers.set("Cache-Control", "private, no-cache");
    return user.is_owner ? withPeopleLink(response) : response;
  }
  response.headers.set("Cache-Control", "private, max-age=604800");
  response.headers.set("Accept-Ranges", "bytes");
  return response;
}

// The exported pages are the same for everyone, so the owner's link to /_admin is added on the way out.
function withPeopleLink(response) {
  response.headers.delete("Content-Length");
  return new HTMLRewriter()
    .on('header.site nav a[href="/_auth/logout"]', {
      element(signOut) {
        signOut.before('<a href="/_admin">People</a>', { html: true });
      },
    })
    .transform(response);
}

// Safari won't play a video unless it can fetch byte ranges, so answer them here if the asset store didn't.
async function withRange(request, asset) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
  if (!match || (!match[1] && !match[2]) || asset.status !== 200 || request.method !== "GET") {
    return new Response(asset.body, asset);
  }
  const body = await asset.arrayBuffer();
  const size = body.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });

  const headers = new Headers(asset.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(new Uint8Array(body, start, end - start + 1), { status: 206, headers });
}

// Mirrors page_file() in heybert/export.py: /posts?page=2 -> /posts/_q/page-2.html
function assetPath(url) {
  if (FILE_DIRS.has(url.pathname.split("/")[1])) return url.pathname;
  const base = url.pathname.replace(/^\/+|\/+$/g, "") || "index";
  const params = [...url.searchParams]
    .filter(([, value]) => value !== "")
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  if (!params.length) return `/${base}.html`;
  if (!params.every(([key, value]) => /^[\w-]+$/.test(key + value))) return null;
  return `/${base}/_q/${params.map(([key, value]) => `${key}-${value}`).join(",")}.html`;
}
