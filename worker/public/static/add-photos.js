// The Add photos page (src/photos.js): photos into a new or existing album, optionally shared as a post, or one
// photo as the profile picture or cover.
import { call, picker, uploadPhotos } from "./upload.js";

const form = document.getElementById("add");
const role = form.dataset.role || null;
const max = Number(form.dataset.max);
const input = form.querySelector("input[type=file]");
const status = form.querySelector(".status");
const error = form.querySelector(".error");
const button = form.querySelector("button.post");
const picked = picker(input, form.querySelector(".picked"), {
  max,
  onChange: (list) => { error.textContent = list.length > max ? `Up to ${max} photos at a time.` : ""; },
});

// The new album's name and description only matter when "New album…" is chosen.
const albums = form.querySelector("select[name=album]");
const albumName = form.querySelector("input[name=name]"); // not form.name: that's the form's own name
const fresh = form.querySelector(".new-album");
const showFresh = () => { if (fresh) fresh.hidden = albums.value !== "new"; };
albums?.addEventListener("change", showFresh);
showFresh();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  if (!picked.length) { error.textContent = role ? "Choose a photo first." : "Choose some photos first."; return; }
  if (picked.length > max) return;
  if (albums?.value === "new" && !albumName.value.trim()) { error.textContent = "Give the new album a name."; albumName.focus(); return; }
  button.disabled = true;
  try {
    const photos = await uploadPhotos(picked.map((p) => p.file), (message) => { status.textContent = message; });
    status.textContent = "Saving…";
    const { href } = await call("/_admin/photos", {
      album: albums?.value, name: albumName?.value, description: form.querySelector("textarea[name=description]")?.value,
      text: form.text.value, share: form.share.checked, role, photos,
    });
    location.href = href;
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    button.disabled = false;
  }
});
