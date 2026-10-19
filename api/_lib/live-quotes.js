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

// NSE equity derivatives trade 09:15-15:30 IST. The exchange keeps publishing a
// feed time after that (15:40 is routine), which is the closing book rather
// than a live one.
const IST_OFFSET_MINUTES = 330;
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Angel returns "17-Sep-2026 15:40:00" with no offset. Date.parse would read
 * that in the HOST's timezone: correct on an IST laptop, five and a half hours
 * out on a UTC server, where during market hours it lands the quote in the
 * FUTURE -- and a negative age passes every "older than" test, so a stale book
 * would read as fresh on exactly the box that matters. The offset is therefore
 * applied explicitly rather than inherited from wherever the process happens
 * to run.
 */
function parseExchangeClock(value) {
  const match = String(value || "").trim()
    .match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const iso = `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`
    + `T${match[4].padStart(2, "0")}:${match[5]}:${match[6]}+05:30`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // 01-Jan-1970 05:30:00 is epoch zero expressed in IST: the exchange's way of
  // saying this contract has never traded. It is a sentinel, not a time.
  if (ms <= 0) return null;
  return ms;
}

/** Minutes past IST midnight, computed without depending on the host zone. */
function istMinutes(ms) {
  const shifted = new Date(ms + IST_OFFSET_MINUTES * 60_000);
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    day: shifted.getUTCDay(),
    date: shifted.toISOString().slice(0, 10)
  };
}

/** Is the exchange open for business at this instant? */
function marketPhase(now = Date.now()) {
  const { minutes, day, date } = istMinutes(now);
  if (day === 0 || day === 6) return { open: false, phase: "WEEKEND", istDate: date };
  if (minutes < SESSION_OPEN_MINUTES) return { open: false, phase: "PRE_OPEN", istDate: date };
  if (minutes > SESSION_CLOSE_MINUTES) return { open: false, phase: "CLOSED", istDate: date };
  return { open: true, phase: "OPEN", istDate: date };
}

/**
 * Classify a book against the EXCHANGE's clock, in the same vocabulary the
 * TradingView client already uses: a kind, an age, and one boolean saying
 * whether an order can be sent against it.
 *
 *   REALTIME      the exchange priced it within the window, market open
 *   CLOSING_BOOK  today's closing book, market shut -- not executable, but its
 *                 SPREAD is the only real spread measurement available, and
 *                 discarding it would switch the spread gate off every evening,
 *                 which is precisely when the desk gets read
 *   STALE         older than today, or no exchange clock at all (Upstox sends
 *                 none, so its books can never claim REALTIME)
 */
function classifyBook(feedTimeMs, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const phase = marketPhase(now);
  if (!Number.isFinite(feedTimeMs)) {
    return { kind: "STALE", executable: false, exchangeAgeSeconds: null, phase: phase.phase, reason: "NO_EXCHANGE_TIMESTAMP" };
  }
  const ageMs = now - feedTimeMs;
  const sameDay = istMinutes(feedTimeMs).date === phase.istDate;
  if (phase.open && ageMs <= maxAgeMs && ageMs >= -60_000) {
    return { kind: "REALTIME", executable: true, exchangeAgeSeconds: Math.round(ageMs / 1000), phase: phase.phase, reason: null };
  }
  if (sameDay) {
    return {
      kind: "CLOSING_BOOK", executable: false, exchangeAgeSeconds: Math.round(ageMs / 1000), phase: phase.phase,
      reason: phase.open ? "EXCHANGE_FEED_OLDER_THAN_WINDOW" : "MARKET_CLOSED_SHOWING_CLOSING_BOOK"
    };
  }
  return { kind: "STALE", executable: false, exchangeAgeSeconds: Math.round(ageMs / 1000), phase: phase.phase, reason: "EXCHANGE_FEED_NOT_FROM_TODAY" };
}

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
  // Memory first, disk second. The disk copy only buys a warm start after a
  // restart; the quotes themselves are already in hand. On a host with an
  // ephemeral or read-only filesystem, writing the file must not be the thing
  // that throws away a refresh that already succeeded.
  memo = payload;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (error) {
    console.error("Quote cache not persisted, serving from memory:", error.message);
  }
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
  // Our own clock still bounds the cache: a book pulled yesterday is not worth
  // reasoning about even if the exchange stamped it.
  const fetchedAt = Date.parse(row.fetchedAt || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > 24 * 60 * 60 * 1000) return null;
  // A price with nobody on both sides cannot be transacted against, whatever
  // its last print says.
  if (!(row.bid > 0 && row.ask > 0)) return null;
  const book = classifyBook(parseExchangeClock(row.exchangeFeedTime), { maxAgeMs, now });
  if (book.kind === "STALE") return null;
  return {
    ...row,
    freshness: book.kind,
    executable: book.executable,
    exchangeAgeSeconds: book.exchangeAgeSeconds,
    marketPhase: book.phase,
    bookReason: book.reason,
    // Retained separately and deliberately named: this is how long ago WE
    // asked, which is not how old the quote is.
    fetchAgeSeconds: Math.round((now - fetchedAt) / 1000),
    // Zero volume means the contract did not trade today. A two-sided quote on
    // it is a market maker's, not evidence that anyone transacted.
    tradedToday: Number(row.volume) > 0
  };
}

/**
 * The LIVE futures price for a symbol: the market's forward, which is what an
 * option must be priced against.
 *
 * Read synchronously from the same cache the engine refreshes, for the same
 * reason the option books are: the card builder is synchronous and a broker
 * call is not. Returns null rather than a stale number, so the caller falls
 * back to the exchange file and labels it, instead of quietly pricing today's
 * options off a forward from an earlier session.
 */
function liveFuture(symbol, expiry, { maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const cache = load();
  const row = cache?.futures?.[`${String(symbol).toUpperCase()}|${String(expiry).slice(0, 10)}`];
  if (!row || !(row.price > 0)) return null;
  const fetchedAt = Date.parse(row.fetchedAt || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > maxAgeMs) return null;
  return { ...row, fetchAgeSeconds: Math.round((now - fetchedAt) / 1000) };
}

/** Refresh futures prices for the given symbol/expiry pairs. */
async function refreshFutures(requests) {
  const brokers = require("./broker-feed");
  if (typeof brokers.futuresQuotes !== "function") return { ok: false, reason: "NOT_SUPPORTED" };
  const result = await brokers.futuresQuotes(requests);
  if (!result.ok) return { ok: false, reason: result.reason || "NO_FUTURES_RETURNED" };
  const store = load() || {};
  const fetchedAt = new Date().toISOString();
  const futures = { ...(store.futures || {}) };
  for (const [key, quote] of Object.entries(result.quotes)) futures[key] = { ...quote, fetchedAt };
  save({ ...store, futures, futuresCount: Object.keys(futures).length });
  return { ok: true, count: Object.keys(result.quotes).length };
}

/** What the cache holds right now, for reporting rather than for pricing. */
/**
 * Is the live feed actually working, right now, in one sentence?
 *
 * The REALTIME path has never been observed during an open session, and the way
 * it fails is quiet: exchFeedTime lags the window, REALTIME never fires, every
 * card reads CLOSING BOOK all day and the spread gate silently keys itself to
 * close-of-day spreads. Nothing throws. Every test still passes.
 *
 * Checking that used to mean running a script on the machine that holds the
 * credentials. This runs on the SERVER instead, off the cache the engine
 * already refreshes, so the answer is visible from a phone without a laptop
 * anywhere near it.
 *
 * The verdict that matters is FEED_LAGGING: market open, a real book present,
 * and not one contract current enough to trade against.
 */
function diagnose({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const state = status({ maxAgeMs, now });
  const phase = marketPhase(now);
  const base = { marketPhase: phase.phase, istDate: phase.istDate, checkedAt: new Date(now).toISOString() };

  if (!phase.open) {
    return {
      ...base, verdict: "MARKET_CLOSED", ok: true, tradeable: false,
      headline: "Market closed",
      detail: state.contracts > 0
        ? `Showing the closing book: ${state.closingBook} contracts from the last session.`
        : "No quotes cached. Cards fall back to the exchange settled price."
    };
  }
  if (!state.provider || state.contracts === 0) {
    return {
      ...base, verdict: "NO_FEED", ok: false, tradeable: false,
      headline: "Market open, but no broker feed",
      detail: "No quotes are cached at all. Usually means broker credentials are not configured on this server, so every card is on the exchange settled price."
    };
  }
  if (state.realtime > 0) {
    return {
      ...base, verdict: "LIVE", ok: true, tradeable: true,
      headline: `Live book on ${state.realtime} contracts`,
      detail: `Quotes are inside the ${Math.round(maxAgeMs / 1000)}s window on the exchange's own clock. Prices are executable.`
    };
  }
  // The failure this whole check exists for.
  return {
    ...base, verdict: "FEED_LAGGING", ok: false, tradeable: false,
    headline: "Market open, but no quote is current",
    detail: `${state.closingBook} contracts carry a book and none is inside the ${Math.round(maxAgeMs / 1000)}s window. `
      + "The exchange feed time is lagging, so nothing is marked executable and the spread gate is judging on stale spreads. "
      + "Widen the window to the measured lag and SAY that it was widened, or stop treating this field as a quote time."
  };
}

function status({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const cache = load();
  if (!cache) return { available: false, reason: "NO_CACHE", contracts: 0, fresh: 0 };
  const entries = Object.values(cache.quotes || {});
  const counts = { REALTIME: 0, CLOSING_BOOK: 0, STALE: 0 };
  for (const row of entries) {
    counts[classifyBook(parseExchangeClock(row.exchangeFeedTime), { maxAgeMs, now }).kind] += 1;
  }
  const phase = marketPhase(now);
  return {
    // Available means there is a real book to read; executable means an order
    // can be sent against it. After 15:30 the first is true and the second is
    // not, and collapsing the two is how a closing book gets shown as a live one.
    available: counts.REALTIME + counts.CLOSING_BOOK > 0,
    executable: counts.REALTIME > 0,
    marketPhase: phase.phase,
    provider: cache.provider || null,
    fetchedAt: cache.fetchedAt || null,
    fetchAgeSeconds: cache.fetchedAt ? Math.round((now - Date.parse(cache.fetchedAt)) / 1000) : null,
    contracts: entries.length,
    realtime: counts.REALTIME,
    closingBook: counts.CLOSING_BOOK,
    stale: counts.STALE,
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
          book: leg.book || null,
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
          // Angel's OWN label for the instrument it priced. Stored so the
          // desk can check that the contract we filed under a key is the
          // contract the broker actually quoted, rather than trusting our own
          // token lookup to have been right.
          tradingSymbol: leg.tradingSymbol ?? null,
          token: leg.token ?? null,
          exchangeFeedTime: leg.exchangeFeedTime ?? null,
          exchangeTradeTime: leg.exchangeTradeTime ?? null,
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

  // KEEP THE FUTURES (19 Oct 2026). This save replaced the whole cache, so every futures price stored before it was lost;
  // the engine re-added only its own universe, and a paper-list future outside it (ATHERENERG, all day) vanished.
  const before = load() || {};
  save({
    provider: active,
    fetchedAt,
    symbolCount: symbolsDone,
    quoteCount: Object.keys(quotes).length,
    failures: failures.slice(0, 20),
    quotes,
    ...(before.futures ? { futures: before.futures, futuresCount: Object.keys(before.futures).length } : {})
  });
  return { ok: symbolsDone > 0, provider: active, refreshed: symbolsDone, requested: list.length, failures };
}

module.exports = {
  CACHE_FILE, DEFAULT_MAX_AGE_MS, classifyBook, diagnose, keyFor, liveFuture, liveQuote, load,
  refreshFutures,
  marketPhase, parseExchangeClock, refreshQuotes, status
};
