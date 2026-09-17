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


// ===========================================================================
// REGRESSION BLOCK -- each assertion below corresponds to a defect found by
// measurement on 2026-09-17. The suite above passed with every one of them
// present, because it only checked that numbers fell inside wide ranges.
// ===========================================================================

function lcg(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
}
function gaussianSeries(n, sigma, seed) {
  const random = lcg(seed);
  const prices = [100];
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = 0; k < 12; k += 1) sum += random();   // Irwin-Hall approximation of N(0,1)
    prices.push(prices[prices.length - 1] * (1 + (sum - 6) * sigma));
  }
  return prices;
}

// --- 1. Gaussian control. For normal returns the 99% VaR is 2.326 sigma and the
// 99% expected shortfall is phi(z)/alpha = 2.665 sigma. Any implementation that
// cannot reproduce these two constants is not measuring tail risk.
const normal = calculateCornishFisherRisk(gaussianSeries(4000, 0.01, 12345), 1000000, 0.99);
assert(Math.abs(normal.varPct - 2.33) < 0.25, `Gaussian 99% VaR must be about 2.33%, got ${normal.varPct}%`);
assert(Math.abs(normal.cvarPct - 2.67) < 0.30, `Gaussian 99% CVaR must be about 2.67%, got ${normal.cvarPct}%`);
console.log(`  ✓ Gaussian control: VaR ${normal.varPct}% vs theory 2.33%, CVaR ${normal.cvarPct}% vs theory 2.67%`);

// --- 2. A fat-tailed series must not report zero risk.
// The Cornish-Fisher polynomial stops being monotone once skewness and kurtosis
// get large, and returned an adjusted quantile of -0.929 on the series below.
// Math.max(0, ...) then published a 99% VaR of exactly 0.00% for an instrument
// that dropped 9% in a day: no risk, precisely where the risk was worst.
const random = lcg(42);
const crashy = [1000];
for (let i = 0; i < 400; i += 1) {
  const u = random();
  const move = u < 0.02 ? -(0.04 + random() * 0.10) : u > 0.99 ? (0.03 + random() * 0.06) : (random() - 0.5) * 0.014;
  crashy.push(crashy[crashy.length - 1] * (1 + move));
}
const fat = calculateCornishFisherRisk(crashy, 1000000, 0.99);
assert(fat.varPct > 1, `A series with 4-14% crash days cannot have ${fat.varPct}% VaR`);
assert(fat.varRupees > 0, "Rupee VaR must be positive when the series has real losses");
assert(fat.cvarPct > fat.varPct, `Expected shortfall must strictly exceed VaR, got CVaR ${fat.cvarPct}% vs VaR ${fat.varPct}%`);
const worstLoss = Math.max(...crashy.slice(1).map((p, i) => -(p / crashy[i] - 1))) * 100;
assert(fat.cvarPct <= worstLoss + 1e-6, "Expected shortfall cannot exceed the worst loss actually observed");
console.log(`  ✓ Fat tails: VaR ${fat.varPct}%, CVaR ${fat.cvarPct}% (method ${fat.method}, CF in domain: ${fat.cornishFisherValid})`);

// --- 3. GARCH long-run variance must belong to the instrument.
// With omega fixed at 5e-6 and persistence 0.96 every asset in the universe was
// told it reverts to the same 17.75% annualised volatility.
const calm = forecastGarch11Volatility(gaussianSeries(600, 0.004, 7), { horizonDays: 5 });
const wild = forecastGarch11Volatility(gaussianSeries(600, 0.030, 7), { horizonDays: 5 });
assert(calm.longRunAnnualizedVol !== null && wild.longRunAnnualizedVol !== null, "Long-run volatility must be estimated");
assert(
  wild.longRunAnnualizedVol > calm.longRunAnnualizedVol * 2,
  `A high-volatility name must not share a long-run volatility with a calm one: calm ${calm.longRunAnnualizedVol}, wild ${wild.longRunAnnualizedVol}`
);
assert(calm.varianceTargeted === true, "Omega must be solved from the sample, not held constant");
console.log(`  ✓ GARCH variance targeting: calm long-run ${calm.longRunAnnualizedVol} vs wild ${wild.longRunAnnualizedVol}`);

// --- 4. The conditional variance filter must consume the most recent return.
// The loop stopped one observation short, so the latest shock never reached the
// forecast and "current" volatility was always a day stale.
const base = gaussianSeries(400, 0.01, 99);
const shocked = base.concat([base[base.length - 1] * 0.85]);   // a -15% session
const beforeShock = forecastGarch11Volatility(base, { horizonDays: 5 });
const afterShock = forecastGarch11Volatility(shocked, { horizonDays: 5 });
assert(
  afterShock.currentAnnualizedVol > beforeShock.currentAnnualizedVol,
  `A -15% session must raise conditional volatility: before ${beforeShock.currentAnnualizedVol}, after ${afterShock.currentAnnualizedVol}`
);
console.log(`  ✓ Latest shock reaches the forecast: ${beforeShock.currentAnnualizedVol} -> ${afterShock.currentAnnualizedVol}`);

// --- 5. Liquidity impact must be measured, not assumed.
// Order flow was signed by the sign of the price change it was regressed on, so
// the estimate was positive by construction on any input at all.
function bars(moveScale, volumeScale, seed) {
  const r = lcg(seed);
  const out = [];
  let price = 500;
  for (let i = 0; i < 200; i += 1) {
    price *= 1 + (r() - 0.5) * moveScale;
    out.push({ close: price, volume: Math.floor(volumeScale * (0.5 + r())) });
  }
  return out;
}
const deep = calculateMicrostructureLiquidity(bars(0.008, 5_000_000, 3));
const thin = calculateMicrostructureLiquidity(bars(0.060, 20_000, 3));
assert(thin.amihudRatio > deep.amihudRatio * 10, "An illiquid name must show a far higher Amihud ratio");
assert(thin.liquidityScore < deep.liquidityScore, "An illiquid name must score lower on liquidity");
assert(deep.trueKyleLambdaRequiresTradeData === true, "The estimator must declare that it is not true Kyle lambda");
assert(deep.estimator === "ABS_RETURN_ON_VOLUME_REGRESSION_DAILY_BARS", "The estimator must name its own method");
console.log(`  ✓ Liquidity discriminates: deep score ${deep.liquidityScore} vs thin ${thin.liquidityScore}`);

// --- 6. Shape statistics must use a consistent denominator.
// Sample variance (n-1) under third and fourth moments divided by n is not a
// standard estimator and biases both statistics toward zero.
const symmetric = [];
let level = 100;
for (let i = 0; i < 500; i += 1) { level *= 1 + (i % 2 === 0 ? 0.01 : -0.01 / 1.01); symmetric.push(level); }
const symMoments = calculateMoments(symmetric);
assert(Math.abs(symMoments.skewness) < 0.25, `A symmetric alternating series must show near-zero skew, got ${symMoments.skewness}`);
const gaussMoments = calculateMoments(gaussianSeries(6000, 0.01, 2024));
assert(Math.abs(gaussMoments.kurtosis - 3) < 0.35, `Normal returns must show kurtosis near 3, got ${gaussMoments.kurtosis}`);
assert(Math.abs(gaussMoments.skewness) < 0.2, `Normal returns must show skew near 0, got ${gaussMoments.skewness}`);
console.log(`  ✓ Moments unbiased: normal kurtosis ${gaussMoments.kurtosis.toFixed(3)} (theory 3.0), skew ${gaussMoments.skewness.toFixed(3)} (theory 0.0)`);

console.log("ALL Institutional Calculus & Stochastic Risk tests passed successfully!\n");
