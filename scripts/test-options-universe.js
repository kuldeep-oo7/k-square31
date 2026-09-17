"use strict";

const assert = require("assert");
const fs = require("node:fs");
const path = require("node:path");
const { fnoUniverseEngine } = require("../api/_lib/universe-210");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const { TradeLedger } = require("../api/_lib/db-ledger");

console.log("Starting Full-Market Options & Signal Accuracy test suite...");

// 1. Test Whole Market Options Universe
const options = fnoUniverseEngine.getOptionsUniverse();
assert(Array.isArray(options), "Options universe must be an array");
assert(options.length >= 420, `Expected at least 420 option contracts across 210 stocks + indices, got: ${options.length}`);
console.log(`  ✓ Whole Market Options coverage verified (${options.length} Call & Put contracts generated)`);

// 2. Check Index Options (NIFTY & BANKNIFTY)
const niftyCe = options.find(o => o.id === "OPT-NIFTY-CE");
assert(niftyCe, "NIFTY CE option contract must be present");
assert(niftyCe.executiveVerdict === "MUST_READ_AND_BUY", "NIFTY CE must be MUST_READ_AND_BUY");
assert(niftyCe.lotSize === 25, "NIFTY lot size must be 25");
assert(niftyCe.strategy && niftyCe.strategy.name === "Bull Call Spread", "NIFTY CE must have defined-risk spread");
assert(niftyCe.links && niftyCe.links.zerodhaOrderPreview && niftyCe.links.dhanApp, "1-Tap broker links must be present");
console.log("  ✓ Benchmark Index Defined-Risk Options verified (NIFTY & BANKNIFTY)");

// 3. Check Stock Options (Both CE and PE)
const relianceCe = options.find(o => o.symbol === "RELIANCE" && o.optionType === "CE");
assert(relianceCe, "RELIANCE CE must be present");
assert(relianceCe.entryPrice > 0, "RELIANCE CE must have valid entry premium");
assert(relianceCe.target1 > relianceCe.entryPrice, "Target 1 must be higher than entry");
assert(relianceCe.stopLoss < relianceCe.entryPrice, "Stop loss must be lower than entry");
assert(relianceCe.daysActiveFormatted, "Days active formatted must be present");
assert(relianceCe.followPnl, "Follow P&L object must be present");

const reliancePe = options.find(o => o.symbol === "RELIANCE" && o.optionType === "PE");
assert(reliancePe, "RELIANCE PE must be present");
assert(reliancePe.executiveVerdict === "IGNORE", "RELIANCE PE must be IGNORE during normal regime");
console.log("  ✓ Equity Call & Put pairs verified across 210 F&O universe");

// 3b. Data provenance: a row may not be recommended on invented inputs.
//
// Measured on 2026-09-17, before this gate existed: of 210 symbols, 120 carried
// a price derived from a hash of the symbol name, 40 came from a hand-written
// baseline table that had TATASTEEL at 152.40 against a traded 187.29, and the
// 30-bar "history" every score was computed from was a linear ramp with a sine
// ripple. 49 of the 49 rows holding a real spot then cleared the conviction
// hurdle -- a 98% pass rate, because the synthetic curve looks alike for every
// name. These assertions keep a verdict from being issued on that basis again.
const provenanceUniverse = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false });
assert(provenanceUniverse.length > 100, "Universe must be populated");
for (const row of provenanceUniverse) {
  assert(typeof row.priceSource === "string" && row.priceSource.length > 0,
    `${row.symbol} must declare where its price came from`);
  if (row.historicalBarsAreSynthetic || !row.hasObservedPrice) {
    assert(row.tradeable === false,
      `${row.symbol} has ${row.hasObservedPrice ? "synthetic history" : "no observed price"} and must not be tradeable`);
    assert(row.action === "STAND_ASIDE",
      `${row.symbol} must stand aside without real inputs, got: ${row.action}`);
    assert(row.executiveVerdict !== "MUST_READ_AND_BUY",
      `${row.symbol} must never be advertised as a buy on synthetic inputs`);
  }
  if (row.quant && row.quant.computed === false) {
    assert(row.quant.vpin === null && row.quant.hurst === null && row.quant.halfLife === null,
      `${row.symbol} must report null for uncomputed quant statistics rather than a placeholder number`);
  }
}
const actionable = provenanceUniverse.filter((r) => r.action === "BUY" || r.action === "ACCUMULATE");
const actionableWithoutData = actionable.filter((r) => r.historicalBarsAreSynthetic || !r.hasObservedPrice);
assert(actionableWithoutData.length === 0,
  `No row may be actionable without real price and history; found ${actionableWithoutData.length}`);
console.log(`  ✓ Data provenance enforced (${provenanceUniverse.length} symbols; ${actionable.length} actionable, none on synthetic inputs)`);

// 4. Test SQLite Signals Lifecycle & Accuracy Scorecard
const TEST_DB = path.resolve(__dirname, "../.private/test-options-accuracy.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

const db = new SqliteTradingDatabase(TEST_DB);

// A brand-new ledger has traded nothing and must say so. This assertion used to
// read the opposite way: it required a >= 70% win rate and exactly 5 wins from
// rows the constructor inserted, so the suite certified an invented track record
// as "Audited Signal Accuracy verified".
const fresh = db.getSignalsAccuracy();
assert(fresh.hasTrackRecord === false, "A fresh ledger must report no track record");
assert(fresh.winRatePct === null, `Win rate must be null with no closed signals, got: ${fresh.winRatePct}`);
assert(fresh.profitFactor === null, `Profit factor must be null with no losses to divide by, got: ${fresh.profitFactor}`);
assert(fresh.totalFollowPnl === null, "Total P&L must be null with no closed signals");
assert(fresh.avgDaysOnScreen === null, "Average holding time must be null with no closed signals");
assert(fresh.winCount === 0 && fresh.lossCount === 0, "A fresh ledger counts nothing");
assert(Array.isArray(fresh.archived) && fresh.archived.length === 0, "A fresh ledger archives nothing");
const freshSummary = db.getSummary();
assert(freshSummary.realizedPnl === 0, `A fresh account has no realized P&L, got: ${freshSummary.realizedPnl}`);
assert(freshSummary.totalTrades === 0, `A fresh account has no trades, got: ${freshSummary.totalTrades}`);
assert(freshSummary.winRatePct === null, "A fresh account has no win rate");
console.log("  ✓ Fresh ledger honestly reports no track record (no seeded performance)");

// Accuracy arithmetic, computed over signals this test inserts itself.
function closedSignal(id, entry, exit, lot, days) {
  db.recordOrUpdateSignal({
    id, symbol: id, tradingSymbol: `${id}26SEPFUT`, assetClass: "FUTURES", side: "BUY",
    lotSize: lot, entryPrice: entry, currentPrice: entry, target1: entry * 1.02,
    target2: entry * 1.05, stopLoss: entry * 0.99,
    issuedAt: new Date(Date.now() - days * 86400000).toISOString(), horizonDays: 5
  });
  db.archiveSignal(id, exit, exit >= entry ? "TARGET 1 ACHIEVED" : "STOP LOSS HIT");
}
closedSignal("WINA", 100, 103, 100, 1);   // +300
closedSignal("WINB", 200, 206, 100, 3);   // +600
closedSignal("LOSA", 100, 98, 100, 1);    // -200

const measured = db.getSignalsAccuracy();
assert(measured.winCount === 2, `Expected 2 wins, got: ${measured.winCount}`);
assert(measured.lossCount === 1, `Expected 1 loss, got: ${measured.lossCount}`);
// The old implementation ran two independent filters, so a signal could land in
// both counts and the total could exceed the number of signals on the books.
assert(
  measured.winCount + measured.lossCount === measured.archived.length,
  `Every closed signal must be counted exactly once: ${measured.winCount}W + ${measured.lossCount}L != ${measured.archived.length} archived`
);
assert(measured.totalSignals === 3, `Expected 3 classified signals, got: ${measured.totalSignals}`);
assert(Math.abs(measured.winRatePct - 66.7) < 0.2, `Expected 66.7% win rate, got: ${measured.winRatePct}%`);
assert(Math.abs(measured.grossWins - 900) < 1, `Expected gross wins 900, got: ${measured.grossWins}`);
assert(Math.abs(measured.grossLoss - 200) < 1, `Expected gross loss 200, got: ${measured.grossLoss}`);
assert(Math.abs(measured.profitFactor - 4.5) < 0.05, `Expected profit factor 4.50, got: ${measured.profitFactor}`);
assert(Math.abs(measured.totalFollowPnl - 700) < 1, `Expected net P&L 700, got: ${measured.totalFollowPnl}`);
console.log(`  ✓ Accuracy arithmetic verified on self-inserted signals (${measured.winRatePct}% | PF ${measured.profitFactor} | net ₹${measured.totalFollowPnl})`);

// With wins and no losses the ratio is undefined, not a large number produced by
// flooring the denominator at one rupee.
const LOSSLESS_DB = path.resolve(__dirname, "../.private/test-lossless.db");
for (const f of [LOSSLESS_DB, LOSSLESS_DB + "-wal", LOSSLESS_DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
const db2 = new SqliteTradingDatabase(LOSSLESS_DB);
db2.recordOrUpdateSignal({
  id: "ONLYWIN", symbol: "ONLYWIN", tradingSymbol: "ONLYWIN26SEPFUT", assetClass: "FUTURES",
  side: "BUY", lotSize: 100, entryPrice: 100, currentPrice: 100, target1: 102, target2: 105,
  stopLoss: 99, issuedAt: new Date().toISOString(), horizonDays: 5
});
db2.archiveSignal("ONLYWIN", 105, "TARGET 1 ACHIEVED");
const lossless = db2.getSignalsAccuracy();
assert(lossless.profitFactor === null, `Profit factor must be null with zero losses, got: ${lossless.profitFactor}`);
assert(lossless.winRatePct === 100, `Expected 100% win rate, got: ${lossless.winRatePct}`);
db2.close();
for (const f of [LOSSLESS_DB, LOSSLESS_DB + "-wal", LOSSLESS_DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
console.log("  ✓ Profit factor is undefined rather than fabricated when there are no losses");

// 5. Test Dynamic Signal Lifecycle: Record and Archive
db.recordOrUpdateSignal({
  id: "SIG-TEST-01",
  symbol: "INFY",
  tradingSymbol: "INFY26SEP1900CE",
  assetClass: "CALL_OPTION",
  side: "BUY",
  optionType: "CE",
  strike: 1900,
  lotSize: 400,
  entryPrice: 32.50,
  currentPrice: 35.00,
  target1: 41.20,
  target2: 52.00,
  stopLoss: 16.00,
  issuedAt: new Date().toISOString(),
  horizonDays: 5
});

const activeSig = db.getActiveSignals().find(s => s.id === "SIG-TEST-01");
assert(activeSig, "Active signal must be recorded");

// Archive upon hitting target
const closedSig = db.archiveSignal("SIG-TEST-01", 41.20, "TARGET 1 ACHIEVED");
assert(closedSig && closedSig.newStatus === "TARGET_HIT", "Closed status must be TARGET_HIT");
assert(closedSig.pnlRupees > 0, "Profit must be positive");
console.log("  ✓ Signal Lifecycle transition (ACTIVE -> TARGET_HIT) verified");

db.close();
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

console.log("ALL Full-Market Options & Signal Accuracy tests passed successfully!\n");
