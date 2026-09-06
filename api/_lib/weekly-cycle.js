// Measures the edge of the desk's real trade instead of a generic hold period.
//
// The rule being evaluated, exactly as it is traded: the week's first session
// open is the anchor; ladder orders rest 2% apart from it (below for longs,
// above for shorts); a filled leg exits on the first touch of its 2% target;
// anything still open is booked at the Friday close. That is a triple-barrier
// trade — profit barrier, and a vertical barrier at the end of the week — so it
// is measured that way rather than as an n-session hold, which would credit
// profits this desk never holds for and hide the Friday book-outs it always
// takes.

const DEFAULT_CONFIG = Object.freeze({
  stepPct: 2,
  targetPct: 2,
  slots: 5,
  // C-1: Mandatory default 2% stop-loss barrier on every ladder rung
  stopLossPct: 2.0,
  // C-2: Mandatory capital-weighted return (1/slots per rung) as the system default
  capitalWeighted: true,
  // Liquid NSE stock futures: statutory round-trip cost (0.05% STT on sell + 0.00183% exchange + GST + stamp duty ~ 0.08%)
  costPct: 0.08,
  fridaySlippagePct: 0.02
});

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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

// Groups daily bars into trading weeks. A holiday-shortened week keeps whatever
// sessions it has: its first session is the anchor and its last is the book-out,
// which is what the desk actually trades through.
function tradingWeeks(bars, options = {}) {
  const minimumSessions = Number.isFinite(Number(options.minimumSessions)) ? Number(options.minimumSessions) : 2;
  const weeks = new Map();
  (Array.isArray(bars) ? bars : []).forEach((bar) => {
    const close = Number(bar.close);
    const high = Number(bar.high);
    const low = Number(bar.low);
    if (![close, high, low].every(Number.isFinite)) return;
    const session = istDate(bar.timestamp);
    const key = weekKeyOf(session);
    if (!weeks.has(key)) weeks.set(key, { weekKey: key, sessions: [] });
    weeks.get(key).sessions.push({
      session,
      open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : close,
      high, low, close,
      volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null
    });
  });
  return [...weeks.values()]
    .filter((week) => week.sessions.length >= minimumSessions)
    .sort((left, right) => left.weekKey.localeCompare(right.weekKey));
}

function ladder(anchor, side, config) {
  const direction = side === "short" ? 1 : -1;
  const step = 1 + direction * Number(config.stepPct) / 100;
  return Array.from({ length: config.slots }, (_, index) => ({
    level: index + 1,
    price: round(anchor * step ** (index + 1), 4)
  }));
}

// Replays one week's ladder bar by bar. A leg never exits on the session that
// filled it: intraday high/low ordering is unknown inside a daily bar, and
// assuming the favourable sequence is how backtests invent profit.
function replayWeek(week, side, config) {
  const anchor = week.sessions[0].open;
  if (!(anchor > 0)) return null;
  const levels = ladder(anchor, side, config);
  const short = side === "short";
  const targetStep = 1 + (short ? -1 : 1) * Number(config.targetPct) / 100;
  const stopLossPct = Number(config.stopLossPct ?? DEFAULT_CONFIG.stopLossPct) || null;
  const stopLossStep = stopLossPct ? (1 - (short ? -1 : 1) * stopLossPct / 100) : null;
  const open = new Map();
  const trades = [];

  week.sessions.forEach((session, index) => {
    const last = index === week.sessions.length - 1;

    for (const [level, lot] of [...open]) {
      if (lot.filledIndex === index) continue;
      const targetReached = short ? session.low <= lot.target : session.high >= lot.target;
      const stopReached = lot.stopLoss ? (short ? session.high >= lot.stopLoss : session.low <= lot.stopLoss) : false;

      // Conservative Ambiguity Resolution (P0-007):
      // If both stop and target are breached in the same daily bar, assume the stop barrier was hit first.
      if (stopReached && targetReached) {
        open.delete(level);
        trades.push({ ...lot, exit: lot.stopLoss, exitSession: session.session, outcome: "stop", sessionsHeld: index - lot.filledIndex });
      } else if (stopReached) {
        open.delete(level);
        trades.push({ ...lot, exit: lot.stopLoss, exitSession: session.session, outcome: "stop", sessionsHeld: index - lot.filledIndex });
      } else if (targetReached) {
        open.delete(level);
        trades.push({ ...lot, exit: lot.target, exitSession: session.session, outcome: "target", sessionsHeld: index - lot.filledIndex });
      }
    }

    if (!last) {
      levels.forEach((entry) => {
        if (open.has(entry.level) || trades.some((trade) => trade.level === entry.level)) return;
        const filled = short ? session.high >= entry.price : session.low <= entry.price;
        if (!filled) return;
        open.set(entry.level, {
          level: entry.level,
          entry: entry.price,
          target: round(entry.price * targetStep, 4),
          stopLoss: stopLossStep ? round(entry.price * stopLossStep, 4) : null,
          filledSession: session.session,
          filledIndex: index
        });
      });
      return;
    }

    // Friday: fill nothing new, then book whatever is still open at the close.
    for (const [level, lot] of [...open]) {
      open.delete(level);
      trades.push({ ...lot, exit: session.close, exitSession: session.session, outcome: "friday", sessionsHeld: index - lot.filledIndex });
    }
  });

  const priced = trades.map((trade) => {
    // Both sides are measured as P&L over the entry notional, which is also what
    // the margin is posted against. Scoring a short as entry/exit - 1 would
    // quietly inflate every winning short and shrink every losing one.
    const gross = (short ? 1 - trade.exit / trade.entry : trade.exit / trade.entry - 1) * 100;
    const cost = Number(config.costPct) + ((trade.outcome === "friday" || trade.outcome === "stop") ? Number(config.fridaySlippagePct) : 0);
    return { ...trade, grossPct: round(gross, 4), netPct: round(gross - cost, 4) };
  });

  const sumNetPct = round(priced.reduce((sum, trade) => sum + trade.netPct, 0), 4);
  const capitalSlots = Number(config.slots) || 5;
  const capitalWeightedNetPct = round(priced.reduce((sum, trade) => sum + (trade.netPct / capitalSlots), 0), 4);

  return {
    weekKey: week.weekKey,
    sessions: week.sessions.length,
    anchor: round(anchor),
    levels,
    trades: priced,
    sumNetPct,
    capitalWeightedNetPct,
    weekNetPct: config.capitalWeighted !== false ? capitalWeightedNetPct : sumNetPct
  };
}

// Wilson score interval: with 8 fills a raw 75% hit rate and a real 75% edge are
// indistinguishable, so the lower bound is what sizing decisions should read.
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

function tradeStats(trades) {
  const netReturns = trades.map((trade) => trade.netPct);
  const targetHits = trades.filter((trade) => trade.outcome === "target").length;
  const gains = netReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(netReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const averageNetPct = mean(netReturns);
  const sigma = deviation(netReturns);
  // A handful of identical outcomes (three fills that all hit the same target)
  // has a sigma of ~1e-16, which would divide out to a t-statistic of 1e16 and
  // wave a three-trade sample straight through the hurdle. Net returns are
  // percentages rounded to 1e-4, so the floor sits above that rounding grain and
  // far below any real dispersion: less than a thousandth of a percentage point
  // of spread is not a measurement.
  const standardError = netReturns.length > 1 && sigma > 1e-3 ? sigma / Math.sqrt(netReturns.length) : null;
  return {
    fills: trades.length,
    targetHits,
    fridayBooks: trades.filter((trade) => trade.outcome === "friday").length,
    hitRatePct: trades.length ? round(targetHits / trades.length * 100) : null,
    ...wilsonBounds(targetHits, trades.length),
    averageNetPct: round(averageNetPct, 3),
    medianSessionsHeld: trades.length
      ? trades.map((trade) => trade.sessionsHeld).sort((a, b) => a - b)[Math.floor(trades.length / 2)]
      : null,
    profitFactor: losses ? round(gains / losses) : gains ? 99 : 0,
    worstTradePct: netReturns.length ? round(Math.min(...netReturns), 3) : null,
    standardErrorPct: round(standardError, 3),
    tStat: standardError === null ? null : round(averageNetPct / standardError, 2)
  };
}

function weekStats(weeks) {
  const weekly = weeks.map((week) => week.weekNetPct);
  const positive = weekly.filter((value) => value > 0).length;
  const traded = weeks.filter((week) => week.trades.length).length;
  const averageWeeklyPct = mean(weekly);
  const sigma = deviation(weekly);
  return {
    weeks: weeks.length,
    tradedWeeks: traded,
    participationPct: weeks.length ? round(traded / weeks.length * 100) : null,
    positiveWeeks: positive,
    averageWeeklyPct: round(averageWeeklyPct, 3),
    worstWeekPct: weekly.length ? round(Math.min(...weekly), 3) : null,
    bestWeekPct: weekly.length ? round(Math.max(...weekly), 3) : null,
    // Weekly returns are independent draws under this rule (every position is
    // flat by Friday), so a plain sqrt(52) annualisation is defensible here.
    annualisedSharpe: sigma ? round(averageWeeklyPct / sigma * Math.sqrt(52), 2) : null
  };
}

function levelBreakdown(weeks, config) {
  return Array.from({ length: config.slots }, (_, index) => {
    const level = index + 1;
    const trades = weeks.flatMap((week) => week.trades.filter((trade) => trade.level === level));
    return { level, stepPct: round(level * Number(config.stepPct), 2), ...tradeStats(trades) };
  });
}

function sideResult(weeks, side, config, splitRatio) {
  const replayed = weeks.map((week) => replayWeek(week, side, config)).filter(Boolean);
  const cut = Math.max(1, Math.floor(replayed.length * splitRatio));
  const inSample = replayed.slice(0, cut);
  const outOfSample = replayed.slice(cut);
  const allTrades = replayed.flatMap((week) => week.trades);
  const outTrades = outOfSample.flatMap((week) => week.trades);

  // P0-009: Strict in-sample level selection without lookahead leakage
  const inSampleLevels = levelBreakdown(inSample, config);
  const hurdle = Math.sqrt(2 * Math.log(config.slots + 1));
  const requiredFills = Math.max(3, Math.floor(8 * splitRatio));
  const viableInSample = inSampleLevels.filter((entry) =>
    entry.fills >= requiredFills &&
    entry.averageNetPct > 0 &&
    Number(entry.tStat) >= hurdle &&
    Number(entry.lowerPct) >= 45
  );

  const viableLevels = viableInSample.map((entry) => entry.level);
  const outTradesViable = viableLevels.length ? outTrades.filter((t) => viableLevels.includes(t.level)) : outTrades;
  const levels = levelBreakdown(replayed, config);

  return {
    side,
    ...weekStats(replayed),
    trades: tradeStats(allTrades),
    outOfSample: { weeks: outOfSample.length, ...weekStats(outOfSample), trades: tradeStats(outTradesViable) },
    levels,
    viableLevels,
    significanceHurdleTStat: round(hurdle, 2),
    expectedWeeklyPct: round(viableInSample.reduce((sum, entry) => sum + entry.averageNetPct * entry.fills / Math.max(1, inSample.length), 0), 3)
  };
}

function verdict(long, short) {
  // M-1: Select candidate side based strictly on in-sample viable rungs and positive expected weekly return.
  // Held-out out-of-sample data is preserved for honest validation, not for directional selection.
  const candidates = [long, short]
    .filter((side) => side.viableLevels.length && Number(side.expectedWeeklyPct) > 0)
    .sort((left, right) => Number(right.expectedWeeklyPct) - Number(left.expectedWeeklyPct));
  const best = candidates[0];
  if (!best) {
    return {
      action: "stand-aside",
      side: null,
      levels: [],
      reason: "No ladder rung cleared its significance hurdle with positive in-sample expected return"
    };
  }
  return {
    action: best.side === "short" ? "sell-ladder" : "buy-ladder",
    side: best.side,
    levels: best.viableLevels,
    expectedWeeklyPct: best.expectedWeeklyPct,
    hitRateLowerPct: best.levels.find((entry) => entry.level === best.viableLevels[0])?.lowerPct ?? null,
    reason: `Rungs ${best.viableLevels.join(", ")} cleared in-sample t≥${best.significanceHurdleTStat} (OOS week: ${best.outOfSample.averageWeeklyPct}%)`
  };
}

function weeklyCycle(bars, overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const weeks = tradingWeeks(bars);
  const minimumWeeks = Number(overrides.minimumWeeks) || 60;
  if (weeks.length < minimumWeeks) {
    return {
      ready: false,
      weeks: weeks.length,
      minimumWeeks,
      reason: `Need at least ${minimumWeeks} complete trading weeks to measure the weekly cycle`
    };
  }
  const splitRatio = Number(overrides.splitRatio) || 0.7;
  const long = sideResult(weeks, "long", config, splitRatio);
  const short = sideResult(weeks, "short", config, splitRatio);
  return {
    ready: true,
    method: "weekly triple barrier: anchor at the week's first open, 2% ladder fills, first-touch 2% target, forced book-out at the Friday close",
    config,
    weeks: weeks.length,
    firstWeek: weeks[0].weekKey,
    lastWeek: weeks.at(-1).weekKey,
    outOfSampleFrom: weeks[Math.max(1, Math.floor(weeks.length * splitRatio))].weekKey,
    long,
    short,
    verdict: verdict(long, short)
  };
}

module.exports = { DEFAULT_CONFIG, ladder, replayWeek, tradingWeeks, weeklyCycle, weekKeyOf, wilsonBounds };
