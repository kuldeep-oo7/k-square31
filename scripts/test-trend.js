"use strict";

const assert = require("node:assert/strict");
const { annualisedVolatilityPct, timeSeriesMomentum, trendAlignment, trendGate } = require("../api/_lib/trend");

function series(count, step) {
  const bars = [];
  let price = 100;
  for (let index = 0; index < count; index += 1) {
    const close = price * (1 + step(index));
    bars.push({ timestamp: 1_700_000_000 + index * 86_400, open: price, high: Math.max(price, close), low: Math.min(price, close), close, volume: 1_000_000 });
    price = close;
  }
  return bars;
}

const rising = series(400, (index) => (index % 5 === 0 ? -0.002 : 0.0035));
const falling = series(400, (index) => (index % 5 === 0 ? 0.002 : -0.0035));
const flat = series(400, (index) => (index % 2 === 0 ? 0.0015 : -0.0015));

const up = timeSeriesMomentum(rising);
assert.equal(up.ready, true);
assert.equal(up.direction, 1);
assert.ok(up.returnPct > 0);
assert.ok(up.annualisedVolatilityPct > 0);
assert.equal(up.sessions, 252, "the default lookback is twelve months");

const down = timeSeriesMomentum(falling);
assert.equal(down.direction, -1);
assert.ok(down.returnPct < 0);
assert.ok(Number(down.scaled) < 0);

assert.equal(timeSeriesMomentum(rising.slice(0, 20)).ready, false, "a short history cannot report a trend");
assert.equal(timeSeriesMomentum([]).ready, false);
assert.equal(annualisedVolatilityPct([100]), null);

// The gate blocks the two combinations that lean against an established trend
// and lets the aligned ones through.
assert.equal(trendGate(falling, "long").blocked, true, "a buy ladder is refused in a 12-month downtrend");
assert.match(trendGate(falling, "long").veto, /12-month trend runs against/);
assert.equal(trendGate(falling, "short").blocked, false, "a sell ladder is allowed in a downtrend");
assert.equal(trendGate(rising, "short").blocked, true, "a sell ladder is refused in a 12-month uptrend");
assert.equal(trendGate(rising, "long").blocked, false);
assert.equal(trendGate(rising, "long").veto, null);

// A flat tape must not block anything: the gate exists to refuse trades against
// real trends, not to demand one.
const flatGate = trendGate(flat, "long");
assert.equal(flatGate.blocked, false, "a directionless market blocks neither side");
assert.equal(trendGate(flat, "short").blocked, false);

// Volatility scaling: the same percentage move in a wilder instrument is weaker
// evidence of trend, so it must score lower per unit of risk.
const calmUp = series(400, (index) => (index % 2 === 0 ? 0.0014 : 0.001));
const wildUp = series(400, (index) => (index % 2 === 0 ? 0.03 : -0.0276));
const calm = timeSeriesMomentum(calmUp);
const wild = timeSeriesMomentum(wildUp);
assert.ok(calm.annualisedVolatilityPct < wild.annualisedVolatilityPct);
assert.ok(Number(calm.scaled) > Number(wild.scaled), "risk-scaling must not reward a trend that is merely noisy");

// A series with no variation at all has no measurable risk, so there is nothing
// to scale by. The gate must fall open rather than block on a null.
const constant = timeSeriesMomentum(series(400, () => 0.0012));
assert.equal(constant.annualisedVolatilityPct, 0);
assert.equal(constant.scaled, null, "zero dispersion yields no risk-scaled trend");
assert.equal(trendGate(series(400, () => -0.0012), "long").blocked, false, "an unmeasurable risk profile must not veto a trade");
assert.equal(trendAlignment(constant, "long"), 0, "an unscalable trend contributes nothing to conviction");

// A tolerance of zero blocks any adverse trend; a large tolerance blocks none.
assert.equal(trendGate(falling, "long", { tolerance: 99 }).blocked, false);
assert.equal(trendGate(flat, "long", { tolerance: -99 }).blocked, true);

assert.equal(trendAlignment(up, "long") > trendAlignment(down, "long"), true);
assert.equal(trendAlignment(down, "short") > trendAlignment(up, "short"), true);
assert.ok(trendAlignment(up, "long") <= 1 && trendAlignment(up, "long") >= 0);
assert.equal(trendAlignment({ ready: false }, "long"), 0);
assert.equal(trendAlignment(null, "long"), 0);

// A shorter lookback is supported for books that trade on a faster clock.
const fast = timeSeriesMomentum(rising, { sessions: 60 });
assert.equal(fast.sessions, 60);
assert.equal(fast.ready, true);

console.log("Trend tests passed: 12-month time-series momentum, risk scaling, direction gating in both directions and a neutral flat tape");
