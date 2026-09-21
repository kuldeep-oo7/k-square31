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
function round2(v) {
  return Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null;
}

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
  const chartResult = scanChartPatterns(historicalBars);

  // 3. 10 Advanced Quant Formulas
  const closePrices = historicalBars.map(b => Number(b.close || b.c || spot));
  const hurst = calculateHurstExponent(closePrices);
  const vpin = calculateVpin(historicalBars);
  const er = calculateKaufmanER(closePrices);
  const ou = calculateOuHalfLife(closePrices);
  const halfLifeVal = Number.isFinite(ou?.halfLifeDays) ? ou.halfLifeDays : 4.5;
  // VPIN resolves for 2 of 212 names: the bucketed order-flow imbalance it
  // needs is not in a daily bar. Pass null so the fusion SKIPS the term, rather
  // than 0.20 which quietly hands every name the same small bonus.
  const vpinVal = Number.isFinite(vpin?.vpin) ? vpin.vpin : null;

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
    // 0.50 is neutral and contributes nothing. This used to read 0.65, a
    // standing bullish tilt applied to all 210 names from no source at all.
    sentimentScore: 0.50
  });

  // 6. K²-Lang Quantitative Rule Verification
  const k2Context = {
    MACRO_GATE: macroState.severity,
    INDIA_VIX: Number(macroRadar.indiaVix?.price || 12.5),
    HURST: hurst,
    VPIN: vpin.vpin,
    ER: er,
    PATTERN: chartResult.primaryPattern?.pattern || "NONE",
    CANDLE: candleResult.primaryPattern || "NONE",
    NEURAL_ALPHA: neuralResult.neuralAlphaScore,
    SPOT: spot
  };
  const k2Result = executeK2Strategy(CANONICAL_K2_STRATEGY, k2Context);

  // 7. Composite Institutional Score (0 - 100)
  // Weighted: 35% Neural 1D-CNN + 25% Candlestick/Chart + 25% Quant Formulas + 15% Macro/GARCH
  // CONTINUOUS COMPONENTS, not switches.
  //
  // This expression previously collapsed four of its six inputs to a two-valued
  // constant: (hurst > 0.55 ? 85 : 50), (vpin < 0.25 ? 85 : 50), the chart
  // detector to (pattern ? 80 : 50), and the whole GARCH model to
  // (regime === "MODERATE_VOL" ? 85 : 50). A Hurst exponent estimated to four
  // decimals and a name at 0.551 scored identically to one at 0.950. Four of
  // six terms therefore carried one bit of information each, and the precision
  // every one of those models computes was discarded at the moment it mattered.
  //
  // The raw values now travel out of this function untouched, and universe-210
  // ranks each one CROSS-SECTIONALLY across the whole universe before combining
  // them. Ranking is the right transform here because these quantities live on
  // incomparable scales -- a Hurst of 0.6 and a VPIN of 0.2 mean nothing
  // against each other until both are expressed as a position in their own
  // distribution -- and because a rank has no free parameters to tune.
  //
  // Directions, applied at ranking time:
  //   hurst        higher is better (persistent trend)
  //   vpin         LOWER is better (less toxic order flow) -> negated
  //   garchVol     a BAND is better, not a direction; distance from the centre
  //                of the preferred regime is negated so closer ranks higher
  //   chart/candle higher is better
  const IDEAL_ANNUAL_VOL = 0.18;   // centre of the old "MODERATE_VOL" band
  const forecastVol = Number(garch.forecastedAnnualizedVol);
  const rawComponents = {
    neural: Number(neuralResult.neuralAlphaScore),
    candle: Number(candleResult.score) * 100,
    chart: Number(chartResult.primaryPattern?.confidence ?? (chartResult.primaryPattern ? 0.5 : 0)) * 100,
    hurst: Number(hurst),
    vpinNegated: Number.isFinite(Number(vpin.vpin)) ? -Number(vpin.vpin) : null,
    volBandCloseness: Number.isFinite(forecastVol) && forecastVol > 0
      ? -Math.abs(Math.log(forecastVol / IDEAL_ANNUAL_VOL))
      : null
  };

  // Fallback only: if a caller uses this scanner standalone, without the
  // cross-sectional pass, the old blended score is still produced so nothing
  // breaks. The deployed path overwrites it with the ranked version.
  // MEASURED ACROSS THE LIVE UNIVERSE, 2026-09-20, and rebuilt on what was found.
  //
  // The previous formula spent 20% of its weight on two terms that were
  // CONSTANT for all 210 names: chart resolved to 50 everywhere because no
  // symbol reports a dominant pattern, and vpin to 50 everywhere because VPIN
  // is not implemented and returns null (null < 0.25 is false). A constant adds
  // the same ten points to every score and ranks nothing, while the published
  // componentWeights claimed it was doing a fifth of the work.
  //
  // It also binarised continuous evidence. Hurst carried 160 distinct values
  // across the universe and was collapsed to {50, 85} on a single threshold, so
  // 0.549 and 0.843 scored identically while 0.549 and 0.551 scored 35 apart.
  // That is a hard boundary through the middle of a noisy estimate.
  //
  // So: dead terms carry no weight instead of a hidden constant, and continuous
  // evidence stays continuous. This is a DEFECT FIX, not a validated
  // improvement -- the entry signal still has no measured edge (out-of-sample
  // t = 1.25 against a 1.6648 hurdle) and nothing here changes that.
  const liveWeights = { neural: 0.35, pattern: 0.15, hurst: 0.25, garch: 0.25 };

  // Hurst maps continuously over [0.35, 0.75]: trending names score higher, and
  // a name just over the old 0.55 line no longer leaps 35 points past one just
  // under it.
  const hurstScore = Number.isFinite(hurst)
    ? 50 + 35 * Math.max(0, Math.min(1, (hurst - 0.35) / 0.40))
    : 50;

  // GARCH, 2026-09-21. This term was a THREE-VALUED STEP FUNCTION --
  // {LOW 65, MODERATE 85, HIGH 40} off a label cut at 15% and 28% -- while the
  // forecast it reads from carried 202 distinct values across 212 names. On a
  // 25% weight that one step drove 61% of the cross-sectional spread of the
  // non-neural terms, and two names either side of 28.0% vol scored 45 points
  // apart. It is the same binarisation already removed from Hurst, left behind.
  //
  // The intent is kept exactly: a BAND is preferred, not a direction, so the
  // score falls with distance from the centre of that band in log space. The
  // endpoints are unchanged -- 18% annualised still scores 85, and one e-fold
  // away in either direction still scores 40 -- so nothing is retuned, only the
  // resolution between them is restored. `volBandCloseness` in rawComponents
  // computed this already and nothing consumed it.
  const IDEAL_LOG_TOLERANCE = 1.0;
  const regimeScore = Number.isFinite(forecastVol) && forecastVol > 0
    ? 85 - 45 * Math.min(1, Math.abs(Math.log(forecastVol / IDEAL_ANNUAL_VOL)) / IDEAL_LOG_TOLERANCE)
    : 50;

  // PATTERN, 2026-09-21. Candlesticks and chart geometry are the same kind of
  // evidence read off the same bars, so they SHARE the 15% that candles alone
  // used to hold. No new weight is introduced and no existing weight moves: when
  // no chart pattern is present -- 110 of 212 names -- this is exactly the old
  // candle term.
  //
  // The chart term is SIGNED BY BIAS. Reading only the confidence would have
  // scored a confirmed DOUBLE_TOP, which is bearish, at 82 out of 100 on a desk
  // that buys. An unconfirmed pattern is discounted to 60% of its distance from
  // neutral, since a pattern that has not broken its neckline is a hypothesis.
  const pat = chartResult.primaryPattern;
  const chartScore = pat && (pat.bias === "BULLISH" || pat.bias === "BEARISH")
    ? 50 + (pat.bias === "BULLISH" ? 1 : -1)
         * Number(pat.confidence || 0.5) * 35 * (pat.confirmed === true ? 1 : 0.6)
    : null;
  const patternScore = chartScore === null
    ? rawComponents.candle
    : (rawComponents.candle + chartScore) / 2;

  let compScore = (rawComponents.neural * liveWeights.neural) +
                  (patternScore * liveWeights.pattern) +
                  (hurstScore * liveWeights.hurst) +
                  (regimeScore * liveWeights.garch);

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
    rawComponents,
    // What the formula ACTUALLY weights. The previous list named six components
    // when two of them were constants, which made it a description of an
    // intention rather than of the code beneath it.
    componentWeights: { neural: 0.35, pattern: 0.15, hurst: 0.25, garchVolBand: 0.25 },
    componentScores: {
      neural: round2(rawComponents.neural),
      candle: round2(rawComponents.candle),
      chart: chartScore === null ? null : round2(chartScore),
      pattern: round2(patternScore),
      hurst: round2(hurstScore),
      garchVolBand: round2(regimeScore)
    },
    inactiveComponents: {
      vpin: "Order-flow toxicity needs bucketed trade prints; a daily bar cannot "
        + "produce it and it resolves for 2 of 212 names. It is SKIPPED in the "
        + "neural fusion rather than defaulted, and carries no weight here."
    },
    compositeScore: compScore,
    neuralScore: neuralResult.neuralAlphaScore,
    rawActivationScore: neuralResult.rawActivationScore,
    rawZ: neuralResult.rawZ,
    neuralMotif: neuralResult.salientMotif,
    neuralRegime: neuralResult.predictedRegime,
    candlestickPattern: candleResult.primaryPattern || "CONSOLIDATION",
    candlestickSummary: candleResult.candlestickSummary,
    chartPattern: chartResult.primaryPattern?.pattern || "RANGE",
    chartPatternBias: chartResult.primaryPattern?.bias || "NEUTRAL",
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
      vpin: vpinVal === null ? null : vpinVal.toFixed(2),
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
