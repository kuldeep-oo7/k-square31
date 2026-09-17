"use strict";

// Advanced Quantitative & Institutional Derivatives Module
//
// Implements the foundational mathematical formulations of modern quantitative finance:
// 1. The Hurst Exponent (H) via Rescaled Range (R/S) Analysis (Mandelbrot / López de Prado)
// 2. Kaufman Efficiency Ratio (ER) (Perry Kaufman)
// 3. Anchored VWAP (AVWAP) from structural pivots (Brian Shannon)
// 4. Derivatives Open Interest (OI) Microstructure & Buildup Classification (NSE F&O)
// 5. The Trillion Dollar Equation: Black-Scholes-Merton Partial Differential Equation & Greeks
// 6. Kelly Criterion & Merton's Optimal Allocation Ratio (John Kelly / Robert Merton)
// 7. Ornstein-Uhlenbeck (OU) Mean-Reversion Stochastic Drift & Half-Life
// 8. Fractional Differentiation: Stationarity with Maximum Memory Retention (López de Prado)
// 9. VPIN: Volume-Synchronized Probability of Informed Trading & Toxicity (Easley, O'Hara & López de Prado)
// 10. Meta-Labeling: Secondary Machine Learning Quality Control Gate (López de Prado)

function stdNormCdf(x) {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c2 = 0.3989422804014327; // 1 / sqrt(2 * pi)

  if (x >= 0.0) {
    const t = 1.0 / (1.0 + p * x);
    return 1.0 - c2 * Math.exp(-x * x / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
  } else {
    const t = 1.0 / (1.0 - p * x);
    return c2 * Math.exp(-x * x / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
  }
}

function stdNormPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Compatibility entry point. Zero dividends remain an explicit legacy assumption;
// new callers use option-pricing.js and must supply their dividend assumption.
function blackScholesMerton({ spot, strike, timeToExpiryYears, riskFreeRate, dividendYield = 0, volatility, isCall = true, isFutures = false } = {}) {
  const { europeanOption } = require("./option-pricing");
  return europeanOption({ model: isFutures === true ? "BLACK76" : "BSM", underlyingPrice: spot,
    strike, timeToExpiryYears, riskFreeRate, dividendYield, volatility,
    optionType: isCall === true ? "CE" : isCall === false ? "PE" : null });
}

/**
 * Hurst Exponent (H) via Rescaled Range (R/S) Analysis
 * Measures long-term memory and statistical persistence of price series.
 * H > 0.55: Persistent / Strong Trend
 * H ~ 0.50: Random Walk / Brownian Motion
 * H < 0.45: Anti-persistent / Mean Reverting
 */
function calculateHurstExponent(prices) {
  if (!Array.isArray(prices) || prices.length < 30) return 0.50;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length < 20) return 0.50;

  const lags = [8, 16, 32, Math.min(64, Math.floor(returns.length / 2))].filter((lag, idx, self) => lag >= 6 && self.indexOf(lag) === idx && lag < returns.length);
  const logLags = [];
  const logRs = [];

  for (const lag of lags) {
    const numSubsets = Math.floor(returns.length / lag);
    if (numSubsets < 1) continue;

    let rsSum = 0;
    for (let s = 0; s < numSubsets; s++) {
      const subset = returns.slice(s * lag, (s + 1) * lag);
      const mean = subset.reduce((a, b) => a + b, 0) / lag;

      let cumDev = 0;
      let maxDev = -Infinity;
      let minDev = Infinity;
      let varianceSum = 0;

      for (let j = 0; j < lag; j++) {
        const dev = subset[j] - mean;
        cumDev += dev;
        if (cumDev > maxDev) maxDev = cumDev;
        if (cumDev < minDev) minDev = cumDev;
        varianceSum += dev * dev;
      }

      const range = maxDev - minDev;
      const stdDev = Math.sqrt(varianceSum / lag);

      if (stdDev > 0 && range > 0) {
        rsSum += (range / stdDev);
      }
    }

    const avgRs = rsSum / numSubsets;
    if (avgRs > 0) {
      logLags.push(Math.log(lag));
      logRs.push(Math.log(avgRs));
    }
  }

  if (logLags.length < 2) return 0.50;

  const n = logLags.length;
  const sumX = logLags.reduce((a, b) => a + b, 0);
  const sumY = logRs.reduce((a, b) => a + b, 0);
  const sumXY = logLags.reduce((sum, x, i) => sum + x * logRs[i], 0);
  const sumX2 = logLags.reduce((sum, x) => sum + x * x, 0);

  const denominator = (n * sumX2 - sumX * sumX);
  if (denominator === 0) return 0.50;

  const hurst = (n * sumXY - sumX * sumY) / denominator;
  return Number(Math.max(0.01, Math.min(0.99, hurst)).toFixed(3));
}

/**
 * Kaufman Efficiency Ratio (ER)
 * Measures noise-to-signal ratio over a defined window (default 20 periods).
 */
function calculateKaufmanER(prices, period = 20) {
  if (!Array.isArray(prices) || prices.length <= period) return 0.30;

  const current = prices[prices.length - 1];
  const prior = prices[prices.length - 1 - period];
  const netChange = Math.abs(current - prior);

  let totalVolatility = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    totalVolatility += Math.abs(prices[i] - prices[i - 1]);
  }

  if (totalVolatility <= 0) return 0.0;
  const er = netChange / totalVolatility;
  return Number(Math.max(0.0, Math.min(1.0, er)).toFixed(3));
}

/**
 * Anchored VWAP (AVWAP)
 * Calculates Volume-Weighted Average Price anchored to Monday open.
 */
function calculateAnchoredVwap(bars, anchorDateStr = null) {
  if (!Array.isArray(bars) || bars.length === 0) return null;

  let filteredBars = bars;
  if (anchorDateStr) {
    const startIndex = bars.findIndex(b => {
      const bDate = b.date || b.session || (b.timestamp ? new Date(b.timestamp * 1000).toISOString().slice(0, 10) : null);
      return bDate && bDate >= anchorDateStr;
    });
    if (startIndex >= 0) filteredBars = bars.slice(startIndex);
  }

  let cumulativePv = 0;
  let cumulativeVol = 0;

  for (const bar of filteredBars) {
    const typicalPrice = ((Number(bar.high) || Number(bar.close)) + (Number(bar.low) || Number(bar.close)) + Number(bar.close)) / 3.0;
    const vol = Number(bar.volume);
    if (Number.isFinite(vol) && vol > 0) {
      cumulativePv += typicalPrice * vol;
      cumulativeVol += vol;
    }
  }

  if (cumulativeVol <= 0) {
    const sumTp = filteredBars.reduce((sum, b) => sum + (((Number(b.high) || Number(b.close)) + (Number(b.low) || Number(b.close)) + Number(b.close)) / 3.0), 0);
    return filteredBars.length ? Number((sumTp / filteredBars.length).toFixed(2)) : null;
  }
  return Number((cumulativePv / cumulativeVol).toFixed(2));
}

/**
 * F&O Institutional Open Interest (OI) Buildup Classifier
 */
function classifyOiBuildup({ priceChangePct, oiChangePct }) {
  const pChange = Number(priceChangePct) || 0;
  const oiChange = Number(oiChangePct) || 0;

  if (pChange > 0.2 && oiChange > 1.0) {
    return { code: "LONG_BUILDUP", regime: "LONG_BUILDUP", label: "Long Buildup", interpretation: "Long Buildup (Aggressive Institutional Buying)", tone: "bullish", convictionBoost: 1.15 };
  } else if (pChange > 0.2 && oiChange < -1.0) {
    return { code: "SHORT_COVERING", regime: "SHORT_COVERING", label: "Short Covering", interpretation: "Short Covering (Bearish Short Sellers Exiting)", tone: "neutral_bullish", convictionBoost: 1.05 };
  } else if (pChange < -0.2 && oiChange > 1.0) {
    return { code: "SHORT_BUILDUP", regime: "SHORT_BUILDUP", label: "Short Buildup", interpretation: "Short Buildup (Aggressive Institutional Shorting)", tone: "bearish", convictionBoost: 0.70 };
  } else if (pChange < -0.2 && oiChange < -1.0) {
    return { code: "LONG_UNWINDING", regime: "LONG_UNWINDING", label: "Long Unwinding", interpretation: "Long Unwinding (Bullish Traders Dumping Longs)", tone: "bearish", convictionBoost: 0.80 };
  }
  return { code: "NEUTRAL", regime: "NEUTRAL", label: "Neutral Flow", interpretation: "Neutral Flow (Balanced Order Flow)", tone: "neutral", convictionBoost: 1.0 };
}

/**
 * Kelly Criterion & Merton's Optimal Allocation Ratio
 */
function calculateKellyFraction({ winRate, rewardToRiskRatio, fractionMultiplier = 0.50 }) {
  const p = Math.max(0.01, Math.min(0.99, Number(winRate)));
  const b = Math.max(0.5, Number(rewardToRiskRatio));
  const q = 1.0 - p;

  const fullKelly = (p * b - q) / b;
  if (fullKelly <= 0) return 0.0;

  const safeKelly = fullKelly * fractionMultiplier;
  // P1-013: Do not artificially floor to 0.05 if actual safe Kelly fraction is lower
  return Number(Math.max(0.0, Math.min(0.35, safeKelly)).toFixed(3));
}

/**
 * Ornstein-Uhlenbeck (OU) Mean-Reversion Half-Life
 */
function calculateOuHalfLife(prices) {
  if (!Array.isArray(prices) || prices.length < 20 || !prices.every(Number.isFinite)) return { halfLifeDays: null, meanReverting: false };

  const x = [];
  const y = [];
  for (let i = 1; i < prices.length; i++) {
    x.push(prices[i - 1]);
    y.push(prices[i] - prices[i - 1]);
  }

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, val, i) => sum + val * y[i], 0);
  const sumX2 = x.reduce((sum, val) => sum + val * val, 0);

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return { halfLifeDays: null, meanReverting: false };

  const lambda = (n * sumXY - sumX * sumY) / denominator;

  const phi = 1 + lambda;
  if (!(phi > 0 && phi < 1)) {
    return { halfLifeDays: null, meanReverting: false, phi, reason: "NOT_A_POSITIVE_STATIONARY_AR1" };
  }

  // Exact discrete AR(1) mapping with unit sampling interval, not Euler -lambda.
  const theta = -Math.log(phi);
  const halfLife = Math.log(2) / theta;

  return {
    halfLifeDays: Number(halfLife.toFixed(4)),
    halfLifePeriods: halfLife,
    samplingWarning: "Days only if observations are equally spaced daily samples; not an optimal holding period",
    meanReverting: halfLife < 30,
    theta: Number(theta.toFixed(4))
  };
}

/**
 * Fractional Differentiation (Marcos López de Prado)
 * Preserves maximal long-term memory while achieving statistical stationarity.
 * d typically in range [0.35, 0.50].
 */
function calculateFractionalDiff(prices, d = 0.45, threshold = 1e-4) {
  if (!Number.isFinite(d) || d < 0 || d > 1 || !Number.isFinite(threshold) || threshold <= 0
      || !Array.isArray(prices) || !prices.every(Number.isFinite)) return { fractionalSeries: [], d, memoryRetentionPct: null, weightsLength: 0, stationarityVerified: false };
  if (!Array.isArray(prices) || prices.length < 20) {
    return {
      fractionalSeries: prices.map(() => null),
      d,
      memoryRetentionPct: null,
      stationarityVerified: false,
      weightsLength: 0
    };
  }

  const weights = [1.0];
  let k = 1;
  while (true) {
    const w = -weights[k - 1] * (d - k + 1) / k;
    if (Math.abs(w) < threshold || k >= prices.length) break;
    weights.push(w);
    k++;
  }

  const result = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < weights.length - 1) {
      result.push(null);
      continue;
    }
    let val = 0;
    for (let j = 0; j < weights.length; j++) {
      val += weights[j] * prices[i - j];
    }
    result.push(Number(val.toFixed(4)));
  }

  return {
    fractionalSeries: result,
    d,
    memoryRetentionPct: null,
    stationarityVerified: false,
    weightsLength: weights.length
  };
}

/**
 * VPIN: Volume-Synchronized Probability of Informed Trading & Toxicity
 * (David Easley, Maureen O'Hara & Marcos López de Prado)
 * Slices volume into equal-sized buckets to measure order flow toxicity.
 */
function calculateVpin(bars, numBuckets = 30) {
  if (!Array.isArray(bars) || bars.length < 10 || !Number.isInteger(numBuckets) || numBuckets < 1 || numBuckets > 1000
      || !bars.every(b => Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.volume) && b.volume > 0)) {
    return { vpin: null, toxicOrderFlow: null, toxicityTone: "UNKNOWN", method: "BAR_VOLUME_PROXY_NOT_TRADE_CLASSIFIED_VPIN" };
  }

  const totalVolume = bars.reduce((sum, b) => sum + b.volume, 0);
  const bucketSize = Math.max(100, Math.floor(totalVolume / numBuckets));

  let currentBucketVol = 0;
  let currentBuyVol = 0;
  let currentSellVol = 0;
  const imbalances = [];

  // Typical price absolute volatility
  let sumAbsChange = 0;
  for (let i = 1; i < bars.length; i++) {
    sumAbsChange += Math.abs(bars[i].close - bars[i - 1].close);
  }
  const avgChange = Math.max(0.01, sumAbsChange / (bars.length - 1));

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prevBar = bars[i - 1];
    const diff = bar.close - prevBar.close;
    // Standardized direction metric
    const zScore = diff / avgChange;
    const buyFrac = Math.max(0.02, Math.min(0.98, stdNormCdf(zScore * 1.5)));
    const vol = bar.volume;

    let remainingVol = vol;
    while (remainingVol > 0) {
      const needed = bucketSize - currentBucketVol;
      const add = Math.min(needed, remainingVol);

      currentBuyVol += add * buyFrac;
      currentSellVol += add * (1.0 - buyFrac);
      currentBucketVol += add;
      remainingVol -= add;

      if (currentBucketVol >= bucketSize) {
        imbalances.push(Math.abs(currentBuyVol - currentSellVol));
        currentBucketVol = 0;
        currentBuyVol = 0;
        currentSellVol = 0;
      }
    }
  }

  if (!imbalances.length) {
    return { vpin: null, toxicOrderFlow: null, toxicityTone: "UNKNOWN" };
  }

  const sumImbalance = imbalances.reduce((a, b) => a + b, 0);
  const vpin = sumImbalance / (imbalances.length * bucketSize);
  const normalizedVpin = Number(Math.max(0.01, Math.min(0.99, vpin)).toFixed(3));

  const toxicOrderFlow = normalizedVpin >= 0.65;
  const toxicityTone = normalizedVpin >= 0.65 ? "CRITICAL" : normalizedVpin >= 0.45 ? "MODERATE" : "LOW";

  return {
    vpin: normalizedVpin,
    method: "BAR_VOLUME_PROXY_NOT_TRADE_CLASSIFIED_VPIN",
    predictiveValidation: "UNVALIDATED",
    toxicOrderFlow,
    toxicityTone,
    bucketsEvaluated: imbalances.length
  };
}

/**
 * Meta-Labeling Quality Control Gate (Marcos López de Prado)
 * Secondary AI filter: evaluates probability that primary trade will be profitable.
 */
function metaLabelConfidence({ primarySide = "long", primaryScore = 50, hurst = 0.55, er = 0.50, vpin = 0.30, isUptrend = true, strategy = "reversal" }) {
  let z = -0.2;

  // Primary trade conviction baseline
  z += (Number(primaryScore) / 100) * 1.8;

  // Regime alignment: Reversal ladders vs Trend breakouts
  if (strategy === "reversal" || strategy === "ladder") {
    // For dip-buying ladders, mean-reverting or moderate persistence is favorable
    if (hurst <= 0.45) z += 0.5; // Mean reverting regime confirms dip bounce
    else if (hurst >= 0.65 && primarySide === "long" && !isUptrend) z -= 1.0; // Strong downtrend momentum kills long dips
  } else {
    // For trend breakouts, high Hurst confirms persistence
    if (hurst >= 0.60) z += 0.8;
    else if (hurst < 0.45) z -= 0.8;
  }

  // Kaufman Efficiency: High ER (>0.4) is clean directional flow
  if (er >= 0.40) z += 0.4;
  else if (er < 0.20 && strategy !== "reversal") z -= 0.6;

  // VPIN: Order flow toxicity is universally dangerous
  if (vpin >= 0.65) z -= 1.8;
  else if (Number.isFinite(vpin) && vpin <= 0.35) z += 0.4;

  // Long trend structure alignment
  if (primarySide === "long" && isUptrend) z += 0.4;
  else if (primarySide === "long" && !isUptrend && strategy !== "reversal") z -= 0.5;

  const metaProb = Number((1.0 / (1.0 + Math.exp(-z))).toFixed(3));

  const decision = (metaProb >= 0.50 && vpin < 0.65) ? "TAKE" : "VETO";
  let metaMultiplier = 1.0;
  if (metaProb >= 0.75) metaMultiplier = 1.25;
  else if (metaProb >= 0.60) metaMultiplier = 1.0;
  else if (metaProb >= 0.50) metaMultiplier = 0.75;
  else metaMultiplier = 0.0;

  return {
    metaProb,
    calibratedProbability: null,
    validated: false,
    modelType: "HAND_WEIGHTED_HEURISTIC_DIAGNOSTIC_ONLY",
    role: "diagnostic, not a gate",
    diagnosticOnly: true,
    decision,
    metaMultiplier,
    qualityRating: metaProb >= 0.75 ? "PRIME" : metaProb >= 0.60 ? "HIGH_CONVICTION" : metaProb >= 0.50 ? "ACCEPTABLE" : "REJECTED"
  };
}

module.exports = {
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
};
