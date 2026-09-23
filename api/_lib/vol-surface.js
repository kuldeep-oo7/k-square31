"use strict";

/**
 * THE SHAPE OF THE VOLATILITY SURFACE, which the desk has never once looked at.
 *
 * Until now every volatility judgement here was a single number: the implied
 * volatility of one contract against the underlying's realised volatility. That
 * is one point on a surface that has two more dimensions, and both of them carry
 * information this desk was throwing away.
 *
 * TERM STRUCTURE -- the same strike, different expiries.
 *   In a quiet market the far month trades ABOVE the near month, because more
 *   time means more that can happen. When that inverts and the FRONT month is
 *   dearer, the market is pricing something it expects to happen soon: an
 *   earnings date, a policy meeting, a verdict. You do not need an events
 *   calendar to find those -- the option chain has already been told.
 *
 * SKEW -- the same expiry, different strikes.
 *   Puts almost always cost more than equidistant calls, because the people who
 *   need insurance are long the market. How MUCH more is the market's own
 *   measure of downside fear, and it moves. A call bought into unusually flat
 *   skew is being bought from a market that sees no danger.
 *
 * Both are computable from the contract file already on disk. Neither needs a
 * single new data source, and neither has ever been read.
 */

const { loadReference } = require("./fno-reference");
const { europeanOption, impliedVolatility } = require("./option-pricing");

const RISK_FREE = 0.065;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
}

/** Solve implied volatility for one listed strike, or null if it will not solve. */
function ivAt(bucket, forward, strike, optionType, years) {
  const quote = bucket.quotes?.[`${strike}|${optionType}`];
  const premium = Number(quote?.price);
  if (!(premium > 0) || !(forward > 0) || !(years > 0)) return null;
  // Refuse settlement artefacts: NSE derives a price for contracts that did not
  // trade, and some come out below intrinsic, where no volatility exists.
  const intrinsic = optionType === "CE" ? Math.max(0, forward - strike) : Math.max(0, strike - forward);
  if (premium < intrinsic) return null;
  const solved = impliedVolatility({
    underlyingPrice: forward, strike, timeToExpiryYears: years,
    riskFreeRate: RISK_FREE, dividendYield: 0, optionType,
    // A futures price is priced with Black-76; only a spot price takes BSM.
    model: Number(bucket.futuresPrice) > 0 ? "BLACK76" : "BSM"
  }, premium);
  const iv = Number(solved?.iv);
  return iv > 0.03 && iv < 3 ? iv : null;
}

/** The at-the-money implied volatility for one expiry, averaged over call and put. */
function atmIv(bucket, forward, years) {
  const strikes = bucket.callStrikes || [];
  if (!strikes.length || !(forward > 0)) return null;
  let atm = strikes[0];
  for (const strike of strikes) if (Math.abs(strike - forward) < Math.abs(atm - forward)) atm = strike;
  const call = ivAt(bucket, forward, atm, "CE", years);
  const put = ivAt(bucket, forward, atm, "PE", years);
  const both = [call, put].filter((v) => v > 0);
  return both.length ? { iv: both.reduce((a, b) => a + b, 0) / both.length, strike: atm, legs: both.length } : null;
}

/**
 * The strike whose delta is closest to a target, on the correct side.
 *
 * 25-delta is the market's convention for "meaningfully out of the money but
 * still traded", and comparing the put and call at that delta is how skew is
 * quoted everywhere. Picking by delta rather than by distance matters: a fixed
 * percentage away from spot is a different amount of risk on a quiet stock than
 * on a wild one, which would make skew incomparable between names.
 */
function strikeAtDelta(bucket, forward, years, optionType, targetDelta = 0.25) {
  const strikes = (optionType === "CE" ? bucket.callStrikes : bucket.putStrikes) || [];
  let best = null;
  for (const strike of strikes) {
    const iv = ivAt(bucket, forward, strike, optionType, years);
    if (!(iv > 0)) continue;
    const greeks = europeanOption({
      underlyingPrice: forward, strike, timeToExpiryYears: years,
      riskFreeRate: RISK_FREE, dividendYield: 0, volatility: iv, optionType,
      model: Number(bucket.futuresPrice) > 0 ? "BLACK76" : "BSM"
    });
    const delta = Math.abs(Number(greeks?.delta));
    if (!Number.isFinite(delta)) continue;
    const gap = Math.abs(delta - targetDelta);
    if (!best || gap < best.gap) best = { strike, iv, delta: round(delta, 3), gap };
  }
  return best && best.gap < 0.12 ? best : null;
}

/**
 * Term structure and skew for one underlying.
 *
 * `now` is injected so this is testable against a fixed clock rather than
 * whenever the suite happens to run.
 */
function surfaceFor(symbol, { reference = loadReference(), now = Date.now() } = {}) {
  const entry = reference?.symbols?.[symbol];
  if (!entry) return { ok: false, reason: "SYMBOL_NOT_IN_CONTRACT_FILE" };

  const expiries = (entry.expiryList || [])
    .map((iso) => ({ iso, days: (Date.parse(`${iso}T15:30:00+05:30`) - now) / 86400000 }))
    .filter((e) => e.days > 0 && entry.expiries[e.iso])
    .sort((a, b) => a.days - b.days);
  if (!expiries.length) return { ok: false, reason: "NO_LIVE_EXPIRY" };

  const readExpiry = (e) => {
    const bucket = entry.expiries[e.iso];
    const forward = Number(bucket.futuresPrice) > 0 ? Number(bucket.futuresPrice) : Number(entry.underlyingPrice);
    const years = e.days / 365;
    const atm = atmIv(bucket, forward, years);
    return atm ? { expiry: e.iso, days: round(e.days, 1), forward: round(forward, 2), atmIv: round(atm.iv, 4), atmStrike: atm.strike, bucket, years } : null;
  };

  const front = readExpiry(expiries[0]);
  const next = expiries.length > 1 ? readExpiry(expiries[1]) : null;

  // --- TERM STRUCTURE ------------------------------------------------------
  let term = { available: false, reason: "NEEDS_TWO_PRICEABLE_EXPIRIES" };
  if (front && next) {
    const slope = (next.atmIv - front.atmIv) / front.atmIv;
    term = {
      available: true,
      frontExpiry: front.expiry, frontDays: front.days, frontAtmIvPct: round(front.atmIv * 100, 2),
      nextExpiry: next.expiry, nextDays: next.days, nextAtmIvPct: round(next.atmIv * 100, 2),
      slopePct: round(slope * 100, 2),
      shape: slope < -0.05 ? "BACKWARDATION" : slope > 0.05 ? "CONTANGO" : "FLAT",
      // The reading that changes a decision, said in words rather than left to
      // be inferred from a sign.
      meaning: slope < -0.05
        ? "The front month is dearer than the next. The market is pricing something it expects SOON -- "
          + "results, a policy date, a verdict. Buying the front month here is paying for that event, "
          + "and the premium usually collapses once it passes whichever way it goes."
        : slope > 0.05
          ? "The far month is dearer, which is the ordinary shape. Nothing unusual is priced into the front."
          : "Flat. The market sees no more risk in the next month than in this one."
    };
  }

  // --- SKEW ----------------------------------------------------------------
  let skew = { available: false, reason: "NEEDS_A_PRICEABLE_FRONT_EXPIRY" };
  if (front) {
    const put25 = strikeAtDelta(front.bucket, front.forward, front.years, "PE", 0.25);
    const call25 = strikeAtDelta(front.bucket, front.forward, front.years, "CE", 0.25);
    if (put25 && call25) {
      const points = (put25.iv - call25.iv) * 100;
      skew = {
        available: true,
        expiry: front.expiry,
        putStrike: put25.strike, putIvPct: round(put25.iv * 100, 2), putDelta: put25.delta,
        callStrike: call25.strike, callIvPct: round(call25.iv * 100, 2), callDelta: call25.delta,
        skewPoints: round(points, 2),
        // Positive is the normal state: insurance costs more than lottery tickets.
        shape: points > 3 ? "PUTS_BID" : points < -1 ? "CALLS_BID" : "BALANCED",
        meaning: points > 3
          ? "Puts cost materially more than equidistant calls. The market is paying up for downside "
            + "protection, which is the usual state and is more pronounced when people are frightened."
          : points < -1
            ? "Calls cost more than equidistant puts, which is unusual for equity. It happens into "
              + "takeovers, squeezes and momentum chases -- and it means upside is already expensive."
            : "Puts and calls at 25 delta cost about the same. The market is pricing no particular "
              + "direction into the tails."
      };
    } else {
      skew = { available: false, reason: "NO_TRADED_25_DELTA_PAIR" };
    }
  }

  return {
    ok: true, symbol,
    atmIvPct: front ? round(front.atmIv * 100, 2) : null,
    frontExpiry: front?.expiry || null,
    termStructure: term,
    skew
  };
}

/**
 * How much of the premium decays away while you wait for the target.
 *
 * The desk computes theta on every contract and has never asked the only
 * question that matters about it: if this option is expected to reach its target
 * in 1.5 days, how much of what I paid burns off in those 1.5 days? A contract
 * that decays 12% of its premium before the move is expected to arrive is a
 * materially worse trade than one that decays 2%, and the desk ranked them the
 * same.
 */
function thetaBurn({ premium, thetaPerDay, daysToTarget, daysToExpiry }) {
  const p = Number(premium), th = Math.abs(Number(thetaPerDay));
  const wait = Number.isFinite(Number(daysToTarget)) && Number(daysToTarget) > 0
    ? Number(daysToTarget)
    : Number(daysToExpiry);
  if (!(p > 0) || !(th >= 0) || !(wait > 0)) return null;
  const burned = th * wait;
  return {
    daysWaited: round(wait, 2),
    premiumBurned: round(burned, 2),
    burnPctOfPremium: round((100 * burned) / p, 2),
    // Theta is not linear: it accelerates into expiry, so a burn measured at
    // today's rate UNDERSTATES what a contract in its last week will actually
    // lose. Said rather than silently ignored.
    understatedNearExpiry: Number(daysToExpiry) < 10
  };
}

module.exports = { surfaceFor, atmIv, strikeAtDelta, thetaBurn, ivAt };
