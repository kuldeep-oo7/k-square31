"use strict";

/**
 * Where you get OUT.
 *
 * The desk computed an entry and four at-expiry outcomes -- max profit, max
 * loss, breakeven -- and then stopped. A card that says BUY and never says SELL
 * is not a trade, it is a position you now have to improvise your way out of,
 * usually at the worst moment.
 *
 * WHAT IS EXACT HERE AND WHAT IS CONVENTION. This distinction is the whole
 * point of the module and it is kept explicit in the output, because mixing the
 * two is how a desk ends up presenting a preference as a measurement.
 *
 *   EXACT (arithmetic, no model, no estimate):
 *     - the payoff of a vertical spread at expiry
 *     - net debit, max profit, max loss, breakeven
 *     - the underlying price at which a given spread value is reached AT EXPIRY
 *
 *   CONVENTION (a rule of thumb with a stated reason, NOT a measured edge):
 *     - taking profit at half of maximum rather than holding for all of it
 *     - cutting at half the debit
 *     - being flat before expiry week's gamma
 *
 * The conventions are defensible and they are not discoveries. Holding a debit
 * spread for the last rupee of its maximum means carrying it through the days
 * when gamma is largest and the remaining reward is smallest: you risk the
 * whole position to collect the part of the payoff that pays least per unit of
 * risk. Closing earlier gives up the tail and removes that exposure. Reasonable
 * people choose different fractions. Nothing in this file was fitted to data,
 * and nothing in it should be read as evidence that the ENTRY has an edge.
 */

const round2 = (value) => Math.round(value * 100) / 100;

// Take profit at half of maximum. The second half of a debit spread's payoff
// arrives slowest and is collected while gamma is at its largest.
const DEFAULT_PROFIT_FRACTION = 0.5;
// Cut when half the debit is gone. Symmetric with the target, so the structure
// risks one rupee to make one rupee on the premium actually at stake.
const DEFAULT_STOP_FRACTION = 0.5;
// Be flat before expiry. Two reasons, and the second is the one that can cost
// far more than the trade.
//
// 1. GAMMA. In the last sessions a vertical stops behaving like a smooth payoff
//    and starts behaving like a coin flip on where the underlying pins.
//
// 2. PHYSICAL SETTLEMENT. Verified against NSE rules rather than assumed: since
//    October 2019, in-the-money SINGLE STOCK options in India are settled by
//    DELIVERY OF SHARES, not cash. An in-the-money long call carried into
//    expiry is not a claim on a profit, it is an obligation to pay for the full
//    lot. One APOLLOHOSP lot is 125 shares; at a strike of 8900 that is about
//    Rs 11.1 lakh of cash against a premium of roughly Rs 9,500. A short leg is
//    worse: it is an obligation to DELIVER shares that may not be held, which
//    brings auction and penalty risk.
//
// Index options remain cash settled. This applies to stocks.
const DEFAULT_DAYS_BEFORE_EXPIRY = 2;

/**
 * Exit levels for a vertical debit spread.
 *
 * Everything is returned as a PREMIUM, because a premium is what goes into a
 * limit order. A spot level is given alongside, but only where it is exact --
 * at expiry -- and it is labelled so nobody reads it as "sell when the stock
 * touches this", which is a different and weaker claim.
 */
function verticalSpreadExits(input) {
  const longPremium = Number(input.longPremium);
  const shortPremium = Number(input.shortPremium);
  const longStrike = Number(input.longStrike);
  const shortStrike = Number(input.shortStrike);
  const lotSize = Number(input.lotSize);
  const isBullish = input.isBullish !== false;
  const profitFraction = Number(input.profitFraction ?? DEFAULT_PROFIT_FRACTION);
  const stopFraction = Number(input.stopFraction ?? DEFAULT_STOP_FRACTION);

  if (![longPremium, shortPremium, longStrike, shortStrike, lotSize].every((v) => Number.isFinite(v) && v > 0)) {
    return { available: false, reason: "INCOMPLETE_SPREAD_INPUTS" };
  }
  const width = Math.abs(shortStrike - longStrike);
  const netDebit = longPremium - shortPremium;
  // A vertical whose cost is not positive is a broken quote pair rather than a
  // free trade, and it has no defined max loss to size against.
  if (!(netDebit > 0) || !(width > netDebit)) {
    return { available: false, reason: "NON_POSITIVE_DEBIT_OR_DEBIT_EXCEEDS_WIDTH" };
  }

  const maxProfitPerShare = width - netDebit;
  const targetValue = round2(netDebit + profitFraction * maxProfitPerShare);
  const stopValue = round2(netDebit * (1 - stopFraction));
  const breakevenSpot = round2(isBullish ? longStrike + netDebit : longStrike - netDebit);

  // At expiry the spread is worth exactly its intrinsic value, capped at the
  // width, so a target VALUE maps to a single underlying price. Before expiry
  // the short leg still holds time value and the same spot is worth less than
  // this -- which is why the instruction below is a limit on the SPREAD, not a
  // trigger on the stock.
  const spotAtTarget = round2(isBullish ? longStrike + targetValue : longStrike - targetValue);

  return {
    available: true,
    structure: isBullish ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD",
    netDebit: round2(netDebit),
    width: round2(width),

    entry: {
      action: isBullish ? "BUY the lower call, SELL the higher call" : "BUY the higher put, SELL the lower put",
      netDebitRupees: Math.round(netDebit * lotSize),
      note: "Both legs together. One leg alone is a different trade with a different risk."
    },

    profitTarget: {
      spreadValue: targetValue,
      // What you actually gain, net of what you paid.
      gainRupees: Math.round((targetValue - netDebit) * lotSize),
      gainPctOfRisk: Math.round(((targetValue - netDebit) / netDebit) * 100),
      pctOfMaxProfit: Math.round(profitFraction * 100),
      spotAtExpiryForThisValue: spotAtTarget,
      order: "Limit order to CLOSE the spread (sell the long leg, buy back the short leg)",
      basis: "CONVENTION"
    },

    stop: {
      spreadValue: stopValue,
      lossRupees: Math.round((netDebit - stopValue) * lotSize),
      lossPctOfRisk: Math.round(stopFraction * 100),
      basis: "CONVENTION",
      note: "A vertical already caps the loss at the debit, so this is a choice to lose less than the maximum, not a protection you lack without it."
    },

    timeStop: {
      daysBeforeExpiry: DEFAULT_DAYS_BEFORE_EXPIRY,
      // The gamma half is a convention. The settlement half is a rule.
      basis: "CONVENTION_PLUS_SETTLEMENT_RULE",
      reason: "Gamma dominates the final sessions, and NSE settles in-the-money single stock options by PHYSICAL DELIVERY -- carrying one into expiry turns a premium into an obligation for the whole lot.",
      physicalSettlementRisk: isBullish
        ? `An in-the-money ${longStrike} call at expiry obliges you to buy ${lotSize} shares, about Rs ${Math.round(longStrike * lotSize).toLocaleString("en-IN")}, not to collect a profit.`
        : `An in-the-money ${longStrike} put at expiry obliges delivery of ${lotSize} shares you may not hold.`
    },

    atExpiry: {
      maxProfitRupees: Math.round(maxProfitPerShare * lotSize),
      maxLossRupees: Math.round(netDebit * lotSize),
      breakevenSpot,
      basis: "EXACT"
    },

    // The orders, exactly as they are typed. A net spread price is not a field
    // in any retail order screen -- "sell the spread at 1.82" maps to no
    // button, which makes it useless as an instruction however correct the
    // arithmetic behind it. Two legs, two tickets, each with its own price.
    ticket: {
      entry: [
        { action: "BUY", strike: longStrike, right: isBullish ? "CE" : "PE", limitPrice: round2(longPremium), quantity: lotSize },
        { action: "SELL", strike: shortStrike, right: isBullish ? "CE" : "PE", limitPrice: round2(shortPremium), quantity: lotSize }
      ],
      exit: [
        { action: "SELL", strike: longStrike, right: isBullish ? "CE" : "PE", note: "the leg you bought" },
        { action: "BUY", strike: shortStrike, right: isBullish ? "CE" : "PE", note: "buy back the leg you sold" }
      ],
      orderType: "LIMIT",
      warning: "Enter both legs together, as a basket if the broker offers one. If only the first fills you are holding the single leg, which costs the full premium instead of the net debit."
    },

    // What the position is worth at expiry for a given underlying price. This
    // is exact -- at expiry a vertical is worth its intrinsic value capped at
    // the width, with no model and no volatility involved. BEFORE expiry it is
    // worth LESS than this, because the short leg still carries time value, so
    // these are the levels the trade converges to rather than levels it prints
    // on the way there.
    spotLadder: (() => {
      const rows = [];
      const step = width / 4;
      for (let i = -1; i <= 5; i += 1) {
        const spot = round2(longStrike + i * step);
        const intrinsic = Math.min(Math.max(isBullish ? spot - longStrike : longStrike - spot, 0), width);
        rows.push({
          spot,
          spreadValueAtExpiry: round2(intrinsic),
          pnlRupees: Math.round((intrinsic - netDebit) * lotSize)
        });
      }
      return rows;
    })()
  };
}

/**
 * Exit levels for a single long option.
 *
 * Kept separate on purpose. A naked long call is NOT the spread, it costs the
 * full premium rather than the debit, and presenting one structure's exits
 * beside the other's cost is how someone ends up risking three times what the
 * card told them.
 */
function longOptionExits(input) {
  const premium = Number(input.premium);
  const strike = Number(input.strike);
  const lotSize = Number(input.lotSize);
  const isCall = input.isCall !== false;
  const gain = Number(input.gainFraction ?? 0.5);
  const loss = Number(input.lossFraction ?? 0.5);

  if (![premium, strike, lotSize].every((v) => Number.isFinite(v) && v > 0)) {
    return { available: false, reason: "INCOMPLETE_OPTION_INPUTS" };
  }

  const target = round2(premium * (1 + gain));
  const stop = round2(premium * (1 - loss));
  return {
    available: true,
    structure: isCall ? "LONG_CALL" : "LONG_PUT",
    costRupees: Math.round(premium * lotSize),
    profitTarget: {
      premium: target,
      gainRupees: Math.round((target - premium) * lotSize),
      gainPct: Math.round(gain * 100),
      basis: "CONVENTION"
    },
    stop: {
      premium: stop,
      lossRupees: Math.round((premium - stop) * lotSize),
      lossPct: Math.round(loss * 100),
      basis: "CONVENTION",
      note: "Unlike a spread, a long option has no built-in floor below this other than losing the entire premium."
    },
    atExpiry: {
      breakevenSpot: round2(isCall ? strike + premium : strike - premium),
      maxLossRupees: Math.round(premium * lotSize),
      basis: "EXACT"
    }
  };
}

module.exports = {
  DEFAULT_DAYS_BEFORE_EXPIRY,
  DEFAULT_PROFIT_FRACTION,
  DEFAULT_STOP_FRACTION,
  longOptionExits,
  verticalSpreadExits
};
