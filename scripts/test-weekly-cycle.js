"use strict";

const assert = require("node:assert/strict");
const { DEFAULT_CONFIG, ladder, replayWeek, tradingWeeks, weeklyCycle, weekKeyOf, wilsonBounds } = require("../api/_lib/weekly-cycle");

const CONFIG = { ...DEFAULT_CONFIG };

// 06:30 UTC is midday in Kolkata, so each bar's IST session date equals its
// calendar date and the week grouping is unambiguous.
function bar(date, open, high, low, close) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume: 1_000_000 };
}

assert.equal(weekKeyOf("2026-01-09"), "2026-01-05", "Friday maps back to its Monday");
assert.equal(weekKeyOf("2026-01-05"), "2026-01-05");
assert.deepEqual(ladder(100, "long", CONFIG).map((entry) => entry.price), [98, 96.04, 94.1192, 92.2368, 90.3921]);
assert.deepEqual(ladder(100, "short", CONFIG).map((entry) => entry.price), [102, 104.04, 106.1208, 108.2432, 110.4081]);

// A rung fills on Tuesday's dip. Tuesday's own high already exceeds the target,
// which a naive same-bar backtest would book that day; the replay must wait.
const targetWeek = tradingWeeks([
  bar("2026-01-05", 100, 100.5, 99.5, 100),
  bar("2026-01-06", 100, 100.0, 97.9, 98.2),
  bar("2026-01-07", 98.2, 98.5, 98.0, 98.3),
  bar("2026-01-08", 98.3, 100.2, 98.3, 100),
  bar("2026-01-09", 100, 100.2, 99.8, 100)
]);
assert.equal(targetWeek.length, 1);
const targetReplay = replayWeek(targetWeek[0], "long", CONFIG);
assert.equal(targetReplay.trades.length, 1, "only the first rung filled");
const [filled] = targetReplay.trades;
assert.equal(filled.level, 1);
assert.equal(filled.entry, 98);
assert.equal(filled.target, 99.96);
assert.equal(filled.outcome, "target");
assert.equal(filled.filledSession, "2026-01-06");
assert.equal(filled.exitSession, "2026-01-08", "the target cannot be booked on the session that filled the rung");
assert.equal(filled.sessionsHeld, 2);
assert.equal(filled.netPct, 1.92, "2% target less the 0.08% institutional round trip");
assert.equal(targetReplay.weekNetPct, 0.384, "capital-weighted return 1.92 / 5 is the production default");
assert.equal(targetReplay.capitalWeightedNetPct, 0.384);

// Nothing recovers and stop is not breached, so the filled rung is booked at the Friday close
const fridayWeek = tradingWeeks([
  bar("2026-01-12", 100, 100, 100, 100),
  bar("2026-01-13", 100, 100, 97.5, 97.5),
  bar("2026-01-14", 97.5, 98, 96.5, 96.8),
  bar("2026-01-15", 96.8, 97.2, 96.5, 97.0),
  bar("2026-01-16", 97.0, 97.5, 96.8, 97.0)
]);
const fridayReplay = replayWeek(fridayWeek[0], "long", CONFIG);
assert.equal(fridayReplay.trades.length, 1);
assert.equal(fridayReplay.trades[0].level, 1);
assert.equal(fridayReplay.trades[0].outcome, "friday");
assert.equal(fridayReplay.trades[0].exit, 97.0, "open legs are booked at the Friday close");
assert.equal(fridayReplay.trades[0].netPct, -1.1204, "loss carries the 0.08% cost + 0.02% book-out slippage");
assert.equal(fridayReplay.weekNetPct, -0.2241, "capital-weighted portfolio loss -1.1204 / 5");

// The short ladder is the mirror image: rungs rest above the anchor and the
// target sits below the fill.
const shortReplay = replayWeek(tradingWeeks([
  bar("2026-01-19", 100, 100, 100, 100),
  bar("2026-01-20", 100, 102.5, 100, 102.2),
  bar("2026-01-21", 102.2, 102.4, 99.5, 99.8),
  bar("2026-01-22", 99.8, 100, 99.5, 99.8),
  bar("2026-01-23", 99.8, 100, 99.5, 99.8)
])[0], "short", CONFIG);
assert.equal(shortReplay.trades.length, 1);
assert.equal(shortReplay.trades[0].entry, 102);
assert.equal(shortReplay.trades[0].target, 99.96);
assert.equal(shortReplay.trades[0].outcome, "target");
assert.equal(shortReplay.trades[0].netPct, 1.92, "a short target earns the same 2% less 0.08% costs");

assert.equal(wilsonBounds(6, 8).lowerPct < 75, true, "a small sample's lower bound sits well under the raw hit rate");
assert.equal(wilsonBounds(0, 0).lowerPct, null);

// Identical outcomes carry no dispersion, so they must carry no significance
// either: a float-noise sigma would otherwise report an astronomical t-statistic.
const identical = weeklyCycle(syntheticIdentical(), { minimumWeeks: 4, slots: 1 });
identical.long.levels.forEach((entry) => {
  if (entry.fills > 1 && entry.hitRatePct === 100) {
    assert.equal(entry.tStat, null, "a rung whose fills all returned the same amount has no measurable t-statistic");
    assert.equal(entry.standardErrorPct, null);
  }
});
assert.deepEqual(identical.long.viableLevels, [], "no dispersion can never clear the significance hurdle");

// Short histories must refuse to publish an edge rather than fit one.
assert.equal(weeklyCycle([bar("2026-01-05", 100, 100, 100, 100)]).ready, false);

// A synthetic series that mean-reverts 2% inside every week: the long ladder
// should find a significant, positive edge; the noise-only series should not.
// Ten identical weeks: the rung fills at 98 and exits at exactly 99.96 every
// time, so all ten fills return precisely the same net percentage.
function syntheticIdentical() {
  const bars = [];
  const start = Date.parse("2025-01-06T06:30:00Z");
  for (let week = 0; week < 10; week += 1) {
    const dates = Array.from({ length: 5 }, (_, day) => new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10));
    bars.push(bar(dates[0], 100, 100.2, 99.8, 100));
    bars.push(bar(dates[1], 100, 100, 97.9, 98.2));
    bars.push(bar(dates[2], 98.2, 99.96, 98, 99.9));
    bars.push(bar(dates[3], 99.9, 100.1, 99.8, 100));
    bars.push(bar(dates[4], 100, 100.1, 99.9, 100));
  }
  return bars;
}

function syntheticBars(weekCount, builder) {
  const bars = [];
  const start = Date.parse("2024-01-01T06:30:00Z");
  for (let week = 0; week < weekCount; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const date = new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10);
      bars.push(bar(date, ...builder(week, day)));
    }
  }
  return bars;
}

// Four weeks in five dip 2% and bounce back through the target; the fifth keeps
// falling and is booked at a loss on Friday. Real dispersion, real edge.
const reverting = weeklyCycle(syntheticBars(80, (week, day) => {
  const base = 100 * 1.001 ** week;
  const misses = week % 5 === 0;
  if (day === 0) return [base, base * 1.002, base * 0.999, base];
  if (day === 1) return [base, base * 1.001, base * 0.974, base * 0.978];
  if (day === 2) return misses
    ? [base * 0.978, base * 0.985, base * 0.974, base * 0.98]
    : [base * 0.978, base * 1.001, base * 0.976, base * 1.0];
  if (day === 3) return misses
    ? [base * 0.98, base * 0.99, base * 0.975, base * 0.977]
    : [base * 1.0, base * 1.002, base * 0.998, base * 1.001];
  return misses
    ? [base * 0.977, base * 0.98, base * 0.974, base * 0.9765]
    : [base * 1.001, base * 1.004, base * 0.999, base * 1.002];
}), { minimumWeeks: 60 });
assert.equal(reverting.ready, true);
assert.equal(reverting.weeks, 80);
assert.equal(reverting.long.levels[0].fills, 80, "rung 1 fills every week in this series");
assert.equal(reverting.long.levels[0].hitRatePct, 80, "four weeks in five reach the target");
assert.ok(reverting.long.levels[0].lowerPct < 80, "the 95% lower bound sits below the observed rate");
assert.ok(Number(reverting.long.levels[0].standardErrorPct) > 0, "a real edge has measurable dispersion");
assert.ok(reverting.long.viableLevels.includes(1), "a repeatable 2% bounce clears the hurdle");
assert.equal(reverting.verdict.action, "buy-ladder");
assert.equal(reverting.verdict.side, "long");
assert.ok(Number(reverting.long.outOfSample.averageWeeklyPct) > 0);

const drifting = weeklyCycle(syntheticBars(80, (week, day) => {
  const base = 100 * 0.99 ** week;
  if (day === 0) return [base, base * 1.001, base * 0.999, base];
  if (day === 1) return [base, base * 1.0, base * 0.973, base * 0.975];
  if (day === 2) return [base * 0.975, base * 0.978, base * 0.968, base * 0.97];
  if (day === 3) return [base * 0.97, base * 0.972, base * 0.962, base * 0.965];
  return [base * 0.965, base * 0.967, base * 0.958, base * 0.96];
}), { minimumWeeks: 60 });
assert.equal(drifting.ready, true);
assert.deepEqual(drifting.long.viableLevels, [], "a one-way downtrend gives the buy ladder no edge");
// Regression test for C-1 / P0-007: Stop-loss barrier execution using production DEFAULT_CONFIG
const stopWeek = tradingWeeks([
  bar("2026-02-02", 100, 100.5, 99.5, 100),
  bar("2026-02-03", 100, 100.0, 97.9, 98.0), // fills rung 1 at 98.0 (target: 99.96, default 2% stop: 96.04)
  bar("2026-02-04", 98.0, 98.5, 96.0, 96.2), // low hits 96.0 <= 96.04 (stop triggered by default!)
  bar("2026-02-05", 96.2, 101.0, 96.2, 100.5),
  bar("2026-02-06", 100.5, 101.0, 99.8, 100.0)
]);
const stopReplay = replayWeek(stopWeek[0], "long", CONFIG);
assert.ok(stopReplay.trades.length >= 1);
assert.equal(stopReplay.trades[0].level, 1);
assert.equal(stopReplay.trades[0].outcome, "stop", "trade must exit at default stop barrier without passing test flags");
assert.equal(stopReplay.trades[0].exit, 96.04);
assert.ok(stopReplay.trades[0].netPct < 0, "stop loss produces negative net return");

// Regression test for C-1 / P0-007: Same-bar ambiguity resolution (conservative: stop takes precedence)
const ambiguousWeek = tradingWeeks([
  bar("2026-02-09", 100, 100.5, 99.5, 100),
  bar("2026-02-10", 100, 100.0, 97.9, 98.0), // fills rung 1 at 98.0 (target: 99.96, stop: 96.04)
  bar("2026-02-11", 98.0, 101.5, 95.0, 99.0), // high 101.5 >= target AND low 95.0 <= stop in same bar!
  bar("2026-02-12", 99.0, 100.0, 99.0, 99.5),
  bar("2026-02-13", 99.5, 100.0, 99.0, 99.5)
]);
const ambiguousReplay = replayWeek(ambiguousWeek[0], "long", CONFIG);
assert.equal(ambiguousReplay.trades[0].outcome, "stop", "conservative ambiguity rule: same-bar conflict must resolve to stop loss");

// Regression test for C-2 / P0-008: Capital weighted return calculation in default production config
const defaultReplay = replayWeek(targetWeek[0], "long", CONFIG);
assert.equal(defaultReplay.weekNetPct, defaultReplay.capitalWeightedNetPct, "capital weighted mode is the production default without any test flags");
assert.equal(defaultReplay.weekNetPct, 0.384);

console.log("Weekly cycle tests passed: triple-barrier replay, no same-bar exits, no Friday fills, short mirror and hurdle gating");
