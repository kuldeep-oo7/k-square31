"use strict";

const assert = require("node:assert/strict");
const {
  calculateNseFuturesCharges,
  generateContractNote,
  simulateExecutionFill
} = require("../api/_lib/shadow-broker");

const SESSION = "2026-09-08";
const QUOTE_TS = Date.parse(`${SESSION}T10:00:00.000Z`);

const buyCharges = calculateNseFuturesCharges({ side: "BUY", price: 3000, quantity: 250, asOfDate: SESSION });
assert.equal(buyCharges.turnover, 750000);
assert.equal(buyCharges.brokerage, 20);
assert.equal(buyCharges.stt, 0);
assert.equal(buyCharges.stampDuty, 15);
assert.equal(buyCharges.exchangeCharges, 13.72);
assert.equal(buyCharges.ipft, 0.0008);

const sellCharges = calculateNseFuturesCharges({ side: "SELL", price: 3060, quantity: 250, asOfDate: SESSION });
assert.equal(sellCharges.turnover, 765000);
assert.equal(sellCharges.stt, 383);
assert.equal(sellCharges.stampDuty, 0);
assert.equal(calculateNseFuturesCharges({ side: "SELL", price: 3060, quantity: 250, asOfDate: "2024-05-15" }).stt, 96);
assert.equal(calculateNseFuturesCharges({ side: "SELL", price: 3060, quantity: 250, asOfDate: "2025-01-15" }).stt, 153);
assert.throws(() => calculateNseFuturesCharges({ side: "unknown", price: 1, quantity: 1 }), /Unsupported/);

const orderIntent = {
  executable: true,
  symbol: "TCS",
  contractSymbol: "TCS26SEPFUT",
  clientOrderId: "K2_TCS_L1",
  side: "long",
  orderType: "LIMIT",
  entryPrice: 4200,
  lotSize: 175,
  lots: 1,
  quantity: 175,
  tickSize: 0.05,
  expiry: "2026-09-29"
};

assert.equal(simulateExecutionFill({ orderIntent, asOfDate: SESSION }).reason, "TIMESTAMPED_MARKET_EVIDENCE_REQUIRED");
assert.equal(simulateExecutionFill({
  orderIntent,
  asOfDate: SESSION,
  currentQuote: { timestamp: QUOTE_TS, open: 4210, high: 4220, low: 4200, close: 4205 }
}).reason, "LIMIT_TOUCHED_QUEUE_UNPROVEN");
assert.equal(simulateExecutionFill({
  orderIntent,
  asOfDate: SESSION,
  currentQuote: { timestamp: QUOTE_TS, open: 4210, high: 4220, low: 4199.95, close: 4205 }
}).fillPrice, 4200);
assert.equal(simulateExecutionFill({
  orderIntent,
  asOfDate: SESSION,
  currentQuote: { timestamp: QUOTE_TS, open: 4190, high: 4210, low: 4180, close: 4200 }
}).fillPrice, 4190, "a buy limit opening through its price receives the better open");

const marketFill = simulateExecutionFill({
  orderIntent: { ...orderIntent, orderType: "MARKET" },
  liquidityTier: "HIGH",
  asOfDate: SESSION,
  currentQuote: { timestamp: QUOTE_TS, ask: 4200, bid: 4199.95 }
});
assert.equal(marketFill.status, "FILLED");
assert.equal(marketFill.side, "BUY");
assert.equal(marketFill.fillPrice, 4200.05);
assert.equal(marketFill.totalSlippageInr, 8.75);
assert.equal(simulateExecutionFill({
  orderIntent: { ...orderIntent, side: "invalid" },
  currentQuote: { timestamp: QUOTE_TS, low: 4100, high: 4300 },
  asOfDate: SESSION
}).reason, "MISSING_OR_INVALID_SIDE");
assert.match(simulateExecutionFill({
  orderIntent,
  currentQuote: { timestamp: Date.parse("2026-09-07T10:00:00Z"), low: 4100, high: 4300 },
  asOfDate: SESSION
}).reason, /^STALE_QUOTE_SESSION/);

const entry = simulateExecutionFill({
  orderIntent: { ...orderIntent, symbol: "INFY", contractSymbol: "INFY26SEPFUT", clientOrderId: "K2_INFY_ENTRY", entryPrice: 1800, lotSize: 400, quantity: 400 },
  currentQuote: { timestamp: QUOTE_TS, open: 1801, high: 1805, low: 1799.95, close: 1802 },
  asOfDate: SESSION
});
const exit = simulateExecutionFill({
  orderIntent: { ...orderIntent, symbol: "INFY", contractSymbol: "INFY26SEPFUT", clientOrderId: "K2_INFY_EXIT", side: "sell", orderType: "MARKET", entryPrice: 1836, lotSize: 400, quantity: 400 },
  currentQuote: { timestamp: QUOTE_TS, bid: 1836, ask: 1836.05 },
  asOfDate: SESSION
});
const note = generateContractNote({
  tradeId: "TRD_INFY_001",
  entryFill: entry,
  exitFill: exit,
  contract: { expiry: "2026-09-29", marginPct: 0.22 },
  settlementDate: SESSION
});
assert.ok(note.contractNoteNumber.startsWith("CN_"));
assert.equal(note.settlementDate, SESSION);
assert.equal(note.contractSymbol, "INFY26SEPFUT");
assert.equal(note.breakdown.grossPnl, Math.round((exit.fillPrice - entry.fillPrice) * 400 * 100) / 100);
assert.equal(note.breakdown.netRealizedPnl, Math.round((note.breakdown.grossPnl - note.breakdown.totalTaxesAndCharges) * 100) / 100);

console.log("Shadow-broker tests passed: dated fee schedule, strict identity, no quote/no fill, trade-through, gap price improvement and adverse market slippage");
