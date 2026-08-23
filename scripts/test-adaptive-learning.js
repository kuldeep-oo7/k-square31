"use strict";

const assert = require("node:assert/strict");
const { analyzeOutcomeSignatures } = require("../api/_lib/adaptive-learning");

const sampleTrades = [
  { outcome: "WIN", features: { return5Pct: 3.2, atr14Pct: 1.5, realisedVol21Pct: 22, rsi14: 65 } },
  { outcome: "WIN", features: { return5Pct: 2.8, atr14Pct: 1.6, realisedVol21Pct: 24, rsi14: 60 } },
  { outcome: "WIN", features: { return5Pct: 4.1, atr14Pct: 1.4, realisedVol21Pct: 20, rsi14: 68 } },
  { outcome: "LOSS", features: { return5Pct: 0.2, atr14Pct: 3.8, realisedVol21Pct: 55, rsi14: 42 } },
  { outcome: "LOSS", features: { return5Pct: -1.1, atr14Pct: 4.2, realisedVol21Pct: 60, rsi14: 38 } }
];

const learning = analyzeOutcomeSignatures(sampleTrades);
assert.equal(learning.ready, true);
assert.equal(learning.samples, 5);
assert.equal(learning.winRatePct, 60);
assert.ok(learning.adjustments.return5Pct.weightMultiplier > 1, "winning features get increased weight");
assert.equal(learning.tightenVolVeto, true, "high volatility losses trigger automatic veto tightening");

console.log("Adaptive learning tests passed: outcome signature analysis, factor weight adjustment, and automatic veto tightening");
