// The owner's composer on Home and Posts: text and up to 20 photos (prepared and uploaded by upload.js), and perhaps a
// poll (the text is its question; src/polls.js), then the post is saved (src/posts.js). In a group, the form says where
// it goes and how many photos it takes (src/groups.js).
import { call, picker, uploadPhotos } from "./upload.js";

const form = document.getElementById("composer");
const MAX_PHOTOS = Number(form.dataset.max) || 20;
const MAX_OPTIONS = 10;
const ACTION = form.dataset.action || "/_admin/posts";
const input = form.querySelector("input[type=file]");
const status = form.querySelector(".status");
const error = form.querySelector(".error");
const button = form.querySelector("button.post");
const picked = picker(input, form.querySelector(".picked"), {
  max: MAX_PHOTOS,
  onChange: (list) => { error.textContent = list.length > MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos in a post.` : ""; },
});

// The poll: hidden until asked for.
const poll = form.querySelector(".poll-maker");
const addPoll = form.querySelector(".add-poll");
const options = poll.querySelector(".poll-options");
const addOption = poll.querySelector(".add-option");
const closes = poll.querySelector("input[name=closes]");
const placeholder = form.text.placeholder;
const pad = (n) => String(n).padStart(2, "0");
const today = new Date();
closes.min = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

function showPoll(on) {
  poll.hidden = !on;
  addPoll.hidden = on;
  form.text.placeholder = on ? "Ask a question" : placeholder;
  if (on) (form.text.value.trim() ? options.querySelector("input") : form.text).focus();
  else addPoll.focus();
}
addPoll.addEventListener("click", () => showPoll(true));
poll.querySelector(".remove-poll").addEventListener("click", () => showPoll(false));
addOption.addEventListener("click", () => {
  const n = options.children.length + 1;
  if (n > MAX_OPTIONS) return;
  const item = document.createElement("li");
  const box = Object.assign(document.createElement("input"), { name: "option", maxLength: 100, placeholder: `Option ${n}` });
  box.setAttribute("aria-label", `Option ${n}`);
  item.append(box);
  options.append(item);
  box.focus();
  addOption.hidden = n >= MAX_OPTIONS;
});

/** The poll to send, or null; throws with a message if it isn't ready. */
function readPoll(text) {
  if (poll.hidden) return null;
  if (!text) throw new Error("Write the question your poll asks.");
  const list = [...options.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  if (list.length < 2) throw new Error("Give your poll at least two options.");
  // A closing day ends at midnight, wherever the person asking is.
  const day = closes.value ? new Date(`${closes.value}T23:59:59`) : null;
  if (day && !(day > new Date())) throw new Error("Pick a closing day that hasn't gone yet.");
  return { options: list, multiple: poll.querySelector("input[name=multiple]").checked, closes_at: day ? Math.floor(day / 1000) : null };
}

function busy(on) {
  button.disabled = on;
  form.text.readOnly = on;
  input.disabled = on;
  poll.disabled = on;
  addPoll.disabled = on;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = form.text.value.trim();
  if (!text && !picked.length && poll.hidden) {
    form.text.focus();
    return;
  }
  if (picked.length > MAX_PHOTOS) return;
  let question;
  try {
    question = readPoll(text);
  } catch (err) {
    error.textContent = err.message;
    return;
  }
  busy(true);
  error.textContent = "";
  try {
    const photos = await uploadPhotos(picked.map((p) => p.file), (message) => { status.textContent = message; });
    status.textContent = "Posting…";
    await call(ACTION, { text, photos, ...(question && { poll: question }) });
    location.href = location.pathname; // back to the page it was written on (Home or Posts), showing the new post
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    busy(false);
  }
});
