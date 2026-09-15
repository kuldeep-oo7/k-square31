"use strict";

// Regression gate for the removed staged-target downgrade. The filename is
// retained so existing CI invokes it, but the production strategy remains the
// one actually researched: one target, one stop and a continuous holding clock.

const assert = require("node:assert/strict");
const { DEFAULT_CONFIG } = require("../api/_lib/weekly-cycle");
const { buildOrderIntent } = require("../api/_lib/recommendation");

assert.equal(DEFAULT_CONFIG.fridayLiquidation, false);
assert.equal(DEFAULT_CONFIG.maxHoldingSessions, 20);
assert.equal(Object.hasOwn(DEFAULT_CONFIG, "stagedExit"), false);
assert.equal(Object.hasOwn(DEFAULT_CONFIG, "target2Pct"), false);
assert.equal(Object.hasOwn(DEFAULT_CONFIG, "target3Pct"), false);

const intent = buildOrderIntent({
  symbol: "RELIANCE",
  side: "long",
  entry: 100,
  target: 102,
  stopLoss: 98,
  sizeMultiplier: 0.5,
  riskReward: 1,
  targetPct: 2,
  stopLossPct: 2,
  weekKey: "2026-09-07",
  level: 1,
  sector: "ENERGY",
  decisionAt: "2026-09-08T10:00:00.000Z",
  contract: {
    contractSymbol: "RELIANCE26OCTFUT",
    instrumentId: "NSE-FO-RELIANCE-OCT",
    expiry: "2026-10-27",
    lotSize: 500,
    spot: 100,
    tickSize: 0.01,
    volume: 100000,
    openInterest: 500000,
    tradeDate: "2026-09-08",
    banStatus: "CLEAR",
    marginPerLot: 15000,
    segment: "NSE_FO"
  }
});

assert.equal(intent.executable, true);
assert.equal(intent.targetPrice, 102);
assert.equal(intent.stopLossPrice, 98);
for (const fabricatedField of [
  "target1Price", "target2Price", "target3MacroPrice", "runnerTargetPrice",
  "holdingDaysT1", "holdingDaysT2", "stagedExecutionPlan", "moonbag"
]) {
  assert.equal(Object.hasOwn(intent, fabricatedField), false, `${fabricatedField} must not be presented as a validated execution field`);
}
assert.equal(intent.liveExecutable, false, "current margin does not prove broker/regulatory readiness");
assert.equal(intent.executionMode, "SHADOW_ONLY");

console.log("Strategy-parity test passed: unvalidated staged exits and promised holding horizons are absent; continuous shadow-only policy remains canonical");
