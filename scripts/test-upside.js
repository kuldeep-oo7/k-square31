"use strict";

const assert = require("node:assert/strict");
const { forwardForecast, forwardRows, loadPooledModel, pooledForecast, upside } = require("../api/_lib/upside");
const { recommendation } = require("../api/_lib/recommendation");

function bar(date, open, high, low, close) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume: 1_000_000 };
}

// A plain Lehmer generator is the wrong tool for an "unlearnable" fixture: its
// next output is a deterministic linear map of the last, so the model recovered it
// through the price path and scored 0.25. This mixes the counter instead.
function mixedRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

function series(sessions, drift) {
  const bars = [];
  let price = 100;
  const start = Date.parse("2020-01-01T06:30:00Z");
  for (let index = 0; index < sessions; index += 1) {
    const close = price * (1 + drift(index, price, bars));
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    bars.push(bar(date, price, Math.max(price, close) * 1.003, Math.min(price, close) * 0.997, close));
    price = close;
  }
  return bars;
}

const climbing = series(900, (index) => (index % 5 === 0 ? -0.004 : 0.0035));
const noisy = (() => {
  const random = mixedRandom(20260817);
  return series(900, () => (random() - 0.5) * 0.03);
})();

// Labels must describe the move that follows the features, and no two rows may
// share one when the score is computed.
const rows = forwardRows(climbing, 5);
assert.ok(rows.length > 700, `expected a row per session, got ${rows.length}`);
assert.ok(rows.every((row) => Number.isFinite(row.label)));
assert.equal(forwardRows(climbing.slice(0, 60), 5).length, 0, "a short history yields no rows");

// The per-name fit still runs for inspection, but is no longer what admits a name.
const single = forwardForecast(climbing, { horizon: 5 });
assert.equal(single.horizon, 5);
assert.ok(Number.isFinite(single.expectedMovePct));
assert.ok(Number.isFinite(single.informationCoefficientStandardError), "the standard error must be reported");
// Five years of daily data at this horizon leaves roughly 250 independent
// observations, so nothing under an information coefficient of about 0.22 is
// separable from luck. Neither fixture may pass.
assert.equal(forwardForecast(noisy, { horizon: 5 }).trustworthy, false, "a random walk must not be trusted");

// Nothing is admitted without a pooled model.
loadPooledModel(null);
const bare = upside({ bars: climbing, side: "long", floorPct: 2, overrides: { pooledModel: null } });
assert.equal(bare.clearsFloor, false);
assert.match(bare.reason, /no pooled model/);

// A pooled model that failed its own validation may not admit anything either.
const unskilled = {
  skilled: false,
  horizon: 5,
  model: { base: 0, learningRate: 0.05, featureNames: [], trees: [{ value: 5 }] },
  validation: { informationCoefficient: 0.021, informationCoefficientStandardError: 0.0126 }
};
const refused = upside({ bars: climbing, side: "long", floorPct: 2, overrides: { pooledModel: unskilled } });
assert.equal(refused.clearsFloor, false);
assert.match(refused.reason, /no measurable skill/);

// A model that cleared its bar does admit a name, once the floor is beaten.
const skilled = {
  skilled: true,
  horizon: 5,
  names: 200,
  rows: 48_000,
  // One leaf, so the carrier is a model rather than a bare constant: the guard
  // refuses a tree-less payload, which is the right call.
  model: { base: 4, learningRate: 0.05, featureNames: [], trees: [{ value: 0 }] },
  validation: { informationCoefficient: 0.05, informationCoefficientStandardError: 0.007, rSquared: 0.01, topDecileAveragePct: 1.1 },
  importance: []
};
const admitted = upside({ bars: climbing, side: "long", floorPct: 2, overrides: { pooledModel: skilled } });
assert.equal(admitted.ready, true);
assert.equal(admitted.trustworthy, true);
assert.ok(admitted.expectedMovePct > 2, `expected the stub's 4% to clear the floor, got ${admitted.expectedMovePct}`);
assert.equal(admitted.clearsFloor, true);
assert.equal(admitted.components.length, 6, "every reading must be accounted for");

// Costs come off, and the floor is respected in both directions.
const gross = admitted.components.reduce((sum, item) => sum + Number(item.expectedPct || 0), 0);
assert.ok(admitted.expectedMovePct < gross, "costs must be subtracted");
assert.equal(upside({ bars: climbing, side: "long", floorPct: 99, overrides: { pooledModel: skilled } }).clearsFloor, false);

// A short is the mirror of the long on the same series.
const shortSide = upside({ bars: climbing, side: "short", floorPct: 2, overrides: { pooledModel: skilled } });
assert.ok(shortSide.expectedMovePct < admitted.expectedMovePct, "a rising series is a worse short than long");

// Carry keeps its sign per side.
const rich = { ready: true, basisPct: 1, weeklyPct: -0.6, state: "premium", favourable: false };
const longCarry = upside({ bars: climbing, side: "long", floorPct: 2, carry: rich, overrides: { pooledModel: skilled } });
const shortCarry = upside({ bars: climbing, side: "short", floorPct: 2, carry: rich, overrides: { pooledModel: skilled } });
assert.ok(Number(longCarry.components.find((item) => item.name === "Carry").expectedPct) < 0);
assert.ok(Number(shortCarry.components.find((item) => item.name === "Carry").expectedPct) > 0);

// End to end. Without a validated pooled model the second route stays shut, so a
// name the ladder rejects is still a stand-aside.
const shut = recommendation({ symbol: "CLIMBER", bars: climbing, model: null, fundamentals: null, technical: null, carry: null, overrides: { pooledModel: null } });
assert.ok(["stand-aside", "buy-ladder"].includes(shut.action));

// With one, the same name can arrive on potential — labelled as such, offering a
// single rung, claiming no history it does not have, and sized more cautiously.
const opened = recommendation({ symbol: "CLIMBER", bars: climbing, model: null, fundamentals: null, technical: null, carry: null, overrides: { pooledModel: skilled } });
if (opened.action === "buy-potential") {
  assert.equal(opened.route, "potential");
  assert.equal(opened.entries.length, 1, "only the first rung is offered without measured reversion");
  assert.equal(opened.entries[0].historicalFills, null, "no historical fills may be claimed");
  assert.equal(opened.entries[0].hitRatePct, null);
  assert.ok(opened.expectedWeeklyPct > 2);
  assert.ok(opened.sizeMultiplier <= 0.75, "a name with no ladder history is sized more cautiously");
  assert.match(opened.evidence.route, /expected move/);
}

// The pooled forecast refuses an empty carrier rather than guessing.
assert.equal(pooledForecast(climbing, { pooledModel: {} }).ready, false);
assert.equal(pooledForecast(climbing, { pooledModel: null }).ready, false);

console.log("Upside tests passed: leak-free labels, per-name fits refused as unvalidatable, pooled model required and gated, potential route separately labelled");
