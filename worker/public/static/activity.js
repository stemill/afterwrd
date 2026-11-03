// The ActivityStreams 2.0 shapes afterwrd speaks, shared by the Worker (what connected sites send each other,
// src/peers.js) and the browser (Download everything, export/main.js). Everything has a permanent address on
// the site it belongs to, so two sites, or two people's downloads, agree on what replied to what:
//   the owner          <site>/                        Person
//   a post             <site>/posts/<post key>        Note; the key survives re-imports (postKey)
//   a photo or video   <site>/photos/sha256/<hash>    Image or Video; the file itself is <site>/files/<hash>
//   a comment          <post or photo address>#c<n>   Note, inReplyTo the post or photo
// Text is plain (mediaType text/plain), not HTML. afterwrd's own extra terms are under https://afterwrd.app/ns#.

export const CONTEXT = ["https://www.w3.org/ns/activitystreams", { afterwrd: "https://afterwrd.app/ns#" }];

// FNV-1a: not for security, just to tell apart posts made in the same second.
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A post's name for comments and links: its time and a fingerprint of what it says, as ids change on re-import. */
export const postKey = (p) =>
  `post-${p.timestamp}-${fingerprint([p.kind, p.title, p.text, p.link_url, p.group_name].map((v) => v ?? "").join("\0"))}`;

export const POST_KEY_RE = /^post-\d+-[0-9a-f]{8}$/;

export const iso = (ts) => (Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString().replace(".000Z", "Z") : undefined);
export const seconds = (text) => {
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
};

export const actorId = (site) => `${site}/`;
export const postId = (site, key) => `${site}/posts/${key}`;
export const mediaId = (site, hash) => `${site}/photos/sha256/${hash}`;
export const fileUrl = (site, hash) => `${site}/files/${hash}`;
/** A comment target ("post-…" or "photo-<hash>", as stored with comments) as an address. */
export const targetId = (site, target) => (target.startsWith("photo-") ? mediaId(site, target.slice(6)) : postId(site, target));
export const commentId = (site, target, n) => `${targetId(site, target)}#c${n}`;

/** A photo or video row (media) as an Image or Video. */
export function mediaObject(site, m, extra = {}) {
  return {
    type: m.kind === "video" ? "Video" : "Image",
    id: mediaId(site, m.hash),
    url: fileUrl(site, m.hash),
    mediaType: m.type ?? undefined,
    width: m.width ?? undefined,
    height: m.height ?? undefined,
    preview: m.thumb_hash ? { type: "Image", url: fileUrl(site, m.thumb_hash), mediaType: "image/jpeg" } : undefined,
    name: m.description || undefined,
    published: iso(m.timestamp),
    "afterwrd:takenAt": m.taken_at && m.taken_at !== m.timestamp ? iso(m.taken_at) : undefined,
    location: m.latitude != null && m.longitude != null ? { type: "Place", latitude: m.latitude, longitude: m.longitude } : undefined,
    ...extra,
  };
}

/**
 * A comment written on a site (a site_comments row) as a Note. `author` is who wrote it: the owner's address, a
 * connected friend's site, or just a name for someone invited to look.
 */
export function commentNote(site, c, author) {
  return {
    type: "Note",
    id: commentId(site, c.target, c.id),
    attributedTo: author,
    inReplyTo: targetId(site, c.target),
    published: iso(c.created_at),
    mediaType: "text/plain",
    content: c.text,
  };
}

/** Who wrote a site comment, given the site's owner and the comment's row (with name and author_is_owner). */
export function commentAuthor(site, c) {
  if (c.author_is_owner) return actorId(site);
  if (c.origin && c.origin !== "site") return { type: "Person", id: actorId(c.origin), name: c.name };
  return { type: "Person", name: c.name };
}

/** Drops undefined fields, so documents stay tidy. */
export function tidy(value) {
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, tidy(v)]));
  }
  return value;
}
