// Getting photos ready and uploading them, for the composer (compose.js) and the Add photos page (add-photos.js).
// Each photo is redrawn here as a JPEG of at most 2560px a side, which also drops what phones hide inside photos
// (where it was taken, the device), plus a thumbnail. Both go up by their SHA-256 through the import's file
// endpoints; the caller then saves the post or album with the details this returns.
const MAX_SIDE = 2560;
const THUMB_BOX = [900, 600]; // as the import's thumbnails

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

export async function call(path, body, { method = "POST", type = "application/json" } = {}) {
  const response = await fetch(path, {
    method, headers: { "Content-Type": type }, body: type === "application/json" ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The site said ${response.status}. Try again.`);
  return data;
}

/** Prepares and uploads `files`, reporting progress through `say`; returns each photo's details for saving. */
export async function uploadPhotos(files, say) {
  const photos = [];
  for (const [i, file] of files.entries()) {
    say(`Getting photo ${i + 1} of ${files.length} ready…`);
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
  const blobs = new Map(photos.flatMap((p) => [[p.hash, p.full.blob], [p.thumbHash, p.thumb.blob]]));
  const { missing } = await call("/_admin/import/missing", { hashes: [...blobs.keys()] });
  for (const [n, hash] of missing.entries()) {
    say(`Uploading ${n + 1} of ${missing.length}…`);
    await call(`/_admin/import/files/${hash}`, blobs.get(hash), { method: "PUT", type: "image/jpeg" });
  }
  return photos.map((p) => ({ hash: p.hash, thumb_hash: p.thumbHash, width: p.full.width, height: p.full.height, size: p.full.blob.size }));
}

/** Thumbnails of the photos picked so far, each with a ✕ to take it out again. */
export function picker(input, list, { max, onChange = () => {} }) {
  const picked = [];
  function show() {
    list.hidden = !picked.length;
    list.replaceChildren(...picked.map((p, i) => {
      const item = document.createElement("li");
      const img = Object.assign(document.createElement("img"), { src: p.url, alt: "" });
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "✕" });
      remove.setAttribute("aria-label", `Remove ${p.file.name}`);
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        picked.splice(i, 1);
        show();
        onChange(picked);
      });
      item.append(img, remove);
      return item;
    }));
  }
  input.addEventListener("change", () => {
    if (max === 1) picked.splice(0).forEach((p) => URL.revokeObjectURL(p.url));
    for (const file of input.files) picked.push({ file, url: URL.createObjectURL(file) });
    input.value = "";
    show();
    onChange(picked);
  });
  return picked;
}
