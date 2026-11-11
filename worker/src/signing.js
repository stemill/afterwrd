// Signed releases (docs/security-and-install-plan.md, section 6): a site only updates itself (and its groups) to a
// release Ste has signed with a key kept on Ste's own machine, never on GitHub, so taking over the GitHub account isn't
// enough to reach every site. scripts/sign.mjs rebuilds a published release from its tag, refuses unless the rebuild
// matches what GitHub published byte for byte, and signs the list of releases sites may take:
//   signatures/index.json   {seq, releases: [{version, manifest_sha256, signed_at}, …], signature}
// one signed list, so nothing in it can be added, dropped or restored by anyone without the key. `seq` goes up every
// time it's signed, and a site never accepts a list with a lower `seq` than one it has seen, so an old list can't be
// put back. Pulling a release is signing the list again without it (scripts/sign.mjs --pull). The public key is in
// package.json (afterwrd.releaseKey, 32 bytes in base64). Updating by hand doesn't need a signature (the person chose
// to), as before.
import pkg from "../package.json";
import { testingHere } from "./cloudflare.js";

const REPO = pkg.afterwrd.releases;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes in base64
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes in base64
const MAX_RELEASES = 50;

/** The exact text the list's signature covers. scripts/sign.mjs makes the same. */
export const signedText = ({ seq, releases }) =>
  `afterwrd releases\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;

/** Where the list comes from: the repository's main branch (or a stand-in when testing on this computer). */
export function signaturesBase(env, origin) {
  return testingHere(env, origin) && env.SIGNATURES_URL ? env.SIGNATURES_URL : `https://raw.githubusercontent.com/${REPO}/main/signatures`;
}

/** The public key releases are checked against: package.json's, or a test key when testing on this computer. */
export function releaseKey(env, origin) {
  const key = testingHere(env, origin) && env.TEST_RELEASE_KEY ? env.TEST_RELEASE_KEY : pkg.afterwrd.releaseKey;
  return typeof key === "string" && KEY_RE.test(key) ? key : null;
}

/**
 * The signed list of releases, checked: {seq, releases: Map(version → {manifestSha256, signedAt})}, or null if
 * there's no key, no list, or it isn't genuine. Never throws for a bad list: that's an answer, "nothing".
 */
export async function signedList(env, origin, fetcher = fetch) {
  const key = releaseKey(env, origin);
  if (!key) return null;
  const response = await fetcher(`${signaturesBase(env, origin)}/index.json`, { headers: { "User-Agent": "afterwrd" } }).catch(() => null);
  if (!response?.ok) return null;
  const text = await response.text().catch(() => "");
  if (text.length > 64_000) return null;
  let list;
  try { list = JSON.parse(text); } catch { return null; }
  if (!Number.isSafeInteger(list?.seq) || list.seq < 1 || !Array.isArray(list.releases) || list.releases.length > MAX_RELEASES
    || !SIG_RE.test(list.signature ?? "")) return null;
  for (const r of list.releases) {
    if (!VERSION_RE.test(r?.version ?? "") || !SHA_RE.test(r?.manifest_sha256 ?? "") || !DATE_RE.test(r?.signed_at ?? "")) return null;
  }
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromBase64(key), { name: "Ed25519" }, false, ["verify"]);
    const good = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64(list.signature), new TextEncoder().encode(signedText(list)));
    if (!good) return null;
  } catch {
    return null;
  }
  return {
    seq: list.seq,
    releases: new Map(list.releases.map((r) => [r.version, { manifestSha256: r.manifest_sha256, signedAt: Math.floor(Date.parse(r.signed_at) / 1000) }])),
  };
}

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
