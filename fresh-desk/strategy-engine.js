"use strict";
const RULES = require("./rules.json");
const { finite, tickRound, describe } = require("./analysis");
const dayAt = (n) => new Date(n + 330 * 60000).toISOString().slice(0, 10);
const clock = (at) => typeof at === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? Date.parse(at) : NaN;
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && finite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s; }
const identity = (i) => i.instrumentId || [i.market || "NSE_FUTURES", i.symbol, i.expiry || "SPOT"].join("|");
function levels({ side, entry, stop, target: structuralTarget = null, tickSize, quantity = RULES.quantity }) {
  if (!["BUY", "SELL"].includes(side) || ![entry, stop, tickSize, quantity].every((v) => finite(v) && v > 0) || tickSize < 1e-8) throw Error("INVALID_PLAN_INPUT");
  const sign = side === "BUY" ? 1 : -1, risk = sign * (entry - stop), riskPct = risk / entry * 100;
  if (!(risk > 0 && riskPct <= RULES.maxRiskPct + 1e-9)) throw Error("STOP_OUTSIDE_RISK_LIMIT");
  const goalTarget = tickRound(entry * (1 + sign * RULES.targetPct / 100), tickSize, sign > 0);
  const target = structuralTarget === null ? goalTarget : tickRound(structuralTarget, tickSize, sign < 0);
  const rewardRisk = sign * (target - entry) / risk;
  if (!(target > 0 && rewardRisk >= RULES.minimumRewardRisk - 1e-9)) throw Error("INSUFFICIENT_ROOM_TO_TARGET");
  if (!finite(risk * quantity)) throw Error("POSITION_TOO_LARGE");
  return { side, entry, stop, target, goalTarget, tickSize, quantity, riskPct, rewardRisk, riskAmount: risk * quantity, costs: "UNKNOWN" };
}
function assessSetups(bars, x, tick) {
  const b = bars.at(-1), p = bars.at(-2), previous = bars.slice(-RULES.structureBars - 2, -2);
  const oldLow = Math.min(...previous.map((v) => v.low)), oldHigh = Math.max(...previous.map((v) => v.high));
  const assessments = [];
  for (const side of RULES.sides) {
    const s = side === "BUY" ? 1 : -1, directional = s * (b.close - b.open) > 0;
    const boundary = s > 0 ? x.resistance : x.support, opposite = s > 0 ? x.support : x.resistance;
    const add = (family, matched, stop, target, explanation) => assessments.push({ family, side, matched, stop, target, explanation });
    const crossed = s * (b.close - boundary) > 0 && s * (p.close - boundary) <= 0;
    const volume = ["EXCHANGE_VOLUME", "TICK_VOLUME"].includes(x.volumeKind) && x.volumeRatio !== null && x.volumeRatio >= RULES.volumeMultiple;
    add("STRUCTURE_BREAKOUT", directional && crossed && volume && (x.supportTouches >= 2 || x.resistanceTouches >= 2),
      s > 0 ? b.low - tick : b.high + tick, boundary + s * (x.resistance - x.support),
      "Completed candle crosses a prior boundary with increased activity; target projects the prior range, stop invalidates the breakout candle.");
    const trend = s > 0 ? x.regime === "UPTREND" : x.regime === "DOWNTREND";
    const retrace = bars.slice(-3, -1).some((v) => s > 0 ? v.low <= x.previousAverage + x.tolerance : v.high >= x.previousAverage - x.tolerance);
    const confirms = s * (b.close - (s > 0 ? p.high : p.low)) > 0 && s * (b.close - x.average) > 0;
    add("TREND_PULLBACK", trend && retrace && directional && confirms,
      s > 0 ? Math.min(...bars.slice(-3).map((v) => v.low)) - tick : Math.max(...bars.slice(-3).map((v) => v.high)) + tick,
      boundary - s * tick, "A pre-existing higher-timeframe trend pulls back toward its average, then confirms a resumption; the prior swing is the target.");
    const oldBoundary = s > 0 ? oldLow : oldHigh, farBoundary = s > 0 ? oldHigh : oldLow;
    const failed = s > 0 ? p.low < oldBoundary && p.close > oldBoundary : p.high > oldBoundary && p.close < oldBoundary;
    add("FAILED_BREAKOUT", failed && directional && s * (b.close - (s > 0 ? p.high : p.low)) > 0,
      s > 0 ? Math.min(p.low, b.low) - tick : Math.max(p.high, b.high) + tick,
      farBoundary - s * tick, "The prior candle breaks a range and returns inside; the next completed candle confirms failure. Stop sits beyond the failed excursion.");
    const rejection = s > 0 ? b.low <= opposite + x.tolerance && b.close > opposite && b.close > p.close : b.high >= opposite - x.tolerance && b.close < opposite && b.close < p.close;
    add("RANGE_BOUNCE", x.regime === "RANGE" && rejection && directional && (s > 0 ? b.close < (x.support + x.resistance) / 2 : b.close > (x.support + x.resistance) / 2),
      s > 0 ? Math.min(b.low, opposite) - tick : Math.max(b.high, opposite) + tick,
      boundary - s * tick, "Repeated range boundaries and low directional efficiency; enter a confirmed reaction near an edge and target the opposite boundary.");
  }
  return assessments;
}
function analyse(input, { now = Date.now(), tradingSession = null } = {}) {
  const out = { symbol: input?.symbol || "?", expiry: input?.expiry || null, instrumentId: input ? identity(input) : "?",
    market: input?.market || "NSE_FUTURES", currency: input?.currency || "INR", status: "WAIT", reason: null,
    evaluatedSides: ["BUY", "SELL"], evidence: null, plans: [], candles: [], assessments: [] };
  const wait = (reason) => ({ ...out, reason });
  if (!input || !/^[A-Z0-9&_.:/-]{1,40}$/.test(input.symbol || "") || typeof input.source !== "string" || !input.source
    || !["NSE_FUTURES", "CRYPTO_SPOT", "CRYPTO_PERP", "FOREX", "EQUITY", "COMMODITY_FUTURES"].includes(out.market)
    || typeof out.currency !== "string" || !/^[A-Z]{3,8}$/.test(out.currency)) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  const nse = out.market === "NSE_FUTURES", session = dayAt(now), step = (input.intervalMinutes ?? RULES.barMinutes) * 60000;
  const open = nse ? Date.parse(`${session}T09:15:00+05:30`) : clock(input.sessionStart), isOpen = nse ? tradingSession : input.isOpen;
  if (isOpen !== true) return wait(isOpen === false ? "MARKET_CLOSED" : "CALENDAR_UNVERIFIED");
  if (nse && (now < open || now >= Date.parse(`${session}T${RULES.lastEntryIst}:00+05:30`))) return wait("OUTSIDE_ENTRY_SESSION");
  if (!finite(open) || !finite(step) || step < 60000 || step > 864e5 || !Number.isInteger(step / 60000)) return wait("SESSION_OR_INTERVAL_UNVERIFIED");
  if (nse && (input.source !== "ANGELONE_NFO" || !validDate(input.expiry) || input.expiry < session)) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  if (out.market.endsWith("FUTURES") && (!validDate(input.expiry) || input.expiry < new Date(now).toISOString().slice(0, 10))) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  if (!(finite(input.tickSize) && input.tickSize >= 1e-8)) return wait("TICK_MISSING_OR_INVALID");
  if (!Array.isArray(input.bars)) return wait("CANDLES_UNAVAILABLE");
  const bars = [];
  for (const b of input.bars) {
    if (!b || typeof b !== "object") return wait("INVALID_CANDLE");
    const at = clock(b.at);
    if (!finite(at) || b.symbol !== input.symbol || (b.expiry || null) !== out.expiry || at < open || (at - open) % step !== 0
      || ![b.open, b.high, b.low, b.close].every((v) => finite(v) && v > 0) || (b.volume !== null && (!finite(b.volume) || b.volume < 0))
      || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) return wait("INVALID_CANDLE");
    if (at > now) return wait("FUTURE_CANDLE");
    if (at + step <= now) bars.push({ ...b, ms: at });
  }
  bars.sort((a, b) => a.ms - b.ms);
  if (bars.some((b, i) => b.ms !== open + i * step)) return wait("MISSING_OR_DUPLICATE_CANDLES");
  if (bars.length < RULES.minimumBars) return wait("WARMING_UP");
  const last = bars.at(-1), signalEnd = last.ms + step;
  if (now - signalEnd >= step) return wait("SIGNAL_STALE");
  const x = describe(bars, { ...RULES, barMinutes: step / 60000 });
  x.volumeKind = input.volumeKind || (nse ? "EXCHANGE_VOLUME" : "UNKNOWN");
  out.evidence = { ...x, context: undefined, signalAt: new Date(signalEnd).toISOString(), lastClose: last.close,
    orderFlow: "NOT_AVAILABLE", source: input.source, sourceUrl: input.sourceUrl || null };
  out.candles = bars.slice(-60).map(({ ms, ...b }) => b);
  out.assessments = assessSetups(bars, x, input.tickSize);
  if (nse && (input.eligibility?.session !== session || input.eligibility?.state !== "CLEAR" || !input.eligibility?.source)) return wait(input.eligibility?.session === session && input.eligibility?.state === "BANNED" ? "NSE_BAN_NEW_ENTRY" : "BAN_STATUS_UNVERIFIED");
  if (!nse && input.tradeable !== true) return wait("INSTRUMENT_ELIGIBILITY_UNVERIFIED");
  const q = input.quote, quoteAt = clock(q?.at);
  if (q?.symbol !== input.symbol || (q?.expiry || null) !== out.expiry || (q.instrumentId && q.instrumentId !== out.instrumentId)
    || !finite(quoteAt) || now - quoteAt > RULES.maxQuoteAgeMs || quoteAt > now + 30000 || quoteAt < signalEnd) return wait("FRESH_POST_SIGNAL_QUOTE_REQUIRED");
  if (![q.bid, q.ask].every((v) => finite(v) && v > 0 && Math.abs(v / input.tickSize - Math.round(v / input.tickSize)) < 1e-5) || q.ask < q.bid) return wait("VALID_BID_ASK_REQUIRED");
  if (100 * (q.ask - q.bid) / ((q.ask + q.bid) / 2) > RULES.maxSpreadPct) return wait("SPREAD_TOO_WIDE");
  for (const a of out.assessments) {
    if (!a.matched) { a.rejection = "TRIGGER_NOT_PRESENT"; continue; }
    if (a.side === "SELL" && !nse && input.canShort !== true) { a.rejection = "SHORT_NOT_SUPPORTED_OR_UNVERIFIED"; continue; }
    const entry = a.side === "BUY" ? q.ask : q.bid;
    if (Math.abs(entry - last.close) / last.close * 100 > RULES.maxEntryDriftPct) { a.rejection = "ENTRY_TOO_FAR_FROM_SIGNAL"; continue; }
    try {
      const stop = tickRound(a.stop, input.tickSize, a.side === "SELL"), plan = levels({ side: a.side, entry, stop, target: a.target, tickSize: input.tickSize, quantity: nse ? 20 : input.defaultQuantity || 1 });
      out.plans.push({ ...plan, id: [RULES.version, out.instrumentId, a.family, a.side, signalEnd].join("~"), setups: [a.family], family: a.family,
        symbol: input.symbol, expiry: out.expiry, instrumentId: out.instrumentId, market: out.market, currency: out.currency, canShort: nse || input.canShort === true,
        minQuantity: nse ? 20 : input.minQuantity || 0, quantityStep: nse ? 1 : input.quantityStep || null,
        explanation: a.explanation, targetBasis: "STRUCTURAL_TARGET", status: "UNVALIDATED_RESEARCH", quoteAt: q.at,
        signalAt: out.evidence.signalAt, validUntil: new Date(signalEnd + step).toISOString(), reviewAt: nse ? `${session}T15:25:00+05:30` : null,
        exitBy: nse ? `${out.expiry}T15:25:00+05:30` : input.expiryAt || null, intervalMinutes: step / 60000,
        entryBasis: a.side === "BUY" ? "OBSERVED_ASK_REFERENCE" : "OBSERVED_BID_REFERENCE" });
    } catch (e) { a.rejection = e.message; }
  }
  return { ...out, status: out.plans.length ? "RESEARCH_SETUP" : "WAIT", reason: out.plans.length ? null : "NO_SETUP_WITHIN_RISK" };
}
module.exports = { RULES, analyse, levels, assessSetups, identity, dayAt, clock };
