"use strict";
// Position monitoring is independent of new-entry signal and ban gates.
const { dayAt } = require("./engine");
const { sessionAt } = require("./feed");
const { parseExchangeClock } = require("../api/_lib/live-quotes");
async function positionQuotes(book, { now = Date.now(), nseQuotes = require("../api/_lib/broker-feed").futuresQuotes,
  cryptoQuotes = require("./crypto-feed").collectCrypto } = {}) {
  const quotes = {}, errors = [], open = book.filter((t) => t.status === "OPEN"), day = dayAt(now);
  const nse = open.filter((t) => t.market === "NSE_FUTURES" && t.expiry >= day);
  if (nse.length && sessionAt(now) === true && now >= Date.parse(`${day}T09:15:00+05:30`) && now <= Date.parse(`${day}T15:30:00+05:30`)) {
    try {
      const r = await nseQuotes(nse.map((t) => ({ symbol: t.symbol, expiry: t.expiry })), { timeoutMs: 12000 });
      for (const t of nse) { const q = r.quotes?.[`${t.symbol}|${t.expiry}`], at = parseExchangeClock(q?.exchangeFeedTime); if (q && at !== null) quotes[t.instrumentId] = { instrumentId: t.instrumentId, at: new Date(at).toISOString(), bid: q.bid, ask: q.ask }; }
      if (r.ok === false) errors.push("POSITION_QUOTES_UNAVAILABLE");
    } catch { errors.push("POSITION_QUOTES_UNAVAILABLE"); }
  }
  const crypto = open.filter((t) => t.market === "CRYPTO_SPOT" && t.instrumentId === "BINANCE_SPOT|" + t.symbol);
  if (crypto.length) {
    try { const r = await cryptoQuotes([...new Set(crypto.map((t) => t.symbol))], { now }); for (const i of r.inputs || []) if (i.quote) quotes[i.instrumentId] = i.quote; if (r.errors?.length) errors.push("CRYPTO_POSITION_QUOTES_UNAVAILABLE"); }
    catch { errors.push("CRYPTO_POSITION_QUOTES_UNAVAILABLE"); }
  }
  return { quotes, errors };
}
module.exports = { positionQuotes };
