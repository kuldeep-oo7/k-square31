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
  assert(buyCharges.exchangeCharges > 14 && buyCharges.exchangeCharges < 15); // 0.0019% = 14.25
  assert(buyCharges.gst > 6 && buyCharges.gst < 7); // 18% of (20 + 14.25 + 0.75) = 6.30
  assert(buyCharges.totalCharges > 50 && buyCharges.totalCharges < 60);

  // Test Case 2: Sell 250 shares @ 3060 -> Turnover = 7,65,000
  const sellCharges = calculateNseFuturesCharges({
    side: "SELL",
    price: 3060,
    quantity: 250
  });

  assert.strictEqual(sellCharges.turnover, 765000);
  assert.strictEqual(sellCharges.brokerage, 20);
  assert.strictEqual(sellCharges.stt, 153); // 0.02% of 7,65,000 = 153
  assert.strictEqual(sellCharges.stampDuty, 0); // No stamp duty on sell side
  assert(sellCharges.totalCharges > 190 && sellCharges.totalCharges < 205);
}

function testExecutionSlippage() {
  const orderIntent = {
    symbol: "TCS",
    contractSymbol: "TCS26SEPFUT",
    side: "long",
    entryPrice: 4200.00,
    lotSize: 175,
    lots: 1,
    quantity: 175,
    tickSize: 0.05
  };

  const fillHigh = simulateExecutionFill({ orderIntent, liquidityTier: "HIGH" });
  assert.strictEqual(fillHigh.side, "BUY");
  assert.strictEqual(fillHigh.fillPrice, 4200.05); // 1 tick slippage
  assert.strictEqual(fillHigh.totalSlippageInr, 8.75);

  const fillMid = simulateExecutionFill({ orderIntent, liquidityTier: "MID" });
  assert.strictEqual(fillMid.fillPrice, 4200.10); // 2 ticks slippage
}

function testContractNoteGeneration() {
  const mockIntent = {
    contractSymbol: "INFY26SEPFUT",
    side: "long",
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
    contract: { expiry: "2026-09-24" }
  });

  assert(note.contractNoteNumber.startsWith("CN_"));
  assert.strictEqual(note.contractSymbol, "INFY26SEPFUT");
  assert.strictEqual(note.breakdown.grossPnl, Math.round((1835.95 - 1800.05) * 400)); // 35.90 * 400 = 14360
  assert(note.breakdown.totalTaxesAndCharges > 200 && note.breakdown.totalTaxesAndCharges < 300);
  assert.strictEqual(
    note.breakdown.netRealizedPnl,
    Math.round((note.breakdown.grossPnl - note.breakdown.totalTaxesAndCharges) * 100) / 100
  );
}

function run() {
  testNseFuturesCharges();
  testExecutionSlippage();
  testContractNoteGeneration();
  console.log("Shadow broker simulation & contract note tests passed: authentic NSE tax calculations, slippage and contract notes verified!");
}

run();
