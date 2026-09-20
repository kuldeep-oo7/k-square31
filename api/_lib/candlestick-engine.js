"use strict";

/**
 * Institutional Candlestick Pattern Recognition Engine
 *
 * Implements exact geometric, ratio-driven recognition of Japanese candlestick formations:
 * 1. Single-Candle: Marubozu, Hammer, Shooting Star, Inverted Hammer, Hanging Man, Doji (Dragonfly, Gravestone, Long-legged)
 * 2. Two-Candle: Bullish/Bearish Engulfing, Piercing Line, Dark Cloud Cover, Inside Bar (Harami)
 * 3. Three-Candle: Morning Star, Evening Star, Three White Soldiers, Three Black Crows
 */

function round(val, digits = 2) {
  if (!Number.isFinite(val)) return null;
  const f = 10 ** digits;
  return Math.round((val + Number.EPSILON) * f) / f;
}

function parseBar(bar) {
  const o = Number(bar.open || bar.o);
  const h = Number(bar.high || bar.h);
  const l = Number(bar.low || bar.l);
  const c = Number(bar.close || bar.c);
  const v = Number(bar.volume || bar.v || 0);

  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
    return null;
  }

  const range = Math.max(1e-6, h - l);
  const body = Math.abs(c - o);
  const isBullish = c >= o;
  const upperShadow = isBullish ? h - c : h - o;
  const lowerShadow = isBullish ? o - l : c - l;
  const bodyTop = Math.max(o, c);
  const bodyBottom = Math.min(o, c);

  return {
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    range,
    body,
    isBullish,
    upperShadow,
    lowerShadow,
    bodyTop,
    bodyBottom,
    bodyToRange: body / range,
    upperToBody: upperShadow / Math.max(1e-6, body),
    lowerToBody: lowerShadow / Math.max(1e-6, body)
  };
}

/**
 * Scans the latest bars (last 1 to 3 bars) for high-probability candlestick patterns
 */
function identifyCandlestickPatterns(rawBars) {
  if (!Array.isArray(rawBars) || rawBars.length < 3) {
    return { patterns: [], primaryPattern: null, bias: "NEUTRAL", score: 0.50 };
  }

  const bars = rawBars.map(parseBar).filter(Boolean);
  if (bars.length < 3) {
    return { patterns: [], primaryPattern: null, bias: "NEUTRAL", score: 0.50 };
  }

  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];

  // THE PRIOR TREND, WITHOUT WHICH HALF THESE PATTERNS HAVE NO MEANING.
  //
  // This is the oldest rule in Japanese candlestick analysis and it was missing.
  // A long lower shadow is a HAMMER after a decline and a HANGING MAN after a
  // rally -- the SAME GEOMETRY, opposite meanings, told apart only by what came
  // before. Likewise a long upper shadow is a SHOOTING STAR after a rally and an
  // INVERTED HAMMER after a decline.
  //
  // Measured across 210 symbols before this fix: 22 of 23 detections labelled
  // SHOOTING_STAR (bearish) had followed a DOWNTREND, which makes them Inverted
  // Hammers and classically BULLISH. The sign was inverted on 96% of the second
  // most common pattern the engine emits, and candlesticks carry 15% of the
  // composite weight.
  //
  // Five sessions back is the conventional look-back for "the prior trend" on a
  // daily chart: long enough to be a move, short enough to still be the context
  // this candle is reacting to.
  const trendLookback = Math.min(6, bars.length - 1);
  const trendFrom = bars[bars.length - 1 - trendLookback];
  const priorTrend = trendFrom && Number.isFinite(trendFrom.close) && Number.isFinite(prev.close)
    ? (prev.close > trendFrom.close ? "UP" : prev.close < trendFrom.close ? "DOWN" : "FLAT")
    : "UNKNOWN";

  const detected = [];

  // ==========================================
  // 1. THREE-CANDLE PATTERNS (Highest Weight)
  // ==========================================

  // Morning Star: Prev2 tall red -> Prev small star -> Curr strong green closing > 50% into Prev2
  if (!prev2.isBullish && prev2.bodyToRange > 0.55 &&
      prev.bodyToRange < 0.35 && prev.bodyBottom < prev2.bodyBottom &&
      curr.isBullish && curr.close > (prev2.open + prev2.close) / 2) {
    detected.push({
      name: "MORNING_STAR",
      bias: "BULLISH",
      reliability: 0.88,
      description: "Institutional 3-bar bullish reversal with strong demand rejection."
    });
  }

  // Evening Star: Prev2 tall green -> Prev small star -> Curr strong red closing < 50% into Prev2
  if (prev2.isBullish && prev2.bodyToRange > 0.55 &&
      prev.bodyToRange < 0.35 && prev.bodyTop > prev2.bodyTop &&
      !curr.isBullish && curr.close < (prev2.open + prev2.close) / 2) {
    detected.push({
      name: "EVENING_STAR",
      bias: "BEARISH",
      reliability: 0.88,
      description: "Institutional 3-bar bearish exhaustion top with heavy distribution."
    });
  }

  // Three White Soldiers: 3 consecutive green candles, each higher
  if (prev2.isBullish && prev.isBullish && curr.isBullish &&
      curr.close > prev.close && prev.close > prev2.close &&
      curr.open > prev.open && prev.open > prev2.open &&
      curr.bodyToRange > 0.60 && prev.bodyToRange > 0.60) {
    detected.push({
      name: "THREE_WHITE_SOLDIERS",
      bias: "BULLISH",
      reliability: 0.85,
      description: "Sustained institutional buying pressure across 3 consecutive sessions."
    });
  }

  // Three Black Crows: 3 consecutive red candles, each lower
  if (!prev2.isBullish && !prev.isBullish && !curr.isBullish &&
      curr.close < prev.close && prev.close < prev2.close &&
      curr.open < prev.open && prev.open < prev2.open &&
      curr.bodyToRange > 0.60 && prev.bodyToRange > 0.60) {
    detected.push({
      name: "THREE_BLACK_CROWS",
      bias: "BEARISH",
      reliability: 0.85,
      description: "Sustained institutional liquidations across 3 consecutive sessions."
    });
  }

  // ==========================================
  // 2. TWO-CANDLE PATTERNS
  // ==========================================

  // Bullish Engulfing: Prior red, current green body completely engulfs prior body
  if (!prev.isBullish && curr.isBullish &&
      curr.open <= prev.close * 1.002 && curr.close >= prev.open * 0.998 &&
      curr.body > prev.body * 1.1) {
    detected.push({
      name: "BULLISH_ENGULFING",
      bias: "BULLISH",
      reliability: 0.82,
      description: "Bullish body fully engulfs previous session distribution."
    });
  }

  // Bearish Engulfing: Prior green, current red body completely engulfs prior body
  if (prev.isBullish && !curr.isBullish &&
      curr.open >= prev.close * 0.998 && curr.close <= prev.open * 1.002 &&
      curr.body > prev.body * 1.1) {
    detected.push({
      name: "BEARISH_ENGULFING",
      bias: "BEARISH",
      reliability: 0.82,
      description: "Bearish body fully engulfs previous session accumulation."
    });
  }

  // Piercing Line (Bullish reversal): Prior red, curr opens below prev low and closes > 50% midpoint
  if (!prev.isBullish && curr.isBullish &&
      curr.open < prev.low && curr.close > (prev.open + prev.close) / 2 && curr.close < prev.open) {
    detected.push({
      name: "PIERCING_LINE",
      bias: "BULLISH",
      reliability: 0.78,
      description: "Bullish piercing thrust closing above prior session midpoint."
    });
  }

  // Dark Cloud Cover (Bearish reversal): Prior green, curr opens above prev high and closes < 50% midpoint
  if (prev.isBullish && !curr.isBullish &&
      curr.open > prev.high && curr.close < (prev.open + prev.close) / 2 && curr.close > prev.open) {
    detected.push({
      name: "DARK_CLOUD_COVER",
      bias: "BEARISH",
      reliability: 0.78,
      description: "Bearish rejection thrust piercing below prior session midpoint."
    });
  }

  // Inside Bar / Harami: Current bar completely contained within prior bar range
  if (curr.high <= prev.high && curr.low >= prev.low) {
    detected.push({
      name: "INSIDE_BAR",
      bias: curr.isBullish ? "BULLISH_SQUEEZE" : "BEARISH_SQUEEZE",
      reliability: 0.72,
      description: "Volatility contraction inside prior session extremes."
    });
  }

  // ==========================================
  // 3. SINGLE-CANDLE PATTERNS
  // ==========================================

  // Long lower shadow. HAMMER after a decline, HANGING MAN after a rally.
  if (curr.lowerToBody >= 2.0 && curr.upperShadow <= Math.max(curr.body * 0.8, curr.range * 0.15)) {
    const isHammer = priorTrend === "DOWN";
    detected.push({
      name: isHammer ? "HAMMER" : priorTrend === "UP" ? "HANGING_MAN" : "LOWER_SHADOW_REJECTION",
      bias: isHammer ? "BULLISH" : priorTrend === "UP" ? "BEARISH" : "NEUTRAL",
      // A pattern read without its context is worth less than one read with it.
      reliability: priorTrend === "UNKNOWN" || priorTrend === "FLAT" ? 0.50 : 0.75,
      priorTrend,
      description: isHammer
        ? "Hammer: buyers reject lower prices after a decline."
        : priorTrend === "UP"
          ? "Hanging Man: the same shape after a rally, which warns rather than invites."
          : "Lower rejection with no clear prior trend, so no reversal claim is made."
    });
  }

  // Long upper shadow. SHOOTING STAR after a rally, INVERTED HAMMER after a decline.
  if (curr.upperToBody >= 2.0 && curr.lowerShadow <= Math.max(curr.body * 0.8, curr.range * 0.15)) {
    const isShootingStar = priorTrend === "UP";
    detected.push({
      name: isShootingStar ? "SHOOTING_STAR" : priorTrend === "DOWN" ? "INVERTED_HAMMER" : "UPPER_SHADOW_REJECTION",
      bias: isShootingStar ? "BEARISH" : priorTrend === "DOWN" ? "BULLISH" : "NEUTRAL",
      reliability: priorTrend === "UNKNOWN" || priorTrend === "FLAT" ? 0.50 : 0.75,
      priorTrend,
      description: isShootingStar
        ? "Shooting Star: sellers reject higher prices after a rally."
        : priorTrend === "DOWN"
          ? "Inverted Hammer: the same shape after a decline, classically bullish."
          : "Upper rejection with no clear prior trend, so no reversal claim is made."
    });
  }

  // Marubozu Bullish: Full green body with negligible wicks
  if (curr.isBullish && curr.bodyToRange >= 0.85) {
    detected.push({
      name: "BULLISH_MARUBOZU",
      bias: "BULLISH",
      reliability: 0.80,
      description: "Total buyer dominance from open to close."
    });
  }

  // Marubozu Bearish: Full red body with negligible wicks
  if (!curr.isBullish && curr.bodyToRange >= 0.85) {
    detected.push({
      name: "BEARISH_MARUBOZU",
      bias: "BEARISH",
      reliability: 0.80,
      description: "Total seller dominance from open to close."
    });
  }

  // Doji: Tiny body (<= 8% of range)
  if (curr.bodyToRange <= 0.08) {
    if (curr.lowerShadow >= curr.range * 0.65) {
      detected.push({ name: "DRAGONFLY_DOJI", bias: "BULLISH", reliability: 0.74, description: "Dragonfly Doji: Long lower shadow rejection." });
    } else if (curr.upperShadow >= curr.range * 0.65) {
      detected.push({ name: "GRAVESTONE_DOJI", bias: "BEARISH", reliability: 0.74, description: "Gravestone Doji: Long upper shadow rejection." });
    } else {
      detected.push({ name: "DOJI", bias: "NEUTRAL", reliability: 0.60, description: "Indecision equilibrium bar." });
    }
  }

  // Rank by reliability
  detected.sort((a, b) => b.reliability - a.reliability);
  const primary = detected[0] || null;

  let score = 0.50;
  let overallBias = "NEUTRAL";
  if (primary) {
    overallBias = primary.bias.includes("BULLISH") ? "BULLISH" : primary.bias.includes("BEARISH") ? "BEARISH" : "NEUTRAL";
    score = primary.bias.includes("BULLISH") ? 0.50 + (primary.reliability * 0.45) :
            primary.bias.includes("BEARISH") ? 0.50 - (primary.reliability * 0.45) : 0.50;
  }

  return {
    patterns: detected,
    primaryPattern: primary ? primary.name : null,
    bias: overallBias,
    score: round(score, 3),
    candlestickSummary: primary ? primary.description : "No decisive single/multi-bar pattern formed."
  };
}

module.exports = {
  parseBar,
  identifyCandlestickPatterns
};
