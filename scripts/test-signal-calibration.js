"use strict";

/**
 * Does the desk get held to its own estimates?
 *
 * The card says "70.5% chance of reaching it, usually about 1.2 days". Until
 * 2026-09-21 nothing recorded whether that was ever true, so the estimate could
 * have been wrong on every single signal and the track record would have looked
 * identical. An estimate nobody scores is not a forecast, it is decoration.
 *
 * These tests drive a ledger through a known history and assert that the
 * prediction is stored, the outcome is stored beside it, the path between them
 * is kept, and the comparison says the right thing -- including saying NOTHING
 * when there is too little history to speak.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const ledger = require("../api/_lib/signal-record");

console.log("Starting signal calibration test suite...");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-calib-"));
const db = new SqliteTradingDatabase(path.join(dir, "calib.db"));

const HOUR = 3_600_000;
let clock = Date.parse("2026-09-21T04:00:00.000Z");

function issue(index, { touchPct, estDays, entry = 100, target = 150 }) {
  const result = ledger.record({
    symbol: `TEST${index}`, strike: 1000 + index, right: "CE", expiry: "2026-12-29",
    entryPrice: entry, lotSize: 100, priceSource: "EXCHANGE_SETTLED_PRICE", executable: true,
    targetPrice: target, stopPrice: entry / 2,
    estimatedTouchPct: touchPct, estimatedDaysToTarget: estDays
  }, { db, now: clock });
  assert.ok(result.ok && result.status === "RECORDED", `signal ${index} was not recorded: ${result.reason}`);
  return result.id;
}

function markAll(priceFor, hoursLater) {
  clock += hoursLater * HOUR;
  return ledger.markToMarket(
    (position) => {
      const price = priceFor(position.symbol);
      return price > 0 ? { price, source: "BROKER_REALTIME" } : null;
    },
    { db, now: clock }
  );
}

// --- 1. The prediction is stored at the moment it is made --------------------
{
  const id = issue(0, { touchPct: 70, estDays: 2 });
  const row = db.db.prepare("SELECT * FROM signals_lifecycle WHERE id = ?").get(id);
  assert.equal(row.estimated_touch_pct, 70, "the predicted probability was not stored");
  assert.equal(row.estimated_days_to_target, 2, "the predicted time to target was not stored");
  assert.equal(row.max_price_seen, 100, "the high-water mark should start at the entry");
  console.log("  ✓ The prediction is written into the ledger with the signal, not afterwards");
}

// --- 2. The path is kept, not only the outcome ------------------------------
{
  markAll(() => 110, 3);      // up a bit
  markAll(() => 143, 3);      // nearly there, then
  markAll(() => 105, 3);      // back down -- a near miss that must not vanish
  const marks = ledger.markHistory("", { db });   // all rows for the one signal below
  const all = db.db.prepare("SELECT * FROM signal_marks ORDER BY recorded_at").all();
  assert.equal(all.length, 3, `expected 3 marks on the path, found ${all.length}`);
  assert.ok(all.every((m) => m.price_source === "BROKER_REALTIME"), "every mark must carry its provenance");
  const peak = Math.max(...all.map((m) => m.price));
  assert.equal(peak, 143, "the path must remember the high it actually reached");
  const row = db.db.prepare("SELECT * FROM signals_lifecycle").get();
  assert.equal(row.max_price_seen, 143, "the high-water mark must survive the pullback");
  assert.equal(row.marks_taken, 3, "every mark must be counted");
  assert.ok(Array.isArray(marks), "markHistory must return rows");
  console.log("  ✓ The whole path is kept: a signal that reached 86% of target and fell back still says so");
}

// --- 3. Too little history must produce silence, not a number ---------------
{
  const early = ledger.calibration({ db, minimumSample: 10 });
  assert.equal(early.hasEnoughHistory, false, "one open signal must not produce a calibration verdict");
  assert.equal(early.settled, 0);
  assert.ok(/anecdote/i.test(early.note), "the refusal should explain itself");
  console.log("  ✓ With no closed history it refuses to grade itself rather than printing a hit rate");
}

// --- 4. An OPTIMISTIC estimator is caught -----------------------------------
{
  // Twelve signals, each claiming an 80% chance. Only three will actually hit.
  const ids = [];
  for (let i = 1; i <= 12; i += 1) ids.push(issue(i, { touchPct: 80, estDays: 2 }));
  const winners = new Set(["TEST1", "TEST2", "TEST3"]);
  // 155 clears the 150 target; 40 breaches the 50 stop. Anything between the
  // two would leave the signal OPEN, which is a different outcome entirely.
  markAll((sym) => (winners.has(sym) ? 155 : 40), 48);

  const report = ledger.calibration({ db, minimumSample: 10 });
  assert.equal(report.hasEnoughHistory, true, "twelve closed signals is enough to grade");
  // Thirteen closed signals now, not twelve: the very first one, issued at 70%,
  // stopped out on this mark too. So the mean prediction is (70 + 12x80)/13.
  assert.ok(Math.abs(report.predictedHitPct - 79.23) < 0.1,
    `mean predicted rate should be 79.23 across the thirteen closed signals, got ${report.predictedHitPct}`);
  assert.ok(report.actualHitPct < 40, `only 3 of 12 hit; actual should be near 25, got ${report.actualHitPct}`);
  assert.equal(report.verdict, "ESTIMATE_IS_OPTIMISTIC",
    `an estimator promising 80% and delivering ${report.actualHitPct}% must be called optimistic, got ${report.verdict}`);
  assert.ok(report.calibrationGapPct < -30, "the gap must be reported as a signed number, not hidden");
  console.log(`  ✓ An optimistic estimator is caught: promised ${report.predictedHitPct}%, delivered `
    + `${report.actualHitPct}% -> ${report.verdict} (gap ${report.calibrationGapPct})`);

  const band = report.buckets.find((b) => b.predictedBand === "80-100%");
  assert.ok(band && band.signals >= 12, `the 80-100% bucket should hold these signals, has ${band && band.signals}`);
  assert.ok(band.actualPct < band.predictedPct, "the bucket must show predicted against actual");
  console.log(`  ✓ By band: predicted ${band.predictedPct}% across ${band.signals} signals, actual ${band.actualPct}%`);
}

// --- 5. Timing is measured against what was promised ------------------------
{
  const report = ledger.calibration({ db, minimumSample: 10 });
  assert.ok(report.timing.measured >= 3, "the winners should have measurable timing");
  assert.equal(report.timing.medianEstimatedDays, 2, "the estimate was two days");
  assert.ok(report.timing.medianActualDays >= 1.9 && report.timing.medianActualDays <= 2.6,
    `it actually took about 2 days, reported ${report.timing.medianActualDays}`);
  assert.ok(report.timing.medianActualOverEstimated > 0,
    "the ratio of actual to estimated time must be reported");
  console.log(`  ✓ Timing graded: predicted ${report.timing.medianEstimatedDays}d, actual `
    + `${report.timing.medianActualDays}d, ratio ${report.timing.medianActualOverEstimated}`);

  assert.ok(report.nearMisses.measured > 0, "the misses must be measured too");
  assert.ok(report.nearMisses.medianFractionOfTargetReached !== null,
    "how far the losers travelled toward target must be reported");
  console.log(`  ✓ Near misses graded: ${report.nearMisses.measured} losers reached a median `
    + `${(report.nearMisses.medianFractionOfTargetReached * 100).toFixed(0)}% of their target`);
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log("ALL signal calibration tests passed: predictions are stored with the signal, the whole price path is kept, an optimistic estimator is caught and named, and with too little history it refuses to grade itself.");
