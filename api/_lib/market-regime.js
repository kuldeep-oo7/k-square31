"use strict";

const { calcEma, calcSma, calcAtr } = require("./trend");

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

// Garman-Klass Range-Based Volatility Estimator (8x more efficient than close-to-close)
function calcGarmanKlassVol(bars, period = 20) {
  const usable = Array.isArray(bars) ? bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.open) && Number.isFinite(b.close)) : [];
  if (usable.length < period) return null;
  const window = usable.slice(-period);
  const terms = window.map((b) => {
    const high = Number(b.high);
    const low = Number(b.low);
    const open = Number(b.open);
    const close = Number(b.close);
    const logHL = Math.log(high / low);
    const logCO = Math.log(close / open);
    return 0.5 * (logHL ** 2) - (2 * Math.log(2) - 1) * (logCO ** 2);
  });
  const variance = mean(terms);
  return round(Math.sqrt(Math.max(0, variance * 252)) * 100, 2);
}

function classifyMarketRegime(indexBars = []) {
  const usable = Array.isArray(indexBars) ? indexBars.filter((b) => Number.isFinite(b.close)) : [];
  if (usable.length < 50) {
    return {
      regime: "NEUTRAL",
      riskMode: "STANDARD",
      sizeMultiplier: 1.0,
      longAllowance: true,
      shortAllowance: true,
      reason: "Insufficient index history for regime classification"
    };
  }

  const closes = usable.map((b) => Number(b.close));
  const lastClose = closes.at(-1);
  const ema20 = calcEma(closes, 20);
  const sma50 = calcSma(closes, 50);
  const sma200 = closes.length >= 200 ? calcSma(closes, 200) : null;
  const atr14 = calcAtr(usable, 14);
  const atrPct = (atr14 / lastClose) * 100;
  const gkVol = calcGarmanKlassVol(usable, 20) || 15;

  const aboveEma20 = lastClose >= ema20;
  const ema20AboveSma50 = ema20 >= sma50;
  const aboveSma200 = !sma200 || lastClose >= sma200;

  if (aboveEma20 && ema20AboveSma50 && aboveSma200) {
    return {
      regime: "BULL_TRENDING",
      riskMode: "AGGRESSIVE_LONG",
      sizeMultiplier: 1.0,
      longAllowance: true,
      shortAllowance: false,
      gkVol,
      atrPct: round(atrPct, 2),
      reason: "Index in primary uptrend (Price > EMA20 > SMA50 > SMA200)"
    };
  }

  if (!aboveEma20 && !ema20AboveSma50) {
    return {
      regime: "BEAR_HOSTILE",
      riskMode: "DEFENSIVE_SHORT_ONLY",
      sizeMultiplier: 0.5,
      longAllowance: false,
      shortAllowance: true,
      gkVol,
      atrPct: round(atrPct, 2),
      reason: "Index in established downtrend (Price < EMA20 < SMA50); long setups restricted"
    };
  }

  return {
    regime: "NEUTRAL_CHOPPY",
    riskMode: "SELECTIVE",
    sizeMultiplier: 0.75,
    longAllowance: true,
    shortAllowance: true,
    gkVol,
    atrPct: round(atrPct, 2),
    reason: "Index consolidating in range (Mixed Moving Averages)"
  };
}

/**
 * Pre-Market Global Macro Shock & Geopolitical Bloodbath Shield
 * Monitors GIFT NIFTY, VIX, Crude Oil spikes (War indicator), and US/Global futures.
 */
function evaluateGlobalMacroShock(input = {}) {
  const required = ["giftNiftyGapPct", "indiaVix", "indiaVixChangePct", "brentCrudeSpikePct", "sp500FuturesGapPct"];
  const missing = required.filter((name) => input[name] === null || input[name] === undefined || !Number.isFinite(Number(input[name])));
  if (missing.length) {
    return {
      severity: "DATA_UNAVAILABLE",
      shieldActive: true,
      dataComplete: false,
      missingFields: missing,
      allowedLongLevels: [],
      vetoedLongLevels: [1, 2, 3, 4, 5],
      shortMultiplier: 0,
      longMultiplier: 0,
      actionDirective: "NO_NEW_ORDERS_DATA_LOCKDOWN",
      reasons: [`Required macro inputs unavailable: ${missing.join(", ")}`],
      summary: "MACRO DATA LOCKDOWN: New orders blocked until required live inputs are restored."
    };
  }

  const gap = Number(input.giftNiftyGapPct);
  const vix = Number(input.indiaVix);
  const vixChange = Number(input.indiaVixChangePct);
  const crudeSpike = Number(input.brentCrudeSpikePct);
  const spGap = Number(input.sp500FuturesGapPct);

  let shockScore = 0;
  const shockFactors = [];

  // 1. Overnight Gap Risk (GIFT NIFTY)
  if (gap <= -1.8) {
    shockScore += 40;
    shockFactors.push(`Severe overnight gap-down (${gap}% on GIFT NIFTY)`);
  } else if (gap <= -1.0) {
    shockScore += 25;
    shockFactors.push(`Moderate overnight gap-down (${gap}% on GIFT NIFTY)`);
  }

  // 2. Volatility / Panic Spike (VIX)
  if (vix >= 22 || vixChange >= 15.0) {
    shockScore += 30;
    shockFactors.push(`High Volatility / Panic Spike (VIX: ${vix}, +${vixChange}%)`);
  } else if (vix >= 18 || vixChange >= 8.0) {
    shockScore += 15;
    shockFactors.push(`Elevated Volatility (VIX: ${vix})`);
  }

  // 3. Geopolitical / War Indicator (Brent Crude Oil Spike)
  if (crudeSpike >= 4.0) {
    shockScore += 25;
    shockFactors.push(`Geopolitical Crude Shock (+${crudeSpike}% overnight)`);
  } else if (crudeSpike >= 2.5) {
    shockScore += 10;
    shockFactors.push(`Crude Oil Spiking (+${crudeSpike}%)`);
  }

  // 4. US / Global Bloodbath Spillover
  if (spGap <= -2.0) {
    shockScore += 20;
    shockFactors.push(`US Markets Bloodbath (S&P Futures ${spGap}%)`);
  }

  // Categorize Shield Status
  if (shockScore >= 55) {
    return {
      severity: "CRITICAL_BLOODBATH",
      shieldActive: true,
      dataComplete: true,
      allowedLongLevels: [4, 5], // ONLY deep capitulation dips allowed (no shallow knife catching)
      vetoedLongLevels: [1, 2, 3],
      shortMultiplier: 1.35,     // Boost short setups to profit from the selloff
      longMultiplier: 0.50,      // Defend long exposure
      actionDirective: "FULL_DEFENSE",
      reasons: shockFactors,
      summary: "CRITICAL GLOBAL SHOCK: All shallow buys vetoed. Capitulation dips & Short setups active."
    };
  }

  if (shockScore >= 25) {
    return {
      severity: "ELEVATED_RISK",
      shieldActive: true,
      dataComplete: true,
      allowedLongLevels: [2, 3, 4, 5], // Veto Level 1 shallow entries
      vetoedLongLevels: [1],
      shortMultiplier: 1.15,
      longMultiplier: 0.75,
      actionDirective: "CAUTION_DEEP_DIPS_ONLY",
      reasons: shockFactors,
      summary: "ELEVATED GLOBAL RISK: Level 1 shallow entries blocked. Waiting for deep pullbacks."
    };
  }

  return {
    severity: "NORMAL",
    shieldActive: false,
    dataComplete: true,
    allowedLongLevels: [1, 2, 3, 4, 5],
    vetoedLongLevels: [],
    shortMultiplier: 1.0,
    longMultiplier: 1.0,
    actionDirective: "STANDARD_EXECUTION",
    reasons: ["Global macro and volatility conditions are within normal baseline thresholds."],
    summary: "NORMAL REGIME: Standard ladder entries active."
  };
}

function enforceSectorDiversification(recommendations = [], maxPerSector = 2) {
  const sectorCounts = new Map();
  const filtered = [];

  for (let i = 0; i < recommendations.length; i += 1) {
    const item = recommendations[i];
    const sector = String(item.sector || item.evidence?.fundamentals?.sector || "GENERAL").toUpperCase();
    const current = sectorCounts.get(sector) || 0;
    if (current < maxPerSector) {
      sectorCounts.set(sector, current + 1);
      filtered.push(item);
    }
  }
  return filtered;
}

module.exports = {
  classifyMarketRegime,
  calcGarmanKlassVol,
  evaluateGlobalMacroShock,
  enforceSectorDiversification,
  round
};
