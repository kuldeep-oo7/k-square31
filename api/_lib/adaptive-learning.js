"use strict";

function round(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function analyzeOutcomeSignatures(resolvedSignals = []) {
  const wins = resolvedSignals.filter((s) => s.outcome === "WIN");
  const losses = resolvedSignals.filter((s) => s.outcome === "LOSS");

  if (wins.length + losses.length < 5) {
    return {
      ready: false,
      reason: "Need at least 5 resolved trades to compute adaptive factor learning",
      adjustments: {}
    };
  }

  const featureNames = [
    "return5Pct", "return21Pct", "atr14Pct", "realisedVol21Pct",
    "rsi14", "zScore20", "volumeRatio520", "highProximityPct"
  ];

  const adjustments = {};
  featureNames.forEach((feat) => {
    const winValues = wins.map((s) => Number(s.features?.[feat])).filter(Number.isFinite);
    const lossValues = losses.map((s) => Number(s.features?.[feat])).filter(Number.isFinite);
    const winAvg = mean(winValues);
    const lossAvg = mean(lossValues);

    const separation = lossAvg !== 0 ? (winAvg - lossAvg) / Math.abs(lossAvg) : 0;
    adjustments[feat] = {
      winAvg: round(winAvg, 2),
      lossAvg: round(lossAvg, 2),
      separationPct: round(separation * 100, 1),
      preferredDirection: separation > 0 ? "HIGHER" : "LOWER",
      weightMultiplier: round(Math.max(0.5, Math.min(1.8, 1 + separation * 0.5)), 2)
    };
  });

  const highVolLosses = losses.filter((s) => Number(s.features?.realisedVol21Pct) > 40).length;
  const highVolLossRatio = losses.length ? highVolLosses / losses.length : 0;
  const tightenVolVeto = highVolLossRatio > 0.4;

  return {
    ready: true,
    samples: resolvedSignals.length,
    winRatePct: round((wins.length / (wins.length + losses.length)) * 100, 1),
    adjustments,
    tightenVolVeto,
    recommendationMultiplier: round(Math.max(0.5, Math.min(1.5, (wins.length + 1) / (losses.length + 1))), 2)
  };
}

module.exports = {
  analyzeOutcomeSignatures,
  round
};
