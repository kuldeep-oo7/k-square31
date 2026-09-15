"use strict";

const assert = require("node:assert/strict");
const {
  accountReconciliation,
  closeShadowPosition,
  emptyShadowLedger,
  normalizeLedger,
  openShadowPosition,
  positionReconciliation,
  rebaseMondayPosition,
  recordFridaySettlement,
  settleShadowPosition
} = require("../api/_lib/shadow-ledger");
const { generateContractNote, simulateExecutionFill } = require("../api/_lib/shadow-broker");

const ledger = emptyShadowLedger(1_000_000);
const orderIntent = {
  executable: true,
  clientOrderId: "K2_TATASTEEL_L1",
  strategyVersion: "continuous-futures-v2",
  symbol: "TATASTEEL",
  sector: "METALS",
  contractSymbol: "TATASTEEL26SEPFUT",
  instrumentId: "NSE-FO-TATASTEEL-SEP",
  expiry: "2026-09-29",
  side: "long",
  orderType: "LIMIT",
  entryPrice: 150,
  targetPrice: 153,
  stopLossPrice: 147,
  lotSize: 5500,
  lots: 1,
  quantity: 5500,
  tickSize: 0.01,
  estMarginRequired: 181500,
  marginSource: "CONSERVATIVE_ESTIMATE"
};

const entryFill = simulateExecutionFill({
  orderIntent,
  currentQuote: {
    timestamp: Date.parse("2026-08-24T10:00:00Z"),
    open: 150.5, high: 151, low: 149.99, close: 150.2
  },
  asOfDate: "2026-08-24"
});
assert.equal(entryFill.status, "FILLED");
assert.equal(entryFill.fillPrice, 150);
const opened = openShadowPosition(ledger, { orderIntent, fillDetails: entryFill, weekKey: "2026-08-24", level: 1 });
assert.equal(opened.opened, true);
assert.equal(openShadowPosition(ledger, { orderIntent, fillDetails: entryFill, weekKey: "2026-08-24", level: 1 }).opened, false);

const position = opened.position;
assert.equal(settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: 151, session: "2026-08-25" }).variationPnl, 5500);
assert.equal(settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: 151, session: "2026-08-25" }).idempotent, true);
assert.equal(settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: 151.5, session: "2026-08-28" }).variationPnl, 2750);
recordFridaySettlement(position, 151.5, "2026-08-28");

const beforeRebase = {
  equity: ledger.accountEquity,
  original: position.originalEntryPrice,
  quantity: position.quantity,
  side: position.side,
  contract: position.contractSymbol,
  variation: position.cumulativeVariationPnl
};
const rebased = rebaseMondayPosition(position, 152, "2026-08-31");
assert.equal(rebased.rebased, true);
assert.equal(position.weeklyReferencePrice, 152);
assert.equal(position.weekendGapPnl, 2750);
assert.deepEqual({
  equity: ledger.accountEquity,
  original: position.originalEntryPrice,
  quantity: position.quantity,
  side: position.side,
  contract: position.contractSymbol,
  variation: position.cumulativeVariationPnl
}, beforeRebase, "Monday reference reset must not alter economic/accounting state");
assert.equal(positionReconciliation(position, 152).reconciled, true);

assert.equal(settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: 152, session: "2026-08-31" }).variationPnl, 2750);
const exitFill = simulateExecutionFill({
  orderIntent: { ...orderIntent, clientOrderId: "K2_TATASTEEL_EXIT", side: "sell", orderType: "MARKET", entryPrice: 153 },
  currentQuote: { timestamp: Date.parse("2026-09-01T10:00:00Z"), bid: 153, ask: 153.01 },
  asOfDate: "2026-09-01"
});
const note = generateContractNote({
  tradeId: position.tradeId,
  entryFill,
  exitFill,
  contract: { expiry: orderIntent.expiry, estMarginRequired: orderIntent.estMarginRequired },
  settlementDate: "2026-09-01"
});
const closed = closeShadowPosition(ledger, { tradeId: position.tradeId, exitFill, contractNote: note, reason: "TARGET_HIT" });
assert.equal(closed.closed, true);
assert.equal(ledger.positions.length, 0);
assert.equal(ledger.closedTrades.length, 1);
assert.equal(ledger.contractNotes.length, 1);
assert.equal(accountReconciliation(ledger).reconciled, true);
assert.equal(closed.closedRecord.positionReconciliation.reconciled, true);
assert.equal(closed.closedRecord.contractNoteDifference, 0);
assert.equal(ledger.availableMargin, ledger.accountEquity);
const corrupted = structuredClone(ledger);
corrupted.accountEquity += 5000;
const loaded = normalizeLedger(corrupted);
assert.equal(loaded.killSwitch.triggered, true, "Loading a discrepancy must lock new risk");
assert.equal(loaded.accounting.migrationAdjustment, 0, "No balancing plug may erase the discrepancy");
assert.equal(accountReconciliation(loaded).reconciled, false);

console.log("Shadow-operations tests passed: real production ledger open, daily variation settlement, Friday carry, Monday invariance, close, fees and reconciliation");
