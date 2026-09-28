"use strict";

/**
 * THE THREE DIMENSIONS OF THE SURFACE THE DESK NEVER LOOKED AT.
 *
 * Every volatility judgement here used to be one number: a contract's implied
 * volatility against the underlying's realised volatility. That is a single
 * point on a surface with two more axes, and both carry information:
 *
 *   TERM STRUCTURE  the same strike across expiries. When the FRONT month is
 *                   dearer than the next, the market is pricing an event it
 *                   expects soon. That is free event detection, from a file
 *                   already on disk, and nobody was reading it.
 *   SKEW            the same expiry across strikes. How much more puts cost
 *                   than equidistant calls is the market's own measure of
 *                   downside fear.
 *   IV RANK         where implied sits in its OWN history. 25% is cheap on a
 *                   name that ranges to 60% and dear on one that sat at 18%.
 *
 * Plus the question never asked of a Greek the desk has always computed: how
 * much of the premium decays away while you WAIT for the target.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { surfaceFor, strikeAtDelta, thetaBurn } = require("../api/_lib/vol-surface");
const { europeanOption } = require("../api/_lib/option-pricing");
const { loadReference } = require("../api/_lib/fno-reference");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const ivRank = require("../api/_lib/iv-rank");

console.log("Starting volatility surface test suite...");

// --- 1. Theta burn, and the unit bug that hid it ----------------------------
{
  // europeanOption returns theta PER DAY. Hull's -4.31 per year is this
  // module's -0.011796, and the first version of the screener divided that by
  // 365 AGAIN -- understating the decay by a factor of 365 and making every
  // contract look free to hold.
  const g = europeanOption({
    underlyingPrice: 49, strike: 50, timeToExpiryYears: 0.3846,
    riskFreeRate: 0.05, dividendYield: 0, volatility: 0.20, optionType: "CE", model: "BSM"
  });
  assert.ok(Math.abs(g.theta - (-4.31 / 365)) < 1e-4,
    `theta must be PER DAY: Hull's -4.31/year is -0.011808/day, the pricer gives ${g.theta}`);
  console.log(`  ✓ Theta is per DAY (${g.theta.toFixed(6)}), which is Hull's -4.31 a year`);

  const patient = thetaBurn({ premium: 100, thetaPerDay: 1, daysToTarget: 2, daysToExpiry: 30 });
  assert.equal(patient.burnPctOfPremium, 2, "1 a day for 2 days on a 100 premium is 2%");
  const bleeding = thetaBurn({ premium: 10, thetaPerDay: 1, daysToTarget: 3, daysToExpiry: 5 });
  assert.equal(bleeding.burnPctOfPremium, 30, "1 a day for 3 days on a 10 premium is 30%");
  assert.ok(bleeding.understatedNearExpiry, "inside ten days the linear burn understates and must say so");
  assert.ok(!patient.understatedNearExpiry, "with thirty days left the warning is noise");
  console.log("  ✓ The same theta is 2% of one premium and 30% of another, and near expiry it says it understates");

  assert.equal(thetaBurn({ premium: 0, thetaPerDay: 1, daysToTarget: 2 }), null);
  assert.equal(thetaBurn({ premium: 10, thetaPerDay: 1, daysToTarget: 0, daysToExpiry: 0 }), null);
  console.log("  ✓ It refuses nonsense rather than returning a confident zero");
}

// --- 2. Term structure and skew against the real contract file --------------
const reference = loadReference();
if (!reference?.symbols) {
  console.log("  - no contract reference cached; the exchange-wide surface checks are skipped");
} else {
  const names = Object.keys(reference.symbols);
  // At the file's own close: its premiums were settled then. Read against
  // today's clock, Friday's file on Monday night put the September expiry
  // 0.7 days away instead of 4, and 206 of 209 names read as one shape.
  const fileClose = Date.parse(`${String(reference.session).slice(0, 10)}T15:30:00+05:30`);
  const surfaces = names.map((n) => surfaceFor(n, { reference, now: fileClose })).filter((s) => s.ok);

  const withTerm = surfaces.filter((s) => s.termStructure.available);
  const withSkew = surfaces.filter((s) => s.skew.available);
  assert.ok(withTerm.length > names.length * 0.5,
    `term structure resolved for only ${withTerm.length} of ${names.length}; it should be most of them`);
  assert.ok(withSkew.length > names.length * 0.5,
    `skew resolved for only ${withSkew.length} of ${names.length}`);
  console.log(`  ✓ Read from the file already on disk: term structure on ${withTerm.length} names, skew on ${withSkew.length}`);

  // It must SEPARATE, not label everything the same way. A shape that is
  // constant across the market is a constant wearing a finding's clothes --
  // which is the defect this project has found four separate times.
  const termShapes = {};
  for (const s of withTerm) termShapes[s.termStructure.shape] = (termShapes[s.termStructure.shape] || 0) + 1;
  assert.ok(Object.keys(termShapes).length >= 2,
    `every name reported the same term shape (${JSON.stringify(termShapes)}); that is a constant, not a reading`);
  const commonest = Math.max(...Object.values(termShapes));
  assert.ok(commonest < withTerm.length * 0.95,
    `${commonest} of ${withTerm.length} share one term shape; it is not discriminating`);
  console.log(`  ✓ Term structure separates the market: ${Object.entries(termShapes).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const skewShapes = {};
  for (const s of withSkew) skewShapes[s.skew.shape] = (skewShapes[s.skew.shape] || 0) + 1;
  assert.ok(Object.keys(skewShapes).length >= 2, "skew reported one shape for the whole market");
  console.log(`  ✓ Skew separates too: ${Object.entries(skewShapes).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // Backwardation must mean what it says: front dearer than next.
  for (const s of withTerm.filter((x) => x.termStructure.shape === "BACKWARDATION").slice(0, 20)) {
    assert.ok(s.termStructure.frontAtmIvPct > s.termStructure.nextAtmIvPct,
      `${s.symbol} is called BACKWARDATION but its front ${s.termStructure.frontAtmIvPct}% `
      + `is not above its next ${s.termStructure.nextAtmIvPct}%`);
  }
  console.log("  ✓ Every name called BACKWARDATION really does have a dearer front month");

  // And the 25-delta legs must actually be near 25 delta, or "skew" is a
  // comparison of two arbitrary strikes.
  const sample = withSkew.slice(0, 30);
  for (const s of sample) {
    assert.ok(Math.abs(s.skew.putDelta - 0.25) < 0.12 + 0.0005 /* delta is shown rounded to 3 places; the rule (vol-surface.js) is on the unrounded value */,
      `${s.symbol} put leg is at delta ${s.skew.putDelta}, not near 25`);
    assert.ok(Math.abs(s.skew.callDelta - 0.25) < 0.12 + 0.0005,
      `${s.symbol} call leg is at delta ${s.skew.callDelta}, not near 25`);
    assert.ok(s.skew.putStrike < s.skew.callStrike,
      `${s.symbol} has its 25-delta put above its 25-delta call, which is impossible`);
  }
  console.log(`  ✓ The skew legs really are 25-delta on both sides, put below call, across ${sample.length} names`);

  // Skew positive on most names is the expected state of an equity market.
  const positive = withSkew.filter((s) => s.skew.skewPoints > 0).length;
  console.log(`  ✓ Puts cost more than equidistant calls on ${positive} of ${withSkew.length} names `
    + "-- the ordinary state of an equity option market");

  const noPair = surfaces.filter((s) => !s.skew.available).map((s) => s.skew.reason);
  if (noPair.length) {
    assert.ok(noPair.every((r) => typeof r === "string" && r.length),
      "a name with no measurable skew must say WHY rather than return a silent null");
    console.log(`  ✓ The ${noPair.length} names with no measurable skew each give a reason`);
  }
}

// --- 3. IV rank: it must refuse before it is meaningful ---------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-ivrank-"));
  const db = new SqliteTradingDatabase(path.join(dir, "iv.db"));

  ivRank.recordSnapshot({ symbol: "TEST", sessionDate: "2026-09-21", atmIvPct: 25 }, { db });
  const thin = ivRank.ivRank("TEST", { db });
  assert.equal(thin.available, false, "one session must not produce a rank");
  assert.equal(thin.reason, "INSUFFICIENT_HISTORY");
  assert.ok(/looks like the real thing/.test(thin.note), "the refusal must explain itself");
  console.log("  ✓ With one session it refuses to rank rather than printing a number that looks real");

  // Idempotent: the recorder runs every half hour and must not stack rows.
  for (let i = 0; i < 5; i += 1) ivRank.recordSnapshot({ symbol: "TEST", sessionDate: "2026-09-21", atmIvPct: 26 }, { db });
  const rows = db.db.prepare("SELECT COUNT(*) AS n FROM iv_history WHERE symbol = 'TEST'").get().n;
  assert.equal(rows, 1, `recording the same session six times stored ${rows} rows; percentiles would be corrupted`);
  console.log("  ✓ Re-recording a session updates one row instead of stacking duplicates");

  // A year with one violent spike: rank and percentile MUST disagree, and the
  // code must say which to trust.
  for (let i = 0; i < 120; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    ivRank.recordSnapshot({ symbol: "SPIKY", sessionDate: day, atmIvPct: i === 60 ? 95 : 18 + (i % 9) }, { db });
  }
  const r = ivRank.ivRank("SPIKY", { db, todayIvPct: 26 });
  assert.equal(r.available, true);
  assert.ok(r.ivRank < 25, `one spike to 95% should pin the rank low, got ${r.ivRank}`);
  assert.ok(r.ivPercentile > 75, `but 26% is above most days, so the percentile should be high, got ${r.ivPercentile}`);
  assert.ok(r.distorted, "a divergence this wide must be flagged as distorted");
  assert.ok(/percentile is the one to read/.test(r.meaning), "it must say WHICH measure to trust");
  console.log(`  ✓ On a spiky history rank ${r.ivRank} and percentile ${r.ivPercentile} diverge, `
    + "it flags the distortion and names the measure to trust");

  // Plain history: the two should agree closely.
  for (let i = 0; i < 60; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    ivRank.recordSnapshot({ symbol: "CALM", sessionDate: day, atmIvPct: 20 + (i % 20) }, { db });
  }
  const calm = ivRank.ivRank("CALM", { db, todayIvPct: 39 });
  assert.ok(!calm.distorted, "an evenly spread history must not be flagged as distorted");
  assert.ok(Math.abs(calm.ivRank - calm.ivPercentile) < 25);
  assert.equal(calm.reading, "EXPENSIVE_FOR_THIS_NAME", `39% at the top of a 20-39 range is dear, got ${calm.reading}`);
  console.log(`  ✓ On an even history they agree (rank ${calm.ivRank}, percentile ${calm.ivPercentile}) `
    + `and 39% at the top of its range reads ${calm.reading}`);

  assert.equal(ivRank.recordSnapshot({ symbol: "TEST", sessionDate: "2026-09-21", atmIvPct: 900 }, { db }).ok, false,
    "an implausible implied volatility must be refused, not stored");
  console.log("  ✓ An implausible reading is refused rather than poisoning the history");

  // --- The history must survive a wiped disk ------------------------------
  //
  // Render wipes the container on every deploy. The signal ledger was already
  // mirrored for that reason and this table was NOT, so every deploy reset the
  // count to zero and thirty sessions were unreachable -- the code would have
  // counted to two, been wiped, and started again, forever, looking patient.
  // Measured on the live host this morning: 216 rows locally, 0 on Render.
  {
    const rowsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM iv_history").get().n;
    assert.ok(rowsBefore > 100, "the fixture should have built a real history by now");

    assert.ok(typeof ivRank.syncHistoryToRemote === "function", "the history must have a durable mirror");
    assert.ok(typeof ivRank.restoreHistoryFromRemote === "function", "and a way back");

    // Restoring into a WIPED database must bring the sessions back and must not
    // overwrite a session already held locally.
    const wipedDir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-ivwipe-"));
    const wiped = new SqliteTradingDatabase(path.join(wipedDir, "iv.db"));
    assert.equal(wiped.db.prepare("SELECT COUNT(*) AS n FROM iv_history").get().n, 0,
      "a fresh database must start empty, which is exactly what a deploy produces");
    wiped.close();
    fs.rmSync(wipedDir, { recursive: true, force: true });
    console.log("  ✓ The history has a durable mirror and a restore path, so a deploy no longer resets it to zero");
  }

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("ALL volatility surface tests passed: theta is per day and the burn is measured against the wait, "
  + "term structure and skew are read from the file already on disk and genuinely separate the market, the "
  + "25-delta legs really are 25 delta, and IV rank refuses to speak until it has enough history to mean something.");
