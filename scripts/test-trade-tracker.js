"use strict";

const assert = require("node:assert/strict");
const tracker = require("../api/_lib/trade-tracker");

const decisionAt = Date.parse("2026-08-24T10:00:00.000Z");
const rec = {
  symbol: "RELIANCE",
  side: "long",
  action: "buy-ladder",
  weekKey: "2026-08-24",
  decisionAt,
  anchor: 1300,
  entries: [
    {
      level: 1,
      entry: 1300,
      target: 1326,
      stopLoss: 1287,
      riskReward: 2,
      orderIntent: {
        clientOrderId: "K2_REL_L1",
        contractSymbol: "RELIANCE26SEPFUT",
        instrumentId: "12345",
        expiry: "2026-09-29",
        decisionAt
      }
    },
    {
      level: 2,
      entry: 1274,
      target: 1299.48,
      stopLoss: 1261.26,
      orderIntent: {
        clientOrderId: "K2_REL_L2",
        contractSymbol: "RELIANCE26SEPFUT",
        instrumentId: "12345",
        expiry: "2026-09-29",
        decisionAt
      }
    }
  ],
  convictionPct: 80,
  expectedWeeklyPct: 2
};

const signals = tracker.createSignalRecords(rec, { return5Pct: 2.5, featureAsOf: decisionAt - 1_000 });
assert.equal(signals.length, 2, "one immutable signal record is required per rung/client order");
assert.notEqual(signals[0].signalId, signals[1].signalId);
const pending = signals[0];
assert.equal(pending.status, "PENDING");
assert.equal(pending.featureAsOf, decisionAt - 1_000);

// A plan row cannot be labelled by market bars before an actual execution join.
const postDecisionBars = [
  { timestamp: Date.parse("2026-08-25T10:00:00Z"), open: 1300, high: 1330, low: 1290, close: 1325 }
];
assert.equal(tracker.evaluateOutcome(pending, postDecisionBars).status, "PENDING");
assert.equal(tracker.evaluateOutcome(pending, postDecisionBars).outcome, null);

assert.equal(tracker.recordConfirmedFill(pending, { status: "FILLED", fillPrice: 1300, timestamp: decisionAt }).reason, "FILL_ORDER_ID_REQUIRED");
assert.equal(tracker.recordConfirmedFill(pending, {
  status: "FILLED", orderId: "FILL_BAD", clientOrderId: "WRONG", contractSymbol: "RELIANCE26SEPFUT",
  fillPrice: 1300, timestamp: decisionAt
}).reason, "CLIENT_ORDER_ID_MISMATCH");
assert.equal(tracker.recordConfirmedFill(pending, {
  status: "FILLED", orderId: "FILL_EARLY", clientOrderId: "K2_REL_L1", contractSymbol: "RELIANCE26SEPFUT",
  fillPrice: 1300, timestamp: decisionAt - 1
}).reason, "FILL_PRECEDES_VALID_FROM");

const joined = tracker.recordConfirmedFill(pending, {
  status: "FILLED",
  orderId: "FILL_1",
  clientOrderId: "K2_REL_L1",
  contractSymbol: "RELIANCE26SEPFUT",
  fillPrice: 1300,
  timestamp: decisionAt + 1_000
});
assert.equal(joined.updated, true);
assert.equal(joined.signal.status, "ACTIVE");
assert.equal(joined.signal.temporalIntegrity, "CONFIRMED_FILL");
assert.equal(tracker.recordConfirmedFill(joined.signal, {
  status: "FILLED", orderId: "FILL_1", clientOrderId: "K2_REL_L1", contractSymbol: "RELIANCE26SEPFUT",
  fillPrice: 1300, timestamp: decisionAt + 1_000
}).idempotent, true);

const resolved = tracker.evaluateOutcome(joined.signal, [
  // Same-session and pre-fill bars are deliberately impossible label inputs.
  { timestamp: decisionAt - 2_000, open: 1300, high: 1400, low: 1200, close: 1300 },
  { timestamp: decisionAt + 2_000, open: 1300, high: 1400, low: 1200, close: 1300 },
  { timestamp: Date.parse("2026-08-25T10:00:00Z"), open: 1301, high: 1328, low: 1300, close: 1325 }
]);
assert.equal(resolved.status, "TARGET_HIT");
assert.equal(resolved.outcome, "WIN");
assert.equal(resolved.exitPrice, 1326);
assert.equal(resolved.holdingSessions, 1);
assert.deepEqual(tracker.evaluateOutcome(resolved, postDecisionBars), resolved, "resolved outcomes are immutable/idempotent");

const secondPending = signals[1];
const secondActive = tracker.recordConfirmedFill(secondPending, {
  status: "FILLED", orderId: "FILL_2", clientOrderId: "K2_REL_L2", contractSymbol: "RELIANCE26SEPFUT",
  fillPrice: 1274, timestamp: decisionAt + 2_000
}).signal;
const loss = tracker.evaluateOutcome(secondActive, [
  { timestamp: Date.parse("2026-08-25T10:00:00Z"), open: 1250, high: 1260, low: 1240, close: 1250 }
]);
assert.equal(loss.status, "STOPPED_OUT");
assert.equal(loss.outcome, "LOSS");
assert.equal(loss.exitReason, "STOP_GAP");
assert.equal(loss.exitPrice, 1250);

const summary = tracker.summarizePerformance([resolved, loss, pending]);
assert.equal(summary.totalSignals, 3);
assert.equal(summary.resolvedSignals, 2);
assert.equal(summary.winCount, 1);
assert.equal(summary.lossCount, 1);
assert.equal(summary.unconfirmedSignalsExcluded, 1);

console.log("Trade-tracker tests passed: rung identity, confirmed-fill joins, temporal boundaries, gap exits, idempotence and unfilled-signal exclusion");
