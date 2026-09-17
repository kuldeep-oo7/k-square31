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
    // A strike with neither volume nor open interest is listed but dead; it is
    // recorded separately so the scanner can prefer strikes that actually trade.
    if (volume > 0 || openInterest > 0) bucket.liveStrikes.push(strike);
  }

  for (const entry of Object.values(symbols)) {
    for (const bucket of Object.values(entry.expiries)) {
      bucket.callStrikes = [...new Set(bucket.callStrikes)].sort((a, b) => a - b);
      bucket.putStrikes = [...new Set(bucket.putStrikes)].sort((a, b) => a - b);
      bucket.liveStrikes = [...new Set(bucket.liveStrikes)].sort((a, b) => a - b);
    }
    entry.expiryList = Object.keys(entry.expiries).sort();
    entry.frontExpiry = entry.expiryList[0] || null;
  }
  return { session: normaliseDate(session), symbolCount: Object.keys(symbols).length, symbols };
}

/** Fetch the latest session and write the reference to disk. */
async function refreshReference(date = new Date()) {
  const payload = await fetchBhavcopy(date instanceof Date ? date : new Date(date));
  const reference = buildReference(payload.rows, payload.tradeDate);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(REFERENCE_FILE, JSON.stringify(reference));
  return reference;
}

let memo = null;
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

module.exports = {
  CACHE_DIR,
  REFERENCE_FILE,
  adjacentListedStrike,
  buildReference,
  isListed,
  loadReference,
  nearestListedStrike,
  refreshReference,
  underlyingPrice
};
