// Makes the key that signs afterwrd releases, once (src/signing.js, scripts/sign.mjs):
//
//   node scripts/release-key.mjs
//
// It asks for a passphrase (keep it in your password manager), writes the private key, encrypted with it, to
// ~/.afterwrd/release-signing-key.pem (never into the repository, never anywhere GitHub can reach), and prints the
// public key to put in package.json as afterwrd.releaseKey. Sites carry that public key in their code; a release
// signed with this key is one they'll install by themselves.
//
// Losing the key (or its passphrase) only stops automatic updates: make a new one and ship its public key in an
// update people install by hand. If someone else may have it, do the same at once.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askHidden } from "./sign.mjs";

const dir = join(homedir(), ".afterwrd");
const file = join(dir, "release-signing-key.pem");
if (existsSync(file)) {
  console.error(`${file} already exists. Move it away first if you really mean to make a new key.`);
  process.exit(1);
}
const passphrase = await askHidden("Passphrase for the new key: ");
if (passphrase.length < 12) { console.error("Use at least 12 characters."); process.exit(1); }
if ((await askHidden("Again: ")) !== passphrase) { console.error("They don't match."); process.exit(1); }

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }), { mode: 0o600 });
// The raw 32-byte public key is the end of its SPKI encoding.
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
console.log(`Private key: ${file} (encrypted with your passphrase)`);
console.log(`Public key, for package.json "afterwrd": { "releaseKey": "${raw.toString("base64")}" }`);
