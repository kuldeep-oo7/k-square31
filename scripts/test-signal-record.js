"use strict";

/**
 * The paper-trading ledger, in the database.
 *
 * This system once shipped a 71.4% win rate and Rs 51,492.50 of profit written
 * by a seed function and never traded, and two test suites asserted the fiction
 * rather than catching it. Separately the desk's headline tile showed
 * +Rs 51,770.75 of "Purchased Trades MTM" that was the sum of hypothetical
 * gains across recommendations nobody had bought.
 *
 * So these tests are not about whether the arithmetic adds up. They are about
 * whether the specific ways this repository has previously invented a track
 * record are now impossible.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const record = require("../api/_lib/signal-record");
const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");

const NOW = Date.parse("2026-09-22T05:00:00Z"); // 10:30 IST, a Tuesday
const base = {
  symbol: "MOTHERSON", strike: 162.5, right: "CE", expiry: "2026-09-29",
  entryPrice: 3.10, lotSize: 6150, priceSource: "LIVE_BROKER_QUOTE",
  executable: true, targetPrice: 4.65, stopPrice: 1.55
};

// Each block gets a throwaway database. The live ledger is never opened here:
// an earlier version of this suite wrote its fixtures into the real store, and
// the desk then reported one closed trade at a 100% win rate worth Rs 9,840
// that nobody had traded.
const temps = [];
function fresh() {
  const file = path.join(os.tmpdir(), `k2-test-${process.pid}-${temps.length}.db`);
  temps.push(file);
  return new SqliteTradingDatabase(file);
}
function cleanup() {
  for (const file of temps) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(file + suffix, { force: true }); } catch (error) { /* leftovers are not failures */ }
    }
  }
}
const rowOf = (db, id) => db.db.prepare("SELECT * FROM signals_lifecycle WHERE id = ?").get(id);
const countOf = (db) => db.db.prepare("SELECT COUNT(*) AS n FROM signals_lifecycle").get().n;

try {
  // --- 1. Recorded once, with an entry price that never moves ---------------
  {
    const db = fresh();
    const first = record.record(base, { now: NOW, db });
    assert.equal(first.ok, true);
    assert.equal(first.status, "RECORDED");

    // The same contract on the same day is the same signal. Re-recording must
    // not create a second row and inflate the count.
    const again = record.record(base, { now: NOW, db });
    assert.equal(again.status, "ALREADY_RECORDED");
    assert.equal(again.id, first.id);
    assert.equal(countOf(db), 1, "one signal, one row");

    // A later, more flattering price must never replace what was displayed.
    record.record({ ...base, entryPrice: 1.00 }, { now: NOW, db });
    assert.equal(rowOf(db, first.id).entry_price, 3.10,
      "the entry price must stay the price that was actually shown");
    assert.equal(rowOf(db, first.id).entry_price_source, "LIVE_BROKER_QUOTE",
      "and it must carry where that price came from");
    console.log("  ✓ One signal per contract per day, entry price and provenance immutable");
  }

  // --- 2. Back-dating is refused --------------------------------------------
  {
    const db = fresh();
    const backdated = record.record({ ...base, issuedAt: "2026-09-01T05:00:00Z" }, { now: NOW, db });
    assert.equal(backdated.ok, false);
    assert.equal(backdated.reason, "BACKDATED_OR_FUTURE_SIGNAL_REFUSED");
    assert.equal(countOf(db), 0, "a back-dated signal must not land");

    const future = record.record({ ...base, issuedAt: "2026-12-01T05:00:00Z" }, { now: NOW, db });
    assert.equal(future.ok, false, "a future-dated signal is refused for the same reason");
    assert.equal(countOf(db), 0);

    // The refusal is recorded rather than silently dropped.
    const audits = db.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'SIGNAL_BACKDATE_REFUSED'")
      .get().n;
    assert.ok(audits >= 2, "refusals are written to the audit log");
    console.log("  ✓ Back-dated and future-dated signals are refused and audited");
  }

  // --- 3. A price with no provenance cannot open a position ------------------
  {
    const db = fresh();
    const noSource = record.record({ ...base, priceSource: null }, { now: NOW, db });
    assert.equal(noSource.ok, false);
    assert.equal(noSource.reason, "NO_PRICE_PROVENANCE");
    assert.equal(countOf(db), 0);
    console.log("  ✓ A price with no provenance cannot open a position");
  }

  // --- 4. Marks and closes use observed prices only --------------------------
  {
    const db = fresh();
    const { id } = record.record(base, { now: NOW, db });

    // Nothing observable: the row stays open and unmarked. Marking it flat
    // would report "no change" when the truth is that nothing was seen.
    const nothing = record.markToMarket(() => null, { now: NOW + 60_000, db });
    assert.equal(nothing.marked, 0);
    assert.equal(rowOf(db, id).status, "ACTIVE");
    assert.equal(rowOf(db, id).current_price, 3.10, "an unmarked row keeps its entry as its mark");

    // A mark that moves but reaches nothing leaves it open.
    record.markToMarket(() => ({ price: 3.80, source: "BROKER_REALTIME" }), { now: NOW + 120_000, db });
    assert.equal(rowOf(db, id).status, "ACTIVE");
    assert.equal(rowOf(db, id).current_price, 3.80);
    assert.equal(rowOf(db, id).entry_price, 3.10, "marking must never disturb the entry price");

    // Target reached: closed, P&L from both observed prices.
    record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 180_000, db });
    const closed = rowOf(db, id);
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.exit_reason, "TARGET_HIT");
    assert.equal(closed.exit_price_source, "BROKER_REALTIME", "a close carries the provenance of its price");
    assert.equal(closed.pnl_rupees, Math.round((4.70 - 3.10) * 6150));
    console.log("  ✓ Positions mark and close only against observed prices, each carrying its source");
  }

  // --- 5. Stop and expiry close too, each for its own reason ------------------
  {
    const db = fresh();
    const { id } = record.record(base, { now: NOW, db });
    record.markToMarket(() => ({ price: 1.50, source: "EXCHANGE_SETTLED_PRICE" }), { now: NOW + 60_000, db });
    assert.equal(rowOf(db, id).exit_reason, "STOP_HIT");
    assert.ok(rowOf(db, id).pnl_rupees < 0, "a stop is a loss");

    const db2 = fresh();
    const second = record.record(base, { now: NOW, db: db2 });
    // Past expiry at a price between stop and target: it closes because time
    // ran out, not because a level was reached.
    const afterExpiry = Date.parse("2026-09-30T05:00:00Z");
    record.markToMarket(() => ({ price: 3.00, source: "EXCHANGE_SETTLED_PRICE" }), { now: afterExpiry, db: db2 });
    assert.equal(rowOf(db2, second.id).exit_reason, "EXPIRED");
    console.log("  ✓ Stop and expiry close the position, each for its own stated reason");
  }

  // --- 6. The track record counts only what actually closed ------------------
  {
    const db = fresh();
    const empty = record.trackRecord({ db });
    assert.equal(empty.available, false);
    assert.equal(empty.reason, "NO_SIGNALS_RECORDED_YET");
    // A win rate of 0% and "nothing has closed" are different facts and must
    // not render as the same number.
    assert.equal(empty.winRatePct, null, "an absent win rate is null, never zero");
    assert.equal(empty.totalPnlRupees, null);

    record.record(base, { now: NOW, db });
    const openOnly = record.trackRecord({ db });
    assert.equal(openOnly.available, false);
    assert.equal(openOnly.reason, "NO_POSITIONS_CLOSED_YET");
    assert.equal(openOnly.open, 1);
    assert.equal(openOnly.winRatePct, null, "an open position is not yet a win");

    record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 60_000, db });
    const done = record.trackRecord({ db });
    assert.equal(done.available, true);
    assert.equal(done.closed, 1);
    assert.equal(done.wins, 1);
    assert.equal(done.winRatePct, 100);
    // No losses, so the profit factor has no denominator. That is an
    // unanswerable question, not a very large number.
    assert.equal(done.profitFactor, null);
    assert.ok(done.profitFactorNote.includes("no losing trades"));
    assert.equal(done.basis, "OBSERVED_PRICES_ONLY");

    const view = record.accuracyView({ db });
    assert.equal(view.source, "SIGNALS_LIFECYCLE_TABLE", "the scorecard reads the database, not a side file");
    assert.equal(view.archived[0].entry_source, "LIVE_BROKER_QUOTE");
    console.log("  ✓ The track record counts closed positions only, and reports absence as absence");
  }

  // --- 7. Running the suite must not touch the live ledger -------------------
  // Not hypothetical: an earlier version of this file DID pollute it.
  {
    const live = path.resolve(__dirname, "..", ".private", "k2-trading.db");
    const before = fs.existsSync(live) ? fs.statSync(live).mtimeMs : null;
    const db = fresh();
    record.record(base, { now: NOW, db });
    record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 60_000, db });
    const after = fs.existsSync(live) ? fs.statSync(live).mtimeMs : null;
    assert.equal(after, before, "the live database must be untouched by these tests");
    console.log("  ✓ A caller-supplied database means the suite cannot seed the live ledger");
  }

  // --- 8. The durable backup never loses a closed trade ----------------------
  {
    const remote = [{ id: "a", status: "CLOSED", pnl_rupees: 4200 }];
    const local = [{ id: "a", status: "ACTIVE" }, { id: "b", status: "ACTIVE" }];
    const merged = record.mergeRows(remote, local);
    const byId = Object.fromEntries(merged.map((r) => [r.id, r]));

    assert.equal(byId.a.status, "CLOSED", "a closed row must not be reopened by a stale snapshot");
    assert.equal(byId.a.pnl_rupees, 4200, "and it keeps its realised result");
    assert.ok(byId.b, "rows seen only locally survive");
    assert.equal(merged.length, 2, "the merge is a union, not a replacement");
    assert.equal(record.mergeRows([], local).length, 2, "an empty backup cannot wipe the ledger");
    console.log("  ✓ The durable backup merges as a union and never reopens a closed trade");
  }

  console.log("Signal-record tests passed: database-backed, immutable entries with provenance, refused back-dating, observed-price marks and closes, and a win rate counting only what closed");
} finally {
  cleanup();
}
