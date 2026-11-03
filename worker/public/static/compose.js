// The owner's composer on Posts. Each photo is redrawn here as a JPEG of at most 2560px a side, which also drops
// what phones hide inside photos (where it was taken, the device), plus a thumbnail. Both are uploaded by their
// SHA-256 through the import's file endpoints, and the post is saved once they're all stored (src/posts.js).
const MAX_SIDE = 2560;
const THUMB_BOX = [900, 600]; // as the import's thumbnails
const MAX_PHOTOS = 20;

const form = document.getElementById("composer");
const input = form.querySelector("input[type=file]");
const list = form.querySelector(".picked");
const status = form.querySelector(".status");
const error = form.querySelector(".error");
const button = form.querySelector("button.post");
const picked = []; // { file, url }

input.addEventListener("change", () => {
  for (const file of input.files) picked.push({ file, url: URL.createObjectURL(file) });
  input.value = "";
  error.textContent = picked.length > MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos in a post.` : "";
  show();
});

function show() {
  list.hidden = !picked.length;
  list.replaceChildren(...picked.map((p, i) => {
    const item = document.createElement("li");
    const img = document.createElement("img");
    img.src = p.url;
    img.alt = "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${p.file.name}`);
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(p.url);
      picked.splice(i, 1);
      error.textContent = "";
      show();
    });
    item.append(img, remove);
    return item;
  }));
}

async function jpeg(bitmap, [boxWidth, boxHeight], quality) {
  const scale = Math.min(boxWidth / bitmap.width, boxHeight / bitmap.height, 1);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality }), width: canvas.width, height: canvas.height };
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(path, body, { method = "POST", type = "application/json" } = {}) {
  const response = await fetch(path, {
    method, headers: { "Content-Type": type }, body: type === "application/json" ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The site said ${response.status}. Try again.`);
  return data;
}

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
    const photos = [];
    for (const [i, { file }] of picked.entries()) {
      status.textContent = `Getting photo ${i + 1} of ${picked.length} ready…`;
      let bitmap;
      try {
        bitmap = await createImageBitmap(file); // turned the right way up, as the phone shows it
      } catch {
        throw new Error(`Couldn't read ${file.name}. Try a JPEG or PNG.`);
      }
      const full = await jpeg(bitmap, [MAX_SIDE, MAX_SIDE], 0.9);
      const thumb = await jpeg(bitmap, THUMB_BOX, 0.8);
      bitmap.close();
      photos.push({ full, thumb, hash: await sha256(full.blob), thumbHash: await sha256(thumb.blob) });
    }
    const files = new Map(photos.flatMap((p) => [[p.hash, p.full.blob], [p.thumbHash, p.thumb.blob]]));
    const { missing } = await call("/_admin/import/missing", { hashes: [...files.keys()] });
    for (const [n, hash] of missing.entries()) {
      status.textContent = `Uploading ${n + 1} of ${missing.length}…`;
      await call(`/_admin/import/files/${hash}`, files.get(hash), { method: "PUT", type: "image/jpeg" });
    }
    status.textContent = "Posting…";
    await call("/_admin/posts", {
      text,
      photos: photos.map((p) => ({
        hash: p.hash, thumb_hash: p.thumbHash, width: p.full.width, height: p.full.height, size: p.full.blob.size,
      })),
    });
    location.href = "/posts";
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    busy(false);
  }
});
