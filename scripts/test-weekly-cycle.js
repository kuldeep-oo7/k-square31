"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_CONFIG,
  clusterStandardError,
  ladder,
  replayContinuous,
  replayWeek,
  tradingWeeks,
  weeklyCycle,
  weekKeyOf,
  wilsonBounds
} = require("../api/_lib/weekly-cycle");

function bar(date, open, high, low, close) {
  return {
    timestamp: Date.parse(`${date}T06:30:00Z`) / 1000,
    open, high, low, close,
    volume: 1_000_000
  };
}

function weekBars(startDate, rows) {
  const start = Date.parse(`${startDate}T06:30:00Z`);
  return rows.map((values, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return bar(date, ...values);
  });
}

assert.equal(DEFAULT_CONFIG.fridayLiquidation, false);
assert.equal(DEFAULT_CONFIG.fillRequiresTradeThrough, true);
assert.equal(DEFAULT_CONFIG.maxHoldingSessions, 20);
assert.equal(weekKeyOf("2026-01-09"), "2026-01-05");
assert.deepEqual(ladder(100, "long", DEFAULT_CONFIG).map((item) => item.price), [98, 96.04, 94.1192, 92.2368, 90.3921]);
assert.deepEqual(ladder(100, "short", DEFAULT_CONFIG).map((item) => item.price), [102, 104.04, 106.1208, 108.2432, 110.4081]);

// Entry-day highs cannot become post-fill targets: the first eligible target
// is evaluated on a strictly later session.
const targetWeek = tradingWeeks(weekBars("2026-01-05", [
  [100, 100.5, 99.5, 100],
  [100, 100.0, 97.9, 98.2],
  [98.2, 98.5, 98.0, 98.3],
  [98.3, 100.2, 98.3, 100],
  [100, 100.2, 99.8, 100]
]))[0];
const targetReplay = replayWeek(targetWeek, "long", DEFAULT_CONFIG);
assert.equal(targetReplay.trades.length, 1);
assert.equal(targetReplay.trades[0].filledSession, "2026-01-06");
assert.equal(targetReplay.trades[0].exitSession, "2026-01-08");
assert.equal(targetReplay.trades[0].outcome, "target");
assert.equal(targetReplay.weekNetPct, 0.384);

// Friday is only an attribution mark. The same economic position survives,
// rebases its weekly reference on Monday, then exits on Tuesday's target.
const continuousWeeks = tradingWeeks([
  ...weekBars("2026-01-12", [
    [100, 100.2, 99.8, 100], [100, 100, 97.9, 98.3], [98.3, 98.8, 98.1, 98.5],
    [98.5, 98.8, 98.2, 98.5], [98.5, 98.8, 98.2, 98.5]
  ]),
  ...weekBars("2026-01-19", [
    [99, 99.4, 98.8, 99.2], [99.2, 100.1, 98.9, 100], [100, 100.2, 99.8, 100],
    [100, 100.2, 99.8, 100], [100, 100.2, 99.8, 100]
  ])
]);
const oneWeek = replayWeek(continuousWeeks[0], "long", { ...DEFAULT_CONFIG, slots: 1, maxConcurrentPositions: 1 });
assert.equal(oneWeek.trades.length, 0, "Friday must not fabricate a close");
assert.equal(oneWeek.openPositions.length, 1, "unresolved Friday exposure remains censored/open");
const continuous = replayContinuous(continuousWeeks, "long", { ...DEFAULT_CONFIG, slots: 1, maxConcurrentPositions: 1 });
assert.equal(continuous.trades.length, 1);
assert.equal(continuous.trades[0].filledSession, "2026-01-13");
assert.equal(continuous.trades[0].exitSession, "2026-01-20");
assert.equal(continuous.trades[0].outcome, "target");
assert.equal(continuous.rebases.length, 1);
assert.equal(continuous.rebases[0].weekKey, "2026-01-19");

// A touch alone is not assumed filled. Disabling the conservative rule proves
// the fixture actually reaches the order.
const touchWeek = tradingWeeks(weekBars("2026-03-02", [
  [100, 100.5, 99.5, 100], [99.5, 99.6, 98.0, 98.5], [98.5, 99.0, 98.2, 98.8],
  [98.8, 99.0, 98.5, 98.9], [98.9, 99.0, 98.6, 98.9]
]))[0];
assert.equal(replayWeek(touchWeek, "long", { ...DEFAULT_CONFIG, slots: 1 }).openPositions.length, 0);
assert.equal(replayWeek(touchWeek, "long", { ...DEFAULT_CONFIG, slots: 1, fillRequiresTradeThrough: false }).openPositions.length, 1);

// Opening gaps execute at the adverse open, never the stale stop. Ambiguous
// daily bars resolve stop-first.
const gapWeeks = tradingWeeks([
  ...weekBars("2026-02-02", [
    [100, 100.2, 99.8, 100], [100, 100, 97.9, 98.2], [98.2, 98.8, 98.1, 98.4],
    [98.4, 98.8, 98.2, 98.5], [98.5, 98.8, 98.3, 98.5]
  ]),
  ...weekBars("2026-02-09", [
    [95, 95.5, 94.5, 95], [95, 95.5, 94.5, 95], [95, 95.5, 94.5, 95],
    [95, 95.5, 94.5, 95], [95, 95.5, 94.5, 95]
  ])
]);
const gapReplay = replayContinuous(gapWeeks, "long", { ...DEFAULT_CONFIG, slots: 1, maxConcurrentPositions: 1 });
assert.equal(gapReplay.trades[0].outcome, "stop-gap");
assert.equal(gapReplay.trades[0].exit, 95);
const ambiguous = replayWeek(tradingWeeks(weekBars("2026-04-06", [
  [100, 100.2, 99.8, 100], [100, 100, 97.9, 98.2], [98.2, 100.2, 95.8, 98],
  [98, 98.2, 97.8, 98], [98, 98.2, 97.8, 98]
]))[0], "long", { ...DEFAULT_CONFIG, slots: 1 });
assert.equal(ambiguous.trades[0].outcome, "stop-ambiguous");

// A closed rung cannot be recycled in the same week to inflate performance.
const noReentry = replayWeek(tradingWeeks(weekBars("2026-05-04", [
  [100, 100.5, 99.5, 100], [99.5, 99.6, 95, 96.5], [96.5, 105, 96.4, 104],
  [104, 104.5, 97, 100], [100, 101, 99, 100]
]))[0], "long", DEFAULT_CONFIG);
assert.equal(noReentry.trades.length, 2);
assert.equal(new Set(noReentry.trades.map((trade) => trade.level)).size, noReentry.trades.length);

assert.equal(wilsonBounds(0, 0).lowerPct, null);
const values = [2, 2, 2, 2, 2, -2, -2, -2, -2, -2];
assert.ok(clusterStandardError(values, ["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"])
  > clusterStandardError(values, values.map((_, index) => `w${index}`)));
assert.equal(weeklyCycle([bar("2026-01-05", 100, 100, 100, 100)]).ready, false);

console.log("Weekly-cycle tests passed: continuous holding, Monday rebase, temporal fills, gap/ambiguity exits, fill-once identity and clustered uncertainty");
