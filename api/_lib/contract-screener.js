"use strict";

/**
 * SCREEN THE WHOLE LISTED CHAIN, not one strike per name.
 *
 * The desk built exactly one at-the-money call and one put for each of 210
 * names and called it the options universe. That is 423 contracts out of the
 * 35,313 NSE lists -- 1.2% -- and the strike was chosen by proximity to spot,
 * which is not a selection. It is a default. Nothing about the machinery this
 * project has built was ever pointed at the other 98.8%.
 *
 * This module points it at all of them. Every listed contract is put through
 * the same gates and the survivors are ranked on evidence that was measured,
 * never assumed.
 *
 * WHAT IT WILL NOT DO. It will not promise a profit. There is no arrangement of
 * these equations that removes the risk from buying an option, and any desk that
 * implies otherwise is lying to you at the moment it matters most. What a
 * screener can do is refuse the contracts where the edge is absent or
 * unmeasurable -- and on this data that is the overwhelming majority of them.
 *
 * MEASURED ON THE EXCHANGE FILE, 2026-09-21:
 *     35,313  listed
 *     19,165  actually traded            54.3%
 *     16,747  implied volatility solves  47.4%
 *      6,031  volume >= 100 AND OI >= 500 17.1%
 * The gates below are what turns that into a list a person can act on.
 */

const { loadReference, tradedQuote } = require("./fno-reference");
const { europeanOption, impliedVolatility } = require("./option-pricing");
const { getCachedBars } = require("./bar-cache");
const { yangZhangVol, parkinsonVol, timeToTarget } = require("./trade-odds");
const { roundTripCost, breakevenMovePct } = require("./trade-costs");

const RISK_FREE = 0.065;

/** Hard gates. A contract that fails any of these is not ranked, it is refused. */
const GATES = {
  minDaysToExpiry: 7,      // must outlive the hold the card describes
  maxDaysToExpiry: 60,     // beyond this the premium is mostly time we pay for
  minVolume: 100,          // it traded today, in size somebody else wanted
  minOpenInterest: 500,    // there is a book to get out into
  minPremium: 1.0,         // a 40-paise option cannot be exited at a sane spread
  minDelta: 0.25,          // not a lottery ticket
  maxDelta: 0.75,          // not a stock substitute with option decay attached
  minIv: 0.05,
  maxIv: 2.0
};

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
}

/** Realised volatility of the underlying, matched to the option's own tenor. */
function realisedVolFor(symbol, days, cache) {
  if (cache.has(symbol)) {
    const byTenor = cache.get(symbol);
    const key = Math.max(10, Math.min(60, Math.round(days)));
    if (byTenor.has(key)) return byTenor.get(key);
    const measured = byTenor.get("bars")
      ? (yangZhangVol(byTenor.get("bars"), key) || parkinsonVol(byTenor.get("bars"), key))
      : null;
    byTenor.set(key, measured);
    return measured;
  }
  const cached = getCachedBars(symbol);
  const bars = Array.isArray(cached?.bars) && cached.bars.length >= 20 ? cached.bars : null;
  const byTenor = new Map([["bars", bars]]);
  cache.set(symbol, byTenor);
  if (!bars) return null;
  const key = Math.max(10, Math.min(60, Math.round(days)));
  const measured = yangZhangVol(bars, key) || parkinsonVol(bars, key);
  byTenor.set(key, measured);
  return measured;
}

/**
 * Score one contract on what was actually measured about it.
 *
 * Every term is a number this system computed from market data, and every term
 * is reported alongside the score so the ranking can be argued with rather than
 * taken on faith. Nothing here is fitted or tuned -- there is no out-of-sample
 * evidence to tune against, and inventing weights and calling the result an
 * edge is the thing this project keeps finding and removing.
 */
function scoreContract(row) {
  const parts = {};

  // 1. VARIANCE RISK PREMIUM. The one number that most reliably decides whether
  //    a BOUGHT option was worth buying: what you paid for movement against what
  //    the underlying has actually been delivering. Below 1.0 means implied is
  //    cheaper than realised, which is the side a buyer wants.
  const vrp = row.realisedVol > 0 ? row.impliedVol / row.realisedVol : null;
  parts.varianceRiskPremium = vrp === null ? 50
    : Math.max(0, Math.min(100, 100 - (vrp - 0.7) * 90));

  // 2. PROBABILITY OF TOUCHING THE TARGET before expiry, under the underlying's
  //    own measured volatility and a martingale drift.
  parts.probabilityOfTouch = Number.isFinite(row.touchPct) ? row.touchPct : 40;

  // 3. LIQUIDITY. Can this be exited? Volume and open interest, on a log scale
  //    because the difference between 100 and 1,000 lots matters far more than
  //    between 50,000 and 51,000.
  const depth = Math.log10(Math.max(10, row.volume)) + Math.log10(Math.max(10, row.openInterest));
  parts.liquidity = Math.max(0, Math.min(100, (depth - 3) * 22));

  // 4. MONEYNESS. Delta near 0.45 to 0.55 buys the most convexity per rupee;
  //    the gates already removed the extremes, this shades within them.
  parts.moneyness = Math.max(0, 100 - Math.abs(Math.abs(row.delta) - 0.5) * 300);

  // 5. TIME. Enough runway for the move, without paying for months of it.
  parts.tenor = row.daysToExpiry >= 12 && row.daysToExpiry <= 35
    ? 100
    : Math.max(0, 100 - Math.abs(row.daysToExpiry - 22) * 3);

  // 6. WHAT IT COSTS TO GET IN AND OUT. A 50% target on a Rs 2.41 premium with
  //    a 3% spread hands back 8.7% of the gain in costs and needs the premium to
  //    move 3.7% before it is even level, where the same target on a liquid
  //    Rs 30 contract costs under 2%. Ranking those two identically is how a
  //    desk recommends the more expensive trade while calling it the cheaper one.
  parts.costEfficiency = Number.isFinite(row.costAsPctOfGross)
    ? Math.max(0, Math.min(100, 100 - row.costAsPctOfGross * 8))
    : 60;

  // 7. THE UNDERLYING'S OWN READ, supplied by the caller from the existing
  //    scanner -- technicals, candlesticks, chart geometry, Hurst, GARCH and
  //    the matched-filter bank. Neutral when the name has not been scanned.
  parts.underlying = Number.isFinite(row.underlyingScore) ? row.underlyingScore : 50;

  // Equal weight, deliberately. Any other split would be a claim about relative
  // importance that nothing in this repo has earned the right to make.
  const keys = Object.keys(parts);
  const score = keys.reduce((sum, key) => sum + parts[key], 0) / keys.length;
  return { score: round(score, 1), parts: Object.fromEntries(keys.map((k) => [k, round(parts[k], 1)])) };
}

/**
 * Walk every listed contract and return the ones that survive.
 *
 * `underlyingScores` maps symbol -> 0..100 from the composite scanner, and
 * `bullish` maps symbol -> boolean so a call is only considered on a name the
 * desk reads as rising and a put only on one it reads as falling. Without that
 * the screener would happily recommend a call and a put on the same name in the
 * same breath.
 */
function screenContracts({
  reference = loadReference(),
  underlyingScores = {},
  bullish = {},
  now = Date.now(),
  gates = {},
  limit = 60
} = {}) {
  const rules = { ...GATES, ...gates };
  if (!reference?.symbols) {
    return { ok: false, reason: "NO_CONTRACT_REFERENCE", contracts: [], examined: 0 };
  }

  const volCache = new Map();
  const refused = {
    expiryWindow: 0, illiquid: 0, tinyPremium: 0, noIv: 0,
    deltaBand: 0, belowIntrinsic: 0, noDirection: 0, noUnderlying: 0
  };
  let examined = 0;
  const survivors = [];

  for (const [symbol, entry] of Object.entries(reference.symbols)) {
    for (const [expiry, bucket] of Object.entries(entry.expiries || {})) {
      const daysToExpiry = (Date.parse(`${expiry}T15:30:00+05:30`) - now) / 86400000;
      if (!(daysToExpiry >= rules.minDaysToExpiry && daysToExpiry <= rules.maxDaysToExpiry)) {
        refused.expiryWindow += (bucket.callStrikes?.length || 0) + (bucket.putStrikes?.length || 0);
        continue;
      }
      // Price off the FORWARD. For an F&O name the market's forward is the
      // future, and using the cash level instead moved at-the-money implied
      // volatility by more than seven points when this desk last got it wrong.
      const forward = Number(bucket.futuresPrice) > 0
        ? Number(bucket.futuresPrice)
        : Number(entry.underlyingPrice);
      if (!(forward > 0)) continue;

      const years = daysToExpiry / 365;
      const realisedVol = realisedVolFor(symbol, daysToExpiry, volCache);

      for (const optionType of ["CE", "PE"]) {
        const wantsCall = bullish[symbol];
        if (typeof wantsCall === "boolean") {
          if (wantsCall && optionType === "PE") { refused.noDirection += 1; continue; }
          if (!wantsCall && optionType === "CE") { refused.noDirection += 1; continue; }
        }
        const strikes = optionType === "CE" ? bucket.callStrikes : bucket.putStrikes;
        for (const strike of strikes || []) {
          examined += 1;
          const quote = bucket.quotes?.[`${strike}|${optionType}`];
          if (!quote) { refused.noIv += 1; continue; }

          const volume = Number(quote.volume) || 0;
          const openInterest = Number(quote.openInterest) || 0;
          if (volume < rules.minVolume || openInterest < rules.minOpenInterest) { refused.illiquid += 1; continue; }

          const premium = Number(quote.price);
          if (!(premium >= rules.minPremium)) { refused.tinyPremium += 1; continue; }

          // NSE derives a settlement price for contracts that did not trade, and
          // 972 of them came out BELOW intrinsic value last time this was
          // measured. An implied volatility solved from one is meaningless.
          const intrinsic = optionType === "CE"
            ? Math.max(0, forward - strike)
            : Math.max(0, strike - forward);
          if (premium < intrinsic) { refused.belowIntrinsic += 1; continue; }

          const solved = impliedVolatility({
            underlyingPrice: forward, strike, timeToExpiryYears: years,
            riskFreeRate: RISK_FREE, dividendYield: 0, optionType, model: "BSM"
          }, premium);
          const impliedVol = Number(solved?.iv);
          if (!(impliedVol > rules.minIv && impliedVol < rules.maxIv)) { refused.noIv += 1; continue; }

          const greeks = europeanOption({
            underlyingPrice: forward, strike, timeToExpiryYears: years,
            riskFreeRate: RISK_FREE, dividendYield: 0, volatility: impliedVol,
            optionType, model: "BSM"
          });
          const delta = Number(greeks?.delta);
          if (!(Math.abs(delta) >= rules.minDelta && Math.abs(delta) <= rules.maxDelta)) {
            refused.deltaBand += 1; continue;
          }

          // Where the underlying has to get for a 50% gain on the premium, and
          // how likely it is to touch it before expiry.
          const targetPremium = premium * 1.5;
          const breakeven = optionType === "CE" ? strike + premium : strike - premium;
          const moveNeeded = optionType === "CE"
            ? breakeven + (targetPremium - premium)
            : breakeven - (targetPremium - premium);
          const touch = realisedVol > 0
            ? timeToTarget({ spot: forward, target: moveNeeded, volatility: realisedVol, daysAvailable: daysToExpiry })
            : null;

          // NET of every charge and of crossing the spread, not the difference
          // between two mid prices multiplied by a lot.
          const economics = roundTripCost({
            entryPremium: premium, exitPremium: targetPremium, lotSize: bucket.lotSize || entry.lotSize
          });
          const breakevenMove = breakevenMovePct({
            entryPremium: premium, lotSize: bucket.lotSize || entry.lotSize
          });

          const row = {
            symbol, expiry, strike, optionType,
            premium: round(premium),
            // PROVENANCE, so a row that reaches the ledger says where its price
            // came from. A settlement price NSE derived for a contract that did
            // not trade is a different fact from one somebody actually paid.
            priceSource: quote.traded ? "EXCHANGE_TRADED_PRICE" : "EXCHANGE_SETTLED_PRICE",
            tradedToday: quote.traded === true,
            forward: round(forward),
            lotSize: bucket.lotSize || entry.lotSize || null,
            daysToExpiry: round(daysToExpiry, 1),
            impliedVol: round(impliedVol * 100, 1),
            realisedVol: realisedVol > 0 ? round(realisedVol * 100, 1) : null,
            varianceRiskPremium: realisedVol > 0 ? round(impliedVol / realisedVol, 2) : null,
            delta: round(delta, 3),
            gamma: round(greeks?.gamma, 6),
            theta: round(greeks?.theta / 365, 3),
            vega: round(greeks?.vega, 4),
            volume, openInterest,
            breakeven: round(breakeven),
            targetPremium: round(targetPremium),
            targetUnderlying: round(moveNeeded),
            touchPct: touch?.probabilityOfTouchPct ?? null,
            medianDaysToTarget: touch?.medianDaysIfItHappens ?? null,
            underlyingScore: Number(underlyingScores[symbol]),
            costPerLot: bucket.lotSize ? round(premium * bucket.lotSize) : null,
            // What actually lands in an account.
            grossProfit: economics?.grossProfit ?? null,
            netProfit: economics?.netProfit ?? null,
            totalCost: economics?.totalCost ?? null,
            costAsPctOfGross: economics?.costAsPctOfGross ?? null,
            breakevenPremiumMovePct: breakevenMove,
            fillAssumption: economics?.fillAssumption ?? null
          };
          // Keep the raw realised value for scoring, then hand back percentages.
          const scored = scoreContract({
            ...row, impliedVol, realisedVol, delta,
            costAsPctOfGross: economics?.costAsPctOfGross
          });
          survivors.push({ ...row, screenScore: scored.score, screenParts: scored.parts });
        }
      }
    }
  }

  survivors.sort((a, b) => b.screenScore - a.screenScore);
  return {
    ok: true,
    examined,
    survived: survivors.length,
    refused,
    gates: rules,
    asOfSession: reference.session || null,
    contracts: survivors.slice(0, limit)
  };
}

module.exports = { screenContracts, scoreContract, GATES };
