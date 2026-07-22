const assert = require("node:assert/strict");
const { calculate } = require("../api/market")._test;

function fixture(multiplier = 1) {
  const timestamps = [], open = [], high = [], low = [], close = [], volume = [];
  const today = Math.floor(Date.now() / 1000);
  for (let index = 139; index >= 0; index -= 1) {
    const step = 139 - index;
    const value = multiplier * (100 + step * .18 + Math.sin(step / 4) * 2.4);
    timestamps.push(today - index * 86_400);
    open.push(value * .997); high.push(value * 1.012); low.push(value * .988); close.push(value); volume.push(1_000_000 + step * 2_000);
  }
  return { meta: { currency: "INR", regularMarketPrice: close.at(-1), regularMarketDayLow: low.at(-1), regularMarketDayHigh: high.at(-1), regularMarketTime: timestamps.at(-1) }, timestamp: timestamps, indicators: { quote: [{ open, high, low, close, volume }] } };
}

const result = calculate("TEST.NS", fixture(), fixture(2));
assert.equal(result.symbol, "TEST");
assert.ok(result.quarter.sessions > result.window.sessions);
assert.ok(result.quarter.low < result.quarter.high);
assert.ok(result.signals.maxDrawdown63Pct >= 0);
assert.ok(result.signals.riskBudgetMultiplier >= .25 && result.signals.riskBudgetMultiplier <= 1.25);
assert.ok(result.empirical.weeks >= 12);
assert.equal(result.analogModel.ready, true);
assert.ok(result.analogModel.samples >= 30);
assert.ok(result.analogModel.probabilityUp5Pct >= 0 && result.analogModel.probabilityUp5Pct <= 100);

console.log("Market model tests passed: 31-day, 3-month, probability, risk sizing and walk-forward analogues");
