"use strict";

/**
 * THE BALANCE-SHEET RULE MUST NOT PUNISH A BUSINESS MODEL (2026-09-25): 15 of
 * the 21 names the unscoped debt-to-equity rule caught were lenders.
 */

const { balanceSheetAdjustment: adjust } = require("../api/_lib/fundamentals");

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

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
