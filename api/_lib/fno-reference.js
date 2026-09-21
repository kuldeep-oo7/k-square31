"use strict";

/**
 * The exchange's own contract reference: real underlying levels, real expiries,
 * real strike ladders, real lot sizes.
 *
 * This exists because the desk was inventing all four.
 *
 *   - Index levels were literals. universe-210.js carried
 *     `const niftySpot = 25440.00` and `const bankNiftySpot = 52680.00`, while
 *     the exchange file for the same session reported NIFTY at 23,270.60 and
 *     BANKNIFTY at 56,055.75. Wrong by 9.3% and 6.0%, and published as a buy
 *     recommendation with a strike, a premium and a one-tap order link.
 *
 *   - Strikes came from a hand-written step table: under 100 step 2.5, under
 *     250 step 5, under 500 step 10, and so on. NSE does not space strikes that
 *     way uniformly, and a strike the exchange does not list cannot be traded
 *     at any price.
 *
 * Everything here is read from the NSE F&O bhavcopy and cached to disk, so the
 * synchronous scanner path can consult it without a network call.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fetchBhavcopy } = require("./bhavcopy");

const CACHE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private", "cache", "fno"));
const REFERENCE_FILE = path.join(CACHE_DIR, "contract-reference.json");

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function normaliseDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

/** Compact the bhavcopy into the reference the scanner needs. */
function buildReference(rows, session) {
  const symbols = {};
  for (const row of rows || []) {
    const type = row.FinInstrmTp;
    const isOption = type === "STO" || type === "IDO";
    const isFuture = type === "STF" || type === "IDF";
    if (!isOption && !isFuture) continue;
    const symbol = row.TckrSymb;
    const expiry = normaliseDate(row.XpryDt);
    const underlying = num(row.UndrlygPric);
    if (!symbol || !expiry) continue;

    if (!symbols[symbol]) {
      symbols[symbol] = {
        symbol,
        isIndex: type === "IDO" || type === "IDF",
        underlyingPrice: null,
        lotSize: null,
        expiries: {}
      };
    }
    const entry = symbols[symbol];
    if (underlying > 0) entry.underlyingPrice = underlying;
    const lot = num(row.NewBrdLotQty);
    // Lot size is a property of the CONTRACT, not the symbol: it can differ by
    // expiry and NSE revises it. Keeping one value per symbol overwrote it with
    // whichever row happened to come last.
    if (lot > 0) entry.lotSize = lot;

    if (!entry.expiries[expiry]) {
      entry.expiries[expiry] = { expiry, futuresPrice: null, lotSize: null, callStrikes: [], putStrikes: [], liveStrikes: [] };
    }
    const bucket = entry.expiries[expiry];
    if (lot > 0) bucket.lotSize = lot;

    if (isFuture) {
      const price = num(row.SttlmPric) ?? num(row.ClsPric);
      if (price > 0) bucket.futuresPrice = price;
      continue;
    }

    const strike = num(row.StrkPric);
    if (!(strike > 0)) continue;
    const optionType = row.OptnTp;
    const volume = num(row.TtlTradgVol) || 0;
    const openInterest = num(row.OpnIntrst) || 0;
    if (optionType === "CE") bucket.callStrikes.push(strike);
    else if (optionType === "PE") bucket.putStrikes.push(strike);

    // The price the market actually paid. A Black-Scholes value is what a
    // contract SHOULD be worth under a model; this is what it DID trade at, and
    // it is the number a broker screen will show. Both are kept so a consumer
    // can see the difference, but the traded price is the one to quote.
    const traded = num(row.LastPric) ?? num(row.ClsPric) ?? num(row.SttlmPric);
    if (traded !== null && traded >= 0) {
      bucket.quotes = bucket.quotes || {};
      bucket.quotes[`${strike}|${optionType}`] = {
        price: traded,
        settle: num(row.SttlmPric),
        close: num(row.ClsPric),
        open: num(row.OpnPric),
        high: num(row.HghPric),
        low: num(row.LwPric),
        volume,
        openInterest,
        // A contract with no volume and no open interest has no market price,
        // only an exchange-constructed settlement figure.
        traded: volume > 0 || openInterest > 0
      };
    }
    // A strike with neither volume nor open interest is listed but dead; it is
    // recorded separately so the scanner can prefer strikes that actually trade.
    if (volume > 0 || openInterest > 0) bucket.liveStrikes.push(strike);
  }

  for (const entry of Object.values(symbols)) {
    for (const bucket of Object.values(entry.expiries)) {
      bucket.callStrikes = [...new Set(bucket.callStrikes)].sort((a, b) => a - b);
      bucket.putStrikes = [...new Set(bucket.putStrikes)].sort((a, b) => a - b);
      bucket.liveStrikes = [...new Set(bucket.liveStrikes)].sort((a, b) => a - b);
      bucket.quotes = bucket.quotes || {};
    }
    entry.expiryList = Object.keys(entry.expiries).sort();
    entry.frontExpiry = entry.expiryList[0] || null;
  }
  return { session: normaliseDate(session), symbolCount: Object.keys(symbols).length, symbols };
}

let memo = null;

/**
 * Fetch the most recent AVAILABLE session and write the reference to disk.
 *
 * This used to ask for exactly one date -- today -- and give up on a 404. NSE
 * publishes the bhavcopy only AFTER the close, so during every live session
 * today's file does not exist yet, and on a host with no cached copy the desk
 * spent the entire trading day with no strikes, no lot sizes and no settled
 * prices. Every card read null. The one date guaranteed to fail is the one it
 * was asking for.
 *
 * So it walks back instead: today first, in case the close has passed, then the
 * previous sessions. Weekends and holidays simply 404 and are skipped. Strikes
 * and lot sizes do not change intraday, so the previous session's contract file
 * is the correct reference for today's trading -- and the session it came from
 * travels with it, so nothing can mistake it for today's settlement.
 */
async function refreshReference(date = new Date(), { maxLookbackDays = 7 } = {}) {
  const start = date instanceof Date ? date : new Date(date);
  const attempts = [];
  for (let back = 0; back <= maxLookbackDays; back += 1) {
    const day = new Date(start.getTime() - back * 86400000);
    try {
      const payload = await fetchBhavcopy(day);
      const reference = buildReference(payload.rows, payload.tradeDate);
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(REFERENCE_FILE, JSON.stringify(reference));
      memo = null;
      return reference;
    } catch (error) {
      attempts.push(`${day.toISOString().slice(0, 10)}: ${error.message}`);
    }
  }
  const failure = new Error(`no bhavcopy in the last ${maxLookbackDays} days -- ${attempts.slice(0, 3).join("; ")}`);
  failure.attempts = attempts;
  throw failure;
}

/** Synchronous read for the scanner path. Returns null when never refreshed. */
function loadReference({ force = false } = {}) {
  if (memo && !force) return memo;
  if (!fs.existsSync(REFERENCE_FILE)) return null;
  try {
    memo = JSON.parse(fs.readFileSync(REFERENCE_FILE, "utf8"));
    return memo;
  } catch (error) {
    return null;
  }
}

/** The exchange's underlying price, or null. Never a literal. */
function underlyingPrice(symbol, reference = loadReference()) {
  const entry = reference?.symbols?.[symbol];
  return entry && entry.underlyingPrice > 0 ? entry.underlyingPrice : null;
}

/**
 * The nearest listed strike at or around a reference price, taken from the
 * strikes the exchange actually lists. Prefers strikes that traded.
 */
function nearestListedStrike(symbol, price, { expiry = null, optionType = "CE", requireLive = true, reference = loadReference() } = {}) {
  const entry = reference?.symbols?.[symbol];
  if (!entry || !(price > 0)) return null;
  const chosenExpiry = expiry || entry.frontExpiry;
  const bucket = entry.expiries?.[chosenExpiry];
  if (!bucket) return null;
  const listed = optionType === "PE" ? bucket.putStrikes : bucket.callStrikes;
  const pool = requireLive && bucket.liveStrikes.length
    ? listed.filter((strike) => bucket.liveStrikes.includes(strike))
    : listed;
  if (!pool.length) return null;
  let best = pool[0];
  for (const strike of pool) {
    if (Math.abs(strike - price) < Math.abs(best - price)) best = strike;
  }
  return { strike: best, expiry: chosenExpiry, listedCount: pool.length, lotSize: bucket.lotSize || entry.lotSize };
}

/**
 * The exchange's own NFO trading symbol suffix for an expiry.
 *
 * WHY THIS EXISTS. The desk built every option and future symbol by pasting a
 * HARD-CODED "26SEP" onto the strike. That is not a label, it is a guess, and on
 * 2026-09-21 it was wrong on the contract the desk was loudest about: NIFTY's
 * front listed expiry is 2026-09-22, a WEEKLY, and the card called it
 * NIFTY26SEP23400CE, which a broker resolves to the 29-Sep monthly. The premium
 * came from one contract and the order link pointed at another. It would also
 * have silently become wrong for all 210 names on 1 October.
 *
 * NSE and Zerodha use two different shapes, and which one applies depends on
 * whether the expiry is the last one listed in its own calendar month:
 *
 *   MONTHLY   SYMBOL + YY + MMM        NIFTY + 26 + SEP + 23400 + CE
 *   WEEKLY    SYMBOL + YY + M + DD     NIFTY + 26 + 9 + 22 + 23400 + CE
 *
 * where the weekly month is a single character: 1-9 for January to September,
 * then O, N and D, because 10, 11 and 12 would not fit in one place.
 */
const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKLY_MONTH_CODES = "123456789OND";

function expiryTradingSuffix(expiryIso, expiryList = []) {
  const iso = String(expiryIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const year = Number(iso.slice(0, 4));
  const monthIndex = Number(iso.slice(5, 7)) - 1;
  const day = Number(iso.slice(8, 10));
  if (!(monthIndex >= 0 && monthIndex <= 11)) return null;
  const yy = String(year % 100).padStart(2, "0");

  // Monthly means "the last expiry listed in this calendar month", which is a
  // fact about the exchange's calendar, not about the day of the week. NSE has
  // already moved this weekday once; reading it from the listed set survives the
  // next move without a code change.
  const sameMonth = (Array.isArray(expiryList) ? expiryList : [])
    .map((value) => String(value).slice(0, 10))
    .filter((value) => value.slice(0, 7) === iso.slice(0, 7))
    .sort();
  const isMonthly = sameMonth.length === 0 || sameMonth[sameMonth.length - 1] === iso;

  if (isMonthly) return `${yy}${MONTH_NAMES[monthIndex]}`;
  return `${yy}${WEEKLY_MONTH_CODES[monthIndex]}${String(day).padStart(2, "0")}`;
}

/**
 * THE SAME CONTRACT HAS A DIFFERENT NAME AT EVERY BROKER.
 *
 * The desk emitted exactly one symbol and used it for every link. It happened to
 * be Zerodha's monthly form. Pasted into Angel One -- which is the broker this
 * desk actually fetches its live quotes from -- it finds nothing, because Angel
 * puts the DAY first and the year last:
 *
 *   ZERODHA    SYMBOL + YY + MMM + STRIKE + CE/PE     ASIANPAINT26SEP2460CE
 *   ANGEL ONE  SYMBOL + DD + MMM + YY + STRIKE + CE/PE  ASIANPAINT29SEP262460CE
 *
 * Both name the 29 September 2026 2460 call. Neither is wrong; showing only one
 * of them and calling it "the trading symbol" is. The Angel form is verified
 * against the instrument master the desk already downloads -- see
 * scripts/test-contract-identity.js, which asserts this function reproduces
 * every cached contract's symbol exactly rather than trusting the format.
 */
function angelTradingSymbol(symbol, expiryIso, strike = null, optionType = null) {
  const iso = String(expiryIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !symbol) return null;
  const monthIndex = Number(iso.slice(5, 7)) - 1;
  if (!(monthIndex >= 0 && monthIndex <= 11)) return null;
  const head = `${symbol}${iso.slice(8, 10)}${MONTH_NAMES[monthIndex]}${iso.slice(2, 4)}`;
  if (strike === null || optionType === null) return `${head}FUT`;
  // Strikes print without a trailing ".0"; a 2460 call is 2460CE, and a 2462.5
  // call is 2462.5CE.
  const strikeText = Number.isInteger(Number(strike)) ? String(Number(strike)) : String(Number(strike));
  return `${head}${strikeText}${optionType}`;
}

/**
 * The nearest listed expiry that still has enough life left to hold the trade.
 *
 * The front contract is not automatically the right one. On 2026-09-21 NIFTY's
 * front expiry was the next day's weekly, while the card it fed said "Day 1 of
 * 5" and carried a +2.5% and +5.0% target ladder. A contract that expires
 * tomorrow cannot carry a five-session plan, and pricing one is not a smaller
 * version of the right answer -- it is a different trade.
 */
function tradableExpiry(symbol, { minDays = 0, reference = loadReference(), now = Date.now() } = {}) {
  const entry = reference?.symbols?.[symbol];
  if (!entry) return null;
  const list = (Array.isArray(entry.expiryList) ? entry.expiryList : [])
    .map((value) => String(value).slice(0, 10))
    .filter((value) => entry.expiries?.[value])
    .sort();
  if (!list.length) return null;
  const chosen = list.find((value) => (Date.parse(`${value}T15:30:00+05:30`) - now) / 86400000 >= minDays);
  const expiry = chosen || list[list.length - 1];
  const days = (Date.parse(`${expiry}T15:30:00+05:30`) - now) / 86400000;
  return {
    expiry,
    days,
    isFrontExpiry: expiry === entry.frontExpiry,
    skippedFront: Boolean(chosen) && chosen !== list[0],
    suffix: expiryTradingSuffix(expiry, list),
    expiryList: list
  };
}

/** The next listed strike above (or below) a given one, for the short wing. */
function adjacentListedStrike(symbol, strike, direction = 1, { expiry = null, optionType = "CE", requireLive = true, reference = loadReference() } = {}) {
  const entry = reference?.symbols?.[symbol];
  if (!entry) return null;
  const chosenExpiry = expiry || entry.frontExpiry;
  const bucket = entry.expiries?.[chosenExpiry];
  if (!bucket) return null;
  const listed = optionType === "PE" ? bucket.putStrikes : bucket.callStrikes;
  const pool = requireLive && bucket.liveStrikes.length
    ? listed.filter((value) => bucket.liveStrikes.includes(value))
    : listed;
  const ordered = direction >= 0
    ? pool.filter((value) => value > strike).sort((a, b) => a - b)
    : pool.filter((value) => value < strike).sort((a, b) => b - a);
  return ordered.length ? { strike: ordered[0], expiry: chosenExpiry } : null;
}

/**
 * The exchange's own traded price for one contract, or null.
 * Returns traded:false when the strike is listed but nothing changed hands, so a
 * caller can refuse to quote a price nobody paid.
 */
function tradedQuote(symbol, strike, optionType, expiry = null, reference = loadReference()) {
  const entry = reference?.symbols?.[symbol];
  if (!entry) return null;
  const chosenExpiry = expiry || entry.frontExpiry;
  const bucket = entry.expiries?.[chosenExpiry];
  if (!bucket || !bucket.quotes) return null;
  const quote = bucket.quotes[`${Number(strike)}|${optionType}`];
  return quote ? { ...quote, expiry: chosenExpiry, lotSize: bucket.lotSize || entry.lotSize } : null;
}

/** Is this exact contract listed by the exchange? */
function isListed(symbol, strike, optionType, expiry = null, reference = loadReference()) {
  const entry = reference?.symbols?.[symbol];
  if (!entry) return false;
  const chosenExpiry = expiry || entry.frontExpiry;
  const bucket = entry.expiries?.[chosenExpiry];
  if (!bucket) return false;
  const listed = optionType === "PE" ? bucket.putStrikes : bucket.callStrikes;
  return listed.includes(Number(strike));
}

/**
 * The forward the OPTIONS themselves imply, with no model and no futures quote.
 *
 * Put-call parity is an identity, not a theory: F = K + (C - P)e^(rT). Given a
 * call and a put on the same strike and expiry, it returns the forward the
 * market is actually using, and it agrees with the listed future to within
 * 0.00-0.27% on every name tested.
 *
 * This matters where NO matching future exists. NIFTY options expire WEEKLY
 * while index futures are MONTHLY, so a 22-Sep option has no 22-Sep future to
 * price against and the desk was falling back to the cash index -- which is the
 * same error, on the instrument where the basis is largest.
 *
 * The median across near-the-money strikes is used rather than a single pair,
 * because one stale quote should not move the answer.
 */
function parityForward(symbol, expiry, { reference = loadReference(), rate = 0.065, now = Date.now() } = {}) {
  const entry = reference?.symbols?.[symbol];
  const bucket = entry?.expiries?.[expiry];
  const spot = underlyingPrice(symbol, reference);
  if (!bucket || !(spot > 0)) return null;

  const years = (Date.parse(`${expiry}T15:30:00+05:30`) - now) / (365 * 86400000);
  if (!(years > 0)) return null;

  const forwards = [];
  for (const strike of bucket.callStrikes || []) {
    // Near the money only: the wings are thin and their quotes are noise.
    if (Math.abs(strike - spot) / spot > 0.03) continue;
    const call = tradedQuote(symbol, strike, "CE", expiry, reference);
    const put = tradedQuote(symbol, strike, "PE", expiry, reference);
    if (!(call?.price > 0) || !(put?.price > 0)) continue;
    forwards.push(strike + (call.price - put.price) * Math.exp(rate * years));
  }
  if (forwards.length < 2) return null;
  forwards.sort((a, b) => a - b);
  const median = forwards[Math.floor(forwards.length / 2)];
  // A forward wildly away from spot means the quotes were not a coherent pair.
  if (!(median > 0) || Math.abs(median - spot) / spot > 0.15) return null;
  return { price: Math.round(median * 100) / 100, pairs: forwards.length };
}

module.exports = {
  parityForward,
  angelTradingSymbol,
  expiryTradingSuffix,
  tradableExpiry,
  CACHE_DIR,
  REFERENCE_FILE,
  adjacentListedStrike,
  buildReference,
  isListed,
  loadReference,
  nearestListedStrike,
  refreshReference,
  tradedQuote,
  underlyingPrice
};
