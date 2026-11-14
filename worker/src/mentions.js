// Mentions (docs/mentions-plan.md): @Ann Example in a post or comment tells Ann, and @here in a group tells everyone in
// it. A post or comment keeps who it mentions beside its words, as [{ name, origin }] (origin "here" for @here); only
// names in that list are shown as mentions, so words typed by hand ("@Ann") mention nobody. Between sites, a mention is
// an ActivityStreams Mention tag ({ type: "Mention", href: "<their site>/", name: "@Ann Example" }), and @here is
// "afterwrd:here": true. Whoever holds the post decides who's told: only people who can see it.
import { siteOrigin } from "./peers.js";

export const MAX_MENTIONS = 10;
export const HERE = "here";
const MAX_NAME = 100;

/** @typedef {{ name: string, origin: string }} Mention */

const WORD = /[A-Za-z0-9_]/;

/**
 * Whether `text` says @`name`, as a whole name (not the start of a longer one, nor part of an address like a@b). A plain
 * search, not a pattern built per name: a friend's site could send many names and long words, and this runs on each.
 */
function says(text, name) {
  const wanted = `@${name}`;
  for (let i = text.indexOf(wanted); i !== -1; i = text.indexOf(wanted, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + wanted.length] ?? "";
    if (!WORD.test(before) && before !== "@" && !WORD.test(after)) return true;
  }
  return false;
}

/**
 * The mentions a post or comment was sent with (`given`: from the browser, a list or its JSON), kept only where the
 * words say @name, to a real site (or @here, if `here`), and no more than MAX_MENTIONS. Never throws: anything else is
 * left out.
 * @param {unknown} given
 * @param {string} text
 * @param {any} env
 * @param {{ here?: boolean }} [options]
 * @returns {Mention[]}
 */
export function cleanMentions(given, text, env, { here = false } = {}) {
  let list = given;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  /** @type {Mention[]} */
  const kept = [];
  // A few more than can be kept, so a long list (from another site, say) costs nothing to turn down.
  for (const m of list.slice(0, MAX_MENTIONS * 2)) {
    const name = typeof m?.name === "string" ? m.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
    if (!name || !says(text, name)) continue;
    const origin = here && m.origin === HERE && name === HERE ? HERE : siteOrigin(m?.origin, env);
    if (!origin || kept.some((k) => k.origin === origin)) continue;
    kept.push({ name, origin });
    if (kept.length >= MAX_MENTIONS) break;
  }
  return kept;
}

/** A post or comment's mentions as they're kept (the mentions column), or null for none. */
export const keptMentions = (list) => (list.length ? JSON.stringify(list) : null);

/** What the mentions column holds, read back: [] for none or anything unexpected. */
export function readMentions(column) {
  if (!column) return [];
  try {
    const list = JSON.parse(column);
    return Array.isArray(list) ? list.filter((m) => typeof m?.name === "string" && typeof m?.origin === "string") : [];
  } catch {
    return [];
  }
}

/** Mentions as ActivityStreams tags, for a note to another site (@here goes as "afterwrd:here" instead). */
export const mentionTags = (list) => list.filter((m) => m.origin !== HERE)
  .map((m) => ({ type: "Mention", href: `${m.origin}/`, name: `@${m.name}` }));

/**
 * The mentions in a note from another site (`note.tag`'s Mention tags with a site address, and "afterwrd:here"), kept
 * only where its words say them, as cleanMentions does.
 * @param {any} note
 * @param {string} text the note's words, as kept
 * @param {any} env
 * @param {{ here?: boolean }} [options] whether @here counts (in a group)
 * @returns {Mention[]}
 */
export function noteMentions(note, text, env, { here = false } = {}) {
  const tags = Array.isArray(note?.tag) ? note.tag.slice(0, MAX_MENTIONS * 2 + 50) : []; // Facebook's tagged people too
  const given = tags.filter((t) => t?.type === "Mention" && typeof t.href === "string" && typeof t.name === "string")
    .map((t) => ({ name: t.name.replace(/^@/, ""), origin: t.href }));
  if (here && note?.["afterwrd:here"] === true) given.unshift({ name: HERE, origin: HERE });
  return cleanMentions(given, text, env, { here });
}
