"use strict";
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const mean = (a) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b.length % 2 ? b[b.length >> 1] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2 : null; };
function ema(values, n) { const a = 2 / (n + 1); return values.reduce((out, v) => { out.push(out.length ? a * v + (1 - a) * out.at(-1) : v); return out; }, []); }
function tickRound(price, tick, up) {
  if (![price, tick].every((v) => finite(v) && v > 0) || price / tick > Number.MAX_SAFE_INTEGER / 2) throw Error("INVALID_TICK_OR_PRICE");
  return Number(((up ? Math.ceil(price / tick - 1e-7) : Math.floor(price / tick + 1e-7)) * tick).toFixed(8));
}
function aggregate(bars, count = 3) {
  const out = [];
  for (let i = 0; i + count <= bars.length; i += count) {
    const a = bars.slice(i, i + count);
    out.push({ at: a[0].at, open: a[0].open, high: Math.max(...a.map((b) => b.high)), low: Math.min(...a.map((b) => b.low)), close: a.at(-1).close, volume: a.reduce((s, b) => s + (b.volume || 0), 0) });
  }
  return out;
}
function candleFacts(b, p) {
  const body = Math.abs(b.close - b.open), range = b.high - b.low, lower = Math.min(b.open, b.close) - b.low, upper = b.high - Math.max(b.open, b.close);
  const names = [], side = b.close > b.open ? "BULLISH" : b.close < b.open ? "BEARISH" : "DOJI";
  if (range > 0 && body / range <= 0.1) names.push("DOJI");
  if (body > 0 && lower >= 2 * body && upper <= body) names.push("LOWER_WICK_REJECTION");
  if (body > 0 && upper >= 2 * body && lower <= body) names.push("UPPER_WICK_REJECTION");
  if (p && b.high <= p.high && b.low >= p.low) names.push("INSIDE_BAR");
  if (p && b.close > b.open && p.close < p.open && b.open <= p.close && b.close >= p.open) names.push("BULLISH_ENGULFING");
  if (p && b.close < b.open && p.close > p.open && b.open >= p.close && b.close <= p.open) names.push("BEARISH_ENGULFING");
  if (range > 0 && body / range >= 0.8) names.push(side + "_WIDE_BODY");
  return { side, names, body, range, lower, upper };
}
function describe(bars, config) {
  const last = bars.at(-1), prior = bars.slice(-config.structureBars - 1, -1), closes = bars.map((b) => b.close);
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  const atr = mean(tr.slice(-14)), averages = ema(closes, 10), support = Math.min(...prior.map((b) => b.low)), resistance = Math.max(...prior.map((b) => b.high));
  const previousCloses = prior.map((b) => b.close), travel = previousCloses.slice(1).reduce((s, c, i) => s + Math.abs(c - previousCloses[i]), 0);
  const efficiency = travel > 0 ? Math.abs(previousCloses.at(-1) - previousCloses[0]) / travel : 0;
  const context = aggregate(bars.slice(0, -3), 3), tail = context.slice(-3);
  const rising = tail.length === 3 && tail.slice(1).every((b, i) => b.high > tail[i].high && b.low > tail[i].low);
  const falling = tail.length === 3 && tail.slice(1).every((b, i) => b.high < tail[i].high && b.low < tail[i].low);
  const tolerance = atr * config.levelToleranceAtr;
  const supportTouches = prior.filter((b) => b.low <= support + tolerance).length, resistanceTouches = prior.filter((b) => b.high >= resistance - tolerance).length;
  const range = efficiency <= config.rangeEfficiencyMax && supportTouches >= 2 && resistanceTouches >= 2 && resistance - support >= 2 * atr;
  const regime = range ? "RANGE" : rising ? "UPTREND" : falling ? "DOWNTREND" : "TRANSITION";
  let pv = 0, volume = 0;
  for (const b of bars) if (finite(b.volume)) { pv += (b.high + b.low + b.close) / 3 * b.volume; volume += b.volume; }
  const volumeBaseline = median(bars.slice(-7, -1).map((b) => b.volume).filter(finite));
  const volumeRatio = volumeBaseline > 0 && finite(last.volume) ? last.volume / volumeBaseline : null;
  const firstWidth = Math.max(...prior.slice(0, 6).map((b) => b.high)) - Math.min(...prior.slice(0, 6).map((b) => b.low));
  const lastWidth = Math.max(...prior.slice(-6).map((b) => b.high)) - Math.min(...prior.slice(-6).map((b) => b.low));
  const pattern = firstWidth > 0 && lastWidth < firstWidth * 0.65 ? "CONTRACTING_RANGE" : supportTouches >= 2 && resistanceTouches >= 2 ? "HORIZONTAL_RANGE" : "SWING_STRUCTURE";
  return { regime, atr, average: averages.at(-1), previousAverage: averages.at(-2), support, resistance, supportTouches, resistanceTouches,
    efficiency, tolerance, volumeRatio, vwap: volume > 0 ? pv / volume : null, pattern, candle: candleFacts(last, bars.at(-2)), context, contextMinutes: config.barMinutes * 3 };
}
module.exports = { finite, mean, median, ema, tickRound, aggregate, candleFacts, describe };
