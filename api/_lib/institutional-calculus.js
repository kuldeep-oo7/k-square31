"use strict";

/**
 * Institutional Calculus, Stochastic Differential Equations & Risk Engine
 *
 * Implements rigorous mathematical formulations of institutional quantitative finance:
 * 1. Geometric Brownian Motion (GBM) & Itô's Lemma Drift/Diffusion Decomposition
 * 2. GARCH(1,1) Conditional Volatility Forecasting (Bollerslev 1986)
 * 3. Cornish-Fisher Value-at-Risk (VaR) & Conditional VaR (CVaR / Expected Shortfall)
 * 4. Market Microstructure Liquidity: Kyle's Lambda & Amihud Illiquidity Ratio
 * 5. Kalman Filter Recursive State-Space Estimator for Time-Varying Beta & Cointegration
 */

function round(val, digits = 4) {
  if (!Number.isFinite(val)) return null;
  const f = 10 ** digits;
  return Math.round((val + Number.EPSILON) * f) / f;
}

/**
 * Normal Distribution Quantiles for Cornish-Fisher Expansion
 */
const Z_CRITICAL = {
  0.90: 1.2816,
  0.95: 1.6449,
  0.99: 2.3263,
  0.999: 3.0902
};

/**
 * Computes log returns and summary statistics (mean, variance, skewness, kurtosis)
 */
function calculateMoments(prices) {
  if (!Array.isArray(prices) || prices.length < 5) {
    return { mean: 0, variance: 0, stdDev: 0, skewness: 0, kurtosis: 3, returns: [] };
  }

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  const n = returns.length;
  if (n < 4) return { mean: 0, variance: 0, stdDev: 0, skewness: 0, kurtosis: 3, returns };

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;

  for (let i = 0; i < n; i++) {
    const diff = returns[i] - mean;
    const diff2 = diff * diff;
    m2 += diff2;
    m3 += diff2 * diff;
    m4 += diff2 * diff2;
  }

  const variance = m2 / (n - 1);
  const stdDev = Math.sqrt(Math.max(1e-12, variance));
  const skewness = (m3 / n) / Math.pow(variance, 1.5);
  const kurtosis = (m4 / n) / Math.pow(variance, 2);

  return { mean, variance, stdDev, skewness, kurtosis, returns };
}

/**
 * 1. Geometric Brownian Motion (GBM) Parameter Estimation & Itô Drift/Diffusion
 * dS_t = mu * S_t * dt + sigma * S_t * dW_t
 * Under Itô's Lemma: d(ln S_t) = (mu - 0.5 * sigma^2) * dt + sigma * dW_t
 */
function estimateGbmParameters(prices, dt = 1 / 252) {
  const { mean, stdDev } = calculateMoments(prices);
  if (stdDev <= 0) return { annualizedDrift: 0, annualizedVol: 0, itoDriftCorrection: 0 };

  const annualizedVol = stdDev * Math.sqrt(1 / dt);
  const annualizedDrift = (mean / dt) + 0.5 * (annualizedVol ** 2);
  const itoDriftCorrection = -0.5 * (annualizedVol ** 2);

  return {
    annualizedDrift: round(annualizedDrift),
    annualizedVol: round(annualizedVol),
    itoDriftCorrection: round(itoDriftCorrection),
    dailyDrift: round(mean),
    dailyVol: round(stdDev)
  };
}

/**
 * 2. GARCH(1,1) Conditional Volatility Forecasting
 * sigma_t^2 = omega + alpha * epsilon_{t-1}^2 + beta * sigma_{t-1}^2
 * Standard empirical baseline parameters for Indian equities: omega ~ 1e-5, alpha ~ 0.08, beta ~ 0.88 (alpha + beta < 1)
 */
function forecastGarch11Volatility(prices, { horizonDays = 5, omega = 0.000005, alpha = 0.08, beta = 0.88 } = {}) {
  const { returns, variance } = calculateMoments(prices);
  if (returns.length < 10) {
    return {
      currentAnnualizedVol: round(Math.sqrt(variance) * Math.sqrt(252)),
      forecastedAnnualizedVol: round(Math.sqrt(variance) * Math.sqrt(252)),
      persistence: alpha + beta,
      longRunAnnualizedVol: null,
      volatilityRegime: "MODERATE_VOL"
    };
  }

  // Stationarity check: alpha + beta must be strictly < 1
  const persistence = alpha + beta;
  const longRunVariance = persistence < 1.0 ? omega / (1.0 - persistence) : variance;

  // Filter rolling conditional variance through history
  let currentVar = variance;
  for (let i = 1; i < returns.length; i++) {
    const shock = returns[i - 1];
    const shockSquared = shock * shock;
    currentVar = omega + alpha * shockSquared + beta * currentVar;
  }

  // Multi-step forward projection:
  // E[sigma_{t+k}^2] = V_L + (alpha + beta)^k * (sigma_t^2 - V_L)
  let projectedVarSum = 0;
  for (let k = 1; k <= horizonDays; k++) {
    const projectedVarK = longRunVariance + Math.pow(persistence, k) * (currentVar - longRunVariance);
    projectedVarSum += projectedVarK;
  }

  const averageProjectedVar = projectedVarSum / horizonDays;
  const annualizedCurrentVol = Math.sqrt(Math.max(1e-12, currentVar)) * Math.sqrt(252);
  const annualizedForecastedVol = Math.sqrt(Math.max(1e-12, averageProjectedVar)) * Math.sqrt(252);
  const annualizedLongRunVol = Math.sqrt(Math.max(1e-12, longRunVariance)) * Math.sqrt(252);

  return {
    currentAnnualizedVol: round(annualizedCurrentVol, 4),
    forecastedAnnualizedVol: round(annualizedForecastedVol, 4),
    longRunAnnualizedVol: round(annualizedLongRunVol, 4),
    dailyVariance: round(currentVar, 8),
    persistence: round(persistence, 4),
    volatilityRegime: annualizedForecastedVol > 0.28 ? "HIGH_VOL" : annualizedForecastedVol < 0.15 ? "LOW_VOL" : "MODERATE_VOL"
  };
}

/**
 * 3. Cornish-Fisher Expansion for Value-at-Risk (VaR) and Conditional VaR (CVaR / Expected Shortfall)
 * Adjusts Gaussian VaR for higher-order skewness (S) and excess kurtosis (K):
 * z_CF = z + (z^2 - 1)*S / 6 + (z^3 - 3z)*K / 24 - (2z^3 - 5z)*S^2 / 36
 */
function calculateCornishFisherRisk(prices, notionalRupees = 1000000, confidence = 0.99) {
  const { mean, stdDev, skewness, kurtosis } = calculateMoments(prices);
  if (stdDev <= 0 || notionalRupees <= 0) {
    return { varRupees: 0, cvarRupees: 0, varPct: 0, cvarPct: 0, skewness: 0, excessKurtosis: 0 };
  }

  const z = Z_CRITICAL[confidence] || 2.3263;
  const S = Number.isFinite(skewness) ? Math.max(-3, Math.min(3, skewness)) : 0;
  const excessK = Number.isFinite(kurtosis) ? Math.max(-1, Math.min(10, kurtosis - 3)) : 0;

  // Cornish-Fisher adjusted critical quantile
  const zCF = z +
    ((z * z - 1) * S) / 6 +
    ((z * z * z - 3 * z) * excessK) / 24 -
    ((2 * z * z * z - 5 * z) * S * S) / 36;

  // Daily VaR percentage (1-tail downside loss)
  const varPct = Math.max(0, -mean + zCF * stdDev);
  const varRupees = varPct * notionalRupees;

  // Expected Shortfall (CVaR) approximation via standard normal density integration
  const phiZ = Math.exp(-0.5 * zCF * zCF) / Math.sqrt(2 * Math.PI);
  const alphaTail = 1 - confidence;
  const cvarFactor = Math.max(zCF, phiZ / Math.max(1e-6, alphaTail));
  const cvarPct = Math.max(varPct, -mean + cvarFactor * stdDev);
  const cvarRupees = cvarPct * notionalRupees;

  return {
    varPct: round(varPct * 100, 2),
    varRupees: round(varRupees, 2),
    cvarPct: round(cvarPct * 100, 2),
    cvarRupees: round(cvarRupees, 2),
    skewness: round(S, 3),
    excessKurtosis: round(excessK, 3),
    gaussianQuantile: z,
    adjustedQuantile: round(zCF, 3)
  };
}

/**
 * 4. Microstructure Liquidity & Kyle's Lambda (Price Impact)
 * Delta P_t = lambda * OrderFlow_t + eta_t
 * Kyle's Lambda measures illiquidity: rupees price shift per lakh traded.
 * Amihud Illiquidity Ratio = (|Return_t| / Volume_t) * 1e6
 */
function calculateMicrostructureLiquidity(bars) {
  if (!Array.isArray(bars) || bars.length < 10) {
    return { kyleLambda: 0, amihudRatio: 0, liquidityScore: 1.0, isLiquid: true };
  }

  let amihudSum = 0;
  let count = 0;
  const priceChanges = [];
  const signedVolumes = [];

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const close = Number(curr.close || curr.c);
    const prevClose = Number(prev.close || prev.c);
    const vol = Number(curr.volume || curr.v || 0);

    if (close > 0 && prevClose > 0 && vol > 0) {
      const ret = Math.abs((close - prevClose) / prevClose);
      amihudSum += (ret / vol) * 1e6;
      count++;

      const deltaP = close - prevClose;
      const signedVol = (close >= prevClose ? 1 : -1) * vol;
      priceChanges.push(deltaP);
      signedVolumes.push(signedVol);
    }
  }

  const amihudRatio = count > 0 ? amihudSum / count : 0;

  // Kyle's Lambda via OLS regression: Cov(DeltaP, SignedVol) / Var(SignedVol)
  let kyleLambda = 0;
  if (signedVolumes.length >= 8) {
    const meanVol = signedVolumes.reduce((a, b) => a + b, 0) / signedVolumes.length;
    const meanP = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;

    let cov = 0;
    let varVol = 0;
    for (let i = 0; i < signedVolumes.length; i++) {
      const devVol = signedVolumes[i] - meanVol;
      const devP = priceChanges[i] - meanP;
      cov += devVol * devP;
      varVol += devVol * devVol;
    }

    if (varVol > 0) {
      // Lambda scaled to price impact per 100,000 shares
      kyleLambda = Math.max(0, (cov / varVol) * 100000);
    }
  }

  // Normalized liquidity score (0.0 to 1.0, where 1.0 is highest institutional liquidity)
  const liquidityScore = Math.max(0, Math.min(1, 1 / (1 + amihudRatio * 0.5 + kyleLambda * 0.1)));
  const isLiquid = amihudRatio < 2.5 && kyleLambda < 5.0;

  return {
    kyleLambda: round(kyleLambda, 4),
    amihudRatio: round(amihudRatio, 4),
    liquidityScore: round(liquidityScore, 3),
    isLiquid
  };
}

/**
 * 5. Kalman Filter Recursive State-Space Estimator
 * Dynamically tracks the time-varying hedge ratio (beta_t) and alpha_t between asset Y and benchmark X:
 * y_t = alpha_t + beta_t * x_t + e_t
 */
class KalmanHedgeEstimator {
  constructor({ delta = 1e-4, R = 1e-3 } = {}) {
    this.delta = delta; // Process noise covariance factor
    this.R = R;         // Measurement noise variance
    this.state = [0, 1]; // [alpha, beta]
    this.P = [[1, 0], [0, 1]]; // Covariance matrix
  }

  update(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.getBeta();

    // 1. Process noise addition (random walk of states)
    const qVal = this.delta / (1.0 - this.delta);
    this.P[0][0] += qVal;
    this.P[1][1] += qVal;

    // 2. Observation matrix H = [1, x]
    const H = [1, x];

    // 3. Error / Innovation: y_pred = alpha + beta * x
    const yPred = this.state[0] * H[0] + this.state[1] * H[1];
    const error = y - yPred;

    // 4. Innovation covariance: S = H * P * H^T + R
    const S = H[0] * (this.P[0][0] * H[0] + this.P[1][0] * H[1]) +
              H[1] * (this.P[0][1] * H[0] + this.P[1][1] * H[1]) + this.R;

    if (S <= 0) return this.getBeta();

    // 5. Kalman Gain: K = P * H^T / S
    const K = [
      (this.P[0][0] * H[0] + this.P[1][0] * H[1]) / S,
      (this.P[0][1] * H[0] + this.P[1][1] * H[1]) / S
    ];

    // 6. Update State: state = state + K * error
    this.state[0] += K[0] * error;
    this.state[1] += K[1] * error;

    // 7. Update Covariance: P = (I - K * H) * P
    const p00 = this.P[0][0] - K[0] * (H[0] * this.P[0][0] + H[1] * this.P[1][0]);
    const p01 = this.P[0][1] - K[0] * (H[0] * this.P[0][1] + H[1] * this.P[1][1]);
    const p10 = this.P[1][0] - K[1] * (H[0] * this.P[0][0] + H[1] * this.P[1][0]);
    const p11 = this.P[1][1] - K[1] * (H[0] * this.P[0][1] + H[1] * this.P[1][1]);

    this.P[0][0] = p00;
    this.P[0][1] = p01;
    this.P[1][0] = p10;
    this.P[1][1] = p11;

    return this.getBeta();
  }

  getBeta() {
    return round(this.state[1], 4);
  }

  getAlpha() {
    return round(this.state[0], 4);
  }
}

module.exports = {
  calculateMoments,
  estimateGbmParameters,
  forecastGarch11Volatility,
  calculateCornishFisherRisk,
  calculateMicrostructureLiquidity,
  KalmanHedgeEstimator
};
