"use strict";
// contract-screener.js bySymbol: every contract of a name is either counted as cleared or under the gate
// that refused it, so the page can say why an index has no row (8 Oct 2026: every index put vanished).
const assert = require("node:assert");
const { screenContracts } = require("../api/_lib/contract-screener");
const now = Date.parse("2026-10-08T05:00:00Z");           // Thu 8 Oct 10:30 IST, in session
const E = "2026-10-27";
const q = (price, volume, openInterest) => ({ price, volume, openInterest });
const reference = { session: "2026-10-07", symbols: {
  NIFTY: { underlyingPrice: 22600, expiries: { "2026-10-13": { futuresPrice: 22620, callStrikes: [22600], putStrikes: [22600], quotes: {} },
    [E]: { futuresPrice: 22650, callStrikes: [22600], putStrikes: [22000, 22300, 22600],
      quotes: { "22600|CE": q(400, 5000, 90000), "22000|PE": q(90, 20, 100), "22300|PE": q(260, 8000, 60000), "22600|PE": q(390, 9000, 80000) } } } },
  AAA: { underlyingPrice: 100, expiries: { [E]: { futuresPrice: 101, callStrikes: [100], putStrikes: [100], quotes: {} } } }
} };
// a live book only for 22600 PE: 22300 PE has a settled price but no book, so in session it is refused as stale
const liveQuoteFor = (s, e, k, t) => (s === "NIFTY" && e === E && k === 22600 && t === "PE" ? { bid: 388, ask: 392, executable: true } : null);
const r = screenContracts({ reference, bullish: { NIFTY: false }, requireView: true, banned: ["AAA"], now, marketOpen: true, liveQuoteFor });
const n = r.bySymbol.NIFTY;
assert.ok(n, "NIFTY has a tally");
assert.strictEqual(n.refused.expiryWindow, 2, "the 13 Oct weekly (5 days) is outside the 7-day minimum: both its strikes");
assert.strictEqual(n.refused.noDirection, 1, "the call is refused in a downtrend (puts only)");
assert.strictEqual(n.examined, 3, "the three 27 Oct puts are examined");
assert.strictEqual(n.refused.illiquid, 1, "22000 PE: volume 20 < 100");
assert.strictEqual(n.refused.staleDuringSession, 1, "22300 PE: no live book in session");
const examinedRefusals = Object.entries(n.refused).filter(([k]) => !["expiryWindow", "noDirection", "banned", "resultsBeforeExit"].includes(k)).reduce((a, [, v]) => a + v, 0);
assert.strictEqual(n.survived + examinedRefusals, n.examined, "every examined contract is either cleared or refused once");
assert.strictEqual(r.bySymbol.AAA.refused.banned, 2, "a banned name's strikes are counted against it");
assert.strictEqual(r.survived, Object.values(r.bySymbol).reduce((a, b) => a + b.survived, 0), "per-name survivors add up to the total");
console.log(`screener bySymbol tests passed (NIFTY: ${n.examined} examined, ${n.survived} cleared, refused ${JSON.stringify(n.refused)})`);
