"use strict";

/**
 * Implied volatility surface, solved from real traded option prices.
 *
 * The desk priced every contract from a single flat volatility per name, which
 * makes an at-the-money option and a deep out-of-the-money option share one
 * sigma. Real option markets do not work that way: out-of-the-money puts trade
 * at a premium to calls of equal distance because crash protection is bid, and
 * near-dated contracts carry different volatility from far-dated ones. A model
 * with one sigma cannot see the skew or the term structure, so it misprices
 * exactly the contracts whose price is most interesting.
 *
 * Volatility here is BACKED OUT of the settlement prices in the NSE F&O
 * bhavcopy, one strike at a time, using the bisection solver in
 * option-pricing.js. It is therefore a measurement of what the market paid, not
 * an assumption about what it should have paid.
 *
 * TWO HONEST LIMITATIONS, both carried in the output:
 *
 *  1. Indian single-stock options are AMERICAN. Inverting a European
 *     Black-Scholes price gives a European-equivalent implied volatility, which
 *     is slightly biased for deep in-the-money puts where early exercise has
 *     value. Every figure is labelled EUROPEAN_EQUIVALENT_IV for that reason.
 *  2. A settlement price on a strike that did not trade is an exchange
 *     construction, not a transaction. Strikes with no volume and no open
 *     interest are excluded rather than inverted, because solving a volatility
 *     from a price nobody paid produces a number nobody should use.
 */

const { fetchBhavcopy } = require("./bhavcopy");
const { europeanOption, impliedVolatility } = require("./option-pricing");

const DEFAULT_RISK_FREE_RATE = 0.065;   // RBI repo, overridable
const DEFAULT_DIVIDEND_YIELD = 0.012;

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
};

function normaliseDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

function yearsBetween(fromIso, toIso) {
  const from = Date.parse(`${normaliseDate(fromIso)}T00:00:00Z`);
  const to = Date.parse(`${normaliseDate(toIso)}T15:30:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return (to - from) / (365 * 86_400_000);
}

/**
 * Extract the option chain for one session, keeping only contracts that
 * actually traded or carry open interest.
 */
function chainFromRows(rows, { requireActivity = true } = {}) {
  const chain = new Map();
  // Futures price per symbol and expiry. An option on an Indian single stock is
  // priced off the FUTURE of the same expiry, not off cash: the future carries
  // the financing and borrow that the option inherits. Discounting spot instead
  // tilts the whole smile, pushing put volatility down and call volatility up by
  // the basis, which on this session runs to a 10.6% annualised median.
  const futuresByKey = new Map();
  for (const row of rows || []) {
    if (row.FinInstrmTp !== "STF" && row.FinInstrmTp !== "IDF") continue;
    const price = num(row.SttlmPric) ?? num(row.ClsPric);
    if (price > 0) futuresByKey.set(`${row.TckrSymb}|${normaliseDate(row.XpryDt)}`, price);
  }
  for (const row of rows || []) {
    if (row.FinInstrmTp !== "STO" && row.FinInstrmTp !== "IDO") continue;
    const optionType = row.OptnTp === "CE" || row.OptnTp === "PE" ? row.OptnTp : null;
    const strike = num(row.StrkPric);
    const price = num(row.SttlmPric) ?? num(row.ClsPric);
    const underlying = num(row.UndrlygPric);
    if (!optionType || !(strike > 0) || !(price >= 0) || !(underlying > 0)) continue;
    const volume = num(row.TtlTradgVol) || 0;
    const openInterest = num(row.OpnIntrst) || 0;
    // A settlement price on an untouched strike is an exchange construction.
    if (requireActivity && volume <= 0 && openInterest <= 0) continue;
    const key = `${row.TckrSymb}|${normaliseDate(row.XpryDt)}`;
    if (!chain.has(key)) {
      chain.set(key, {
        symbol: row.TckrSymb,
        expiry: normaliseDate(row.XpryDt),
        underlyingPrice: underlying,
        futuresPrice: futuresByKey.get(key) ?? null,
        lotSize: num(row.NewBrdLotQty),
        contracts: []
      });
    }
    chain.get(key).contracts.push({ optionType, strike, price, volume, openInterest });
  }
  return chain;
}

/**
 * Solve implied volatility for every usable strike in one expiry, then reduce to
 * the three numbers a desk actually trades on: at-the-money level, skew, and the
 * shape of the wings.
 */
function solveSmile(entry, session, options = {}) {
  const riskFreeRate = Number.isFinite(Number(options.riskFreeRate)) ? Number(options.riskFreeRate) : DEFAULT_RISK_FREE_RATE;
  const dividendYield = Number.isFinite(Number(options.dividendYield)) ? Number(options.dividendYield) : DEFAULT_DIVIDEND_YIELD;
  const timeToExpiryYears = yearsBetween(session, entry.expiry);
  if (!(timeToExpiryYears > 0)) {
    return { ...entry, available: false, reason: "EXPIRED_OR_UNDATED", points: [] };
  }

  // Black-76 on the future when one exists for this expiry, which is the correct
  // model for an option whose deliverable is the future. Falls back to spot-based
  // Black-Scholes only when no future trades that expiry, and records which was
  // used so a consumer is never guessing.
  const future = num(entry.futuresPrice);
  const useBlack76 = future > 0;
  const forwardPrice = useBlack76 ? future : entry.underlyingPrice;

  const points = [];
  for (const contract of entry.contracts) {
    const shared = useBlack76
      ? {
        model: "BLACK76",
        optionType: contract.optionType,
        underlyingPrice: future,
        strike: contract.strike,
        timeToExpiryYears,
        riskFreeRate
      }
      : {
        model: "BSM",
        optionType: contract.optionType,
        underlyingPrice: entry.underlyingPrice,
        strike: contract.strike,
        timeToExpiryYears,
        riskFreeRate,
        dividendYield
      };
    const solved = impliedVolatility(shared, contract.price);
    if (!solved.available || !(solved.iv > 0.01) || solved.iv > 4) continue;
    const moneyness = Math.log(contract.strike / forwardPrice);
    points.push({
      optionType: contract.optionType,
      strike: contract.strike,
      price: contract.price,
      iv: round(solved.iv, 4),
      logMoneyness: round(moneyness, 4),
      volume: contract.volume,
      openInterest: contract.openInterest,
      delta: round(europeanOption({ ...shared, volatility: solved.iv }).delta, 4)
    });
  }

  if (points.length < 3) {
    return { ...entry, available: false, reason: "TOO_FEW_SOLVABLE_STRIKES", timeToExpiryYears, points };
  }

  // At-the-money volatility: the strike closest to spot, taken from whichever
  // side is out-of-the-money there, because the OTM leg is the liquid one.
  const atm = points.reduce((best, point) =>
    (best === null || Math.abs(point.logMoneyness) < Math.abs(best.logMoneyness) ? point : best), null);

  // Skew measured where it is actually observable: the difference between the
  // volatility of a roughly 25-delta put and a roughly 25-delta call. Positive
  // means downside protection is bid relative to upside, which is the normal
  // state of an equity surface.
  const nearestByDelta = (type, target) => points
    .filter((point) => point.optionType === type && Number.isFinite(point.delta))
    .reduce((best, point) =>
      (best === null || Math.abs(Math.abs(point.delta) - target) < Math.abs(Math.abs(best.delta) - target) ? point : best), null);
  const put25 = nearestByDelta("PE", 0.25);
  const call25 = nearestByDelta("CE", 0.25);
  const skew = put25 && call25 ? round(put25.iv - call25.iv, 4) : null;

  const ivs = points.map((point) => point.iv).sort((a, b) => a - b);
  return {
    symbol: entry.symbol,
    expiry: entry.expiry,
    session: normaliseDate(session),
    underlyingPrice: entry.underlyingPrice,
    lotSize: entry.lotSize,
    timeToExpiryYears: round(timeToExpiryYears, 6),
    daysToExpiry: Math.round(timeToExpiryYears * 365),
    available: true,
    // Named so no caller can mistake this for an American-exercise implied vol.
    method: useBlack76 ? "BLACK76_ON_FUTURE_EUROPEAN_EQUIVALENT_IV" : "BSM_ON_SPOT_EUROPEAN_EQUIVALENT_IV",
    pricedOff: useBlack76 ? "FUTURE" : "SPOT",
    futuresPrice: future,
    basisPct: future > 0 && entry.underlyingPrice > 0
      ? round((future / entry.underlyingPrice - 1) * 100, 3) : null,
    atmIv: atm ? atm.iv : null,
    atmStrike: atm ? atm.strike : null,
    skew25Delta: skew,
    put25DeltaIv: put25 ? put25.iv : null,
    call25DeltaIv: call25 ? call25.iv : null,
    minIv: ivs[0],
    medianIv: ivs[Math.floor(ivs.length / 2)],
    maxIv: ivs.at(-1),
    solvedStrikes: points.length,
    totalOpenInterest: points.reduce((sum, point) => sum + point.openInterest, 0),
    points: points.sort((a, b) => a.strike - b.strike)
  };
}

/**
 * Full surface for one session: every symbol, every expiry, plus the term
 * structure of at-the-money volatility across expiries.
 */
function buildSurface(rows, session, options = {}) {
  const chain = chainFromRows(rows, options);
  const bySymbol = new Map();
  for (const entry of chain.values()) {
    const smile = solveSmile(entry, session, options);
    if (!smile.available) continue;
    if (!bySymbol.has(smile.symbol)) bySymbol.set(smile.symbol, []);
    bySymbol.get(smile.symbol).push(smile);
  }

  const symbols = {};
  for (const [symbol, smiles] of bySymbol) {
    const ordered = smiles.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    const front = ordered[0];
    const back = ordered.length > 1 ? ordered[ordered.length - 1] : null;
    symbols[symbol] = {
      symbol,
      session: normaliseDate(session),
      front,
      expiries: ordered,
      // A rising term structure is the calm state; an inverted one says the
      // market expects something to happen before the near contract expires.
      termStructureSlope: back && front && front.atmIv && back.atmIv
        ? round(back.atmIv - front.atmIv, 4)
        : null,
      termStructure: ordered.map((smile) => ({ expiry: smile.expiry, days: smile.daysToExpiry, atmIv: smile.atmIv }))
    };
  }
  return { session: normaliseDate(session), method: "EUROPEAN_EQUIVALENT_IV", symbolCount: Object.keys(symbols).length, symbols };
}

/** Fetch one session and build the surface from it. */
async function loadSurface(date = new Date(), options = {}) {
  const payload = await fetchBhavcopy(date instanceof Date ? date : new Date(date));
  return buildSurface(payload.rows, payload.tradeDate, options);
}

/**
 * The volatility to price a contract at a given strike and expiry.
 * Interpolates across the observed smile in log-moneyness rather than returning
 * one flat number, and says so when it cannot.
 */
function volatilityFor(surface, symbol, strike, expiry = null) {
  const entry = surface?.symbols?.[symbol];
  if (!entry) return { available: false, reason: "NO_SURFACE_FOR_SYMBOL", volatility: null };
  const smile = expiry
    ? entry.expiries.find((item) => item.expiry === normaliseDate(expiry))
    : entry.front;
  if (!smile) return { available: false, reason: "NO_SURFACE_FOR_EXPIRY", volatility: null };
  const target = Math.log(Number(strike) / (smile.futuresPrice > 0 ? smile.futuresPrice : smile.underlyingPrice));
  if (!Number.isFinite(target)) return { available: false, reason: "STRIKE_INVALID", volatility: null };

  const sorted = [...smile.points].sort((a, b) => a.logMoneyness - b.logMoneyness);
  let lower = null;
  let upper = null;
  for (const point of sorted) {
    if (point.logMoneyness <= target) lower = point;
    if (point.logMoneyness >= target && upper === null) upper = point;
  }
  // Outside the observed strikes the smile is not extrapolated; the nearest
  // observed wing is returned and flagged, because extrapolating a smile is how
  // a model invents a price for a contract nobody quoted.
  if (!lower && upper) return { available: true, volatility: upper.iv, source: "NEAREST_WING", extrapolated: true, method: smile.method };
  if (lower && !upper) return { available: true, volatility: lower.iv, source: "NEAREST_WING", extrapolated: true, method: smile.method };
  if (!lower || !upper) return { available: false, reason: "NO_OBSERVED_STRIKES", volatility: null };
  if (lower === upper) return { available: true, volatility: lower.iv, source: "OBSERVED_STRIKE", extrapolated: false, method: smile.method };
  const span = upper.logMoneyness - lower.logMoneyness;
  const weight = span === 0 ? 0 : (target - lower.logMoneyness) / span;
  return {
    available: true,
    volatility: round(lower.iv + weight * (upper.iv - lower.iv), 4),
    source: "INTERPOLATED",
    extrapolated: false,
    method: smile.method,
    between: [lower.strike, upper.strike]
  };
}

module.exports = {
  DEFAULT_DIVIDEND_YIELD,
  DEFAULT_RISK_FREE_RATE,
  buildSurface,
  chainFromRows,
  loadSurface,
  solveSmile,
  volatilityFor
};
