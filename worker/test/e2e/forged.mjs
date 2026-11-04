// What a hostile friend's site might send, through the real parsing code.
// The real friends.js and feed.js, bundled by run.sh (with a stand-in for Cloudflare's runtime) into $OUT/bundle.mjs.
import { pathToFileURL } from "node:url";
const { callSite, cleanFeed, markMine, markMineInGroup, parseGroupPage, parseMedia, siteOrigin } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
const B = "https://bob.example";
const A = "https://ann.example";
const hash = "a".repeat(64);
let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const media = (fetch) => ({ type: "Image", url: `${B}/files/${hash}`, "afterwrd:fetch": fetch, width: 10, height: 10 });

check("a proper signed link is accepted", parseMedia(media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}`), B)?.src.endsWith("x".repeat(43)));
check("a link with styling tacked on is refused", parseMedia(media(`${B}/files/${hash}?exp=1'); position:fixed; inset:0; background:url('https://evil.example/x.png`), B) === null);
check("a link with anything after the signature is refused", parseMedia(media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}&x=')`), B) === null);
check("a link to another site is refused", parseMedia(media(`https://evil.example/files/${hash}?exp=1&sig=${"x".repeat(43)}`), B) === null);

const note = (replies) => ({ "@context": [], attributedTo: { name: "Bob" }, orderedItems: [{ type: "Note", id: `${B}/posts/post-1700000000-0b918c1b`,
  published: "2026-11-03T10:00:00Z", content: "Hi", replies: { items: replies } }] });
const reply = (n, author, content) => ({ type: "Note", id: `${B}/posts/post-1700000000-0b918c1b#c${n}`, attributedTo: author,
  published: "2026-11-03T10:01:00Z", content });
const feed = cleanFeed(note([reply(1, { type: "Person", id: "https://[", name: "Broken" }, "x"),
  reply(2, { type: "Person", id: `${A}/`, name: "Ann" }, "words Ann never wrote"),
  reply(3, { type: "Person", id: `${A}/`, name: "Ann" }, "forged text on Ann's real comment"),
  reply(4, { type: "Person", name: "Bob's visitor" }, "hello")]), B);
check("a malformed site address on a comment doesn't break the Feed", feed.posts[0].comments.find((c) => c.id === 1)?.from === null);

// Ann's site sent comment 3 (and remembers what it said); comment 2 claims to be Ann's but she never sent it.
const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ remote_id: 3, text: "What Ann actually wrote" }] }) }) }) };
const shown = await markMine(db, 1, "post-1700000000-0b918c1b", feed.posts[0].comments, A);
check("a comment falsely claiming to be Ann's is left out", !shown.some((c) => c.id === 2));
check("Ann's real comment shows the words her site kept", shown.find((c) => c.id === 3)?.text === "What Ann actually wrote" && shown.find((c) => c.id === 3).mine);
check("other people's comments still show, not as Ann's", shown.find((c) => c.id === 4)?.mine === false);

// A group's site (Bob's, group 7) as seen from Ann's: what it sends about the group, its posts and their comments.
const group = { type: "Group", id: `${B}/groups/7`, name: "Walkers", attributedTo: { type: "Person", id: `${B}/`, name: "Bob" }, "afterwrd:members": 3 };
const groupNote = (id, author, extra = {}) => ({ type: "Note", id, attributedTo: author, published: "2026-11-03T10:00:00Z", content: "Hi", ...extra });
const someone = { type: "Person", id: "https://cat.example/", name: "Cat" };
let threw = false;
try { parseGroupPage({ context: { ...group, id: `${B}/groups/8` }, orderedItems: [] }, B, 7); } catch { threw = true; }
check("a group's site answering for a different group is refused", threw);
const page = parseGroupPage({ context: group, orderedItems: [
  groupNote(`${B}/groups/7/posts/1`, someone),
  groupNote(`https://evil.example/groups/7/posts/2`, someone),
  groupNote(`${B}/groups/8/posts/3`, someone),
  groupNote(`${B}/groups/7/posts/4`, { type: "Person", id: someone.id, name: "x".repeat(101) }),
  groupNote(`${B}/groups/7/posts/5`, someone, { attachment: [media(`https://evil.example/files/${hash}?exp=1&sig=${"x".repeat(43)}`),
    media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}`)] }),
  groupNote(`${B}/groups/7/posts/6`, { type: "Person", id: `${A}/`, name: "Ann" }, { attachment: [media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}`)],
    replies: { items: [
      groupNote(`${B}/groups/7/posts/6#c1`, { type: "Person", id: `${A}/`, name: "Ann" }),
      groupNote(`${B}/groups/7/posts/6#c2`, { type: "Person", id: `${A}/`, name: "Ann" }),
      groupNote(`${B}/groups/7/posts/5#c3`, someone),
    ] } }),
  // Ann's real comment 9 was on post 6; the group shows it under post 1 instead.
  groupNote(`${B}/groups/7/posts/1`, someone, { replies: { items: [groupNote(`${B}/groups/7/posts/1#c9`, { type: "Person", id: `${A}/`, name: "Ann" })] } }),
] }, B, 7);
check("only posts in that group, on that site, by someone named sensibly, are read", page.posts.map((p) => p.id).join() === "1,5,6,1");
check("only the group's own photo links are kept", page.posts.find((p) => p.id === 5).photos.length === 1);
check("a comment addressed to another post is dropped", page.posts.find((p) => p.id === 6).comments.map((c) => c.id).join() === "1,2");
// Ann's site sent post 6 and comment 1 there; the group's site claims comment 2 is hers too.
const sent = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
  { kind: "post", post_id: 6, remote_id: 6, text: "What Ann posted", photos: "[]", created_at: 1700000000 },
  { kind: "comment", post_id: 6, remote_id: 1, text: "What Ann said", created_at: 1700000001 },
  { kind: "comment", post_id: 6, remote_id: 9, text: "Yes, count me in", created_at: 1700000002 }] }) }) }) };
const marked = await markMineInGroup(sent, { origin: B, remote_id: 7 }, page.posts, A);
const annPost = marked.find((p) => p.id === 6);
check("Ann's post and comment show the words her site kept", annPost?.mine && annPost.text === "What Ann posted"
  && annPost.comments.find((c) => c.id === 1)?.text === "What Ann said");
check("a comment falsely claiming to be Ann's is left out", annPost && !annPost.comments.some((c) => c.id === 2));
check("other people's posts aren't marked as Ann's", marked.filter((p) => p.id !== 6).every((p) => !p.mine));
check("…nor a photo the group added to Ann's post, nor its date", annPost?.photos.length === 0 && annPost.created_at === 1700000000);
check("Ann's comment moved under another post isn't shown as hers", marked.filter((p) => p.id === 1).every((p) => !p.comments.some((c) => c.id === 9)));
check("an address with a trailing dot isn't taken as a site", siteOrigin("https://ann.example./") === null && siteOrigin("https://ann.example/") === A);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("null", { status: 200 });
check("a site answering null counts as saying nothing", JSON.stringify(await callSite(B, "/x")) === "{}");
globalThis.fetch = async () => new Response("[1]", { status: 500 });
check("…and an error answer that isn't an object doesn't crash", await callSite(B, "/x").then(() => false, (e) => /answered 500/.test(e.message)));
globalThis.fetch = realFetch;
process.exit(failed ? 1 : 0);
