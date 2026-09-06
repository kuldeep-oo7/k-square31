"use strict";

const assert = require("node:assert/strict");
const { auditPurchases } = require("../api/_lib/trade-audit");

const lots = [
  { symbol: "RELIANCE", buyAverage: 1305, quantity: 50, markPrice: 1320, position: "long" },
  { symbol: "TCS", buyAverage: 2320, quantity: 25, markPrice: 2280, position: "long" },
  { symbol: "UNRECOMMENDED", buyAverage: 500, quantity: 10, markPrice: 510, position: "long" }
];

const recommendations = [
  { symbol: "RELIANCE", action: "buy-momentum", entries: [{ entry: 1300, target: 1326, stopLoss: 1287, riskReward: 2.0 }], convictionPct: 85 },
  { symbol: "TCS", action: "buy-momentum", entries: [{ entry: 2300, target: 2346, stopLoss: 2277, riskReward: 2.0 }], convictionPct: 75 }
];

const audit = auditPurchases(lots, recommendations);
assert.equal(audit.items.length, 3);
assert.equal(audit.items[0].symbol, "RELIANCE");
assert.equal(audit.items[0].onBuyList, true);
assert.ok(audit.items[0].slippagePct !== null);
assert.equal(audit.items[0].tradeHealth, "IN_PROFIT");

assert.equal(audit.items[1].symbol, "TCS");
assert.equal(audit.items[1].onBuyList, true);
assert.equal(audit.items[1].tradeHealth, "DRAWDOWN");

assert.equal(audit.items[2].symbol, "UNRECOMMENDED");
assert.equal(audit.items[2].onBuyList, false);

assert.equal(audit.summary.totalPositions, 3);
assert.equal(audit.summary.compliantPositions, 2);
assert.equal(audit.summary.offPlanPositions, 1);
// Regression test for P1-024: totalOpenPnl must handle short positions correctly
const mixedLots = [
  { symbol: "SHORT_WIN", buyAverage: 100, quantity: 10, markPrice: 90, position: "short" }, // openPnl = (100 - 90) * 10 = +100
  { symbol: "LONG_WIN", buyAverage: 100, quantity: 10, markPrice: 110, position: "long" }   // openPnl = (110 - 100) * 10 = +100
];
const mixedAudit = auditPurchases(mixedLots, []);
assert.equal(mixedAudit.items[0].openPnl, 100);
assert.equal(mixedAudit.items[1].openPnl, 100);
assert.equal(mixedAudit.summary.totalOpenPnl, 200, "totalOpenPnl must sum profits from both long and short positions");

console.log("Trade audit tests passed: broker lot matching, slippage calculation, plan compliance and trade health");
