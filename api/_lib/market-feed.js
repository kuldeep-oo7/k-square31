function resultBars(result) {
  if (Array.isArray(result?.k2NormalizedBars)) return result.k2NormalizedBars.map(bar => ({ ...bar }));
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adjclose = result?.indicators?.adjclose?.[0]?.adjclose || [];
  return timestamps.map((timestamp, index) => {
    const rawClose = quote.close?.[index];
    const adjClose = adjclose?.[index];
    // A-1: Dividend adjustment ratio removes artificial ex-dividend price drops
    const factor = (Number.isFinite(adjClose) && Number.isFinite(rawClose) && rawClose > 0)
      ? adjClose / rawClose
      : 1.0;
    const rawOpen = quote.open?.[index];
    const rawHigh = quote.high?.[index];
    const rawLow = quote.low?.[index];

    return {
      timestamp,
      open: Number.isFinite(rawOpen) ? Math.round(rawOpen * factor * 100) / 100 : null,
      high: Number.isFinite(rawHigh) ? Math.round(rawHigh * factor * 100) / 100 : null,
      low: Number.isFinite(rawLow) ? Math.round(rawLow * factor * 100) / 100 : null,
      close: Number.isFinite(adjClose) ? Math.round(adjClose * 100) / 100 : (Number.isFinite(rawClose) ? Math.round(rawClose * 100) / 100 : null),
      rawClose: Number.isFinite(rawClose) ? rawClose : null,
      rawOpen: Number.isFinite(rawOpen) ? rawOpen : null,
      rawHigh: Number.isFinite(rawHigh) ? rawHigh : null,
      rawLow: Number.isFinite(rawLow) ? rawLow : null,
      dividendAdjFactor: factor,
      priceBasis: Number.isFinite(adjClose) ? "ADJUSTED" : "RAW_UNADJUSTED",
      source: "YahooFinance",
      volume: Number.isFinite(quote.volume?.[index]) && quote.volume[index] >= 0 ? quote.volume[index] : null
    };
  }).filter((bar) => Number.isFinite(bar.timestamp) && [bar.open, bar.high, bar.low, bar.close].every(n => Number.isFinite(n) && n > 0)
    && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close));
}

function formatSymbol(rawSymbol) {
  if (typeof rawSymbol !== "string") return "";
  const s = rawSymbol.trim();
  if (s.startsWith("^") || s.includes("=") || s.includes(".")) {
    return s;
  }
  return `${s}.NS`;
}

async function fetchChart(rawSymbol, options = {}) {
  const symbol = formatSymbol(rawSymbol);
  const range = options.range || "3mo";
  const interval = options.interval || "1d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeout || 9_000)
  });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  const payload = await response.json();
  const error = payload.chart?.error;
  if (error) throw new Error(error.description || error.code || "Provider error");
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error("Symbol not found");
  return result;
}

/**
 * Fetches verified real-time macro drivers for the Indian market:
 * - GIFT Nifty 50 Futures from TradingView official scanner (NSEIX:NIFTY1!)
 * - India VIX, Brent Crude, US S&P Futures, US Nasdaq Futures from Yahoo Finance
 */
function createMacroEnvelope(provider, providerSymbol, data = null, error = null) {
  const isLive = data && Number.isFinite(data.price) && data.price > 0;
  // Retrieval time is not a source price timestamp. Never upgrade missing provenance.
  const quoteIso = data?.quoteAsOf || null;
  const quoteTime = Date.parse(quoteIso);
  const recent = Number.isFinite(quoteTime) && Date.now() - quoteTime >= -60000 && Date.now() - quoteTime <= 24 * 60 * 60_000;
  return {
    price: isLive ? Number(data.price) : null,
    changePct: isLive && Number.isFinite(data.changePct) ? data.changePct : null,
    changeAbs: isLive && Number.isFinite(data.changeAbs) ? Number(data.changeAbs) : null,
    provider,
    providerSymbol,
    freshnessStatus: !isLive ? "UNAVAILABLE" : recent ? "RECENT_PROVIDER_SNAPSHOT" : Number.isFinite(quoteTime) ? "STALE" : "TIMESTAMP_UNVERIFIED",
    qualityStatus: isLive ? "VALID_PRICE_ONLY" : "MISSING",
    timestampKind: data?.timestampKind || "UNVERIFIED",
    fallbackUsed: false,
    receivedAt: isLive ? new Date().toISOString() : null,
    quoteAsOf: quoteIso,
    error: error ? String(error) : null
  };
}

function macroInputFromRadar(radar, nowMs = Date.now(), maxAgeMs = 5 * 60_000) {
  const value = (node, field) => {
    const stamp = Date.parse(node?.quoteAsOf);
    return ["EXCHANGE", "PROVIDER_QUOTE"].includes(node?.timestampKind)
      && Number.isFinite(stamp) && nowMs - stamp <= maxAgeMs && nowMs - stamp >= 0
      && typeof node?.[field] === "number" && Number.isFinite(node[field]) ? node[field] : null;
  };
  return { giftNiftyGapPct: value(radar?.giftNifty, "changePct"), indiaVix: value(radar?.indiaVix, "price"),
    indiaVixChangePct: value(radar?.indiaVix, "changePct"), brentCrudeSpikePct: value(radar?.brentCrude, "changePct"),
    sp500FuturesGapPct: value(radar?.sp500Futures, "changePct") };
}

/**
 * Fetches verified real-time macro drivers for the Indian market:
 * - GIFT Nifty 50 Futures from TradingView official scanner (NSEIX:NIFTY1!)
 * - India VIX, Brent Crude, US S&P Futures, US Nasdaq Futures from Yahoo Finance
 *
 * NOTE: Returns null / UNAVAILABLE when network or provider fails.
 * NEVER fabricates plausible synthetic prices.
 */
async function fetchLiveMacroRadar() {
  const radar = {
    giftNifty: createMacroEnvelope("TradingView", "NSEIX:NIFTY1!"),
    indiaVix: createMacroEnvelope("YahooFinance", "^INDIAVIX"),
    brentCrude: createMacroEnvelope("YahooFinance", "BZ=F"),
    sp500Futures: createMacroEnvelope("YahooFinance", "ES=F"),
    nasdaqFutures: createMacroEnvelope("YahooFinance", "NQ=F"),
    usdInr: createMacroEnvelope("YahooFinance", "INR=X"),
    updatedAt: new Date().toISOString(),
    qualitySummary: "INITIALIZING"
  };

  // 1. Live GIFT Nifty from TradingView Scanner
  try {
    const tvUrl = "https://scanner.tradingview.com/symbol?symbol=NSEIX:NIFTY1!&fields=close,change,change_abs,open,high,low";
    const res = await fetch(tvUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const d = await res.json();
      if (Number.isFinite(d.close)) {
        radar.giftNifty = createMacroEnvelope("TradingView", "NSEIX:NIFTY1!", {
          price: Number(d.close),
          changePct: Number.isFinite(d.change) ? d.change : null,
          changeAbs: Number.isFinite(d.change_abs) ? d.change_abs : null,
          quoteAsOf: null,
          timestampKind: "UNVERIFIED"
        });
      }
    } else {
      radar.giftNifty.error = `TradingView returned status ${res.status}`;
    }
  } catch (e) {
    radar.giftNifty.error = e.message;
  }

  // 2. Live global correlation assets from Yahoo Finance
  async function fetchYahooQuote(ticker) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return { data: null, error: `HTTP ${res.status}` };
      const d = await res.json();
      const result = d.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!quote || !quote.close) return { data: null, error: "Empty quote indicator" };
      const closes = quote.close.map((price, index) => ({ price, timestamp: result.timestamp?.[index] })).filter((row) => Number.isFinite(row.price) && row.price > 0);
      if (closes.length < 2) return { data: null, error: "Insufficient closes" };
      const last = closes.at(-1).price;
      const prev = closes.at(-2).price;
      return {
        data: {
          price: Number(last),
          changePct: Number(((last - prev) / prev) * 100),
          // These are daily bars, not an asserted live last-trade feed.
          quoteAsOf: Number.isFinite(closes.at(-1).timestamp) ? new Date(closes.at(-1).timestamp * 1000).toISOString() : null,
          timestampKind: "DAILY_BAR_START"
        },
        error: null
      };
    } catch (err) {
      return { data: null, error: err.message };
    }
  }

  try {
    const [vixRes, brentRes, sp500Res, nqRes, inrRes] = await Promise.all([
      fetchYahooQuote("^INDIAVIX"),
      fetchYahooQuote("BZ=F"),
      fetchYahooQuote("ES=F"),
      fetchYahooQuote("NQ=F"),
      fetchYahooQuote("INR=X")
    ]);

    radar.indiaVix = createMacroEnvelope("YahooFinance", "^INDIAVIX", vixRes.data, vixRes.error);
    radar.brentCrude = createMacroEnvelope("YahooFinance", "BZ=F", brentRes.data, brentRes.error);
    radar.sp500Futures = createMacroEnvelope("YahooFinance", "ES=F", sp500Res.data, sp500Res.error);
    radar.nasdaqFutures = createMacroEnvelope("YahooFinance", "NQ=F", nqRes.data, nqRes.error);
    radar.usdInr = createMacroEnvelope("YahooFinance", "INR=X", inrRes.data, inrRes.error);
  } catch (e) {
    console.warn("Global assets fetch warning:", e.message);
  }

  const liveCount = [
    radar.giftNifty, radar.indiaVix, radar.brentCrude,
    radar.sp500Futures, radar.nasdaqFutures, radar.usdInr
  ].filter(item => item.freshnessStatus === "RECENT_PROVIDER_SNAPSHOT").length;

  radar.qualitySummary = liveCount >= 4 ? "PARTIAL_TIMESTAMPED_SNAPSHOTS" : liveCount > 0 ? "PARTIAL_DEGRADED" : "FRESHNESS_UNVERIFIED";

  return radar;
}

module.exports = { createMacroEnvelope, macroInputFromRadar, fetchChart, fetchLiveMacroRadar, formatSymbol, resultBars };
