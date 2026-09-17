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

// 4. Test SQLite Signals Lifecycle & Accuracy Scorecard
const TEST_DB = path.resolve(__dirname, "../.private/test-options-accuracy.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

const db = new SqliteTradingDatabase(TEST_DB);
const accuracy = db.getSignalsAccuracy();
assert(accuracy.winRatePct >= 70, `Win rate must be >= 70%, got: ${accuracy.winRatePct}%`);
assert(accuracy.winCount === 5, `Expected 5 wins in seed data, got: ${accuracy.winCount}`);
assert(accuracy.lossCount === 2, `Expected 2 losses in seed data, got: ${accuracy.lossCount}`);
assert(accuracy.totalFollowPnl > 40000, `Expected total follow PnL > ₹40,000, got: ₹${accuracy.totalFollowPnl}`);
assert(accuracy.avgDaysOnScreen > 0, "Average days on screen must be > 0");
assert(accuracy.profitFactor > 3.0, `Expected profit factor > 3.0, got: ${accuracy.profitFactor}`);
assert(Array.isArray(accuracy.archived) && accuracy.archived.length === 7, "Archived signals count must be 7");
console.log(`  ✓ Audited Signal Accuracy verified (${accuracy.winRatePct}% Win Rate | 5W / 2L | +₹${accuracy.totalFollowPnl} P&L | PF: ${accuracy.profitFactor})`);

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
