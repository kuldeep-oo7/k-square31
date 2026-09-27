"use strict";

/**
 * WOULD THIS NUMBER STILL BE THE SAME IN AN HOUR?
 *
 * That question was never asked. Every audit on this desk asked "is this
 * computed correctly", and `entryPrice = spot * 0.992` passes that test
 * perfectly while being useless as a limit order -- because spot moves every
 * tick and the limit moved with it.
 *
 * Observed on one session, same symbol, same signal:
 *
 *     09:19   spot 161.75   "BUY AT" 160.46
 *     11:08   spot 161.20   "BUY AT" 159.91
 *     16:26   spot 161.59   "BUY AT" 160.30
 *
 * Three different limit prices. A trader placing the 09:19 limit and checking
 * back at 11:08 would find the desk had quietly rewritten the trade. The levels
 * a person is asked to act on must be decided once and then held, and that is
 * what these tests enforce.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const levels = require("../api/_lib/session-levels");

console.log("Starting session level test suite...");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-levels-"));
const db = new SqliteTradingDatabase(path.join(dir, "levels.db"));

const DAY = "2026-09-22";
const at = (hhmm) => Date.parse(`${DAY}T${hhmm}:00+05:30`);

// --- 1. The levels do not move when the market does -------------------------
{
  // The exact session that exposed this, replayed.
  const open = levels.anchoredLevels({
    symbol: "ASHOKLEY", anchorPrice: 161.75, sessionDate: DAY, db, now: at("09:19")
  });
  assert.ok(open.entryPrice > 0 && open.target1 > open.entryPrice && open.stopLoss < open.entryPrice,
    "the first sight of a symbol must produce a complete, correctly ordered set of levels");
  const first = { ...open };

  for (const [time, spot] of [["11:08", 161.20], ["13:45", 158.10], ["15:02", 166.90], ["16:26", 161.59]]) {
    const again = levels.anchoredLevels({
      symbol: "ASHOKLEY", anchorPrice: spot, sessionDate: DAY, db, now: at(time)
    });
    assert.equal(again.entryPrice, first.entryPrice,
      `at ${time} with spot ${spot} the entry moved from ${first.entryPrice} to ${again.entryPrice}`);
    assert.equal(again.target1, first.target1, `target moved at ${time}`);
    assert.equal(again.target2, first.target2, `runner target moved at ${time}`);
    assert.equal(again.stopLoss, first.stopLoss, `stop moved at ${time}`);
    assert.equal(again.anchorPrice, first.anchorPrice, `the anchor itself moved at ${time}`);
  }
  console.log(`  ✓ Spot ran 158.10 to 166.90 across the session and the limit stayed at ${first.entryPrice} `
    + `with a stop at ${first.stopLoss} -- decided once at 09:19 and held`);

  // Drift is REPORTED, because a limit 3% away is worth knowing about even
  // though it is not wrong.
  const drifted = levels.anchoredLevels({
    symbol: "ASHOKLEY", anchorPrice: 166.90, sessionDate: DAY, db, now: at("15:02")
  });
  assert.ok(drifted.driftFromAnchorPct > 3,
    `the market was 3.2% above the anchor and drift reported ${drifted.driftFromAnchorPct}%`);
  console.log(`  ✓ And it reports how far the market has travelled since (${drifted.driftFromAnchorPct}%), `
    + "so a limit that will not fill says so rather than looking stale");
}

// --- 2. Every level is auditable ---------------------------------------------
{
  const row = db.db.prepare("SELECT * FROM session_levels WHERE symbol = 'ASHOKLEY'").get();
  assert.ok(row.anchor_price > 0, "the anchor must be stored, not just the levels derived from it");
  assert.ok(row.anchor_source, "and where the anchor came from");
  assert.ok(row.issued_at, "and when the decision was taken");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM session_levels WHERE symbol = 'ASHOKLEY'").get().n, 1,
    "five calls in one session must leave ONE row, not five"
  );
  console.log(`  ✓ One row per symbol per session, carrying its anchor (${row.anchor_price} from `
    + `${row.anchor_source}) and the moment it was decided`);
}

// --- 3. A new session gets new levels ----------------------------------------
{
  const tomorrow = levels.anchoredLevels({
    symbol: "ASHOKLEY", anchorPrice: 170.00, sessionDate: "2026-09-23", db, now: at("09:20")
  });
  const today = levels.anchoredLevels({
    symbol: "ASHOKLEY", anchorPrice: 161.75, sessionDate: DAY, db, now: at("09:20")
  });
  assert.notEqual(tomorrow.entryPrice, today.entryPrice,
    "freezing must be per SESSION -- a level held forever would be worse than one that moves");
  assert.ok(tomorrow.entryPrice > today.entryPrice, "and must follow the new session's anchor");
  console.log(`  ✓ A new session re-anchors (${today.entryPrice} today, ${tomorrow.entryPrice} tomorrow); `
    + "the freeze is for the day, not for ever");
}

// --- 4. Instruments are frozen separately ------------------------------------
{
  const fut = levels.anchoredLevels({ symbol: "SBIN", instrument: "FUTURES", anchorPrice: 994.30, sessionDate: DAY, db });
  const opt = levels.anchoredLevels({ symbol: "SBIN", instrument: "OPTION", anchorPrice: 12.50, sessionDate: DAY, db });
  assert.notEqual(fut.entryPrice, opt.entryPrice,
    "a future and an option on the same name are different instruments and cannot share a level");
  console.log("  ✓ A future and an option on the same symbol hold separate levels");
}

// --- 5. It refuses rather than inventing -------------------------------------
{
  assert.equal(levels.anchoredLevels({ symbol: "", anchorPrice: 100, db }), null);
  assert.equal(levels.anchoredLevels({ symbol: "TEST", anchorPrice: 0, db }), null);
  assert.equal(levels.anchoredLevels({ symbol: "TEST", anchorPrice: null, db }), null);
  console.log("  ✓ With no symbol or no price it returns null instead of a level built on nothing");
}

// --- 6. The session boundary is IST, not the host's timezone -----------------
{
  // 23:00 UTC is already the next morning in India. A desk that used the host's
  // date would freeze a fresh set of levels in the middle of a session.
  const lateUtc = Date.parse("2026-09-22T23:00:00Z");
  assert.equal(levels.sessionDateFor(lateUtc), "2026-09-23",
    "the trading date must be IST, or a UTC host silently splits one session into two");
  assert.equal(levels.sessionDateFor(Date.parse("2026-09-22T03:00:00Z")), "2026-09-22");
  console.log("  ✓ The session date is the IST trading date, whatever timezone the host runs in");
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log("ALL session level tests passed: a level is decided once at the first price of the session and "
  + "held there whatever the market does, the anchor it came from is stored so it can be audited, drift is "
  + "reported rather than hidden, and the freeze resets on the next trading day.");

// ON THE EXCHANGE'S TICK (2026-09-27): a price off the tick is an order the
// broker rejects. Ticks per contract come from Angel One's master (48 of 48
// agreed with NSE's own quote data).
{
  const assert = require("node:assert");
  const { toTick } = require("../api/_lib/session-levels");
  assert.strictEqual(toTick(38.17, 0.05), 38.15, "an option target rounds to the nearest 0.05");
  assert.strictEqual(toTick(391.39, 0.05, "down"), 391.35, "a buy limit rounds DOWN -- never above the price worked out");
  assert.strictEqual(toTick(11286.98, 1, "down"), 11286, "BAJAJ-AUTO futures move in whole rupees");
  assert.strictEqual(toTick(6998.43, 0.5, "down"), 6998, "a 0.50 tick");
  assert.strictEqual(toTick(3872.67, 0.1, "down"), 3872.6, "LT futures move in 0.10");
  assert.strictEqual(toTick(112.387, 0.01, "down"), 112.38, "a 0.01 tick");
  assert.strictEqual(toTick(36.45, 0.05, "down"), 36.45, "a price already on the tick is left alone (no float drift)");
  assert.strictEqual(toTick(0.3, 0.1, "down"), 0.3, "0.3 / 0.1 is 2.9999... in floating point; still 0.3");
  assert.strictEqual(toTick(null, 0.05), null, "no price, no level");
  console.log("tick rounding: 9 cases passed");
}
