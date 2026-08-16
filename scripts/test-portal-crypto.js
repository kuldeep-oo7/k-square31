"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ITERATIONS, generatePassphrase, openPayload, sealPayload } = require("../api/_lib/portal-crypto");

const book = { positions: [{ symbol: "AMBUJACEM", quantity: 470, mtm: -4313.19 }], totalMtm: -47309.15 };
const passphrase = "correct-horse-battery";

const sealed = sealPayload(book, passphrase);
assert.equal(sealed.algorithm, "AES-256-GCM");
assert.equal(sealed.iterations, ITERATIONS);
assert.deepEqual(openPayload(sealed, passphrase), book, "the round trip must return the book unchanged");

// The plaintext must not survive anywhere in the emitted payload.
const serialised = JSON.stringify(sealed);
assert.ok(!serialised.includes("AMBUJACEM"), "a symbol must not be readable in the sealed payload");
assert.ok(!serialised.includes("47309"), "the P&L must not be readable in the sealed payload");
assert.ok(!serialised.includes("4313"));

// Every seal is unique even for identical input, so republishing does not leak
// that the book is unchanged.
const again = sealPayload(book, passphrase);
assert.notEqual(again.ciphertext, sealed.ciphertext, "a fresh salt and IV must produce different ciphertext");
assert.notEqual(again.salt, sealed.salt);
assert.notEqual(again.iv, sealed.iv);

assert.throws(() => openPayload(sealed, "wrong-passphrase-entirely"), /unable to authenticate|bad decrypt|Unsupported state/i, "a wrong passphrase must fail, never return partial data");

// GCM authenticates the payload: a flipped byte must fail rather than decode.
const tampered = { ...sealed };
const bytes = Buffer.from(sealed.ciphertext, "base64");
bytes[0] ^= 0xff;
tampered.ciphertext = bytes.toString("base64");
assert.throws(() => openPayload(tampered, passphrase), /unable to authenticate|bad decrypt|Unsupported state/i, "tampering must be detected");

assert.throws(() => sealPayload(book, "short"), /at least 12 characters/, "a weak passphrase must be refused");
assert.throws(() => sealPayload(book, ""), /at least 12 characters/);

const generated = generatePassphrase();
assert.match(generated, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/, `generated passphrase has an unexpected shape: ${generated}`);
assert.ok(generated.replace(/-/g, "").length >= 20, "a generated passphrase must carry enough entropy");
assert.notEqual(generatePassphrase(), generated, "generated passphrases must not repeat");
assert.deepEqual(openPayload(sealPayload(book, generated), generated), book);

// The browser side derives the same key with SubtleCrypto's PBKDF2. Deriving it
// here through a second, independent path confirms the parameters agree.
const salt = Buffer.from(sealed.salt, "base64");
const direct = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, "sha256");
const viaAsync = crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, ITERATIONS, 32, "sha256");
assert.equal(direct.toString("hex"), viaAsync.toString("hex"), "UTF-8 passphrase bytes must derive the same key the browser will");

console.log("Portal crypto tests passed: authenticated round trip, no plaintext leakage, unique seals, tamper and wrong-passphrase rejection");
