"use strict";

/**
 * CLI utility to generate a formatted broker contract note from an executed shadow trade.
 * Usage: node scripts/generate-shadow-contract-note.js [options]
 */

const { calculateNseFuturesCharges, generateContractNote, simulateExecutionFill } = require("../api/_lib/shadow-broker");

function sampleContractNote() {
  const mockIntent = {
    symbol: "RELIANCE",
    contractSymbol: "RELIANCE26SEPFUT",
    side: "long",
    entryPrice: 2950.00,
    targetPrice: 3009.00,
    stopLossPrice: 2891.00,
    lotSize: 250,
    lots: 1,
    quantity: 250,
    tickSize: 0.05
  };

  const entryFill = simulateExecutionFill({
    orderIntent: mockIntent,
    liquidityTier: "HIGH"
  });

  const exitFill = simulateExecutionFill({
    orderIntent: {
      ...mockIntent,
      side: "sell",
      entryPrice: 3009.00
    },
    liquidityTier: "HIGH"
  });

  const note = generateContractNote({
    tradeId: "TRD_SAMPLE_001",
    entryFill,
    exitFill,
    contract: { expiry: "2026-09-24" }
  });

  return note;
}

if (require.main === module) {
  const note = sampleContractNote();
  console.log("=== NSE ELECTRONIC CONTRACT NOTE (SHADOW EXECUTION) ===");
  console.log(`Note Number : ${note.contractNoteNumber}`);
  console.log(`Trade ID    : ${note.tradeId}`);
  console.log(`Contract    : ${note.contractSymbol} (Expiry: ${note.expiry})`);
  console.log(`Quantity    : ${note.quantity} (${note.quantity / note.lotSize} Lot)`);
  console.log("-------------------------------------------------------");
  console.log(`Entry Fill  : ₹${note.entry.price.toFixed(2)} (Turnover: ₹${note.entry.turnover.toLocaleString("en-IN")})`);
  console.log(`Exit Fill   : ₹${note.exit.price.toFixed(2)} (Turnover: ₹${note.exit.turnover.toLocaleString("en-IN")})`);
  console.log(`Gross P&L   : ₹${note.breakdown.grossPnl.toLocaleString("en-IN")}`);
  console.log("-------------------------------------------------------");
  console.log(`Brokerage   : ₹${note.breakdown.brokerage.toFixed(2)}`);
  console.log(`STT         : ₹${note.breakdown.stt.toFixed(2)} (0.02% on sell side)`);
  console.log(`Exch Turnovr: ₹${note.breakdown.exchangeTurnoverCharges.toFixed(2)} (0.0019%)`);
  console.log(`Clearing Chg: ₹${note.breakdown.clearingCharges.toFixed(2)}`);
  console.log(`SEBI Charges: ₹${note.breakdown.sebiTurnoverCharges.toFixed(2)}`);
  console.log(`Stamp Duty  : ₹${note.breakdown.stampDuty.toFixed(2)} (0.002% on buy side)`);
  console.log(`GST (18%)   : ₹${note.breakdown.gst.toFixed(2)}`);
  console.log(`Total Taxes : ₹${note.breakdown.totalTaxesAndCharges.toFixed(2)}`);
  console.log("-------------------------------------------------------");
  console.log(`Net P&L     : ₹${note.breakdown.netRealizedPnl.toLocaleString("en-IN")} (${note.breakdown.returnOnTurnoverPct}% on turnover)`);
  console.log("=======================================================");
}

module.exports = { sampleContractNote };
