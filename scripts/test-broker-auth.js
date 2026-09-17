"use strict";

/**
 * Broker session management.
 *
 * The TOTP generator is checked against RFC 6238's own published vectors, which
 * exist independently of this codebase. Everything else checks that the two
 * brokers are described honestly: Angel One can run unattended, Upstox cannot,
 * and no amount of scheduling changes that.
 */

const assert = require("node:assert/strict");
const {
  angelLogin,
  angelRefresh,
  base32Decode,
  sessionStatus,
  totp,
  upstoxExchangeCode,
  upstoxTokenExpiry
} = require("../api/_lib/broker-auth");

// --- RFC 6238 published vectors ---------------------------------------------
// Secret is the 20-byte ASCII string "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
assert.equal(base32Decode(RFC_SECRET).toString("utf8"), "12345678901234567890",
  "base32 decoding must round-trip the RFC test secret");
assert.equal(base32Decode(RFC_SECRET).length, 20);

for (const [unixSeconds, expected] of [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"]
]) {
  assert.equal(totp(RFC_SECRET, { timestamp: unixSeconds * 1000, digits: 8 }), expected,
    `RFC 6238 vector at T=${unixSeconds}`);
}
// The six-digit form a broker actually asks for is the same value truncated.
assert.equal(totp(RFC_SECRET, { timestamp: 59_000 }), "287082");
assert.equal(totp(RFC_SECRET, { timestamp: 59_000 }).length, 6);
// Codes must change on the next 30-second step and hold within one.
assert.equal(totp(RFC_SECRET, { timestamp: 0 }), totp(RFC_SECRET, { timestamp: 29_000 }),
  "a code holds for its whole 30-second window");
assert.notEqual(totp(RFC_SECRET, { timestamp: 0 }), totp(RFC_SECRET, { timestamp: 30_000 }),
  "a code must change when the window rolls");
assert.throws(() => totp("not valid base32 !!!"), /base32/,
  "a malformed secret must fail loudly rather than mint a wrong code");
console.log("  ✓ TOTP matches all five RFC 6238 published vectors, holds and rolls on the 30s window");

// --- Upstox token lifetime ---------------------------------------------------
// Tokens die at 03:30 IST, which is 22:00 UTC the previous day, whenever minted.
const midMorning = upstoxTokenExpiry(new Date("2026-09-17T10:00:00Z"));
assert.equal(midMorning.toISOString(), "2026-09-17T22:00:00.000Z",
  "a token held at 15:30 IST expires at 03:30 IST the next morning");
const justBefore = upstoxTokenExpiry(new Date("2026-09-17T21:59:00Z"));
assert.equal(justBefore.toISOString(), "2026-09-17T22:00:00.000Z", "one minute before the cutoff, the cutoff is still today");
const justAfter = upstoxTokenExpiry(new Date("2026-09-17T22:10:00Z"));
assert.equal(justAfter.toISOString(), "2026-09-18T22:00:00.000Z", "past the cutoff, the next one is tomorrow");
console.log("  ✓ Upstox expiry pinned to 03:30 IST regardless of when the token was minted");

// --- the two brokers are described honestly ----------------------------------
const saved = {};
for (const key of ["ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET", "UPSTOX_ACCESS_TOKEN"]) {
  saved[key] = process.env[key];
  delete process.env[key];
}
const status = sessionStatus(new Date("2026-09-17T10:00:00Z"));

// Upstox issues no refresh token. Saying otherwise would invite a scheduler
// that silently never works.
assert.equal(status.upstox.canAutoRefresh, false, "Upstox cannot auto-refresh: it issues no refresh token");
assert.equal(status.upstox.refreshTokenSupported, false);
assert.equal(status.upstox.mode, "MANUAL_DAILY_OAUTH");
assert.equal(status.upstox.expiresAt, "2026-09-17T22:00:00.000Z");
assert.equal(status.upstox.hoursRemaining, 12, "hours remaining must be computed, not guessed");
assert.ok(status.upstox.note.includes("no refresh token"), "the limitation must be stated in the status itself");

// Angel One without a TOTP secret is manual; with one it is unattended.
assert.equal(status.angelone.canAutoRefresh, false, "no credentials means no unattended refresh");
assert.equal(status.angelone.mode, "MANUAL");
assert.deepEqual(status.angelone.missing, ["apiKey", "clientCode", "mpin", "totpSecret"],
  "the status must name exactly what is missing");

process.env.ANGELONE_API_KEY = "k";
process.env.ANGELONE_CLIENT_CODE = "c";
process.env.ANGELONE_MPIN = "1234";
process.env.ANGELONE_TOTP_SECRET = RFC_SECRET;
const armed = sessionStatus();
assert.equal(armed.angelone.canAutoRefresh, true, "with a TOTP secret Angel One runs unattended");
assert.equal(armed.angelone.mode, "UNATTENDED_TOTP");
assert.deepEqual(armed.angelone.missing, []);
console.log("  ✓ Angel One reports UNATTENDED_TOTP once armed; Upstox always reports MANUAL_DAILY_OAUTH");

// --- incomplete credentials refuse before reaching the network ---------------
(async () => {
  for (const key of ["ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET"]) delete process.env[key];

  const login = await angelLogin();
  assert.equal(login.ok, false);
  assert.equal(login.reason, "INCOMPLETE_CREDENTIALS");
  assert.ok(Array.isArray(login.missing) && login.missing.length > 0, "a refusal must list what is missing");
  assert.equal(login.session, null, "a refusal carries no session");

  const refresh = await angelRefresh();
  assert.equal(refresh.ok, false);
  assert.equal(refresh.session, null);

  const exchange = await upstoxExchangeCode(null);
  assert.equal(exchange.ok, false);
  assert.ok(["INCOMPLETE_CREDENTIALS", "NO_AUTHORIZATION_CODE"].includes(exchange.reason));
  assert.equal(exchange.session, null);
  console.log("  ✓ Incomplete credentials refuse locally and never reach the network");

  for (const [key, value] of Object.entries(saved)) if (value) process.env[key] = value;
  console.log("Broker auth tests passed: RFC 6238 TOTP vectors, Upstox 03:30 IST expiry, honest per-provider capability, local refusal on incomplete credentials");
})();
