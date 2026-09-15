"use strict";
const { europeanOption } = require("./option-pricing");
const { isDate } = require("./indian-instruments");
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const round = (n) => finite(n) ? Math.round(n * 100) / 100 : null;

// Terminal payoff analysis, NOT a probability model or a broker instruction.
// All legs must have the same economic underlying, venue and expiry. Black-76
// is NOT automatically chosen just because an Indian option sits in F&O.
function analyzeOptionStrategy(input = {}) {
  const { legs, roundTripCostsInr, underlyingPrice } = input;
  const fail = (reason) => ({ available: false, status: "BLOCKED", reason, actionable: false });
  if (!Array.isArray(legs) || !legs.length || legs.length > 8) return fail("ONE_TO_EIGHT_LEGS_REQUIRED");
  if (!finite(roundTripCostsInr) || roundTripCostsInr < 0) return fail("ALL_LEG_COST_ESTIMATE_REQUIRED");
  if (!finite(underlyingPrice) || underlyingPrice <= 0) return fail("UNDERLYING_PRICE_REQUIRED");
  const first = legs[0], keys = new Set();
  for (const leg of legs) {
    if (!leg?.contractKey || keys.has(leg.contractKey)) return fail("EXACT_UNIQUE_CONTRACT_KEYS_REQUIRED");
    keys.add(leg.contractKey);
    if (!["BUY", "SELL"].includes(leg.side) || !["CE", "PE", "FUT"].includes(leg.type)) return fail("SIDE_OR_TYPE_INVALID");
    if (!leg.underlying || leg.underlying !== first.underlying || leg.exchange !== first.exchange || leg.expiry !== first.expiry || !isDate(leg.expiry)) return fail("MATCHING_UNDERLYING_VENUE_EXPIRY_REQUIRED");
    if (!["NFO", "BFO"].includes(leg.exchange)) return fail("VENUE_NOT_SUPPORTED");
    if (!Number.isSafeInteger(leg.lotSize) || leg.lotSize < 1 || !Number.isSafeInteger(leg.quantity) || leg.quantity < 1 || leg.quantity % leg.lotSize) return fail("WHOLE_LOTS_REQUIRED");
    if (!finite(leg.price) || leg.price <= 0 || !finite(leg.tickSize) || leg.tickSize <= 0) return fail("LEG_PRICE_AND_TICK_REQUIRED");
    if (Math.abs(leg.price / leg.tickSize - Math.round(leg.price / leg.tickSize)) > 1e-6) return fail("PRICE_OFF_TICK");
    if (leg.type !== "FUT" && (!finite(leg.strike) || leg.strike <= 0)) return fail("STRIKE_INVALID");
  }
  const sign = (leg) => leg.side === "BUY" ? 1 : -1;
  const payoffAt = (price) => legs.reduce((pnl, leg) => {
    const payoff = leg.type === "FUT" ? price : leg.type === "CE" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
    return pnl + sign(leg) * leg.quantity * (payoff - leg.price);
  }, -roundTripCostsInr);
  const knots = [...new Set([0, ...legs.filter((l) => l.type !== "FUT").map((l) => l.strike)])].sort((a, b) => a - b);
  const values = knots.map(payoffAt);
  const upperSlope = legs.reduce((total, leg) => total + (leg.type === "PE" ? 0 : sign(leg) * leg.quantity), 0);
  const unlimitedLoss = upperSlope < 0, unlimitedProfit = upperSlope > 0;
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const breakEvens = [];
  for (let i = 0; i < knots.length; i += 1) {
    if (Math.abs(values[i]) < 1e-9) breakEvens.push(knots[i]);
    if (i < knots.length - 1 && values[i] * values[i + 1] < 0) breakEvens.push(knots[i] - values[i] * (knots[i + 1] - knots[i]) / (values[i + 1] - values[i]));
  }
  const root = upperSlope !== 0 ? knots.at(-1) - values.at(-1) / upperSlope : null;
  if (root !== null && root > knots.at(-1)) breakEvens.push(root);
  const premiums = legs.filter((l) => l.type !== "FUT").reduce((cost, l) => cost + sign(l) * l.price * l.quantity, 0);
  const greeks = { delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  let greeksAvailable = true;
  for (const leg of legs) {
    const g = leg.type === "FUT" ? { available: true, delta: 1, gamma: 0, vega: 0, theta: 0, rho: 0 }
      : europeanOption({ model: input.model, underlyingPrice, strike: leg.strike, timeToExpiryYears: input.timeToExpiryYears,
        riskFreeRate: input.riskFreeRate, dividendYield: input.dividendYield, volatility: leg.volatility, optionType: leg.type });
    if (!g.available || !Object.keys(greeks).every((key) => finite(g[key]))) { greeksAvailable = false; continue; }
    for (const key of Object.keys(greeks)) greeks[key] += sign(leg) * leg.quantity * g[key];
  }
  return { available: true, status: "TERMINAL_PAYOFF_RESEARCH", actionable: false,
    underlying: first.underlying, exchange: first.exchange, expiry: first.expiry, legs,
    netPremiumDebitInr: round(premiums), roundTripCostsInr, unlimitedLoss, unlimitedProfit,
    maxTerminalLossInr: unlimitedLoss ? null : round(Math.max(0, -minimum)),
    maxTerminalProfitInr: unlimitedProfit ? null : round(Math.max(0, maximum)),
    breakEvenUnderlyingPrices: [...new Set(breakEvens.map(round))],
    scenarios: [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2].map((move) => ({ underlyingPrice: round(underlyingPrice * (1 + move)), netTerminalPnlInr: round(payoffAt(underlyingPrice * (1 + move))) })),
    greeks: greeksAvailable ? greeks : null,
    limitations: ["Payoff assumes all legs fill in full and settle against the same underlying at the same expiry.",
      "Not a bound on daily drawdown or margin: legs can fail, fills can differ, and margin can rise.",
      "Expiry charges/delivery, funding, and exercise obligations require separate checks; cost is user/provider estimated.",
      "A long call plus a long put is a long straddle/strangle; both premiums can be lost. It is not a zero-loss hedge.",
      "No win probability, profitable holding time, or strategy edge is inferred from Black-Scholes or a payoff graph."] };
}

function recommendationReadiness({ strategy, mandate = {}, catalogueVerified = false, quotesVerified = false, evidence = {} } = {}) {
  const reasons = [];
  if (!strategy?.available) reasons.push("STRATEGY_INPUT_INVALID");
  if (strategy?.unlimitedLoss) reasons.push("UNCAPPED_LOSS_NOT_PERMITTED");
  if (!catalogueVerified) reasons.push("EXACT_CURRENT_CONTRACTS_NOT_VERIFIED");
  if (!quotesVerified) reasons.push("FRESH_EXECUTABLE_QUOTES_NOT_VERIFIED");
  if (!(finite(mandate.capitalInr) && mandate.capitalInr > 0)) reasons.push("CAPITAL_NOT_SPECIFIED");
  if (!(finite(mandate.maxDailyLossInr) && mandate.maxDailyLossInr > 0)) reasons.push("NO_POSITIVE_LOSS_BUDGET_AUTHORIZED");
  if (!(finite(mandate.maxTradeLossInr) && mandate.maxTradeLossInr > 0)) reasons.push("TRADE_RISK_BUDGET_NOT_AUTHORIZED");
  if (finite(strategy?.maxTerminalLossInr) && finite(mandate.maxTradeLossInr) && strategy.maxTerminalLossInr > mandate.maxTradeLossInr) reasons.push("TERMINAL_RISK_OVER_BUDGET");
  if (evidence.status !== "INDEPENDENTLY_APPROVED" || !evidence.artifactHash || !evidence.validationReportId) reasons.push("NO_APPROVED_AFTER_COST_EDGE");
  // Deliberately not an execution gateway. Even complete input is a review card;
  // portfolio suitability, live margin, settlement and operator review remain.
  return { status: reasons.length ? "RESEARCH_ONLY" : "MANUAL_REVIEW_REQUIRED", actionable: false, permittedOrderQuantity: 0,
    reasons, mode: "MANUAL_RECOMMENDATIONS_NO_BROKER_AUTOMATION" };
}
module.exports = { analyzeOptionStrategy, recommendationReadiness };
