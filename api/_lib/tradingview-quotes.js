"use strict";

/**
 * TradingView public scanner: live underlying quotes, free and unauthenticated.
 *
 * WHAT THIS CAN AND CANNOT DO, established by testing rather than assumption:
 *
 *   NSE equities        works, in bulk, one request for many symbols
 *   NSE index futures   works, via the single-symbol endpoint (NSE:NIFTY1!)
 *   NSE OPTIONS         DOES NOT EXIST on the free API
 *
 * The last line is not a guess. TradingView's own symbol search rejects the
 * category outright:
 *
 *     search_type=option          -> HTTP 400 search_type_not_found: option
 *     NSE:NIFTY...CE / ...PE      -> HTTP 404 symbol_not_exists
 *
 * So this module supplies UNDERLYING prices and nothing else. Option premiums
 * still require either the exchange bhavcopy (end of day) or a broker feed
 * (live, authenticated). Pretending otherwise would put a made-up premium on a
 * card with a one-tap order link, which is the failure this codebase keeps
 * having to undo.
 *
 * DELAY IS RECORDED, NOT HIDDEN. The scanner reports update_mode, and on this
 * exchange it returns delayed_streaming_900 -- fifteen minutes behind. A price
 * that is a quarter of an hour old is usable for ranking and useless for
 * execution, and the difference has to travel with the number.
 */

const SYMBOL_ENDPOINT = "https://scanner.tradingview.com/symbol";
const SCAN_ENDPOINT = "https://scanner.tradingview.com/india/scan";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const COLUMNS = ["close", "change", "change_abs", "open", "high", "low", "volume", "update_mode"];

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Translate TradingView's update_mode into an explicit staleness contract.
 * Anything not recognised is treated as unknown rather than assumed live.
 */
function freshnessFor(updateMode) {
  const mode = String(updateMode || "").toLowerCase();
  if (mode.startsWith("streaming") || mode === "realtime") {
    return { kind: "REALTIME", delaySeconds: 0, executable: true };
  }
  const delayed = mode.match(/delayed[_-]?streaming[_-]?(\d+)/);
  if (delayed) {
    const seconds = Number(delayed[1]);
    return {
      kind: "DELAYED",
      delaySeconds: Number.isFinite(seconds) ? seconds : null,
      // A quarter-hour-old price cannot be transacted against.
      executable: false
    };
  }
  if (mode.includes("delayed")) return { kind: "DELAYED", delaySeconds: null, executable: false };
  if (mode.includes("eod") || mode.includes("end_of_day")) return { kind: "END_OF_DAY", delaySeconds: null, executable: false };
  return { kind: "UNKNOWN", delaySeconds: null, executable: false };
}

function normalise(ticker, values, receivedAt) {
  const [close, change, changeAbs, open, high, low, volume, updateMode] = values;
  const freshness = freshnessFor(updateMode);
  return {
    ticker,
    symbol: String(ticker).split(":").pop(),
    exchange: String(ticker).split(":")[0] || null,
    price: num(close),
    changePct: num(change),
    changeAbs: num(changeAbs),
    open: num(open),
    high: num(high),
    low: num(low),
    volume: num(volume),
    updateMode: updateMode || null,
    freshness: freshness.kind,
    delaySeconds: freshness.delaySeconds,
    // The single field a caller must read before treating this as a fill price.
    executable: freshness.executable,
    receivedAt,
    provider: "TRADINGVIEW_SCANNER",
    // Retrieval time is not the exchange's timestamp. The scanner does not give
    // one, so none is invented here.
    quoteAsOf: null
  };
}

/**
 * Bulk quotes. One request covers many symbols, which matters when the desk
 * refreshes 210 names on a timer.
 */
async function quotes(tickers, { timeoutMs = 20_000 } = {}) {
  const list = (Array.isArray(tickers) ? tickers : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, reason: "NO_TICKERS", quotes: {} };

  try {
    const response = await fetch(SCAN_ENDPOINT, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ symbols: { tickers: list, query: { types: [] } }, columns: COLUMNS }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, reason: `HTTP_${response.status}`, quotes: {} };
    const payload = await response.json();
    const receivedAt = new Date().toISOString();
    const result = {};
    for (const row of payload.data || []) {
      if (!row?.s || !Array.isArray(row.d)) continue;
      result[row.s] = normalise(row.s, row.d, receivedAt);
    }
    // Symbols the scanner silently dropped are reported, not filled in.
    const missing = list.filter((ticker) => !result[ticker]);
    return { ok: true, requested: list.length, returned: Object.keys(result).length, missing, quotes: result };
  } catch (error) {
    return { ok: false, reason: error.name === "TimeoutError" ? "TIMEOUT" : error.message, quotes: {} };
  }
}

/**
 * One symbol via the single-symbol endpoint. Index futures such as NSE:NIFTY1!
 * answer here but are dropped by the bulk scanner, so both paths are needed.
 */
async function quote(ticker, { timeoutMs = 15_000 } = {}) {
  const symbol = String(ticker || "").trim();
  if (!symbol) return { ok: false, reason: "NO_TICKER", quote: null };
  try {
    const url = `${SYMBOL_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&fields=${COLUMNS.join(",")}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { ok: false, reason: response.status === 404 ? "SYMBOL_NOT_EXISTS" : `HTTP_${response.status}`, quote: null, ticker: symbol };
    }
    const payload = await response.json();
    const values = COLUMNS.map((column) => payload[column]);
    return { ok: true, ticker: symbol, quote: normalise(symbol, values, new Date().toISOString()) };
  } catch (error) {
    return { ok: false, reason: error.name === "TimeoutError" ? "TIMEOUT" : error.message, quote: null, ticker: symbol };
  }
}

/**
 * Options are not available here, and asking is a programming error rather than
 * a runtime condition. This exists so a caller gets a clear refusal instead of
 * an empty result they might mistake for "no trades today".
 */
function optionQuote() {
  return {
    ok: false,
    reason: "OPTIONS_NOT_AVAILABLE_ON_TRADINGVIEW_PUBLIC_API",
    evidence: "symbol_search search_type=option returns HTTP 400 search_type_not_found; NSE option tickers return HTTP 404 symbol_not_exists",
    useInstead: "NSE F&O bhavcopy for end-of-day, or an authenticated broker feed for live",
    quote: null
  };
}

module.exports = { COLUMNS, SCAN_ENDPOINT, SYMBOL_ENDPOINT, freshnessFor, optionQuote, quote, quotes };
