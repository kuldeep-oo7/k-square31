"use strict";

/**
 * Real F&O liquidity, capacity and basis, from the NSE bhavcopy.
 *
 * The desk previously had no liquidity model at all. Amihud was computed from
 * cash bars and gated nothing, there was no open-interest or volume filter, and
 * no answer to "how much size can this take before it stops working" -- which is
 * the first question any desk asks and the one that decides whether a backtested
 * edge survives contact with a real order.
 *
 * Everything here comes from the NSE F&O bhavcopy, which carries the traded
 * contract rather than a proxy for it:
 *
 *   OpnIntrst      open interest, in units
 *   TtlTradgVol    contracts traded
 *   TtlTrfVal      turnover in rupees
 *   SttlmPric      settlement price of the actual future
 *   UndrlygPric    the cash underlying on the same session
 *   NewBrdLotQty   the real lot size
 *
 * so basis, roll and capacity are measured on the instrument that would be
 * traded, not inferred from equity cash bars.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fetchBhavcopy, latestBhavcopy } = require("./bhavcopy");

const CACHE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private", "cache", "fno"));

// A resting order is assumed to be able to take this share of a session's
// turnover without moving the price against itself. 10% of ADV is the
// conventional ceiling for a participation-rate order and is deliberately
// generous; anything above it is not a capacity estimate, it is a hope.
const PARTICIPATION_CAP = 0.10;

// Below these a name is not tradeable at institutional size on this desk.
const DEFAULT_THRESHOLDS = Object.freeze({
  minAverageDailyTurnoverInr: 50_000_000,   // Rs 5 crore of futures turnover
  minOpenInterestInr: 250_000_000,          // Rs 25 crore of open interest
  minSessionsObserved: 5,
  maxBasisAnnualisedPct: 40                 // beyond this the quote is stale or broken
});

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** One session of F&O data, cached on disk because each fetch is a multi-MB zip. */
async function sessionRows(date) {
  ensureCacheDir();
  const stamp = date.toISOString().slice(0, 10);
  const file = path.join(CACHE_DIR, `fo-${stamp}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { /* refetch */ }
  }
  const payload = await fetchBhavcopy(date);
  // Only the stock-futures rows are retained; the option chain is fetched
  // separately by the surface builder and would otherwise dominate the cache.
  const futures = (payload.rows || [])
    .filter((row) => row.FinInstrmTp === "STF")
    .map((row) => ({
      symbol: row.TckrSymb,
      expiry: row.XpryDt,
      close: num(row.ClsPric),
      settle: num(row.SttlmPric),
      underlying: num(row.UndrlygPric),
      openInterest: num(row.OpnIntrst),
      changeInOpenInterest: num(row.ChngInOpnIntrst),
      contracts: num(row.TtlTradgVol),
      turnoverInr: num(row.TtlTrfVal),
      trades: num(row.TtlNbOfTxsExctd),
      lotSize: num(row.NewBrdLotQty),
      session: row.TradDt
    }));
  const record = { session: normaliseDate(payload.tradeDate) || payload.tradeDate, futures };
  fs.writeFileSync(file, JSON.stringify(record));
  return record;
}

/** Walk back from `from`, collecting `sessions` real trading sessions. */
async function recentSessions(sessions = 20, from = new Date()) {
  const collected = [];
  const cursor = new Date(from);
  let attempts = 0;
  while (collected.length < sessions && attempts < sessions * 3) {
    attempts += 1;
    try {
      collected.push(await sessionRows(new Date(cursor)));
    } catch (error) { /* weekend, holiday, or not yet published */ }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return collected;
}

/**
 * Annualised basis between a future and its cash underlying.
 * A future trading above spot is carrying positive cost-of-carry; a large
 * negative basis usually means borrow cost or a dividend the cash price has not
 * yet dropped. Either way a futures strategy earns or pays it and a backtest run
 * on cash bars silently ignores it.
 */
function annualisedBasisPct(futurePrice, underlyingPrice, daysToExpiry) {
  const future = num(futurePrice);
  const spot = num(underlyingPrice);
  const days = num(daysToExpiry);
  if (!(future > 0) || !(spot > 0) || !(days > 0)) return null;
  return round(((future / spot) - 1) * (365 / days) * 100, 3);
}

/**
 * The bhavcopy carries dates as both 2026-09-17 and 20260917 depending on which
 * field they came from. Normalising here is what makes the basis computable at
 * all: an unparsed date silently produced null days-to-expiry, and every basis
 * on the desk came back null without anything reporting a failure.
 */
function normaliseDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

function daysBetween(fromValue, toValue) {
  const fromIso = normaliseDate(fromValue);
  const toIso = normaliseDate(toValue);
  if (!fromIso || !toIso) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.round((to - from) / 86_400_000) : null;
}

/**
 * Per-symbol liquidity, capacity and basis over the observed sessions.
 *
 * Capacity is expressed in rupees and in lots, because a number that is not in
 * lots cannot be traded: the front-month contract is indivisible.
 */
function buildLiquidityProfile(sessions, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options };
  const ordered = [...sessions].filter(Boolean).sort((a, b) => String(b.session).localeCompare(String(a.session)));
  if (!ordered.length) return { asOf: null, sessionsObserved: 0, symbols: {} };
  const latest = ordered[0];
  const bySymbol = new Map();

  for (const session of ordered) {
    const frontBySymbol = new Map();
    for (const row of session.futures || []) {
      if (!row.symbol || !row.expiry) continue;
      const existing = frontBySymbol.get(row.symbol);
      // The front month is the nearest expiry that has not passed.
      if (!existing || row.expiry < existing.expiry) frontBySymbol.set(row.symbol, row);
    }
    for (const [symbol, row] of frontBySymbol) {
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, { turnovers: [], contracts: [], rows: [] });
      const bucket = bySymbol.get(symbol);
      if (row.turnoverInr > 0) bucket.turnovers.push(row.turnoverInr);
      if (row.contracts > 0) bucket.contracts.push(row.contracts);
      bucket.rows.push(row);
    }
  }

  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const symbols = {};
  for (const [symbol, bucket] of bySymbol) {
    const front = bucket.rows[0];
    const averageTurnover = mean(bucket.turnovers);
    const averageContracts = mean(bucket.contracts);
    const openInterestInr = front.openInterest > 0 && front.settle > 0
      ? front.openInterest * front.settle
      : null;
    const daysToExpiry = daysBetween(latest.session, front.expiry);
    const basis = annualisedBasisPct(front.settle ?? front.close, front.underlying, daysToExpiry);
    const capacityInr = averageTurnover > 0 ? averageTurnover * PARTICIPATION_CAP : null;
    const notionalPerLot = front.settle > 0 && front.lotSize > 0 ? front.settle * front.lotSize : null;
    const capacityLots = capacityInr !== null && notionalPerLot > 0
      ? Math.floor(capacityInr / notionalPerLot)
      : null;

    const reasons = [];
    if (bucket.turnovers.length < thresholds.minSessionsObserved) reasons.push("INSUFFICIENT_SESSIONS");
    if (!(averageTurnover >= thresholds.minAverageDailyTurnoverInr)) reasons.push("TURNOVER_BELOW_FLOOR");
    if (!(openInterestInr >= thresholds.minOpenInterestInr)) reasons.push("OPEN_INTEREST_BELOW_FLOOR");
    if (basis !== null && Math.abs(basis) > thresholds.maxBasisAnnualisedPct) reasons.push("BASIS_IMPLAUSIBLE");
    if (capacityLots !== null && capacityLots < 1) reasons.push("CAPACITY_BELOW_ONE_LOT");

    symbols[symbol] = {
      symbol,
      session: normaliseDate(latest.session),
      expiry: front.expiry,
      daysToExpiry,
      futuresPrice: front.settle ?? front.close,
      underlyingPrice: front.underlying,
      basisAnnualisedPct: basis,
      basisPct: front.underlying > 0 ? round(((front.settle ?? front.close) / front.underlying - 1) * 100, 3) : null,
      lotSize: front.lotSize,
      notionalPerLotInr: round(notionalPerLot),
      openInterest: front.openInterest,
      openInterestInr: round(openInterestInr),
      averageDailyTurnoverInr: round(averageTurnover),
      averageDailyContracts: round(averageContracts),
      sessionsObserved: bucket.turnovers.length,
      capacityInr: round(capacityInr),
      capacityLots,
      participationCap: PARTICIPATION_CAP,
      tradeable: reasons.length === 0,
      reasons
    };
  }

  return { asOf: normaliseDate(latest.session), sessionsObserved: ordered.length, thresholds, symbols };
}

/** Convenience: fetch and build in one call. */
async function loadLiquidityProfile({ sessions = 20, from = new Date(), ...thresholds } = {}) {
  const collected = await recentSessions(sessions, from);
  return buildLiquidityProfile(collected, thresholds);
}

/**
 * Admission decision for a proposed position.
 * Returns the number of lots that can actually be worked, which may be fewer
 * than requested and may be zero.
 */
function admitOrder(profile, symbol, requestedLots = 1) {
  const entry = profile?.symbols?.[symbol];
  if (!entry) return { admitted: false, lots: 0, reason: "NO_LIQUIDITY_DATA", symbol };
  if (!entry.tradeable) return { admitted: false, lots: 0, reason: entry.reasons[0], symbol, detail: entry.reasons };
  const lots = Math.max(0, Math.min(Math.floor(requestedLots), entry.capacityLots ?? 0));
  return {
    admitted: lots > 0,
    lots,
    requestedLots: Math.floor(requestedLots),
    cappedByCapacity: lots < Math.floor(requestedLots),
    capacityLots: entry.capacityLots,
    capacityInr: entry.capacityInr,
    notionalInr: entry.notionalPerLotInr === null ? null : round(entry.notionalPerLotInr * lots),
    reason: lots > 0 ? null : "CAPACITY_BELOW_ONE_LOT",
    symbol
  };
}

module.exports = {
  CACHE_DIR,
  normaliseDate,
  DEFAULT_THRESHOLDS,
  PARTICIPATION_CAP,
  admitOrder,
  annualisedBasisPct,
  buildLiquidityProfile,
  loadLiquidityProfile,
  recentSessions,
  sessionRows
};
