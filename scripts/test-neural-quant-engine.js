"use strict";

const assert = require("assert");
const {
  extractTemporalTensor,
  conv1DForward,
  maxPool1D,
  evaluateNeuralAlpha
} = require("../api/_lib/neural-quant-engine");

console.log("Starting 1D-CNN Neural Alpha Engine test suite...");

// 1. Synthetic Breakout Series (30 bars)
const breakoutBars = [];
let price = 100;
for (let i = 0; i < 30; i++) {
  // Accelerating price rally with rising volume in last 10 bars
  const step = i > 20 ? 1.5 : 0.2;
  price += step;
  const vol = i > 20 ? 25000 : 8000;
  breakoutBars.push({
    open: price - 0.2,
    high: price + 0.3,
    low: price - 0.3,
    close: price,
    volume: vol
  });
}

const tensor = extractTemporalTensor(breakoutBars, 30);
assert(tensor !== null, "Tensor extraction must succeed");
assert(tensor.returns.length === 30, "Returns length must match lookback");
assert(tensor.ranges.length === 30, "Ranges length must match lookback");
assert(tensor.volumes.length === 30, "Volumes length must match lookback");
console.log("  ✓ 3-Channel Temporal Tensor extraction verified (30 bars, 3 channels)");

// 2. Conv1D Forward Pass
const convOut = conv1DForward(tensor);
assert(convOut.length === 4, "Should have 4 feature maps from 4 Conv1D kernels");
assert(convOut[0].values.length === 30 - 3 + 1, "Conv1D valid padding length = L - K + 1");
console.log("  ✓ Conv1D Forward Pass verified (4 temporal kernels, output length:", convOut[0].values.length + ")");

// 3. MaxPool1D
const pooled = maxPool1D(convOut);
assert(pooled.length === 4, "Should have 4 pooled feature representations");
assert(Number.isFinite(pooled[0].maxVal), "Max activation must be finite");
console.log("  ✓ MaxPool1D pooling verified (Kernels:", pooled.map(p => p.kernel).join(", ") + ")");

// 4. End-to-End Factor Fusion & Neural Alpha Score
const quantFactors = {
  hurst: 0.65,
  vpin: 0.18,
  er: 0.62,
  halfLife: 3.5,
  garchVol: 0.19,
  kyleLambda: 0.85
};

const neuralResult = evaluateNeuralAlpha({
  bars: breakoutBars,
  quantFactors,
  sentimentScore: 0.70
});

assert(neuralResult.neuralAlphaScore >= 0 && neuralResult.neuralAlphaScore <= 100, "Neural score must be in [0, 100]");
assert(neuralResult.neuralAlphaScore >= 60, "Breakout series with bullish quant factors should score >= 60, got: " + neuralResult.neuralAlphaScore);
assert(["MOMENTUM_BREAKOUT", "INSTITUTIONAL_ABSORPTION"].includes(neuralResult.salientMotif), "Salient motif should be MOMENTUM_BREAKOUT or INSTITUTIONAL_ABSORPTION, got: " + neuralResult.salientMotif);
console.log("  ✓ Full Neural Alpha evaluation verified: Score:", neuralResult.neuralAlphaScore + "/100 | Regime:", neuralResult.predictedRegime + " | Motif:", neuralResult.salientMotif);

console.log("ALL 1D-CNN Neural Alpha Engine tests passed successfully!\n");
