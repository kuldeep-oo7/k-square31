"use strict";

const assert = require("node:assert/strict");
const { DEFAULT_CONFIG, replayWeek, tradingWeeks } = require("../api/_lib/weekly-cycle");
const { exitDecision } = require("./run-shadow-session");

function bar(date, open, high, low, close) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume: 100_000 };
}

const week = tradingWeeks([
  bar("2026-06-01", 100, 100.2, 99.8, 100),
  bar("2026-06-02", 100, 100, 97.9, 98.3),
  bar("2026-06-03", 98.3, 98.7, 98.1, 98.4),
  bar("2026-06-04", 98.4, 98.7, 98.1, 98.3),
  bar("2026-06-05", 98.3, 98.6, 98.0, 98.2)
])[0];

const timed = replayWeek(week, "long", {
  ...DEFAULT_CONFIG,
  slots: 1,
  maxConcurrentPositions: 1,
  maxHoldingSessions: 2
});
assert.equal(timed.trades.length, 1);
assert.equal(timed.trades[0].outcome, "time-stop");
assert.equal(timed.trades[0].exitSession, "2026-06-03");
assert.equal(timed.trades[0].sessionsHeld, 2, "Holding ceiling counts the entry session");
assert.equal(DEFAULT_CONFIG.fridayLiquidation, false);

const longAmbiguous = exitDecision(
  { side: "long", targetPrice: 102, stopLossPrice: 98 },
  { open: 100, high: 103, low: 97 }
);
assert.equal(longAmbiguous.exit, true);
assert.equal(longAmbiguous.reason, "STOP_FIRST_DAILY_AMBIGUITY");
assert.equal(longAmbiguous.referencePrice, 98);

const shortGap = exitDecision(
  { side: "short", targetPrice: 98, stopLossPrice: 102 },
  { open: 104, high: 105, low: 103 }
);
assert.equal(shortGap.reason, "STOP_GAP");
assert.equal(shortGap.referencePrice, 104);

console.log("Exit-policy tests passed: no Friday liquidation, finite risk ceiling, gap-aware exits and conservative daily-bar ambiguity");
