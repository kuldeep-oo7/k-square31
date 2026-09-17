"use strict";

const assert = require("assert");
const {
  calculateMoments,
  estimateGbmParameters,
  forecastGarch11Volatility,
  calculateCornishFisherRisk,
  calculateMicrostructureLiquidity,
  KalmanHedgeEstimator
} = require("../api/_lib/institutional-calculus");

console.log("Starting Institutional Calculus & Stochastic Risk test suite...");

// 1. Moments & Distribution
const samplePrices = [100, 101, 102, 101.5, 103, 104, 103.5, 105, 106, 105.8, 107, 108];
const moments = calculateMoments(samplePrices);
assert(moments.returns.length === samplePrices.length - 1, "Returns count should match prices - 1");
assert(moments.stdDev > 0, "StdDev must be strictly positive");
assert(Number.isFinite(moments.skewness), "Skewness must be finite");
assert(Number.isFinite(moments.kurtosis), "Kurtosis must be finite");
console.log("  ✓ Moments calculation verified (returns:", moments.returns.length, "stdDev:", moments.stdDev.toFixed(4) + ")");

// 2. GBM & Ito's Drift/Diffusion
const gbm = estimateGbmParameters(samplePrices);
assert(Number.isFinite(gbm.annualizedDrift), "Annualized drift must be finite");
assert(Number.isFinite(gbm.annualizedVol), "Annualized vol must be finite");
assert(gbm.itoDriftCorrection < 0, "Ito's drift correction (-0.5*sigma^2) must be strictly negative");
console.log("  ✓ GBM & Ito's Lemma verified (Drift:", gbm.annualizedDrift, "Vol:", gbm.annualizedVol, "Ito correction:", gbm.itoDriftCorrection + ")");

// 3. GARCH(1,1) Volatility Forecasting
const garch = forecastGarch11Volatility(samplePrices, { horizonDays: 5 });
assert(garch.forecastedAnnualizedVol > 0, "GARCH forecasted vol must be positive");
assert(garch.persistence === 0.96, "Baseline GARCH persistence alpha+beta must be 0.96");
assert(["HIGH_VOL", "MODERATE_VOL", "LOW_VOL"].includes(garch.volatilityRegime), "Volatility regime must be valid");
console.log("  ✓ GARCH(1,1) Volatility Forecast verified (Current:", garch.currentAnnualizedVol, "Forecast 5d:", garch.forecastedAnnualizedVol, "Regime:", garch.volatilityRegime + ")");

// 4. Cornish-Fisher VaR & CVaR
const cfRisk = calculateCornishFisherRisk(samplePrices, 500000, 0.99);
assert(cfRisk.varRupees > 0, "Cornish-Fisher VaR in Rupees must be positive");
assert(cfRisk.cvarRupees >= cfRisk.varRupees, "Expected Shortfall (CVaR) must be >= VaR");
console.log("  ✓ Cornish-Fisher VaR/CVaR verified (99% VaR: ₹" + cfRisk.varRupees + ", 99% CVaR: ₹" + cfRisk.cvarRupees + ")");

// 5. Microstructure Liquidity & Kyle's Lambda
const sampleBars = samplePrices.map((p, i) => ({
  close: p,
  volume: 50000 + (i % 3) * 10000
}));
const liquidity = calculateMicrostructureLiquidity(sampleBars);
assert(liquidity.liquidityScore >= 0 && liquidity.liquidityScore <= 1, "Liquidity score must be normalized in [0, 1]");
assert(Number.isFinite(liquidity.kyleLambda), "Kyle's Lambda must be finite");
console.log("  ✓ Microstructure Liquidity verified (Kyle's Lambda:", liquidity.kyleLambda, "Amihud:", liquidity.amihudRatio, "Score:", liquidity.liquidityScore + ")");

// 6. Kalman Filter Dynamic Beta Tracking
const kalman = new KalmanHedgeEstimator();
// Feed synthetic pairs data where Y = 1.5 * X + noise
let beta = 1.0;
for (let i = 0; i < 30; i++) {
  const x = 100 + i * 0.5;
  const y = 1.5 * x + (Math.sin(i) * 0.5);
  beta = kalman.update(x, y);
}
assert(beta >= 1.2 && beta <= 1.8, "Kalman filter should converge near true beta 1.5, got: " + beta);
console.log("  ✓ Kalman Filter state-space dynamic beta convergence verified (estimated beta:", beta + ")");

console.log("ALL Institutional Calculus & Stochastic Risk tests passed successfully!\n");
