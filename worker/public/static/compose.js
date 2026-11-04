// The owner's composer on Home and Posts: text and up to 20 photos (prepared and uploaded by upload.js), then the post
// is saved (src/posts.js). In a group, the form says where it goes and how many photos it takes (src/groups.js).
import { call, picker, uploadPhotos } from "./upload.js";

const form = document.getElementById("composer");
const MAX_PHOTOS = Number(form.dataset.max) || 20;
const ACTION = form.dataset.action || "/_admin/posts";
const input = form.querySelector("input[type=file]");
const status = form.querySelector(".status");
const error = form.querySelector(".error");
const button = form.querySelector("button.post");
const picked = picker(input, form.querySelector(".picked"), {
  max: MAX_PHOTOS,
  onChange: (list) => { error.textContent = list.length > MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos in a post.` : ""; },
});

function busy(on) {
  button.disabled = on;
  form.text.readOnly = on;
  input.disabled = on;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = form.text.value.trim();
  if (!text && !picked.length) {
    form.text.focus();
    return;
  }
  if (picked.length > MAX_PHOTOS) return;
  busy(true);
  error.textContent = "";
  try {
    const photos = await uploadPhotos(picked.map((p) => p.file), (message) => { status.textContent = message; });
    status.textContent = "Posting…";
    await call(ACTION, { text, photos });
    location.href = location.pathname; // back to the page it was written on (Home or Posts), showing the new post
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    busy(false);
  }
});
