// Supervised model over the desk's weekly trade.
//
// Family choice: gradient-boosted regression trees. The label is one number per
// symbol-week (the net result of running the ladder), so a single name yields
// roughly 250 rows of five years' history and the pooled F&O universe yields
// order 10^5 - tabular, low-signal, heteroscedastic data. Boosted trees are the
// established choice at that shape; a deep network needs orders of magnitude
// more rows before it stops memorising, and on this data it mostly fits the
// 2020 and 2024 volatility regimes. Rows are symbol-agnostic by construction so
// the whole universe can be pooled into one model, which is where the sample
// size for a heavier architecture would have to come from.
//
// Every number reported here is out-of-sample: training never sees a week that
// closed after the week being predicted.

const { tradingWeeks, replayContinuous, DEFAULT_CONFIG } = require("./weekly-cycle");

const FEATURE_NAMES = Object.freeze([
  "return5Pct", "return21Pct", "return63Pct",
  "smaGap20Pct", "smaSpread2050Pct",
  "atr14Pct", "realisedVol21Pct", "volRatio2163",
  "zScore20", "rsi14", "rangeLocation20",
  "drawdown63Pct", "volumeRatio520", "closeLocation", "bodyRatio",
  "gapFromWeekOpenPct"
]);

function round(value, digits = 4) {
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

// Deterministic generator: the same history must always produce the same model,
// otherwise a rerun silently reshuffles every recommendation.
function seededRandom(seed) {
  let state = (Number(seed) || 1) % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = state * 16807 % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function sma(bars, end, period, field = "close") {
  if (end + 1 < period) return null;
  return mean(bars.slice(end - period + 1, end + 1).map((bar) => Number(bar[field])));
}

function rsi(bars, end, period = 14) {
  if (end < period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = end - period + 1; index <= end; index += 1) {
    const change = Number(bars[index].close) - Number(bars[index - 1].close);
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(bars, end, period = 14) {
  if (end < period) return null;
  const ranges = [];
  for (let index = end - period + 1; index <= end; index += 1) {
    const previousClose = Number(bars[index - 1].close);
    ranges.push(Math.max(
      Number(bars[index].high) - Number(bars[index].low),
      Math.abs(Number(bars[index].high) - previousClose),
      Math.abs(Number(bars[index].low) - previousClose)
    ));
  }
  return mean(ranges);
}

function dailyReturns(bars, end, period) {
  const values = [];
  for (let index = Math.max(1, end - period + 1); index <= end; index += 1) {
    const previous = Number(bars[index - 1].close);
    if (previous > 0) values.push(Number(bars[index].close) / previous - 1);
  }
  return values;
}

// Features are read strictly at `end`, the decision session. Anything later in
// the series is the answer, not an input.
function features(bars, end) {
  if (!Array.isArray(bars) || end < 70 || end >= bars.length) return null;
  const bar = bars[end];
  const close = Number(bar.close);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const open = Number.isFinite(Number(bar.open)) ? Number(bar.open) : close;
  if (!(close > 0)) return null;

  const sma20 = sma(bars, end, 20);
  const sma50 = sma(bars, end, 50);
  const atr14 = atr(bars, end, 14);
  const window20 = bars.slice(end - 19, end + 1);
  const high20 = Math.max(...window20.map((item) => Number(item.high)));
  const low20 = Math.min(...window20.map((item) => Number(item.low)));
  const closes20 = window20.map((item) => Number(item.close));
  const sigma20 = deviation(closes20);
  const returns21 = dailyReturns(bars, end, 21);
  const returns63 = dailyReturns(bars, end, 63);
  const volume5 = mean(bars.slice(end - 4, end + 1).map((item) => Number(item.volume) || 0));
  const volume20 = mean(window20.map((item) => Number(item.volume) || 0));
  const peak63 = Math.max(...bars.slice(Math.max(0, end - 62), end + 1).map((item) => Number(item.close)));
  const barRange = Math.max(high - low, close * 0.0001);
  const closeFive = Number(bars[end - 5]?.close);
  const close21 = Number(bars[end - 21]?.close);
  const close63 = Number(bars[end - 63]?.close);

  const row = {
    return5Pct: closeFive > 0 ? (close / closeFive - 1) * 100 : 0,
    return21Pct: close21 > 0 ? (close / close21 - 1) * 100 : 0,
    return63Pct: close63 > 0 ? (close / close63 - 1) * 100 : 0,
    smaGap20Pct: sma20 ? (close / sma20 - 1) * 100 : 0,
    smaSpread2050Pct: sma20 && sma50 ? (sma20 / sma50 - 1) * 100 : 0,
    atr14Pct: atr14 ? atr14 / close * 100 : 0,
    realisedVol21Pct: deviation(returns21) * Math.sqrt(252) * 100,
    volRatio2163: deviation(returns63) ? deviation(returns21) / deviation(returns63) : 1,
    zScore20: sigma20 ? (close - mean(closes20)) / sigma20 : 0,
    rsi14: rsi(bars, end, 14) ?? 50,
    rangeLocation20: high20 > low20 ? (close - low20) / (high20 - low20) : 0.5,
    drawdown63Pct: peak63 > 0 ? (close / peak63 - 1) * 100 : 0,
    volumeRatio520: volume20 ? volume5 / volume20 : 1,
    closeLocation: (close - low) / barRange,
    bodyRatio: Math.abs(close - open) / barRange,
    // Despite the legacy field name, this is the gap of the decision session,
    // known when that bar closes. It is never replaced with next Monday's open.
    gapFromWeekOpenPct: end > 0 && Number(bars[end - 1]?.close) > 0
      ? (open / Number(bars[end - 1].close) - 1) * 100
      : 0
  };
  return FEATURE_NAMES.every((name) => Number.isFinite(row[name])) ? row : null;
}

// One row per tradable week: features known at the previous week's final close,
// label the net percentage the ladder actually returned that week.
function weeklyTrainingRows(bars, side = "long", overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const weeks = tradingWeeks(bars);
  const replay = replayContinuous(weeks, side, config);
  const cohortByWeek = new Map(replay.cohorts.map((cohort) => [cohort.weekKey, cohort]));
  const indexBySession = new Map(bars.map((bar, index) => [
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Number(bar.timestamp) * 1000)),
    index
  ]));
  const rows = [];
  weeks.forEach((week, position) => {
    if (!position) return;
    const previous = weeks[position - 1];
    const decisionSession = previous.sessions.at(-1).session;
    const decisionIndex = indexBySession.get(decisionSession);
    if (!Number.isInteger(decisionIndex)) return;
    const row = features(bars, decisionIndex);
    if (!row) return;
    const cohort = cohortByWeek.get(week.weekKey);
    if (!cohort?.complete) return; // right-censored outcomes are not labels
    rows.push({
      weekKey: week.weekKey,
      decisionSession,
      featureAsOf: decisionSession,
      labelFrom: week.sessions[0].session,
      labelThrough: cohort.trades.length
        ? cohort.trades.map((trade) => trade.exitSession).sort().at(-1)
        : week.sessions.at(-1).session,
      features: row,
      label: Number(cohort.cohortNetPct),
      fills: cohort.trades.length,
      targetHits: cohort.trades.filter((trade) => trade.outcome === "target" || trade.outcome === "target-gap").length,
      strategyVersion: config.strategyVersion
    });
  });
  return rows;
}

function matrixOf(rows) {
  return rows.map((row) => FEATURE_NAMES.map((name) => Number(row.features[name])));
}

function splitCandidates(values, bins) {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  if (sorted.length <= bins) return sorted.slice(0, -1);
  const step = sorted.length / (bins + 1);
  return Array.from({ length: bins }, (_, index) => sorted[Math.floor((index + 1) * step)]);
}

function growTree(matrix, residuals, indices, depth, options) {
  const total = indices.reduce((sum, index) => sum + residuals[index], 0);
  // M-3: Consistent L2 shrinkage on leaf value matching split gain formula
  const leaf = { value: total / (indices.length + (options.lambda || 1)) };
  if (depth >= options.maxDepth || indices.length < options.minSamplesSplit * 2) return leaf;

  let best = null;
  for (let feature = 0; feature < FEATURE_NAMES.length; feature += 1) {
    const values = indices.map((index) => matrix[index][feature]);
    for (const threshold of splitCandidates(values, options.bins)) {
      const left = [];
      const right = [];
      indices.forEach((index) => (matrix[index][feature] <= threshold ? left : right).push(index));
      if (left.length < options.minSamplesSplit || right.length < options.minSamplesSplit) continue;
      const leftSum = left.reduce((sum, index) => sum + residuals[index], 0);
      const rightSum = right.reduce((sum, index) => sum + residuals[index], 0);
      // Squared-error reduction with L2 shrinkage on the leaf denominators.
      const gain = leftSum ** 2 / (left.length + options.lambda) + rightSum ** 2 / (right.length + options.lambda)
        - total ** 2 / (indices.length + options.lambda);
      if (!best || gain > best.gain) best = { gain, feature, threshold, left, right };
    }
  }
  if (!best || best.gain <= options.minGain) return leaf;
  return {
    feature: best.feature,
    threshold: best.threshold,
    left: growTree(matrix, residuals, best.left, depth + 1, options),
    right: growTree(matrix, residuals, best.right, depth + 1, options)
  };
}

function treeValue(tree, row) {
  let node = tree;
  while (node.feature !== undefined) node = row[node.feature] <= node.threshold ? node.left : node.right;
  return node.value;
}

function trainBoostedTrees(rows, overrides = {}) {
  const options = {
    trees: 120, learningRate: 0.06, maxDepth: 3, minSamplesSplit: 12,
    bins: 16, lambda: 1, subsample: 0.8, seed: 20260813, minGain: 1e-9,
    ...overrides
  };
  if (rows.length < 40) return { ready: false, rows: rows.length, reason: "Need at least 40 labelled weeks to fit the model" };
  const matrix = matrixOf(rows);
  const labels = rows.map((row) => row.label);
  const base = mean(labels);
  const predictions = labels.map(() => base);
  const random = seededRandom(options.seed);
  const trees = [];
  const importance = FEATURE_NAMES.map(() => 0);

  for (let round_ = 0; round_ < options.trees; round_ += 1) {
    const residuals = labels.map((label, index) => label - predictions[index]);
    const sampled = matrix.map((_, index) => index).filter(() => random() < options.subsample);
    if (sampled.length < options.minSamplesSplit * 2) continue;
    const tree = growTree(matrix, residuals, sampled, 0, options);
    if (tree.feature === undefined && Math.abs(tree.value) < 1e-12) continue;
    trees.push(tree);
    matrix.forEach((row, index) => { predictions[index] += options.learningRate * treeValue(tree, row); });
    const walk = (node) => {
      if (node.feature === undefined) return;
      importance[node.feature] += 1;
      walk(node.left);
      walk(node.right);
    };
    walk(tree);
  }

  const model = { ready: true, base: round(base, 6), learningRate: options.learningRate, trees, featureNames: [...FEATURE_NAMES] };
  const splits = importance.reduce((sum, value) => sum + value, 0);
  model.importance = FEATURE_NAMES
    .map((name, index) => ({ feature: name, sharePct: splits ? round(importance[index] / splits * 100, 2) : 0 }))
    .sort((left, right) => right.sharePct - left.sharePct);
  return model;
}

function predict(model, featureRow) {
  if (!model?.ready) return null;
  const vector = FEATURE_NAMES.map((name) => Number(featureRow[name]));
  if (!vector.every(Number.isFinite)) return null;
  return round(model.trees.reduce((sum, tree) => sum + model.learningRate * treeValue(tree, vector), model.base), 4);
}

function correlation(left, right) {
  if (left.length < 3) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const covariance = mean(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
  const spread = deviation(left) * deviation(right) * ((left.length - 1) / left.length);
  return spread ? round(covariance / spread, 4) : null;
}

function scoreFold(model, rows) {
  const predicted = rows.map((row) => predict(model, row.features));
  const actual = rows.map((row) => row.label);
  const usable = predicted.map((value, index) => ({ value, actual: actual[index] })).filter((item) => item.value !== null);
  if (!usable.length) return null;
  const errors = usable.map((item) => Math.abs(item.value - item.actual));
  const actualMean = mean(usable.map((item) => item.actual));
  const totalSumSquares = usable.reduce((sum, item) => sum + (item.actual - actualMean) ** 2, 0);
  const residualSumSquares = usable.reduce((sum, item) => sum + (item.actual - item.value) ** 2, 0);
  const positives = usable.filter((item) => item.value > 0);
  return {
    weeks: usable.length,
    meanAbsoluteErrorPct: round(mean(errors), 3),
    rSquared: totalSumSquares ? round(1 - residualSumSquares / totalSumSquares, 4) : null,
    informationCoefficient: correlation(usable.map((item) => item.value), usable.map((item) => item.actual)),
    // What the desk actually cares about: when the model says take the week, is
    // the realised week positive, and by how much on average.
    actedWeeks: positives.length,
    actedWinRatePct: positives.length ? round(positives.filter((item) => item.actual > 0).length / positives.length * 100, 2) : null,
    actedAverageWeeklyPct: positives.length ? round(mean(positives.map((item) => item.actual)), 3) : null,
    allWeeksAverageWeeklyPct: round(actualMean, 3)
  };
}

function nonOverlappingRows(rows, minimumStride = 1) {
  const spaced = minimumStride > 1 ? rows.filter((_, index) => index % minimumStride === 0) : rows;
  const selected = [];
  let lastLabelThrough = null;
  for (const row of spaced) {
    if (lastLabelThrough && String(row.labelFrom) <= lastLabelThrough) continue;
    selected.push(row);
    lastLabelThrough = String(row.labelThrough || row.labelFrom);
  }
  return selected;
}

// Expanding-window walk-forward: fit on everything up to a cut, score the block
// that follows, roll the cut forward. No fold ever trains on its own future.
//
// `embargo` drops that many rows immediately before each cut. It matters whenever
// labels overlap: with a five-session forward return sampled daily, neighbouring
// rows share four fifths of their label, so a training row just before the cut
// already contains the first days of the test block. Without the embargo a purely
// random series scored as though the model had skill.
function walkForward(rows, overrides = {}) {
  const minimumTrain = Number(overrides.minimumTrain) || 80;
  const folds = Math.max(2, Number(overrides.folds) || 4);
  const dependentHorizonWeeks = Math.max(1, Math.ceil(Number(overrides.maxHoldingSessions || DEFAULT_CONFIG.maxHoldingSessions) / 5));
  const embargo = Math.max(0, overrides.embargo === undefined ? dependentHorizonWeeks : Number(overrides.embargo) || 0);
  // Overlapping labels also inflate the score itself, not just the split. With a
  // five-session forward return sampled daily, neighbouring test rows share four
  // fifths of their label and their errors are serially correlated, which lifted a
  // random walk's information coefficient to 0.14 while a shuffled-label control
  // over the same pipeline sat at -0.02. Scoring every stride-th test row instead
  // removes the overlap from the measurement.
  const scoreStride = Math.max(1, overrides.scoreStride === undefined ? dependentHorizonWeeks : Number(overrides.scoreStride) || 1);
  if (rows.length < minimumTrain + folds * 8) {
    return { ready: false, rows: rows.length, reason: `Need at least ${minimumTrain + folds * 8} labelled weeks for ${folds} walk-forward folds` };
  }
  const blockSize = Math.floor((rows.length - minimumTrain) / folds);
  const results = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const trainTo = minimumTrain + fold * blockSize;
    const testRows = rows.slice(trainTo, fold === folds - 1 ? rows.length : trainTo + blockSize);
    if (!testRows.length) continue;
    const testStart = String(testRows[0].labelFrom || testRows[0].weekKey);
    const trainCandidates = rows.slice(0, Math.max(1, trainTo - embargo));
    // Purging by the observed label boundary is stronger than assuming that a
    // fixed number of calendar rows always covers a 20-session holding period.
    const trainRows = trainCandidates.filter((row) => String(row.labelThrough || row.weekKey) < testStart);
    const model = trainBoostedTrees(trainRows, overrides);
    if (!model.ready) continue;
    const scored = nonOverlappingRows(testRows, scoreStride);
    const score = scoreFold(model, scored);
    if (score) results.push({
      fold: fold + 1,
      trainWeeks: trainRows.length,
      trainThrough: trainRows.at(-1)?.weekKey || null,
      trainLabelThrough: trainRows.map((row) => row.labelThrough).filter(Boolean).sort().at(-1) || null,
      embargoed: trainTo - trainRows.length,
      from: testRows[0].weekKey,
      testLabelFrom: testStart,
      to: testRows.at(-1).weekKey,
      ...score
    });
  }
  if (!results.length) return { ready: false, rows: rows.length, reason: "No walk-forward fold produced a usable model" };
  const acted = results.flatMap((item) => Array(item.actedWeeks).fill(item.actedAverageWeeklyPct)).filter(Number.isFinite);
  const scoredWeeks = results.reduce((sum, item) => sum + item.weeks, 0);
  return {
    ready: true,
    method: `expanding-window walk-forward${embargo ? ` with a ${embargo}-row embargo before each cut` : ""}${scoreStride > 1 ? `, scored on every ${scoreStride}th row so labels do not overlap` : ""}; features at the prior close, label the following period`,
    // The standard error of a correlation over n independent observations. A
    // coefficient inside two of these is indistinguishable from luck.
    informationCoefficientStandardError: scoredWeeks > 3 ? round(1 / Math.sqrt(scoredWeeks - 3), 4) : null,
    folds: results.length,
    rows: rows.length,
    outOfSample: {
      weeks: results.reduce((sum, item) => sum + item.weeks, 0),
      actedWeeks: results.reduce((sum, item) => sum + item.actedWeeks, 0),
      informationCoefficient: round(mean(results.map((item) => Number(item.informationCoefficient)).filter(Number.isFinite)), 4),
      // Was computed per fold and then dropped, so every caller read undefined.
      // It is the more robust of the two skill measures when labels have little
      // spread, where a correlation is unstable but the error is still meaningful.
      rSquared: round(mean(results.map((item) => Number(item.rSquared)).filter(Number.isFinite)), 4),
      meanAbsoluteErrorPct: round(mean(results.map((item) => Number(item.meanAbsoluteErrorPct))), 3),
      actedAverageWeeklyPct: round(mean(acted), 3),
      actedWinRatePct: round(mean(results.map((item) => Number(item.actedWinRatePct)).filter(Number.isFinite)), 2),
      allWeeksAverageWeeklyPct: round(mean(results.map((item) => Number(item.allWeeksAverageWeeklyPct))), 3)
    },
    perFold: results
  };
}

// The full pipeline for one symbol: label its weeks, validate out of sample,
// refit on everything and score the week about to be traded.
function weeklyForecast(bars, side = "long", overrides = {}) {
  const rows = weeklyTrainingRows(bars, side, overrides);
  const validation = walkForward(rows, overrides);
  const model = trainBoostedTrees(rows, overrides);
  const latestIndex = bars.length - 1;
  const latest = features(bars, latestIndex);
  const expectedWeeklyPct = latest && model.ready ? predict(model, latest) : null;
  const edge = validation.ready ? Number(validation.outOfSample.informationCoefficient) : null;
  const rSquared = validation.ready ? Number(validation.outOfSample.rSquared) : null;
  const unstableFold = validation.ready && validation.perFold.some((fold) =>
    !(Number(fold.informationCoefficient) >= 0) || !(Number(fold.rSquared) >= 0)
  );
  return {
    ready: Boolean(model.ready && validation.ready),
    side,
    rows: rows.length,
    expectedWeeklyPct,
    // A model whose out-of-sample information coefficient is not positive is
    // reported, but must not be allowed to justify a trade.
    trustworthy: Boolean(
      validation.ready
      && edge >= 0.05
      && rSquared > 0
      && !unstableFold
      && Number(validation.outOfSample.actedAverageWeeklyPct) > 0
    ),
    validation,
    importance: model.ready ? model.importance.slice(0, 8) : [],
    featureAsOf: bars[latestIndex]?.timestamp
      ? new Date(Number(bars[latestIndex].timestamp) * 1000).toISOString()
      : null,
    timingContract: "Every feature is derived at or before featureAsOf; no next-session opening value is used",
    reason: model.ready ? null : model.reason
  };
}

/**
 * Institutional Model Fitness & Abstention Evaluator.
 * If IC < 0.05, R^2 <= 0, or any fold has negative IC, the model is strictly
 * demoted to RESEARCH_ADVISORY_ONLY and cannot generate standalone trades.
 */
function evaluateModelFitness(model) {
  if (!model) {
    return {
      status: "NO_MODEL",
      canGenerateTrades: false,
      isAdvisoryOnly: true,
      reason: "No model provided"
    };
  }

  const target = model.validation?.outOfSample || model.validation || model.outOfSample || model;
  const ic = Number(target?.informationCoefficient ?? model.informationCoefficient ?? 0);
  const r2 = Number(target?.rSquared ?? model.rSquared ?? 0);
  const folds = Array.isArray(model.perFold || model.validation?.perFold || target?.perFold)
    ? (model.perFold || model.validation?.perFold || target?.perFold)
    : [];
  const anyNegativeFold = folds.some((f) => ![f.informationCoefficient, f.rSquared].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0));
  const timingVerified = folds.length >= 2 && folds.every((fold) => /^\d{4}-\d{2}-\d{2}$/.test(fold.trainLabelThrough || "")
    && /^\d{4}-\d{2}-\d{2}$/.test(fold.testLabelFrom || "") && fold.trainLabelThrough < fold.testLabelFrom);

  const passesThresholds = model.ready === true && model.validation?.ready === true && timingVerified
    && Number.isFinite(ic) && Number.isFinite(r2) && ic >= 0.05 && r2 > 0 && !anyNegativeFold
    && Number(target.actedAverageWeeklyPct) > 0;

  if (!passesThresholds) {
    return {
      status: "RESEARCH_ADVISORY_ONLY",
      canGenerateTrades: false,
      isAdvisoryOnly: true,
      metrics: {
        informationCoefficient: ic,
        rSquared: r2,
        unstableFolds: anyNegativeFold
      },
      reason: `Model has weak out-of-sample skill (IC: ${ic}, R^2: ${r2}). Demoted to secondary advisory ranking filter; standalone trade generation forbidden.`
    };
  }

  return {
    status: "VALIDATED_RESEARCH_FILTER",
    canGenerateTrades: true,
    isAdvisoryOnly: false,
    metrics: {
      informationCoefficient: ic,
      rSquared: r2,
      unstableFolds: false
    },
    reason: "Model passed these research fitness and chronology checks; this is not live approval or profitability validation."
  };
}

module.exports = {
  FEATURE_NAMES,
  evaluateModelFitness,
  features,
  predict,
  seededRandom,
  trainBoostedTrees,
  walkForward,
  weeklyForecast,
  weeklyTrainingRows
};

