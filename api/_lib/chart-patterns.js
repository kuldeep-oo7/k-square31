"use strict";

/**
 * Quantitative Chart Pattern Recognition Engine
 *
 * Implements objective, geometric detection of classical institutional price patterns:
 * 1. Double Bottom (W-Reversal) & Double Top (M-Reversal)
 * 2. Head & Shoulders Top & Inverse Head & Shoulders Bottom
 * 3. Cup & Handle (Parabolic Accumulation + Handle Shakeout)
 * 4. Ascending & Descending Triangle Squeezes
 *
 * Based on local extrema detection (kernel pivot points) and polynomial regression.
 */

function round(val, digits = 2) {
  if (!Number.isFinite(val)) return null;
  const f = 10 ** digits;
  return Math.round((val + Number.EPSILON) * f) / f;
}

/**
 * Finds local swing peaks and troughs using rolling neighborhood analysis
 */
function findPivots(bars, windowSize = 4) {
  const pivots = [];
  const n = bars.length;
  if (n < windowSize * 2 + 1) return pivots;

  for (let i = windowSize; i < n - windowSize; i++) {
    const currentHigh = Number(bars[i].high);
    const currentLow = Number(bars[i].low);

    let isPeak = true;
    let isTrough = true;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j === i) continue;
      if (Number(bars[j].high) >= currentHigh) isPeak = false;
      if (Number(bars[j].low) <= currentLow) isTrough = false;
    }

    if (isPeak) {
      pivots.push({ type: "PEAK", index: i, price: currentHigh, timestamp: bars[i].timestamp, volume: bars[i].volume });
    } else if (isTrough) {
      pivots.push({ type: "TROUGH", index: i, price: currentLow, timestamp: bars[i].timestamp, volume: bars[i].volume });
    }
  }

  return pivots;
}

/**
 * Detects Double Bottom (W-Pattern) and Double Top (M-Pattern)
 */
function detectDoublePivots(pivots, currentPrice) {
  if (pivots.length < 3) return null;

  // Check last 3 pivots for W (Trough - Peak - Trough)
  const p1 = pivots[pivots.length - 3];
  const p2 = pivots[pivots.length - 2];
  const p3 = pivots[pivots.length - 1];

  // Double Bottom (W)
  if (p1.type === "TROUGH" && p2.type === "PEAK" && p3.type === "TROUGH") {
    const diffPct = Math.abs(p1.price - p3.price) / p1.price;
    const neckline = p2.price;
    const depth = neckline - Math.min(p1.price, p3.price);

    if (diffPct <= 0.025 && depth > 0) {
      const isConfirmed = currentPrice >= neckline * 0.99;
      return {
        pattern: "DOUBLE_BOTTOM",
        bias: "BULLISH",
        confidence: isConfirmed ? 0.82 : 0.65,
        neckline: round(neckline),
        trough1: round(p1.price),
        trough2: round(p3.price),
        targetPrice: round(neckline + depth),
        invalidationPrice: round(Math.min(p1.price, p3.price) * 0.985),
        confirmed: isConfirmed
      };
    }
  }

  // Double Top (M)
  if (p1.type === "PEAK" && p2.type === "TROUGH" && p3.type === "PEAK") {
    const diffPct = Math.abs(p1.price - p3.price) / p1.price;
    const neckline = p2.price;
    const height = Math.max(p1.price, p3.price) - neckline;

    if (diffPct <= 0.025 && height > 0) {
      const isConfirmed = currentPrice <= neckline * 1.01;
      return {
        pattern: "DOUBLE_TOP",
        bias: "BEARISH",
        confidence: isConfirmed ? 0.82 : 0.65,
        neckline: round(neckline),
        peak1: round(p1.price),
        peak2: round(p3.price),
        targetPrice: round(neckline - height),
        invalidationPrice: round(Math.max(p1.price, p3.price) * 1.015),
        confirmed: isConfirmed
      };
    }
  }

  return null;
}

/**
 * Detects 5-point Head & Shoulders and Inverse Head & Shoulders
 */
function detectHeadAndShoulders(pivots, currentPrice) {
  if (pivots.length < 5) return null;

  const [p1, p2, p3, p4, p5] = pivots.slice(-5);

  // Inverse Head & Shoulders (Bullish Reversal: Trough - Peak - Trough(Head) - Peak - Trough)
  if (p1.type === "TROUGH" && p2.type === "PEAK" && p3.type === "TROUGH" && p4.type === "PEAK" && p5.type === "TROUGH") {
    const isHeadLowest = p3.price < p1.price && p3.price < p5.price;
    const shouldersSymmetric = Math.abs(p1.price - p5.price) / p1.price <= 0.035;
    const neckline = (p2.price + p4.price) / 2;
    const headDepth = neckline - p3.price;

    if (isHeadLowest && shouldersSymmetric && headDepth > 0) {
      return {
        pattern: "INVERSE_HEAD_AND_SHOULDERS",
        bias: "BULLISH",
        confidence: 0.88,
        leftShoulder: round(p1.price),
        head: round(p3.price),
        rightShoulder: round(p5.price),
        neckline: round(neckline),
        targetPrice: round(neckline + headDepth),
        invalidationPrice: round(p5.price * 0.985),
        confirmed: currentPrice >= neckline * 0.995
      };
    }
  }

  // Standard Head & Shoulders (Bearish Reversal: Peak - Trough - Peak(Head) - Trough - Peak)
  if (p1.type === "PEAK" && p2.type === "TROUGH" && p3.type === "PEAK" && p4.type === "TROUGH" && p5.type === "PEAK") {
    const isHeadHighest = p3.price > p1.price && p3.price > p5.price;
    const shouldersSymmetric = Math.abs(p1.price - p5.price) / p1.price <= 0.035;
    const neckline = (p2.price + p4.price) / 2;
    const headHeight = p3.price - neckline;

    if (isHeadHighest && shouldersSymmetric && headHeight > 0) {
      return {
        pattern: "HEAD_AND_SHOULDERS",
        bias: "BEARISH",
        confidence: 0.88,
        leftShoulder: round(p1.price),
        head: round(p3.price),
        rightShoulder: round(p5.price),
        neckline: round(neckline),
        targetPrice: round(neckline - headHeight),
        invalidationPrice: round(p5.price * 1.015),
        confirmed: currentPrice <= neckline * 1.005
      };
    }
  }

  return null;
}

/**
 * Detects Cup & Handle Pattern via U-shaped base + consolidation handle
 */
function detectCupAndHandle(bars, pivots, currentPrice) {
  if (bars.length < 40 || pivots.length < 3) return null;

  // Look for a peak (left rim), deep rounded trough (cup bottom), and a recovery to peak level (right rim)
  const recentPeaks = pivots.filter(p => p.type === "PEAK").slice(-3);
  const recentTroughs = pivots.filter(p => p.type === "TROUGH").slice(-3);

  if (recentPeaks.length < 2 || !recentTroughs.length) return null;

  const leftRim = recentPeaks[0];
  const rightRim = recentPeaks[recentPeaks.length - 1];
  const cupBottom = recentTroughs.reduce((min, t) => t.price < min.price ? t : min, recentTroughs[0]);

  if (cupBottom.index <= leftRim.index || cupBottom.index >= rightRim.index) return null;

  const rimDiff = Math.abs(leftRim.price - rightRim.price) / leftRim.price;
  const cupDepthPct = (leftRim.price - cupBottom.price) / leftRim.price;

  // Cup must be 8% to 35% deep and rims must be within 3.5%
  if (rimDiff <= 0.035 && cupDepthPct >= 0.08 && cupDepthPct <= 0.35) {
    // Handle is a mild consolidation from right rim
    const handleDepth = (rightRim.price - currentPrice) / rightRim.price;
    const validHandle = handleDepth >= 0 && handleDepth <= cupDepthPct * 0.45;

    if (validHandle) {
      const target = rightRim.price + (rightRim.price - cupBottom.price);
      return {
        pattern: "CUP_AND_HANDLE",
        bias: "BULLISH",
        confidence: 0.85,
        rimPrice: round(rightRim.price),
        cupBottom: round(cupBottom.price),
        cupDepthPct: round(cupDepthPct * 100, 1),
        targetPrice: round(target),
        invalidationPrice: round(rightRim.price * (1 - handleDepth - 0.02)),
        confirmed: currentPrice >= rightRim.price * 0.99
      };
    }
  }

  return null;
}

/**
 * Detects Ascending & Descending Triangle Squeezes
 */
function detectTriangleSqueeze(pivots, currentPrice) {
  const peaks = pivots.filter((p) => p.type === "PEAK").slice(-3);
  const troughs = pivots.filter((p) => p.type === "TROUGH").slice(-3);
  if (peaks.length < 2 || troughs.length < 2) return null;

  const p1 = peaks[peaks.length - 2];
  const p2 = peaks[peaks.length - 1];
  const t1 = troughs[troughs.length - 2];
  const t2 = troughs[troughs.length - 1];

  const peakDiff = Math.abs(p1.price - p2.price) / p1.price;
  const troughDiff = Math.abs(t1.price - t2.price) / t1.price;

  // Ascending Triangle: Flat horizontal resistance (peaks within 1.8%), higher lows (t2 > t1)
  if (peakDiff <= 0.018 && t2.price > t1.price * 1.01) {
    const breakoutLevel = p2.price;
    const height = p2.price - t1.price;
    return {
      pattern: "ASCENDING_TRIANGLE",
      bias: "BULLISH",
      confidence: 0.80,
      breakoutLevel: round(breakoutLevel),
      targetPrice: round(breakoutLevel + height),
      invalidationPrice: round(t2.price),
      confirmed: currentPrice >= breakoutLevel * 0.995
    };
  }

  // Descending Triangle: Flat horizontal support (troughs within 1.8%), lower highs (p2 < p1)
  if (troughDiff <= 0.018 && p2.price < p1.price * 0.99) {
    const breakdownLevel = t2.price;
    const height = p1.price - t2.price;
    return {
      pattern: "DESCENDING_TRIANGLE",
      bias: "BEARISH",
      confidence: 0.80,
      breakdownLevel: round(breakdownLevel),
      targetPrice: round(breakdownLevel - height),
      invalidationPrice: round(p2.price),
      confirmed: currentPrice <= breakdownLevel * 1.005
    };
  }

  return null;
}

/**
 * Master scanner: evaluates all classical patterns for a symbol's bars
 */
function scanChartPatterns(bars) {
  if (!Array.isArray(bars) || bars.length < 30) {
    return { detected: false, patterns: [], primaryPattern: null, confluenceBonus: 0 };
  }

  const currentPrice = Number(bars.at(-1).close);
  const pivots = findPivots(bars, 4);

  const doublePattern = detectDoublePivots(pivots, currentPrice);
  const hsPattern = detectHeadAndShoulders(pivots, currentPrice);
  const cupPattern = detectCupAndHandle(bars, pivots, currentPrice);
  const trianglePattern = detectTriangleSqueeze(pivots, currentPrice);

  const patterns = [hsPattern, cupPattern, doublePattern, trianglePattern].filter(Boolean);

  if (!patterns.length) {
    return { detected: false, patterns: [], primaryPattern: null, confluenceBonus: 0 };
  }

  // Sort by highest confidence
  patterns.sort((a, b) => b.confidence - a.confidence);
  const primary = patterns[0];

  // P1-007: Confluence bonus is strictly awarded ONLY when the pattern is CONFIRMED
  const confluenceBonus = (primary && primary.confirmed === true)
    ? (primary.bias === "BULLISH" ? Math.round(primary.confidence * 18) : -Math.round(primary.confidence * 18))
    : 0;

  return {
    detected: true,
    patterns,
    primaryPattern: primary,
    confluenceBonus,
    pivotsCount: pivots.length
  };
}

module.exports = {
  detectCupAndHandle,
  detectDoublePivots,
  detectHeadAndShoulders,
  detectTriangleSqueeze,
  findPivots,
  scanChartPatterns
};
