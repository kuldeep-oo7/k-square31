"use strict";

const RULE = Object.freeze(require("../../config/gm-weekly-research.json"));
const { plan, result } = require("./gm-weekly-goal");
const { toTick } = require("./session-levels");
const { isNseHoliday } = require("./nse-holidays");

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function ema(values, n) {
  const out = Array(values.length).fill(null);
  if (values.length < n) return out;
  out[n - 1] = mean(values.slice(0, n));
  for (let i = n; i < values.length; i++) out[i] = values[i] * 2 / (n + 1) + out[i - 1] * (1 - 2 / (n + 1));
  return out;
}
function wilder(a, n) {
  let x = mean(a.slice(0, n));
  for (let i = n; i < a.length; i++) x = (x * (n - 1) + a[i]) / n;
  return x;
}
function indicators(bars) {
  const c = bars.map((b) => b.close), e20 = ema(c, 20), e50 = ema(c, 50), fast = ema(c, 12), slow = ema(c, 26);
  const macd = c.slice(25).map((_, i) => fast[i + 25] - slow[i + 25]), signal = ema(macd, 9);
  const delta = c.slice(1).map((x, i) => x - c[i]);
  const gain = wilder(delta.map((x) => Math.max(0, x)), 14), loss = wilder(delta.map((x) => Math.max(0, -x)), 14);
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  const prior = bars.slice(-21, -1);
  return { ema20: e20.at(-1), ema20Prior: e20.at(-6), ema50: e50.at(-1),
    rsi14: gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    atr14: wilder(tr, 14), macdHistogram: macd.at(-1) - signal.at(-1),
    volumeMultiple: bars.at(-1).volume / mean(prior.map((b) => b.volume)),
    resistance20: Math.max(...prior.map((b) => b.high)), support20: Math.min(...prior.map((b) => b.low)) };
}
function validDate(d) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
}
function validBar(b) {
  return b && validDate(b.date) && [b.open, b.high, b.low, b.close, b.volume].every(finite)
    && b.low > 0 && b.volume > 0 && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close);
}
function tradingDay(d) {
  const holiday = isNseHoliday(d), weekday = new Date(d).getUTCDay();
  return weekday === 0 || weekday === 6 ? false : holiday === null ? null : !holiday;
}
function nextDay(d) { return new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10); }
function nextSession(d) {
  for (let i = 0; i < 10; i++) { d = nextDay(d); const open = tradingDay(d); if (open === null) return null; if (open) return d; }
  return null;
}

function scan({ symbol, expiry, tickSize, bars, asOf, source } = {}) {
  const blocked = (reason) => ({ symbol, expiry, status: "BLOCKED", reason, candidates: [] });
  if (source !== "NSE_FUTURES") return blocked("ACTUAL_FUTURES_DATA_REQUIRED");
  if (!symbol || !validDate(asOf) || !validDate(expiry) || expiry <= asOf || !finite(tickSize) || tickSize < 0.01
    || Math.abs(tickSize * 100 - Math.round(tickSize * 100)) > 1e-8) return blocked("CONTRACT_METADATA_REQUIRED");
  if (!Array.isArray(bars) || bars.length < RULE.minHistory) return blocked("INSUFFICIENT_SAME_CONTRACT_HISTORY");
  if (bars.some((b, i) => !validBar(b) || b.date > asOf || b.date > expiry || (i && b.date <= bars[i - 1].date))) return blocked("INVALID_OR_UNSORTED_BARS");
  if (bars.at(-1).date !== asOf) return blocked("STALE_FUTURES_HISTORY");
  // Contract identity is mandatory on every bar; a cash chart or a stitched
  // rollover must not manufacture a breakout or a 3% move.
  if (bars.some((b) => b.symbol !== symbol || b.expiry !== expiry)) return blocked("CONTRACT_IDENTITY_MISMATCH");
  if (bars.some((b, i) => b.corporateAction === true || (i && Math.abs(b.open / bars[i - 1].close - 1) >= 0.18))) return blocked("EXTREME_GAP_OR_CORPORATE_ACTION_REQUIRES_REVIEW");
  const x = indicators(bars), b = bars.at(-1), p = bars.at(-2), p2 = bars.at(-3);
  if (!Object.values(x).every(finite)) return blocked("INDICATORS_UNAVAILABLE");
  const atrPct = x.atr14 / b.close * 100;
  if (atrPct < RULE.minAtrPct || atrPct > RULE.maxAtrPct) return blocked("VOLATILITY_OUTSIDE_RESEARCH_WINDOW");
  if (x.volumeMultiple < RULE.volumeMultiple) return blocked("VOLUME_NOT_CONFIRMED");
  const longTrend = b.close > x.ema20 && x.ema20 > x.ema50 && x.ema20 > x.ema20Prior;
  const shortTrend = b.close < x.ema20 && x.ema20 < x.ema50 && x.ema20 < x.ema20Prior;
  const candidates = [];
  const add = (setup, side, rawStop) => {
    const stopPrice = toTick(rawStop, tickSize, side === "BUY" ? "down" : "up");
    const riskPct = (side === "BUY" ? b.close - stopPrice : stopPrice - b.close) / b.close * 100;
    if (!(stopPrice > 0 && riskPct > 0 && riskPct <= RULE.maxStopPct && RULE.targetPct / riskPct >= RULE.minRewardRisk)) return;
    candidates.push({ symbol, expiry, tickSize, setup, side, signalDate: asOf, signalClose: b.close,
      stopPrice, atr14: x.atr14, riskPct, targetPct: RULE.targetPct,
      entryRule: "FIRST_OBSERVED_NEXT_SESSION_BID_ASK_WITH_RISK_RECHECK", status: "UNVALIDATED_PAPER_CANDIDATE",
      probability: null, source, indicators: x });
  };
  const bullish = longTrend && x.macdHistogram > 0 && x.rsi14 >= 45 && x.rsi14 <= 75;
  const bearish = shortTrend && x.macdHistogram < 0 && x.rsi14 >= 25 && x.rsi14 <= 55;
  // Donchian channel excludes today's candle. A close through the level,
  // directional real body, trend, momentum and volume all have to agree.
  if (bullish && b.close > x.resistance20 && b.close > b.open) add("CHANNEL_BREAKOUT", "BUY", Math.min(b.low, x.resistance20) - tickSize);
  if (bearish && b.close < x.support20 && b.close < b.open) add("CHANNEL_BREAKDOWN", "SELL", Math.max(b.high, x.support20) + tickSize);
  // Reversals need a preceding pullback within the longer trend and must occur
  // at EMA20 (within one ATR); an engulfing body alone is insufficient.
  const downPullback = p.close < bars.at(-5).close, upPullback = p.close > bars.at(-5).close;
  if (bullish && downPullback && Math.abs(Math.min(b.low, p.low) - x.ema20) <= x.atr14
    && p.close < p.open && b.close > b.open && b.open <= p.close && b.close >= p.open) add("ENGULFING_PULLBACK", "BUY", Math.min(b.low, p.low) - tickSize);
  if (bearish && upPullback && Math.abs(Math.max(b.high, p.high) - x.ema20) <= x.atr14
    && p.close > p.open && b.close < b.open && b.open >= p.close && b.close <= p.open) add("ENGULFING_PULLBACK", "SELL", Math.max(b.high, p.high) + tickSize);
  // A hammer / shooting star is the PREVIOUS candle. Today's close provides
  // confirmation. Dojis do not pass the body geometry.
  const body = Math.abs(p.close - p.open), upper = p.high - Math.max(p.close, p.open), lower = Math.min(p.close, p.open) - p.low;
  if (bullish && p2.close < bars.at(-6).close && body > 0 && lower >= 2 * body && upper <= body
    && Math.abs(p.low - x.ema20) <= x.atr14 && b.close > p.high && b.close > b.open) add("CONFIRMED_HAMMER", "BUY", p.low - tickSize);
  if (bearish && p2.close > bars.at(-6).close && body > 0 && upper >= 2 * body && lower <= body
    && Math.abs(p.high - x.ema20) <= x.atr14 && b.close < p.low && b.close < b.open) add("CONFIRMED_SHOOTING_STAR", "SELL", p.high + tickSize);
  return { symbol, expiry, status: candidates.length ? "RESEARCH_ONLY" : "NO_SETUP", candidates, indicators: x };
}

function bindEntry(candidate, { entryPrice, entryDate, quantity = RULE.quantity, roundTripCostsInr = null } = {}) {
  if (!candidate || candidate.status !== "UNVALIDATED_PAPER_CANDIDATE" || !finite(candidate.stopPrice)
    || !finite(candidate.atr14) || !(candidate.atr14 > 0) || !finite(candidate.signalClose)) throw new Error("A valid research candidate is required.");
  if (!validDate(entryDate) || entryDate !== nextSession(candidate.signalDate)) throw new Error("Entry must be the next verified NSE session after the completed signal.");
  if (!finite(entryPrice) || Math.abs(entryPrice - candidate.signalClose) > RULE.maxEntryGapAtr * candidate.atr14) throw new Error("Entry gap exceeds the research limit.");
  const goal = plan({ entryPrice, entryDate, quantity, roundTripCostsInr, side: candidate.side, expiry: candidate.expiry, tickSize: candidate.tickSize });
  const risk = (candidate.side === "BUY" ? entryPrice - candidate.stopPrice : candidate.stopPrice - entryPrice);
  const reward = Math.abs(goal.targetPrice - entryPrice);
  if (!(risk > 0 && risk / entryPrice * 100 <= RULE.maxStopPct && reward / risk >= RULE.minRewardRisk)) throw new Error("Actual fill fails the stop distance or reward/risk limit.");
  return { ...goal, stopPrice: candidate.stopPrice, setup: candidate.setup, symbol: candidate.symbol, status: "PAPER_ONLY" };
}

function replay(position, bars, { entryAtSessionOpen = false, roundTripCostsInr = null, completeThrough = null } = {}) {
  const goal = plan(position), sign = goal.side === "BUY" ? 1 : -1;
  if (!finite(position.stopPrice) || position.stopPrice <= 0 || sign * (goal.entryPrice - position.stopPrice) <= 0) throw new Error("Invalid protective stop.");
  if (!Array.isArray(bars) || bars.some((b, i) => !validBar(b) || b.symbol !== position.symbol || b.expiry !== position.expiry || (i && b.date <= bars[i - 1].date))) throw new Error("Replay needs ordered bars of the same futures contract.");
  const incomplete = (reason) => ({ status: "CENSORED", reason, grossGoalMet: null, netGoalMet: null });
  if (!entryAtSessionOpen) return incomplete("INTRADAY_ENTRY_ORDER_UNKNOWN");
  if (!bars.some((b) => b.date === goal.entryDate)) return incomplete("ENTRY_SESSION_MISSING");
  let last = null;
  for (const b of bars) {
    if (b.date < goal.entryDate || b.date > goal.deadline) continue;
    if (last && nextSession(last.date) !== b.date) return incomplete("MISSING_SESSION_OR_UNVERIFIED_CALENDAR");
    if (b.date === goal.entryDate && Math.abs(b.open - goal.entryPrice) > 1e-8) throw new Error("Session-open replay requires a fill at that session's open.");
    last = b;
    const stopped = sign > 0 ? b.low <= position.stopPrice : b.high >= position.stopPrice;
    const target = sign > 0 ? b.high >= goal.targetPrice : b.low <= goal.targetPrice;
    let exitPrice = null, reason = null;
    if (sign * (b.open - position.stopPrice) <= 0) { exitPrice = b.open; reason = "GAP_STOP"; }
    else if (sign * (b.open - goal.targetPrice) >= 0) { exitPrice = goal.targetPrice; reason = "TARGET"; }
    else if (stopped) { exitPrice = position.stopPrice; reason = target ? "STOP_FIRST_AMBIGUOUS_BAR" : "STOP"; }
    else if (target) { exitPrice = goal.targetPrice; reason = "TARGET"; }
    if (reason) return { status: "DONE", reason, exitDate: b.date, exitPrice,
      ...result(goal, { exitPrice, exitDate: b.date, roundTripCostsInr }) };
  }
  // An expiry or weekend can shorten the usable window. Close at the final
  // trading session only when later dates are verified non-trading days.
  let coveredEnd = !!last;
  for (let d = last ? nextDay(last.date) : goal.deadline; d <= goal.deadline; d = nextDay(d)) {
    if (tradingDay(d) !== false) { coveredEnd = false; break; }
  }
  if (last && coveredEnd && validDate(completeThrough) && completeThrough >= goal.deadline) return {
    status: "DONE", reason: "TIME_EXIT", exitDate: last.date, exitPrice: last.close,
    ...result(goal, { exitPrice: last.close, exitDate: last.date, roundTripCostsInr }) };
  return incomplete("INCOMPLETE_WEEK_OR_UNKNOWN_ENTRY_ORDER");
}
module.exports = { RULE, ema, indicators, scan, bindEntry, replay, validBar, nextSession };
