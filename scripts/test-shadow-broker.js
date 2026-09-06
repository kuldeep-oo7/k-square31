"use strict";

const assert = require("node:assert");
const { calculateNseFuturesCharges, simulateExecutionFill, generateContractNote } = require("../api/_lib/shadow-broker");

function testNseFuturesCharges() {
  // Test Case 1: Buy 250 shares @ 3000 -> Turnover = 7,50,000
  const buyCharges = calculateNseFuturesCharges({
    side: "BUY",
    price: 3000,
    quantity: 250
  });

  assert.strictEqual(buyCharges.turnover, 750000);
  assert.strictEqual(buyCharges.brokerage, 20); // Flat 20
  assert.strictEqual(buyCharges.stt, 0); // No STT on buy side for futures
  assert.strictEqual(buyCharges.stampDuty, 15); // 0.002% on 7,50,000 = 15
  assert.strictEqual(buyCharges.exchangeCharges, 13.73); // 0.00183% = 13.73
  assert.strictEqual(buyCharges.ipft, 0.08); // IPFT Rs 0.01/crore = 0.08
  assert(buyCharges.gst >= 6.2 && buyCharges.gst <= 6.3); // 18% of (20 + 13.73 + 0.75 + 0.08) = 6.22
  assert(buyCharges.totalCharges > 55 && buyCharges.totalCharges < 60);

  // Test Case 2: Sell 250 shares @ 3060 -> Turnover = 7,65,000 with current 0.05% STT rate
  const sellCharges = calculateNseFuturesCharges({
    side: "SELL",
    price: 3060,
    quantity: 250
  });

  assert.strictEqual(sellCharges.turnover, 765000);
  assert.strictEqual(sellCharges.brokerage, 20);
  assert.strictEqual(sellCharges.stt, 383); // 0.05% of 7,65,000 = 382.5 -> 383
  assert.strictEqual(sellCharges.stampDuty, 0); // No stamp duty on sell side
  assert(sellCharges.totalCharges > 420 && sellCharges.totalCharges < 430);

  // Test Case 3: Dated STT support across historical rate revisions
  const preOct2024 = calculateNseFuturesCharges({ side: "SELL", price: 3060, quantity: 250, asOfDate: "2024-05-15" });
  assert.strictEqual(preOct2024.stt, 96); // 0.0125% = 95.6 -> 96

  const oct2024ToMar2026 = calculateNseFuturesCharges({ side: "SELL", price: 3060, quantity: 250, asOfDate: "2025-01-15" });
  assert.strictEqual(oct2024ToMar2026.stt, 153); // 0.02% = 153
}

function testExecutionSlippage() {
  const orderIntent = {
    symbol: "TCS",
    contractSymbol: "TCS26SEPFUT",
    side: "long",
    orderType: "LIMIT",
    entryPrice: 4200.00,
    lotSize: 175,
    lots: 1,
    quantity: 175,
    tickSize: 0.05
  };

  // Limit orders guarantee price certainty: never fill worse than limit price
  const fillLimit = simulateExecutionFill({ orderIntent, liquidityTier: "HIGH" });
  assert.strictEqual(fillLimit.side, "BUY");
  assert.strictEqual(fillLimit.fillPrice, 4200.00, "Limit orders must fill at requested limit price or better, never worse");
  assert.strictEqual(fillLimit.slippagePerShare, 0);

  // Market orders accept price uncertainty and pay adverse slippage
  const marketIntent = { ...orderIntent, orderType: "MARKET" };
  const fillMarket = simulateExecutionFill({ orderIntent: marketIntent, liquidityTier: "HIGH" });
  assert.strictEqual(fillMarket.fillPrice, 4200.05, "Market buy order pays 1 tick adverse slippage");
  assert.strictEqual(fillMarket.totalSlippageInr, 8.75);

  // Quote-aware fill logic: unfilled if market never traded down to limit
  const unfilled = simulateExecutionFill({
    orderIntent,
    currentQuote: { open: 4250, high: 4260, low: 4210, close: 4220 }
  });
  assert.strictEqual(unfilled.status, "UNFILLED", "Order must not fill if session low is above limit price");
}

function testContractNoteGeneration() {
  const mockIntent = {
    contractSymbol: "INFY26SEPFUT",
    side: "long",
    orderType: "LIMIT",
    entryPrice: 1800.00,
    lotSize: 400,
    lots: 1,
    quantity: 400,
    tickSize: 0.05
  };

  const entry = simulateExecutionFill({ orderIntent: mockIntent, liquidityTier: "HIGH" });
  const exit = simulateExecutionFill({
    orderIntent: { ...mockIntent, side: "sell", entryPrice: 1836.00 },
    liquidityTier: "HIGH"
  });

  const note = generateContractNote({
    tradeId: "TRD_INFY_001",
    entryFill: entry,
    exitFill: exit,
    contract: { expiry: "2026-09-24", marginPct: 0.22 }
  });

  assert(note.contractNoteNumber.startsWith("CN_"));
  assert.strictEqual(note.contractSymbol, "INFY26SEPFUT");
  // Gross P&L: (1836 - 1800) * 400 = 14400
  assert.strictEqual(note.breakdown.grossPnl, 14400);
  assert(note.breakdown.totalTaxesAndCharges > 400 && note.breakdown.totalTaxesAndCharges < 500);
  assert.strictEqual(
    note.breakdown.netRealizedPnl,
    Math.round((note.breakdown.grossPnl - note.breakdown.totalTaxesAndCharges) * 100) / 100
  );
  // Verify return on margin is reported
  assert(Number.isFinite(note.breakdown.returnOnMarginPct));
  assert(note.breakdown.returnOnMarginPct > 0);
}

function run() {
  testNseFuturesCharges();
  testExecutionSlippage();
  testContractNoteGeneration();
  console.log("Shadow broker simulation & contract note tests passed: authentic NSE tax calculations, slippage and contract notes verified!");
}

run();
