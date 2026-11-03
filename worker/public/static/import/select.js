// Picks what to publish from an imported archive: only what the chosen sections show. With the default
// (posts, photos), comments come along only when a photo is attached to them, likes and the friends list stay
// on the owner's computer, and people appear by name only where a post or photo mentions them.
import { MAX_FILE } from "./schema.js";

export const SECTIONS = ["overview", "timeline", "posts", "photos", "comments", "likes", "friends"];
export const DEFAULT_SECTIONS = ["posts", "photos"];

/** `sizeOf(media)` gives a file's size in bytes, or null if it's missing. */
export function select(tables, sections, sizeOf) {
  const on = (...names) => names.some((s) => sections.includes(s));
  const withMedia = (key) => new Set(tables.media.map((m) => m[key]));

  // Without their own sections, posts and comments come along only to caption photos on the photo pages.
  const allPosts = on("posts", "timeline", "overview", "friends");
  const allComments = on("comments", "timeline", "overview", "friends");
  const postsWithMedia = withMedia("post_id");
  const commentsWithMedia = withMedia("comment_id");
  let posts = allPosts ? tables.posts : on("photos") ? tables.posts.filter((p) => postsWithMedia.has(p.id)) : [];
  let comments = allComments ? tables.comments
    : on("photos") ? tables.comments.filter((c) => commentsWithMedia.has(c.id)) : [];
  const reactions = on("likes", "timeline", "overview", "friends") ? tables.reactions : [];
  const tagged = on("photos", "overview", "friends") ? tables.tagged_photos : [];
  const albums = on("photos", "overview") ? tables.albums : [];
  const me = tables.people.find((p) => p.is_me);

  let postIds = new Set(posts.map((p) => p.id));
  let commentIds = new Set(comments.map((c) => c.id));
  const profileIds = on("overview") ? [me.profile_media_id, me.cover_media_id] : [];
  const tooBig = [];
  const media = tables.media.filter((m) => {
    const wanted = on("photos") || postIds.has(m.post_id) || commentIds.has(m.comment_id) || profileIds.includes(m.id);
    if (!wanted) return false;
    const size = sizeOf(m) ?? 0;
    if (size > MAX_FILE) tooBig.push([m.path, size]);
    return size > 0 && size <= MAX_FILE;
  });
  const mediaIds = new Set(media.map((m) => m.id));

  // A caption whose photos were all left out (missing or too big) has nothing to caption.
  if (!allPosts) posts = posts.filter((p) => media.some((m) => m.post_id === p.id));
  if (!allComments) comments = comments.filter((c) => media.some((m) => m.comment_id === c.id));
  postIds = new Set(posts.map((p) => p.id));
  commentIds = new Set(comments.map((c) => c.id));
  const postTags = tables.post_tags.filter((t) => postIds.has(t.post_id));

  // Everyone, with friendship dates, only if the friends section is published; otherwise just the people the
  // published rows name, without them.
  const named = new Set([me.id, ...posts.map((p) => p.target_id), ...postTags.map((t) => t.person_id),
    ...comments.flatMap((c) => [c.target_owner_id, c.author_id]), ...reactions.map((r) => r.target_owner_id),
    ...tagged.map((t) => t.owner_id)]);
  const people = tables.people
    .filter((p) => on("friends") || named.has(p.id))
    .map((p) => ({
      ...p,
      friend_since: on("friends") ? p.friend_since : null,
      unfriended_at: on("friends") ? p.unfriended_at : null,
      profile_media_id: mediaIds.has(p.profile_media_id) ? p.profile_media_id : null,
      cover_media_id: mediaIds.has(p.cover_media_id) ? p.cover_media_id : null,
    }));

  return {
    tables: { people, albums, posts, post_tags: postTags, comments, reactions, media, tagged_photos: tagged },
    tooBig,
  };
}
