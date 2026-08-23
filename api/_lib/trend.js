// Time-series momentum: the direction filter with the widest evidence base of
// anything in this repository.
//
// Hurst, Ooi and Pedersen ("A Century of Evidence on Trend-Following Investing",
// JPM 2017) find positive average returns from 12-month time-series momentum in
// every decade since 1880, across equity indices, bonds, currencies and
// commodities, in war and peace and across inflation regimes. Moskowitz, Ooi and
// Pedersen (JFE 2012) find 12-month time-series momentum positive for every one
// of 58 liquid futures contracts. Liu and Tsyvinski (RFS 2021) find the same
// effect in cryptocurrency. It is not an equity effect or an India effect.
//
// It is used here as a direction gate rather than a standalone strategy: this
// desk's ladder is a short-term reversal trade, and reversal against a 12-month
// downtrend is where its losses concentrate. The signal is volatility-scaled so
// the same thresholds apply to a 12% annualised name and a 60% one, which is
// what makes the module reusable across futures, crypto, commodities and FX.

const SESSIONS_PER_YEAR = 252;

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function closesOf(bars) {
  return (Array.isArray(bars) ? bars : []).map((bar) => Number(bar.close)).filter(Number.isFinite);
}

// Annualised volatility from daily log-ish returns, used to put every instrument
// on one scale before the trend is judged.
function annualisedVolatilityPct(closes, lookback = 63) {
  const window = closes.slice(-Math.min(lookback + 1, closes.length));
  const returns = [];
  for (let index = 1; index < window.length; index += 1) {
    if (window[index - 1] > 0) returns.push(window[index] / window[index - 1] - 1);
  }
  return returns.length < 5 ? null : deviation(returns) * Math.sqrt(SESSIONS_PER_YEAR) * 100;
}

// `sessions` defaults to a 12-month lookback, the horizon that carries the
// evidence. Shorter horizons are supported so the same function can serve a
// crypto book trading on a faster clock.
function timeSeriesMomentum(bars, options = {}) {
  const closes = closesOf(bars);
  const sessions = Number(options.sessions) || SESSIONS_PER_YEAR;
  if (closes.length < Math.floor(sessions * 0.6) + 2) {
    return { ready: false, reason: `Need about ${sessions} sessions of history to measure the trend` };
  }
  const lookback = Math.min(sessions, closes.length - 1);
  const start = closes[closes.length - 1 - lookback];
  const last = closes.at(-1);
  if (!(start > 0) || !(last > 0)) return { ready: false, reason: "Unusable closes for the trend lookback" };

  const returnPct = (last / start - 1) * 100;
  const volatilityPct = annualisedVolatilityPct(closes);
  // Guard the divisor, not its rounded display value. A series with no real
  // dispersion carries a floating-point sigma near 1e-16, which would divide a
  // 26% move into a trend score of 1e14 and veto trades on arithmetic noise.
  // Real instruments run from single-digit to triple-digit annualised
  // volatility, so anything under a hundredth of a percent is not a measurement.
  const measurable = Number.isFinite(volatilityPct) && volatilityPct > 1e-2;
  // Return per unit of risk over the lookback. Scaling by the square root of the
  // horizon keeps the number comparable when `sessions` is changed.
  const scaled = measurable ? returnPct / (volatilityPct * Math.sqrt(lookback / SESSIONS_PER_YEAR)) : null;
  return {
    ready: true,
    sessions: lookback,
    returnPct: round(returnPct, 3),
    annualisedVolatilityPct: round(volatilityPct, 2),
    scaled: round(scaled, 4),
    direction: returnPct > 0 ? 1 : returnPct < 0 ? -1 : 0
  };
}

// A gate, not a score: a ladder that leans against a 12-month trend of this size
// is refused outright. The tolerance lets a flat market through — only a trend
// with real magnitude relative to its own volatility blocks a trade.
function trendGate(bars, side, options = {}) {
  const trend = timeSeriesMomentum(bars, options);
  const tolerance = Number.isFinite(Number(options.tolerance)) ? Number(options.tolerance) : 0.25;
  if (!trend.ready) return { ...trend, blocked: false, veto: null };
  const against = side === "short" ? Number(trend.scaled) : -Number(trend.scaled);
  const blocked = Number.isFinite(against) && against > tolerance;
  return {
    ...trend,
    tolerance,
    blocked,
    veto: blocked
      ? `The 12-month trend runs against this ladder (${trend.returnPct}% over ${trend.sessions} sessions, ${round(trend.scaled, 2)} per unit of risk)`
      : null
  };
}

// Alignment in [0, 1] for the conviction blend: a ladder trading with the trend
// scores high, one in a flat market scores middling.
function trendAlignment(trend, side) {
  // `Number(null)` is 0 and passes a plain isFinite check, so an unmeasurable
  // trend has to be rejected explicitly or it scores as neutral instead of absent.
  if (!trend?.ready || trend.scaled === null || trend.scaled === undefined) return 0;
  if (!Number.isFinite(Number(trend.scaled))) return 0;
  const withTrend = side === "short" ? -Number(trend.scaled) : Number(trend.scaled);
  return Math.max(0, Math.min(1, (withTrend + 0.5) / 1.5));
}

function calcEma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    ema = values[index] * k + ema * (1 - k);
  }
  return ema;
}

function calcSma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return mean(values.slice(-period));
}

function calcAtr(bars, period = 14) {
  const usable = Array.isArray(bars) ? bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close)) : [];
  if (usable.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < usable.length; i += 1) {
    const high = Number(usable[i].high);
    const low = Number(usable[i].low);
    const prevClose = Number(usable[i - 1].close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return mean(trs.slice(-period));
}

function trendMetrics(bars) {
  const closes = closesOf(bars);
  if (closes.length < 20) return { ready: false, reason: "Need at least 20 bars for trend metrics" };
  const lastClose = closes.at(-1);
  const ema20 = calcEma(closes, 20);
  const sma50 = closes.length >= 50 ? calcSma(closes, 50) : null;
  const sma200 = closes.length >= 200 ? calcSma(closes, 200) : null;
  const atr14 = calcAtr(bars, 14) || (lastClose * 0.02);
  
  const highWindow = (Array.isArray(bars) ? bars : []).slice(-Math.min(252, bars.length));
  const high52Week = Math.max(...highWindow.map((b) => Number(b.high || b.close)).filter(Number.isFinite));
  const low52Week = Math.min(...highWindow.map((b) => Number(b.low || b.close)).filter(Number.isFinite));
  const highProximityPct = high52Week > 0 ? ((lastClose / high52Week) - 1) * 100 : 0;

  const isUptrendStructure = Boolean(ema20 && lastClose >= ema20 && (!sma50 || ema20 >= sma50 * 0.99));
  const isDowntrendStructure = Boolean(ema20 && lastClose <= ema20 && (!sma50 || ema20 <= sma50 * 1.01));

  return {
    ready: true,
    lastClose: round(lastClose, 2),
    ema20: round(ema20, 2),
    sma50: round(sma50, 2),
    sma200: round(sma200, 2),
    atr14: round(atr14, 2),
    atrPct: round((atr14 / lastClose) * 100, 2),
    high52Week: round(high52Week, 2),
    low52Week: round(low52Week, 2),
    isUptrendStructure,
    isDowntrendStructure
  };
}

function relativeStrengthScore(stockBars, indexBars, period = 63) {
  const stockCloses = closesOf(stockBars);
  const indexCloses = closesOf(indexBars);
  if (stockCloses.length < period || indexCloses.length < period) return { rsScore: 1.0, outperforming: true };
  const stockReturn = (stockCloses.at(-1) / stockCloses.at(-period)) - 1;
  const indexReturn = (indexCloses.at(-1) / indexCloses.at(-period)) - 1;
  const rsRatio = (1 + stockReturn) / Math.max(0.01, 1 + indexReturn);
  return {
    rsScore: round(rsRatio, 3),
    stockReturnPct: round(stockReturn * 100, 2),
    indexReturnPct: round(indexReturn * 100, 2),
    outperforming: rsRatio >= 1.0
  };
}

module.exports = { annualisedVolatilityPct, calcAtr, calcEma, calcSma, relativeStrengthScore, timeSeriesMomentum, trendAlignment, trendGate, trendMetrics };


