"use strict";

/**
 * What the signals ACTUALLY earned.
 *
 * Every other number on this desk is a forecast, a price, or a probability.
 * This is the only one that is a RESULT: if you had bought what the card said,
 * at the price the card showed, and sold where the card told you to, what would
 * have happened?
 *
 * WHY THIS FILE IS BUILT THE WAY IT IS. A previous version of this system
 * shipped a 71.4% win rate and Rs 51,492.50 of profit that were inserted by a
 * seed function and had never been traded. Two test suites asserted the
 * fiction. So the design here is not about convenience, it is about making that
 * specific failure impossible:
 *
 *   - A signal is recorded ONCE, at the moment it is issued, with the price
 *     observable AT THAT MOMENT. openedAt is stamped from the clock, never
 *     supplied by a caller.
 *   - Entry price is immutable. Re-recording the same signal is a no-op rather
 *     than an update, so a later, better-looking price can never replace the one
 *     that was actually shown.
 *   - A position closes only against an OBSERVED price carrying its provenance.
 *     There is no path that closes a position at a price nobody printed.
 *   - Back-dating is rejected outright. A record whose issue time is not close
 *     to now is refused, because every fabricated track record in history was
 *     built by writing yesterday's winners into today's ledger.
 *   - Nothing here computes a win rate from anything except closed positions
 *     with both prices observed.
 *
 * The result may well be unflattering. The out-of-sample test already failed at
 * t = 1.25 against a 1.6648 hurdle, and P(profit) across the option cards runs
 * a median of 35%. If this ledger comes back negative it is doing its job: an
 * honest record of a strategy that does not work is worth incomparably more
 * than a flattering one that was never traded.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private", "ledger"));
const STORE_FILE = path.join(STORE_DIR, "signal-record.json");

// A record issued more than this far from now is a back-date and is refused.
const MAX_BACKDATE_MS = 10 * 60 * 1000;

const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function emptyStore() {
  return { version: 1, createdAt: new Date().toISOString(), positions: {}, rejected: 0 };
}

function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.positions ? parsed : emptyStore();
  } catch (error) {
    return emptyStore();
  }
}

function save(store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store));
  } catch (error) {
    console.error("Signal record not persisted:", error.message);
  }
  return store;
}

/**
 * One signal per contract per day. Deterministic, so the same card seen twice
 * in a session cannot become two positions and inflate the count.
 */
function signalId({ symbol, strike, right, expiry, day }) {
  return crypto.createHash("sha1")
    .update([symbol, strike, right, expiry, day].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Record a signal at the price it was shown at. Returns what happened, so a
 * caller can never mistake "already recorded" for "recorded again".
 */
function record(signal, { now = Date.now(), store = null, persist = store === null } = {}) {
  // A caller that supplies its own store owns it. Persisting a passed-in store
  // is how a test wrote MOTHERSON at 100% and Rs 9,840 into the live ledger --
  // the seeded-track-record failure, arriving again through the back door.
  store = store || load();
  const commit = (value) => (persist ? save(value) : value);
  const symbol = String(signal?.symbol || "").toUpperCase();
  const right = String(signal?.right || "").toUpperCase();
  const strike = num(signal?.strike);
  const entryPrice = num(signal?.entryPrice);
  const lotSize = num(signal?.lotSize);
  const expiry = String(signal?.expiry || "").slice(0, 10);

  if (!symbol || !["CE", "PE"].includes(right) || !(strike > 0) || !(entryPrice > 0) || !(lotSize > 0) || !expiry) {
    return { ok: false, reason: "INCOMPLETE_SIGNAL" };
  }
  // A price nobody printed cannot open a position.
  if (!signal.priceSource) return { ok: false, reason: "NO_PRICE_PROVENANCE" };

  // Back-dating is how every fabricated record gets built.
  const issued = signal.issuedAt ? Date.parse(signal.issuedAt) : now;
  if (!Number.isFinite(issued) || Math.abs(now - issued) > MAX_BACKDATE_MS) {
    store.rejected = (store.rejected || 0) + 1;
    commit(store);
    return { ok: false, reason: "BACKDATED_OR_FUTURE_SIGNAL_REFUSED" };
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const id = signalId({ symbol, strike, right, expiry, day });
  if (store.positions[id]) return { ok: true, status: "ALREADY_RECORDED", id };

  store.positions[id] = {
    id, symbol, strike, right, expiry,
    // Immutable from here. Nothing in this module rewrites these three.
    entryPrice: round2(entryPrice),
    lotSize,
    openedAt: new Date(now).toISOString(),
    entryPriceSource: signal.priceSource,
    entryExecutable: signal.executable === true,
    targetPrice: num(signal.targetPrice),
    stopPrice: num(signal.stopPrice),
    probabilityOfProfitPct: num(signal.probabilityOfProfitPct),
    volatilityVerdict: signal.volatilityVerdict || null,
    status: "OPEN",
    lastMark: null,
    lastMarkAt: null,
    closedAt: null, closePrice: null, closeReason: null, closePriceSource: null
  };
  commit(store);
  return { ok: true, status: "RECORDED", id };
}

/**
 * Mark open positions against observed prices, and close the ones that reached
 * a level or ran out of time.
 *
 * `quoteFor(position)` must return { price, source } from a real book or an
 * exchange price, or null. Returning a modelled number here would put a
 * fabricated result into the one place on this desk that is supposed to hold
 * only outcomes.
 */
function markToMarket(quoteFor, { now = Date.now(), store = null, persist = store === null } = {}) {
  store = store || load();
  const commit = (value) => (persist ? save(value) : value);
  let marked = 0, closed = 0;
  for (const position of Object.values(store.positions)) {
    if (position.status !== "OPEN") continue;
    const quote = typeof quoteFor === "function" ? quoteFor(position) : null;
    const price = num(quote?.price);
    if (!(price > 0)) continue;

    position.lastMark = round2(price);
    position.lastMarkAt = new Date(now).toISOString();
    position.markSource = quote.source || null;
    marked += 1;

    // Expiry settles at intrinsic value against the underlying, which is the
    // only price that exists once the contract stops trading.
    const expired = Date.parse(`${position.expiry}T15:30:00+05:30`) <= now;
    let reason = null;
    if (position.targetPrice > 0 && price >= position.targetPrice) reason = "TARGET_HIT";
    else if (position.stopPrice > 0 && price <= position.stopPrice) reason = "STOP_HIT";
    else if (expired) reason = "EXPIRED";

    if (reason) {
      position.status = "CLOSED";
      position.closedAt = new Date(now).toISOString();
      position.closePrice = round2(price);
      position.closeReason = reason;
      position.closePriceSource = quote.source || null;
      position.pnlRupees = Math.round((price - position.entryPrice) * position.lotSize);
      position.returnPct = round2(((price - position.entryPrice) / position.entryPrice) * 100);
      closed += 1;
    }
  }
  commit(store);
  return { marked, closed };
}

/**
 * The track record. Computed ONLY from closed positions with both prices
 * observed -- an open position has no result yet, and counting an unrealised
 * mark as a win is the oldest way to make a losing book look profitable.
 */
function trackRecord({ store = null } = {}) {
  store = store || load();
  const all = Object.values(store.positions || {});
  const closed = all.filter((p) => p.status === "CLOSED" && p.closePrice !== null && p.entryPrice > 0);
  const open = all.filter((p) => p.status === "OPEN");

  if (!closed.length) {
    return {
      available: false,
      reason: all.length ? "NO_POSITIONS_CLOSED_YET" : "NO_SIGNALS_RECORDED_YET",
      recorded: all.length,
      open: open.length,
      closed: 0,
      // Stated rather than shown as zero: a win rate of 0% and "no trades yet"
      // are different facts and must not render identically.
      winRatePct: null, totalPnlRupees: null
    };
  }

  const wins = closed.filter((p) => p.pnlRupees > 0);
  const total = closed.reduce((a, p) => a + (p.pnlRupees || 0), 0);
  const returns = closed.map((p) => p.returnPct).filter((r) => Number.isFinite(r));
  const meanReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const grossWin = wins.reduce((a, p) => a + p.pnlRupees, 0);
  const grossLoss = Math.abs(closed.filter((p) => p.pnlRupees < 0).reduce((a, p) => a + p.pnlRupees, 0));

  const byReason = {};
  for (const p of closed) byReason[p.closeReason] = (byReason[p.closeReason] || 0) + 1;

  return {
    available: true,
    recorded: all.length,
    open: open.length,
    closed: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRatePct: round2((wins.length / closed.length) * 100),
    totalPnlRupees: Math.round(total),
    averageReturnPct: meanReturn === null ? null : round2(meanReturn),
    // Undefined rather than infinite when nothing lost: a profit factor with no
    // denominator is not a very large number, it is an unanswerable question.
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    profitFactorNote: grossLoss > 0 ? null : "Undefined: no losing trades yet, so there is no denominator.",
    closedBy: byReason,
    firstSignalAt: all.reduce((a, p) => (!a || p.openedAt < a ? p.openedAt : a), null),
    backdatedRejections: store.rejected || 0,
    basis: "OBSERVED_PRICES_ONLY"
  };
}

/**
 * The ledger in the shape the desk's scorecard already reads.
 *
 * Deliberately returns nulls rather than zeros when nothing has closed. A win
 * rate of 0% and "nothing has closed yet" are different facts, and rendering
 * them identically is how a desk with no history came to advertise 71.4%.
 */
function accuracyView({ store = null } = {}) {
  store = store || load();
  const summary = trackRecord({ store });
  const closed = Object.values(store.positions || {})
    .filter((p) => p.status === "CLOSED" && p.closePrice !== null);

  const days = closed
    .map((p) => (Date.parse(p.closedAt) - Date.parse(p.openedAt)) / 86400000)
    .filter((d) => Number.isFinite(d) && d >= 0);

  return {
    hasTrackRecord: summary.available,
    totalSignals: summary.closed || 0,
    winCount: summary.wins || 0,
    lossCount: summary.losses || 0,
    winRatePct: summary.winRatePct,
    totalFollowPnl: summary.totalPnlRupees,
    profitFactor: summary.profitFactor,
    avgDaysOnScreen: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    openPositions: summary.open || 0,
    recordedTotal: summary.recorded || 0,
    backdatedRejections: summary.backdatedRejections || 0,
    source: "SIGNAL_PAPER_LEDGER",
    basis: summary.basis || "OBSERVED_PRICES_ONLY",
    archived: closed
      .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
      .slice(0, 100)
      .map((p) => ({
        signal_id: p.id,
        trading_symbol: `${p.symbol}${p.strike}${p.right}`,
        instrument_type: p.right,
        lot_size: p.lotSize,
        issued_at: p.openedAt,
        entry_price: p.entryPrice,
        exit_price: p.closePrice,
        status: p.closeReason,
        pnl_rupees: p.pnlRupees,
        entry_source: p.entryPriceSource,
        exit_source: p.closePriceSource
      }))
  };
}

module.exports = {
  accuracyView,
  MAX_BACKDATE_MS, STORE_FILE,
  emptyStore, load, markToMarket, record, save, signalId, trackRecord
};
