// Fuses the four independent readings of one name into a single instruction.
//
//   weekly cycle   what the desk's exact rule actually returned on this name
//   model          what boosted trees expect from the coming week
//   technical      the existing composite of trend, momentum and candles
//   fundamentals   event risk and balance-sheet asymmetry
//
// The order matters. Vetoes are checked before conviction is computed, because a
// results date inside the week or a model that expects a losing week cannot be
// outvoted by a strong-looking score. Conviction is only ever a way to size a
// trade the evidence has already cleared.

const crypto = require("node:crypto");
const { tradingWeeks, ladder, weeklyCycle, DEFAULT_CONFIG } = require("./weekly-cycle");
const { stockFutureTickSize } = require("./bhavcopy");
const { weeklyForecast, evaluateModelFitness } = require("./ml-model");
const { trendAlignment, trendGate, trendMetrics } = require("./trend");
const { carryScore } = require("./carry");
const { upside } = require("./upside");
const {
  calculateVpin,
  metaLabelConfidence
} = require("./advanced-quant");
const { scanChartPatterns } = require("./chart-patterns");

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function standAside(symbol, reason, evidence = {}) {
  return {
    symbol,
    action: "stand-aside",
    side: null,
    levels: [],
    entries: [],
    convictionPct: 0,
    expectedWeeklyPct: null,
    sizeMultiplier: 0,
    reasons: [reason],
    vetoes: evidence.vetoes || [],
    evidence
  };
}

// The live anchor is the first open of the week in progress, including a week
// that is only one session old - that open is what the ladder hangs from.
function currentAnchor(bars) {
  const weeks = tradingWeeks(bars, { minimumSessions: 1 });
  const week = weeks.at(-1);
  if (!week) return null;
  return {
    weekKey: week.weekKey,
    anchor: week.sessions[0].open,
    // Raw/adjusted divergence for the anchor session. Order prices must be raw;
    // see the note on `adjFactor` in weekly-cycle.js tradingWeeks().
    anchorAdjFactor: Number(week.sessions[0].adjFactor) > 0 ? Number(week.sessions[0].adjFactor) : 1,
    sessionsElapsed: week.sessions.length
  };
}

function convictionOf({ cycle, model, technical, fundamentals, trend, carry, side, config }) {
  const sideCycle = cycle[side];
  const target = Number(config.targetPct) || 2;
  const bestLevel = sideCycle.levels.find((entry) => entry.level === sideCycle.viableLevels[0]);
  const technicalScore = Number(technical?.score);
  const technicalAlignment = Number.isFinite(technicalScore)
    ? clamp((side === "short" ? -technicalScore : technicalScore) / 60)
    : 0;
  const balanceSheet = Number(fundamentals?.balanceSheetScore) || 0;
  // Carry is the only component that is not a forecast: the basis has to close
  // by expiry, so it is a known credit or cost on the week. It earns real weight
  // for that, taken from the components that merely re-read the same history.
  // It is supplied for the long side, so a short ladder takes the opposite sign.
  const carryForSide = carry?.ready
    ? { ...carry, weeklyPct: side === "short" ? -Number(carry.weeklyPct) : Number(carry.weeklyPct) }
    : null;

  const components = [
    ["Realised weekly edge", 22, clamp(Number(sideCycle.outOfSample.averageWeeklyPct) / target), `${sideCycle.outOfSample.averageWeeklyPct}% average out-of-sample week over ${sideCycle.outOfSample.weeks} weeks`],
    ["Target hit reliability", 16, clamp((Number(bestLevel?.lowerPct) - 50) / 30), `rung ${bestLevel?.level} hits its ${target}% target at least ${bestLevel?.lowerPct}% of the time with 95% confidence`],
    ["Trend alignment", 15, trendAlignment(trend, side), trend?.ready ? `12-month move ${trend.returnPct}%, ${round(trend.scaled, 2)} per unit of risk` : "not enough history to measure the trend"],
    ["Model expectation", 16, model?.trustworthy ? clamp(Number(model.expectedWeeklyPct) / target) : 0, model?.trustworthy ? `boosted trees expect ${model.expectedWeeklyPct}% this week` : "model did not clear its out-of-sample gate"],
    ["Model skill", 7, model?.trustworthy ? clamp(Number(model.validation.outOfSample.informationCoefficient) / 0.1) : 0, model?.trustworthy ? `out-of-sample information coefficient ${model.validation.outOfSample.informationCoefficient}` : "model is advisory-only"],
    ["Technical alignment", 6, technicalAlignment, Number.isFinite(technicalScore) ? `composite score ${round(technicalScore)} versus a ${side} ladder` : "no technical composite supplied"],
    ["Carry", 12, carryScore(carryForSide, target), carryForSide ? `futures at a ${carryForSide.state} of ${carryForSide.basisPct}%, worth ${carryForSide.weeklyPct}% to this side over the week` : "no contract price for this name"],
    ["Balance-sheet asymmetry", 6, clamp((side === "short" ? -balanceSheet : balanceSheet) + 0.5, 0, 1), fundamentals?.available ? `balance-sheet score ${balanceSheet}` : "fundamentals unavailable"]
  ].map(([name, weight, score, note]) => ({ name, weight, score: round(score, 4), contribution: round(weight * score, 2), note }));

  return { convictionPct: round(components.reduce((sum, item) => sum + Number(item.contribution), 0)), components };
}

function enforceHardVetoes({ symbol, vpinData, evidence = {} }) {
  // P0-2 REMEDIATION: The hand-written metaLabelConfidence formula is an uncalibrated
  // heuristic, not a trained secondary classifier. Per audit requirement P0-2,
  // enforceHardVetoes no longer consults metaGate or metaLabelConfidence.
  // Meta-labeling is strictly a diagnostic metric displayed in research UI, not a gate.
  return null;
}

function buildOrderIntent({ symbol, side, entry, target, stopLoss, sizeMultiplier, riskReward, contract, targetPct, stopLossPct, weekKey = null, level = 1, sector = null, decisionAt = null, adjFactor = 1 }) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const normalizedSide = side === "long" || side === "buy" ? "long" : side === "short" || side === "sell" ? "short" : null;
  // A-1 follow-on: the bar series is dividend back-adjusted so that signals and
  // statistics are not corrupted by ex-date gaps. Those adjusted prices are NOT
  // what the exchange quotes. An order has to be priced in raw terms, and
  // raw = adjusted / factor. The factor is 1.0 for every bar after the most
  // recent ex-date, so this is a no-op except when a dividend went ex inside the
  // anchor week -- precisely the case that would otherwise misprice every rung
  // by the dividend amount.
  const factor = Number(adjFactor) > 0 ? Number(adjFactor) : 1;
  const toRaw = (value) => (Number.isFinite(Number(value)) ? Number(value) / factor : value);
  const rawEntry = toRaw(entry);
  const rawTarget = toRaw(target);
  const rawStop = toRaw(stopLoss);

  const TICK_SIZE = stockFutureTickSize(contract?.spot || rawEntry, contract?.tickSize);
  if (!(TICK_SIZE > 0)) throw new TypeError("A valid stock-futures tick size is required");
  const entryTick = round(Math.round(rawEntry / TICK_SIZE) * TICK_SIZE, 2);
  const targetTick = round(Math.round(rawTarget / TICK_SIZE) * TICK_SIZE, 2);
  const stopLossTick = round(Math.round(rawStop / TICK_SIZE) * TICK_SIZE, 2);

  // C-6: Fail closed if contract lot size is missing - never default to 1 share for stock futures
  const lotSize = Number(contract?.lotSize);
  const validLotSize = (Number.isFinite(lotSize) && lotSize > 0) ? lotSize : null;
  const expiry = contract?.expiry || null;
  const contractSymbol = contract?.contractSymbol || null;
  const instrumentId = contract?.instrumentId || null;

  // C-6: Risk budget cap modeling: ₹25,000 baseline risk budget scaled by sizeMultiplier
  // C-6 FIX: Do NOT use Math.max(1, ...). If riskPerLot exceeds risk budget, targetLots = 0!
  const BASE_RISK_BUDGET = 25000;
  const sizingMultiplier = Number.isFinite(Number(sizeMultiplier)) ? Math.max(0, Number(sizeMultiplier)) : 0;
  const effectiveRiskBudget = BASE_RISK_BUDGET * sizingMultiplier;
  const riskPerShare = Math.max(0.05, Math.abs(entryTick - stopLossTick));
  const riskPerLot = validLotSize ? riskPerShare * validLotSize : riskPerShare;
  const targetLots = validLotSize ? Math.floor(effectiveRiskBudget / Math.max(1, riskPerLot)) : 0;
  const quantity = targetLots * (validLotSize || 0);
  const notional = round(quantity * entryTick, 2);
  // Real margin tier: 22% default, or higher if high volatility
  const currentMarginPerLot = Number(contract?.marginPerLot);
  const currentMarginRequired = Number.isFinite(currentMarginPerLot) && currentMarginPerLot > 0
    ? round(currentMarginPerLot * targetLots, 2)
    : null;
  const marginPct = currentMarginRequired && notional > 0
    ? round(currentMarginRequired / notional, 6)
    : Number(contract?.marginPct) || (stopLossPct > 1.5 ? 0.28 : 0.22);
  const estMarginRequired = currentMarginRequired || round(notional * marginPct, 2);
  const maxRiskInr = round(riskPerShare * quantity, 2);
  const validationErrors = [];
  if (!normalizedSymbol) validationErrors.push("MISSING_SYMBOL");
  if (!normalizedSide) validationErrors.push("MISSING_OR_INVALID_SIDE");
  if (!validLotSize) validationErrors.push("MISSING_CONTRACT_LOT_SIZE");
  if (!expiry) validationErrors.push("MISSING_EXPIRY");
  if (!contractSymbol) validationErrors.push("MISSING_CONTRACT_SYMBOL");
  if (!instrumentId) validationErrors.push("MISSING_INSTRUMENT_ID");
  if (!(Number(contract?.volume) > 0)) validationErrors.push("MISSING_CONTRACT_VOLUME");
  if (!(Number(contract?.openInterest) > 0)) validationErrors.push("MISSING_OPEN_INTEREST");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(contract?.tradeDate || ""))) validationErrors.push("MISSING_CONTRACT_AS_OF_DATE");
  if (contract?.banStatus !== "CLEAR") validationErrors.push(contract?.banStatus === "BANNED" ? "SECURITY_IN_FO_BAN" : "FO_BAN_STATUS_UNAVAILABLE");
  if (targetLots < 1) validationErrors.push("RISK_EXCEEDS_BUDGET");
  const executable = validationErrors.length === 0;
  const independentlyLiveApproved = contract?.liveBrokerVerified === true && contract?.regulatoryApproved === true;
  const orderSeed = [normalizedSymbol, contractSymbol, expiry, weekKey || "NO_WEEK", `L${level}`, normalizedSide || "NO_SIDE"].join(":");
  const clientOrderId = `K2_${crypto.createHash("sha256").update(orderSeed).digest("hex").slice(0, 20).toUpperCase()}`;

  return {
    symbol: normalizedSymbol,
    side: normalizedSide,
    brokerSide: normalizedSide === "long" ? "BUY" : normalizedSide === "short" ? "SELL" : null,
    clientOrderId,
    strategyVersion: "continuous-futures-v2",
    decisionAt: decisionAt || new Date().toISOString(),
    weekKey,
    level,
    sector,
    contractSymbol,
    instrumentId,
    segment: "NSE_FO",
    instrumentType: "STOCK_FUTURE",
    finInstrmTp: "STF",
    expiry,
    lotSize: validLotSize,
    lots: targetLots,
    quantity,
    executable,
    liveExecutable: Boolean(executable && currentMarginRequired && independentlyLiveApproved),
    executionMode: executable && currentMarginRequired && independentlyLiveApproved ? "LIVE_ELIGIBLE_AFTER_RISK" : "SHADOW_ONLY",
    validationErrors,
    rejectionReason: validationErrors[0] || null,
    tickSize: TICK_SIZE,
    entryPrice: entryTick,
    targetPrice: targetTick,
    stopLossPrice: stopLossTick,
    riskReward,
    targetPct,
    stopLossPct,
    contractNotional: notional,
    estMarginRequired,
    marginPct,
    marginSource: currentMarginRequired ? "BROKER_OR_CLEARING_CURRENT" : "CONSERVATIVE_ESTIMATE",
    sessionVolume: Number(contract?.volume) || null,
    openInterest: Number(contract?.openInterest) || null,
    dataAsOf: contract?.tradeDate || null,
    dataSource: contract?.segment || null,
    banStatus: contract?.banStatus || "UNAVAILABLE",
    maxRiskInr,
    orderType: "LIMIT",
    timeInForce: "DAY"
  };
}

// A name admitted on expected move rather than on ladder history. It carries no
// measured rung statistics, because none passed — so it is labelled differently
// and sized more cautiously.
function potentialCall(symbol, { bars, cycle, potential, config, input }) {
  const anchorInfo = currentAnchor(bars);
  if (!anchorInfo?.anchor) return standAside(symbol, "No anchor session for the week in progress", { cycle, upside: potential });
  const side = potential.side;
  const rungs = ladder(anchorInfo.anchor, side, config);
  const targetStep = 1 + (side === "short" ? -1 : 1) * Number(config.targetPct) / 100;
  const vetoes = [];
  if (input.fundamentals?.veto) vetoes.push(input.fundamentals.veto);
  const trend = input.trend === undefined ? trendGate(bars, side, input.overrides || {}) : input.trend;
  if (trend?.veto) vetoes.push(trend.veto);
  if (vetoes.length) return standAside(symbol, vetoes[0], { cycle, upside: potential, trend, vetoes });
 
  // Institutional Model Governance Gate:
  // If the ML model is unvalidated, has negative R^2, or IC < 0.05, it is strictly
  // advisory-only and CANNOT unilaterally create a standalone potential trade.
  const modelFitness = evaluateModelFitness(input.model || potential.model || potential.forecast);
  if (!modelFitness.canGenerateTrades) {
    return standAside(
      symbol,
      `ML model unvalidated for standalone trade generation: ${modelFitness.reason}`,
      { cycle, upside: potential, trend, vetoes, modelFitness }
    );
  }

  // Confidence is the margin over the floor against the model's typical error:
  // a 6% call with a 3% average error is a weaker claim than a 3% call with 0.5%.
  const margin = Number(potential.expectedMovePct) - Number(potential.floorPct);
  const error = Number(potential.typicalErrorPct);
  const convictionPct = round(clamp(margin / Math.max(error || 1, 0.5)) * 55 + clamp(Number(potential.forecast?.informationCoefficient) / 0.1) * 15);

  const metrics = trendMetrics(bars);
  const atrPct = metrics?.ready ? Number(metrics.atrPct) || 2.0 : 2.0;
  const stopLossPct = Number(config.stopLossPct);
  const targetPct = Number(config.targetPct);
  const riskReward = round(targetPct / stopLossPct, 1);
  const entryPrice = round(rungs[0].price);
  const targetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (targetPct / 100)));
  const stopLossPrice = round(entryPrice * (1 - (side === "short" ? -1 : 1) * (stopLossPct / 100)));

  const hurst = metrics?.hurstExponent || 0.50;
  const er = metrics?.kaufmanEr || 0.30;
  const vpinData = calculateVpin(bars, 20);
  const metaGate = metaLabelConfidence({
    primarySide: side,
    primaryScore: convictionPct,
    hurst,
    er,
    vpin: vpinData.vpin,
    isUptrend: metrics?.isUptrendStructure
  });

  // Strict Hard Veto Gate for Potential Route (P0-001):
  const hardVeto = enforceHardVetoes({
    symbol,
    metaGate,
    vpinData,
    evidence: { cycle, upside: potential, trend, vetoes }
  });
  const finalSizeMultiplier = round(clamp(0.20 + 0.20 * clamp(convictionPct / 70), 0.10, 0.40), 3);

  const orderIntent = buildOrderIntent({
    symbol,
    side,
    entry: entryPrice,
    target: targetPrice,
    stopLoss: stopLossPrice,
    sizeMultiplier: finalSizeMultiplier,
    riskReward,
    contract: input.contract,
    targetPct,
    stopLossPct,
    weekKey: anchorInfo.weekKey,
    level: 1,
    sector: input.sector,
    decisionAt: input.decisionAt,
    adjFactor: anchorInfo.anchorAdjFactor
  });
  // This alternate forecast route has no matching exit-policy validation.
  orderIntent.executable = false;
  orderIntent.liveExecutable = false;
  orderIntent.executionMode = "RESEARCH_ONLY";
  orderIntent.rejectionReason = "POTENTIAL_ROUTE_NOT_VALIDATED";
  orderIntent.validationErrors.push("POTENTIAL_ROUTE_NOT_VALIDATED");

  return {
    symbol,
    action: side === "short" ? "sell-potential" : "buy-potential",
    route: "potential",
    side,
    weekKey: anchorInfo.weekKey,
    anchor: round(anchorInfo.anchor),
    sessionsElapsed: anchorInfo.sessionsElapsed,
    levels: [1],
    entries: [{
      level: 1,
      entry: entryPrice,
      target: targetPrice,
      holdingGuidance: {
        medianObservedSessions: null,
        maximumRiskCeilingSessions: Number(config.maxHoldingSessions),
        fridayExit: false,
        status: "NO_ROUTE_SPECIFIC_HOLDING_ESTIMATE"
      },
      stopLoss: stopLossPrice,
      riskReward,
      targetPct,
      stopLossPct,
      stepFromAnchorPct: round(Number(config.stepPct)),
      historicalFills: null,
      hitRatePct: null,
      hitRateLowerPct: null,
      averageNetPct: null,
      medianSessionsHeld: null,
      orderIntent
    }],
    convictionPct,
    expectedWeeklyPct: round(potential.expectedMovePct, 3),
    expectedFromPricePct: round(potential.expectedMovePct, 3),
    expectedFromCarryPct: round(Number(potential.components?.find((item) => item.name === "Carry")?.expectedPct) || 0, 3),
    sizeMultiplier: finalSizeMultiplier,
    advancedQuant: {
      hurst,
      er,
      vpin: vpinData.vpin,
      toxicityTone: vpinData.toxicityTone,
      metaProb: metaGate.metaProb,
      metaDecision: metaGate.decision,
      qualityRating: metaGate.qualityRating,
      kellyFraction: kelly
    },
    bookOut: `Hold across Fridays; Monday resets reporting reference only. Exit on target, stop, ${config.maxHoldingSessions}-session risk ceiling, or genuine close-and-open roll ${config.rollWindowCalendarDays} calendar days before expiry.`,
    reasons: [potential.reason, ...potential.components.filter((item) => Number(item.expectedPct) > 0).map((item) => `${item.name}: ${item.note}`)],
    vetoes: [],
    components: potential.components.map((item) => ({ name: item.name, weight: null, score: null, contribution: item.expectedPct, note: item.note })),
    evidence: {
      route: "expected move rather than ladder history",
      cycleWeeks: cycle.weeks,
      ladderVerdict: cycle.verdict.reason,
      horizonSessions: potential.horizon,
      typicalErrorPct: potential.typicalErrorPct,
      informationCoefficient: potential.forecast?.informationCoefficient ?? null,
      topFeatures: potential.forecast?.importance || [],
      trend: trend?.ready ? { returnPct: trend.returnPct, scaled: trend.scaled } : null
    }
  };
}

function recommendation(input) {
  const symbol = String(input.symbol || "").toUpperCase();
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const config = { ...DEFAULT_CONFIG, ...(input.overrides || {}) };
  // `undefined` means "compute it"; an explicit null means "this caller has
  // deliberately skipped it", which keeps the expensive fit off request paths.
  const cycle = input.cycle === undefined ? weeklyCycle(bars, input.overrides || {}) : input.cycle;
  if (!cycle) return standAside(symbol, "No weekly cycle evidence supplied");
  if (!cycle.ready) return standAside(symbol, cycle.reason, { cycle });
  if (input.requireFundamentals && !input.fundamentals?.available) {
    return standAside(symbol, `Required point-in-time fundamentals unavailable: ${input.fundamentals?.reason || "not supplied"}`, { cycle, fundamentals: input.fundamentals || null });
  }
  if (input.requireContract && !input.contract) {
    return standAside(symbol, "No current NSE stock-futures contract was verified", { cycle });
  }

  const verdict = cycle.verdict;
  // Two ways onto the list. The ladder route asks whether harvesting 2% slices
  // has paid on this name before. The potential route asks a different question:
  // whether the name is set up to travel further than the desk's 2% floor at all.
  // A stock can fail the first and pass the second — the 2% ladder is simply the
  // wrong instrument for something poised to move six — and rejecting it for that
  // was discarding most of the universe.
  if (verdict.action === "stand-aside") {
    const potential = input.upside === undefined
      ? upside({ bars, side: "long", technical: input.technical, fundamentals: input.fundamentals, carry: input.carry, floorPct: Number(config.targetPct) || 2, overrides: input.overrides })
      : input.upside;
    if (!potential?.clearsFloor) {
      return standAside(symbol, verdict.reason, { cycle, upside: potential });
    }
    return potentialCall(symbol, { bars, cycle, potential, config, input });
  }

  const side = verdict.side;
  const model = input.model === undefined ? weeklyForecast(bars, side, input.overrides || {}) : input.model;
  const modelFitness = evaluateModelFitness(model);
  const governedModel = modelFitness.canGenerateTrades ? { ...model, trustworthy: true } : { ...model, trustworthy: false };
  const fundamentals = input.fundamentals || null;
  const technical = input.technical || null;

  // The trend gate is checked with the other hard vetoes: reversal into a
  // established downtrend is the single largest source of this rule's losses.
  const trend = input.trend === undefined ? trendGate(bars, side, input.overrides || {}) : input.trend;
  const vetoes = [];
  if (trend?.veto) vetoes.push(trend.veto);
  if (fundamentals?.veto) vetoes.push(fundamentals.veto);
  if (modelFitness.canGenerateTrades && Number(model?.expectedWeeklyPct) < 0) {
    vetoes.push(`The model expects a ${model.expectedWeeklyPct}% week against this ladder`);
  }
  if (Number(cycle[side].outOfSample.averageWeeklyPct) <= 0) {
    vetoes.push("The rule did not make money on this name out of sample");
  }
  const evidence = { cycle, model, modelFitness, fundamentals, technical, trend, vetoes };
  if (vetoes.length) return standAside(symbol, vetoes[0], evidence);

  const anchorInfo = currentAnchor(bars);
  if (!anchorInfo?.anchor) return standAside(symbol, "No anchor session for the week in progress", evidence);

  const rungs = ladder(anchorInfo.anchor, side, config);
  const metrics = trendMetrics(bars);
  const atrPct = metrics?.ready ? Number(metrics.atrPct) || 2.0 : 2.0;
  const stopLossPct = Number(config.stopLossPct);
  const targetPct = Number(config.targetPct);
  const riskReward = round(targetPct / stopLossPct, 1);

  const entries = verdict.levels.map((level) => {
    const rung = rungs.find((item) => item.level === level);
    const stats = cycle[side].levels.find((item) => item.level === level);
    const entryPrice = round(rung.price);
    const targetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (targetPct / 100)));
    const stopLossPrice = round(entryPrice * (1 - (side === "short" ? -1 : 1) * (stopLossPct / 100)));

    return {
      level,
      entry: entryPrice,
      target: targetPrice,
      holdingGuidance: {
        medianObservedSessions: stats?.medianSessionsHeld ?? null,
        maximumRiskCeilingSessions: Number(config.maxHoldingSessions),
        fridayExit: false,
        status: "EMPIRICAL_MEDIAN_NOT_A_PROMISE"
      },
      stopLoss: stopLossPrice,
      riskReward,
      targetPct,
      stopLossPct,
      stepFromAnchorPct: round(level * Number(config.stepPct)),
      historicalFills: stats?.fills ?? null,
      hitRatePct: stats?.hitRatePct ?? null,
      hitRateLowerPct: stats?.lowerPct ?? null,
      averageNetPct: stats?.averageNetPct ?? null,
      medianSessionsHeld: stats?.medianSessionsHeld ?? null
    };
  });

  const { convictionPct, components } = convictionOf({ cycle, model: governedModel, technical, fundamentals, trend, carry: input.carry || null, side, config });
  // Cash-proxy cohort returns and current futures basis have different units,
  // horizons and exposure. Do not add basis as a guaranteed weekly credit, or
  // blend a separately fitted forecast into validation evidence.
  const priceExpectation = Number(cycle[side].outOfSample.averageWeeklyPct);
  const carryContribution = 0;
  const expectedWeeklyPct = round(priceExpectation, 3);

  // A ladder whose carry costs more than the price edge is expected to earn is
  // not a trade, however well the rule has scored historically. This is checked
  // after the expectation is assembled because it depends on the total, not on
  // any single component.
  if (expectedWeeklyPct <= 0) {
    return standAside(symbol, `The week is not expected to pay: ${round(priceExpectation, 3)}% from price against ${round(carryContribution, 3)}% of carry`, evidence);
  }


  const hurst = metrics?.hurstExponent || 0.50;
  const er = metrics?.kaufmanEr || 0.30;
  const vpinData = calculateVpin(bars, 20);
  const patternScan = scanChartPatterns(bars);

  // Pattern recognition is displayed as advisory evidence. It is not allowed to
  // inflate sizing until its own point-in-time validation has passed.
  const adjustedConviction = convictionPct;
  let patternReason = null;
  if (patternScan.detected && patternScan.primaryPattern && patternScan.primaryPattern.confirmed === true) {
    const isAligned = (side === "long" && patternScan.primaryPattern.bias === "BULLISH") ||
                      (side === "short" && patternScan.primaryPattern.bias === "BEARISH");
    if (isAligned) {
      patternReason = `Geometric Pattern: ${patternScan.primaryPattern.pattern} confirmed (Target: ₹${patternScan.primaryPattern.targetPrice})`;
    }
  }

  const metaGate = metaLabelConfidence({
    primarySide: side,
    primaryScore: adjustedConviction,
    hurst,
    er,
    vpin: vpinData.vpin,
    isUptrend: metrics?.isUptrendStructure
  });
  // Risk remains capped by the order-level rupee stop budget and portfolio engine.
  const finalSizeMultiplier = round(clamp(0.25 + 0.25 * clamp(adjustedConviction / 70), 0.10, 0.50), 3);

  const entriesWithIntent = entries.map((entry) => ({
    ...entry,
    orderIntent: buildOrderIntent({
      symbol,
      side,
      entry: entry.entry,
      target: entry.target,
      stopLoss: entry.stopLoss,
      sizeMultiplier: finalSizeMultiplier,
      riskReward,
      contract: input.contract,
      targetPct,
      stopLossPct,
      weekKey: anchorInfo.weekKey,
      level: entry.level,
      sector: input.sector,
      decisionAt: input.decisionAt,
      adjFactor: anchorInfo.anchorAdjFactor
    })
  }));

  return {
    symbol,
    action: verdict.action,
    side,
    weekKey: anchorInfo.weekKey,
    anchor: round(anchorInfo.anchor),
    sessionsElapsed: anchorInfo.sessionsElapsed,
    levels: verdict.levels,
    entries: entriesWithIntent,
    convictionPct: adjustedConviction,
    expectedWeeklyPct,
    expectedFromPricePct: round(priceExpectation, 3),
    expectedFromCarryPct: round(carryContribution, 3),
    sizeMultiplier: finalSizeMultiplier,
    chartPattern: patternScan.primaryPattern || null,
    advancedQuant: {
      hurst,
      er,
      vpin: vpinData.vpin,
      toxicityTone: vpinData.toxicityTone,
      metaProb: metaGate.metaProb,
      metaDecision: metaGate.decision,
      qualityRating: metaGate.qualityRating
    },
    evidencePillars: {
      pillar1_fundamentals: {
        balanceSheetScore: fundamentals?.available ? fundamentals.balanceSheetScore : null,
        earningsVeto: fundamentals?.veto || null,
        status: fundamentals?.available ? (fundamentals?.veto ? "VETOED" : "AVAILABLE") : "UNAVAILABLE"
      },
      pillar2_technicals: {
        momentumReturnPct: trend?.ready ? round(Number(trend.returnPct || 0), 2) : null,
        trendEfficiency: er,
        atrPct,
        status: trend?.ready ? (trend?.veto ? "VETOED" : "AVAILABLE") : "UNAVAILABLE"
      },
      pillar3_chartPattern: {
        pattern: patternScan.primaryPattern?.pattern || null,
        targetPrice: patternScan.primaryPattern?.targetPrice || null,
        confirmed: Boolean(patternScan.primaryPattern?.confirmed)
      },
      pillar4_candlesticks: { status: "RESEARCH_ONLY_NOT_AN_EXECUTION_GATE" },
      pillar5_quantMath: {
        hurst,
        regime: hurst > 0.55 ? "Persistent Trend" : hurst < 0.45 ? "Mean-Reverting" : "Random Walk",
        role: "RESEARCH_ADVISORY_ONLY"
      },
      pillar6_statistics: {
        wilsonLowerBoundPct: entries[0]?.hitRateLowerPct ?? null,
        tStatistic: cycle[side]?.levels?.find((l) => l.level === verdict.levels[0])?.tStat ?? null,
        kellyAllocationPct: null
      },
      pillar7_microstructure: {
        dailyBarFlowToxicityProxy: vpinData.vpin,
        toxicityTone: vpinData.toxicityTone,
        status: "NOT_TRUE_VPIN_RESEARCH_ONLY"
      },
      pillar8_machineLearning: {
        boostedTreeForecastPct: model?.expectedWeeklyPct ? Number(model.expectedWeeklyPct) : null,
        ruleScoreNotCalibratedProbability: metaGate.metaProb,
        metaDecision: metaGate.decision,
        qualityRating: metaGate.qualityRating,
        status: "ADVISORY_ONLY_UNLESS_INDEPENDENTLY_VALIDATED"
      }
    },
    bookOut: `Hold across Fridays; Monday resets reporting reference only. Exit on target, stop, ${config.maxHoldingSessions}-session risk ceiling, or genuine close-and-open roll ${config.rollWindowCalendarDays} calendar days before expiry.`,
    reasons: [
      verdict.reason,
      ...(patternReason ? [patternReason] : []),
      ...components.filter((item) => Number(item.contribution) > 0).map((item) => `${item.name}: ${item.note}`)
    ],
    vetoes: [],
    components,
    evidence: {
      cycleWeeks: cycle.weeks,
      cycleOutOfSampleFrom: cycle.outOfSampleFrom,
      modelValidation: model?.validation?.ready ? model.validation.outOfSample : null,
      modelTrustworthy: modelFitness.canGenerateTrades,
      modelGovernance: modelFitness,
      trend: trend?.ready ? { returnPct: trend.returnPct, scaled: trend.scaled, annualisedVolatilityPct: trend.annualisedVolatilityPct } : null,
      topFeatures: model?.importance || [],
      fundamentals: fundamentals?.available
        ? { balanceSheetScore: fundamentals.balanceSheetScore, nextEarningsDate: fundamentals.events?.nextEarningsDate, metrics: fundamentals.metrics }
        : { available: false, reason: fundamentals?.reason || "not requested" }
    }
  };
}

// // The buying list: only names that cleared every veto, ranked by the expected
// result of the week net of costs, with conviction breaking ties.
function rankRecommendations(list, options = {}) {
  const limit = Number(options.limit) || 20;
  const requireExecutable = options.requireExecutable !== false;
  const isActionable = (item) => {
    if (!item || item.action === "stand-aside") return false;
    if (Array.isArray(item.entries)) {
      return item.entries.some((entry) => entry.orderIntent?.executable === true);
    }
    return !requireExecutable;
  };
  const actionable = (Array.isArray(list) ? list : [])
    .filter(isActionable)
    .sort((left, right) => Number(right.expectedWeeklyPct) - Number(left.expectedWeeklyPct)
      || Number(right.convictionPct) - Number(left.convictionPct));
  const stoodAside = (Array.isArray(list) ? list : []).filter((item) => !isActionable(item));
  return {
    generatedFor: options.weekKey || actionable[0]?.weekKey || null,
    considered: Array.isArray(list) ? list.length : 0,
    actionable: actionable.length,
    buys: actionable.filter((item) => item.side === "long").slice(0, limit),
    sells: actionable.filter((item) => item.side === "short").slice(0, limit),
    best: actionable.slice(0, limit),
    rejected: stoodAside.map((item) => ({
      symbol: item.symbol,
      reason: item.action === "stand-aside"
        ? (item.reasons?.[0] || "No edge")
        : (item.entries?.flatMap((entry) => entry.orderIntent?.validationErrors || [])[0] || "No executable stock-futures order")
    })).slice(0, 120)
  };
}

module.exports = {
  buildOrderIntent,
  convictionOf,
  currentAnchor,
  enforceHardVetoes,
  evaluateTradeSuitability: recommendation,
  rankRecommendations,
  recommendation,
  standAside
};
