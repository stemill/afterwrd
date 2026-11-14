// The look: the Dark / Light / Auto switch behind your picture, kept in this browser (nav.js LOOK applies it).

const looks = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="look"]'));
const showChoice = () => looks.forEach((r) => { r.checked = r.value === document.documentElement.dataset.lookChoice; });
showChoice();
looks.forEach((r) => r.addEventListener("change", () => {
  try { localStorage.setItem("afterwrd-look", r.value); } catch {}
  dispatchEvent(new Event("afterwrd-look"));
  // If this browser won't keep it (some private windows), show it for this page anyway.
  if (document.documentElement.dataset.lookChoice !== r.value) {
    const light = r.value === "light" || (r.value === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.look = light ? "light" : "dark";
    document.documentElement.dataset.lookChoice = r.value;
  }
}));
addEventListener("storage", (e) => { if (e.key === "afterwrd-look") showChoice(); });
