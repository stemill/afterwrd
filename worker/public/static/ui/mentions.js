// Mentions (src/mentions.js): typing @ in a post or comment box offers people to mention, narrowing as you type.
// Picking one writes @Their Name and notes who that is in the form's "mentions" field, since two people can share a
// name. Who's offered: in a group, its members (and @here, if you may use it); on a friend's post, its writer and those
// who've already commented there (all its site will tell); on your own, your friends and anyone already on it. Whoever
// holds the post decides who's actually told: only people who can see it. Without this script,
// @ is just a character, and nobody is told.
const BOXES = "form.say textarea[name=text], #composer textarea[name=text]";
const SHOWN = 6;

const read = (id) => {
  try { return JSON.parse(document.getElementById(id)?.textContent ?? "null"); } catch { return null; }
};
/** @type {{ name: string, origin: string }[]} */
const friends = read("mention-people") ?? [];
/** @type {{ people: { name: string, origin: string }[], here: boolean } | null} */
const group = read("mention-group");

/** Everyone who can be mentioned from `box`, the owner here left out. */
function candidates(box) {
  const form = box.form;
  const who = (el) => ({ name: el.dataset.name ?? "", origin: el.dataset.who ?? "", note: "" });
  // On a friend's post or photo: its writer, and those who've commented there already. Their site tells no one else.
  if (form?.dataset.ownerWho) {
    const thread = form.closest(".thread") ?? form;
    const there = [.../** @type {NodeListOf<HTMLElement>} */ (thread.querySelectorAll(".comment[data-who]"))].map(who);
    const seen = new Set([location.origin]);
    return [{ name: form.dataset.ownerName ?? "", origin: form.dataset.ownerWho, note: "" }, ...there]
      .filter((p) => p.name && p.origin && !seen.has(p.origin) && seen.add(p.origin));
  }
  const near = box.closest("[data-region], article, .info, main") ?? document.body;
  const shown = [.../** @type {NodeListOf<HTMLElement>} */ (near.querySelectorAll("[data-who]"))].map(who);
  const list = group
    ? [...(group.here ? [{ name: "here", origin: "here", note: "everyone in the group" }] : []), ...group.people.map((p) => ({ ...p, note: "" })), ...shown]
    : [...shown, ...friends.map((p) => ({ ...p, note: "" }))];
  const seen = new Set([location.origin]);
  return list.filter((p) => p.name && p.origin && !seen.has(p.origin) && seen.add(p.origin));
}

/** The @words being typed just before the cursor, if any: where the @ is, and what follows it. */
function typing(box) {
  if (box.selectionStart !== box.selectionEnd) return null;
  const before = box.value.slice(0, box.selectionStart);
  const m = /(^|[\s(])@([^@\n]{0,40})$/u.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

const matches = (person, query) => {
  const name = person.name.toLowerCase();
  return !query || name.startsWith(query) || name.split(/\s+/).some((word) => word.startsWith(query));
};

const list = Object.assign(document.createElement("ul"), { id: "mention-list", className: "picker-list mention-list", hidden: true });
list.setAttribute("role", "listbox");
list.setAttribute("aria-label", "People to mention");
document.body.append(list);
/** @type {HTMLTextAreaElement | null} the box the list is showing for */
let current = null;
let shown = [];
let active = 0;

function hide() {
  list.hidden = true;
  if (current) {
    current.setAttribute("aria-expanded", "false");
    current.removeAttribute("aria-activedescendant");
  }
  current = null;
}

function move(to) {
  active = to;
  [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
  if (current && list.children[active]) current.setAttribute("aria-activedescendant", list.children[active].id);
}

function show(box) {
  const at = typing(box);
  shown = at ? candidates(box).filter((p) => matches(p, at.query)).slice(0, SHOWN) : [];
  if (!shown.length) { hide(); return; }
  current = box;
  box.setAttribute("aria-autocomplete", "list");
  box.setAttribute("aria-controls", list.id);
  box.setAttribute("aria-expanded", "true");
  list.replaceChildren(...shown.map((p, i) => {
    const li = Object.assign(document.createElement("li"), { id: `mention-${i}`, textContent: `@${p.name}` });
    if (p.note) li.append(Object.assign(document.createElement("span"), { className: "meta", textContent: ` ${p.note}` }));
    li.setAttribute("role", "option");
    li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(box, p); }); // before the box loses focus
    return li;
  }));
  const r = box.getBoundingClientRect();
  Object.assign(list.style, { left: `${r.left + scrollX}px`, top: `${r.bottom + scrollY + 6}px`, width: `${Math.max(Math.min(r.width, 340), 220)}px` });
  list.hidden = false;
  move(0);
}

/** Writes @name in place of what's being typed, and notes who it is in the form's mentions field. */
function pick(box, person) {
  const at = typing(box);
  if (!at) return;
  const end = box.selectionStart;
  const words = `@${person.name} `;
  box.value = box.value.slice(0, at.start) + words + box.value.slice(end);
  box.setSelectionRange(at.start + words.length, at.start + words.length);
  const form = box.form;
  let field = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name=mentions]"));
  if (!field) {
    field = Object.assign(document.createElement("input"), { type: "hidden", name: "mentions", value: "[]" });
    form.append(field);
  }
  let kept = [];
  try { kept = JSON.parse(field.value); } catch {}
  if (!kept.some((m) => m.origin === person.origin)) kept.push({ name: person.name, origin: person.origin });
  field.value = JSON.stringify(kept);
  hide();
  box.dispatchEvent(new Event("input", { bubbles: true })); // kept as a draft (drafts.js), like anything typed
}

document.addEventListener("input", (e) => {
  const box = /** @type {HTMLTextAreaElement} */ (e.target);
  if (box.matches?.(BOXES)) show(box);
});
document.addEventListener("keydown", (e) => {
  if (!current || e.target !== current || list.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move((active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
  } else if ((e.key === "Enter" || e.key === "Tab") && shown[active]) {
    e.preventDefault(); // choosing, not sending the form
    pick(current, shown[active]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    hide();
  }
});
document.addEventListener("focusout", (e) => { if (e.target === current) hide(); });
addEventListener("resize", hide);
