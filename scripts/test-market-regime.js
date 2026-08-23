"use strict";

const assert = require("node:assert/strict");
const { classifyMarketRegime, calcGarmanKlassVol, enforceSectorDiversification } = require("../api/_lib/market-regime");

function mockBars(count, trend = "up") {
  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    price = trend === "up" ? price * 1.002 : price * 0.998;
    bars.push({
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000000
    });
  }
  return bars;
}

// 1. Bull Trending Regime
const bullBars = mockBars(60, "up");
const bull = classifyMarketRegime(bullBars);
assert.equal(bull.regime, "BULL_TRENDING");
assert.equal(bull.longAllowance, true);
assert.equal(bull.sizeMultiplier, 1.0);

// 2. Bear Hostile Regime
const bearBars = mockBars(60, "down");
const bear = classifyMarketRegime(bearBars);
assert.equal(bear.regime, "BEAR_HOSTILE");
assert.equal(bear.longAllowance, false);
assert.equal(bear.sizeMultiplier, 0.5);

// 3. Garman-Klass Volatility
const gk = calcGarmanKlassVol(bullBars, 20);
assert.ok(Number.isFinite(gk) && gk > 0);

// 4. Sector Diversification
const recs = [
  { symbol: "TCS", sector: "IT", convictionPct: 90 },
  { symbol: "INFY", sector: "IT", convictionPct: 85 },
  { symbol: "WIPRO", sector: "IT", convictionPct: 80 },
  { symbol: "HDFCBANK", sector: "BANKING", convictionPct: 75 }
];
const diversified = enforceSectorDiversification(recs, 2);
assert.equal(diversified.length, 3);
assert.equal(diversified.filter(r => r.sector === "IT").length, 2, "Max 2 per sector enforced");
assert.equal(diversified.filter(r => r.sector === "BANKING").length, 1);

console.log("Market regime and sector diversification tests passed: Bull/Bear classification, Garman-Klass volatility, and Sector concentration caps");
