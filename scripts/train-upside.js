"use strict";

// Trains one forward-move model across the whole tradable universe.
//
// Why pooled rather than per name: a five-session horizon over five years leaves
// about 250 non-overlapping observations for a single stock, and the standard
// error on a correlation that size is ±0.11. Nothing short of an information
// coefficient of 0.22 could be told from luck, so a per-name model can neither be
// trusted nor honestly rejected — a deliberately predictable series failed the
// same gate that a random walk failed. Pooling 214 names gives order 50,000
// observations, where a real coefficient of 0.05 is measurable.
//
// The split is by calendar date, not by row: every name contributes to training
// or to testing for a given period, never both, or one stock's future leaks
// through its neighbour's past.
//
//   node scripts/train-upside.js --limit 60 --out models/upside.json

const fs = require("node:fs");
const path = require("node:path");
const { dailyBars } = require("./weekly-plan");
const { forwardRows } = require("../api/_lib/upside");
const { predict, trainBoostedTrees } = require("../api/_lib/ml-model");
const { latestBhavcopy, frontFutures } = require("../api/_lib/bhavcopy");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function correlation(left, right) {
  if (left.length < 4) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const covariance = mean(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
  const spread = deviation(left) * deviation(right) * ((left.length - 1) / left.length);
  return spread ? covariance / spread : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function gather(symbols, horizon) {
  const rows = [];
  for (const [index, symbol] of symbols.entries()) {
    try {
      const bars = await dailyBars(symbol);
      // Only every horizon-th session, so no two rows share a label.
      forwardRows(bars, horizon).forEach((row, position) => {
        if (position % horizon !== 0) return;
        rows.push({ ...row, symbol, date: row.weekKey });
      });
      if ((index + 1) % 20 === 0) console.log(`  gathered ${index + 1}/${symbols.length} names, ${rows.length} rows`);
    } catch (error) {
      console.warn(`  ${symbol}: skipped (${String(error?.message || error).slice(0, 60)})`);
    }
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

function evaluate(rows, horizon, options) {
  // Chronological folds by date. Every name is on the same side of a cut.
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const folds = 4;
  const firstTest = Math.floor(dates.length * 0.5);
  const blockSize = Math.max(1, Math.floor((dates.length - firstTest) / folds));
  const results = [];

  for (let fold = 0; fold < folds; fold += 1) {
    const trainUntil = dates[firstTest + fold * blockSize - 1];
    const testFrom = dates[firstTest + fold * blockSize];
    const testUntil = fold === folds - 1 ? dates.at(-1) : dates[Math.min(dates.length - 1, firstTest + (fold + 1) * blockSize - 1)];
    if (!trainUntil || !testFrom) continue;
    const trainRows = rows.filter((row) => row.date <= trainUntil);
    const testRows = rows.filter((row) => row.date >= testFrom && row.date <= testUntil);
    if (trainRows.length < 500 || testRows.length < 100) continue;

    const model = trainBoostedTrees(trainRows, options);
    if (!model.ready) continue;
    const predicted = testRows.map((row) => predict(model, row.features));
    const usable = predicted.map((value, index) => ({ value, actual: testRows[index].label }))
      .filter((item) => Number.isFinite(item.value));
    if (usable.length < 50) continue;

    const actualMean = mean(usable.map((item) => item.actual));
    const totalSumSquares = usable.reduce((sum, item) => sum + (item.actual - actualMean) ** 2, 0);
    const residual = usable.reduce((sum, item) => sum + (item.actual - item.value) ** 2, 0);
    // The decile the model likes most, which is what a buy list actually uses.
    const ranked = [...usable].sort((left, right) => right.value - left.value);
    const top = ranked.slice(0, Math.max(10, Math.floor(ranked.length / 10)));
    // Expected value is the wrong question for a floor. "Can this clear 2%" is a
    // probability: a name whose average move is 0.8% still clears 2% whenever the
    // week runs hot, and how often that happens is measurable rather than assumed.
    const floorPct = Number(options.floorPct) || 2;
    const decileSize = Math.max(1, Math.floor(ranked.length / 10));
    const deciles = Array.from({ length: 10 }, (_, index) => {
      const slice = ranked.slice(index * decileSize, (index + 1) * decileSize);
      if (!slice.length) return null;
      return {
        decile: index + 1,
        predictedFrom: round(slice.at(-1).value, 3),
        predictedTo: round(slice[0].value, 3),
        averagePct: round(mean(slice.map((item) => item.actual)), 3),
        clearedFloorPct: round(slice.filter((item) => item.actual >= floorPct).length / slice.length * 100, 1),
        cases: slice.length
      };
    }).filter(Boolean);
    const baseClearedPct = round(usable.filter((item) => item.actual >= floorPct).length / usable.length * 100, 1);
    results.push({
      fold: fold + 1,
      trainRows: trainRows.length,
      testRows: usable.length,
      from: testFrom,
      to: testUntil,
      informationCoefficient: round(correlation(usable.map((item) => item.value), usable.map((item) => item.actual))),
      rSquared: totalSumSquares ? round(1 - residual / totalSumSquares) : null,
      allAveragePct: round(actualMean, 3),
      topDecileAveragePct: round(mean(top.map((item) => item.actual)), 3),
      topDecileWinPct: round(top.filter((item) => item.actual > 0).length / top.length * 100, 1),
      floorPct,
      baseClearedFloorPct: baseClearedPct,
      topDecileClearedFloorPct: round(top.filter((item) => item.actual >= floorPct).length / top.length * 100, 1),
      deciles
    });
  }
  if (!results.length) return { ready: false, reason: "no fold had enough rows" };

  const ics = results.map((item) => Number(item.informationCoefficient)).filter(Number.isFinite);
  const scored = results.reduce((sum, item) => sum + item.testRows, 0);
  return {
    ready: true,
    folds: results.length,
    scoredRows: scored,
    informationCoefficient: round(mean(ics)),
    informationCoefficientStandardError: scored > 3 ? round(1 / Math.sqrt(scored - 3)) : null,
    rSquared: round(mean(results.map((item) => Number(item.rSquared)).filter(Number.isFinite))),
    topDecileAveragePct: round(mean(results.map((item) => Number(item.topDecileAveragePct))), 3),
    allAveragePct: round(mean(results.map((item) => Number(item.allAveragePct))), 3),
    topDecileWinPct: round(mean(results.map((item) => Number(item.topDecileWinPct))), 1),
    floorPct: results[0].floorPct,
    baseClearedFloorPct: round(mean(results.map((item) => Number(item.baseClearedFloorPct))), 1),
    topDecileClearedFloorPct: round(mean(results.map((item) => Number(item.topDecileClearedFloorPct))), 1),
    // Averaged across folds so the portal can turn a prediction into "how often a
    // score like this has cleared the floor" rather than a bare expectation.
    deciles: Array.from({ length: 10 }, (_, index) => {
      const matching = results.map((item) => item.deciles[index]).filter(Boolean);
      if (!matching.length) return null;
      return {
        decile: index + 1,
        predictedFrom: round(mean(matching.map((item) => item.predictedFrom)), 3),
        predictedTo: round(mean(matching.map((item) => item.predictedTo)), 3),
        averagePct: round(mean(matching.map((item) => item.averagePct)), 3),
        clearedFloorPct: round(mean(matching.map((item) => item.clearedFloorPct)), 1),
        cases: matching.reduce((sum, item) => sum + item.cases, 0)
      };
    }).filter(Boolean),
    perFold: results
  };
}

async function run() {
  const horizon = Number(argument("horizon", "5"));
  const limit = Number(argument("limit", "0"));
  const book = await latestBhavcopy();
  const all = [...frontFutures(book.rows).keys()].sort();
  const symbols = limit > 0 ? all.slice(0, limit) : all;
  console.log(`Pooling ${symbols.length} names, ${horizon}-session horizon, non-overlapping rows.\n`);

  // Gathering 200 names takes about ten minutes of fetching. Caching it means an
  // interrupted evaluation costs seconds to retry rather than starting over.
  const cache = argument("cache");
  let rows = null;
  if (cache && fs.existsSync(cache)) {
    const held = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (held.horizon === horizon && Array.isArray(held.rows) && held.rows.length) {
      rows = held.rows;
      console.log(`Reusing ${rows.length} cached rows from ${cache}.`);
    }
  }
  if (!rows) {
    rows = await gather(symbols, horizon);
    if (cache) {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify({ horizon, gatheredAt: new Date().toISOString(), rows }));
      console.log(`Cached ${rows.length} rows to ${cache}.`);
    }
  }
  const names = new Set(rows.map((row) => row.symbol)).size;
  console.log(`\n${rows.length} rows from ${names} names, ${new Set(rows.map((row) => row.date)).size} distinct dates.\n`);
  if (rows.length < 2000) throw new Error(`Only ${rows.length} rows; pooling needs thousands to beat the per-name noise floor`);

  const options = { trees: 200, learningRate: 0.05, maxDepth: 4, minSamplesSplit: 40, subsample: 0.7 };
  const validation = evaluate(rows, horizon, options);
  if (!validation.ready) throw new Error(validation.reason);

  const bar = 2 * Number(validation.informationCoefficientStandardError);
  console.log(`Out of sample across ${validation.scoredRows} rows in ${validation.folds} folds:`);
  console.log(`  information coefficient ${validation.informationCoefficient} against a standard error of ${validation.informationCoefficientStandardError} (needs ${round(bar)})`);
  console.log(`  explained variance ${validation.rSquared}`);
  console.log(`  the model's favourite tenth returned ${validation.topDecileAveragePct}% per ${horizon} sessions against ${validation.allAveragePct}% for everything`);
  console.log(`  and was positive ${validation.topDecileWinPct}% of the time`);
  console.log(`
  clearing the ${validation.floorPct}% floor: the favourite tenth managed it ${validation.topDecileClearedFloorPct}% of the time against ${validation.baseClearedFloorPct}% across everything`);
  console.log("  by decile, most-liked first:");
  [...validation.deciles].reverse().forEach((entry) => {
    console.log(`    ${String(entry.decile).padStart(2)}  score ${String(entry.predictedFrom).padStart(7)} to ${String(entry.predictedTo).padStart(7)}  average ${String(entry.averagePct).padStart(7)}%  cleared ${String(entry.clearedFloorPct).padStart(5)}%  (${entry.cases} cases)`);
  });
  const skilled = Number(validation.informationCoefficient) > bar;
  console.log(`\n  verdict: ${skilled ? "the pooled model has measurable skill" : "no measurable skill — the potential route must stay closed"}`);

  const model = trainBoostedTrees(rows, options);
  const out = argument("out", "models/upside.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    trainedAt: new Date().toISOString(),
    tradeDate: book.tradeDate,
    horizon,
    names,
    rows: rows.length,
    skilled,
    validation,
    importance: model.importance,
    model: { base: model.base, learningRate: model.learningRate, featureNames: model.featureNames, trees: model.trees }
  }));
  console.log(`\nWritten to ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Pooled training failed: ${String(error?.message || error).slice(0, 250)}`);
    process.exitCode = 1;
  });
}

module.exports = { evaluate, gather };
