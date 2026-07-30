const ROUND_TRIP_COST_PCT = 0.25;

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

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
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function average(bars, end, period, field = "close") {
  if (end + 1 < period) return null;
  return mean(bars.slice(end - period + 1, end + 1).map((bar) => Number(bar[field])).filter(Number.isFinite));
}

function zScoreAt(bars, index, period = 20) {
  const values = bars.slice(index - period + 1, index + 1).map((bar) => Number(bar.close)).filter(Number.isFinite);
  if (values.length < period) return 0;
  const sigma = deviation(values);
  return sigma ? (Number(bars[index].close) - mean(values)) / sigma : 0;
}

function rsiAt(bars, index, period = 14) {
  if (index < period) return 50;
  let gains = 0;
  let losses = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const change = Number(bars[cursor].close) - Number(bars[cursor - 1].close);
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function candleAt(bars, index) {
  const bar = bars[index];
  const prior = bars[index - 1] || bar;
  const prior2 = bars[index - 2] || prior;
  const open = Number.isFinite(bar.open) ? Number(bar.open) : Number(prior.close);
  const priorOpen = Number.isFinite(prior.open) ? Number(prior.open) : Number(prior2.close);
  const range = Math.max(Number(bar.high) - Number(bar.low), Number(bar.close) * 0.0001);
  const body = Math.abs(Number(bar.close) - open);
  const upper = Number(bar.high) - Math.max(open, Number(bar.close));
  const lower = Math.min(open, Number(bar.close)) - Number(bar.low);
  const location = (Number(bar.close) - Number(bar.low)) / range;
  const bullishThree = [prior2, prior, bar].every((item) => Number(item.close) > Number(item.open))
    && Number(prior2.close) < Number(prior.close) && Number(prior.close) < Number(bar.close);
  const bearishThree = [prior2, prior, bar].every((item) => Number(item.close) < Number(item.open))
    && Number(prior2.close) > Number(prior.close) && Number(prior.close) > Number(bar.close);

  if (bullishThree) return { name: "three advancing candles", direction: 1 };
  if (bearishThree) return { name: "three declining candles", direction: -1 };
  if (Number(bar.close) > open && Number(prior.close) < priorOpen && open <= Number(prior.close) && Number(bar.close) >= priorOpen) {
    return { name: "bullish engulfing", direction: 1 };
  }
  if (Number(bar.close) < open && Number(prior.close) > priorOpen && open >= Number(prior.close) && Number(bar.close) <= priorOpen) {
    return { name: "bearish engulfing", direction: -1 };
  }
  if (lower >= Math.max(body * 2, range * 0.45) && upper <= range * 0.2) return { name: "hammer-like rejection", direction: 1 };
  if (upper >= Math.max(body * 2, range * 0.45) && lower <= range * 0.2) return { name: "shooting-star rejection", direction: -1 };
  if (body <= range * 0.12) return { name: "doji-like indecision", direction: 0 };
  if (Number(bar.high) < Number(prior.high) && Number(bar.low) > Number(prior.low)) return { name: "inside day", direction: 0 };
  if (Number(bar.high) > Number(prior.high) && Number(bar.low) < Number(prior.low)) {
    return { name: "outside day", direction: Number(bar.close) >= open ? 0.5 : -0.5 };
  }
  if (location >= 0.75) return { name: "strong close near high", direction: 0.6 };
  if (location <= 0.25) return { name: "weak close near low", direction: -0.6 };
  return { name: "balanced candle", direction: 0 };
}

function candleStudy(bars, horizon = 5) {
  if (bars.length < 35) return { ready: false, pattern: "insufficient history", sample: 0, directionScore: 0 };
  const current = candleAt(bars, bars.length - 1);
  const returns = [];
  for (let index = 20; index < bars.length - horizon - 1; index += 1) {
    const pattern = candleAt(bars, index);
    if (pattern.name !== current.name || !pattern.direction) continue;
    const entry = Number(bars[index + 1].open ?? bars[index + 1].close);
    const exit = Number(bars[index + horizon].close);
    if (!(entry > 0) || !(exit > 0)) continue;
    returns.push(pattern.direction * (exit / entry - 1) * 100 - ROUND_TRIP_COST_PCT);
  }
  const wins = returns.filter((value) => value > 0).length;
  const averageNetReturnPct = mean(returns);
  const standardErrorPct = returns.length ? deviation(returns) / Math.sqrt(returns.length) : null;
  const winRatePct = returns.length ? wins / returns.length * 100 : null;
  const empirical = returns.length >= 5
    ? clamp(averageNetReturnPct / 2) * 0.6 + clamp((winRatePct - 50) / 20) * 0.4
    : 0;
  const sampleWeight = Math.min(1, returns.length / 20);
  const directionScore = clamp(current.direction * (0.45 + 0.55 * empirical * sampleWeight));
  return {
    ready: returns.length >= 5,
    pattern: current.name,
    intrinsicDirection: current.direction,
    directionScore: round(directionScore, 4),
    horizonSessions: horizon,
    sample: returns.length,
    wins,
    winRatePct: round(winRatePct),
    averageNetReturnPct: round(averageNetReturnPct),
    costAssumptionPct: ROUND_TRIP_COST_PCT
  };
}

function maximumDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  returns.forEach((value) => {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  });
  return drawdown;
}

function tradeReturns(bars, candidate, from, to) {
  const output = [];
  const start = Math.max(candidate.minimumHistory || 60, from);
  const last = Math.min(to, bars.length - candidate.hold - 1);
  let nextAllowed = start;
  for (let index = start; index <= last; index += 1) {
    if (index < nextAllowed) continue;
    const direction = Number(candidate.signal(bars, index)) || 0;
    if (!direction) continue;
    const entry = Number(bars[index + 1].open ?? bars[index + 1].close);
    const exit = Number(bars[index + candidate.hold].close);
    if (!(entry > 0) || !(exit > 0)) continue;
    output.push(direction * (exit / entry - 1) * 100 - ROUND_TRIP_COST_PCT);
    nextAllowed = index + candidate.hold;
  }
  return output;
}

function metrics(returns) {
  const wins = returns.filter((value) => value > 0).length;
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const averageNetReturnPct = mean(returns);
  const standardErrorPct = returns.length ? deviation(returns) / Math.sqrt(returns.length) : null;
  const maxDrawdownPct = maximumDrawdown(returns);
  const reliability = Math.sqrt(Math.min(1, returns.length / 24));
  const score = averageNetReturnPct * reliability + ((returns.length ? wins / returns.length : 0.5) - 0.5) * 2 - maxDrawdownPct * 0.025;
  return {
    trades: returns.length,
    wins,
    winRatePct: returns.length ? round(wins / returns.length * 100) : null,
    averageNetReturnPct: round(averageNetReturnPct),
    compoundedReturnPct: round((returns.reduce((equity, value) => equity * (1 + value / 100), 1) - 1) * 100),
    profitFactor: losses ? round(gains / losses) : gains ? 99 : 0,
    maxDrawdownPct: round(maxDrawdownPct),
    standardErrorPct: round(standardErrorPct),
    score: round(score, 4)
  };
}

function candidates() {
  const list = [];
  for (const lookback of [20, 63, 126]) for (const hold of [5, 10]) {
    list.push({
      family: "Time-series momentum", id: `momentum-${lookback}-${hold}`, label: `${lookback}-session direction · ${hold}-session hold`,
      hold, minimumHistory: lookback + 50,
      signal: (bars, index) => {
        const base = Number(bars[index - lookback]?.close);
        const fast = average(bars, index, 20);
        const slow = average(bars, index, 50);
        if (!base || !fast || !slow) return 0;
        const direction = Number(bars[index].close) >= base ? 1 : -1;
        return direction > 0 && fast > slow ? 1 : direction < 0 && fast < slow ? -1 : 0;
      }
    });
  }
  for (const lookback of [20, 55]) for (const hold of [5, 10]) {
    list.push({
      family: "Donchian breakout", id: `donchian-${lookback}-${hold}`, label: `${lookback}-session channel · ${hold}-session hold`,
      hold, minimumHistory: lookback + 2,
      signal: (bars, index) => {
        const prior = bars.slice(index - lookback, index);
        const high = Math.max(...prior.map((bar) => Number(bar.high)));
        const low = Math.min(...prior.map((bar) => Number(bar.low)));
        return Number(bars[index].close) > high ? 1 : Number(bars[index].close) < low ? -1 : 0;
      }
    });
  }
  for (const threshold of [25, 30, 35]) for (const hold of [3, 5]) {
    list.push({
      family: "RSI mean reversion", id: `rsi-${threshold}-${hold}`, label: `RSI ${threshold}/${100 - threshold} · ${hold}-session hold`,
      hold, minimumHistory: 30,
      signal: (bars, index) => {
        const value = rsiAt(bars, index);
        return value <= threshold ? 1 : value >= 100 - threshold ? -1 : 0;
      }
    });
  }
  for (const threshold of [1.5, 2]) for (const hold of [3, 5, 10]) {
    list.push({
      family: "Statistical stretch", id: `zscore-${threshold}-${hold}`, label: `20-session z ±${threshold} · ${hold}-session hold`,
      hold, minimumHistory: 30,
      signal: (bars, index) => {
        const value = zScoreAt(bars, index);
        return value <= -threshold ? 1 : value >= threshold ? -1 : 0;
      }
    });
  }
  for (const hold of [3, 5, 10]) {
    list.push({
      family: "Candlestick confirmation", id: `candle-${hold}`, label: `OHLC pattern · ${hold}-session hold`,
      hold, minimumHistory: 30,
      signal: (bars, index) => candleAt(bars, index).direction
    });
  }
  for (const step of [2, 3]) for (const hold of [3, 5]) {
    list.push({
      family: "Monday grid reversion", id: `monday-${step}-${hold}`, label: `Monday ±${step}% · ${hold}-session hold`,
      hold, minimumHistory: 15,
      signal: (bars, index) => {
        const date = new Date(Number(bars[index].timestamp) * 1000);
        const weekday = date.getUTCDay();
        let cursor = index;
        while (cursor > 0) {
          const priorWeekday = new Date(Number(bars[cursor - 1].timestamp) * 1000).getUTCDay();
          if (priorWeekday > weekday || index - cursor >= 5) break;
          cursor -= 1;
        }
        const anchor = Number(bars[cursor].open ?? bars[cursor].close);
        const move = anchor ? (Number(bars[index].close) / anchor - 1) * 100 : 0;
        return move <= -step ? 1 : move >= step ? -1 : 0;
      }
    });
  }
  return list;
}

function strategyLab(bars) {
  const all = candidates();
  if (!Array.isArray(bars) || bars.length < 300) {
    return { ready: false, sessions: bars?.length || 0, testedCandidates: all.length, reason: "Need at least 300 stored sessions for chronological validation" };
  }
  const cutOne = Math.floor(bars.length * 0.5);
  const cutTwo = Math.floor(bars.length * 0.75);
  const families = [...new Set(all.map((candidate) => candidate.family))];
  const leaderboard = families.map((family) => {
    const familyCandidates = all.filter((candidate) => candidate.family === family);
    const folds = [
      { trainTo: cutOne, testFrom: cutOne, testTo: cutTwo },
      { trainTo: cutTwo, testFrom: cutTwo, testTo: bars.length - 1 }
    ];
    const outOfSample = [];
    const selectedVariants = [];
    folds.forEach((fold) => {
      const ranked = familyCandidates.map((candidate) => ({
        candidate,
        result: metrics(tradeReturns(bars, candidate, 0, fold.trainTo))
      })).filter((item) => item.result.trades >= 5).sort((left, right) => right.result.score - left.result.score);
      const selected = ranked[0]?.candidate;
      if (!selected) return;
      selectedVariants.push(selected.label);
      outOfSample.push(...tradeReturns(bars, selected, fold.testFrom, fold.testTo));
    });
    const result = metrics(outOfSample);
    const multipleTestHurdlePct = Number(result.standardErrorPct || 0) * Math.sqrt(2 * Math.log(familyCandidates.length + 1));
    const currentCandidate = familyCandidates.find((candidate) => candidate.label === selectedVariants.at(-1)) || familyCandidates[0];
    const currentSignal = Number(currentCandidate.signal(bars, bars.length - 1)) || 0;
    const passed = result.trades >= 8 && result.averageNetReturnPct > multipleTestHurdlePct && result.profitFactor > 1 && result.compoundedReturnPct > 0;
    return {
      family,
      selectedVariant: selectedVariants.at(-1) || "No stable variant",
      currentSignal,
      passed,
      multipleTestHurdlePct: round(multipleTestHurdlePct),
      ...result
    };
  }).sort((left, right) => right.score - left.score);
  const passed = leaderboard.filter((item) => item.passed);
  const selected = passed[0] || null;
  return {
    ready: true,
    method: "two-fold expanding-window walk-forward; signals at close, next-open entry",
    sessions: bars.length,
    testedCandidates: all.length,
    testedFamilies: families.length,
    outOfSampleStart: cutOne,
    costAssumptionPct: ROUND_TRIP_COST_PCT,
    passedFamilies: passed.length,
    selected,
    leaderboard
  };
}

function weightedModel(context) {
  const signals = context.signals || {};
  const analog = context.analogModel || {};
  const empirical = context.empirical || {};
  const candle = context.candleStudy || {};
  const lab = context.strategyLab || {};
  const trendScore = clamp((Number(signals.sma20GapPct) + Number(signals.sma50GapPct) + Number(signals.emaSpreadPct) * 2) / 8);
  const momentumScore = clamp(Number(signals.return63Pct) / 12) * 0.7 + clamp(Number(signals.volatilityAdjustedMomentum) / 0.5) * 0.3;
  const reversionScore = clamp(-Number(signals.zScore20) / 2) * 0.6 + clamp((50 - Number(context.rsi14)) / 25) * 0.4;
  const relativeScore = clamp(Number(signals.relativeStrength20Pct) / 6);
  const candleScore = clamp(Number(candle.directionScore));
  const analogScore = analog.ready ? clamp((Number(analog.probabilityUp5Pct) - 50) / 20) * clamp(Number(analog.walkForwardAccuracyPct) / 55, 0, 1) : 0;
  const participationDirection = Math.sign(Number(signals.return5Pct) || Number(signals.closeLocationPct) - 50);
  const volumeScore = clamp((Number(signals.volumeRatio5To20) - 1) / 0.75) * participationDirection;
  const historicalScore = Number.isFinite(empirical.nextDayUpAfterDown2Pct) ? clamp((Number(empirical.nextDayUpAfterDown2Pct) - 50) / 20) : 0;
  const strategyScore = lab.selected?.passed ? clamp(Number(lab.selected.currentSignal)) * clamp(Number(lab.selected.score) / 1.5, 0, 1) : 0;
  const components = [
    ["Trend stack", 22, trendScore, "EMA and 20/50-session direction"],
    ["Medium momentum", 15, momentumScore, "63-session and volatility-adjusted momentum"],
    ["Mean reversion", 14, reversionScore, "RSI and 20-session statistical stretch"],
    ["Relative strength", 12, relativeScore, "Performance versus Nifty"],
    ["Candlestick evidence", 10, candleScore, `${candle.pattern || "No pattern"} · ${candle.sample || 0} comparable historical cases`],
    ["Walk-forward analogues", 10, analogScore, analog.ready ? `${analog.validationTrades || 0} chronological validations` : "Not enough validated analogues"],
    ["Volume confirmation", 5, volumeScore, "Participation relative to 20 sessions"],
    ["Post-shock history", 7, historicalScore, `${empirical.downShockSample || 0} prior daily drops of at least 2%`],
    ["Strategy laboratory", 5, strategyScore, lab.selected?.family || "No strategy family passed"]
  ].map(([name, weight, score, note]) => ({ name, weight, score: round(clamp(score), 4), contribution: round(weight * clamp(score), 2), note }));
  const rawScore = components.reduce((sum, item) => sum + Number(item.contribution), 0);
  const riskPenalty = signals.riskState === "high" ? 18 : signals.riskState === "elevated" ? 8 : 0;
  const score = clamp(rawScore - Math.sign(rawScore || 1) * riskPenalty, -100, 100);
  const confidence = Math.min(100, Math.abs(score) * 1.6);
  return {
    score: round(score),
    confidencePct: round(confidence),
    bias: score >= 20 ? "bullish" : score <= -20 ? "bearish" : "mixed",
    riskPenalty,
    components
  };
}

module.exports = { ROUND_TRIP_COST_PCT, candleAt, candleStudy, strategyLab, weightedModel };
