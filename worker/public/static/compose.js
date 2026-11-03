// The owner's composer on Posts: text and up to 20 photos (prepared and uploaded by upload.js), then the post is
// saved (src/posts.js).
import { call, picker, uploadPhotos } from "./upload.js";

const MAX_PHOTOS = 20;
const form = document.getElementById("composer");
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
    await call("/_admin/posts", { text, photos });
    location.href = "/posts";
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    busy(false);
  }
});
