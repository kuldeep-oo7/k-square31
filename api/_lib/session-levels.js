"use strict";

/**
 * A LEVEL IS DECIDED ONCE, AND THEN IT IS A FACT.
 *
 * The desk computed its entry as `spot * 0.992` on every single render. Spot
 * moves every tick, so the "BUY AT" moved with it. On one session ASHOKLEY was
 * shown at 160.46 at 09:19, 159.91 at 11:08 and 160.30 at 16:26 -- three
 * different limit prices, for the same signal, on the same day.
 *
 * Each one of those numbers was arithmetically correct. That is exactly why it
 * survived every audit: the question asked was always "is this computed
 * correctly", never "would this still be the same in an hour". A limit that
 * chases the market is not a plan. It cannot be placed with any confidence, it
 * quietly rewrites the trade you thought you were in every time you look, and
 * it makes the recorded entry and the displayed entry disagree.
 *
 * So the levels are frozen the first time a symbol is seen in a session and
 * read back unchanged thereafter. The anchor they were derived from, and where
 * that anchor came from, are stored beside them -- because a number nobody can
 * audit is the thing this project keeps removing.
 */

const ENTRY_DISCOUNT = 0.992;   // a limit 0.8% under the anchor
const TARGET_1 = 1.025;
const TARGET_2 = 1.050;
const STOP = 0.985;

function database(db) {
  if (db) return db;
  const { SqliteTradingDatabase, DB_PATH } = require("./db-sqlite");
  if (!database._shared) database._shared = new SqliteTradingDatabase(DB_PATH);
  return database._shared;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** The IST trading date, which is what a "session" means here. */
function sessionDateFor(now = Date.now()) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The frozen levels for one instrument, creating them on first sight.
 *
 * `anchorPrice` is only consulted the FIRST time a symbol is seen in a session.
 * Afterwards the stored row wins, whatever the market has done since -- which is
 * the whole point.
 */
function anchoredLevels({
  symbol, instrument = "FUTURES", anchorPrice, anchorSource = "FIRST_OBSERVED_PRICE",
  sessionDate = null, db = null, now = Date.now()
} = {}) {
  const name = String(symbol || "").toUpperCase();
  const day = sessionDate || sessionDateFor(now);
  const price = Number(anchorPrice);
  if (!name || !(price > 0)) return null;

  const handle = database(db);
  const existing = handle.db.prepare(
    "SELECT * FROM session_levels WHERE symbol = ? AND session_date = ? AND instrument = ?"
  ).get(name, day, instrument);

  if (existing) {
    return {
      symbol: name, sessionDate: day, instrument,
      entryPrice: existing.entry_price,
      target1: existing.target1,
      target2: existing.target2,
      stopLoss: existing.stop_loss,
      anchorPrice: existing.anchor_price,
      anchorSource: existing.anchor_source,
      issuedAt: existing.issued_at,
      frozen: true,
      // How far the market has travelled from where this was decided. A limit
      // that is now 4% away is not wrong, but it is worth knowing before
      // waiting all day for a fill that is not coming.
      driftFromAnchorPct: round2((100 * (price - existing.anchor_price)) / existing.anchor_price)
    };
  }

  const entryPrice = round2(price * ENTRY_DISCOUNT);
  const levels = {
    entryPrice,
    target1: round2(entryPrice * TARGET_1),
    target2: round2(entryPrice * TARGET_2),
    stopLoss: round2(entryPrice * STOP)
  };
  const issuedAt = new Date(now).toISOString();
  handle.db.prepare(`
    INSERT INTO session_levels (symbol, session_date, instrument, anchor_price, anchor_source,
      entry_price, target1, target2, stop_loss, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, session_date, instrument) DO NOTHING
  `).run(name, day, instrument, round2(price), String(anchorSource),
    levels.entryPrice, levels.target1, levels.target2, levels.stopLoss, issuedAt);

  return {
    symbol: name, sessionDate: day, instrument,
    ...levels,
    anchorPrice: round2(price), anchorSource: String(anchorSource),
    issuedAt, frozen: true, driftFromAnchorPct: 0
  };
}

/** Everything frozen for a session, for auditing what the desk actually said. */
function levelsForSession({ sessionDate = null, db = null, now = Date.now() } = {}) {
  const handle = database(db);
  return handle.db.prepare(
    "SELECT * FROM session_levels WHERE session_date = ? ORDER BY symbol"
  ).all(sessionDate || sessionDateFor(now));
}

/**
 * A price on the exchange's grid. "down" for a BUY limit -- never above the
 * price worked out; "nearest" for a target or a stop. A price off the tick is
 * an order the broker rejects: on 25 Sep 89 of 193 option targets (e.g.
 * JINDALSTEL OCT 1180 CE sell 38.17) and 45 of 52 futures buys were off it.
 */
function toTick(price, tick, mode = "nearest") {
  const p = Number(price), t = Number(tick);
  if (!(p > 0) || !(t > 0)) return p > 0 ? Math.round(p * 100) / 100 : null;
  const steps = mode === "down" ? Math.floor(p / t + 1e-9) : mode === "up" ? Math.ceil(p / t - 1e-9) : Math.round(p / t);
  return Math.round(steps * t * 100) / 100;
}

module.exports = {
  toTick, anchoredLevels, levelsForSession, sessionDateFor, ENTRY_DISCOUNT, TARGET_1, TARGET_2, STOP };
