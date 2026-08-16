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
const { weeklyForecast } = require("./ml-model");
const { trendAlignment, trendGate } = require("./trend");
const { carryScore } = require("./carry");

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
  if (verdict.action === "stand-aside") return standAside(symbol, verdict.reason, { cycle });

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
  const targetStep = 1 + (side === "short" ? -1 : 1) * Number(config.targetPct) / 100;
  const entries = verdict.levels.map((level) => {
    const rung = rungs.find((item) => item.level === level);
    const stats = cycle[side].levels.find((item) => item.level === level);
    return {
      level,
      entry: round(rung.price),
      target: round(rung.price * targetStep),
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


  return {
    symbol,
    action: verdict.action,
    side,
    weekKey: anchorInfo.weekKey,
    anchor: round(anchorInfo.anchor),
    sessionsElapsed: anchorInfo.sessionsElapsed,
    levels: verdict.levels,
    entries,
    convictionPct,
    expectedWeeklyPct,
    expectedFromPricePct: round(priceExpectation, 3),
    expectedFromCarryPct: round(carryContribution, 3),
    // Conviction only scales the ticket; it never creates one.
    sizeMultiplier: round(0.25 + 0.75 * clamp(convictionPct / 70), 3),
    bookOut: "Book every open leg at the Friday close; Monday's open sets the next anchor",
    reasons: [
      verdict.reason,
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

module.exports = { convictionOf, currentAnchor, rankRecommendations, recommendation };
