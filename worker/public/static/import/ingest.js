// Reads a Facebook "Download your information" export (JSON format) into the archive's tables.
// A port of afterwrd/ingest.py that runs in the browser, and in Node for tests: same rules, same order, so the
// rows match. `source` reads the export's files (see sources.js). Photos aren't opened here; their sizes and
// thumbnails are worked out while uploading.
import { ARCHIVE, emptyRow } from "./schema.js";

const TARGET_KINDS = "life event|post|photo|comment|reel|link|album|note|event|video|status";

// "Ste Millington commented on Jo Bloggs's photo." / "... replied to his own comment."
// / "... liked a post." / "... commented on St Mary's School's link in Some Group."
const ACTION_RE = new RegExp(
  "^(?<actor>.+?) (?<verb>commented on|replied to|liked|reacted to) "
    + "(?:(?<own>his|her|their) own |an? |(?<owner>.+?)'s? )"
    + `(?<kind>${TARGET_KINDS})(?: in (?<group>.+?))?\\.$`,
);
const WALL_RE = / wrote on (?<owner>.+?)'s? (?:profile|timeline)\.$/;
const GROUP_POST_RE = / posted in (?<group>.+?)\.$/;

const REACTIONS = {
  LIKE: "Like", LOVE: "Love", HAHA: "Haha", WOW: "Wow", SORRY: "Sad", SAD: "Sad", ANGER: "Angry", ANGRY: "Angry",
  SUPPORT: "Care", CARE: "Care",
};
export const VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const POSTS = "your_facebook_activity/posts";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Undo Facebook's mojibake: UTF-8 bytes are written out as Latin-1 code points. */
export function fixText(value) {
  if (typeof value === "string") {
    if (/[^\x00-\xff]/.test(value)) return value;
    try {
      return UTF8.decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(fixText);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixText(v)]));
  }
  return value;
}

function reactionName(raw) {
  if (!raw) return "Like";
  return REACTIONS[raw.toUpperCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function exif(media) {
  const meta = media.media_metadata || {};
  const merged = {};
  for (const kind of ["photo_metadata", "video_metadata"]) {
    for (const entry of (meta[kind] || {}).exif_data ?? []) Object.assign(merged, entry);
  }
  return merged;
}

/** Flatten the newer "label_values" format into {label: value}. */
function labelValues(entry) {
  const out = {};
  for (const lv of entry.label_values ?? []) {
    if ("label" in lv) out[lv.label] = lv.value || lv.timestamp_value || null;
    else if (lv.title) {
      for (const d of lv.dict ?? []) {
        for (const inner of d.dict ?? []) {
          if (inner.label === "Name") out[lv.title] = inner.value ?? null;
        }
      }
    }
  }
  return out;
}

/** Like Python's Path.suffix: '.jpg' for 'a/b.jpg', '' for 'a/b' or 'a/.hidden'. */
export function suffix(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

function kindFromUrl(url) {
  if (url.includes("comment_id=")) return "comment";
  if (url.includes("/reel/")) return "reel";
  if (url.includes("/videos/") || url.includes("/watch")) return "video";
  if (url.includes("photo")) return "photo";
  return "post";
}

/** 'a/./b/../c' -> 'a/c'; null if it climbs out of the export. */
function normalise(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export async function ingest(source, { log = () => {} } = {}) {
  const tables = Object.fromEntries(Object.keys(ARCHIVE).map((t) => [t, []]));
  const people = new Map();
  const mediaByPath = new Map();
  const tagsSeen = new Set();
  const unparsed = new Map();

  function insert(table, fields) {
    const row = { ...emptyRow(table), ...fields };
    if ("id" in row) row.id = tables[table].length + 1;
    tables[table].push(row);
    return row;
  }

  function person(name, fields = {}) {
    if (!name) return null;
    if (!people.has(name)) people.set(name, insert("people", { name }));
    return Object.assign(people.get(name), fields).id;
  }

  async function load(rel) {
    if (!source.has(rel)) {
      log(`(missing ${rel}, skipping)`);
      return null;
    }
    return fixText(JSON.parse(await source.text(rel)));
  }

  async function isVideo(path) {
    const ext = suffix(path);
    if (ext) return VIDEO_SUFFIXES.has(ext.toLowerCase());
    const head = await source.head(path, 12); // some videos come without an extension; MP4/MOV have "ftyp" at byte 4
    return String.fromCharCode(...head.slice(4, 8)) === "ftyp";
  }

  async function media(m, links = {}) {
    const uri = m.uri || "";
    const file = uri && normalise(uri);
    if (!file || !source.has(file)) return null;

    const existing = mediaByPath.get(uri);
    if (existing) {
      for (const [col, value] of [...Object.entries(links), ["description", m.description || null]]) {
        existing[col] ??= value;
      }
      return existing.id;
    }
    const meta = exif(m);
    const row = insert("media", {
      path: uri,
      kind: (await isVideo(file)) ? "video" : "photo",
      timestamp: m.creation_timestamp || null,
      taken_at: meta.taken_timestamp || null,
      description: m.description || null,
      latitude: meta.latitude ?? null,
      longitude: meta.longitude ?? null,
      ...links,
    });
    row.file = file; // for the uploader; not a column
    mediaByPath.set(uri, row);
    return row.id;
  }

  function parseAction(title, actorFallback) {
    const m = ACTION_RE.exec(title);
    if (!m) {
      unparsed.set(title, (unparsed.get(title) ?? 0) + 1);
      return [actorFallback, null, null, null, null];
    }
    const g = m.groups;
    return [g.actor, g.verb, (g.own ? g.actor : g.owner) ?? null, g.kind, g.group ?? null];
  }

  // --- the import, in afterwrd/ingest.py's order ------------------------------

  const profile = await load("personal_information/profile_information/profile_information.json");
  if (!profile) throw new Error("This doesn't look like a Facebook export: it has no profile information.");
  const me = profile.profile_v2.name.full_name;
  person(me, { is_me: 1 });

  // friends
  for (const f of (await load("connections/friends/your_friends.json") ?? {}).friends_v2 ?? []) {
    person(f.name, { friend_since: f.timestamp });
  }
  for (const f of (await load("connections/friends/removed_friends.json") ?? {}).deleted_friends_v2 ?? []) {
    person(f.name, { unfriended_at: f.timestamp });
  }

  // albums
  const albumFiles = source.files
    .filter((f) => f.startsWith(`${POSTS}/album/`) && !f.slice(POSTS.length + 7).includes("/") && f.endsWith(".json"))
    .map((f) => {
      const stem = f.slice(f.lastIndexOf("/") + 1, -5);
      return [/^\d+$/.test(stem) ? Number(stem) : 0, f];
    })
    .sort(([a, x], [b, y]) => a - b || (x < y ? -1 : 1))
    .map(([, f]) => f);
  for (const path of albumFiles) {
    const album = await load(path);
    if (!album || !album.photos?.length) continue;
    const row = insert("albums", {
      name: album.name || "Untitled album",
      description: album.description || null,
      last_modified: album.last_modified_timestamp ?? null,
    });
    const photoIds = new Map();
    for (const photo of album.photos) photoIds.set(photo.uri, await media(photo, { album_id: row.id }));
    // Some exports point the cover at a generic "?" placeholder; use the first photo instead.
    const coverUri = (album.cover_photo || {}).uri;
    row.cover_media_id = photoIds.get(coverUri) || photoIds.values().next().value || null;
  }

  // loose media
  for (const m of (await load(`${POSTS}/your_uncategorized_photos.json`) ?? {}).other_photos_v2 ?? []) await media(m);
  for (const m of (await load(`${POSTS}/your_videos.json`) ?? {}).videos_v2 ?? []) await media(m);

  // posts
  const wallFbids = new Map();
  for (const e of await load(`${POSTS}/posts_on_other_pages_and_profiles.json`) ?? []) {
    wallFbids.set(e.timestamp, e.fbid ?? null);
  }
  const postFiles = source.files
    .filter((f) => f.startsWith(`${POSTS}/your_posts__check_ins__photos_and_videos`) && f.endsWith(".json")
      && !f.slice(POSTS.length + 1).includes("/"))
    .sort();
  for (const path of postFiles) {
    for (const p of await load(path) ?? []) await post(p, wallFbids.get(p.timestamp) ?? null);
  }
  for (const p of (await load("your_facebook_activity/groups/group_posts_and_comments.json") ?? {}).group_posts_v2 ?? []) {
    await post(p);
  }

  async function post(p, fbid = null) {
    const title = p.title || "";
    const text = (p.data ?? []).find((d) => d.post)?.post ?? null;
    const attached = [];
    let link = null;
    let place = null;
    for (const attachment of p.attachments ?? []) {
      for (const d of attachment.data ?? []) {
        if ("media" in d) attached.push(d.media);
        link = link || (d.external_context || {}).url || null;
        place = place || d.place || null;
      }
    }

    let kind;
    let targetId = null;
    let group = null;
    let m;
    if ((m = WALL_RE.exec(title))) [kind, targetId] = ["wall", person(m.groups.owner)];
    else if ((m = GROUP_POST_RE.exec(title))) [kind, group] = ["group", m.groups.group];
    else if (title.includes("recommend")) kind = "review";
    else if (attached.length) {
      const videos = attached.every((x) => VIDEO_SUFFIXES.has(suffix(x.uri ?? "").toLowerCase())
        || (x.uri ?? "").includes("/videos/"));
      kind = videos ? "video" : "photo";
    } else if (link) kind = "link";
    else if (place) kind = "checkin";
    else if (title.includes(" shared ")) kind = "shared";
    else kind = "status";

    place = place || {};
    const coords = place.coordinate || {};
    const row = insert("posts", {
      timestamp: p.timestamp,
      kind,
      title: title || null,
      text,
      target_id: targetId,
      group_name: group,
      link_url: link,
      place_name: place.name ?? null,
      place_address: place.address ?? null,
      latitude: coords.latitude ?? null,
      longitude: coords.longitude ?? null,
      fbid,
    });
    for (const tag of p.tags ?? []) {
      const personId = person(tag.name);
      const key = `${row.id}:${personId}`;
      if (personId === null || tagsSeen.has(key)) continue; // INSERT OR IGNORE
      tagsSeen.add(key);
      tables.post_tags.push({ post_id: row.id, person_id: personId });
    }
    for (const x of attached) await media(x, { post_id: row.id });
  }

  // comments
  const commentEntries = [
    ...(await load("your_facebook_activity/comments_and_reactions/comments.json") ?? {}).comments_v2 ?? [],
    ...(await load("your_facebook_activity/groups/your_comments_in_groups.json") ?? {}).group_comments_v2 ?? [],
  ];
  const commentsSeen = new Set();
  for (const c of commentEntries) {
    const title = c.title || "";
    const data = (c.data ?? []).find((d) => "comment" in d)?.comment ?? {};
    const key = JSON.stringify([c.timestamp, title, data.comment ?? null]);
    if (commentsSeen.has(key)) continue;
    commentsSeen.add(key);

    const [actor, verb, owner, kind, group] = parseAction(title, me);
    const attached = [];
    let link = null;
    for (const attachment of c.attachments ?? []) {
      for (const d of attachment.data ?? []) {
        if ("media" in d) attached.push(d.media);
        link = link || (d.external_context || {}).url || null;
      }
    }
    const authorId = person(data.author || actor);
    const row = insert("comments", {
      timestamp: data.timestamp || c.timestamp,
      author_id: authorId,
      action: verb === "replied to" ? "replied" : "commented",
      target_owner_id: person(owner),
      target_kind: kind,
      group_name: data.group || group || null,
      text: data.comment || null,
      link_url: link,
      title: title || null,
    });
    for (const x of attached) await media(x, { comment_id: row.id });
  }

  // reactions: likes_and_reactions.json has URLs but only covers recent years; likes_and_reactions_N.json has
  // summary lines going back to the start. They overlap heavily, so pair them up by timestamp.
  const rich = [];
  const titled = [];
  const reactionFiles = source.files
    .filter((f) => /^your_facebook_activity\/comments_and_reactions\/likes_and_reactions[^/]*\.json$/.test(f))
    .sort();
  for (const path of reactionFiles) {
    for (const e of await load(path) ?? []) ("label_values" in e ? rich : titled).push(e);
  }
  const richByTs = new Map();
  for (const e of rich) {
    const v = labelValues(e);
    const url = v.URL || null;
    if (!richByTs.has(e.timestamp)) richByTs.set(e.timestamp, []);
    richByTs.get(e.timestamp).push({
      reaction: v.Reaction ?? null,
      owner: v.Owner || v.Author || v.Name || null,
      group: v.Group ?? null,
      url,
      fbid: e.fbid ?? null,
      kind: kindFromUrl(url || ""),
    });
  }
  const reactionsSeen = new Set();
  for (const e of titled) {
    const title = e.title || "";
    const key = JSON.stringify([e.timestamp, title]);
    if (reactionsSeen.has(key)) continue;
    reactionsSeen.add(key);
    const raw = (e.data ?? []).find((d) => "reaction" in d)?.reaction ?? {};
    const [, , owner, kind, group] = parseAction(title, me);

    const candidates = richByTs.get(e.timestamp) ?? [];
    const match = candidates.find((c) => c.owner === owner) ?? candidates[0] ?? null;
    if (match) candidates.splice(candidates.indexOf(match), 1);
    const found = match ?? {};
    insert("reactions", {
      timestamp: e.timestamp,
      reaction: reactionName(raw.reaction || found.reaction),
      target_owner_id: person(owner || found.owner),
      target_kind: kind || found.kind || null,
      group_name: group || found.group || null,
      url: found.url ?? null,
      fbid: found.fbid ?? null,
      title: title || null,
    });
  }
  for (const [ts, leftovers] of richByTs) {
    for (const r of leftovers) {
      insert("reactions", {
        timestamp: ts,
        reaction: reactionName(r.reaction),
        target_owner_id: person(r.owner),
        target_kind: r.kind,
        group_name: r.group,
        url: r.url,
        fbid: r.fbid,
        title: null,
      });
    }
  }

  // photos and videos other people have tagged me in: links, not images
  const taggedRel = "your_facebook_activity/activity_you're_tagged_in/photos_and_videos_you're_tagged_in.json";
  for (const e of await load(taggedRel) ?? []) {
    const v = labelValues(e);
    insert("tagged_photos", { timestamp: e.timestamp, owner_id: person(v.Name), url: v.URL ?? null, fbid: e.fbid ?? null });
  }

  // My current profile picture and cover photo. The profile update history records each profile picture
  // change, so the latest one is current. Cover photo changes usually aren't recorded, so fall back to the
  // newest upload in the "Cover photos" album.
  const latest = {};
  const history = await load("personal_information/profile_information/profile_update_history.json") ?? {};
  const updates = [...history.profile_updates_v2 ?? []].sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of updates) {
    const title = (entry.title || "").toLowerCase();
    const field = title.includes("profile picture") ? "profile_media_id" : title.includes("cover photo") ? "cover_media_id" : null;
    const uri = (entry.attachments ?? []).flatMap((a) => a.data ?? []).find((d) => "media" in d)?.media.uri;
    if (field && uri) latest[field] = mediaByPath.get(uri)?.id ?? latest[field] ?? null;
  }
  if (!("cover_media_id" in latest)) {
    const coverAlbums = new Set(tables.albums.filter((a) => a.name === "Cover photos").map((a) => a.id));
    // ORDER BY timestamp DESC, id DESC, with SQLite's NULLs-last for DESC
    const newest = tables.media.filter((x) => coverAlbums.has(x.album_id))
      .sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || b.id - a.id)[0];
    if (newest) latest.cover_media_id = newest.id;
  }
  if (Object.keys(latest).length) person(me, latest);

  return { tables, me, unparsed };
}
