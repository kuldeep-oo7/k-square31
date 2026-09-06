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

const { tradingWeeks, ladder, weeklyCycle, DEFAULT_CONFIG } = require("./weekly-cycle");
const { weeklyForecast, evaluateModelFitness } = require("./ml-model");
const { trendAlignment, trendGate, trendMetrics } = require("./trend");
const { carryScore } = require("./carry");
const { upside } = require("./upside");
const { calculateVpin, metaLabelConfidence, calculateKellyFraction } = require("./advanced-quant");
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
  return { weekKey: week.weekKey, anchor: week.sessions[0].open, sessionsElapsed: week.sessions.length };
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
    ["Model skill", 7, model?.validation?.ready ? clamp(Number(model.validation.outOfSample.informationCoefficient) / 0.1) : 0, model?.validation?.ready ? `out-of-sample information coefficient ${model.validation.outOfSample.informationCoefficient}` : "no validated model"],
    ["Technical alignment", 6, technicalAlignment, Number.isFinite(technicalScore) ? `composite score ${round(technicalScore)} versus a ${side} ladder` : "no technical composite supplied"],
    ["Carry", 12, carryScore(carryForSide, target), carryForSide ? `futures at a ${carryForSide.state} of ${carryForSide.basisPct}%, worth ${carryForSide.weeklyPct}% to this side over the week` : "no contract price for this name"],
    ["Balance-sheet asymmetry", 6, clamp((side === "short" ? -balanceSheet : balanceSheet) + 0.5, 0, 1), fundamentals?.available ? `balance-sheet score ${balanceSheet}` : "fundamentals unavailable"]
  ].map(([name, weight, score, note]) => ({ name, weight, score: round(score, 4), contribution: round(weight * score, 2), note }));

  return { convictionPct: round(components.reduce((sum, item) => sum + Number(item.contribution), 0)), components };
}

function enforceHardVetoes({ symbol, metaGate, vpinData, evidence = {} }) {
  if (metaGate?.decision === "VETO" || (metaGate?.metaMultiplier !== undefined && metaGate.metaMultiplier <= 0)) {
    const vetoReason = `Meta-Labeling VETO: Low win probability (${metaGate?.metaProb ?? 0}) or high flow toxicity (VPIN: ${vpinData?.vpin ?? 0})`;
    if (!evidence.vetoes) evidence.vetoes = [];
    if (!evidence.vetoes.includes(vetoReason)) evidence.vetoes.push(vetoReason);
    return standAside(symbol, vetoReason, evidence);
  }
  return null;
}

function buildOrderIntent({ symbol, side, entry, target, runnerTarget, stopLoss, sizeMultiplier, riskReward, contract, targetPct, stopLossPct }) {
  const TICK_SIZE = 0.05;
  const entryTick = round(Math.round(entry / TICK_SIZE) * TICK_SIZE, 2);
  const targetTick = round(Math.round(target / TICK_SIZE) * TICK_SIZE, 2);
  const runnerTargetTick = runnerTarget ? round(Math.round(runnerTarget / TICK_SIZE) * TICK_SIZE, 2) : null;
  const stopLossTick = round(Math.round(stopLoss / TICK_SIZE) * TICK_SIZE, 2);

  // C-6: Fail closed if contract lot size is missing - never default to 1 share for stock futures
  const lotSize = Number(contract?.lotSize);
  const validLotSize = (Number.isFinite(lotSize) && lotSize > 0) ? lotSize : null;
  const expiry = contract?.expiry || null;
  const contractSymbol = expiry ? `${symbol}-${expiry}-FUT` : `${symbol}-FUT`;

  // C-6: Risk budget cap modeling: ₹25,000 baseline risk budget scaled by sizeMultiplier
  // C-6 FIX: Do NOT use Math.max(1, ...). If riskPerLot exceeds risk budget, targetLots = 0!
  const BASE_RISK_BUDGET = 25000;
  const effectiveRiskBudget = BASE_RISK_BUDGET * (sizeMultiplier || 1.0);
  const riskPerShare = Math.max(0.05, Math.abs(entryTick - stopLossTick));
  const riskPerLot = validLotSize ? riskPerShare * validLotSize : riskPerShare;
  const targetLots = validLotSize ? Math.floor(effectiveRiskBudget / Math.max(1, riskPerLot)) : 0;
  const quantity = targetLots * (validLotSize || 0);
  const notional = round(quantity * entryTick, 2);
  // Real margin tier: 22% default, or higher if high volatility
  const marginPct = Number(contract?.marginPct) || (stopLossPct > 1.5 ? 0.28 : 0.22);
  const estMarginRequired = round(notional * marginPct, 2);
  const maxRiskInr = round(riskPerShare * quantity, 2);
  const executable = Boolean(validLotSize && targetLots >= 1);

  return {
    contractSymbol,
    segment: "NSE_FO",
    instrumentType: "STOCK_FUTURE",
    finInstrmTp: "STF",
    expiry,
    lotSize: validLotSize,
    lots: targetLots,
    quantity,
    executable,
    rejectionReason: !validLotSize ? "MISSING_CONTRACT_LOT_SIZE" : (targetLots < 1 ? "RISK_EXCEEDS_BUDGET" : null),
    tickSize: TICK_SIZE,
    entryPrice: entryTick,
    targetPrice: targetTick,
    runnerTargetPrice: runnerTargetTick,
    stopLossPrice: stopLossTick,
    riskReward,
    targetPct,
    stopLossPct,
    contractNotional: notional,
    estMarginRequired,
    marginPct,
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
  const stopLossPct = round(Math.max(0.8, Math.min(2.0, atrPct * 0.6)), 2);
  const targetPct = round(Math.max(Number(config.targetPct) || 2.0, stopLossPct * 2.0), 2);
  const runnerTargetPct = round(Math.max(5.0, targetPct * 2.2), 2);
  const riskReward = round(targetPct / stopLossPct, 1);
  const entryPrice = round(rungs[0].price);
  const targetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (targetPct / 100)));
  const runnerTargetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (runnerTargetPct / 100)));
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
  if (hardVeto) return hardVeto;

  const kelly = calculateKellyFraction({
    winRate: Math.max(0.40, convictionPct / 100),
    rewardToRiskRatio: riskReward
  });

  const finalSizeMultiplier = metaGate.metaMultiplier > 0
    ? round(clamp((0.25 + 0.5 * clamp(convictionPct / 70)) * Math.min(1.0, metaGate.metaMultiplier), 0.10, 0.75), 3)
    : 0;

  const orderIntent = buildOrderIntent({
    symbol,
    side,
    entry: entryPrice,
    target: targetPrice,
    runnerTarget: runnerTargetPrice,
    stopLoss: stopLossPrice,
    sizeMultiplier: finalSizeMultiplier,
    riskReward,
    contract: input.contract,
    targetPct,
    stopLossPct
  });

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
      runnerTarget: runnerTargetPrice,
      runnerTargetPct,
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
    bookOut: "Hold open legs continuously across weekends with Monday reference rebase; exit strictly on 2% target, 2% stop-loss, or mandatory 3-day monthly futures expiry roll window",
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
  const fundamentals = input.fundamentals || null;
  const technical = input.technical || null;

  // The trend gate is checked with the other hard vetoes: reversal into a
  // established downtrend is the single largest source of this rule's losses.
  const trend = input.trend === undefined ? trendGate(bars, side, input.overrides || {}) : input.trend;
  const vetoes = [];
  if (trend?.veto) vetoes.push(trend.veto);
  if (fundamentals?.veto) vetoes.push(fundamentals.veto);
  if (model?.ready && Number(model.expectedWeeklyPct) < 0) {
    vetoes.push(`The model expects a ${model.expectedWeeklyPct}% week against this ladder`);
  }
  if (Number(cycle[side].outOfSample.averageWeeklyPct) <= 0) {
    vetoes.push("The rule did not make money on this name out of sample");
  }
  const evidence = { cycle, model, fundamentals, technical, trend, vetoes };
  if (vetoes.length) return standAside(symbol, vetoes[0], evidence);

  const anchorInfo = currentAnchor(bars);
  if (!anchorInfo?.anchor) return standAside(symbol, "No anchor session for the week in progress", evidence);

  const rungs = ladder(anchorInfo.anchor, side, config);
  const metrics = trendMetrics(bars);
  const atrPct = metrics?.ready ? Number(metrics.atrPct) || 2.0 : 2.0;
  const stopLossPct = round(Math.max(0.8, Math.min(2.0, atrPct * 0.6)), 2);
  const targetPct = round(Math.max(Number(config.targetPct) || 2.0, stopLossPct * 2.0), 2);
  const riskReward = round(targetPct / stopLossPct, 1);

  const entries = verdict.levels.map((level) => {
    const rung = rungs.find((item) => item.level === level);
    const stats = cycle[side].levels.find((item) => item.level === level);
    const entryPrice = round(rung.price);
    const targetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (targetPct / 100)));
    const runnerTargetPct = round(Math.max(5.0, targetPct * 2.2), 2);
    const runnerTargetPrice = round(entryPrice * (1 + (side === "short" ? -1 : 1) * (runnerTargetPct / 100)));
    const stopLossPrice = round(entryPrice * (1 - (side === "short" ? -1 : 1) * (stopLossPct / 100)));
    return {
      level,
      entry: entryPrice,
      target: targetPrice,
      runnerTarget: runnerTargetPrice,
      runnerTargetPct,
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

  const { convictionPct, components } = convictionOf({ cycle, model, technical, fundamentals, trend, carry: input.carry || null, side, config });
  // Carry is added rather than averaged in: it is not another opinion about the
  // week, it is a credit or cost that accrues whatever the price does. Leaving it
  // out ranked a name earning 1.3% a week from basis alone below one earning
  // nothing.
  const priceExpectation = model?.trustworthy && Number.isFinite(Number(model.expectedWeeklyPct))
    ? (Number(model.expectedWeeklyPct) + Number(cycle[side].outOfSample.averageWeeklyPct)) / 2
    : Number(cycle[side].outOfSample.averageWeeklyPct);
  const carryContribution = input.carry?.ready
    ? (side === "short" ? -Number(input.carry.weeklyPct) : Number(input.carry.weeklyPct))
    : 0;
  const expectedWeeklyPct = round(priceExpectation + carryContribution, 3);

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

  let adjustedConviction = convictionPct;
  let patternReason = null;
  if (patternScan.detected && patternScan.primaryPattern && patternScan.primaryPattern.confirmed === true) {
    const isAligned = (side === "long" && patternScan.primaryPattern.bias === "BULLISH") ||
                      (side === "short" && patternScan.primaryPattern.bias === "BEARISH");
    if (isAligned) {
      adjustedConviction = Math.min(95, Math.round(convictionPct + Math.abs(patternScan.confluenceBonus || 12)));
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
  const kelly = calculateKellyFraction({
    winRate: Math.max(0.40, adjustedConviction / 100),
    rewardToRiskRatio: riskReward
  });

  // Hard Veto Gate: A rejected meta-label setup must NEVER pass through with capital
  const hardVeto = enforceHardVetoes({
    symbol,
    metaGate,
    vpinData,
    evidence
  });
  if (hardVeto) return hardVeto;

  // Base sizing scaled strictly by conviction and meta-labeling multiplier
  const baseSize = 0.25 + 0.75 * clamp(adjustedConviction / 70);
  const finalSizeMultiplier = metaGate.metaMultiplier > 0
    ? round(clamp(baseSize * metaGate.metaMultiplier, 0.10, 1.0), 3)
    : 0;

  const entriesWithIntent = entries.map((entry) => ({
    ...entry,
    orderIntent: buildOrderIntent({
      symbol,
      side,
      entry: entry.entry,
      target: entry.target,
      runnerTarget: entry.runnerTarget,
      stopLoss: entry.stopLoss,
      sizeMultiplier: finalSizeMultiplier,
      riskReward,
      contract: input.contract,
      targetPct,
      stopLossPct
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
      qualityRating: metaGate.qualityRating,
      kellyFraction: kelly
    },
    bookOut: "Hold open legs continuously across weekends with Monday reference rebase; exit strictly on 2% target, 2% stop-loss, or mandatory 3-day monthly futures expiry roll window",
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
      modelTrustworthy: Boolean(model?.trustworthy),
      trend: trend?.ready ? { returnPct: trend.returnPct, scaled: trend.scaled, annualisedVolatilityPct: trend.annualisedVolatilityPct } : null,
      topFeatures: model?.importance || [],
      fundamentals: fundamentals?.available
        ? { balanceSheetScore: fundamentals.balanceSheetScore, nextEarningsDate: fundamentals.events?.nextEarningsDate, metrics: fundamentals.metrics }
        : { available: false, reason: fundamentals?.reason || "not requested" }
    }
  };
}

// The buying list: only names that cleared every veto, ranked by the expected
// result of the week net of costs, with conviction breaking ties.
function rankRecommendations(list, options = {}) {
  const limit = Number(options.limit) || 20;
  const actionable = (Array.isArray(list) ? list : [])
    .filter((item) => item && item.action !== "stand-aside")
    .sort((left, right) => Number(right.expectedWeeklyPct) - Number(left.expectedWeeklyPct)
      || Number(right.convictionPct) - Number(left.convictionPct));
  const stoodAside = (Array.isArray(list) ? list : []).filter((item) => item && item.action === "stand-aside");
  return {
    generatedFor: options.weekKey || actionable[0]?.weekKey || null,
    considered: Array.isArray(list) ? list.length : 0,
    actionable: actionable.length,
    buys: actionable.filter((item) => item.side === "long").slice(0, limit),
    sells: actionable.filter((item) => item.side === "short").slice(0, limit),
    best: actionable.slice(0, limit),
    // Rejections are part of the output: knowing a name was vetoed for results
    // risk is as useful as knowing another one qualified.
    rejected: stoodAside.map((item) => ({ symbol: item.symbol, reason: item.reasons?.[0] || "No edge" })).slice(0, 120)
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
