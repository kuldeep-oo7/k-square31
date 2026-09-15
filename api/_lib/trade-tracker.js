"use strict";

const crypto = require("node:crypto");

function round(value, digits = 2) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function millis(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function barTimestamp(bar) {
  return millis(bar?.timestamp ?? bar?.time ?? bar?.date ?? bar?.session);
}

function sessionOf(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function createSignalRecord(rec, features = {}, entryOverride = null) {
  if (!rec || !rec.symbol) return null;
  const side = rec.side === "short" ? "short" : "long";
  const entry = entryOverride || (rec.entries && rec.entries[0]) || {};
  const intent = entry.orderIntent || {};
  const entryPrice = Number(entry.entry ?? intent.entryPrice) || Number(rec.anchor) || 0;
  if (!(entryPrice > 0)) return null;

  const targetPrice = Number(entry.target ?? intent.targetPrice) || round(entryPrice * (1 + (side === "short" ? -1 : 1) * 0.02));
  const stopLossPrice = Number(entry.stopLoss ?? intent.stopLossPrice) || round(entryPrice * (1 - (side === "short" ? -1 : 1) * 0.01));
  const decisionAt = millis(intent.decisionAt || rec.decisionAt || rec.generatedAt) || Date.now();
  const validFrom = millis(intent.validFrom || rec.validFrom) || decisionAt;
  const suppliedFeatureAsOf = millis(features?.featureAsOf);
  const featureAsOf = suppliedFeatureAsOf && suppliedFeatureAsOf <= decisionAt ? suppliedFeatureAsOf : decisionAt;
  const level = Number(entry.level ?? intent.level) || 1;
  const identity = intent.clientOrderId || [rec.symbol, rec.weekKey || sessionOf(decisionAt), side, `L${level}`, intent.contractSymbol || "NO_CONTRACT"].join(":");
  const signalId = `sig_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;

  return {
    id: signalId,
    signalId,
    clientOrderId: intent.clientOrderId || null,
    strategyVersion: intent.strategyVersion || rec.strategyVersion || "UNKNOWN",
    symbol: String(rec.symbol).toUpperCase(),
    side,
    level,
    action: rec.action || "research-signal",
    weekKey: rec.weekKey || sessionOf(decisionAt),
    decisionAt,
    validFrom,
    orderSubmittedAt: millis(intent.orderSubmittedAt),
    filledAt: null,
    fillOrderId: null,
    fillSession: null,
    contractSymbol: intent.contractSymbol || null,
    instrumentId: intent.instrumentId || null,
    expiry: intent.expiry || null,
    entryPrice: round(entryPrice),
    targetPrice: round(targetPrice),
    stopLossPrice: round(stopLossPrice),
    riskReward: round(Number(entry.riskReward ?? intent.riskReward) || 2, 1),
    convictionPct: Number(rec.convictionPct) || 0,
    expectedWeeklyPct: Number(rec.expectedWeeklyPct) || 0,
    sizeMultiplier: Number(rec.sizeMultiplier) || 0,
    reasons: Array.isArray(rec.reasons) ? rec.reasons : [],
    features: { ...features },
    featureAsOf,
    status: "PENDING",
    outcome: null,
    exitPrice: null,
    pnlPct: null,
    grossPnlPct: null,
    mfePct: null,
    maePct: null,
    maxHighSinceFill: null,
    minLowSinceFill: null,
    holdingSessions: 0,
    lastEvaluatedTimestamp: null,
    lastEvaluatedSession: null,
    resolvedAt: null,
    temporalIntegrity: "AWAITING_CONFIRMED_FILL"
  };
}

function createSignalRecords(rec, features = {}) {
  const entries = Array.isArray(rec?.entries) ? rec.entries : [];
  return entries.map((entry) => createSignalRecord(rec, features, entry)).filter(Boolean);
}

function recordConfirmedFill(signal, fill) {
  if (!signal || fill?.status !== "FILLED") return { updated: false, reason: "CONFIRMED_FILL_REQUIRED", signal };
  if (!String(fill.orderId || "").trim()) return { updated: false, reason: "FILL_ORDER_ID_REQUIRED", signal };
  if (!(Number(fill.fillPrice) > 0)) return { updated: false, reason: "VALID_FILL_PRICE_REQUIRED", signal };
  if (signal.clientOrderId && fill.clientOrderId !== signal.clientOrderId) return { updated: false, reason: "CLIENT_ORDER_ID_MISMATCH", signal };
  if (signal.contractSymbol && fill.contractSymbol !== signal.contractSymbol) return { updated: false, reason: "CONTRACT_MISMATCH", signal };
  if (signal.fillOrderId === fill.orderId) return { updated: false, reason: "ALREADY_RECORDED", idempotent: true, signal };
  if (signal.fillOrderId) return { updated: false, reason: "DIFFERENT_FILL_ALREADY_RECORDED", signal };
  const filledAt = millis(fill.timestamp);
  if (!filledAt) return { updated: false, reason: "FILL_TIMESTAMP_REQUIRED", signal };
  const earliestFill = Math.max(Number(signal.validFrom || 0), Number(signal.decisionAt || 0), Number(signal.orderSubmittedAt || 0));
  if (filledAt < earliestFill) return { updated: false, reason: "FILL_PRECEDES_VALID_FROM", signal };
  const updated = {
    ...signal,
    status: "ACTIVE",
    filledAt,
    fillSession: sessionOf(filledAt),
    fillOrderId: fill.orderId,
    entryPrice: round(Number(fill.fillPrice)),
    temporalIntegrity: "CONFIRMED_FILL"
  };
  return { updated: true, signal: updated };
}

function evaluateOutcome(signal, bars = []) {
  if (!signal || !(Number(signal.entryPrice) > 0)) return signal;
  if (signal.outcome === "WIN" || signal.outcome === "LOSS") return signal;
  if (!signal.filledAt || !signal.fillOrderId || signal.status === "PENDING") {
    // Plans are not trades. Without a broker/shadow fill there is no outcome to
    // learn from and therefore no candle is consumed.
    return { ...signal, temporalIntegrity: "AWAITING_CONFIRMED_FILL" };
  }

  const lowerBound = Math.max(Number(signal.validFrom || 0), Number(signal.filledAt || 0), Number(signal.lastEvaluatedTimestamp || 0));
  const fillSession = signal.fillSession || sessionOf(Number(signal.filledAt));
  const usable = (Array.isArray(bars) ? bars : [])
    .map((bar) => ({ ...bar, _timestamp: barTimestamp(bar) }))
    .filter((bar) => Number.isFinite(bar._timestamp) && bar._timestamp > lowerBound)
    .filter((bar) => sessionOf(bar._timestamp) !== fillSession)
    .filter((bar) => [bar.open ?? bar.close, bar.high, bar.low, bar.close].every((value) => Number.isFinite(Number(value))))
    .sort((left, right) => left._timestamp - right._timestamp);
  if (!usable.length) return signal;

  const side = signal.side === "short" ? "short" : "long";
  const entry = Number(signal.entryPrice);
  const target = Number(signal.targetPrice);
  const stop = Number(signal.stopLossPrice);
  let maxHigh = Number(signal.maxHighSinceFill) || entry;
  let minLow = Number(signal.minLowSinceFill) || entry;
  let exitPrice = null;
  let outcome = null;
  let status = "ACTIVE";
  let reason = null;
  let sessions = Number(signal.holdingSessions || 0);
  let resolvedTimestamp = null;

  for (const bar of usable) {
    const open = Number(bar.open ?? bar.close);
    const high = Number(bar.high);
    const low = Number(bar.low);
    sessions += 1;
    maxHigh = Math.max(maxHigh, high);
    minLow = Math.min(minLow, low);

    if (side === "long") {
      if (open <= stop) { outcome = "LOSS"; status = "STOPPED_OUT"; exitPrice = open; reason = "STOP_GAP"; }
      else if (open >= target) { outcome = "WIN"; status = "TARGET_HIT"; exitPrice = open; reason = "TARGET_GAP"; }
      else if (low <= stop) { outcome = "LOSS"; status = "STOPPED_OUT"; exitPrice = stop; reason = high >= target ? "STOP_FIRST_DAILY_AMBIGUITY" : "STOP_LOSS"; }
      else if (high >= target) { outcome = "WIN"; status = "TARGET_HIT"; exitPrice = target; reason = "TARGET_HIT"; }
    } else {
      if (open >= stop) { outcome = "LOSS"; status = "STOPPED_OUT"; exitPrice = open; reason = "STOP_GAP"; }
      else if (open <= target) { outcome = "WIN"; status = "TARGET_HIT"; exitPrice = open; reason = "TARGET_GAP"; }
      else if (high >= stop) { outcome = "LOSS"; status = "STOPPED_OUT"; exitPrice = stop; reason = low <= target ? "STOP_FIRST_DAILY_AMBIGUITY" : "STOP_LOSS"; }
      else if (low <= target) { outcome = "WIN"; status = "TARGET_HIT"; exitPrice = target; reason = "TARGET_HIT"; }
    }
    if (outcome) { resolvedTimestamp = bar._timestamp; break; }
  }

  const lastConsumed = outcome ? resolvedTimestamp : usable.at(-1)._timestamp;
  const currentMark = exitPrice || Number(usable.at(-1).close);
  const frictionPct = outcome ? Number(signal.frictionPct || signal.roundTripCostPct || 0.08) : 0;
  const grossPnlPct = side === "short" ? (entry - currentMark) / entry * 100 : (currentMark - entry) / entry * 100;
  const mfePct = side === "short" ? (entry - minLow) / entry * 100 : (maxHigh - entry) / entry * 100;
  const maePct = side === "short" ? (maxHigh - entry) / entry * 100 : (entry - minLow) / entry * 100;

  return {
    ...signal,
    status,
    outcome,
    exitPrice: round(exitPrice),
    exitReason: reason,
    pnlPct: round(grossPnlPct - frictionPct),
    grossPnlPct: round(grossPnlPct),
    mfePct: round(Math.max(0, mfePct)),
    maePct: round(Math.max(0, maePct)),
    maxHighSinceFill: round(maxHigh, 4),
    minLowSinceFill: round(minLow, 4),
    holdingSessions: sessions,
    lastEvaluatedTimestamp: lastConsumed,
    lastEvaluatedSession: sessionOf(lastConsumed),
    resolvedAt: outcome ? resolvedTimestamp : null,
    temporalIntegrity: "POST_FILL_EVENTS_ONLY"
  };
}

function summarizePerformance(signals = []) {
  const items = Array.isArray(signals) ? signals.filter(Boolean) : [];
  const resolved = items.filter((signal) => signal.outcome === "WIN" || signal.outcome === "LOSS");
  const wins = resolved.filter((signal) => signal.outcome === "WIN");
  const losses = resolved.filter((signal) => signal.outcome === "LOSS");
  const totalWinPnl = wins.reduce((sum, signal) => sum + Math.max(0, Number(signal.pnlPct) || 0), 0);
  const totalLossPnl = losses.reduce((sum, signal) => sum + Math.abs(Math.min(0, Number(signal.pnlPct) || 0)), 0);
  const winRate = resolved.length ? wins.length / resolved.length : 0;
  const averageWin = wins.length ? totalWinPnl / wins.length : 0;
  const averageLoss = losses.length ? totalLossPnl / losses.length : 0;

  return {
    totalSignals: items.length,
    activeSignals: items.filter((signal) => signal.status === "ACTIVE").length,
    pendingSignals: items.filter((signal) => signal.status === "PENDING").length,
    resolvedSignals: resolved.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct: round(winRate * 100, 1),
    profitFactor: round(totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 99 : 1, 2),
    averageWinPct: round(averageWin, 2),
    averageLossPct: round(averageLoss, 2),
    expectancyPct: round(winRate * averageWin - (1 - winRate) * averageLoss, 2),
    totalSimulatedPnlPct: round(totalWinPnl - totalLossPnl, 2),
    unconfirmedSignalsExcluded: items.filter((signal) => !signal.fillOrderId).length
  };
}

module.exports = {
  createSignalRecord,
  createSignalRecords,
  evaluateOutcome,
  recordConfirmedFill,
  round,
  summarizePerformance
};
