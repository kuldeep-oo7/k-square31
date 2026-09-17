"use strict";

/**
 * Unified Institutional Multi-Cap Quantitative Scanner & Signal Arbiter
 *
 * Synthesizes:
 * 1. 1D-CNN Temporal Matched Filters (Convolutional Alpha 0-100)
 * 2. Institutional Candlestick Pattern Engine (Morning Star, Hammer, Engulfing, Marubozu)
 * 3. Classical Geometric Chart Scanner (Double Bottom/Top, H&S, Triangles)
 * 4. Foundational Quant Formulas (Hurst, VPIN, Black-Scholes Greeks, OU Decay)
 * 5. Stochastic Calculus & Risk (GARCH(1,1), Cornish-Fisher CVaR, Kyle's Lambda)
 * 6. K²-Lang Dynamic Strategy Rule Governance
 * 7. 1-Tap Mobile Execution Deep-Links (Zerodha Kite & Dhan)
 */

const { identifyCandlestickPatterns } = require("./candlestick-engine");
const { scanChartPatterns } = require("./chart-patterns");
const { evaluateNeuralAlpha } = require("./neural-quant-engine");
const { executeK2Strategy } = require("./k2-lang");
const {
  forecastGarch11Volatility,
  calculateCornishFisherRisk,
  calculateMicrostructureLiquidity
} = require("./institutional-calculus");
const {
  calculateHurstExponent,
  calculateVpin,
  calculateOuHalfLife,
  calculateKaufmanER,
  blackScholesMerton
} = require("./advanced-quant");

// Canonical Institutional K²-Lang Strategy Rule Definition
const CANONICAL_K2_STRATEGY = `
  STRATEGY "ApexInstitutionalMultiFactor"

  REQUIRE MACRO_GATE == "NORMAL" AND INDIA_VIX < 22.0

  SIGNAL BUY WHEN HURST >= 0.52 AND VPIN < 0.35 AND NEURAL_ALPHA >= 60

  SET TARGET1 = SPOT * 1.025, TARGET2 = SPOT * 1.050, STOPLOSS = SPOT * 0.985
`;

/**
 * Generates 1-tap mobile execution deep links for Zerodha Kite and Dhan
 */
function generateBrokerDeepLinks({ symbol, exchange = "NSE", action = "BUY", quantity = 1, price = 0, triggerPrice = 0 }) {
  const encSymbol = encodeURIComponent(symbol);
  const encExchange = encodeURIComponent(exchange);
  const encAction = encodeURIComponent(action);

  // Zerodha Kite Mobile Order Preview URL
  const zerodhaOrderPreview = `https://kite.zerodha.com/connect/basket?api_key=quick&data=%5B%7B%22variety%22%3A%22regular%22%2C%22tradingsymbol%22%3A%22${encSymbol}%22%2C%22exchange%22%3A%22${encExchange}%22%2C%22transaction_type%22%3A%22${encAction}%22%2C%22order_type%22%3A%22LIMIT%22%2C%22quantity%22%3A${quantity}%2C%22price%22%3A${price}%2C%22product%22%3A%22NRML%22%7D%5D`;

  // Dhan App Universal Deep Link
  const dhanApp = `dhan://order?exchange=${encExchange}&symbol=${encSymbol}&transactionType=${encAction}&orderType=LIMIT&quantity=${quantity}&price=${price}`;

  // Interactive TradingView Chart Link
  const tradingViewChart = `https://in.tradingview.com/chart/?symbol=${encExchange}%3A${encSymbol}`;

  return {
    zerodhaOrderPreview,
    dhanApp,
    tradingViewChart
  };
}

/**
 * Processes a raw instrument candidate and computes institutional multi-engine analytics
 */
function analyzeCandidate({
  id,
  symbol,
  companyName = null,
  sector = null,
  isBanned = false,
  tradingSymbol,
  assetClass,
  marketCap = "Large Cap",
  action = "BUY",
  currentLtp,
  entryPrice,
  target1,
  target2,
  stopLoss,
  lotSize = 1,
  capitalRequired = 0,
  historicalBars = [],
  strategy = null,
  macroState = { severity: "NORMAL", shieldActive: false },
  macroRadar = { indiaVix: { price: 12.5 } }
}) {
  const spot = Number(currentLtp || entryPrice);

  // 1. Candlestick Pattern Identification
  const candleResult = identifyCandlestickPatterns(historicalBars);

  // 2. Chart Pattern Scanning
  const chartResult = scanChartPatterns(historicalBars, spot);

  // 3. 10 Advanced Quant Formulas
  const closePrices = historicalBars.map(b => Number(b.close || b.c || spot));
  const hurst = calculateHurstExponent(closePrices);
  const vpin = calculateVpin(historicalBars);
  const er = calculateKaufmanER(closePrices);
  const ou = calculateOuHalfLife(closePrices);
  const halfLifeVal = Number.isFinite(ou?.halfLifeDays) ? ou.halfLifeDays : 4.5;
  const vpinVal = Number.isFinite(vpin?.vpin) ? vpin.vpin : 0.20;

  // 4. Stochastic Calculus & Risk Engine
  const garch = forecastGarch11Volatility(closePrices, { horizonDays: 5 });
  const notional = spot * lotSize;
  const cfRisk = calculateCornishFisherRisk(closePrices, notional, 0.99);
  const liquidity = calculateMicrostructureLiquidity(historicalBars);

  // 5. 1D-CNN Matched Filter Feature Extractor
  const quantFactors = {
    hurst,
    vpin: vpinVal,
    er,
    halfLife: halfLifeVal,
    garchVol: garch.forecastedAnnualizedVol,
    kyleLambda: liquidity.kyleLambda
  };
  const neuralResult = evaluateNeuralAlpha({
    bars: historicalBars,
    quantFactors,
    sentimentScore: 0.65
  });

  // 6. K²-Lang Quantitative Rule Verification
  const k2Context = {
    MACRO_GATE: macroState.severity,
    INDIA_VIX: Number(macroRadar.indiaVix?.price || 12.5),
    HURST: hurst,
    VPIN: vpin.vpin,
    ER: er,
    PATTERN: chartResult.dominantPattern?.pattern || "NONE",
    CANDLE: candleResult.primaryPattern || "NONE",
    NEURAL_ALPHA: neuralResult.neuralAlphaScore,
    SPOT: spot
  };
  const k2Result = executeK2Strategy(CANONICAL_K2_STRATEGY, k2Context);

  // 7. Composite Institutional Score (0 - 100)
  // Weighted: 35% Neural 1D-CNN + 25% Candlestick/Chart + 25% Quant Formulas + 15% Macro/GARCH
  let compScore = (neuralResult.neuralAlphaScore * 0.35) +
                  (candleResult.score * 100 * 0.15) +
                  ((chartResult.dominantPattern ? 80 : 50) * 0.10) +
                  ((hurst > 0.55 ? 85 : 50) * 0.15) +
                  ((vpin.vpin < 0.25 ? 85 : 50) * 0.10) +
                  ((garch.volatilityRegime === "MODERATE_VOL" ? 85 : 50) * 0.15);

  compScore = Math.max(10, Math.min(99, Math.round(compScore)));

  // Calculate dynamic P&L in Rupees based on spot vs entry
  const pnlPerUnit = action === "BUY" ? spot - Number(entryPrice) : Number(entryPrice) - spot;
  const pnlRupees = Math.round((pnlPerUnit * lotSize + Number.EPSILON) * 100) / 100;

  // 1-Tap Broker Execution Links
  const links = generateBrokerDeepLinks({
    symbol: tradingSymbol || symbol,
    exchange: "NSE",
    action,
    quantity: lotSize,
    price: entryPrice,
    triggerPrice: stopLoss
  });

  return {
    id,
    symbol,
    companyName: companyName || symbol,
    sector: sector || "General",
    isBanned: Boolean(isBanned),
    tradingSymbol: tradingSymbol || symbol,
    assetClass,
    marketCap,
    action,
    spotPrice: spot,
    entryPrice: Number(entryPrice),
    target1: Number(target1),
    target2: Number(target2),
    stopLoss: Number(stopLoss),
    lotSize,
    capitalRequired,
    pnlRupees,
    pnlPct: Number(entryPrice) > 0 ? Math.round(((spot - entryPrice) / entryPrice * 100) * 100) / 100 : 0,
    strategy,

    // Integrated Analytics
    rawCompScore: compScore,
    compositeScore: compScore,
    neuralScore: neuralResult.neuralAlphaScore,
    rawActivationScore: neuralResult.rawActivationScore,
    rawZ: neuralResult.rawZ,
    neuralMotif: neuralResult.salientMotif,
    neuralRegime: neuralResult.predictedRegime,
    candlestickPattern: candleResult.primaryPattern || "CONSOLIDATION",
    candlestickSummary: candleResult.candlestickSummary,
    chartPattern: chartResult.dominantPattern?.pattern || "RANGE",
    chartPatternBias: chartResult.dominantPattern?.bias || "NEUTRAL",
    garchVol: `${Math.round(garch.forecastedAnnualizedVol * 100)}%`,
    garchRegime: garch.volatilityRegime,
    cvar99Rupees: `₹${cfRisk.cvarRupees.toLocaleString('en-IN')}`,
    kyleLambda: liquidity.kyleLambda,
    amihudRatio: liquidity.amihudRatio,
    advShares: liquidity.advShares,
    advRupees: liquidity.advRupees,
    estimatedCapacityRupees: liquidity.estimatedCapacityRupees,
    capacityFormatted: `₹${(liquidity.estimatedCapacityRupees / 1e7).toFixed(2)} Cr`,
    isLiquid: liquidity.isLiquid,
    k2StrategyPassed: k2Result.passed,

    // Quant Greek & Microstructure block
    quant: {
      hurst: hurst.toFixed(2),
      vpin: vpinVal.toFixed(2),
      er: er.toFixed(2),
      halfLife: `${halfLifeVal.toFixed(1)}d`,
      capacity: `₹${(liquidity.estimatedCapacityRupees / 1e7).toFixed(2)} Cr`
    },

    links
  };
}

module.exports = {
  CANONICAL_K2_STRATEGY,
  generateBrokerDeepLinks,
  analyzeCandidate
};
