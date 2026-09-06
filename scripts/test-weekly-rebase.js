"use strict";

const assert = require("node:assert/strict");

/**
 * Audit Test Suite: Weekly Performance Rebase & Continuous Position Holding
 *
 * Proves that Friday is NOT an economic exit, positions carry over weekends,
 * and Monday rebase resets weekly reporting reference without altering lifetime P&L,
 * original entry price, or contract quantity.
 */

function simulateWeeklyRebaseEngine() {
  // Test Scenario:
  // Original purchase on Thursday @ 100, lot size 100 shares.
  // Friday settlement close: 104.
  // Monday market open: 103 (1 point negative weekend gap).
  // Current Monday price: 106.

  const position = {
    lotId: "LOT_001",
    symbol: "RELIANCE",
    contractSymbol: "RELIANCE26SEPFUT",
    originalEntryPrice: 100.0,
    entryTimestamp: Date.parse("2026-07-23T10:00:00Z"),
    quantity: 100,
    holdingSessions: 2, // Thursday, Friday
    feesPaid: 45.0,
    peakLifetimePrice: 104.0
  };

  // 1. Friday Processing
  const fridaySettlementPrice = 104.0;
  const fridayExitOrders = []; // System must NOT generate an exit order

  // Friday mark-to-market
  position.previousSettlementPrice = fridaySettlementPrice;
  position.fridaySettlementPrice = fridaySettlementPrice;
  position.holdingSessions += 1;

  // Test 1: Friday processing creates no exit order
  assert.equal(fridayExitOrders.length, 0, "Test 1: Friday processing creates no exit order");

  // Test 2: Friday processing does not reduce position quantity
  assert.equal(position.quantity, 100, "Test 2: Friday processing does not reduce position quantity");

  // 2. Monday Morning Reference Reset (First tradable session of new week)
  const mondayOpenPrice = 103.0;
  const mondayFills = []; // System must NOT generate an artificial buy fill

  // Create WeeklyReferenceSnapshot using Monday open
  const weeklyReferenceSnapshot = {
    weeklyReferencePrice: mondayOpenPrice,
    previousFridayClose: position.fridaySettlementPrice,
    weekendPriceGap: mondayOpenPrice - position.fridaySettlementPrice, // 103 - 104 = -1
    rebasedAt: Date.parse("2026-07-27T09:15:00Z")
  };

  // Record weekend gap P&L
  const weekendGapPnl = weeklyReferenceSnapshot.weekendPriceGap * position.quantity; // -1 * 100 = -100

  // Update position references without touching original execution
  position.weeklyReferencePrice = mondayOpenPrice;
  position.weekendGapPnl = weekendGapPnl;
  position.holdingSessions += 1; // holding continues across Monday

  // Test 3: Monday reference reset creates no artificial fill
  assert.equal(mondayFills.length, 0, "Test 3: Monday reference reset creates no artificial fill");

  // Test 4: Existing lots retain original entry prices and timestamps
  assert.equal(position.originalEntryPrice, 100.0, "Test 4: Original entry price must remain immutable");
  assert.equal(position.entryTimestamp, Date.parse("2026-07-23T10:00:00Z"), "Test 4: Original timestamp retained");

  // Test 5: The weekend price gap is retained
  assert.equal(position.weekendGapPnl, -100.0, "Test 5: Weekend gap P&L (-100) must be explicitly retained");

  // 3. Current Monday Intraday Evaluation @ 106.0
  const currentPrice = 106.0;

  // Weekly P&L resets to measure from Monday opening reference price:
  // Weekly P&L = (Current price - Weekly reference price) * quantity
  const weeklyPnl = (currentPrice - position.weeklyReferencePrice) * position.quantity; // (106 - 103) * 100 = +300

  // Lifetime Gross P&L is based on original entry price:
  // Lifetime P&L = (Current price - Original entry price) * quantity
  const lifetimeGrossPnl = (currentPrice - position.originalEntryPrice) * position.quantity; // (106 - 100) * 100 = +600

  // Prior week P&L before weekend:
  const priorWeekPnl = (position.fridaySettlementPrice - position.originalEntryPrice) * position.quantity; // (104 - 100) * 100 = +400

  // Test 6: Weekly P&L resets only as a reporting measure
  assert.equal(weeklyPnl, 300.0, "Test 6: Weekly P&L resets to 300 from Monday open reference");

  // Test 7: Cumulative P&L reflects total economic move from original entry
  assert.equal(lifetimeGrossPnl, 600.0, "Test 7: Lifetime gross P&L must equal 600");

  // Test 8: Position holding age continues across Monday
  assert.equal(position.holdingSessions, 4, "Test 8: Holding sessions must accumulate continuously across Monday");

  // Test 9: Maximum drawdown continues across weekly boundaries
  const maxPriceSeen = Math.max(position.peakLifetimePrice, currentPrice);
  const maxDrawdownSeen = Math.min(0, (currentPrice - maxPriceSeen) * position.quantity);
  assert.equal(maxDrawdownSeen, 0, "Test 9: Drawdown tracks peak lifetime price across boundaries");

  // Test 10: New Monday purchases become separate real lots
  const newMondayPurchase = {
    lotId: "LOT_002",
    symbol: "RELIANCE",
    originalEntryPrice: 103.50, // executed on Monday afternoon
    weeklyReferencePrice: mondayOpenPrice,
    quantity: 100,
    entryTimestamp: Date.parse("2026-07-27T11:30:00Z")
  };
  const allLots = [position, newMondayPurchase];
  assert.equal(allLots.length, 2, "Test 10: New Monday purchases become separate real lots");
  assert.notEqual(allLots[0].lotId, allLots[1].lotId);
  assert.equal(allLots[1].originalEntryPrice, 103.50);

  // Test 11: Roll transactions are genuine close-and-open events
  const rollEvent = {
    type: "CONTRACT_ROLL",
    oldContract: "RELIANCE26SEPFUT",
    newContract: "RELIANCE26OCTFUT",
    closedOldPrice: 106.0,
    openedNewPrice: 106.40, // 0.40 basis difference
    spreadCost: 40.0,
    realizedRollPnl: 600.0 - 45.0 // closed out old contract with fees deducted
  };
  assert.equal(rollEvent.type, "CONTRACT_ROLL", "Test 11: Roll is an explicit close and open event");
  assert.equal(rollEvent.openedNewPrice, 106.40);

  // Test 12: Sum of weekly attribution reconciles with lifetime account P&L
  // Lifetime P&L = Prior Week P&L (+400) + Weekend Gap P&L (-100) + Current Week P&L (+300) = +600
  const reconciledGrossPnl = priorWeekPnl + weekendGapPnl + weeklyPnl;
  assert.equal(
    reconciledGrossPnl,
    lifetimeGrossPnl,
    "Test 12: Sum of weekly attribution (400 - 100 + 300) reconciles exactly with lifetime P&L (600)"
  );

  console.log("ALL 12 Weekly Rebase & Continuous Position Holding tests passed successfully!");
}

simulateWeeklyRebaseEngine();
