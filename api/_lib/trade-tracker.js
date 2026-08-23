"use strict";

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function createSignalRecord(rec, features = {}) {
  if (!rec || !rec.symbol) return null;
  const side = rec.side === "short" ? "short" : "long";
  const firstEntry = (rec.entries && rec.entries[0]) || {};
  const entryPrice = Number(firstEntry.entry) || Number(rec.anchor) || 0;
  if (!(entryPrice > 0)) return null;

  const targetPrice = Number(firstEntry.target) || round(entryPrice * (1 + (side === "short" ? -1 : 1) * 0.02));
  const stopLossPrice = Number(firstEntry.stopLoss) || round(entryPrice * (1 - (side === "short" ? -1 : 1) * 0.01));
  const riskReward = Number(firstEntry.riskReward) || 2.0;

  return {
    id: `sig_${rec.symbol}_${rec.weekKey || new Date().toISOString().slice(0, 10)}_${side}`,
    symbol: String(rec.symbol).toUpperCase(),
    side,
    action: rec.action || "buy-momentum",
    weekKey: rec.weekKey || new Date().toISOString().slice(0, 10),
    timestamp: Date.now(),
    entryPrice: round(entryPrice),
    targetPrice: round(targetPrice),
    stopLossPrice: round(stopLossPrice),
    riskReward: round(riskReward, 1),
    convictionPct: Number(rec.convictionPct) || 50,
    expectedWeeklyPct: Number(rec.expectedWeeklyPct) || 2.0,
    sizeMultiplier: Number(rec.sizeMultiplier) || 1.0,
    reasons: Array.isArray(rec.reasons) ? rec.reasons : [],
    features: {
      return5Pct: Number(features.return5Pct) || 0,
      return21Pct: Number(features.return21Pct) || 0,
      atr14Pct: Number(features.atr14Pct) || 0,
      realisedVol21Pct: Number(features.realisedVol21Pct) || 0,
      rsi14: Number(features.rsi14) || 50,
      zScore20: Number(features.zScore20) || 0,
      volumeRatio520: Number(features.volumeRatio520) || 1.0,
      highProximityPct: Number(features.highProximityPct) || 0
    },
    status: "PENDING",
    outcome: null,
    exitPrice: null,
    pnlPct: null,
    mfePct: null,
    maePct: null,
    holdingSessions: 0,
    resolvedAt: null
  };
}

function evaluateOutcome(signal, bars = []) {
  if (!signal || !signal.entryPrice) return signal;
  const usable = Array.isArray(bars) ? bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low)) : [];
  if (!usable.length) return signal;

  const side = signal.side === "short" ? "short" : "long";
  const entry = Number(signal.entryPrice);
  const target = Number(signal.targetPrice);
  const stop = Number(signal.stopLossPrice);

  let triggered = signal.status !== "PENDING";
  let maxHigh = entry;
  let minLow = entry;
  let exitPrice = null;
  let outcome = null;
  let status = signal.status;
  let sessions = signal.holdingSessions || 0;

  for (let i = 0; i < usable.length; i += 1) {
    const bar = usable[i];
    const high = Number(bar.high);
    const low = Number(bar.low);

    if (!triggered) {
      if (side === "long" && low <= entry * 1.005) {
        triggered = true;
        status = "ACTIVE";
      } else if (side === "short" && high >= entry * 0.995) {
        triggered = true;
        status = "ACTIVE";
      } else {
        continue;
      }
    }

    sessions += 1;
    maxHigh = Math.max(maxHigh, high);
    minLow = Math.min(minLow, low);

    if (side === "long") {
      if (high >= target) {
        outcome = "WIN";
        status = "TARGET_HIT";
        exitPrice = target;
        break;
      }
      if (low <= stop) {
        outcome = "LOSS";
        status = "STOPPED_OUT";
        exitPrice = stop;
        break;
      }
    } else {
      if (low <= target) {
        outcome = "WIN";
        status = "TARGET_HIT";
        exitPrice = target;
        break;
      }
      if (high >= stop) {
        outcome = "LOSS";
        status = "STOPPED_OUT";
        exitPrice = stop;
        break;
      }
    }
  }

  const latestClose = usable.at(-1)?.close || entry;
  const currentMark = exitPrice || latestClose;
  const pnlPct = side === "short"
    ? ((entry - currentMark) / entry) * 100
    : ((currentMark - entry) / entry) * 100;

  const mfePct = side === "short"
    ? ((entry - minLow) / entry) * 100
    : ((maxHigh - entry) / entry) * 100;

  const maePct = side === "short"
    ? ((maxHigh - entry) / entry) * 100
    : ((entry - minLow) / entry) * 100;

  return {
    ...signal,
    status: triggered ? (status || "ACTIVE") : "PENDING",
    outcome,
    exitPrice: round(exitPrice),
    pnlPct: round(pnlPct),
    mfePct: round(Math.max(0, mfePct)),
    maePct: round(Math.max(0, maePct)),
    holdingSessions: sessions,
    resolvedAt: outcome ? Date.now() : null
  };
}

function summarizePerformance(signals = []) {
  const items = Array.isArray(signals) ? signals.filter(Boolean) : [];
  const resolved = items.filter((s) => s.outcome === "WIN" || s.outcome === "LOSS");
  const wins = resolved.filter((s) => s.outcome === "WIN");
  const losses = resolved.filter((s) => s.outcome === "LOSS");

  const winCount = wins.length;
  const lossCount = losses.length;
  const totalResolved = resolved.length;
  const winRatePct = totalResolved ? (winCount / totalResolved) * 100 : 0;

  const totalWinPnl = wins.reduce((sum, s) => sum + Math.max(0, Number(s.pnlPct) || 0), 0);
  const totalLossPnl = losses.reduce((sum, s) => sum + Math.abs(Math.min(0, Number(s.pnlPct) || 0)), 0);

  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 99.0 : 1.0;
  const averageWinPct = winCount ? totalWinPnl / winCount : 0;
  const averageLossPct = lossCount ? totalLossPnl / lossCount : 0;
  const expectancyPct = totalResolved ? (winRatePct / 100 * averageWinPct) - ((100 - winRatePct) / 100 * averageLossPct) : 0;

  return {
    totalSignals: items.length,
    activeSignals: items.filter((s) => s.status === "ACTIVE").length,
    pendingSignals: items.filter((s) => s.status === "PENDING").length,
    resolvedSignals: totalResolved,
    winCount,
    lossCount,
    winRatePct: round(winRatePct, 1),
    profitFactor: round(profitFactor, 2),
    averageWinPct: round(averageWinPct, 2),
    averageLossPct: round(averageLossPct, 2),
    expectancyPct: round(expectancyPct, 2),
    totalSimulatedPnlPct: round(totalWinPnl - totalLossPnl, 2)
  };
}

module.exports = {
  createSignalRecord,
  evaluateOutcome,
  round,
  summarizePerformance
};
