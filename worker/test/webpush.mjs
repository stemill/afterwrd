// Checks src/webpush.js: encryption against RFC 8291's worked example, a round trip decrypted the way a device does it
// (with Node's own crypto, not the code under test), the signing header, and which push addresses are allowed.
//   node test/webpush.mjs
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { encryptMessage, makeVapidKeys, pushEndpoint, vapidAuthorization } from "../src/webpush.js";
import { fromBase64Url, toBase64Url } from "../src/util.js";

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const b64 = (s) => fromBase64Url(s.replace(/\s+/g, ""));

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

const pub = b64(RFC.asPublic);
const jwk = { kty: "EC", crv: "P-256", x: toBase64Url(pub.slice(1, 33)), y: toBase64Url(pub.slice(33)), d: RFC.asPrivate };
const serverKeys = {
  publicKey: await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []),
  privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
};
const made = await encryptMessage(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { serverKeys, salt: b64(RFC.salt) });
check("matches RFC 8291's worked example byte for byte", toBase64Url(made) === toBase64Url(b64(RFC.body)), toBase64Url(made).slice(0, 40));

// A device decrypting, as RFC 8291 describes it, written separately with Node's crypto.
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const sealed = body.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end -= 1; // padding
  if (plain[end] !== 2) throw new Error("no final-record delimiter");
  return { rs, text: plain.subarray(0, end).toString("utf8"), size: body.length };
}

const rfcBack = decrypt(Buffer.from(made), Buffer.from(b64(RFC.uaPrivate)), Buffer.from(b64(RFC.uaPublic)), Buffer.from(b64(RFC.auth)));
check("the RFC example decrypts back", rfcBack.text === RFC.plaintext && rfcBack.rs === 4096, rfcBack.text);

// A fresh device and a fresh message, as in real use.
const device = createECDH("prime256v1");
device.generateKeys();
const deviceAuth = crypto.getRandomValues(new Uint8Array(16));
const message = JSON.stringify({ title: "Sam Taylor", body: "Are you coming tonight? 🎉" });
const sent = await encryptMessage(message, { p256dh: toBase64Url(device.getPublicKey()), auth: toBase64Url(deviceAuth) });
const back = decrypt(Buffer.from(sent), device.getPrivateKey(), device.getPublicKey(), Buffer.from(deviceAuth));
check("a fresh message decrypts on the device", back.text === message, back.text);
const again = await encryptMessage(message, { p256dh: toBase64Url(device.getPublicKey()), auth: toBase64Url(deviceAuth) });
check("…and the same message never encrypts the same way twice", toBase64Url(again) !== toBase64Url(sent));
const padded = await Promise.all(["hi", "a much longer message than that one, but still short"].map((m) =>
  encryptMessage(m, { p256dh: toBase64Url(device.getPublicKey()), auth: toBase64Url(deviceAuth) }, { padTo: 1024 })));
const unpadded = padded.map((b) => decrypt(Buffer.from(b), device.getPrivateKey(), device.getPublicKey(), Buffer.from(deviceAuth)));
check("padded messages are all the same size, and decrypt to what was sent", padded[0].length === padded[1].length
  && unpadded[0].text === "hi" && unpadded[1].text.startsWith("a much longer"), `${padded[0].length} ${padded[1].length}`);
let refused = await encryptMessage("x".repeat(3001), { p256dh: toBase64Url(device.getPublicKey()), auth: toBase64Url(deviceAuth) }).then(() => false, () => true);
check("a message that's too long is refused", refused);
refused = await encryptMessage("hi", { p256dh: "AAAA", auth: toBase64Url(deviceAuth) }).then(() => false, () => true);
check("…and so are bad device keys", refused);

// The signing header: a JWT the push service can check with the public key in it.
const vapid = await makeVapidKeys();
const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH...", vapid, "https://afterwrd.example", 1_700_000_000);
const [, token, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header) ?? [];
const [h, c, s] = (token ?? "..").split(".");
const claims = JSON.parse(Buffer.from(c, "base64url"));
check("signing header has the right shape and claims", k === vapid.publicKey && claims.aud === "https://web.push.apple.com"
  && claims.exp === 1_700_000_000 + 43200 && claims.sub === "https://afterwrd.example"
  && JSON.parse(Buffer.from(h, "base64url")).alg === "ES256", JSON.stringify(claims));
const raw = Buffer.from(fromBase64Url(k));
const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
check("…and its signature checks out with the site's public key",
  verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));

// Only real push services.
const ok = ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-db5p.notify.windows.com/w/?token=abc"];
const bad = ["http://web.push.apple.com/abc", "https://web.push.apple.com.evil.example/abc", "https://evil.example/web.push.apple.com", "https://localhost/abc",
  "https://web.push.apple.com:8443/abc", "https://user@fcm.googleapis.com/x", "https://:secret@fcm.googleapis.com/x", "javascript:alert(1)", "", null];
check("push addresses at known services are allowed", ok.every((e) => pushEndpoint(e)));
check("…and nothing else is", bad.every((e) => !pushEndpoint(e)), bad.filter((e) => pushEndpoint(e)).join(", "));
check("a push service on this computer only for a site being tested here", !pushEndpoint("http://localhost:8795/push/1")
  && pushEndpoint("http://localhost:8795/push/1", { local: true }) && !pushEndpoint("http://evil.example/push", { local: true }));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
