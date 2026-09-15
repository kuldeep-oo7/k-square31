"use strict";

const assert = require("node:assert/strict");
const { currentAnchor, rankRecommendations, recommendation } = require("../api/_lib/recommendation");
const { weeklyCycle } = require("../api/_lib/weekly-cycle");

function bar(date, open, high, low, close) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume: 1_000_000 };
}

// A synthetic positive-branch fixture, not market profitability evidence.
function revertingBars(weekCount) {
  const bars = [];
  const start = Date.parse("2021-01-04T06:30:00Z");
  for (let week = 0; week < weekCount; week += 1) {
    const base = 100 * 1.0008 ** week;
    // Seven-week spacing avoids identical five-week block means. Misses carry
    // into the next week; they are never fabricated Friday liquidations.
    const misses = week % 7 === 0;
    const days = misses
      ? [
        [base, base * 1.002, base * 0.999, base],
        [base, base * 1.001, base * 0.974, base * 0.978],
        [base * 0.978, base * 0.985, base * 0.974, base * 0.98],
        [base * 0.98, base * 0.99, base * 0.975, base * 0.977],
        [base * 0.977, base * 0.98, base * 0.974, base * 0.9765]
      ]
      : [
        [base, base * 1.002, base * 0.999, base],
        [base, base * 1.001, base * 0.974, base * 0.978],
        [base * 0.978, base * 1.001, base * 0.976, base * 1.0],
        [base * 1.0, base * 1.002, base * 0.998, base * 1.001],
        [base * 1.001, base * 1.004, base * 0.999, base * 1.002]
      ];
    days.forEach((values, day) => {
      const date = new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10);
      bars.push(bar(date, ...values));
    });
  }
  return bars;
}

const bars = revertingBars(181);
const anchor = currentAnchor(bars);
assert.ok(anchor.anchor > 0);
assert.equal(anchor.sessionsElapsed, 5);

const buy = recommendation({
  symbol: "TESTLONG",
  bars,
  sector: "TEST_SECTOR",
  decisionAt: "2026-09-08T10:00:00.000Z",
  contract: {
    contractSymbol: "TESTLONG26SEPFUT",
    instrumentId: "NSE-FO-12345",
    expiry: "2026-09-29",
    lotSize: 250,
    futures: 116,
    spot: 115,
    tickSize: 0.01,
    volume: 120000,
    openInterest: 450000,
    tradeDate: "2026-09-08",
    banStatus: "CLEAR",
    marginPerLot: 8500,
    segment: "NSE_FO"
  }
});
assert.equal(buy.action, "buy-ladder");
assert.equal(buy.side, "long");
assert.ok(buy.entries.length > 0, "an actionable call must name the rungs to work");
assert.ok(buy.entries.every((entry) => entry.entry > 0 && entry.target > entry.entry), "long targets sit above their entry");
assert.ok(buy.entries.every((entry) => entry.stopLoss < entry.entry), "long stop loss sits below entry");
assert.ok(buy.entries.every((entry) => entry.riskReward === 1 && entry.targetPct === 2 && entry.stopLossPct === 2), "execution levels must match the canonical 2%/2% research policy");
assert.equal(buy.entries[0].entry, Math.round(anchor.anchor * 0.98 * 100) / 100);
assert.ok(buy.convictionPct > 0 && buy.convictionPct <= 100);
assert.ok(buy.sizeMultiplier >= 0.25 && buy.sizeMultiplier <= 1);
assert.match(buy.bookOut, /Hold across Fridays/);
assert.match(buy.bookOut, /20-session risk ceiling/);
assert.deepEqual(buy.vetoes, []);
assert.ok(buy.reasons.length > 1);

// A results date inside the trading week is a hard veto, whatever the price
// history says, because the ladder is sized for drift and not for a gap.
const vetoed = recommendation({
  symbol: "TESTLONG",
  bars,
  fundamentals: { available: true, veto: "Results are scheduled inside this trading week", balanceSheetScore: 0.4, events: { nextEarningsDate: "2026-08-14", insideTradingWeek: true }, metrics: {} }
});
assert.equal(vetoed.action, "stand-aside");
assert.equal(vetoed.sizeMultiplier, 0);
assert.match(vetoed.reasons[0], /Results are scheduled/);
assert.equal(vetoed.entries.length, 0, "a vetoed name must not publish entry levels");

// An unvalidated model is advisory-only and cannot veto an otherwise accepted
// rule. A model that passes every governance hurdle may veto it.
const weakModelAdvisory = recommendation({
  symbol: "TESTLONG",
  bars,
  model: { ready: true, trustworthy: false, expectedWeeklyPct: -0.8, validation: { ready: false } }
});
assert.equal(weakModelAdvisory.action, "buy-ladder");
assert.equal(weakModelAdvisory.evidence.modelTrustworthy, false);
const validatedModelVeto = recommendation({
  symbol: "TESTLONG",
  bars,
  model: {
    ready: true,
    expectedWeeklyPct: -0.8,
    validation: {
      ready: true,
      outOfSample: { informationCoefficient: 0.08, rSquared: 0.04, actedAverageWeeklyPct: 0.2 },
      perFold: [
        { informationCoefficient: 0.07, rSquared: 0.03, trainLabelThrough: "2025-01-01", testLabelFrom: "2025-01-06" },
        { informationCoefficient: 0.09, rSquared: 0.05, trainLabelThrough: "2025-05-01", testLabelFrom: "2025-05-05" }
      ]
    }
  }
});
assert.equal(validatedModelVeto.action, "stand-aside");
assert.match(validatedModelVeto.reasons[0], /expects a -0.8% week/);

// Conviction must respond to the evidence, not sit at a constant.
const strong = recommendation({
  symbol: "TESTLONG", bars,
  technical: { score: 55 },
  fundamentals: { available: true, veto: null, balanceSheetScore: 0.8, events: {}, metrics: {} }
});
const weak = recommendation({
  symbol: "TESTLONG", bars,
  technical: { score: -55 },
  fundamentals: { available: true, veto: null, balanceSheetScore: -0.8, events: {}, metrics: {} }
});
assert.ok(strong.convictionPct > weak.convictionPct, "aligned technicals and a stronger balance sheet must raise conviction");
assert.ok(strong.sizeMultiplier >= weak.sizeMultiplier);

// Too little history must produce a refusal, never a guess.
const thin = recommendation({ symbol: "THIN", bars: bars.slice(0, 40) });
assert.equal(thin.action, "stand-aside");
assert.equal(thin.expectedWeeklyPct, null);

const ranked = rankRecommendations([
  { symbol: "A", action: "buy-ladder", side: "long", expectedWeeklyPct: 0.4, convictionPct: 50, weekKey: "2026-08-10" },
  { symbol: "B", action: "buy-ladder", side: "long", expectedWeeklyPct: 1.2, convictionPct: 40, weekKey: "2026-08-10" },
  { symbol: "C", action: "sell-ladder", side: "short", expectedWeeklyPct: 0.9, convictionPct: 60, weekKey: "2026-08-10" },
  { symbol: "D", action: "stand-aside", reasons: ["Results are scheduled inside this trading week"] }
], { requireExecutable: false });
assert.equal(ranked.considered, 4);
assert.equal(ranked.actionable, 3);
assert.deepEqual(ranked.best.map((item) => item.symbol), ["B", "C", "A"], "the list is ordered by expected weekly result");
assert.deepEqual(ranked.buys.map((item) => item.symbol), ["B", "A"]);
assert.deepEqual(ranked.sells.map((item) => item.symbol), ["C"]);
// Regression test for P0-006: OrderIntent must be present on actionable entries with pure F&O fields
assert.ok(buy.entries[0].orderIntent, "actionable entry must carry an OrderIntent");
assert.equal(buy.entries[0].orderIntent.segment, "NSE_FO");
assert.equal(buy.entries[0].orderIntent.instrumentType, "STOCK_FUTURE");
assert.equal(buy.entries[0].orderIntent.finInstrmTp, "STF");
assert.equal(buy.entries[0].orderIntent.executable, true);
assert.equal(buy.entries[0].orderIntent.contractSymbol, "TESTLONG26SEPFUT");
assert.equal(buy.entries[0].orderIntent.instrumentId, "NSE-FO-12345");
assert.ok(buy.entries[0].orderIntent.contractNotional > 0);
assert.ok(buy.entries[0].orderIntent.estMarginRequired > 0);
assert.ok(buy.entries[0].orderIntent.maxRiskInr > 0);
assert.equal(buy.entries[0].orderIntent.tickSize, 0.01);
assert.equal(buy.entries[0].orderIntent.liveExecutable, false, "margin alone cannot imply broker/regulatory approval");
assert.equal(buy.entries[0].orderIntent.executionMode, "SHADOW_ONLY");
assert.equal("runnerTarget" in buy.entries[0], false, "unvalidated staged runner targets must not appear as orders");
assert.equal("runnerTargetPrice" in buy.entries[0].orderIntent, false);

// C-6: Fail-closed when contract lot size is missing:
const missingContract = recommendation({ symbol: "NOLOT", bars });
assert.equal(missingContract.entries[0].orderIntent.executable, false);
assert.equal(missingContract.entries[0].orderIntent.rejectionReason, "MISSING_CONTRACT_LOT_SIZE");

console.log("Recommendation tests passed: governed ML, exchange-identified futures intents, fail-closed sizing, shadow-only execution and ranked candidates");
