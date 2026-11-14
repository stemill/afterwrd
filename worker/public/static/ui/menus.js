// The small V menus (Edit, Delete) on posts and comments: one open at a time, closed by a tap elsewhere, a choice, or
// Escape. Edit opens the words (the page's #target) with the cursor at the end, ready to change.

const openMenus = () => /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll("details.more[open]"));
document.addEventListener("toggle", (e) => {
  const menu = /** @type {HTMLDetailsElement} */ (e.target);
  if (!menu.matches?.("details.more") || !menu.open) return;
  openMenus().forEach((d) => { if (d !== menu) d.open = false; });
}, true);
document.addEventListener("click", (e) => {
  // After the click has done its work (a Delete's form is on its way to being asked about), so it isn't lost.
  const tapped = /** @type {Element} */ (e.target);
  const choice = tapped.closest("details.more .menu a, details.more .menu button");
  setTimeout(() => openMenus().forEach((d) => { if (choice ? d.contains(choice) : !d.contains(tapped)) d.open = false; }));
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  openMenus().forEach((d) => { d.open = false; /** @type {HTMLElement} */ (d.querySelector("summary")).focus(); });
});
/** What the address points at (#c12), if anything; nothing for a mangled address (a stray "%"). */
export const pointedAt = () => {
  try {
    return location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  } catch {
    return null;
  }
};
function editing() {
  const box = pointedAt();
  const words = box?.matches("div.edit") ? box.querySelector("textarea") : null;
  if (!words) return;
  words.focus({ preventScroll: true });
  words.setSelectionRange(words.value.length, words.value.length);
}
window.addEventListener("hashchange", editing);
editing();
