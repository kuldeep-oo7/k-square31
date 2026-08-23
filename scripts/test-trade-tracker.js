"use strict";

const assert = require("node:assert/strict");
const { createSignalRecord, evaluateOutcome, summarizePerformance } = require("../api/_lib/trade-tracker");

const rec = {
  symbol: "RELIANCE",
  side: "long",
  action: "buy-momentum",
  weekKey: "2026-08-24",
  anchor: 1300,
  entries: [{ level: 1, entry: 1300, target: 1326, stopLoss: 1287, riskReward: 2.0 }],
  convictionPct: 80,
  expectedWeeklyPct: 2.0,
  reasons: ["Top Relative Strength"]
};

const sig = createSignalRecord(rec, { return5Pct: 2.5, atr14Pct: 1.8, rsi14: 62 });
assert.equal(sig.symbol, "RELIANCE");
assert.equal(sig.entryPrice, 1300);
assert.equal(sig.targetPrice, 1326);
assert.equal(sig.stopLossPrice, 1287);
assert.equal(sig.riskReward, 2.0);
assert.equal(sig.status, "PENDING");

// Test Target Hit (WIN)
const winBars = [
  { high: 1302, low: 1298, close: 1301 },
  { high: 1328, low: 1300, close: 1325 }
];
const winRes = evaluateOutcome(sig, winBars);
assert.equal(winRes.status, "TARGET_HIT");
assert.equal(winRes.outcome, "WIN");
assert.ok(winRes.pnlPct > 0);

// Test Stopped Out (LOSS)
const lossBars = [
  { high: 1302, low: 1298, close: 1300 },
  { high: 1301, low: 1285, close: 1286 }
];
const lossRes = evaluateOutcome(sig, lossBars);
assert.equal(lossRes.status, "STOPPED_OUT");
assert.equal(lossRes.outcome, "LOSS");
assert.ok(lossRes.pnlPct < 0);

// Test Performance Summary
const summary = summarizePerformance([winRes, lossRes, sig]);
assert.equal(summary.totalSignals, 3);
assert.equal(summary.resolvedSignals, 2);
assert.equal(summary.winCount, 1);
assert.equal(summary.lossCount, 1);
assert.equal(summary.winRatePct, 50);
assert.ok(summary.profitFactor >= 1.5, "2:1 RR yields profit factor > 1.5 at 50% win rate");

console.log("Trade tracker tests passed: signal creation, win/loss resolution, MFE/MAE and performance metrics");
