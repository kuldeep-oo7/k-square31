"use strict";
// Public SPOT market data only. No accounts, keys, orders, perpetuals or leverage.
async function collectCrypto(symbols = ["BTCUSDT", "ETHUSDT"], { now = Date.now(), fetchImpl = fetch } = {}) {
  const inputs = [], errors = [], root = "https://api.binance.com", sessionStart = new Date(now).toISOString().slice(0, 10) + "T00:00:00Z";
  for (const symbol of symbols) {
    if (!/^[A-Z0-9]{5,24}$/.test(symbol)) { errors.push("INVALID_CRYPTO_SYMBOL"); continue; }
    try {
      const request = async (url) => { const r = await fetchImpl(root + url, { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw Error("PUBLIC_MARKET_DATA_UNAVAILABLE"); return r.json(); };
      const meta = await request("/api/v3/exchangeInfo?symbol=" + symbol), instrument = meta.symbols?.find((s) => s.symbol === symbol);
      const tickSize = Number(instrument?.filters?.find((f) => f.filterType === "PRICE_FILTER")?.tickSize), lot = instrument?.filters?.find((f) => f.filterType === "LOT_SIZE");
      if (instrument?.status !== "TRADING" || !(tickSize > 0)) { errors.push(`${symbol}: INSTRUMENT_NOT_TRADEABLE`); continue; }
      const raw = await request("/api/v3/klines?symbol=" + symbol + "&interval=5m&startTime=" + Date.parse(sessionStart) + "&limit=1000");
      // /depth carries the exchange event time in neither spot REST book nor ticker.
      // Bracket it with /time and reject a slow request; do not label client time exchange time.
      const before = await request("/api/v3/time"), book = await request("/api/v3/ticker/bookTicker?symbol=" + symbol), after = await request("/api/v3/time");
      if (!(after.serverTime >= before.serverTime && after.serverTime - before.serverTime <= 5000 && Math.abs(now - after.serverTime) <= 120000)) { errors.push(`${symbol}: QUOTE_TIME_UNVERIFIED`); continue; }
      if (!Array.isArray(raw)) throw Error("INVALID_CANDLES");
      inputs.push({ symbol, market: "CRYPTO_SPOT", currency: instrument.quoteAsset, instrumentId: "BINANCE_SPOT|" + symbol, expiry: null,
        source: "BINANCE_SPOT", sourceUrl: "https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints",
        sessionStart, intervalMinutes: 5, isOpen: true, tradeable: true, canShort: false, tickSize, minQuantity: Number(lot?.minQty) || 0,
        quantityStep: Number(lot?.stepSize) || null, defaultQuantity: 1, volumeKind: "EXCHANGE_VOLUME",
        bars: raw.map((b) => ({ symbol, expiry: null, at: new Date(b[0]).toISOString(), open: Number(b[1]), high: Number(b[2]), low: Number(b[3]), close: Number(b[4]), volume: Number(b[5]) })),
        quote: { symbol, expiry: null, instrumentId: "BINANCE_SPOT|" + symbol, at: new Date(before.serverTime).toISOString(), bid: Number(book.bidPrice), ask: Number(book.askPrice), timeBasis: "EXCHANGE_SERVER_TIME_BRACKET" } });
    } catch (e) { errors.push(`${symbol}: ${e.cause?.code === "EACCES" ? "NETWORK_ACCESS_DENIED" : "PUBLIC_MARKET_DATA_UNAVAILABLE"}`); }
  }
  return { inputs, errors, state: inputs.length ? "SCANNED" : "DATA_UNAVAILABLE", tradingSession: true };
}
module.exports = { collectCrypto };
