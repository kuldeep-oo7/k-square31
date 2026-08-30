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

/**
 * The Trillion Dollar Equation (Black-Scholes-Merton Model & Greeks)
 * Calculates theoretical option price, Delta, Gamma, Vega, and Theta.
 */
function blackScholesMerton({ spot, strike, timeToExpiryYears, riskFreeRate = 0.065, volatility, isCall = true }) {
  const S = Number(spot);
  const K = Number(strike);
  const T = Math.max(0.0001, Number(timeToExpiryYears));
  const r = Number(riskFreeRate);
  const sigma = Math.max(0.01, Number(volatility));

  if (!Number.isFinite(S) || !Number.isFinite(K) || S <= 0 || K <= 0) {
    return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, iv: sigma };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = stdNormCdf(d1);
  const Nd2 = stdNormCdf(d2);
  const N_neg_d1 = stdNormCdf(-d1);
  const N_neg_d2 = stdNormCdf(-d2);
  const pdf_d1 = stdNormPdf(d1);

  let price = 0;
  let delta = 0;
  let theta = 0;

  const discount = Math.exp(-r * T);

  if (isCall) {
    price = S * Nd1 - K * discount * Nd2;
    delta = Nd1;
    theta = -(S * pdf_d1 * sigma) / (2 * sqrtT) - r * K * discount * Nd2;
  } else {
    price = K * discount * N_neg_d2 - S * N_neg_d1;
    delta = Nd1 - 1.0;
    theta = -(S * pdf_d1 * sigma) / (2 * sqrtT) + r * K * discount * N_neg_d2;
  }

  const gamma = pdf_d1 / (S * sigma * sqrtT);
  const vega = S * sqrtT * pdf_d1;

  return {
    price: Math.max(0, Number(price.toFixed(2))),
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(6)),
    vega: Number((vega / 100).toFixed(4)),
    theta: Number((theta / 365).toFixed(4)),
    d1: Number(d1.toFixed(4)),
    d2: Number(d2.toFixed(4))
  };
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
    const startIndex = bars.findIndex(b => b.date >= anchorDateStr);
    if (startIndex >= 0) filteredBars = bars.slice(startIndex);
  }

  let cumulativePv = 0;
  let cumulativeVol = 0;

  for (const bar of filteredBars) {
    const typicalPrice = ((bar.high || bar.close) + (bar.low || bar.close) + bar.close) / 3.0;
    const vol = Number(bar.volume) || 1;
    cumulativePv += typicalPrice * vol;
    cumulativeVol += vol;
  }

  if (cumulativeVol <= 0) return null;
  return Number((cumulativePv / cumulativeVol).toFixed(2));
}

/**
 * F&O Institutional Open Interest (OI) Buildup Classifier
 */
function classifyOiBuildup({ priceChangePct, oiChangePct }) {
  const pChange = Number(priceChangePct) || 0;
  const oiChange = Number(oiChangePct) || 0;

  if (pChange > 0.2 && oiChange > 1.0) {
    return { code: "LONG_BUILDUP", label: "Long Buildup", tone: "bullish", convictionBoost: 1.15 };
  } else if (pChange > 0.2 && oiChange < -1.0) {
    return { code: "SHORT_COVERING", label: "Short Covering", tone: "neutral_bullish", convictionBoost: 1.05 };
  } else if (pChange < -0.2 && oiChange > 1.0) {
    return { code: "SHORT_BUILDUP", label: "Short Buildup", tone: "bearish", convictionBoost: 0.70 };
  } else if (pChange < -0.2 && oiChange < -1.0) {
    return { code: "LONG_UNWINDING", label: "Long Unwinding", tone: "bearish", convictionBoost: 0.80 };
  }
  return { code: "NEUTRAL", label: "Neutral Flow", tone: "neutral", convictionBoost: 1.0 };
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
  return Number(Math.max(0.05, Math.min(0.35, safeKelly)).toFixed(3));
}

/**
 * Ornstein-Uhlenbeck (OU) Mean-Reversion Half-Life
 */
function calculateOuHalfLife(prices) {
  if (!Array.isArray(prices) || prices.length < 20) return { halfLifeDays: null, meanReverting: false };

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

  if (lambda >= 0) {
    return { halfLifeDays: Infinity, meanReverting: false, lambda: Number(lambda.toFixed(4)) };
  }

  const theta = -lambda;
  const halfLife = Math.log(2) / theta;

  return {
    halfLifeDays: Number(Math.max(0.5, Math.min(250, halfLife)).toFixed(1)),
    meanReverting: halfLife < 30,
    theta: Number(theta.toFixed(4))
  };
}

module.exports = {
  blackScholesMerton,
  calculateHurstExponent,
  calculateKaufmanER,
  calculateAnchoredVwap,
  classifyOiBuildup,
  calculateKellyFraction,
  calculateOuHalfLife
};
