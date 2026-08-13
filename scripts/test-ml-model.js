"use strict";

const assert = require("node:assert/strict");
const {
  FEATURE_NAMES, features, predict, seededRandom, trainBoostedTrees, walkForward, weeklyForecast, weeklyTrainingRows
} = require("../api/_lib/ml-model");

function bar(date, open, high, low, close, volume = 1_000_000) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume };
}

// A deterministic series with a hidden rule: after a deep 63-session drawdown
// the following week reverts, otherwise it bleeds. A model that cannot recover a
// rule this clean is broken, and one that "recovers" it from noise is leaking.
function series(weekCount, options = {}) {
  const bars = [];
  const start = Date.parse("2019-01-07T06:30:00Z");
  let price = 100;
  for (let week = 0; week < weekCount; week += 1) {
    const stressed = options.random ? false : week % 3 === 0;
    for (let day = 0; day < 5; day += 1) {
      const date = new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10);
      const drift = options.random
        ? (seededDrift(week * 5 + day) - 0.5) * 0.02
        : stressed ? (day < 2 ? -0.012 : 0.011) : -0.001;
      const open = price;
      const close = price * (1 + drift);
      bars.push(bar(date, open, Math.max(open, close) * 1.003, Math.min(open, close) * 0.997, close));
      price = close;
    }
  }
  return bars;
}

const seededDrift = (() => {
  const random = seededRandom(7);
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, random());
    return cache.get(key);
  };
})();

const structured = series(220);
assert.ok(structured.length > 1_000);

const featureRow = features(structured, 200);
assert.ok(featureRow, "features are available once enough history exists");
assert.deepEqual(Object.keys(featureRow).sort(), [...FEATURE_NAMES].sort());
assert.equal(features(structured, 10), null, "a short lookback yields no feature row");
assert.equal(features(structured, structured.length + 5), null);
assert.ok(featureRow.rsi14 >= 0 && featureRow.rsi14 <= 100);
assert.ok(featureRow.rangeLocation20 >= 0 && featureRow.rangeLocation20 <= 1);

const rows = weeklyTrainingRows(structured, "long");
assert.ok(rows.length > 150, `expected a row per tradable week, received ${rows.length}`);
assert.ok(rows.every((row) => typeof row.weekKey === "string" && Number.isFinite(row.label)));

// The decision session must always precede the labelled week, or the model is
// reading its own answer.
assert.ok(rows.every((row) => row.decisionSession < row.weekKey), "features must be dated before the week they predict");

const model = trainBoostedTrees(rows);
assert.equal(model.ready, true);
assert.ok(model.trees.length > 0);
assert.ok(model.importance[0].sharePct > 0);
assert.equal(trainBoostedTrees(rows.slice(0, 20)).ready, false, "a tiny sample must refuse to fit");

const first = predict(model, rows.at(-1).features);
const second = predict(model, rows.at(-1).features);
assert.equal(first, second, "prediction is deterministic");
assert.ok(Number.isFinite(first));
assert.equal(predict(model, { ...rows.at(-1).features, rsi14: NaN }), null, "an incomplete feature row scores nothing");
assert.equal(predict({ ready: false }, rows.at(-1).features), null);

const validation = walkForward(rows, { folds: 4 });
assert.equal(validation.ready, true, validation.reason || "walk-forward should run on this history");
assert.ok(validation.folds >= 2);
validation.perFold.forEach((fold, index) => {
  assert.equal(fold.from, rows[fold.trainWeeks].weekKey, "a fold's test block must start exactly where its training data stopped");
  assert.ok(fold.from > rows[fold.trainWeeks - 1].weekKey, "no fold may test a week it trained on");
  if (index) assert.ok(fold.from > validation.perFold[index - 1].to, "folds must roll forward in time");
});
assert.ok(validation.outOfSample.weeks > 0);
assert.ok(Number(validation.outOfSample.informationCoefficient) > 0, `a learnable rule should give a positive out-of-sample IC, received ${validation.outOfSample.informationCoefficient}`);

const forecast = weeklyForecast(structured, "long");
assert.equal(forecast.ready, true);
assert.ok(Number.isFinite(forecast.expectedWeeklyPct));
assert.equal(forecast.trustworthy, true, "the structured series should clear the trust gate");
assert.ok(forecast.importance.length > 0);

// Noise must not be dressed up as an edge.
const noise = weeklyForecast(series(220, { random: true }), "long");
assert.equal(noise.ready, true, "the pipeline still runs on unlearnable data");
assert.equal(noise.trustworthy, false, "an unlearnable series must never be marked trustworthy");

assert.equal(walkForward(rows.slice(0, 30)).ready, false, "too few weeks cannot be validated");

console.log("ML model tests passed: leak-free labelling, deterministic boosting, walk-forward validation and a trust gate that rejects noise");
