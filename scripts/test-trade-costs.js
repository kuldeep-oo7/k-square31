"use strict";

/**
 * Is the profit on the card the profit that would land in an account?
 *
 * Until 2026-09-21 it was not. "Buy at 30.38, sell at 45.57, +Rs 3,798" is the
 * difference between two mid prices times a lot size -- gross of every charge
 * and of the spread that has to be crossed twice. Every profit figure on the
 * desk was optimistic by the whole cost stack.
 *
 * The rates below come from the broker's published schedule, and the one that
 * matters most has moved twice recently: securities transaction tax on options
 * went 0.0625% -> 0.10% (Oct 2024) -> 0.15% (Apr 2026). Any model still carrying
 * the oldest figure understates the largest single line by 2.4x, so it is
 * asserted explicitly rather than left to drift.
 */

const assert = require("node:assert/strict");
const { CHARGES, roundTripCost, breakevenPremium, breakevenMovePct } = require("../api/_lib/trade-costs");

console.log("Starting trade cost test suite...");

// --- 1. The rates are the published ones, not remembered ones ---------------
{
  assert.equal(CHARGES.sttSellPct, 0.0015, "STT on options is 0.15% of premium on the sell side from April 2026");
  assert.equal(CHARGES.brokeragePerOrder, 20, "brokerage is a flat Rs 20 per executed order");
  assert.equal(CHARGES.exchangeTxnPct, 0.0003553, "NSE transaction charge is 0.03553% of premium");
  assert.equal(CHARGES.stampBuyPct, 0.00003, "stamp duty is 0.003%, buy side only");
  assert.equal(CHARGES.gstPct, 0.18, "GST is 18% on brokerage, SEBI and exchange charges");
  console.log("  ✓ Published rates are asserted, including the STT that tripled between 2024 and 2026");
}

// --- 2. Every line is charged on the right side of the trade ----------------
{
  const r = roundTripCost({ entryPremium: 100, exitPremium: 150, lotSize: 100 });
  const sellTurnover = 150 * 100;
  const buyTurnover = 100 * 100;
  assert.ok(Math.abs(r.charges.securitiesTransactionTax - sellTurnover * 0.0015) < 0.01,
    "STT must be charged on the SELL turnover only");
  assert.ok(Math.abs(r.charges.stampDuty - buyTurnover * 0.00003) < 0.01,
    "stamp duty must be charged on the BUY turnover only");
  assert.ok(Math.abs(r.charges.exchangeTransaction - (buyTurnover + sellTurnover) * 0.0003553) < 0.01,
    "the exchange charge applies to both sides");
  assert.equal(r.charges.brokerage, 40, "two orders, two lots of brokerage");
  assert.ok(Math.abs(r.charges.gst - (r.charges.brokerage + r.charges.sebiTurnover + r.charges.exchangeTransaction) * 0.18) < 0.01,
    "GST applies to brokerage, SEBI and exchange charges -- not to STT or stamp duty");
  console.log("  ✓ STT and stamp on their correct sides, GST on the correct base");
}

// --- 3. Net is always below gross, and the gap is reported ------------------
{
  const r = roundTripCost({ entryPremium: 30.38, exitPremium: 45.57, lotSize: 250 });
  assert.ok(r.netProfit < r.grossProfit, "net profit must be below gross");
  assert.ok(Math.abs(r.grossProfit - 3797.5) < 0.5, `gross should be 3797.50, got ${r.grossProfit}`);
  assert.ok(r.costAsPctOfGross > 1 && r.costAsPctOfGross < 4,
    `charges alone should eat 1-4% of this gain, got ${r.costAsPctOfGross}%`);
  console.log(`  ✓ The card's +Rs 3,798 is really +Rs ${r.netProfit} once charged (${r.costAsPctOfGross}% eaten)`);
}

// --- 4. The spread is a cost, and it is the bigger one -----------------------
{
  const mid = roundTripCost({ entryPremium: 30.38, exitPremium: 45.57, lotSize: 250 });
  const real = roundTripCost({ entryPremium: 30.38, exitPremium: 45.57, lotSize: 250, entrySpreadPct: 1.15 });
  assert.ok(real.netProfit < mid.netProfit, "crossing the spread must cost more than not crossing it");
  assert.ok(real.spreadCost > real.charges.total,
    `on a 1.15% spread the spread (${real.spreadCost}) should exceed the statutory charges (${real.charges.total})`);
  assert.equal(mid.fillAssumption, "MID_PRICE_NO_BOOK_OBSERVED");
  assert.equal(real.fillAssumption, "CROSSES_THE_SPREAD_AT_THE_TOUCH");
  assert.equal(mid.spreadKnown, false, "with no book observed, the model must SAY the spread is unknown");
  console.log(`  ✓ The spread costs Rs ${real.spreadCost} against Rs ${real.charges.total} of charges `
    + "-- the bigger of the two, and the one no schedule lists");
}

// --- 5. A cheap contract with a wide spread is far worse than it looks -------
{
  const liquid = roundTripCost({ entryPremium: 30.38, exitPremium: 45.57, lotSize: 250, entrySpreadPct: 1.15 });
  const cheap = roundTripCost({ entryPremium: 2.41, exitPremium: 3.62, lotSize: 6500, entrySpreadPct: 3.0 });
  assert.ok(cheap.costAsPctOfGross > liquid.costAsPctOfGross * 1.5,
    `a Rs 2.41 premium on a 3% spread should be far more expensive per rupee of gain: `
    + `${cheap.costAsPctOfGross}% against ${liquid.costAsPctOfGross}%`);
  console.log(`  ✓ A cheap, wide contract hands back ${cheap.costAsPctOfGross}% of the gain against `
    + `${liquid.costAsPctOfGross}% for a liquid one -- the desk used to rank those identically`);
}

// --- 6. Breakeven is above the entry, not at it -----------------------------
{
  const be = breakevenPremium({ entryPremium: 30.38, lotSize: 250 });
  assert.ok(be > 30.38, `breakeven must be above the entry price, got ${be}`);
  const beWide = breakevenPremium({ entryPremium: 30.38, lotSize: 250, spreadPct: 1.15 });
  assert.ok(beWide > be, "a wider spread must push breakeven further away");

  const move = breakevenMovePct({ entryPremium: 30.38, lotSize: 250, spreadPct: 1.15 });
  assert.ok(move > 1 && move < 5, `the required move should be a couple of percent, got ${move}%`);

  // And the solver must actually be solving: at breakeven, net is ~zero.
  const atBe = roundTripCost({ entryPremium: 30.38, exitPremium: beWide, lotSize: 250, entrySpreadPct: 1.15 });
  assert.ok(Math.abs(atBe.netProfit) < atBe.capitalRequired * 0.002,
    `at the solved breakeven the net should be about zero, got ${atBe.netProfit}`);
  console.log(`  ✓ Breakeven on that card is ${beWide}, not 30.38 -- the premium must rise ${move}% to be level`);
}

// --- 7. It refuses nonsense rather than returning a confident zero ----------
{
  assert.equal(roundTripCost({ entryPremium: 0, exitPremium: 10, lotSize: 100 }), null);
  assert.equal(roundTripCost({ entryPremium: 10, exitPremium: 10, lotSize: 0 }), null);
  assert.equal(breakevenPremium({ entryPremium: -5, lotSize: 100 }), null);
  console.log("  ✓ Nonsense inputs return null rather than a plausible-looking zero");
}

console.log("ALL trade cost tests passed: charges are the published ones on the correct sides, the spread is "
  + "modelled as the larger cost it usually is, breakeven sits above the entry rather than at it, and a cheap "
  + "contract with a wide book is correctly shown to be the expensive one.");
