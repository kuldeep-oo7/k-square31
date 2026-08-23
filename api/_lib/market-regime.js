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
  enforceSectorDiversification,
  round
};
