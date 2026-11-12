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
//
// From list SIGNATURE2_FROM on, each release also carries its `etag`: Cloudflare's fingerprint of the release's code,
// the same in every account (scripts/sign.mjs gets it by uploading the release, never live, to a Worker kept for the
// purpose). Friends' checks use it to make sure every version uploaded to a site since the last check was a signed
// release. It's covered by a second signature, `signature2`, over signedText2(), so sites from before it still check
// `signature` as they always have; sites from after it insist on `signature2` from that list on, so nobody can serve
// the list with the etags taken out.
import pkg from "../package.json";
import { testingHere } from "./cloudflare.js";

const REPO = pkg.afterwrd.releases;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes in base64
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes in base64
// Enough that a release stays in the list long after sites have moved on (friends' checks look back at every version
// since their last check), at about 250 characters a release; the list is never read past MAX_LIST characters.
const MAX_RELEASES = 200;
const MAX_LIST = 256_000;
const SIGNATURE2_FROM = 9; // the first list signed with etags

/** The exact text the list's signature covers. scripts/sign.mjs makes the same. */
export const signedText = ({ seq, releases }) =>
  `afterwrd releases\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;

/** The text `signature2` covers: the same, with each release's etag ("-" for one signed before etags). */
export const signedText2 = ({ seq, releases }) =>
  `afterwrd releases 2\n${seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at} ${r.etag ?? "-"}\n`).join("")}`;

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
 * The signed list of releases, checked: {seq, releases: Map(version → {manifestSha256, signedAt, etag})}, or null if
 * there's no key, no list, or it isn't genuine. Never throws for a bad list: that's an answer, "nothing".
 */
export async function signedList(env, origin, fetcher = fetch) {
  const key = releaseKey(env, origin);
  if (!key) return null;
  // A test on this computer never reads the real list: it gives its own, or has none.
  if (testingHere(env, origin) && !env.SIGNATURES_URL) return null;
  const response = await fetcher(`${signaturesBase(env, origin)}/index.json`, { headers: { "User-Agent": "afterwrd" } }).catch(() => null);
  if (!response?.ok) return null;
  const text = await response.text().catch(() => "");
  if (text.length > MAX_LIST) return null;
  let list;
  try { list = JSON.parse(text); } catch { return null; }
  if (!Number.isSafeInteger(list?.seq) || list.seq < 1 || !Array.isArray(list.releases) || list.releases.length > MAX_RELEASES
    || !SIG_RE.test(list.signature ?? "")) return null;
  for (const r of list.releases) {
    if (!VERSION_RE.test(r?.version ?? "") || !SHA_RE.test(r?.manifest_sha256 ?? "") || !DATE_RE.test(r?.signed_at ?? "")) return null;
    if (r.etag !== undefined && !SHA_RE.test(r.etag)) return null;
  }
  const from = testingHere(env, origin) && Number(env.TEST_SIGNATURE2_FROM) > 0 ? Number(env.TEST_SIGNATURE2_FROM) : SIGNATURE2_FROM;
  const second = list.seq >= from || list.signature2 !== undefined;
  if (second && !SIG_RE.test(list.signature2 ?? "")) return null;
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromBase64(key), { name: "Ed25519" }, false, ["verify"]);
    const verify = (signature, text) => crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64(signature), new TextEncoder().encode(text));
    if (!(await verify(list.signature, signedText(list)))) return null;
    if (second && !(await verify(list.signature2, signedText2(list)))) return null;
  } catch {
    return null;
  }
  return {
    seq: list.seq,
    releases: new Map(list.releases.map((r) => [r.version, { manifestSha256: r.manifest_sha256, signedAt: Math.floor(Date.parse(r.signed_at) / 1000),
      // Only when the second signature covers it.
      etag: second && r.etag ? r.etag : null }])),
  };
}

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
