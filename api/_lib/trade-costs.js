"use strict";

/**
 * WHAT THE TRADE ACTUALLY COSTS, before anyone calls a number a profit.
 *
 * The desk has been showing gross arithmetic. "Buy at 30.38, sell at 45.57,
 * +Rs 3,798" is the difference between two premiums multiplied by a lot size,
 * and it is not what would land in an account. Every figure on every card has
 * been optimistic by the whole cost stack, which for a bought option in India is
 * not a rounding error -- the securities transaction tax alone TRIPLED between
 * 2024 and April 2026, from 0.0625% to 0.15%, and any model still carrying the
 * old figure understates the largest single line by a factor of 2.4.
 *
 * RATES, taken from the broker's own published schedule (Zerodha, NSE F&O):
 *
 *   Brokerage            Rs 20 flat per executed order, both sides
 *   STT                  0.15% of premium, SELL SIDE ONLY
 *   Exchange transaction 0.03553% of premium, both sides (NSE)
 *   SEBI turnover        Rs 10 per crore, both sides
 *   Stamp duty           0.003% of premium, BUY SIDE ONLY
 *   GST                  18% on brokerage + SEBI + exchange charges
 *
 * AND THE COST NOBODY PUTS IN A SCHEDULE: the spread. A card quoting a mid of
 * 30.38 against a book of 30.20 / 30.55 is quoting a price at which nobody
 * transacts. You buy at the ask and you sell at the bid, and on a 1.15% spread
 * that is another 1.1% of the position gone before the trade has an opinion.
 * Where a real book is known it is used; where it is not, that is said rather
 * than assumed away.
 */

const CHARGES = {
  brokeragePerOrder: 20,
  sttSellPct: 0.0015,          // 0.15% on premium, sell side, from 1 April 2026
  exchangeTxnPct: 0.0003553,   // NSE
  sebiPerCrore: 10,
  stampBuyPct: 0.00003,        // 0.003%, buy side
  gstPct: 0.18
};

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/**
 * The full round trip on a bought option, in rupees.
 *
 * `entryPremium` and `exitPremium` are per unit; `lotSize` is the exchange lot.
 * Pass `entrySpreadPct` when a real book is known, and the fill is modelled at
 * the touch rather than the middle.
 */
function roundTripCost({ entryPremium, exitPremium, lotSize, lots = 1, entrySpreadPct = null, exitSpreadPct = null }) {
  const entry = Number(entryPremium), exit = Number(exitPremium), lot = Number(lotSize);
  if (!(entry > 0) || !(exit > 0) || !(lot > 0)) return null;
  const quantity = lot * Math.max(1, Math.round(lots));

  // Crossing the spread. Buying lifts the offer and selling hits the bid, so a
  // round trip pays the WHOLE spread, not half of it -- half on the way in and
  // half on the way out.
  const inSpread = Number.isFinite(entrySpreadPct) ? entrySpreadPct / 100 : null;
  const outSpread = Number.isFinite(exitSpreadPct) ? exitSpreadPct / 100 : inSpread;
  const paidEntry = inSpread === null ? entry : entry * (1 + inSpread / 2);
  const paidExit = outSpread === null ? exit : exit * (1 - outSpread / 2);

  const buyTurnover = paidEntry * quantity;
  const sellTurnover = paidExit * quantity;
  const turnover = buyTurnover + sellTurnover;

  const brokerage = CHARGES.brokeragePerOrder * 2;
  const stt = sellTurnover * CHARGES.sttSellPct;
  const exchange = turnover * CHARGES.exchangeTxnPct;
  const sebi = (turnover / 1e7) * CHARGES.sebiPerCrore;
  const stamp = buyTurnover * CHARGES.stampBuyPct;
  const gst = (brokerage + sebi + exchange) * CHARGES.gstPct;
  const statutory = brokerage + stt + exchange + sebi + stamp + gst;

  const grossProfit = (exit - entry) * quantity;
  const spreadCost = (paidEntry - entry) * quantity + (exit - paidExit) * quantity;
  const netProfit = grossProfit - spreadCost - statutory;

  return {
    quantity,
    capitalRequired: round2(buyTurnover),
    grossProfit: round2(grossProfit),
    spreadCost: round2(spreadCost),
    spreadKnown: inSpread !== null,
    charges: {
      brokerage: round2(brokerage),
      securitiesTransactionTax: round2(stt),
      exchangeTransaction: round2(exchange),
      sebiTurnover: round2(sebi),
      stampDuty: round2(stamp),
      gst: round2(gst),
      total: round2(statutory)
    },
    totalCost: round2(statutory + spreadCost),
    netProfit: round2(netProfit),
    // The part that changes decisions: what fraction of the gain the costs eat,
    // and how far the premium must actually travel before you are level.
    costAsPctOfGross: grossProfit > 0 ? round2((100 * (statutory + spreadCost)) / grossProfit) : null,
    netProfitPct: buyTurnover > 0 ? round2((100 * netProfit) / buyTurnover) : null,
    fillAssumption: inSpread === null
      ? "MID_PRICE_NO_BOOK_OBSERVED"
      : "CROSSES_THE_SPREAD_AT_THE_TOUCH"
  };
}

/**
 * The premium at which a bought option merely BREAKS EVEN after every cost.
 *
 * This is the number that ought to sit beside every entry price and never has.
 * A contract bought at 30.38 does not become profitable at 30.39.
 */
function breakevenPremium({ entryPremium, lotSize, lots = 1, spreadPct = null, tolerance = 0.0001 }) {
  const entry = Number(entryPremium);
  if (!(entry > 0) || !(Number(lotSize) > 0)) return null;
  // Costs depend on the exit price, which depends on the costs, so it is solved
  // rather than stated. Monotone and well behaved; a dozen steps is plenty.
  let low = entry, high = entry * 3;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    const result = roundTripCost({ entryPremium: entry, exitPremium: mid, lotSize, lots, entrySpreadPct: spreadPct });
    if (!result) return null;
    if (Math.abs(result.netProfit) < tolerance * result.capitalRequired) return round2(mid);
    if (result.netProfit > 0) high = mid; else low = mid;
  }
  return round2((low + high) / 2);
}

/** The same, expressed as the percentage move the premium has to make. */
function breakevenMovePct({ entryPremium, lotSize, lots = 1, spreadPct = null }) {
  const be = breakevenPremium({ entryPremium, lotSize, lots, spreadPct });
  const entry = Number(entryPremium);
  return be && entry > 0 ? round2((100 * (be - entry)) / entry) : null;
}

module.exports = { CHARGES, roundTripCost, breakevenPremium, breakevenMovePct };
