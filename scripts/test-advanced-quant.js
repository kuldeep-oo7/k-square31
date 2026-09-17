"use strict";

const assert = require("node:assert/strict");
const {
  blackScholesMerton,
  calculateHurstExponent,
  calculateKaufmanER,
  calculateAnchoredVwap,
  classifyOiBuildup,
  calculateKellyFraction,
  calculateOuHalfLife,
  calculateFractionalDiff,
  calculateVpin,
  metaLabelConfidence
} = require("../api/_lib/advanced-quant");

console.log("Starting Full Advanced Quantitative Mathematics test suite (10 Formulas)...");

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
assert(bsmCall.rho > 0.50 && bsmCall.rho < 0.56, `Expected Rho around 0.5323, got ${bsmCall.rho}`);

// 2. Hurst Exponent (H)
const trendingSeries = Array.from({ length: 100 }, (_, i) => 100 + i * 2 + (Math.sin(i / 2) * 1.5));
const hurstTrend = calculateHurstExponent(trendingSeries);
assert(hurstTrend > 0.55, `Expected trending series Hurst > 0.55, got ${hurstTrend}`);

// 3. Kaufman Efficiency Ratio (ER)
const cleanTrend = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
const erHigh = calculateKaufmanER(cleanTrend, 20);
assert(erHigh === 1.0, `Expected perfect straight line ER = 1.0, got ${erHigh}`);

// 4. Anchored VWAP (AVWAP)
const mockBars = [
  { date: "2026-08-24", close: 100, volume: 1000 },
  { date: "2026-08-25", close: 105, volume: 2000 },
  { date: "2026-08-26", close: 110, volume: 3000 }
];
const avwap = calculateAnchoredVwap(mockBars, "2026-08-24");
assert.equal(avwap, 106.67);

// 5. Derivatives OI Buildup Classifier
const longBuildup = classifyOiBuildup({ priceChangePct: 2.5, oiChangePct: 5.2 });
assert.equal(longBuildup.code, "LONG_BUILDUP");

// 6. Kelly Criterion
const kelly = calculateKellyFraction({ winRate: 0.65, rewardToRiskRatio: 2.0 });
assert(kelly >= 0.20 && kelly <= 0.25, `Expected Half-Kelly around 0.238, got ${kelly}`);

// 7. Ornstein-Uhlenbeck (OU) Mean Reversion Half-Life
const ouPrices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
const ou = calculateOuHalfLife(ouPrices);
assert(ou.halfLifeDays !== null && Number.isFinite(ou.halfLifeDays), "Expected valid OU half-life");

// 8. Fractional Differentiation (López de Prado)
const rawPrices = Array.from({ length: 80 }, (_, i) => 100 + i * 1.5 + Math.sin(i) * 2);
const fracDiff = calculateFractionalDiff(rawPrices, 0.45);
assert.equal(fracDiff.d, 0.45);
assert(fracDiff.fractionalSeries.length === rawPrices.length);
assert.equal(fracDiff.memoryRetentionPct, null, "d is not a percentage of memory retained");
assert.equal(fracDiff.stationarityVerified, false);
assert.equal(fracDiff.fractionalSeries[0], null, "warmup is missing, not a fabricated zero");

// 9. VPIN (Volume-Synchronized Probability of Toxicity)
const normalBars = Array.from({ length: 40 }, (_, i) => ({
  close: 100 + (i % 2 === 0 ? 0.5 : -0.4),
  volume: 5000 + (i * 137) % 1000
}));
const vpinNormal = calculateVpin(normalBars, 15);
assert(vpinNormal.vpin > 0 && vpinNormal.vpin < 1.0);
assert.equal(vpinNormal.toxicOrderFlow, false);

const toxicBars = Array.from({ length: 40 }, (_, i) => ({
  close: 100 - i * 1.2,
  volume: 20000
}));
const vpinToxic = calculateVpin(toxicBars, 15);
assert(vpinToxic.vpin > 0.60, `Expected high toxicity on dump, got ${vpinToxic.vpin}`);
console.log(`  Normal VPIN: ${vpinNormal.vpin} (${vpinNormal.toxicityTone}) | Toxic Dump VPIN: ${vpinToxic.vpin} (${vpinToxic.toxicityTone})`);

// 10. Meta-Labeling Quality Control Gate
const primeSetup = metaLabelConfidence({
  primarySide: "long",
  primaryScore: 75,
  hurst: 0.62,
  er: 0.58,
  vpin: 0.28,
  isUptrend: true
});
assert.equal(primeSetup.decision, "TAKE");
assert.equal(primeSetup.qualityRating, "PRIME");
assert(primeSetup.metaProb > 0.75);

const trapSetup = metaLabelConfidence({
  primarySide: "long",
  primaryScore: 40,
  hurst: 0.42,
  er: 0.18,
  vpin: 0.72,
  isUptrend: false
});
// Regression test for P1-014: BSM at expiry (T <= 0) must return exact intrinsic value
const bsmExpiredCall = blackScholesMerton({ spot: 110, strike: 100, timeToExpiryYears: 0, isCall: true });
assert.equal(bsmExpiredCall.price, 10.0, "ITM call at expiry must equal intrinsic value (S - K)");
assert.equal(bsmExpiredCall.delta, 1.0);
assert.equal(bsmExpiredCall.gamma, 0);

const bsmExpiredPut = blackScholesMerton({ spot: 95, strike: 100, timeToExpiryYears: 0, isCall: false });
assert.equal(bsmExpiredPut.price, 5.0, "ITM put at expiry must equal intrinsic value (K - S)");
assert.equal(bsmExpiredPut.delta, -1.0);
assert.equal(blackScholesMerton({ spot: 95, strike: 100, timeToExpiryYears: -0.1 }).available, false, "negative time is invalid, not a current expiry price");

// Regression test for P1-013: Kelly fraction should not floor small positive values to 0.05
const tinyKelly = calculateKellyFraction({ winRate: 0.51, rewardToRiskRatio: 1.0, fractionMultiplier: 0.5 });
assert.ok(tinyKelly > 0 && tinyKelly < 0.05, "tiny Kelly edge must not be inflated to 0.05");

console.log("ALL 10 Advanced Quantitative & Institutional Formulas passed successfully!");
