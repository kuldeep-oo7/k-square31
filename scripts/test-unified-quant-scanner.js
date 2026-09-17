"use strict";

const assert = require("assert");
const { analyzeCandidate, generateBrokerDeepLinks } = require("../api/_lib/unified-quant-scanner");

console.log("Starting Master Unified Quant Scanner test suite...");

// 1. Broker Deep Links
const links = generateBrokerDeepLinks({
  symbol: "ABB26SEPFUT",
  exchange: "NFO",
  action: "BUY",
  quantity: 125,
  price: 6954.45,
  triggerPrice: 6860.00
});
assert(links.zerodhaOrderPreview.includes("ABB26SEPFUT"), "Kite link should contain symbol");
assert(links.dhanApp.includes("ABB26SEPFUT"), "Dhan link should contain symbol");
assert(links.tradingViewChart.includes("ABB26SEPFUT"), "TradingView link should contain symbol");
console.log("  ✓ 1-Tap Broker Deep-Links verified (Kite, Dhan, TradingView)");

// 2. Candidate Analysis with 30-bar historical series
const sampleBars = [];
let price = 6800;
for (let i = 0; i < 30; i++) {
  price += (i % 2 === 0 ? 15 : -8);
  sampleBars.push({
    open: price - 5,
    high: price + 12,
    low: price - 8,
    close: price,
    volume: 12000 + i * 500
  });
}

const candidateInput = {
  id: "setup-abb",
  symbol: "ABB",
  tradingSymbol: "ABB26SEPFUT",
  assetClass: "FUTURES",
  marketCap: "Large Cap",
  action: "BUY",
  currentLtp: 7080.00,
  entryPrice: 6954.45,
  target1: 7140.85,
  target2: 7220.00,
  stopLoss: 6860.00,
  lotSize: 125,
  capitalRequired: 165000,
  historicalBars: sampleBars,
  macroState: { severity: "NORMAL", shieldActive: false },
  macroRadar: { indiaVix: { price: 12.4 } }
};

const analyzed = analyzeCandidate(candidateInput);

assert(analyzed.compositeScore >= 10 && analyzed.compositeScore <= 99, "Composite score must be in range");
assert(Number.isFinite(analyzed.neuralScore), "Neural score must be finite");
assert(typeof analyzed.candlestickPattern === "string", "Candlestick pattern must be string");
assert(typeof analyzed.chartPattern === "string", "Chart pattern must be string");
assert(typeof analyzed.garchVol === "string", "GARCH vol must be string");
assert(typeof analyzed.cvar99Rupees === "string", "CVaR rupees must be string");
assert(analyzed.links && analyzed.links.zerodhaOrderPreview, "Kite link must exist");
assert(Math.abs(analyzed.pnlRupees - 15693.75) < 0.01, "Dynamic MTM PnL in Rupees must match exactly");

console.log("  ✓ Candidate Analysis verified:");
console.log("    - Composite Score:", analyzed.compositeScore + "/100");
console.log("    - Neural Alpha Score:", analyzed.neuralScore + "/100 (" + analyzed.neuralMotif + ")");
console.log("    - Candlestick Formation:", analyzed.candlestickPattern);
console.log("    - Chart Structure:", analyzed.chartPattern);
console.log("    - GARCH(1,1) Forward Vol:", analyzed.garchVol);
console.log("    - Cornish-Fisher 99% CVaR:", analyzed.cvar99Rupees);
console.log("    - Live MTM P&L: ₹" + analyzed.pnlRupees.toLocaleString('en-IN'));

console.log("ALL Master Unified Quant Scanner tests passed successfully!\n");
