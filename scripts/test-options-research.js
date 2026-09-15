"use strict";
const assert = require("node:assert/strict");
const { europeanOption, impliedVolatility } = require("../api/_lib/option-pricing");
const { analyzeOptionStrategy, recommendationReadiness } = require("../api/_lib/option-strategy");
const near = (a, b, tolerance = 1e-4) => assert.ok(Number.isFinite(a) && Math.abs(a - b) < tolerance, `${a} != ${b}`);
for (const model of ["BSM", "BLACK76"]) for (const optionType of ["CE", "PE"]) {
  const p = { model, optionType, underlyingPrice: 105, strike: 100, timeToExpiryYears: 0.75, riskFreeRate: 0.06, dividendYield: 0.02, volatility: 0.3 };
  const g = europeanOption(p), price = (changes) => europeanOption({ ...p, ...changes }).price;
  assert.equal(g.available, true);
  const h = 0.01, small = 0.0001;
  near(g.delta, (price({ underlyingPrice: 105 + h }) - price({ underlyingPrice: 105 - h })) / (2 * h));
  near(g.gamma, (price({ underlyingPrice: 105 + h }) - 2 * g.price + price({ underlyingPrice: 105 - h })) / h ** 2, 2e-5);
  near(g.vega, (price({ volatility: 0.3 + small }) - price({ volatility: 0.3 - small })) / (2 * small * 100));
  near(g.rho, (price({ riskFreeRate: 0.06 + small }) - price({ riskFreeRate: 0.06 - small })) / (2 * small * 100));
  near(g.theta, (price({ timeToExpiryYears: 0.75 - small }) - price({ timeToExpiryYears: 0.75 + small })) / (2 * small * 365));
  near(impliedVolatility(p, g.price).iv, 0.3, 1e-7);
  const call = price({ optionType: "CE" }), put = price({ optionType: "PE" });
  near(call - put, model === "BLACK76" ? Math.exp(-0.06 * 0.75) * 5 : 105 * Math.exp(-0.02 * 0.75) - 100 * Math.exp(-0.06 * 0.75));
}
const baseline = { model: "BSM", optionType: "CE", underlyingPrice: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, dividendYield: 0, volatility: 0.2 };
near(europeanOption(baseline).price, 10.45058357, 2e-5);
for (const key of ["model", "optionType", "underlyingPrice", "strike", "timeToExpiryYears", "riskFreeRate", "dividendYield", "volatility"]) {
  assert.equal(europeanOption({ ...baseline, [key]: null }).available, false, `${key} must not default to invented data`);
}
assert.equal(impliedVolatility(baseline, 120).available, false);
assert.equal(impliedVolatility(baseline, null).available, false);
assert.equal(europeanOption({ ...baseline, volatility: 0 }).status, "DETERMINISTIC_BOUNDARY");
assert.equal(europeanOption({ ...baseline, timeToExpiryYears: 0 }).delta, null, "ATM expiry derivative is not an ordinary delta");
const leg = (side, type, strike, price) => ({ contractKey: `NFO:TEST:${strike}:${type}`, underlying: "TEST", exchange: "NFO", side, type, strike, price,
  quantity: 50, lotSize: 50, tickSize: 0.05, expiry: "2026-09-29" });
const debit = analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 40, legs: [leg("BUY", "CE", 100, 8), leg("SELL", "CE", 110, 3)] });
assert.equal(debit.maxTerminalLossInr, 290);
assert.equal(debit.maxTerminalProfitInr, 210);
assert.deepEqual(debit.breakEvenUnderlyingPrices, [105.8]);
const credit = analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 40, legs: [leg("SELL", "PE", 100, 8), leg("BUY", "PE", 90, 3)] });
assert.equal(credit.maxTerminalLossInr, 290);
assert.equal(credit.maxTerminalProfitInr, 210);
assert.deepEqual(credit.breakEvenUnderlyingPrices, [95.8]);
const naked = analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 40, legs: [leg("SELL", "CE", 100, 8)] });
assert.equal(naked.unlimitedLoss, true);
assert.equal(naked.maxTerminalLossInr, null);
const both = analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 40, legs: [leg("BUY", "CE", 100, 8), leg("BUY", "PE", 100, 7)] });
assert.equal(both.maxTerminalLossInr, 790, "Call + put can lose both premiums plus charges");
const protective = analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 40, legs: [leg("BUY", "FUT", 0, 100), leg("BUY", "PE", 95, 3)] });
assert.equal(protective.maxTerminalLossInr, 440);
assert.equal(protective.unlimitedProfit, true);
assert.equal(analyzeOptionStrategy({ underlyingPrice: 100, roundTripCostsInr: 0, legs: [leg("BUY", "CE", 100, 8), { ...leg("SELL", "CE", 110, 3), expiry: "2026-10-27" }] }).available, false);
assert.equal(analyzeOptionStrategy({ underlyingPrice: 100, legs: [leg("BUY", "CE", 100, 8)] }).available, false);
const gate = recommendationReadiness({ strategy: debit, mandate: { capitalInr: 1000000, maxDailyLossInr: 0, maxTradeLossInr: 0 } });
assert.equal(gate.permittedOrderQuantity, 0);
assert.ok(gate.reasons.includes("NO_POSITIVE_LOSS_BUDGET_AUTHORIZED"));
console.log("Options research tests passed: BSM/Black-76 Greek finite differences, parity, IV inversion, missing data, expiry, spreads, hedge loss and zero-risk gate.");
