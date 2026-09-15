"use strict";

/**
 * Manual Recommendation Engine for K² Range Desk.
 * Generates human-executable trade tickets for Zerodha Kite (Cash, Futures, and Options)
 * with exact limit entry triggers, multi-tier profit targets (Target 1, 2, Runner),
 * strict stop-loss levels, defined-risk hedging, and pre-trade corporate event / sentiment checks.
 */

const { evaluateSentimentAndEventRisk } = require("./sentiment-risk");
const { europeanOption } = require("./option-pricing");
const { analyzeOptionStrategy } = require("./option-strategy");

function roundToTick(price, tickSize = 0.05) {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.05;
  return Math.round(price / tick) * tick;
}

function fixed(val, decimals = 2) {
  if (!Number.isFinite(val)) return "—";
  return Number(val).toFixed(decimals);
}

/**
 * Generates an institutional-grade, human-executable trade ticket for Zerodha Kite.
 *
 * @param {Object} input
 * @param {string} input.symbol - Ticker symbol (e.g. 'NIFTY', 'APLAPOLLO')
 * @param {number} input.spotPrice - Underlying cash/spot reference price
 * @param {string} [input.direction="LONG"] - "LONG" or "SHORT"
 * @param {string} [input.assetClass="OPTION"] - "OPTION" | "FUTURES" | "CASH"
 * @param {number} [input.strike] - Optional explicit strike
 * @param {string} [input.expiry="2026-09-24"] - Contract expiry date (YYYY-MM-DD)
 * @param {number} [input.lotSize=25] - Contract lot size (e.g. 25 for NIFTY, 1 for Cash)
 * @param {number} [input.tickSize=0.05] - Price tick size
 * @param {number} [input.holdingSessions=5] - Expected holding duration in trading sessions
 * @param {number} [input.volatility=0.18] - Implied or realized annualized volatility
 * @param {Array<number>} [input.targetPcts] - Step targets (e.g. [1.025, 1.05, 1.10])
 * @param {number} [input.stopLossPct=0.985] - Stop loss fraction (e.g. 0.985 for -1.5%)
 * @param {Object} [input.sentimentContext] - Optional news, event calendar, or ban list
 * @returns {Object} Structured recommendation ticket
 */
function generateManualRecommendation({
  symbol,
  spotPrice,
  direction = "LONG",
  assetClass = "OPTION",
  strike = null,
  entryPrice = null,
  expiry = "2026-09-24",
  lotSize = 25,
  tickSize = 0.05,
  holdingSessions = 5,
  volatility = 0.18,
  targetPcts = null,
  stopLossPct = null,
  sentimentContext = {}
} = {}) {
  const cleanSymbol = String(symbol || "").trim().toUpperCase();
  const spot = Number(spotPrice);
  const isLong = direction.toUpperCase() !== "SHORT";

  if (!cleanSymbol || !Number.isFinite(spot) || spot <= 0) {
    return {
      status: "INVALID",
      actionable: false,
      reason: "VALID_SYMBOL_AND_POSITIVE_SPOT_REQUIRED"
    };
  }

  // 1. Corporate Actions & News Sentiment Gate
  const sentimentRisk = evaluateSentimentAndEventRisk({
    symbol: cleanSymbol,
    holdingSessions,
    now: sentimentContext.now || Date.now(),
    events: sentimentContext.events || null,
    newsHeadlines: sentimentContext.newsHeadlines || [],
    foBanList: sentimentContext.foBanList || []
  });

  // Default targets & stop if not provided (Long vs Short)
  const defaultTargets = isLong ? [1.025, 1.055, 1.12] : [0.975, 0.945, 0.88];
  const defaultStop = isLong ? 0.985 : 1.015;
  const resolvedTargets = Array.isArray(targetPcts) && targetPcts.length >= 2 ? targetPcts : defaultTargets;
  const resolvedStop = Number.isFinite(stopLossPct) ? stopLossPct : defaultStop;

  // Spot price levels
  const spotStop = roundToTick(spot * resolvedStop, tickSize);
  const spotT1 = roundToTick(spot * resolvedTargets[0], tickSize);
  const spotT2 = roundToTick(spot * resolvedTargets[1], tickSize);
  const spotRunner = roundToTick(spot * (resolvedTargets[2] || resolvedTargets[1] * (isLong ? 1.05 : 0.95)), tickSize);

  let ticket = null;

  if (assetClass.toUpperCase() === "OPTION") {
    // Select ATM strike rounded to nearest strike step
    const strikeStep = spot > 10000 ? 100 : spot > 2000 ? 50 : spot > 500 ? 20 : 10;
    const selectedStrike = Number.isFinite(strike) && strike > 0
      ? strike
      : Math.round(spot / strikeStep) * strikeStep;

    const optionType = isLong ? "CE" : "PE";
    const action = "BUY";
    const expiryFormatted = expiry.replace(/-/g, "").slice(2, 6) + expiry.slice(8, 10);
    const tradingSymbol = `${cleanSymbol}${expiry.slice(2, 4)}${new Date(expiry).toLocaleString("en-US", { month: "short" }).toUpperCase()}${selectedStrike}${optionType}`;

    // Black-Scholes estimate for entry premium & targets
    const tYears = Math.max(0.005, (new Date(expiry) - Date.now()) / (365.25 * 24 * 3600 * 1000));
    const pricing = europeanOption({
      model: "BSM",
      underlyingPrice: spot,
      strike: selectedStrike,
      timeToExpiryYears: tYears,
      riskFreeRate: 0.065,
      dividendYield: 0.01,
      volatility,
      optionType
    });

    const estEntryPremium = (entryPrice && Number(entryPrice) > 0)
      ? roundToTick(Number(entryPrice), tickSize)
      : (pricing.available ? roundToTick(pricing.price, tickSize) : roundToTick(spot * 0.02, tickSize));
    const delta = pricing.available ? Math.abs(pricing.delta) : 0.5;

    // Premium rungs based on Delta movement
    const estStopPremium = roundToTick(Math.max(tickSize, estEntryPremium - Math.abs(spot - spotStop) * delta), tickSize);
    const estT1Premium = roundToTick(estEntryPremium + Math.abs(spotT1 - spot) * delta, tickSize);
    const estT2Premium = roundToTick(estEntryPremium + Math.abs(spotT2 - spot) * delta, tickSize);
    const estRunnerPremium = roundToTick(estEntryPremium + Math.abs(spotRunner - spot) * delta, tickSize);

    const premiumRequiredPerLot = roundToTick(estEntryPremium * lotSize, 1);
    const maxRiskPerLot = roundToTick((estEntryPremium - estStopPremium) * lotSize, 1);

    // Defined-Risk Hedge Leg (Spread structure: sell OTM wing)
    const hedgeStrike = isLong ? selectedStrike + strikeStep * 2 : selectedStrike - strikeStep * 2;
    const hedgeTradingSymbol = `${cleanSymbol}${expiry.slice(2, 4)}${new Date(expiry).toLocaleString("en-US", { month: "short" }).toUpperCase()}${hedgeStrike}${optionType}`;
    const hedgePricing = europeanOption({
      model: "BSM",
      underlyingPrice: spot,
      strike: hedgeStrike,
      timeToExpiryYears: tYears,
      riskFreeRate: 0.065,
      dividendYield: 0.01,
      volatility,
      optionType
    });
    const estHedgePremium = hedgePricing.available ? roundToTick(hedgePricing.price, tickSize) : roundToTick(estEntryPremium * 0.4, tickSize);
    const netDebitPerLot = roundToTick((estEntryPremium - estHedgePremium) * lotSize, 1);

    const fastCopy = `${action} ${tradingSymbol} | QTY: ${lotSize} (1 Lot) | LIMIT: ₹${fixed(estEntryPremium)} | SL: ₹${fixed(estStopPremium)} | T1: ₹${fixed(estT1Premium)} | T2: ₹${fixed(estT2Premium)} | RUNNER: ₹${fixed(estRunnerPremium)}`;

    ticket = {
      id: `REC-${cleanSymbol}-${optionType}-${selectedStrike}-${Date.now().toString(36).toUpperCase()}`,
      symbol: cleanSymbol,
      underlyingSpot: spot,
      assetClass: "OPTION",
      action: "BUY",
      tradingSymbol,
      optionType,
      strike: selectedStrike,
      expiry,
      lotSize,
      exchange: "NFO",
      orderType: "LIMIT",
      entryTrigger: estEntryPremium,
      stopLoss: estStopPremium,
      targetRung1: estT1Premium,
      targetRung2: estT2Premium,
      runnerTarget: estRunnerPremium,
      holdingSessions,
      capitalRequiredInr: premiumRequiredPerLot,
      maxRiskInr: maxRiskPerLot,
      zerodhaFastCopy: fastCopy,
      definedRiskHedge: {
        strategyType: isLong ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD",
        primaryLeg: `BUY ${tradingSymbol} @ ₹${fixed(estEntryPremium)}`,
        hedgeLeg: `SELL ${hedgeTradingSymbol} @ ₹${fixed(estHedgePremium)}`,
        netDebitPerLotInr: netDebitPerLot,
        maximumLossCappedInr: netDebitPerLot,
        breakEvenUnderlying: isLong ? selectedStrike + (netDebitPerLot / lotSize) : selectedStrike - (netDebitPerLot / lotSize)
      }
    };
  } else if (assetClass.toUpperCase() === "FUTURES") {
    const tradingSymbol = `${cleanSymbol}${expiry.slice(2, 4)}${new Date(expiry).toLocaleString("en-US", { month: "short" }).toUpperCase()}FUT`;
    const action = isLong ? "BUY" : "SELL";
    const fastCopy = `${action} ${tradingSymbol} | QTY: ${lotSize} | LIMIT: ₹${fixed(spot)} | SL: ₹${fixed(spotStop)} | T1: ₹${fixed(spotT1)} | T2: ₹${fixed(spotT2)} | RUNNER: ₹${fixed(spotRunner)}`;

    ticket = {
      id: `REC-${cleanSymbol}-FUT-${Date.now().toString(36).toUpperCase()}`,
      symbol: cleanSymbol,
      underlyingSpot: spot,
      assetClass: "FUTURES",
      action,
      tradingSymbol,
      expiry,
      lotSize,
      exchange: "NFO",
      orderType: "LIMIT",
      entryTrigger: spot,
      stopLoss: spotStop,
      targetRung1: spotT1,
      targetRung2: spotT2,
      runnerTarget: spotRunner,
      holdingSessions,
      capitalRequiredInr: roundToTick(spot * lotSize * 0.22, 100), // ~22% margin
      maxRiskInr: roundToTick(Math.abs(spot - spotStop) * lotSize, 1),
      zerodhaFastCopy: fastCopy,
      definedRiskHedge: {
        strategyType: isLong ? "PROTECTIVE_PUT" : "PROTECTIVE_CALL",
        hedgeLeg: `BUY ${cleanSymbol} ${isLong ? "PE" : "CE"} @ OTM Strike to lock tail risk`,
        maximumLossCappedInr: "Finite (Hedged against gap)"
      }
    };
  } else {
    // CASH Equity Delivery
    const action = "BUY";
    const fastCopy = `BUY ${cleanSymbol} (NSE EQ) | LIMIT: ₹${fixed(spot)} | SL: ₹${fixed(spotStop)} | T1: ₹${fixed(spotT1)} | T2: ₹${fixed(spotT2)} | RUNNER: ₹${fixed(spotRunner)}`;

    ticket = {
      id: `REC-${cleanSymbol}-EQ-${Date.now().toString(36).toUpperCase()}`,
      symbol: cleanSymbol,
      underlyingSpot: spot,
      assetClass: "CASH",
      action,
      tradingSymbol: cleanSymbol,
      exchange: "NSE",
      orderType: "LIMIT",
      lotSize: 1,
      entryTrigger: spot,
      stopLoss: spotStop,
      targetRung1: spotT1,
      targetRung2: spotT2,
      runnerTarget: spotRunner,
      holdingSessions,
      capitalRequiredInr: spot,
      maxRiskInr: roundToTick(Math.abs(spot - spotStop), 1),
      zerodhaFastCopy: fastCopy,
      definedRiskHedge: null
    };
  }

  return {
    ...ticket,
    sentimentRisk,
    status: sentimentRisk.allowedToTrade ? "ACTIVE" : "VETOED",
    actionable: sentimentRisk.allowedToTrade,
    reason: sentimentRisk.reason,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  generateManualRecommendation,
  roundToTick
};
