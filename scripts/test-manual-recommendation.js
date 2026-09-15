"use strict";

const assert = require("node:assert");
const { generateManualRecommendation } = require("../api/_lib/manual-recommendation");

console.log("Starting Manual Recommendation Engine test suite...");

// Test 1: NIFTY Call Option Recommendation with defined-risk hedge
const niftyCall = generateManualRecommendation({
  symbol: "NIFTY",
  spotPrice: 23120,
  direction: "LONG",
  assetClass: "OPTION",
  lotSize: 25,
  expiry: "2026-09-24",
  holdingSessions: 4
});

assert.equal(niftyCall.status, "ACTIVE");
assert.equal(niftyCall.actionable, true);
assert.equal(niftyCall.symbol, "NIFTY");
assert.equal(niftyCall.assetClass, "OPTION");
assert.equal(niftyCall.action, "BUY");
assert.equal(niftyCall.strike, 23100);
assert.equal(niftyCall.optionType, "CE");
assert.ok(niftyCall.entryTrigger > 0, "Entry trigger must be positive");
assert.ok(niftyCall.targetRung1 > niftyCall.entryTrigger, "Target 1 must be higher than entry for long call");
assert.ok(niftyCall.runnerTarget > niftyCall.targetRung2, "Runner target must be higher than Target 2");
assert.ok(niftyCall.stopLoss < niftyCall.entryTrigger, "Stop loss must be lower than entry for long call");
assert.ok(niftyCall.zerodhaFastCopy.includes("BUY NIFTY"), "Zerodha fast copy must format BUY NIFTY");
assert.equal(niftyCall.definedRiskHedge.strategyType, "BULL_CALL_SPREAD");
assert.ok(niftyCall.definedRiskHedge.maximumLossCappedInr > 0, "Max loss on spread must be positive finite debit");

// Test 2: NIFTY Put Option Recommendation (Short Direction)
const niftyPut = generateManualRecommendation({
  symbol: "NIFTY",
  spotPrice: 23120,
  direction: "SHORT",
  assetClass: "OPTION",
  lotSize: 25,
  expiry: "2026-09-24",
  holdingSessions: 3
});

assert.equal(niftyPut.status, "ACTIVE");
assert.equal(niftyPut.optionType, "PE");
assert.equal(niftyPut.strike, 23100);
assert.ok(niftyPut.targetRung1 > niftyPut.entryTrigger, "Target 1 option premium must increase as spot falls");
assert.equal(niftyPut.definedRiskHedge.strategyType, "BEAR_PUT_SPREAD");

// Test 3: Futures Recommendation
const futRec = generateManualRecommendation({
  symbol: "SUPREMEIND",
  spotPrice: 5200,
  direction: "LONG",
  assetClass: "FUTURES",
  lotSize: 125,
  expiry: "2026-09-24"
});

assert.equal(futRec.status, "ACTIVE");
assert.equal(futRec.assetClass, "FUTURES");
assert.equal(futRec.action, "BUY");
assert.ok(futRec.targetRung1 > 5200);
assert.ok(futRec.stopLoss < 5200);
assert.ok(futRec.capitalRequiredInr > 100000, "Futures margin should reflect contract notional");

// Test 4: Cash Recommendation
const cashRec = generateManualRecommendation({
  symbol: "APLAPOLLO",
  spotPrice: 1540,
  direction: "LONG",
  assetClass: "CASH"
});

assert.equal(cashRec.status, "ACTIVE");
assert.equal(cashRec.assetClass, "CASH");
assert.equal(cashRec.lotSize, 1);
assert.equal(cashRec.capitalRequiredInr, 1540);

// Test 5: Event-risk VETO (Earnings upcoming within holding window)
const vetoedRec = generateManualRecommendation({
  symbol: "TCS",
  spotPrice: 4200,
  direction: "LONG",
  assetClass: "OPTION",
  holdingSessions: 5,
  sentimentContext: {
    events: [{ symbol: "TCS", type: "EARNINGS", date: new Date(Date.now() + 2 * 86400000).toISOString() }]
  }
});

assert.equal(vetoedRec.status, "VETOED");
assert.equal(vetoedRec.actionable, false);
assert.ok(vetoedRec.reason.includes("High-risk event"));

console.log("Manual Recommendation Engine tests passed: options rungs, fast-copy, defined-risk spreads, futures, cash, and event vetoes verified.");
