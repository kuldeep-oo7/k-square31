"use strict";

const assert = require("node:assert/strict");
const {
  blackScholesMerton,
  calculateHurstExponent,
  calculateKaufmanER,
  calculateAnchoredVwap,
  classifyOiBuildup,
  calculateKellyFraction,
  calculateOuHalfLife
} = require("../api/_lib/advanced-quant");

console.log("Starting Advanced Quantitative Mathematics & Trillion Dollar Equation test suite...");

// 1. Black-Scholes-Merton (The Trillion Dollar Equation)
const bsmCall = blackScholesMerton({
  spot: 100,
  strike: 100,
  timeToExpiryYears: 1.0,
  riskFreeRate: 0.05,
  volatility: 0.20,
  isCall: true
});

assert(bsmCall.price > 10.0 && bsmCall.price < 11.0, `Expected ATM Call around 10.45, got ${bsmCall.price}`);
assert(bsmCall.delta > 0.60 && bsmCall.delta < 0.68, `Expected Call Delta around 0.637, got ${bsmCall.delta}`);
assert(bsmCall.gamma > 0.01 && bsmCall.gamma < 0.03, `Expected Gamma around 0.0187, got ${bsmCall.gamma}`);
assert(bsmCall.vega > 0.35 && bsmCall.vega < 0.40, `Expected Vega around 0.375, got ${bsmCall.vega}`);

const bsmPut = blackScholesMerton({
  spot: 100,
  strike: 100,
  timeToExpiryYears: 1.0,
  riskFreeRate: 0.05,
  volatility: 0.20,
  isCall: false
});
assert(bsmPut.price > 5.0 && bsmPut.price < 6.0, `Expected ATM Put around 5.57, got ${bsmPut.price}`);
assert(bsmPut.delta < 0 && bsmPut.delta > -0.5, `Expected Put Delta around -0.363, got ${bsmPut.delta}`);

// 2. Hurst Exponent (H)
const trendingSeries = Array.from({ length: 100 }, (_, i) => 100 + i * 2 + (Math.sin(i / 2) * 1.5));
const hurstTrend = calculateHurstExponent(trendingSeries);
assert(hurstTrend > 0.55, `Expected trending series Hurst > 0.55, got ${hurstTrend}`);

// 3. Kaufman Efficiency Ratio (ER)
const cleanTrend = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
const erHigh = calculateKaufmanER(cleanTrend, 20);
assert(erHigh === 1.0, `Expected perfect straight line ER = 1.0, got ${erHigh}`);

const choppyNoise = [100, 102, 98, 103, 99, 101, 98, 102, 99, 101, 98, 102, 99, 101, 98, 102, 99, 101, 98, 102, 100];
const erLow = calculateKaufmanER(choppyNoise, 20);
assert(erLow < 0.20, `Expected noisy ER < 0.20, got ${erLow}`);

// 4. Anchored VWAP (AVWAP)
const mockBars = [
  { date: "2026-08-24", close: 100, volume: 1000 },
  { date: "2026-08-25", close: 105, volume: 2000 },
  { date: "2026-08-26", close: 110, volume: 3000 }
];
const avwap = calculateAnchoredVwap(mockBars, "2026-08-24");
// (100*1000 + 105*2000 + 110*3000) / 6000 = (100000 + 210000 + 330000) / 6000 = 640000 / 6000 = 106.67
assert.equal(avwap, 106.67);

// 5. Derivatives OI Buildup Classifier
const longBuildup = classifyOiBuildup({ priceChangePct: 2.5, oiChangePct: 5.2 });
assert.equal(longBuildup.code, "LONG_BUILDUP");
assert.equal(longBuildup.tone, "bullish");

const shortBuildup = classifyOiBuildup({ priceChangePct: -2.1, oiChangePct: 4.8 });
assert.equal(shortBuildup.code, "SHORT_BUILDUP");
assert.equal(shortBuildup.tone, "bearish");

// 6. Kelly Criterion & Merton's Optimal Allocation Ratio
const kelly = calculateKellyFraction({ winRate: 0.65, rewardToRiskRatio: 2.0 });
// Full Kelly = (0.65 * 2 - 0.35) / 2 = (1.30 - 0.35) / 2 = 0.95 / 2 = 0.475
// Half Kelly = 0.475 * 0.5 = 0.238
assert(kelly >= 0.20 && kelly <= 0.25, `Expected Half-Kelly around 0.238, got ${kelly}`);

// 7. Ornstein-Uhlenbeck (OU) Mean Reversion Half-Life
const ouPrices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
const ou = calculateOuHalfLife(ouPrices);
assert(ou.halfLifeDays !== null && Number.isFinite(ou.halfLifeDays), "Expected valid OU half-life");

console.log("Advanced Quantitative Mathematics tests passed: BSM Trillion Dollar Equation, Hurst Exponent, Kaufman ER, Anchored VWAP, OI Buildup, Kelly Criterion, and OU Process.");
