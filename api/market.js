const DAY = 86_400;
const { readSession } = require("./_lib/security");
let benchmarkCache = { expires: 0, result: null };

function round(value) {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1000) return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

function indiaDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp * 1000));
}

function weekSnapshot(bars, livePrice) {
  const last = bars.at(-1);
  if (!last) return null;
  const latestDate = indiaDate(last.timestamp);
  const weekday = new Date(`${latestDate}T12:00:00Z`).getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  const weekStart = new Date(Date.parse(`${latestDate}T12:00:00Z`) - daysFromMonday * DAY * 1000).toISOString().slice(0, 10);
  const sessions = bars.filter((bar) => indiaDate(bar.timestamp) >= weekStart);
  const first = sessions[0] || last;
  const openingPrice = Number.isFinite(first.open) ? first.open : first.close;
  return {
    weekStart,
    firstSession: indiaDate(first.timestamp),
    sessions: sessions.length,
    openingPrice: round(openingPrice),
    high: round(Math.max(...sessions.map((bar) => bar.high))),
    low: round(Math.min(...sessions.map((bar) => bar.low))),
    movePct: round((Number(livePrice) / openingPrice - 1) * 100)
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function covariance(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 2) return 0;
  const a = left.slice(-length), b = right.slice(-length);
  const aMean = mean(a), bMean = mean(b);
  return mean(a.map((value, index) => (value - aMean) * (b[index] - bMean)));
}

function resultBars(result) {
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    timestamp,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index]
  })).filter((bar) => [bar.high, bar.low, bar.close].every(Number.isFinite));
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  const changes = closes.slice(-period - 1).slice(1).map((value, index) => value - closes.slice(-period - 1)[index]);
  const gains = mean(changes.map((value) => Math.max(0, value)));
  const losses = mean(changes.map((value) => Math.max(0, -value)));
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function ema(values, period) {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((value, next) => next * alpha + value * (1 - alpha), values[0]);
}

function linearTrend(values) {
  if (values.length < 3) return { slopePctPerDay: 0, rSquared: 0 };
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0, denominator = 0, total = 0, unexplained = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  const slope = denominator ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;
  values.forEach((value, index) => {
    const fitted = intercept + slope * index;
    total += (value - yMean) ** 2;
    unexplained += (value - fitted) ** 2;
  });
  return {
    slopePctPerDay: yMean ? (slope / yMean) * 100 : 0,
    rSquared: total ? Math.max(0, 1 - unexplained / total) : 0
  };
}

function calculate(symbol, result, benchmarkResult = null) {
  const meta = result.meta || {};
  const bars = resultBars(result);

  if (!bars.length) throw new Error("No usable market bars returned");

  const now = Math.floor(Date.now() / 1000);
  const rolling = bars.filter((bar) => bar.timestamp >= now - 31 * DAY);
  const windowBars = rolling.length ? rolling : bars.slice(-23);
  const livePrice = meta.regularMarketPrice ?? bars.at(-1).close;
  const liveLow = Number.isFinite(meta.regularMarketDayLow) ? meta.regularMarketDayLow : livePrice;
  const liveHigh = Number.isFinite(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : livePrice;
  const low31 = Math.min(liveLow, ...windowBars.map((bar) => bar.low));
  const high31 = Math.max(liveHigh, ...windowBars.map((bar) => bar.high));
  const range = Math.max(high31 - low31, high31 * 0.005);
  const midpoint = (low31 + high31) / 2;

  const trueRanges = windowBars.map((bar, index) => {
    const previousClose = windowBars[index - 1]?.close ?? bar.open ?? bar.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  const atr14 = mean(trueRanges.slice(-14));
  const extension = Math.min(range * 0.2, Math.max(range * 0.1, atr14 * 0.75));

  const buy = [
    midpoint - range * 0.15,
    midpoint - range * 0.3,
    low31 + range * 0.05,
    low31 - extension,
    low31 - extension * 2
  ].map(round);
  const sell = [
    midpoint + range * 0.15,
    midpoint + range * 0.3,
    high31 - range * 0.05,
    high31 + extension,
    high31 + extension * 2
  ].map(round);

  const closes = windowBars.map((bar) => bar.close);
  const allCloses = bars.map((bar) => bar.close);
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const price = livePrice;
  const dateInIndia = indiaDate;
  const latestBarIsCurrentSession = meta.regularMarketTime && dateInIndia(meta.regularMarketTime) === dateInIndia(bars.at(-1).timestamp);
  const previousClose = latestBarIsCurrentSession ? (bars.at(-2)?.close ?? price) : bars.at(-1).close;
  const position = Math.max(-0.5, Math.min(1.5, (price - low31) / range));
  const regime = price < low31 ? "below-range" : price > high31 ? "above-range" : position <= 0.35 ? "lower-band" : position >= 0.65 ? "upper-band" : "mid-band";
  const rsi14 = rsi(allCloses);
  const ema12 = ema(allCloses, 12);
  const ema26 = ema(allCloses, 26);
  const emaSpreadPct = price ? ((ema12 - ema26) / price) * 100 : 0;
  const fiveDayBase = allCloses.at(-6) ?? allCloses[0];
  const return5Pct = fiveDayBase ? ((price - fiveDayBase) / fiveDayBase) * 100 : 0;
  const threeDayBase = allCloses.at(-4) ?? allCloses[0];
  const sixDayBase = allCloses.at(-7) ?? allCloses[0];
  const recent3Pct = threeDayBase ? ((price - threeDayBase) / threeDayBase) * 100 : 0;
  const prior3Pct = sixDayBase ? ((threeDayBase - sixDayBase) / sixDayBase) * 100 : 0;
  const accelerationPct = recent3Pct - prior3Pct;
  const recent20 = allCloses.slice(-20);
  const average20 = mean(recent20);
  const deviation20 = standardDeviation(recent20);
  const zScore20 = deviation20 ? (price - average20) / deviation20 : 0;
  const trend10 = linearTrend(allCloses.slice(-10));
  const benchmarkCloses = resultBars(benchmarkResult).map((bar) => bar.close);
  const hasBenchmark = benchmarkCloses.length >= 6;
  const stock20Base = allCloses.at(-21) ?? allCloses[0];
  const benchmark20Base = benchmarkCloses.at(-21) ?? benchmarkCloses[0];
  const stock20Pct = stock20Base ? (price / stock20Base - 1) * 100 : 0;
  const benchmark20Pct = benchmark20Base && benchmarkCloses.length ? (benchmarkCloses.at(-1) / benchmark20Base - 1) * 100 : 0;
  const relativeStrength20Pct = hasBenchmark ? stock20Pct - benchmark20Pct : 0;
  const stockRiskReturns = allCloses.slice(-21).slice(1).map((value, index) => Math.log(value / allCloses.slice(-21)[index]));
  const benchmarkRiskCloses = benchmarkCloses.slice(-21);
  const benchmarkRiskReturns = benchmarkRiskCloses.slice(1).map((value, index) => Math.log(value / benchmarkRiskCloses[index]));
  const benchmarkVariance = standardDeviation(benchmarkRiskReturns) ** 2;
  const beta20 = benchmarkVariance ? covariance(stockRiskReturns, benchmarkRiskReturns) / benchmarkVariance : 0;
  const correlation20 = standardDeviation(stockRiskReturns) && standardDeviation(benchmarkRiskReturns)
    ? covariance(stockRiskReturns, benchmarkRiskReturns) / (standardDeviation(stockRiskReturns) * standardDeviation(benchmarkRiskReturns)) : 0;
  const reversionParts = [
    position <= 0.35 ? 1 : position >= 0.65 ? -1 : 0,
    Number.isFinite(rsi14) ? (rsi14 <= 35 ? 1 : rsi14 >= 65 ? -1 : 0) : 0,
    zScore20 <= -1 ? 1 : zScore20 >= 1 ? -1 : 0
  ];
  const trendParts = [
    return5Pct >= 1 ? 1 : return5Pct <= -1 ? -1 : 0,
    emaSpreadPct >= 0.25 ? 1 : emaSpreadPct <= -0.25 ? -1 : 0,
    hasBenchmark ? (relativeStrength20Pct >= 1 ? 1 : relativeStrength20Pct <= -1 ? -1 : 0) : 0
  ];
  const reversionScore = reversionParts.reduce((sum, value) => sum + value, 0);
  const trendScore = trendParts.reduce((sum, value) => sum + value, 0);
  const volatilityPct = standardDeviation(returns) * Math.sqrt(252) * 100;
  const atrPct = price ? atr14 / price * 100 : 0;
  const marketRegime = volatilityPct >= 65 || atrPct >= 4 || Math.abs(accelerationPct) >= 5 || Math.abs(return5Pct) >= 12 ? "volatile"
    : trend10.rSquared >= .55 && Math.abs(emaSpreadPct) >= .2 ? "trend"
      : trend10.rSquared <= .3 ? "range" : "transition";
  const pulseScore = marketRegime === "trend" ? trendScore : marketRegime === "range" ? reversionScore : 0;
  const activeParts = marketRegime === "trend" ? trendParts : marketRegime === "range" ? reversionParts : [];
  const directionalParts = activeParts.filter(Boolean);
  const pulseAgreementPct = directionalParts.length ? Math.abs(pulseScore) / directionalParts.length * 100 : 0;

  return {
    symbol: symbol.replace(/\.NS$/, ""),
    providerSymbol: symbol,
    currency: meta.currency || "INR",
    exchange: meta.fullExchangeName || meta.exchangeName || "NSE",
    price: round(price),
    previousClose: round(previousClose),
    change: round(price - previousClose),
    changePct: round(((price - previousClose) / previousClose) * 100),
    marketState: meta.marketState || "UNKNOWN",
    exchangeTime: meta.regularMarketTime || bars.at(-1).timestamp,
    fetchedAt: Math.floor(Date.now() / 1000),
    daily: {
      open: round(Number.isFinite(meta.regularMarketOpen) ? meta.regularMarketOpen : (bars.at(-1).open ?? bars.at(-1).close)),
      low: round(liveLow),
      high: round(liveHigh)
    },
    weekly: weekSnapshot(bars, price),
    window: {
      calendarDays: 31,
      sessions: windowBars.length,
      from: windowBars[0].timestamp,
      to: windowBars.at(-1).timestamp,
      low: round(low31),
      high: round(high31),
      midpoint: round(midpoint),
      range: round(range),
      atr14: round(atr14),
      annualizedVolatilityPct: round(volatilityPct),
      rsi14: round(rsi14)
    },
    signals: {
      atrPct: round(atrPct),
      return5Pct: round(return5Pct),
      emaSpreadPct: round(emaSpreadPct),
      zScore20: round(zScore20),
      slope10PctPerDay: round(trend10.slopePctPerDay),
      trendFitPct: round(trend10.rSquared * 100),
      accelerationPct: round(accelerationPct),
      relativeStrength20Pct: round(relativeStrength20Pct),
      benchmark20Pct: round(benchmark20Pct),
      beta20: round(beta20),
      correlation20: round(correlation20),
      marketRegime,
      trendScore,
      reversionScore,
      pulseScore,
      pulseAgreementPct: round(pulseAgreementPct)
    },
    ladder: { buy, sell, extension: round(extension) },
    regime,
    position: round(position),
    series: windowBars.map((bar) => ({
      t: bar.timestamp,
      c: round(bar.close),
      h: round(bar.high),
      l: round(bar.low)
    }))
  };
}

async function fetchChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d&includePrePost=false&events=div%2Csplits`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 K-Square/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(9_000)
  });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  const payload = await response.json();
  const error = payload.chart?.error;
  if (error) throw new Error(error.description || error.code || "Provider error");
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error("Symbol not found");
  return result;
}

async function benchmark() {
  if (benchmarkCache.result && benchmarkCache.expires > Date.now()) return benchmarkCache.result;
  const result = await fetchChart("^NSEI");
  benchmarkCache = { result, expires: Date.now() + 60_000 };
  return result;
}

async function fetchSymbol(rawSymbol, benchmarkResult) {
  const symbol = rawSymbol === "NIFTY" ? "^NSEI" : rawSymbol.endsWith(".NS") ? rawSymbol : `${rawSymbol}.NS`;
  const result = calculate(symbol, await fetchChart(symbol), benchmarkResult);
  result.symbol = rawSymbol.replace(/\.NS$/, "");
  return result;
}

module.exports = async function handler(request, response) {
  if (!readSession(request)) return response.status(401).json({ error: "Authentication required" });
  response.setHeader("Cache-Control", "private, no-store, max-age=0");

  const raw = String(request.query?.symbols || "").toUpperCase();
  const symbols = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))].slice(0, 10);
  const valid = symbols.filter((symbol) => /^[A-Z0-9&-]{1,30}(\.NS)?$/.test(symbol));

  if (!valid.length) {
    return response.status(400).json({ error: "Supply 1–10 comma-separated NSE symbols." });
  }

  const benchmarkResult = await benchmark().catch(() => null);
  const settled = await Promise.allSettled(valid.map((symbol) => fetchSymbol(symbol, benchmarkResult)));
  const data = [];
  const errors = [];
  settled.forEach((item, index) => {
    if (item.status === "fulfilled") data.push(item.value);
    else errors.push({ symbol: valid[index].replace(/\.NS$/, ""), message: item.reason?.message || "Fetch failed" });
  });

  return response.status(data.length ? 200 : 502).json({ data, errors, provider: "Yahoo Finance chart feed (unofficial; may be delayed)" });
};
