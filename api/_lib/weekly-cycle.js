"use strict";

/**
 * Canonical research replay for the continuous-holding ladder.
 *
 * Friday is an attribution boundary, never an automatic exit. Open legs carry
 * until target, stop, a provisional 20-session risk ceiling, or the end of the
 * available history (censored, therefore excluded from labels). Live/shadow
 * expiry rolls are handled by the session runner because adjusted cash bars do
 * not contain a historical futures contract chain.
 */

const DEFAULT_CONFIG = Object.freeze({
  strategyId: "K2_CONTINUOUS_NSE_STOCK_FUTURES",
  strategyVersion: "2.0.0",
  stepPct: 2,
  targetPct: 2,
  slots: 5,
  stopLossPct: 2,
  maxHoldingSessions: 20,
  maxConcurrentPositions: 5,
  rollWindowCalendarDays: 3,
  fridayLiquidation: false,
  fillRequiresTradeThrough: true,
  clusterByWeek: true,
  capitalWeighted: true,
  // Conservative research approximation. Executed shadow/live economics use
  // the itemized dated charge engine in shadow-broker.js.
  costPct: 0.08,
  adverseExitSlippagePct: 0.02,
  developmentRatio: 0.60,
  validationRatio: 0.20
});

function round(value, digits = 2) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function istDate(seconds) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(Number(seconds) * 1000));
}

function weekKeyOf(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function tradingWeeks(bars, options = {}) {
  const minimumSessions = Number.isFinite(Number(options.minimumSessions)) ? Number(options.minimumSessions) : 2;
  const weeks = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    const close = Number(bar.close);
    const high = Number(bar.high);
    const low = Number(bar.low);
    if (![close, high, low].every(Number.isFinite)) continue;
    const session = istDate(bar.timestamp);
    const weekKey = weekKeyOf(session);
    if (!weeks.has(weekKey)) weeks.set(weekKey, { weekKey, sessions: [] });
    weeks.get(weekKey).sessions.push({
      session,
      timestamp: Number(bar.timestamp),
      open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : close,
      high,
      low,
      close,
      adjFactor: Number(bar.dividendAdjFactor) > 0 ? Number(bar.dividendAdjFactor) : 1,
      volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null
    });
  }
  return [...weeks.values()]
    .map((week) => ({ ...week, sessions: week.sessions.sort((left, right) => left.session.localeCompare(right.session)) }))
    .filter((week) => week.sessions.length >= minimumSessions)
    .sort((left, right) => left.weekKey.localeCompare(right.weekKey));
}

function ladder(anchor, side, config = DEFAULT_CONFIG) {
  const direction = side === "short" ? 1 : -1;
  const step = 1 + direction * Number(config.stepPct) / 100;
  return Array.from({ length: Number(config.slots) }, (_, index) => ({
    level: index + 1,
    price: round(anchor * step ** (index + 1), 4)
  }));
}

function exitFromBar(position, session, globalIndex, side, config) {
  if (position.filledIndex === globalIndex) return null;
  const short = side === "short";
  const open = Number(session.open);
  const high = Number(session.high);
  const low = Number(session.low);
  const hitStop = short ? high >= position.stopLoss : low <= position.stopLoss;
  const hitTarget = short ? low <= position.target : high >= position.target;

  if ((!short && open <= position.stopLoss) || (short && open >= position.stopLoss)) {
    return { exit: open, outcome: "stop-gap", exitSession: session.session };
  }
  if ((!short && open >= position.target) || (short && open <= position.target)) {
    return { exit: open, outcome: "target-gap", exitSession: session.session };
  }
  if (hitStop) {
    return { exit: position.stopLoss, outcome: hitTarget ? "stop-ambiguous" : "stop", exitSession: session.session };
  }
  if (hitTarget) return { exit: position.target, outcome: "target", exitSession: session.session };
  if (globalIndex - position.filledIndex + 1 >= Number(config.maxHoldingSessions)) {
    return { exit: Number(session.close), outcome: "time-stop", exitSession: session.session };
  }
  return null;
}

function priceTrade(position, exit, side, config) {
  const short = side === "short";
  const grossPct = (short ? 1 - exit.exit / position.entry : exit.exit / position.entry - 1) * 100;
  const adverse = ["stop", "stop-gap", "stop-ambiguous", "stop-entry-session", "time-stop"].includes(exit.outcome)
    ? Number(config.adverseExitSlippagePct)
    : 0;
  const netPct = grossPct - Number(config.costPct) - adverse;
  return {
    ...position,
    ...exit,
    sessionsHeld: position.lastIndex - position.filledIndex + 1,
    grossPct: round(grossPct, 4),
    netPct: round(netPct, 4)
  };
}

function entryFill(level, session, side, requireTradeThrough = true, tickTolerance = 1e-8) {
  const short = side === "short";
  const opensThrough = short ? session.open >= level.price : session.open <= level.price;
  const tradesThrough = short ? session.high > level.price + tickTolerance : session.low < level.price - tickTolerance;
  const touches = short ? session.high >= level.price : session.low <= level.price;
  if (!opensThrough && !(requireTradeThrough ? tradesThrough : touches)) return null;
  if (opensThrough) return short ? Math.max(session.open, level.price) : Math.min(session.open, level.price);
  return level.price;
}

function replayContinuous(weeks, side = "long", overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const ordered = Array.isArray(weeks) ? weeks.filter(Boolean) : [];
  const short = side === "short";
  const sign = short ? -1 : 1;
  const positions = [];
  const trades = [];
  const rebases = [];
  const filledLevelIds = new Set();
  const cohorts = ordered.map((week) => ({
    weekKey: week.weekKey,
    sessions: week.sessions.length,
    anchor: round(week.sessions[0]?.open),
    levels: ladder(Number(week.sessions[0]?.open), side, config),
    trades: [],
    complete: true,
    openAtEnd: 0,
    weekNetPct: 0,
    cohortNetPct: 0
  }));
  const cohortByWeek = new Map(cohorts.map((cohort) => [cohort.weekKey, cohort]));
  let globalIndex = -1;

  ordered.forEach((week, weekIndex) => {
    const cohort = cohortByWeek.get(week.weekKey);
    week.sessions.forEach((session, sessionIndex) => {
      globalIndex += 1;

      if (sessionIndex === 0) {
        for (const position of positions) {
          const priorReference = Number(position.weeklyReferencePrice);
          position.completedWeeklyPnlPct = round(Number(position.completedWeeklyPnlPct || 0) + sign * (Number(position.previousClose) / priorReference - 1) * 100, 4);
          const gapPct = sign * (Number(session.open) / Number(position.previousClose) - 1) * 100;
          position.weekendGapPnlPct = round(Number(position.weekendGapPnlPct || 0) + gapPct, 4);
          position.weeklyReferencePrice = Number(session.open);
          rebases.push({ positionId: position.positionId, weekKey: week.weekKey, session: session.session, referencePrice: session.open, gapPct: round(gapPct, 4) });
        }
      }

      for (let index = positions.length - 1; index >= 0; index -= 1) {
        const position = positions[index];
        position.lastIndex = globalIndex;
        const exit = exitFromBar(position, session, globalIndex, side, config);
        if (!exit) {
          position.previousClose = Number(session.close);
          continue;
        }
        const trade = priceTrade(position, exit, side, config);
        positions.splice(index, 1);
        trades.push(trade);
        cohortByWeek.get(position.originWeek).trades.push(trade);
      }

      const lastSessionOfWeek = sessionIndex === week.sessions.length - 1;
      if (lastSessionOfWeek) return; // Friday/holiday-week last session: no new risk, no forced exit
      if (positions.length >= Number(config.maxConcurrentPositions)) return;

      for (const level of cohort.levels) {
        if (positions.length >= Number(config.maxConcurrentPositions)) break;
        const levelId = `${side}:${week.weekKey}:L${level.level}`;
        if (filledLevelIds.has(levelId)) continue;
        const fillPrice = entryFill(level, session, side, config.fillRequiresTradeThrough !== false);
        if (!(fillPrice > 0)) continue;
        const target = round(level.price * (1 + sign * Number(config.targetPct) / 100), 4);
        const stopLoss = round(level.price * (1 - sign * Number(config.stopLossPct) / 100), 4);
        if (short ? fillPrice >= stopLoss : fillPrice <= stopLoss) continue;
        filledLevelIds.add(levelId);
        const position = {
          positionId: levelId,
          originWeek: week.weekKey,
          level: level.level,
          requestedEntry: level.price,
          entry: round(fillPrice, 4),
          target,
          stopLoss,
          filledSession: session.session,
          filledIndex: globalIndex,
          lastIndex: globalIndex,
          weeklyReferencePrice: fillPrice,
          previousClose: Number(session.close),
          completedWeeklyPnlPct: 0,
          weekendGapPnlPct: 0
        };
        const entryBarStop = short ? session.high >= stopLoss : session.low <= stopLoss;
        if (entryBarStop) {
          const trade = priceTrade(position, { exit: stopLoss, outcome: "stop-entry-session", exitSession: session.session }, side, config);
          trades.push(trade);
          cohort.trades.push(trade);
        } else positions.push(position);
      }
    });
  });

  for (const cohort of cohorts) {
    const openAtEnd = positions.filter((position) => position.originWeek === cohort.weekKey);
    cohort.openAtEnd = openAtEnd.length;
    cohort.complete = openAtEnd.length === 0;
    const sumNetPct = cohort.trades.reduce((sum, trade) => sum + Number(trade.netPct), 0);
    cohort.sumNetPct = round(sumNetPct, 4);
    cohort.capitalWeightedNetPct = round(sumNetPct / Number(config.slots), 4);
    cohort.cohortNetPct = config.capitalWeighted !== false ? cohort.capitalWeightedNetPct : cohort.sumNetPct;
    cohort.weekNetPct = cohort.cohortNetPct;
  }

  const lastClose = Number(ordered.at(-1)?.sessions.at(-1)?.close);
  const openPositions = positions.map((position) => ({
    ...position,
    censored: true,
    markedAt: lastClose,
    grossMarkedPct: round(sign * (lastClose / position.entry - 1) * 100, 4)
  }));
  return { side, config, cohorts, trades, openPositions, rebases };
}

function replayWeek(week, side, overrides = {}) {
  const simulation = replayContinuous([week], side, overrides);
  const cohort = simulation.cohorts[0];
  return cohort ? { ...cohort, openPositions: simulation.openPositions, rebases: simulation.rebases } : null;
}

function wilsonBounds(successes, total, z = 1.96) {
  if (!total) return { lowerPct: null, upperPct: null };
  const proportion = successes / total;
  const denominator = 1 + z ** 2 / total;
  const centre = proportion + z ** 2 / (2 * total);
  const spread = z * Math.sqrt(proportion * (1 - proportion) / total + z ** 2 / (4 * total ** 2));
  return {
    lowerPct: round(Math.max(0, (centre - spread) / denominator) * 100),
    upperPct: round(Math.min(1, (centre + spread) / denominator) * 100)
  };
}

// One-way cluster-robust standard error for an intercept (the sample mean).
// Every rung in the same symbol-week shares the same market shock, so treating
// those fills as independent would manufacture precision.
function clusterStandardError(values, clusterIds) {
  if (!Array.isArray(values) || values.length < 2 || values.length !== clusterIds?.length) return null;
  const average = mean(values.map(Number));
  const sums = new Map();
  values.forEach((value, index) => {
    const id = String(clusterIds[index]);
    sums.set(id, Number(sums.get(id) || 0) + Number(value) - average);
  });
  const clusters = [...sums.values()];
  if (clusters.length < 2) return null;
  const variance = (clusters.length / (clusters.length - 1))
    * clusters.reduce((sum, residualSum) => sum + residualSum ** 2, 0)
    / values.length ** 2;
  return round(Math.sqrt(Math.max(0, variance)), 6);
}

function conditionalValueAtRisk(returns, tailProbability = 0.05) {
  const losses = (Array.isArray(returns) ? returns : []).map(Number).filter(Number.isFinite).map((value) => Math.max(0, -value)).sort((a, b) => b - a);
  if (!losses.length) return null;
  const count = Math.max(1, Math.ceil(losses.length * Number(tailProbability)));
  return round(mean(losses.slice(0, count)), 4);
}

function tradeStats(trades, weeklyObservations = []) {
  const netReturns = trades.map((trade) => Number(trade.netPct));
  const targetHits = trades.filter((trade) => trade.outcome === "target" || trade.outcome === "target-gap").length;
  const gains = netReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(netReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const blockMean = mean(weeklyObservations);
  // Aggregate adjacent cohorts before estimating uncertainty; a carried trade
  // can span several anchor weeks. This remains a research approximation, not
  // a claim that all blocks or Wilson hit-rate intervals are independent.
  const blockMeans = [];
  for (let index = 0; index + 5 <= weeklyObservations.length; index += 5) blockMeans.push(mean(weeklyObservations.slice(index, index + 5)));
  const blockSigma = deviation(blockMeans);
  const standardError = blockMeans.length > 1 && blockSigma > 1e-6 ? blockSigma / Math.sqrt(blockMeans.length) : null;
  return {
    fills: trades.length,
    targetHits,
    stopExits: trades.filter((trade) => String(trade.outcome).startsWith("stop")).length,
    timeStops: trades.filter((trade) => trade.outcome === "time-stop").length,
    fridayBooks: 0,
    hitRatePct: trades.length ? round(targetHits / trades.length * 100) : null,
    ...wilsonBounds(targetHits, trades.length),
    averageNetPct: trades.length ? round(mean(netReturns), 3) : null,
    averageWeeklyContributionPct: round(blockMean, 4),
    medianSessionsHeld: trades.length ? trades.map((trade) => trade.sessionsHeld).sort((a, b) => a - b)[Math.floor(trades.length / 2)] : null,
    profitFactor: losses ? round(gains / losses) : gains ? 99 : 0,
    worstTradePct: netReturns.length ? round(Math.min(...netReturns), 3) : null,
    standardErrorPct: round(standardError, 4),
    tStat: standardError === null ? null : round(blockMean / standardError, 2),
    independentWeekBlocks: null,
    fiveWeekBlocks: blockMeans.length,
    uncertaintyMethod: "NON_OVERLAPPING_FIVE_WEEK_BLOCK_MEANS_RESEARCH_APPROXIMATION"
  };
}

function cohortReturns(cohorts, levels, config) {
  const allowed = new Set(levels);
  return cohorts.map((cohort) => round(
    cohort.trades.filter((trade) => allowed.has(trade.level)).reduce((sum, trade) => sum + Number(trade.netPct), 0) / Number(config.slots),
    4
  ));
}

function weekStats(cohorts, levels = null, config = DEFAULT_CONFIG) {
  const selected = levels ? cohortReturns(cohorts, levels, config) : cohorts.map((cohort) => Number(cohort.weekNetPct));
  const positive = selected.filter((value) => value > 0).length;
  const traded = cohorts.filter((cohort) => cohort.trades.length).length;
  const averageWeeklyPct = mean(selected);
  const sigma = deviation(selected);
  return {
    weeks: cohorts.length,
    tradedWeeks: traded,
    participationPct: cohorts.length ? round(traded / cohorts.length * 100) : null,
    positiveWeeks: positive,
    averageWeeklyPct: round(averageWeeklyPct, 3),
    worstWeekPct: selected.length ? round(Math.min(...selected), 3) : null,
    bestWeekPct: selected.length ? round(Math.max(...selected), 3) : null,
    // Cohort labels can overlap for up to maxHoldingSessions; sqrt(52) would
    // falsely imply independent weekly returns.
    annualisedSharpe: null,
    annualisationValid: false,
    returnVolRatio: sigma ? round(averageWeeklyPct / sigma, 2) : null,
    expectedShortfall95Pct: conditionalValueAtRisk(selected, 0.05)
  };
}

function levelBreakdown(cohorts, config) {
  return Array.from({ length: Number(config.slots) }, (_, index) => {
    const level = index + 1;
    const trades = cohorts.flatMap((cohort) => cohort.trades.filter((trade) => trade.level === level));
    const observations = cohortReturns(cohorts, [level], config);
    return { level, stepPct: round(level * Number(config.stepPct), 2), ...tradeStats(trades, observations) };
  });
}

function sideResult(weeks, side, config) {
  const simulation = replayContinuous(weeks, side, config);
  const complete = simulation.cohorts.filter((cohort) => cohort.complete);
  // Split on input dates, never on future-dependent counts of resolved labels.
  const developmentEnd = Math.max(1, Math.floor(weeks.length * Number(config.developmentRatio)));
  const validationEnd = Math.max(developmentEnd + 1, Math.floor(weeks.length * (Number(config.developmentRatio) + Number(config.validationRatio))));
  const validationFrom = weeks[Math.min(developmentEnd, weeks.length - 1)].weekKey;
  const finalTestFrom = weeks[Math.min(validationEnd, weeks.length - 1)].weekKey;
  const development = complete.filter((cohort) => cohort.weekKey < validationFrom && cohort.trades.every((trade) => trade.exitSession < validationFrom));
  const validation = complete.filter((cohort) => cohort.weekKey >= validationFrom && cohort.weekKey < finalTestFrom && cohort.trades.every((trade) => trade.exitSession < finalTestFrom));
  const finalTest = complete.filter((cohort) => cohort.weekKey >= finalTestFrom);
  const developmentLevels = levelBreakdown(development, config);
  const validationLevels = levelBreakdown(validation, config);
  const hurdle = Math.sqrt(2 * Math.log(Number(config.slots) + 1));
  const requiredFills = Math.max(8, Math.floor(development.length * 0.10));
  const selectedOnDevelopment = developmentLevels.filter((entry) =>
    entry.fills >= requiredFills
    && entry.averageWeeklyContributionPct > 0
    && Number(entry.tStat) >= hurdle
    && Number(entry.lowerPct) >= 45
  ).map((entry) => entry.level);
  const viableLevels = selectedOnDevelopment.filter((level) => {
    const check = validationLevels.find((entry) => entry.level === level);
    return check && check.fills >= 3 && Number(check.averageWeeklyContributionPct) > 0;
  });
  const allLevels = levelBreakdown(complete, config);
  const allTrades = complete.flatMap((cohort) => cohort.trades);
  const validationTrades = validation.flatMap((cohort) => cohort.trades.filter((trade) => viableLevels.includes(trade.level)));
  const finalTrades = finalTest.flatMap((cohort) => cohort.trades.filter((trade) => viableLevels.includes(trade.level)));

  return {
    side,
    ...weekStats(complete, null, config),
    censoredCohorts: simulation.cohorts.length - complete.length,
    splitBoundaries: { validationFrom, finalTestFrom, purgedBoundaryCohorts: complete.length - development.length - validation.length - finalTest.length },
    openPositionsAtHistoryEnd: simulation.openPositions.length,
    trades: tradeStats(allTrades, complete.map((cohort) => cohort.weekNetPct)),
    development: { ...weekStats(development, selectedOnDevelopment, config), levels: developmentLevels },
    outOfSample: {
      ...weekStats(validation, viableLevels, config),
      trades: tradeStats(validationTrades, cohortReturns(validation, viableLevels, config)),
      purpose: "validation used to confirm development-selected rungs"
    },
    finalTest: {
      ...weekStats(finalTest, viableLevels, config),
      trades: tradeStats(finalTrades, cohortReturns(finalTest, viableLevels, config)),
      levels: levelBreakdown(finalTest, config),
      purpose: "untouched reporting only; never used by verdict, ranking, sizing or thresholds"
    },
    // Decision-facing rung statistics stop at validation. Full-history and final
    // test statistics remain available only under explicitly reporting fields.
    levels: validationLevels,
    reportingAllLevels: allLevels,
    selectedOnDevelopment,
    viableLevels,
    significanceHurdleTStat: round(hurdle, 2),
    expectedWeeklyPct: round(viableLevels.reduce((sum, level) => {
      const stat = validationLevels.find((entry) => entry.level === level);
      return sum + Number(stat?.averageWeeklyContributionPct || 0);
    }, 0), 3),
    replay: simulation
  };
}

function verdict(long, short) {
  const candidates = [long, short]
    .filter((result) => result.viableLevels.length && Number(result.expectedWeeklyPct) > 0)
    .sort((left, right) => Number(right.expectedWeeklyPct) - Number(left.expectedWeeklyPct));
  const best = candidates[0];
  if (!best) {
    return { action: "stand-aside", side: null, levels: [], reason: "No development-selected rung retained positive validation economics" };
  }
  return {
    action: best.side === "short" ? "sell-ladder" : "buy-ladder",
    side: best.side,
    levels: best.viableLevels,
    expectedWeeklyPct: best.expectedWeeklyPct,
    hitRateLowerPct: best.levels.find((entry) => entry.level === best.viableLevels[0])?.lowerPct ?? null,
    reason: `Rungs ${best.viableLevels.join(", ")} passed development t≥${best.significanceHurdleTStat} and retained positive validation contribution`
  };
}

function weeklyCycle(bars, overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const weeks = tradingWeeks(bars);
  const minimumWeeks = Number(overrides.minimumWeeks) || 60;
  if (weeks.length < minimumWeeks) {
    return { ready: false, weeks: weeks.length, minimumWeeks, reason: `Need at least ${minimumWeeks} trading weeks to measure the continuous ladder` };
  }
  const long = sideResult(weeks, "long", config);
  const short = sideResult(weeks, "short", config);
  const validationStart = Math.max(1, Math.floor(weeks.length * Number(config.developmentRatio)));
  return {
    ready: true,
    strategyId: config.strategyId,
    strategyVersion: config.strategyVersion,
    method: "continuous ladder: weekly anchor and entries, no automatic Friday exit, target/stop/time-risk exit, censored unresolved cohorts",
    evidenceClass: "ADJUSTED_CASH_PROXY_RESEARCH_ONLY_NOT_POINT_IN_TIME_FUTURES",
    config,
    weeks: weeks.length,
    firstWeek: weeks[0].weekKey,
    lastWeek: weeks.at(-1).weekKey,
    outOfSampleFrom: weeks[Math.min(validationStart, weeks.length - 1)].weekKey,
    long,
    short,
    verdict: verdict(long, short)
  };
}

module.exports = {
  DEFAULT_CONFIG,
  cohortReturns,
  clusterStandardError,
  conditionalValueAtRisk,
  ladder,
  levelBreakdown,
  replayContinuous,
  replayWeek,
  tradingWeeks,
  weeklyCycle,
  weekKeyOf,
  wilsonBounds
};
