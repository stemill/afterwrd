// Read access to a Facebook export, from the zip file(s) Facebook gives you or an unzipped folder, in the shape
// ingest.js expects: paths relative to the export's top folder.
/* global zip */

export async function zipSource(files) {
  zip.configure({ useWebWorkers: false }); // Facebook stores files uncompressed, so there's little to unpack
  const entries = new Map();
  for (const file of files) {
    const reader = new zip.ZipReader(new zip.BlobReader(file));
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) entries.set(entry.filename, entry);
    }
  }
  return wrap(entries, {
    size: (entry) => entry.uncompressedSize,
    text: (entry) => entry.getData(new zip.TextWriter("utf-8")),
    blob: (entry, type) => entry.getData(new zip.BlobWriter(type)),
  });
}

export function folderSource(fileList) {
  const entries = new Map([...fileList].map((file) => [file.webkitRelativePath || file.name, file]));
  return wrap(entries, {
    size: (file) => file.size,
    text: (file) => file.text(),
    blob: async (file, type) => (type ? file.slice(0, file.size, type) : file),
  });
}

// Exports can sit inside a folder (an unzipped download, or a zip someone made themselves), so paths are taken
// relative to wherever the profile information file is.
function wrap(entries, io) {
  const profile = [...entries.keys()].find((p) => /(^|\/)personal_information\/profile_information\/profile_information\.json$/.test(p));
  if (!profile) {
    throw new Error("This doesn't look like a Facebook export in JSON format: there's no personal_information folder.");
  }
  const prefix = profile.slice(0, profile.indexOf("personal_information/"));
  const files = new Map();
  for (const [path, entry] of entries) {
    if (path.startsWith(prefix)) files.set(path.slice(prefix.length), entry);
  }
  return {
    files: [...files.keys()],
    has: (path) => files.has(path),
    size: (path) => io.size(files.get(path)),
    text: (path) => io.text(files.get(path)),
    blob: (path, type) => io.blob(files.get(path), type),
    head: async (path, n) => new Uint8Array(await (await io.blob(files.get(path))).slice(0, n).arrayBuffer()),
  };
}
