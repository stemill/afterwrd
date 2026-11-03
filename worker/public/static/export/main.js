// Download everything (src/export.js): reads every table a page at a time, turns it into ActivityStreams
// documents (../activity.js), and writes them and every photo and video into a zip, straight to a file where
// the browser allows it (Chrome, Edge) and in memory otherwise.
/* global zip */
import {
  actorId, commentAuthor, commentId, commentNote, CONTEXT, iso, mediaObject, postId, postKey, targetId, tidy,
} from "../activity.js";

const SITE_POSTS_FROM = 1_000_000_000; // posts written on afterwrd (src/posts.js)
const EXTENSIONS = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};
const TABLES = ["settings", "people", "albums", "posts", "post_tags", "comments", "reactions", "media", "tagged_photos",
  "site_comments", "comments_elsewhere", "connections", "users"];

const form = document.getElementById("export");
const status = document.getElementById("status");
const error = document.getElementById("error");
const button = document.getElementById("go");
const site = location.origin;

async function rows(table) {
  const all = [];
  let after = 0;
  do {
    const response = await fetch(`/_admin/export/rows?table=${table}&after=${after}`);
    if (!response.ok) throw new Error(`Couldn't read ${table} (the site said ${response.status}).`);
    const page = await response.json();
    all.push(...page.rows);
    after = page.next;
  } while (after);
  return all;
}

const unique = (media) => [...new Map(media.filter((m) => m.hash).map((m) => [m.hash, m])).values()];
const fileFor = (m) => `media/${m.hash}${EXTENSIONS[m.type] ?? ""}`;
const megabytes = (n) => `${(n / 1e6).toLocaleString("en-GB", { maximumFractionDigits: n < 1e7 ? 1 : 0 })} MB`;

// Sizes for the label, and a note where the download has to fit in memory.
let media = [];
rows("media").then((list) => {
  media = list;
  const files = unique(list);
  if (files.length) {
    document.getElementById("size").textContent = `(${files.length.toLocaleString("en-GB")} files, ${megabytes(files.reduce((n, m) => n + (m.size ?? 0), 0))})`;
  }
}).catch(() => {});
if (!window.showSaveFilePicker) document.getElementById("memory").hidden = false;

/** Every document in the download, keyed by its name in the zip. */
function documents(t) {
  const owner = t.users.find((u) => u.is_owner) ?? { name: "Owner" };
  const me = t.people.find((p) => p.is_me);
  const people = new Map(t.people.map((p) => [p.id, p]));
  const users = new Map(t.users.map((u) => [u.id, u]));
  const byHash = new Map(t.media.filter((m) => m.hash).map((m) => [m.hash, m]));
  const media = (m) => mediaObject(site, m, { "afterwrd:file": fileFor(m) });
  const person = (id) => (people.get(id) ? { type: "Person", name: people.get(id).name } : undefined);
  const link = (url) => (url ? { type: "Link", href: url } : undefined);
  const picture = (key, fallbackId) => {
    const chosen = t.settings.find((s) => s.key === key)?.value;
    const m = (chosen && byHash.get(chosen)) || t.media.find((x) => x.id === fallbackId && x.hash);
    return m ? media(m) : undefined;
  };

  // Comments written on this site, by what they're on.
  const threads = new Map();
  for (const c of t.site_comments) {
    const user = users.get(c.author_id);
    const row = { ...c, name: user?.name ?? c.author_name, author_is_owner: user?.is_owner ?? 0 };
    if (!threads.has(c.target)) threads.set(c.target, []);
    threads.get(c.target).push(commentNote(site, row, commentAuthor(site, row)));
  }
  const replies = (target) => {
    const items = threads.get(target);
    return items?.length ? { type: "Collection", totalItems: items.length, items } : undefined;
  };
  const collection = (items, extra = {}) => ({ "@context": CONTEXT, type: "OrderedCollection", totalItems: items.length, ...extra, orderedItems: items });
  const newest = (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0);

  const postIds = new Map();
  const posts = [...t.posts].sort(newest).map((p) => {
    const key = postKey(p);
    postIds.set(p.id, postId(site, key));
    return {
      type: "Note",
      id: postId(site, key),
      attributedTo: actorId(site),
      published: iso(p.timestamp),
      summary: p.title || undefined,
      mediaType: "text/plain",
      content: p.text ?? "",
      attachment: [...t.media.filter((m) => m.post_id === p.id && m.hash).map(media), link(p.link_url)].filter(Boolean),
      tag: t.post_tags.some((x) => x.post_id === p.id)
        ? t.post_tags.filter((x) => x.post_id === p.id).map((x) => ({ type: "Mention", name: people.get(x.person_id)?.name })) : undefined,
      location: p.place_name || p.latitude != null
        ? { type: "Place", name: p.place_name || undefined, "afterwrd:address": p.place_address || undefined,
          latitude: p.latitude ?? undefined, longitude: p.longitude ?? undefined } : undefined,
      context: p.group_name ? { type: "Group", name: p.group_name } : undefined,
      "afterwrd:kind": p.kind,
      "afterwrd:onWallOf": person(p.target_id),
      "afterwrd:source": p.id >= SITE_POSTS_FROM ? "afterwrd" : "facebook",
      "afterwrd:facebookId": p.fbid || undefined,
      replies: replies(key),
    };
  });

  const albums = new Map(t.albums.map((a) => [a.id, a]));
  const photos = [...t.media].filter((m) => m.hash).sort(newest).map((m) => ({
    ...media(m),
    "afterwrd:album": albums.get(m.album_id)?.name,
    "afterwrd:postedWith": postIds.get(m.post_id),
    replies: replies(`photo-${m.hash}`),
  }));

  return {
    "profile.json": {
      "@context": CONTEXT,
      type: "Person",
      id: actorId(site),
      url: actorId(site),
      name: owner.name,
      "afterwrd:facebookName": me?.name,
      // The picture and cover chosen on afterwrd, or else Facebook's.
      icon: picture("profile_hash", me?.profile_media_id),
      image: picture("cover_hash", me?.cover_media_id),
      "afterwrd:sections": JSON.parse(t.settings.find((s) => s.key === "sections")?.value ?? "[]"),
    },
    "posts.json": collection(posts, { name: "Posts" }),
    "photos.json": collection(photos, { name: "Photos and videos" }),
    "albums.json": collection(t.albums.map((a) => ({
      type: "Collection",
      name: a.name,
      summary: a.description || undefined,
      updated: iso(a.last_modified),
      "afterwrd:cover": a.cover_media_id && t.media.find((m) => m.id === a.cover_media_id)?.hash
        ? `${site}/photos/sha256/${t.media.find((m) => m.id === a.cover_media_id).hash}` : undefined,
      items: t.media.filter((m) => m.album_id === a.id && m.hash).map((m) => `${site}/photos/sha256/${m.hash}`),
    })), { name: "Albums" }),
    "facebook-comments.json": collection([...t.comments].sort(newest).map((c) => ({
      type: "Note",
      attributedTo: c.author_id && c.author_id !== me?.id ? person(c.author_id) : actorId(site),
      published: iso(c.timestamp),
      summary: c.title || undefined,
      mediaType: "text/plain",
      content: c.text ?? undefined,
      attachment: [...t.media.filter((m) => m.comment_id === c.id && m.hash).map(media), link(c.link_url)].filter(Boolean),
      context: c.group_name ? { type: "Group", name: c.group_name } : undefined,
      "afterwrd:action": c.action,
      // Facebook's download doesn't say which post a comment was on; this is what it does say.
      "afterwrd:on": c.target_kind || c.target_owner_id
        ? { type: "Object", "afterwrd:kind": c.target_kind || undefined, attributedTo: person(c.target_owner_id) } : undefined,
    })), { name: "Your comments on Facebook" }),
    "facebook-likes.json": collection([...t.reactions].sort(newest).map((r) => ({
      type: "Like",
      actor: actorId(site),
      published: iso(r.timestamp),
      summary: r.title || undefined,
      object: r.url || { type: "Object", "afterwrd:kind": r.target_kind || undefined, attributedTo: person(r.target_owner_id) },
      context: r.group_name ? { type: "Group", name: r.group_name } : undefined,
      "afterwrd:reaction": r.reaction,
      "afterwrd:facebookId": r.fbid || undefined,
    })), { name: "Your likes and reactions on Facebook" }),
    "facebook-tagged.json": collection([...t.tagged_photos].sort(newest).map((x) => ({
      type: "Image", url: x.url || undefined, published: iso(x.timestamp), attributedTo: person(x.owner_id),
      "afterwrd:facebookId": x.fbid || undefined,
    })), { name: "Photos you're tagged in on Facebook" }),
    "facebook-people.json": collection(t.people.filter((p) => !p.is_me).map((p) => ({
      type: "Person", name: p.name, "afterwrd:friendSince": iso(p.friend_since), "afterwrd:unfriendedAt": iso(p.unfriended_at),
    })), { name: "People from your Facebook download" }),
    "connections.json": collection(t.connections.map((c) => ({
      type: "Person", id: actorId(c.origin), url: actorId(c.origin), name: c.name, "afterwrd:connectedAt": iso(c.connected_at),
    })), { name: "Friends' afterwrd sites you're connected with" }),
    "comments-elsewhere.json": collection([...t.comments_elsewhere].filter((c) => c.site).sort((a, b) => b.created_at - a.created_at)
      .map((c) => ({
        type: "Note",
        id: commentId(c.site, c.target, c.remote_id),
        attributedTo: actorId(site),
        inReplyTo: targetId(c.site, c.target),
        published: iso(c.created_at),
        mediaType: "text/plain",
        content: c.text,
      })), { name: "Your comments on friends' sites (the originals are kept there)" }),
  };
}

const README = (host, when, withMedia) => `afterwrd download of ${host}, made ${when}

Everything on the site, as ActivityStreams 2.0 JSON (https://www.w3.org/TR/activitystreams-core/), the format the
fediverse uses. afterwrd's own extra terms start "afterwrd:" (https://afterwrd.app/ns#).

  profile.json               who the site belongs to
  posts.json                 posts, from Facebook and written on afterwrd, each with the comments made on the site
  photos.json                every photo and video, with comments made on the site
  albums.json                albums, listing their photos by address
  comments-elsewhere.json    comments you've written on friends' afterwrd sites (the originals live there)
  connections.json           friends' afterwrd sites you're connected with
  facebook-comments.json     your comments on Facebook
  facebook-likes.json        your likes and reactions on Facebook
  facebook-tagged.json       photos of you on Facebook (links only: Facebook doesn't include the images)
  facebook-people.json       people named in your Facebook download
${withMedia ? "  media/                     every photo and video, named by its SHA-256 fingerprint\n" : ""}
Addresses. Everything has a permanent address on the site it belongs to:
  the site's owner     https://<site>/
  a post               https://<site>/posts/<post key>
  a photo or video     https://<site>/photos/sha256/<fingerprint>   (the file itself: https://<site>/files/<fingerprint>)
  a comment            <the post's or photo's address>#c<number>
A comment you wrote on a friend's post has the same address in your download (comments-elsewhere.json) as in
theirs (in the post's "replies"), and its "inReplyTo" is the address of their post. So two friends' downloads
can be matched up, and your conversations put back together, by address alone.

Facebook's own download doesn't say which post a comment or like was on, only whose it was and what kind
("afterwrd:on"), and when. Those keep what Facebook gave.

Photos: "afterwrd:file" is where each one is in media/ here. Text is plain, not HTML ("mediaType": "text/plain").
`;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const withMedia = form.media.checked;
  const host = location.host;
  const date = new Date().toISOString().slice(0, 10);
  const name = `afterwrd-${host.replace(/[^\w.-]/g, "-")}-${date}`;
  error.textContent = "";
  // Ask where to save first, while the click still counts as the person's own.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: `${name}.zip`, types: [{ description: "Zip file", accept: { "application/zip": [".zip"] } }] });
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  button.disabled = true;
  try {
    status.textContent = "Reading the site…";
    const t = {};
    for (const table of TABLES) t[table] = await rows(table);
    media = t.media;

    zip.configure({ useWebWorkers: false });
    const writer = new zip.ZipWriter(handle ? await handle.createWritable() : new zip.BlobWriter("application/zip"));
    await writer.add(`${name}/README.txt`, new zip.TextReader(README(host, new Date().toLocaleString("en-GB"), withMedia)));
    for (const [file, doc] of Object.entries(documents(t))) {
      await writer.add(`${name}/${file}`, new zip.TextReader(JSON.stringify(tidy(doc), null, 2)));
    }
    if (withMedia) {
      const files = unique(t.media);
      for (const [i, m] of files.entries()) {
        status.textContent = `Adding photos and videos: ${i + 1} of ${files.length}…`;
        const response = await fetch(`/files/${m.hash}`);
        if (!response.ok) throw new Error(`Couldn't fetch a photo (the site said ${response.status}).`);
        await writer.add(`${name}/${fileFor(m)}`, new zip.BlobReader(await response.blob()), { level: 0 });
      }
    }
    status.textContent = "Finishing…";
    const result = await writer.close();
    if (!handle) {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(result), download: `${name}.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    status.textContent = "Done. Your download is saved.";
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
  } finally {
    button.disabled = false;
  }
});
