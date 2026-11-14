// Asking first: a form or button with data-confirm="Delete this post?" (and data-confirm-ok="Delete" for the
// button's word) asks in afterwrd's own box before it's sent, in place of the browser's confirm(). Scripts can ask the
// same way: `if (!(await askFirst("Leave this group?", { ok: "Leave" }))) return;` (also window.askFirst, for the
// pages' own small scripts).

/** Asks `message` in afterwrd's own box; resolves true for `ok`, false for `cancel`, Escape or a tap outside. */
export function askFirst(message, { ok = "OK", cancel = "Cancel" } = {}) {
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
  const form = /** @type {HTMLFormElement} */ (e.target);
  const submitter = /** @type {HTMLButtonElement | null} */ (e.submitter);
  const by = submitter && submitter.form === form ? submitter : null;
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
