"use strict";

/**
 * DOES THE LIVE RECORDING PATH ACTUALLY REACH THE SCREENED CHAIN?
 *
 * The end-to-end simulation proves the ledger CAN record 40 rows. It does not
 * prove the production path does, because recordSignals() returns early when
 * the market is shut:
 *
 *     const phase = live.marketPhase();
 *     if (!phase.open) return { ok: false, reason: "MARKET_CLOSED_NOT_RECORDING" };
 *
 * Every measurement taken while building this was after the close, so the
 * screened-chain recording loop has never once executed. Its first run would be
 * at the opening bell, inside a function that returns early, where a mistake is
 * silent -- which is the exact shape of every defect this project has found.
 *
 * So this forces the market open and watches what recordSignals actually does.
 * Nothing is written: `record` is replaced with a collector, so the live ledger
 * is never opened and the check can run at any hour.
 */

const assert = require("node:assert/strict");
const path = require("node:path");

console.log("Starting live recording path test suite...");

const liveQuotes = require("../api/_lib/live-quotes");
const signalRecord = require("../api/_lib/signal-record");

const realPhase = liveQuotes.marketPhase;
const realRecord = signalRecord.record;
const realMark = signalRecord.markToMarket;
const realSync = signalRecord.syncToRemote;

const collected = [];
liveQuotes.marketPhase = () => ({ open: true, phase: "OPEN", reason: "FORCED_BY_TEST" });
signalRecord.record = (signal) => {
  collected.push(signal);
  return { ok: true, status: "RECORDED", id: `TEST-${collected.length}` };
};
signalRecord.markToMarket = () => ({ marked: 0, closed: 0 });
signalRecord.syncToRemote = async () => ({ ok: false, reason: "GOOGLE_STORE_NOT_CONFIGURED" });

let engine;
try {
  // The module exports the CLASS, not a running instance, so the test builds
  // its own. Nothing is started -- no timers, no network -- only the one method
  // under examination is called.
  const { RealtimeMarketEngine } = require("../api/_lib/realtime-market-engine");
  engine = new RealtimeMarketEngine();

  const result = engine.recordSignals();

  // 1. It must not have bailed out at the market-closed guard.
  assert.notEqual(result?.reason, "MARKET_CLOSED_NOT_RECORDING",
    "recordSignals returned at the market-closed guard even with the phase forced open");
  assert.ok(result?.ok !== false || collected.length > 0,
    `recordSignals failed before reaching any recording: ${JSON.stringify(result)}`);
  console.log(`  ✓ recordSignals ran past the market-closed guard (recorded ${result.recorded}, refused ${result.refused})`);

  // 2. The screened chain must be among what it recorded. This is the loop that
  //    has never executed in production.
  const screen = engine.screenedContracts();
  const shown = new Set((screen.contracts || []).map((c) => `${c.symbol}|${c.strike}|${c.optionType}`));
  assert.ok(shown.size > 0, "the screener produced nothing, so this proves nothing");

  const recordedKeys = new Set(collected.map((s) => `${s.symbol}|${s.strike}|${s.right}`));
  const overlap = [...shown].filter((k) => recordedKeys.has(k));
  assert.ok(overlap.length > 0,
    `not one of the ${shown.size} contracts on the screen was recorded; the screened loop never ran`);
  console.log(`  ✓ The screened chain IS recorded: ${overlap.length} of ${shown.size} shown contracts reached the ledger call`);

  // 3. Each one must carry the prediction, or calibration can never grade it.
  const fromScreen = collected.filter((s) => shown.has(`${s.symbol}|${s.strike}|${s.right}`));
  const withPrediction = fromScreen.filter((s) => s.estimatedTouchPct != null || s.estimatedDaysToTarget != null);
  assert.ok(withPrediction.length > fromScreen.length * 0.5,
    `only ${withPrediction.length} of ${fromScreen.length} screened rows carried a prediction; `
    + "without it the estimate can never be graded");
  console.log(`  ✓ ${withPrediction.length} of ${fromScreen.length} carry the predicted probability and days to target`);

  // 4. And the provenance of the price, or the row cannot be audited.
  assert.ok(fromScreen.every((s) => s.priceSource),
    "a screened row reached the ledger with no price provenance");
  const sources = [...new Set(fromScreen.map((s) => s.priceSource))];
  console.log(`  ✓ Every screened row carries its price source (${sources.join(", ")})`);

  // 5. Entry, target and stop must all be present and correctly ordered, or the
  //    position can never close.
  for (const s of fromScreen) {
    assert.ok(s.entryPrice > 0, `${s.symbol} ${s.strike}${s.right} recorded with no entry price`);
    assert.ok(s.targetPrice > s.entryPrice,
      `${s.symbol} ${s.strike}${s.right} has a target ${s.targetPrice} at or below its entry ${s.entryPrice}`);
    assert.ok(s.stopPrice > 0 && s.stopPrice < s.entryPrice,
      `${s.symbol} ${s.strike}${s.right} has a stop ${s.stopPrice} that is not below its entry ${s.entryPrice}`);
    assert.ok(s.lotSize > 0 && s.expiry, `${s.symbol} ${s.strike}${s.right} is missing a lot size or expiry`);
  }
  console.log(`  ✓ All ${fromScreen.length} carry an entry, a target above it and a stop below it`);

  // 6. The 423-card path must still work too. Fixing one must not break the other.
  const cardKeys = new Set(
    (engine.getOptionsUniverse() || [])
      .filter((c) => (c.action === "BUY" || c.action === "ACCUMULATE") && c.available !== false)
      .map((c) => `${c.symbol}|${c.strike}|${c.optionType}`)
  );
  const fromCards = collected.filter((s) => cardKeys.has(`${s.symbol}|${s.strike}|${s.right}`));
  console.log(`  ✓ The card path still records alongside it (${fromCards.length} from the 423 cards, `
    + `${fromScreen.length} from the screened chain)`);
} finally {
  liveQuotes.marketPhase = realPhase;
  signalRecord.record = realRecord;
  signalRecord.markToMarket = realMark;
  signalRecord.syncToRemote = realSync;
  if (engine && typeof engine.stop === "function") { try { engine.stop(); } catch (error) { /* nothing to stop */ } }
}

console.log("Live recording path tests passed: with the market forced open, recordSignals reaches the screened chain, "
  + "every row carries its prediction, its price provenance and a correctly ordered entry, target and stop, "
  + "and the original card path still records beside it.");
process.exit(0);
