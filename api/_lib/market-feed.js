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
  const isLive = data && Number.isFinite(data.price);
  return {
    price: isLive ? Number(data.price) : null,
    changePct: isLive ? Number(data.changePct || 0) : null,
    changeAbs: isLive && Number.isFinite(data.changeAbs) ? Number(data.changeAbs) : null,
    provider,
    providerSymbol,
    freshnessStatus: isLive ? "LIVE" : "UNAVAILABLE",
    qualityStatus: isLive ? "VALID" : "MISSING",
    fallbackUsed: false,
    receivedAt: isLive ? new Date().toISOString() : null,
    error: error ? String(error) : null
  };
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
          changePct: Number(d.change || 0),
          changeAbs: Number(d.change_abs || 0)
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
      const quote = d.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!quote || !quote.close) return { data: null, error: "Empty quote indicator" };
      const closes = quote.close.filter(Number.isFinite);
      if (closes.length < 2) return { data: null, error: "Insufficient closes" };
      const last = closes.at(-1);
      const prev = closes.at(-2);
      return {
        data: {
          price: Number(last),
          changePct: Number(((last - prev) / prev) * 100)
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
  ].filter(item => item.freshnessStatus === "LIVE").length;

  radar.qualitySummary = liveCount >= 4 ? "LIVE_VERIFIED" : liveCount > 0 ? "PARTIAL_DEGRADED" : "DATA_UNAVAILABLE";

  return radar;
}

module.exports = { fetchChart, fetchLiveMacroRadar, formatSymbol, resultBars };
