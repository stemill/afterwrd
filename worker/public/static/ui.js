// Two things browsers do plainly, done in afterwrd's look, on every signed-in page (nav.js loads this):
//
//   - Asking first. A form or button with data-confirm="Delete this post?" (and data-confirm-ok="Delete" for the
//     button's word) asks in afterwrd's own box before it's sent, in place of the browser's confirm(). Scripts can ask
//     the same way: `if (!(await askFirst("Leave this group?", { ok: "Leave" }))) return;`
//   - Drop-downs you can type into. A <select data-search> becomes a box that narrows its list as you type; the
//     select itself stays (hidden) in the form, so what's sent, and any onchange, are as before.
(() => {
  // --- asking first --------------------------------------------------------------------------------------------
  function askFirst(message, { ok = "OK", cancel = "Cancel" } = {}) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "ask";
      dialog.setAttribute("aria-label", "Are you sure?");
      const words = document.createElement("p");
      words.textContent = message;
      const row = document.createElement("div");
      row.className = "ask-buttons";
      const no = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: cancel });
      const yes = Object.assign(document.createElement("button"), { type: "button", className: "chip danger", textContent: ok });
      row.append(no, yes);
      dialog.append(words, row);
      document.body.append(dialog);
      let answered = false;
      const done = (answer) => {
        if (answered) return;
        answered = true;
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      no.addEventListener("click", () => done(false));
      yes.addEventListener("click", () => done(true));
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); done(false); }); // Escape
      dialog.addEventListener("click", (e) => { if (e.target === dialog) done(false); }); // a tap outside the box
      dialog.showModal();
      no.focus(); // the safe choice is the one ready to press
    });
  }
  window.askFirst = askFirst;

  // Before any form is sent (in the capture phase, so ahead of the page's own handlers): ask, then send it again,
  // through the same button (which may have its own formaction), if they said yes.
  document.addEventListener("submit", (e) => {
    const form = e.target;
    const by = e.submitter && e.submitter.form === form ? e.submitter : null;
    const message = by?.dataset.confirm || form.dataset.confirm;
    if (!message || form.dataset.asked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    askFirst(message, { ok: by?.dataset.confirmOk || form.dataset.confirmOk || "OK" }).then((yes) => {
      if (!yes) return;
      // On the next turn: a browser ignores sending a form again while it's still handling the first try.
      setTimeout(() => {
        form.dataset.asked = "1";
        try { form.requestSubmit(by ?? undefined); } finally { delete form.dataset.asked; }
      });
    });
  }, true);

  // --- drop-downs you can type into ------------------------------------------------------------------------------
  let made = 0;
  function searchable(select) {
    const id = `picker-${++made}`;
    const box = Object.assign(document.createElement("span"), { className: "picker" });
    const input = Object.assign(document.createElement("input"), {
      type: "text", className: "picker-input", autocomplete: "off", spellcheck: false,
      placeholder: select.dataset.search || "Type to search",
    });
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-label", select.getAttribute("aria-label") || select.closest("label")?.textContent.trim() || "Choose");
    const list = Object.assign(document.createElement("ul"), { id, className: "picker-list", hidden: true });
    list.setAttribute("role", "listbox");
    box.append(input, list);
    select.hidden = true;
    select.after(box);

    const options = [...select.options].filter((o) => !o.disabled);
    const label = () => select.selectedOptions[0]?.textContent.trim() ?? "";
    input.value = label();
    let shown = [];
    let active = -1;

    function show(filter) {
      const words = filter.trim().toLowerCase();
      shown = options.filter((o) => !words || o.textContent.toLowerCase().includes(words));
      list.replaceChildren(...shown.map((o, i) => {
        const li = Object.assign(document.createElement("li"), { id: `${id}-${i}`, textContent: o.textContent.trim() });
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(o.selected));
        li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(o); }); // before the box loses focus
        return li;
      }));
      if (!shown.length) list.append(Object.assign(document.createElement("li"), { className: "picker-none", textContent: "Nothing matches" }));
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      move(shown.length ? Math.max(0, shown.findIndex((o) => o.selected)) : -1);
    }
    function hide() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function move(to) {
      active = to;
      [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
      const li = list.children[active];
      if (li && li.id) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    }
    function pick(option) {
      const changed = select.value !== option.value;
      select.value = option.value;
      input.value = label();
      hide();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    input.addEventListener("focus", () => { input.select(); show(""); });
    // Clicked again after choosing (still focused, so no focus event): open afresh, ready to type over.
    input.addEventListener("click", () => { if (list.hidden) { input.select(); show(""); } });
    input.addEventListener("input", () => show(input.value));
    input.addEventListener("blur", () => { hide(); input.value = label(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) show("");
        else if (shown.length) move((active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
      } else if (e.key === "Enter") {
        e.preventDefault(); // choosing, not sending the form
        if (!list.hidden && shown[active]) pick(shown[active]);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault();
        hide();
        input.value = label();
      }
    });
  }
  document.querySelectorAll("select[data-search]").forEach(searchable);
})();
