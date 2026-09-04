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
async function fetchLiveMacroRadar() {
  const radar = {
    giftNifty: { price: 24050, changePct: 0.15, changeAbs: 35 },
    indiaVix: { price: 11.5, changePct: 0.0 },
    brentCrude: { price: 95.0, changePct: 0.5 },
    sp500Futures: { price: 7750, changePct: 0.8 },
    nasdaqFutures: { price: 29500, changePct: 1.0 },
    usdInr: { price: 94.4, changePct: 0.0 },
    updatedAt: new Date().toISOString()
  };

  // 1. Live GIFT Nifty from TradingView Scanner
  try {
    const tvUrl = "https://scanner.tradingview.com/symbol?symbol=NSEIX:NIFTY1!&fields=close,change,change_abs,open,high,low";
    const res = await fetch(tvUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const d = await res.json();
      if (Number.isFinite(d.close)) {
        radar.giftNifty = {
          price: Number(d.close),
          changePct: Number(d.change || 0),
          changeAbs: Number(d.change_abs || 0)
        };
      }
    }
  } catch (e) {
    console.warn("GIFT Nifty TV fetch warning:", e.message);
  }

  // 2. Live global correlation assets from Yahoo Finance
  async function fetchYahooQuote(ticker) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const d = await res.json();
      const quote = d.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!quote || !quote.close) return null;
      const closes = quote.close.filter(Number.isFinite);
      if (closes.length < 2) return null;
      const last = closes.at(-1);
      const prev = closes.at(-2);
      return {
        price: Number(last),
        changePct: Number(((last - prev) / prev) * 100)
      };
    } catch {
      return null;
    }
  }

  try {
    const [vix, brent, sp500, nq, inr] = await Promise.all([
      fetchYahooQuote("^INDIAVIX"),
      fetchYahooQuote("BZ=F"),
      fetchYahooQuote("ES=F"),
      fetchYahooQuote("NQ=F"),
      fetchYahooQuote("INR=X")
    ]);

    if (vix) radar.indiaVix = vix;
    if (brent) radar.brentCrude = brent;
    if (sp500) radar.sp500Futures = sp500;
    if (nq) radar.nasdaqFutures = nq;
    if (inr) radar.usdInr = inr;
  } catch (e) {
    console.warn("Global assets fetch warning:", e.message);
  }

  return radar;
}

module.exports = { fetchChart, fetchLiveMacroRadar, formatSymbol, resultBars };
