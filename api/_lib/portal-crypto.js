// Passphrase encryption for the portal's private payload.
//
// The portal is served as static files from a host that may be publicly
// reachable, so the book never leaves the build in plaintext. Positions, averages
// and P&L are sealed with a passphrase at build time and opened in the browser
// with WebCrypto; the host only ever holds ciphertext.
//
// Parameters are chosen to match what SubtleCrypto can do natively, so the page
// needs no library: PBKDF2-HMAC-SHA256 for key derivation and AES-256-GCM for
// the seal, which also authenticates the payload so a tampered file fails to
// open rather than decoding into something misleading.

const crypto = require("node:crypto");

const ITERATIONS = 600_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const DIGEST = "sha256";

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(String(passphrase), salt, ITERATIONS, KEY_BYTES, DIGEST);
}

function sealPayload(data, passphrase) {
  if (!passphrase || String(passphrase).length < 12) {
    throw new Error("The portal passphrase must be at least 12 characters");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return {
    algorithm: "AES-256-GCM",
    keyDerivation: `PBKDF2-HMAC-SHA256/${ITERATIONS}`,
    iterations: ITERATIONS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    // WebCrypto expects the authentication tag appended to the ciphertext.
    ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64")
  };
}

// Mirrors what the browser does, so the round trip can be tested without one.
function openPayload(sealed, passphrase) {
  const salt = Buffer.from(String(sealed.salt), "base64");
  const iv = Buffer.from(String(sealed.iv), "base64");
  const raw = Buffer.from(String(sealed.ciphertext), "base64");
  if (raw.length <= 16) throw new Error("Sealed payload is too short to contain a tag");
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const key = crypto.pbkdf2Sync(String(passphrase), salt, Number(sealed.iterations) || ITERATIONS, KEY_BYTES, DIGEST);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

function generatePassphrase() {
  // Six short words from a fixed alphabet-free set would need a wordlist; random
  // base32 keeps it dependency-free while staying readable enough to retype.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(20);
  const groups = [];
  for (let index = 0; index < 20; index += 4) {
    groups.push([...bytes.subarray(index, index + 4)].map((byte) => alphabet[byte % alphabet.length]).join(""));
  }
  return groups.join("-");
}

module.exports = { ITERATIONS, generatePassphrase, openPayload, sealPayload };
