// Fingerprints and thumbnails, made in the browser while importing.
import { MEDIA_TYPES } from "./schema.js";
import { suffix } from "./ingest.js";

const THUMB_BOX = [900, 600]; // big enough for a 2x-density grid row or a single photo in a post

export async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The MIME type to store a file as, from its extension or, failing that, its first bytes; null if unknown. */
export function mediaType(path, kind, head) {
  const known = MEDIA_TYPES[suffix(path).toLowerCase()];
  if (known) return known;
  if (kind === "video") return "video/mp4"; // extension-less videos are recognised by their MP4 header
  const ascii = String.fromCharCode(...head.slice(0, 12));
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (ascii.startsWith("\x89PNG")) return "image/png";
  if (ascii.startsWith("GIF8")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8) === "WEBP") return "image/webp";
  return null;
}

/** A photo's size (after EXIF rotation, as the browser shows it) and a JPEG thumbnail; nulls if unreadable. */
export async function photoInfo(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob); // applies the EXIF orientation
  } catch {
    return { width: null, height: null, thumb: null };
  }
  const { width, height } = bitmap;
  const scale = Math.min(THUMB_BOX[0] / width, THUMB_BOX[1] / height, 1);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const thumb = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return { width, height, thumb };
}
