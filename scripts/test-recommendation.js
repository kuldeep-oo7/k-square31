"use strict";

const assert = require("node:assert/strict");
const { currentAnchor, rankRecommendations, recommendation } = require("../api/_lib/recommendation");
const { weeklyCycle } = require("../api/_lib/weekly-cycle");

function bar(date, open, high, low, close) {
  return { timestamp: Date.parse(`${date}T06:30:00Z`) / 1000, open, high, low, close, volume: 1_000_000 };
}

// A series that reliably dips 2% and recovers inside the week, so the long
// ladder has a genuine measured edge to be recommended.
function revertingBars(weekCount) {
  const bars = [];
  const start = Date.parse("2021-01-04T06:30:00Z");
  for (let week = 0; week < weekCount; week += 1) {
    const base = 100 * 1.0008 ** week;
    // Every fifth week fails to recover and is booked at a loss on Friday, so
    // the sample carries genuine dispersion rather than one repeated outcome.
    const misses = week % 5 === 0;
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

// 181 weeks leaves week 181 next, which this fixture makes a recovery week, so
// the model and the historical rule agree. 180 weeks leaves a scheduled losing
// week next - used below to prove the model can veto its own ladder.
const bars = revertingBars(181);
const beforeLosingWeek = revertingBars(180);
const anchor = currentAnchor(bars);
assert.ok(anchor.anchor > 0);
assert.equal(anchor.sessionsElapsed, 5);

const buy = recommendation({ symbol: "TESTLONG", bars });
assert.equal(buy.action, "buy-ladder");
assert.equal(buy.side, "long");
assert.ok(buy.entries.length > 0, "an actionable call must name the rungs to work");
assert.ok(buy.entries.every((entry) => entry.entry > 0 && entry.target > entry.entry), "long targets sit above their entry");
assert.ok(buy.entries.every((entry) => entry.stopLoss < entry.entry), "long stop loss sits below entry");
assert.ok(buy.entries.every((entry) => entry.riskReward >= 1.5), "risk reward ratio is at least 1.5");
assert.equal(buy.entries[0].entry, Math.round(anchor.anchor * 0.98 * 100) / 100);
assert.ok(buy.convictionPct > 0 && buy.convictionPct <= 100);
assert.ok(buy.sizeMultiplier >= 0.25 && buy.sizeMultiplier <= 1);
assert.match(buy.bookOut, /Friday close/);
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

// A model that expects a losing week outranks a flattering backtest.
const modelVeto = recommendation({
  symbol: "TESTLONG",
  bars,
  model: { ready: true, trustworthy: false, expectedWeeklyPct: -0.8, validation: { ready: false } }
});
assert.equal(modelVeto.action, "stand-aside");
assert.match(modelVeto.reasons[0], /expects a -0.8% week/);

// The same veto driven by a real fit rather than a stub: the rule's own history
// says buy this ladder, but the trained model has learned that the week about to
// start is the one that does not recover, and it wins the argument.
const learnedCycle = weeklyCycle(beforeLosingWeek);
assert.equal(learnedCycle.verdict.action, "buy-ladder", "the historical rule alone still likes this name");
const learnedVeto = recommendation({ symbol: "TESTLONG", bars: beforeLosingWeek });
assert.equal(learnedVeto.action, "stand-aside", "a trained model that expects a down week overrides the ladder's own history");
assert.match(learnedVeto.reasons[0], /The model expects a -?\d+(\.\d+)?% week/);

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
]);
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
assert.ok(buy.entries[0].orderIntent.contractNotional > 0);
assert.ok(buy.entries[0].orderIntent.estMarginRequired > 0);
assert.ok(buy.entries[0].orderIntent.maxRiskInr > 0);
assert.equal(buy.entries[0].orderIntent.tickSize, 0.05);

// Regression test for P0-001: Potential route must strictly obey Meta VETO
const potentialVeto = recommendation({
  symbol: "POTENTIALVETO",
  bars,
  cycle: { ready: true, verdict: { action: "stand-aside", side: null, levels: [], reason: "No ladder edge" }, weeks: 20 },
  potential: {
    side: "long",
    expectedMovePct: 3.5,
    floorPct: 2.0,
    typicalErrorPct: 2.5,
    reason: "Machine learning edge",
    components: [{ name: "ML", expectedPct: 3.5, note: "forecast" }],
    forecast: { informationCoefficient: -0.05 } // weak/negative IC creates VETO
  }
});
// When metaGate rejects, it must NEVER create an active potential trade or positive size
if (potentialVeto.advancedQuant?.metaDecision === "VETO") {
  assert.equal(potentialVeto.action, "stand-aside", "Potential route must be vetoed when metaDecision is VETO");
  assert.equal(potentialVeto.sizeMultiplier, 0, "Size multiplier must be 0 on VETO");
}

console.log("Recommendation tests passed: rung-level entries, hard vetoes ahead of conviction, evidence-driven sizing and ranked buying list");
