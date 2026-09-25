"use strict";

/**
 * THE BALANCE-SHEET RULE MUST NOT PUNISH A BUSINESS MODEL (2026-09-25): 15 of
 * the 21 names the unscoped debt-to-equity rule caught were lenders.
 */

const { balanceSheetAdjustment: adjust, balanceSheetScore: score } = require("../api/_lib/fundamentals");

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label); }
}

console.log("balance-sheet rule:");
check("a lender's leverage is its business: BAJFINANCE D/E 315 is not penalised",
  adjust({ debtToEquity: 314.8, balanceSheetScore: 0.02, sector: "Financial Services" }) === 0);
check("a non-financial above 2x is: INDIGO D/E 1113 (leases) costs 15 points",
  adjust({ debtToEquity: 1112.7, balanceSheetScore: -0.26, sector: "Services" }) === -15);
check("exactly 2x is not above it", adjust({ debtToEquity: 200, balanceSheetScore: 0, sector: "Power" }) === 0);
check("a strong balance sheet earns 4: TCS", adjust({ debtToEquity: 10.2, balanceSheetScore: 0.95, sector: "Information Technology" }) === 4);
check("a bank with no reported D/E and a strong score earns 4, never a penalty",
  adjust({ debtToEquity: null, balanceSheetScore: 0.63, sector: "Financial Services" }) === 4);
check("an unknown sector is never penalised: unknown is not bad",
  adjust({ debtToEquity: 300, balanceSheetScore: 0, sector: "Diversified" }) === 0 && adjust({ debtToEquity: 300 }) === 0);
check("no data, no adjustment", adjust({}) === 0 && adjust() === 0);

// A MISSING METRIC IS LEFT OUT, NOT SCORED AS ZERO. ACC.NS as Yahoo reported it
// on 2026-09-25: no return on equity, no current ratio.
const acc = { profitMargin: 0.07563, returnOnEquity: null, debtToEquity: 2.085, currentRatio: null, revenueGrowth: -0.038 };
const onlyKnown = (0.2 * Math.min(1, 0.07563 * 8) + 0.2 * Math.min(1, (80 - 2.085) / 80) + 0.15 * Math.max(-1, -0.038 * 6)) / (0.2 + 0.2 + 0.15);
check("a metric Yahoo did not report is left out of the score, not scored as zero (ACC: 0.512, not 0.157)",
  Math.abs(score(acc) - Math.round(onlyKnown * 1e4) / 1e4) < 1e-9 && score(acc) > 0.25);
check("an unreported debt-to-equity is not 'no debt': it adds nothing, rather than a perfect score",
  score({ profitMargin: 0.1, debtToEquity: null }) === score({ profitMargin: 0.1 }));
check("a real zero is still a zero: 0% growth counts", score({ revenueGrowth: 0 }) === 0 && score({ profitMargin: 0.1, revenueGrowth: 0 }) < score({ profitMargin: 0.1 }));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
