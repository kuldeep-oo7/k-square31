"use strict";

/**
 * Live broker quotes, cached for the synchronous scanner path.
 *
 * The desk builds its cards synchronously, and a broker chain is an
 * asynchronous, rate-limited request -- Angel One batches 50 tokens per call
 * and Dhan permits one chain every three seconds. Fetching inside the card
 * builder would either block it or, worse, tempt someone to fill the gap with a
 * model price while the request was in flight.
 *
 * So the engine refreshes into this cache on its own timer, and the card
 * builder reads whatever is there. What it reads always carries an AGE, because
 * that is the whole difference between a quote and a number:
 *
 *   - inside the freshness window, the card shows a live bid and ask
 *   - outside it, the card falls back to the exchange's settled price and SAYS
 *     SO, rather than presenting a stale quote as a current one
 *
 * A quote that has gone stale is not downgraded quietly. Nothing here ever
 * substitutes a model value for a market one.
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private", "cache"));
const CACHE_FILE = path.join(CACHE_DIR, "live-quotes.json");

// Beyond this a quote describes the past. Indian option books move fast enough
// that a two-minute-old bid is not something to size a position against.
const DEFAULT_MAX_AGE_MS = 120_000;

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

let memo = null;

function load() {
  if (memo) return memo;
  if (!fs.existsSync(CACHE_FILE)) return null;
  try { memo = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); return memo; }
  catch (error) { return null; }
}

function save(payload) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  memo = payload;
  return payload;
}

const keyFor = (symbol, expiry, strike, optionType) =>
  `${String(symbol).toUpperCase()}|${String(expiry).slice(0, 10)}|${Number(strike)}|${String(optionType).toUpperCase()}`;

/**
 * One contract's live quote, or null when there is none or it has aged out.
 *
 * Returning null rather than a stale row is deliberate: a caller that gets
 * nothing falls back to the settled price and labels it. A caller that gets a
 * two-minute-old bid has no way to know it should not act on it.
 */
function liveQuote(symbol, expiry, strike, optionType, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const cache = load();
  if (!cache) return null;
  const row = cache.quotes?.[keyFor(symbol, expiry, strike, optionType)];
  if (!row) return null;
  const fetchedAt = Date.parse(row.fetchedAt || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) return null;
  const ageMs = now - fetchedAt;
  if (ageMs > maxAgeMs) return null;
  // A price with nobody on both sides cannot be transacted against, whatever
  // its last print says.
  if (!(row.bid > 0 && row.ask > 0)) return null;
  return { ...row, ageMs, ageSeconds: Math.round(ageMs / 1000) };
}

/** What the cache holds right now, for reporting rather than for pricing. */
function status({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const cache = load();
  if (!cache) return { available: false, reason: "NO_CACHE", contracts: 0, fresh: 0 };
  const entries = Object.values(cache.quotes || {});
  const fresh = entries.filter((row) => {
    const fetchedAt = Date.parse(row.fetchedAt || cache.fetchedAt || "");
    return Number.isFinite(fetchedAt) && now - fetchedAt <= maxAgeMs;
  });
  return {
    available: fresh.length > 0,
    provider: cache.provider || null,
    fetchedAt: cache.fetchedAt || null,
    ageSeconds: cache.fetchedAt ? Math.round((now - Date.parse(cache.fetchedAt)) / 1000) : null,
    contracts: entries.length,
    fresh: fresh.length,
    symbols: cache.symbolCount || 0,
    maxAgeMs
  };
}

/**
 * Refresh quotes for a list of symbols.
 *
 * Deliberately bounded. Refreshing all 210 names would take minutes under the
 * brokers' rate limits and the earliest quotes would be stale before the last
 * arrived, so the caller passes the symbols that actually matter -- the ones
 * the desk is recommending -- and everything else keeps the settled price with
 * an honest label.
 */
async function refreshQuotes(requests, { provider = null, concurrency = 1 } = {}) {
  const brokers = require("./broker-feed");
  const state = brokers.status();
  const active = provider || state.activeProvider;
  if (!active) {
    return { ok: false, reason: "NO_BROKER_CONFIGURED", refreshed: 0, detail: state };
  }

  const list = (Array.isArray(requests) ? requests : []).filter((row) => row?.symbol && row?.expiry);
  if (!list.length) return { ok: false, reason: "NOTHING_REQUESTED", refreshed: 0 };

  const previous = load();
  const quotes = { ...(previous?.quotes || {}) };
  const fetchedAt = new Date().toISOString();
  let symbolsDone = 0;
  const failures = [];

  for (const request of list) {
    try {
      const chain = await brokers.optionChain(request.symbol, request.expiry, {
        provider: active,
        referencePrice: num(request.referencePrice)
      });
      if (!chain.ok) { failures.push(`${request.symbol}: ${chain.reason}`); continue; }
      for (const leg of chain.chain || []) {
        quotes[keyFor(request.symbol, chain.expiry, leg.strike, leg.optionType)] = {
          symbol: request.symbol,
          expiry: chain.expiry,
          strike: leg.strike,
          optionType: leg.optionType,
          lastPrice: leg.lastPrice,
          bid: leg.bid,
          ask: leg.ask,
          bidQuantity: leg.bidQuantity,
          askQuantity: leg.askQuantity,
          spread: leg.spread,
          spreadPct: leg.spreadPct,
          openInterest: leg.openInterest,
          volume: leg.volume,
          impliedVolatility: leg.impliedVolatility,
          delta: leg.delta,
          gamma: leg.gamma,
          theta: leg.theta,
          vega: leg.vega,
          lotSize: leg.lotSize ?? null,
          provider: chain.provider,
          source: chain.source,
          fetchedAt
        };
      }
      symbolsDone += 1;
    } catch (error) {
      failures.push(`${request.symbol}: ${error.message}`);
    }
  }

  save({
    provider: active,
    fetchedAt,
    symbolCount: symbolsDone,
    quoteCount: Object.keys(quotes).length,
    failures: failures.slice(0, 20),
    quotes
  });
  return { ok: symbolsDone > 0, provider: active, refreshed: symbolsDone, requested: list.length, failures };
}

module.exports = { CACHE_FILE, DEFAULT_MAX_AGE_MS, keyFor, liveQuote, refreshQuotes, status };
