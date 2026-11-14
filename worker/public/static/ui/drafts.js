
// A box marked data-draft="<key>" (a comment, a post, an edit) keeps its words in this browser until
// they're sent, so losing signal, the app being closed, or a tap elsewhere doesn't lose them: they're back in the
// box next time. Kept for a week at most, and all gone on Sign out (this may be a shared phone or computer).
// Whatever sends them calls afterwrdSent(box) once the site has them: compose.js, and "in place" below.
const DRAFT = "afterwrd-draft:";
const WEEK = 7 * 24 * 3600 * 1000;
export const drafts = {
  get(key) { try { return JSON.parse(localStorage.getItem(DRAFT + key) || "null"); } catch { return null; } },
  keep(key, text) { try { localStorage.setItem(DRAFT + key, JSON.stringify({ text, at: Date.now() })); } catch {} },
  drop(key) { try { localStorage.removeItem(DRAFT + key); } catch {} },
  all() { try { return Object.keys(localStorage).filter((k) => k.startsWith(DRAFT)).map((k) => k.slice(DRAFT.length)); } catch { return []; } },
};
drafts.all().forEach((key) => { if (!(Date.now() - (drafts.get(key)?.at ?? 0) < WEEK)) drafts.drop(key); });
export const restoreDrafts = (within) => within.querySelectorAll("textarea[data-draft]").forEach((box) => {
  const kept = drafts.get(box.dataset.draft);
  // Only into a box that's as the page made it: never over words the browser itself has put back.
  if (typeof kept?.text === "string" && kept.text !== box.defaultValue && box.value === box.defaultValue) box.value = kept.text;
});
restoreDrafts(document);
document.addEventListener("input", (e) => {
  const box = /** @type {HTMLTextAreaElement} */ (e.target);
  if (!box.matches?.("textarea[data-draft]")) return;
  if (box.value.trim() && box.value !== box.defaultValue) drafts.keep(box.dataset.draft, box.value);
  else drafts.drop(box.dataset.draft);
});
window.afterwrdSent = (box) => { if (box?.dataset.draft) drafts.drop(box.dataset.draft); };
document.addEventListener("submit", (e) => {
  if (new URL(/** @type {HTMLFormElement} */ (e.target).action, location.href).pathname === "/_auth/logout") drafts.all().forEach(drafts.drop);
});
