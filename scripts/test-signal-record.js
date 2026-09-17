"use strict";

/**
 * The paper-trading ledger.
 *
 * This system once shipped a 71.4% win rate and Rs 51,492.50 of profit that
 * were written by a seed function and never traded, and two test suites
 * asserted the fiction rather than catching it. Separately, the desk's headline
 * tile showed +Rs 51,770.75 of "Purchased Trades MTM" that was the sum of
 * hypothetical gains across recommendations nobody had bought.
 *
 * So these tests are not about whether the arithmetic adds up. They are about
 * whether the specific ways this repository has previously invented a track
 * record are now impossible.
 */

const assert = require("node:assert/strict");
const record = require("../api/_lib/signal-record");

const NOW = Date.parse("2026-09-22T05:00:00Z"); // 10:30 IST, a Tuesday
const base = {
  symbol: "MOTHERSON", strike: 162.5, right: "CE", expiry: "2026-09-29",
  entryPrice: 3.10, lotSize: 6150, priceSource: "LIVE_BROKER_QUOTE",
  executable: true, targetPrice: 4.65, stopPrice: 1.55
};

const fresh = () => record.emptyStore();

// --- 1. A signal is recorded once, and its entry price is immutable ----------
{
  const store = fresh();
  const first = record.record(base, { now: NOW, store });
  assert.equal(first.ok, true);
  assert.equal(first.status, "RECORDED");

  // The same contract on the same day is the same signal. Re-recording must not
  // create a second position and inflate the count.
  const again = record.record(base, { now: NOW, store });
  assert.equal(again.status, "ALREADY_RECORDED");
  assert.equal(again.id, first.id);
  assert.equal(Object.keys(store.positions).length, 1, "one signal, one position");

  // And a later, more flattering price must not overwrite what was shown.
  record.record({ ...base, entryPrice: 1.00 }, { now: NOW, store });
  assert.equal(store.positions[first.id].entryPrice, 3.10,
    "the entry price must be the price that was actually displayed, forever");
  console.log("  ✓ One signal per contract per day, with an immutable entry price");
}

// --- 2. Back-dating is refused ----------------------------------------------
// Every fabricated track record in history was built by writing yesterday's
// winners into today's ledger.
{
  const store = fresh();
  const backdated = record.record({ ...base, issuedAt: "2026-09-01T05:00:00Z" }, { now: NOW, store });
  assert.equal(backdated.ok, false);
  assert.equal(backdated.reason, "BACKDATED_OR_FUTURE_SIGNAL_REFUSED");
  assert.equal(Object.keys(store.positions).length, 0, "a back-dated signal must not land");

  const future = record.record({ ...base, issuedAt: "2026-12-01T05:00:00Z" }, { now: NOW, store });
  assert.equal(future.ok, false, "a future-dated signal is refused for the same reason");
  assert.ok(store.rejected >= 2, "refusals are counted, not silently dropped");
  console.log("  ✓ Back-dated and future-dated signals are refused and counted");
}

// --- 3. A price with no provenance cannot open a position -------------------
{
  const store = fresh();
  const noSource = record.record({ ...base, priceSource: null }, { now: NOW, store });
  assert.equal(noSource.ok, false);
  assert.equal(noSource.reason, "NO_PRICE_PROVENANCE");
  console.log("  ✓ A price with no provenance cannot open a position");
}

// --- 4. Marks and closes use observed prices only ---------------------------
{
  const store = fresh();
  const { id } = record.record(base, { now: NOW, store });

  // Nothing observable yet: the position stays open and unmarked rather than
  // being marked flat, because "no price" and "no change" are different facts.
  const nothing = record.markToMarket(() => null, { now: NOW + 60_000, store });
  assert.equal(nothing.marked, 0);
  assert.equal(store.positions[id].status, "OPEN");
  assert.equal(store.positions[id].lastMark, null);

  // A mark that moves but reaches nothing leaves it open.
  record.markToMarket(() => ({ price: 3.80, source: "BROKER_REALTIME" }), { now: NOW + 120_000, store });
  assert.equal(store.positions[id].status, "OPEN");
  assert.equal(store.positions[id].lastMark, 3.80);

  // Target reached: closed, with the P&L computed from both observed prices.
  record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 180_000, store });
  const closed = store.positions[id];
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closeReason, "TARGET_HIT");
  assert.equal(closed.closePriceSource, "BROKER_REALTIME", "a close must carry the provenance of its price");
  assert.equal(closed.pnlRupees, Math.round((4.70 - 3.10) * 6150));
  console.log("  ✓ Positions mark and close only against observed prices, and carry their provenance");
}

// --- 5. Stop and expiry close too, in the right direction -------------------
{
  const store = fresh();
  const { id } = record.record(base, { now: NOW, store });
  record.markToMarket(() => ({ price: 1.50, source: "EXCHANGE_SETTLED_PRICE" }), { now: NOW + 60_000, store });
  assert.equal(store.positions[id].closeReason, "STOP_HIT");
  assert.ok(store.positions[id].pnlRupees < 0, "a stop is a loss");

  const store2 = fresh();
  const second = record.record(base, { now: NOW, store: store2 });
  // Past expiry, at a price between stop and target: it closes because time ran
  // out, not because a level was reached.
  const afterExpiry = Date.parse("2026-09-30T05:00:00Z");
  record.markToMarket(() => ({ price: 3.00, source: "EXCHANGE_SETTLED_PRICE" }), { now: afterExpiry, store: store2 });
  assert.equal(store2.positions[second.id].closeReason, "EXPIRED");
  console.log("  ✓ Stop and expiry close the position, each for its own stated reason");
}

// --- 6. The track record counts only closed positions ------------------------
// Counting an unrealised mark as a win is the oldest way to make a losing book
// look profitable.
{
  const store = fresh();
  const empty = record.trackRecord({ store });
  assert.equal(empty.available, false);
  assert.equal(empty.reason, "NO_SIGNALS_RECORDED_YET");
  // A win rate of 0% and "nothing has closed" are different facts and must not
  // render as the same number.
  assert.equal(empty.winRatePct, null, "an absent win rate is null, never zero");
  assert.equal(empty.totalPnlRupees, null);

  record.record(base, { now: NOW, store });
  const openOnly = record.trackRecord({ store });
  assert.equal(openOnly.available, false);
  assert.equal(openOnly.reason, "NO_POSITIONS_CLOSED_YET");
  assert.equal(openOnly.open, 1);
  assert.equal(openOnly.winRatePct, null, "an open position is not yet a win");

  record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 60_000, store });
  const done = record.trackRecord({ store });
  assert.equal(done.available, true);
  assert.equal(done.closed, 1);
  assert.equal(done.wins, 1);
  assert.equal(done.winRatePct, 100);
  // No losses yet, so the profit factor has no denominator. That is an
  // unanswerable question, not a very large number.
  assert.equal(done.profitFactor, null);
  assert.ok(done.profitFactorNote.includes("no losing trades"));
  assert.equal(done.basis, "OBSERVED_PRICES_ONLY");
  console.log("  ✓ The track record counts closed positions only, and reports absence as absence");
}

// --- 7. Running these tests must not write into the live ledger -------------
// This is not hypothetical. An earlier version of this file DID pollute it:
// save() persisted whatever store it was handed, so the fixtures above landed
// in .private and the desk proudly reported one closed trade, a 100% win rate
// and Rs 9,840 of profit that no one had traded. That is precisely the seeded
// track record this whole module exists to make impossible, arriving through
// the back door of its own test suite.
{
  const fs = require("node:fs");
  const before = fs.existsSync(record.STORE_FILE) ? fs.readFileSync(record.STORE_FILE, "utf8") : null;

  const scratch = fresh();
  record.record(base, { now: NOW, store: scratch });
  record.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 60_000, store: scratch });
  assert.equal(Object.keys(scratch.positions).length, 1, "the scratch store still works normally");

  const after = fs.existsSync(record.STORE_FILE) ? fs.readFileSync(record.STORE_FILE, "utf8") : null;
  assert.equal(after, before, "a store passed in by a caller must never be written to disk");
  console.log("  ✓ A caller-supplied store is never persisted, so tests cannot seed the live ledger");
}

// --- 8. The durable mirror must never lose a closed trade -------------------
// Two containers can both hold the ledger, and a deploy wipes the local disk.
// The merge is union-by-id with local winning, EXCEPT that a close is a fact:
// an open snapshot must never undo one, or a real closed trade vanishes.
{
  const remote = { positions: { a: { id: "a", status: "CLOSED", pnlRupees: 4200 } }, rejected: 3 };
  const local = { positions: { a: { id: "a", status: "OPEN" }, b: { id: "b", status: "OPEN" } }, rejected: 1 };
  const merged = record.mergeStores(remote, local);

  assert.equal(merged.positions.a.status, "CLOSED", "a closed position must not be reopened by a stale snapshot");
  assert.equal(merged.positions.a.pnlRupees, 4200, "and it keeps its realised result");
  assert.ok(merged.positions.b, "positions seen only locally survive the merge");
  assert.equal(Object.keys(merged.positions).length, 2, "the merge is a union, not a replacement");
  assert.equal(merged.rejected, 3, "refusal counts take the larger of the two");

  // An empty remote (first ever sync) must not wipe the local ledger.
  const fromNothing = record.mergeStores(null, local);
  assert.equal(Object.keys(fromNothing.positions).length, 2);
  console.log("  ✓ The durable merge is a union that never reopens a closed trade or drops a local one");
}

console.log("Signal-record tests passed: immutable entries, refused back-dating, provenance required, observed-price marks and closes, and a win rate that counts only what actually closed");
