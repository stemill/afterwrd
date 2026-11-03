// What a hostile friend's site might send, through the real parsing code.
// The real friends.js and feed.js, bundled by run.sh (with a stand-in for Cloudflare's runtime) into $OUT/bundle.mjs.
import { pathToFileURL } from "node:url";
const { cleanFeed, markMine, parseMedia } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
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
process.exit(failed ? 1 : 0);
