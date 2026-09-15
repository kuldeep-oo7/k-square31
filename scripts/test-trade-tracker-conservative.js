"use strict";

const assert = require("node:assert/strict");
const { evaluateOutcome } = require("../api/_lib/trade-tracker");
const { resolveIntradayExecution } = require("../api/_lib/intraday-feed");

function testConservativeSameBarAmbiguity() {
  const signal = {
    symbol: "SBIN",
    side: "long",
    entryPrice: 800.0,
    targetPrice: 816.0,
    stopLossPrice: 792.0,
    status: "ACTIVE",
    validFrom: Date.parse("2026-08-03T09:15:00Z"),
    filledAt: Date.parse("2026-08-03T09:16:00Z"),
    fillSession: "2026-08-03",
    fillOrderId: "FILL_SB_1"
  };

  // Scenario: Bar 1 triggers entry. Bar 2 spans BOTH target (818) and stop (790) in the same daily candle!
  const ambiguousBars = [
    { timestamp: Date.parse("2026-08-03T10:00:00Z"), open: 800, high: 805, low: 798, close: 802 },
    { timestamp: Date.parse("2026-08-04T10:00:00Z"), open: 802, high: 818, low: 790, close: 800 }
  ];

  const outcome = evaluateOutcome(signal, ambiguousBars);

  // Must resolve conservatively to STOPPED_OUT (LOSS), not TARGET_HIT (WIN)!
  assert.equal(outcome.status, "STOPPED_OUT", "Conservative rule must assume stop hit first");
  assert.equal(outcome.outcome, "LOSS");
  assert.equal(outcome.exitPrice, 792.0);
  assert.ok(outcome.pnlPct < 0, "P&L must be negative");
}

function testMinuteBarChronologicalResolution() {
  const orderIntent = {
    side: "long",
    entryPrice: 500.0,
    targetPrice: 510.0,
    stopLossPrice: 495.0
  };

  // 1-minute bars:
  // 09:15 - fills entry at 499
  // 09:16 - moves to 505
  // 09:17 - touches target 511 BEFORE stop is ever touched!
  // 09:18 - drops to 494 (stop touched later)
  const minuteBars = [
    { time: "09:15", high: 502, low: 499, close: 501 },
    { time: "09:16", high: 506, low: 501, close: 505 },
    { time: "09:17", high: 511, low: 504, close: 509 }, // target touched first at 09:17
    { time: "09:18", high: 509, low: 494, close: 495 }  // stop touched second at 09:18
  ];

  const resolution = resolveIntradayExecution({ orderIntent, minuteBars });
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.exitReason, "TARGET_HIT");
  assert.equal(resolution.exitPrice, 510.0);
  assert.equal(resolution.exitTime, "09:17");
}

function run() {
  testConservativeSameBarAmbiguity();
  testMinuteBarChronologicalResolution();
  console.log("Conservative ambiguity & intraday execution tests passed successfully!");
}

run();
