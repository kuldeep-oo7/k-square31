"use strict";

const assert = require("assert");
const fs = require("node:fs");
const path = require("node:path");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const { TradeLedger } = require("../api/_lib/db-ledger");

console.log("Starting Native SQLite Database Engine test suite...");

const TEST_DB_PATH = path.resolve(__dirname, "../.private/test-k2-trading.db");
const TEST_JSON_PATH = path.resolve(__dirname, "../.private/test-trade-ledger.json");

// Clean test artifacts if present
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
if (fs.existsSync(TEST_JSON_PATH)) fs.unlinkSync(TEST_JSON_PATH);

// 1. Initialize SQLite Database
const db = new SqliteTradingDatabase(TEST_DB_PATH);

// Check WAL mode
const journalMode = db.db.prepare("PRAGMA journal_mode;").get();
assert(journalMode.journal_mode.toLowerCase() === "wal", "Database must use WAL journal mode, got: " + journalMode.journal_mode);
console.log("  ✓ SQLite Engine initialized with WAL (Write-Ahead Logging) mode verified");

// 2. A fresh ledger starts empty.
// This block previously asserted a seeded account at +Rs 29,078.10 over 8 trades
// at a 75% win rate, and a closed-trade ledger containing specific ABB and BEL
// fills. None of those trades were ever placed; the constructor wrote them. A
// test that requires invented performance to be present will also defend it.
const summary = db.getSummary();
assert(summary.realizedPnl === 0, "A fresh ledger has no realized P&L, got: " + summary.realizedPnl);
assert(summary.totalTrades === 0, "A fresh ledger has no trades, got: " + summary.totalTrades);
assert(summary.winCount === 0 && summary.lossCount === 0, "A fresh ledger has no wins or losses");
assert(summary.winRatePct === null, "A fresh ledger has no win rate, got: " + summary.winRatePct);
assert(summary.hasTrackRecord === false, "A fresh ledger must declare it has no track record");
assert(summary.initialCapital > 0, "Initial capital is configuration and may be set");
console.log("  ✓ Fresh account reports zero history and a null win rate (no seeded performance)");

// 3. Completed trades ledger starts empty.
const completed = db.getCompletedTrades();
assert(Array.isArray(completed) && completed.length === 0, "A fresh ledger has no completed trades, got: " + completed.length);
console.log("  ✓ Completed-trade ledger starts empty");

// 4. Open Position & Close Position Lifecycle (ACID Transaction)
const sampleCandidate = {
  id: "CAN-TRENT-01",
  symbol: "TRENT",
  tradingSymbol: "TRENT",
  assetClass: "EQUITY",
  action: "BUY",
  lotSize: 50,
  entryPrice: 2750.00,
  target1: 2850.00,
  target2: 2950.00,
  stopLoss: 2690.00,
  capitalRequired: 137500
};

const pos = db.openPosition(sampleCandidate, 2750.00);
assert(pos.status === "ACTIVE", "Position status must be ACTIVE");
const activePositions = db.getActivePositions();
assert(activePositions.some(p => p.symbol === "TRENT"), "TRENT must be present in active positions");
console.log("  ✓ Position open lifecycle verified (Position ID:", pos.id + ")");

// Close position at target ₹2,850 (+₹100/sh * 50 sh = +₹5,000)
const closeResult = db.closePosition(pos.id, 2850.00, "TARGET 1 HIT");
assert(closeResult.isWin === true, "Trade must be marked as win");
assert(closeResult.realizedPnl === 5000.00, "Realized P&L must be +5000.00, got: " + closeResult.realizedPnl);

// Verify atomic balance update in account
const updatedSummary = db.getSummary();
assert(updatedSummary.realizedPnl === 5000.00, "Account balance must atomically increase by +₹5,000, got: " + updatedSummary.realizedPnl);
assert(updatedSummary.totalTrades === 1, "Total trades must increment to 1, got: " + updatedSummary.totalTrades);
assert(updatedSummary.winCount === 1, "Win count must increment to 1, got: " + updatedSummary.winCount);
assert(updatedSummary.winRatePct === 100, "One win out of one trade is 100%, got: " + updatedSummary.winRatePct);
assert(updatedSummary.hasTrackRecord === true, "A closed trade creates a track record");
console.log("  ✓ Position close transaction verified (Updated Realized P&L: ₹" + updatedSummary.realizedPnl + ")");

// 5. Time-Series Tick Insertion & Query
db.recordTick({
  symbol: "ABB",
  price: 7095.50,
  volume: 18500,
  neuralScore: 92,
  candlestickPattern: "BULLISH_ENGULFING",
  chartPattern: "DOUBLE_BOTTOM"
});
const tickRow = db.db.prepare("SELECT * FROM ticks_history WHERE symbol = 'ABB' ORDER BY id DESC LIMIT 1").get();
assert(tickRow.price === 7095.50, "Recorded tick price must match");
assert(tickRow.neural_score === 92, "Recorded neural score must match");
console.log("  ✓ High-frequency Time-Series Tick recording verified (Symbol: ABB @ ₹" + tickRow.price + ")");

// 6. Time-Series Macro Snapshot
db.recordMacroSnapshot({
  giftNifty: 23285,
  indiaVix: 12.45,
  brentCrude: 104.20,
  sp500Futures: 7685,
  severity: "NORMAL",
  directive: "STANDARD_EXECUTION"
});
const macroRow = db.db.prepare("SELECT * FROM macro_snapshots ORDER BY id DESC LIMIT 1").get();
assert(macroRow.gift_nifty === 23285, "Macro GIFT Nifty must match");
console.log("  ✓ Macro Volatility Snapshot recording verified");

db.close();

// 7. TradeLedger SQLite integration and JSON Mirror Sync
const ledger = new TradeLedger(TEST_DB_PATH, TEST_JSON_PATH);
const ledgerSummary = ledger.getSummary();
assert(ledgerSummary.realizedPnl === updatedSummary.realizedPnl, "TradeLedger summary must match SQLite");
assert(fs.existsSync(TEST_JSON_PATH), "JSON mirror must be generated");
const mirrorContent = JSON.parse(fs.readFileSync(TEST_JSON_PATH, "utf8"));
assert(mirrorContent.databaseType.includes("SQLite"), "Mirror must state SQLite backing");
console.log("  ✓ TradeLedger & JSON Mirror Sync verified");

// Close database handle before unlinking on Windows
ledger.sqlite.close();

// Clean test artifacts
if (fs.existsSync(TEST_DB_PATH)) {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}
if (fs.existsSync(TEST_JSON_PATH)) {
  try { fs.unlinkSync(TEST_JSON_PATH); } catch {}
}

console.log("ALL Native SQLite Database Engine tests passed successfully!\n");
