"use strict";
const assert = require("node:assert/strict");
const { dailyRecommendationAudit } = require("../api/_lib/daily-recommendation-audit");
const { parseCsv, buildCatalogue, directoryFromCatalogue } = require("../api/_lib/indian-instruments");
const now = Date.parse("2026-09-15T12:30:00Z"), issuedAt = "2026-09-14T04:00:00Z";
const r = { id: "signal-1", issuedAt, strategyVersion: "test-only" };
const o = { recommendationId: r.id, status: "CLOSED", source: "USER_CONFIRMED", entryFillId: "E", exitFillId: "X", filledAt: issuedAt,
  exitAt: "2026-09-15T05:00:00Z", grossPnlInr: 100, feesInr: 20, netPnlInr: 80 };
assert.equal(dailyRecommendationAudit({ now }).groups.USER_CONFIRMED.winRatePct, null);
const result = dailyRecommendationAudit({ now, recommendations: [r], outcomes: [o] });
assert.equal(result.acceptedOutcomes, 1);
assert.equal(result.groups.USER_CONFIRMED.netPnlInr, 80);
assert.equal(result.groups.BROKER_RECONCILED.completedTrades, 0);
assert.equal(result.automaticModelPromotion, false);
assert.equal(dailyRecommendationAudit({ now, recommendations: [r], outcomes: [o], previous: result }).newlyClosedCount, 0);
for (const change of [{ status: "OPEN" }, { source: "GUESSED_FROM_TOUCH" }, { feesInr: null }, { filledAt: "2020-01-01" }, { exitAt: "2099-01-01" }, { netPnlInr: 100 }]) {
  assert.equal(dailyRecommendationAudit({ now, recommendations: [r], outcomes: [{ ...o, ...change }] }).acceptedOutcomes, 0);
}
assert.equal(dailyRecommendationAudit({ now, recommendations: [r, r], outcomes: [o] }).acceptedOutcomes, 0);
assert.equal(dailyRecommendationAudit({ now, recommendations: [r], outcomes: [o, o] }).acceptedOutcomes, 0);
assert.deepEqual(parseCsv('a,b\n"x,y","a""b"\n'), [{ a: "x,y", b: 'a"b' }]);
assert.throws(() => parseCsv('a,b\n"unterminated,b'), /Unterminated/);
const header = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n";
const sources = ["NSE", "BSE", "NFO", "BFO"].map((exchange, i) => ({ exchange, url: `fixture:${exchange}`, csv: header +
  (i < 2 ? `${i + 1},1,TEST,TEST COMPANY,0,,0,0.05,1,EQ,${exchange},${exchange}\n` : `${i + 1},1,TEST26SEP100CE,TEST,0,2026-09-29,100,0.05,50,CE,${exchange}-OPT,${exchange}\n`) }));
const catalog = buildCatalogue(sources, now), dir = directoryFromCatalogue(catalog, [{ symbol: "KEPT", name: "Original" }]);
assert.equal(dir.cashListings, 3);
assert.equal(dir.derivativeContracts, 2);
assert.equal(dir.sourceTimestampVerified, false);
assert.equal(dir.derivatives.length, 2, "Venue identity must not collapse across exchanges");
assert.throws(() => buildCatalogue(sources.slice(1), now), /Incomplete/);
assert.throws(() => buildCatalogue([...sources, sources[0]], now), /Duplicate/);
console.log("Daily audit and catalogue tests passed: immutable IDs, mature confirmed outcomes, fee/time checks, duplicates, no automatic promotion, venue identities and CSV quoting.");
