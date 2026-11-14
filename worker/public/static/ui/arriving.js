import { pointedAt } from "./menus.js";

// A page opened at something (#c12, from Notifications say) shows it just below the site's header, however tall
// the header is on this screen (two rows on a phone), and keeps it there while pictures load, until you scroll.
const header = /** @type {HTMLElement | null} */ (document.querySelector("header.site"));
const fitHeader = () => { if (header) document.documentElement.style.scrollPaddingTop = `${header.offsetHeight + 12}px`; };
fitHeader();
addEventListener("resize", fitHeader);
const target = pointedAt();
if (target && !target.matches("div.edit") && /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.("navigation")[0])?.type === "navigate") {
  let touched = false; // once you scroll yourself, the page is yours
  ["wheel", "touchstart", "keydown", "mousedown"].forEach((type) => addEventListener(type, () => { touched = true; }, { once: true, passive: true }));
  const put = () => { if (!touched) target.scrollIntoView({ block: "start" }); };
  // Once every script has had its say (the Add to home screen note can appear above), and again when pictures
  // have loaded.
  document.addEventListener("DOMContentLoaded", put, { once: true });
  addEventListener("load", put, { once: true });
}
