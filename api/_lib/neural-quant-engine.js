"use strict";

/**
 * 1D-CNN Temporal Convolutional Signal Detector & Quantitative Alpha Engine
 *
 * NOTE: These 4 kernels are domain-engineered matched filters (wavelet pattern bank)
 * designed from institutional price-volume motifs (momentum acceleration, oversold spring,
 * volatility squeeze, volume absorption). They are hand-designed matched filters, NOT
 * gradient backpropagation-trained weights.
 * The 1D convolution arithmetic, LeakyReLU activation, and MaxPool1D pooling are real and deterministic.
 *
 * Architecture:
 * 1. 3-Channel Temporal Preprocessing (Returns, Range Deviation, Volume Deviation)
 * 2. Multi-Kernel Conv1D Matched Filters (Momentum, Mean-Reversion, Squeeze, Institutional Absorption)
 * 3. LeakyReLU Activation & MaxPool1D
 * 4. Factor Fusion (Temporal matched filter visual activations + Quant Factors)
 * 5. Convolutional Alpha Score (0 - 100) & Regime Prediction
 */

function round(val, digits = 2) {
  if (!Number.isFinite(val)) return null;
  const f = 10 ** digits;
  return Math.round((val + Number.EPSILON) * f) / f;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, x))));
}

function leakyRelu(x, alpha = 0.01) {
  return x >= 0 ? x : alpha * x;
}

/**
 * 4 Domain-Engineered Conv1D Matched Filter Kernels for Temporal Financial Time Series
 * Kernel dimensions: [inChannels = 3, kernelSize = 3]
 * Hand-tuned matched filters, not backprop gradient-trained weights.
 */
const CONV_KERNELS = [
  // Kernel 0: Upward Momentum & Breakout Filter
  {
    name: "MOMENTUM_BREAKOUT",
    weights: [
      [-0.2, 0.4, 1.2],   // Returns channel (accelerating positive returns)
      [-0.1, 0.2, 0.8],   // Range channel (widening range)
      [0.0, 0.3, 1.0]     // Volume channel (rising volume)
    ],
    bias: 0.15
  },
  // Kernel 1: Mean Reversion / Oversold Spring Filter
  {
    name: "MEAN_REVERSION_SPRING",
    weights: [
      [-1.0, -0.6, 0.8],  // Returns channel (sharp drop followed by snap-back)
      [0.8, 0.4, 0.2],    // Range channel (exhaustion spike)
      [1.2, 0.6, 0.4]     // Volume channel (high volume panic selling absorbed)
    ],
    bias: -0.10
  },
  // Kernel 2: Volatility Contraction / Squeeze Filter
  {
    name: "VOLATILITY_SQUEEZE",
    weights: [
      [0.1, -0.05, 0.05], // Returns channel (tight equilibrium)
      [-0.8, -0.9, -0.7], // Range channel (tightening compression)
      [-0.5, -0.4, 0.6]   // Volume channel (drying up before sudden surge)
    ],
    bias: 0.20
  },
  // Kernel 3: Institutional Block Flow / Absorption Filter
  {
    name: "INSTITUTIONAL_ABSORPTION",
    weights: [
      [0.1, 0.15, 0.2],   // Returns channel (quiet drift)
      [-0.3, -0.2, -0.1], // Range channel (controlled tight bars)
      [1.0, 1.4, 1.8]     // Volume channel (massive volume footprint)
    ],
    bias: 0.05
  }
];

/**
 * Prepares 3-channel normalized temporal tensor from raw bars
 * Lookback: minimum 10 bars, ideal 30 bars
 */
function extractTemporalTensor(rawBars, maxLookback = 30) {
  if (!Array.isArray(rawBars) || rawBars.length < 5) return null;

  const slice = rawBars.slice(-maxLookback);
  const n = slice.length;

  const returns = [];
  const ranges = [];
  const volumes = [];

  let volSum = 0;
  for (let i = 0; i < n; i++) {
    volSum += Number(slice[i].volume || slice[i].v || 1000);
  }
  const avgVol = Math.max(1, volSum / n);

  for (let i = 0; i < n; i++) {
    const c = Number(slice[i].close || slice[i].c || 100);
    const prevC = i > 0 ? Number(slice[i - 1].close || slice[i - 1].c || c) : c;
    const h = Number(slice[i].high || slice[i].h || c);
    const l = Number(slice[i].low || slice[i].l || c);
    const v = Number(slice[i].volume || slice[i].v || avgVol);

    const r = prevC > 0 ? (c - prevC) / prevC : 0;
    const rng = c > 0 ? (h - l) / c : 0.01;
    const vNorm = v / avgVol;

    // All three channels must be mean-zero and on a comparable scale, or the
    // convolution measures whichever channel is largest rather than the shape of
    // the series.
    //
    // Volume was previously pushed as v/avgVol clamped to [0.1, 5], so it sat
    // around 1.0 while returns sat in [-0.2, 0.2] and ranges in [0, 0.5]. It
    // also carries the heaviest kernel weights -- INSTITUTIONAL_ABSORPTION reads
    // [1.0, 1.4, 1.8] on this channel -- so a typical bar contributed a constant
    // of roughly +4.2 to the logit for every symbol in the universe. sigmoid(z)
    // then pinned at 1 and the score hit its own ceiling: measured across the
    // 210-name F&O universe, 205 names scored exactly 98 and the "neural >= 70"
    // hurdle passed 210 of 210. A gate that admits everything is not a gate.
    //
    // Centring the channel removes that constant and leaves the deviation, which
    // is the thing the absorption kernel was meant to detect in the first place.
    returns.push(Math.max(-0.2, Math.min(0.2, r * 10))); // Scaled return
    ranges.push(Math.max(-0.5, Math.min(0.5, rng * 10 - 0.1))); // Range deviation
    volumes.push(Math.max(-1, Math.min(4, vNorm - 1)));  // Volume deviation
  }

  return { returns, ranges, volumes, length: n };
}

/**
 * 1D Convolution Forward Pass over the 3 temporal channels
 */
function conv1DForward(tensor) {
  const { returns, ranges, volumes, length } = tensor;
  const kernelSize = 3;
  const numKernels = CONV_KERNELS.length;
  const featureMaps = [];

  for (let k = 0; k < numKernels; k++) {
    const kernel = CONV_KERNELS[k];
    const map = [];

    for (let t = 0; t <= length - kernelSize; t++) {
      let sum = kernel.bias;

      for (let w = 0; w < kernelSize; w++) {
        sum += returns[t + w] * kernel.weights[0][w];
        sum += ranges[t + w] * kernel.weights[1][w];
        sum += volumes[t + w] * kernel.weights[2][w];
      }

      // LeakyReLU activation
      map.push(leakyRelu(sum));
    }

    featureMaps.push({ name: kernel.name, values: map });
  }

  return featureMaps;
}

/**
 * Max Pooling 1D (poolSize = 2, stride = 2)
 */
function maxPool1D(featureMaps) {
  const pooledFeatures = [];

  for (const fMap of featureMaps) {
    const vals = fMap.values;
    const pooled = [];

    for (let i = 0; i < vals.length; i += 2) {
      if (i + 1 < vals.length) {
        pooled.push(Math.max(vals[i], vals[i + 1]));
      } else {
        pooled.push(vals[i]);
      }
    }

    // Extract dominant peak activation for this kernel
    const maxActivation = pooled.length > 0 ? Math.max(...pooled) : 0;
    const meanActivation = pooled.length > 0 ? pooled.reduce((a, b) => a + b, 0) / pooled.length : 0;

    pooledFeatures.push({
      kernel: fMap.name,
      maxVal: maxActivation,
      meanVal: meanActivation,
      vector: pooled
    });
  }

  return pooledFeatures;
}

/**
 * Matched Filter Convolutional Forward Pass with Factor Embedding Fusion
 * Fuses 1D-CNN temporal matched filter activations with mathematical quant features
 */
function evaluateNeuralAlpha({ bars, quantFactors = {}, sentimentScore = 0.50 } = {}) {
  const tensor = extractTemporalTensor(bars, 30);
  if (!tensor || tensor.length < 5) {
    return {
      neuralAlphaScore: 50,
      predictedRegime: "NEUTRAL_CONSOLIDATION",
      convConfidence: 0.50,
      salientMotif: "INSUFFICIENT_HISTORY",
      activations: {}
    };
  }

  // 1. Conv1D Feature Extraction
  const convOut = conv1DForward(tensor);

  // 2. MaxPool1D
  const pooled = maxPool1D(convOut);

  // Find most active CNN motif
  let bestMotif = pooled[0];
  for (const p of pooled) {
    if (p.maxVal > bestMotif.maxVal) {
      bestMotif = p;
    }
  }

  // 3. Dense Layer Factor Fusion:
  // Quantitative Factor normalizations:
  const hurst = Number(quantFactors.hurst || 0.50);
  const vpin = Number(quantFactors.vpin || 0.20);
  const er = Number(quantFactors.er || 0.50);
  const ouHalfLife = Number(quantFactors.halfLife || 5);
  const garchVol = Number(quantFactors.garchVol || 0.18);
  const kyleLambda = Number(quantFactors.kyleLambda || 1.0);

  // Weighted Linear Combination in Dense Output Node:
  // - High Hurst (> 0.55) & High ER (> 0.50) favor momentum
  // - Low VPIN (< 0.30) confirms non-toxic clean order flow
  // - Low Kyle Lambda (< 3.0) confirms deep institutional liquidity
  // - Moderate GARCH (12% - 24%) provides optimal range expansion without panic risk
  let z = 0.0;

  // CNN Visual Activations contribution (40% weight)
  const momAct = (pooled.find(p => p.kernel === "MOMENTUM_BREAKOUT")?.maxVal || 0) * 0.45;
  const revAct = (pooled.find(p => p.kernel === "MEAN_REVERSION_SPRING")?.maxVal || 0) * 0.35;
  const sqzAct = (pooled.find(p => p.kernel === "VOLATILITY_SQUEEZE")?.maxVal || 0) * 0.25;
  const absAct = (pooled.find(p => p.kernel === "INSTITUTIONAL_ABSORPTION")?.maxVal || 0) * 0.30;
  z += (momAct + revAct + sqzAct + absAct);

  // Quant Factor Fusion contribution (45% weight)
  z += (hurst - 0.50) * 4.0;          // Hurst contribution (-0.8 to +0.8)
  z += (er - 0.40) * 2.0;             // Kaufman efficiency ratio
  z -= (vpin - 0.25) * 3.5;           // Penalize toxic order flow
  z -= Math.max(0, kyleLambda - 2.5) * 0.5; // Penalize heavy price impact
  z += (sentimentScore - 0.50) * 1.5; // Sentiment contribution

  // Volatility conditioning
  if (garchVol > 0.35) z -= 1.2; // High volatility penalty
  if (garchVol < 0.12) z -= 0.5; // Stagnant volatility penalty

  // 4. Calibrated Sigmoid Alpha Output (0 to 100)
  const probability = sigmoid(z);
  const alphaScore = Math.max(5, Math.min(98, Math.round(probability * 100)));

  // Regime classification based on dominant neural activation
  let regime = "BALANCED_RANGE";
  if (bestMotif.kernel === "MOMENTUM_BREAKOUT" && alphaScore >= 65) {
    regime = "TRENDING_BREAKOUT";
  } else if (bestMotif.kernel === "MEAN_REVERSION_SPRING" && alphaScore >= 60) {
    regime = "MEAN_REVERSION_LONG";
  } else if (bestMotif.kernel === "VOLATILITY_SQUEEZE") {
    regime = "COMPRESSION_EXPANSION";
  } else if (bestMotif.kernel === "INSTITUTIONAL_ABSORPTION") {
    regime = "INSTITUTIONAL_ACCUMULATION";
  } else if (alphaScore < 40) {
    regime = "DISTRIBUTION_EXHAUSTION";
  }

  const confidence = round(Math.abs(probability - 0.5) * 2, 2);

  return {
    rawZ: round(z, 4),
    rawActivationScore: round(bestMotif.maxVal, 4),
    neuralAlphaScore: alphaScore,
    predictedRegime: regime,
    convConfidence: confidence,
    salientMotif: bestMotif.kernel,
    peakActivation: round(bestMotif.maxVal, 3),
    cnnMotifs: pooled.map(p => ({ motif: p.kernel, intensity: round(p.maxVal, 2) }))
  };
}

module.exports = {
  extractTemporalTensor,
  conv1DForward,
  maxPool1D,
  evaluateNeuralAlpha
};
