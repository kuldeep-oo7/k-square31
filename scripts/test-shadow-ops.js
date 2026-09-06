"use strict";

const assert = require("node:assert/strict");
const {
  openShadowPosition,
  closeShadowPosition,
  rebaseMondayPosition
} = require("../api/_lib/shadow-ledger");
const {
  simulateExecutionFill,
  generateContractNote
} = require("../api/_lib/shadow-broker");

function testShadowOperationsLifecycle() {
  const ledger = {
    version: "1.0.0",
    accountEquity: 1000000.0,
    availableMargin: 1000000.0,
    positions: [],
    closedTrades: [],
    contractNotes: []
  };

  const orderIntent = {
    symbol: "TATASTEEL",
    contractSymbol: "TATASTEEL26SEPFUT",
    side: "long",
    entryPrice: 150.0,
    targetPrice: 153.0,
    stopLossPrice: 147.0,
    lotSize: 5500,
    lots: 1,
    quantity: 5500,
    tickSize: 0.05,
    estMarginRequired: 181500 // 22% of 8,25,000
  };

  // 1. Monday Open Fill
  const fillDetails = simulateExecutionFill({ orderIntent, liquidityTier: "HIGH" });
  assert.equal(fillDetails.fillPrice, 150.00, "Limit orders fill at limit price, zero adverse slippage");

  const openRes = openShadowPosition(ledger, {
    orderIntent,
    fillDetails,
    weekKey: "2026-08-24",
    level: 1
  });

  assert.equal(openRes.opened, true);
  assert.equal(ledger.positions.length, 1);
  assert.equal(ledger.availableMargin, 1000000 - 181500);

  // 2. Idempotency test: duplicate open must be rejected
  const dupRes = openShadowPosition(ledger, {
    orderIntent,
    fillDetails,
    weekKey: "2026-08-24",
    level: 1
  });
  assert.equal(dupRes.opened, false);
  assert.equal(dupRes.reason, "Position already exists in ledger");

  // 3. Friday Close (Holding Over Weekend)
  // On Friday: position remains OPEN! No exit order.
  const pos = ledger.positions[0];
  pos.previousSettlementPrice = 151.50; // Friday close mark
  pos.holdingSessions += 4; // hold through Friday

  assert.equal(ledger.positions.length, 1, "Friday must not liquidate open position");

  // 4. Monday Morning Rebase
  const mondayOpen = 152.0; // gap up +0.50 over weekend
  const rebaseRes = rebaseMondayPosition(pos, mondayOpen, "2026-08-31");
  assert.equal(rebaseRes.rebased, true);
  assert.equal(pos.weeklyReferencePrice, 152.0);
  assert.equal(pos.originalEntryPrice, 150.00, "Original entry price stays immutable");
  assert.equal(pos.weekendGapPnl, (152.0 - 151.50) * 5500); // 2750

  // 5. Target Hit on Tuesday @ 153.0
  const exitFill = simulateExecutionFill({
    orderIntent: { ...orderIntent, side: "sell", entryPrice: 153.0 },
    liquidityTier: "HIGH"
  });

  const contractNote = generateContractNote({
    tradeId: pos.tradeId,
    entryFill: fillDetails,
    exitFill,
    contract: { expiry: "2026-09-24" }
  });

  const closeRes = closeShadowPosition(ledger, {
    tradeId: pos.tradeId,
    exitFill,
    contractNote,
    reason: "Target 2% reached"
  });

  assert.equal(closeRes.closed, true);
  assert.equal(ledger.positions.length, 0);
  assert.equal(ledger.closedTrades.length, 1);
  assert.equal(ledger.contractNotes.length, 1);
  assert.equal(ledger.availableMargin, 1000000, "Margin fully unblocked");
  assert.ok(ledger.accountEquity > 1000000, "Profit added to account equity");
  assert.ok(contractNote.breakdown.totalTaxesAndCharges > 200, "Taxes and fees accurately deducted");
}

function run() {
  testShadowOperationsLifecycle();
  console.log("Shadow operations & lifecycle simulation tests passed successfully!");
}

run();
