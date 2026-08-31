"use strict";

const assert = require("node:assert/strict");
const {
  classifyMarketRegime,
  calcGarmanKlassVol,
  evaluateGlobalMacroShock,
  enforceSectorDiversification
} = require("../api/_lib/market-regime");

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

// 5. Normal Global Macro Condition
const normalMacro = evaluateGlobalMacroShock({
  giftNiftyGapPct: -0.2,
  indiaVix: 13.5,
  indiaVixChangePct: 1.0,
  brentCrudeSpikePct: 0.5,
  sp500FuturesGapPct: -0.1
});
assert.equal(normalMacro.severity, "NORMAL");
assert.equal(normalMacro.shieldActive, false);
assert.equal(normalMacro.allowedLongLevels.length, 5);

// 6. Elevated Risk Condition (Moderate Gap-Down & Crude Jump)
const elevatedMacro = evaluateGlobalMacroShock({
  giftNiftyGapPct: -1.2,
  indiaVix: 18.5,
  indiaVixChangePct: 9.0,
  brentCrudeSpikePct: 3.0,
  sp500FuturesGapPct: -0.8
});
assert.equal(elevatedMacro.severity, "ELEVATED_RISK");
assert.equal(elevatedMacro.shieldActive, true);
assert(elevatedMacro.vetoedLongLevels.includes(1), "Level 1 shallow buy must be vetoed");

// 7. Critical War / Global Bloodbath Shock
const bloodbathMacro = evaluateGlobalMacroShock({
  giftNiftyGapPct: -2.4, // Massive gap down
  indiaVix: 25.0,        // Panic spike
  indiaVixChangePct: 22.0,
  brentCrudeSpikePct: 6.5, // War crude spike
  sp500FuturesGapPct: -2.8
});
assert.equal(bloodbathMacro.severity, "CRITICAL_BLOODBATH");
assert.equal(bloodbathMacro.shieldActive, true);
assert.deepEqual(bloodbathMacro.allowedLongLevels, [4, 5], "ONLY deep capitulation dips allowed");
assert.equal(bloodbathMacro.shortMultiplier, 1.35, "Short setups boosted +35% to profit from crash");
assert.equal(bloodbathMacro.longMultiplier, 0.50, "Long exposure scaled down for defense");

console.log("Market regime and Global Macro Shock Shield tests passed: Normal, Elevated, and Bloodbath war shields verified!");
