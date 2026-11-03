// The import page: read the export here, then upload the chosen sections to this site (src/importer.js).
// Files go first (the slow part, and skipped when already stored), then the rows, then one swap so visitors
// never see a half-finished import.
import { ingest } from "./ingest.js";
import { mediaType, photoInfo, sha256 } from "./images.js";
import { ARCHIVE } from "./schema.js";
import { select } from "./select.js";
import { folderSource, zipSource } from "./sources.js";

const ROWS_PER_REQUEST_BYTES = 150_000;
const FILE_BATCH = 24; // files prepared, checked and uploaded together
const PARALLEL = 4;

const $ = (id) => document.getElementById(id);
let chosen = null;

$("zips").addEventListener("change", (e) => pick(e.target.files.length ? { zips: [...e.target.files] } : null));
$("folder").addEventListener("change", (e) => pick(e.target.files.length ? { folder: e.target.files } : null));
$("go").addEventListener("click", () => run().catch(fail));

function pick(selection) {
  chosen = selection;
  $("go").disabled = !chosen;
  $("error").textContent = "";
}

// --- progress ----------------------------------------------------------------

function step(text) {
  document.querySelector("#steps li:last-child")?.classList.add("done");
  const li = document.createElement("li");
  li.textContent = text;
  $("steps").append(li);
  progress(0, 1, "");
}

function progress(done, total, text) {
  $("bar").max = total || 1;
  $("bar").value = done;
  $("status").textContent = text;
}

function note(text) {
  const li = document.createElement("li");
  li.textContent = text;
  $("notes").append(li);
}

function fail(error) {
  console.error(error);
  $("error").textContent = `${error.message} Nothing has changed on the site; fix that and try again.`;
  $("go").disabled = false;
  window.onbeforeunload = null;
}

const sizeText = (bytes) => `${(bytes / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 0 })} MB`;

// --- talking to the site -----------------------------------------------------

async function api(path, body, { method = "POST", type = "application/json", attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(`/_admin/import${path}`, {
        method,
        headers: { "Content-Type": type },
        body: type === "application/json" ? JSON.stringify(body) : body,
      });
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Lost connection to the site (${error.message}).`);
    }
    if (response?.ok) return response.json();
    if (response && response.status < 500 && response.status !== 429) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `The site said ${response.status}.`);
    }
    if (attempt >= attempts) throw new Error(`The site kept failing (${response?.status ?? "no response"}).`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** Runs `work` over `items`, `limit` at a time. */
async function eachLimited(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

// --- the import --------------------------------------------------------------

async function run() {
  const sections = [...document.querySelectorAll("input[name=section]:checked")].map((i) => i.value);
  if (!sections.length) throw new Error("Tick at least one section to publish.");
  $("go").disabled = true;
  $("error").textContent = "";
  $("steps").replaceChildren();
  $("notes").replaceChildren();
  $("progress").hidden = false;
  window.onbeforeunload = () => "The import is still running.";

  step("Reading your export");
  const source = chosen.zips ? await zipSource(chosen.zips) : folderSource(chosen.folder);
  const { tables, me } = await ingest(source, { log: () => {} });
  progress(1, 1, `${me}: ${tables.posts.length.toLocaleString("en-GB")} posts, ${tables.media.length.toLocaleString("en-GB")} photos and videos`);

  const { tables: publish, tooBig } = select(tables, sections, (m) => (source.has(m.file) ? source.size(m.file) : null));
  for (const [path, size] of tooBig) note(`Left out ${path} (${sizeText(size)}): too big for the site.`);

  step("Uploading photos and videos");
  await uploadMedia(source, publish.media);

  step("Uploading posts, people and the rest");
  await api("/start", {});
  const total = Object.values(publish).reduce((n, rows) => n + rows.length, 0);
  let sent = 0;
  for (const [table, rows] of Object.entries(publish)) {
    const columns = Object.keys(ARCHIVE[table].columns);
    for (const batch of rowBatches(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))))) {
      await api("/rows", { table, rows: batch });
      sent += batch.length;
      progress(sent, total, `${sent.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} rows`);
    }
  }

  step("Publishing");
  const { removed } = await api("/finish", { sections });
  if (removed) note(`Deleted ${removed.toLocaleString("en-GB")} files the archive no longer uses.`);
  document.querySelector("#steps li:last-child").classList.add("done");
  progress(1, 1, "");
  $("status").innerHTML = 'Done. <a href="/">See your archive</a>';
  window.onbeforeunload = null;
}

function* rowBatches(rows) {
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (batch.length && bytes + size > ROWS_PER_REQUEST_BYTES) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) yield batch;
}

// Each file is fingerprinted (and photos measured and thumbnailed), then only files the site doesn't already
// have are sent: re-importing the same archive uploads almost nothing.
async function uploadMedia(source, media) {
  const totalBytes = media.reduce((n, m) => n + source.size(m.file), 0);
  const sent = new Set();
  let doneBytes = 0;
  let uploadedBytes = 0;
  let unreadable = 0;
  for (let i = 0; i < media.length; i += FILE_BATCH) {
    const batch = media.slice(i, i + FILE_BATCH);
    const blobs = new Map();
    await eachLimited(batch, PARALLEL, async (m) => {
      const head = await source.head(m.file, 12);
      m.type = mediaType(m.file, m.kind, head);
      if (!m.type) {
        m.skip = true;
        note(`Left out ${m.path}: not a photo or video this site can show.`);
        return;
      }
      const blob = await source.blob(m.file, m.type);
      m.size = blob.size;
      m.hash = await sha256(blob);
      blobs.set(m.hash, blob);
      if (m.kind === "photo") {
        const info = await photoInfo(blob);
        m.width = info.width;
        m.height = info.height;
        if (info.thumb) {
          m.thumb_hash = await sha256(info.thumb);
          blobs.set(m.thumb_hash, info.thumb);
        } else unreadable++;
      }
    });

    const { missing } = await api("/missing", { hashes: [...blobs.keys()].filter((h) => !sent.has(h)) });
    await eachLimited(missing, PARALLEL, async (hash) => {
      const blob = blobs.get(hash);
      await api(`/files/${hash}`, blob, { method: "PUT", type: blob.type });
      sent.add(hash);
      uploadedBytes += blob.size;
    });
    doneBytes += batch.reduce((n, m) => n + source.size(m.file), 0);
    progress(doneBytes, totalBytes, `${sizeText(doneBytes)} of ${sizeText(totalBytes)} checked, ${sizeText(uploadedBytes)} uploaded`);
  }
  // Anything that couldn't be stored isn't published either.
  for (let i = media.length - 1; i >= 0; i--) if (media[i].skip) media.splice(i, 1);
  if (unreadable) note(`${unreadable} photos couldn't be read for a thumbnail; they show full size instead.`);
}
