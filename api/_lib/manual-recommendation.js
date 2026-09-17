"use strict";
// Quote-backed research tickets. No guessed contracts, premiums, Greeks or risk approval.
const { evaluateSentimentAndEventRisk } = require("./sentiment-risk");
const { analyzeOptionStrategy, recommendationReadiness } = require("./option-strategy");
const { isDate } = require("./indian-instruments");
const finite = n => typeof n === "number" && Number.isFinite(n);
function roundToTick(price, tickSize) {
  return finite(price) && price > 0 && finite(tickSize) && tickSize > 0
    ? Number((Math.round(price / tickSize) * tickSize).toFixed(8)) : null;
}
function verifiedContract(catalogue, key, now) {
  const received = Date.parse(catalogue?.fetchedAt);
  if (!finite(received) || received > now || now - received > 86400000) return null;
  const matches = (catalogue.instruments || []).filter(i => i.key === key);
  const c = matches.length === 1 ? matches[0] : null;
  if (!c || !["EQ", "FUT", "CE", "PE"].includes(c.type) || !Number.isSafeInteger(c.lotSize) || c.lotSize < 1
      || !finite(c.tickSize) || c.tickSize <= 0 || !c.tradingSymbol || !c.exchange) return null;
  if (c.type !== "EQ" && (!isDate(c.expiry) || Date.parse(c.expiry + "T00:00:00+05:30") <= now)) return null;
  return c;
}
function verifiedQuote(quote, contract, now) {
  const t = Date.parse(quote?.eventAt);
  return Boolean(contract && quote?.instrumentKey === contract.key && quote.provider && quote.timestampKind === "EXCHANGE"
    && quote.marketOpen === true && finite(t) && t <= now && now - t <= 5000
    && finite(quote.bid) && finite(quote.ask) && quote.bid > 0 && quote.ask >= quote.bid
    && [quote.bid, quote.ask].every(p => Math.abs(p / contract.tickSize - Math.round(p / contract.tickSize)) < 1e-6));
}
function generateManualRecommendation(input = {}) {
  const now = input.now ?? Date.now(), reasons = [];
  const fail = reason => ({ status: "BLOCKED", actionable: false, permittedOrderQuantity: 0, reason,
    reasons: [reason], zerodhaFastCopy: null, generatedAt: finite(now) ? new Date(now).toISOString() : null });
  if (!finite(now)) return fail("INVALID_CLOCK");
  const contract = verifiedContract(input.catalogue, input.contractKey, now);
  if (!contract) return fail("EXACT_CURRENT_CATALOGUE_CONTRACT_REQUIRED");
  if (!verifiedQuote(input.quote, contract, now)) return fail("FRESH_EXACT_CONTRACT_BID_ASK_REQUIRED");
  const action = input.action;
  if (!["BUY", "SELL"].includes(action)) return fail("EXPLICIT_BUY_OR_SELL_REQUIRED");
  if (contract.type === "EQ" && action === "SELL") return fail("OVERNIGHT_CASH_SHORT_NOT_SUPPORTED");
  const lots = input.lots;
  if (!Number.isSafeInteger(lots) || lots < 1) return fail("POSITIVE_WHOLE_LOTS_REQUIRED");
  const quantity = lots * contract.lotSize;
  if (!Number.isSafeInteger(quantity)) return fail("QUANTITY_OVERFLOW");
  const price = action === "BUY" ? input.quote.ask : input.quote.bid;
  const sentimentRisk = evaluateSentimentAndEventRisk({ ...input.sentimentContext,
    symbol: contract.underlying || contract.tradingSymbol, assetClass: contract.type === "EQ" ? "CASH" : "DERIVATIVE",
    now, holdingSessions: input.holdingSessions });
  if (!sentimentRisk.allowedToTrade) reasons.push(...sentimentRisk.riskFlags);
  let strategy = null;
  if (contract.type !== "EQ") {
    const leg = (c, q, side) => ({ contractKey: c.key, underlying: c.underlying, exchange: c.exchange,
      expiry: c.expiry, type: c.type, strike: c.strike, tickSize: c.tickSize, lotSize: c.lotSize,
      quantity, side, price: side === "BUY" ? q.ask : q.bid });
    const legs = [leg(contract, input.quote, action)];
    if (input.hedge) {
      const h = verifiedContract(input.catalogue, input.hedge.contractKey, now);
      if (!h || !verifiedQuote(input.hedge.quote, h, now)) return fail("HEDGE_CONTRACT_AND_QUOTE_UNVERIFIED");
      if (!["BUY", "SELL"].includes(input.hedge.action)) return fail("HEDGE_SIDE_REQUIRED");
      legs.push(leg(h, input.hedge.quote, input.hedge.action));
    }
    strategy = analyzeOptionStrategy({ ...input.pricingAssumptions, legs,
      roundTripCostsInr: input.roundTripCostsInr, underlyingPrice: input.underlyingPrice });
    if (!strategy.available) reasons.push(strategy.reason);
  } else if (!finite(input.roundTripCostsInr) || input.roundTripCostsInr < 0) reasons.push("ALL_LEG_COST_ESTIMATE_REQUIRED");
  const readiness = recommendationReadiness({ strategy: strategy || { available: !reasons.length,
    maxTerminalLossInr: price * quantity + (input.roundTripCostsInr || 0) }, mandate: input.mandate,
    catalogueVerified: true, quotesVerified: true, evidence: input.evidence });
  reasons.push(...readiness.reasons);
  return { symbol: contract.underlying || contract.tradingSymbol, tradingSymbol: contract.tradingSymbol,
    contractKey: contract.key, exchange: contract.exchange, expiry: contract.expiry,
    assetClass: contract.type === "EQ" ? "CASH" : contract.type === "FUT" ? "FUTURES" : "OPTION",
    action, optionType: ["CE", "PE"].includes(contract.type) ? contract.type : null,
    lotSize: contract.lotSize, researchQuantity: quantity, entryTrigger: price, quoteAsOf: input.quote.eventAt,
    sentimentRisk, strategy, status: reasons.length ? "RESEARCH_ONLY" : "MANUAL_REVIEW_REQUIRED",
    actionable: false, permittedOrderQuantity: 0, zerodhaFastCopy: null,
    targetRung1: null, targetRung2: null, runnerTarget: null, stopLoss: null,
    maxRiskInr: strategy?.maxTerminalLossInr ?? null, capitalRequiredInr: null,
    reasons: [...new Set(reasons)], generatedAt: new Date(now).toISOString(),
    limitations: ["Research quantity is not approved sizing. A stop price does not cap loss.",
      "Bid/ask is an observation, not a fill; depth, impact, margin and all-leg execution need validation.",
      "Terminal payoff is conditional on matching filled legs, settlement and estimated costs; it is not zero-loss protection."] };
}
module.exports = { generateManualRecommendation, roundToTick, verifiedContract, verifiedQuote };
