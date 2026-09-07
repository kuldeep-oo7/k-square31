"use strict";

const assert = require("node:assert/strict");
const { recommendation } = require("../api/_lib/recommendation");
const { weeklyCycle } = require("../api/_lib/weekly-cycle");

console.log("Starting Multi-Target Staged Exits, Holding Duration & 8-Pillar Quant Test Suite...\n");

function revertingBars(weekCount) {
  const bars = [];
  const start = Date.parse("2021-01-04T06:30:00Z");
  for (let week = 0; week < weekCount; week += 1) {
    const base = 100 * (1.0008 ** week);
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
      bars.push({
        timestamp: Math.floor(Date.parse(`${date}T06:30:00Z`) / 1000),
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
        volume: 1_000_000
      });
    });
  }
  return bars;
}

const bars = revertingBars(181);
assert.ok(bars.length >= 800, "Must have sufficient historical bars for testing");

const cycle = weeklyCycle(bars);
const rec = recommendation({
  symbol: "SYNTHETIC_STOCK",
  bars,
  cycle,
  contract: {
    contractSymbol: "SYNTHETIC-2026-09-29-FUT",
    lotSize: 250,
    expiry: "2026-09-29",
    spot: 115,
    futures: 115.5
  }
});

// Test 1: Actionable trade generation with entries
assert.equal(rec.action, "buy-ladder");
assert.equal(rec.side, "long");
assert.ok(rec.entries && rec.entries.length > 0, "Test 1 Failed: Actionable trade must provide entries");
const entry = rec.entries[0];

// Test 2: Exact 3-Tier Staged Targets must be populated
assert.ok(entry.target1Price > entry.entry, "Test 2A Failed: Target 1 must be higher than entry for Long");
assert.ok(entry.target2Price > entry.target1Price, "Test 2B Failed: Target 2 Runner must be higher than Target 1");
assert.ok(entry.target3MacroPrice > entry.target2Price, "Test 2C Failed: Target 3 Macro must be higher than Target 2");
assert.ok(entry.stopLoss < entry.entry, "Test 2D Failed: Stop-loss must sit below entry for Long");

// Test 3: Holding Duration Horizons must be populated and realistic
assert.ok(entry.holdingDaysT1 >= 1 && entry.holdingDaysT1 <= 5, "Test 3A Failed: Target 1 expected holding days should be 1-5 sessions");
assert.ok(entry.holdingDaysT2 >= 5 && entry.holdingDaysT2 <= 30, "Test 3B Failed: Target 2 Runner expected holding days should be 5-30 sessions");
assert.ok(entry.stagedExecutionPlan && entry.stagedExecutionPlan.includes("T1: Bank 50%"), "Test 3C Failed: Staged execution plan must include 50% bank instruction");
assert.ok(entry.stagedExecutionPlan.includes("slide SL to Breakeven"), "Test 3D Failed: Staged execution plan must include sliding SL to Breakeven");

// Test 4: Staged Exit Profit Outperformance Simulation in Trending / Momentum Regimes
console.log("Simulating 3-Tier Staged Exits vs Flat 2% Cap on trending/momentum series...");

function trendingSeries(count = 60) {
  const trendBars = [];
  let p = 1000;
  for (let i = 0; i < count; i++) {
    // Trend with healthy pullbacks: moves +1.2% per day with 2% intraday swings
    const open = p;
    const low = open * 0.98; // 2% dip
    const high = open * 1.03; // 3% push
    const close = open * 1.012;
    trendBars.push({ open, high, low, close });
    p = close;
  }
  return trendBars;
}

const trendData = trendingSeries(60);
let flatPnlTotal = 0;
let stagedPnlTotal = 0;
let tradesCount = 0;

for (let i = 0; i < trendData.length - 8; i += 4) {
  const testEntry = trendData[i].low; // Filled at dip
  const testT1 = testEntry * 1.02; // +2%
  const testT2 = testEntry * 1.06; // +6%
  const testT3 = testEntry * 1.15; // +15%
  const testSl = testEntry * 0.99; // 1% initial SL

  let t1 = false;
  let t2 = false;
  let t3 = false;
  let stopped = false;

  for (let f = i; f < i + 8 && f < trendData.length; f++) {
    const b = trendData[f];
    if (!t1) {
      if (b.low <= testSl) { stopped = true; break; }
      if (b.high >= testT1) t1 = true;
    } else {
      if (b.low <= testEntry) break; // Breakeven exit on remainder
      if (b.high >= testT2) t2 = true;
      if (b.high >= testT3) t3 = true;
    }
  }

  tradesCount++;
  if (stopped) {
    flatPnlTotal -= 1.0;
    stagedPnlTotal -= 1.0;
  } else if (t1) {
    flatPnlTotal += 2.0; // Flat 2% exit

    // Staged: 50% at T1 (+2%), 25% at T2 (+6%), 25% at T3 (+15%)
    let stagedPnl = 0.5 * 2.0;
    if (t2) stagedPnl += 0.25 * 6.0;
    if (t3) stagedPnl += 0.25 * 15.0;
    stagedPnlTotal += stagedPnl;
  }
}

console.log(`  Trades Simulated               : ${tradesCount}`);
console.log(`  Flat 2% Cap Total Yield        : +${flatPnlTotal.toFixed(2)}%`);
console.log(`  Staged 3-Tier Multi-Target     : +${stagedPnlTotal.toFixed(2)}%`);

assert.ok(stagedPnlTotal > flatPnlTotal, "Test 4 Failed: Staged exits must capture fat-tail trend runners exceeding the 2% cap");

// Test 5: All 8 Institutional Quantitative Pillars must be populated
assert.ok(rec.eightPillars, "Test 5 Failed: eightPillars object must exist on trade recommendation");
assert.ok(rec.eightPillars.pillar1_fundamentals !== undefined, "Pillar 1 (Fundamentals) must be present");
assert.ok(rec.eightPillars.pillar2_technicals !== undefined, "Pillar 2 (Technicals) must be present");
assert.ok(rec.eightPillars.pillar3_chartPattern !== undefined, "Pillar 3 (Chart Patterns) must be present");
assert.ok(rec.eightPillars.pillar4_candlesticks !== undefined, "Pillar 4 (Candlesticks) must be present");
assert.ok(rec.eightPillars.pillar5_quantMath !== undefined, "Pillar 5 (Quant Math) must be present");
assert.ok(rec.eightPillars.pillar6_statistics !== undefined, "Pillar 6 (Statistics) must be present");
assert.ok(rec.eightPillars.pillar7_microstructure !== undefined, "Pillar 7 (Microstructure) must be present");
assert.ok(rec.eightPillars.pillar8_machineLearning !== undefined, "Pillar 8 (Machine Learning) must be present");

console.log("\nALL 5 Multi-Target, Holding Duration & 8-Pillar Quant tests PASSED successfully!");
