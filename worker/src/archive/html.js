// A tagged template for HTML: every interpolated value is escaped unless it's already HTML (another html``
// result or raw()), arrays are joined, and null/undefined/false render as nothing.
import { escape } from "../util.js";

class Html {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

export const raw = (text) => new Html(String(text));

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new Html(out);
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}
