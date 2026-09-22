"use strict";

/**
 * WHERE IMPLIED VOLATILITY SITS IN ITS OWN HISTORY.
 *
 * The desk has always asked one volatility question: is implied above or below
 * what the stock has actually been doing? That is the variance risk premium and
 * it is a good question. It is not the question every options trader in the
 * world screens on first, which is: is this name's implied volatility HIGH OR
 * LOW FOR THIS NAME?
 *
 * 25% is meaningless on its own. On a stock that has ranged 15% to 60% it is
 * cheap; on one that sat at 18% all quarter it is dear. The two are ranked
 * identically by anything that only compares implied against realised.
 *
 * TWO MEASURES, and they disagree in the way that matters:
 *
 *   IV RANK        where today sits between the LOWEST and HIGHEST of the
 *                  window. One violent spike drags the top up and pins every
 *                  subsequent day near zero.
 *   IV PERCENTILE  what FRACTION of days were below today. Immune to a single
 *                  spike, and the better of the two when the history is messy.
 *
 * When they disagree, the disagreement is itself the finding: a low rank with a
 * high percentile means one outlier is distorting the range.
 *
 * THIS CANNOT BE COMPUTED FROM DATA NOBODY KEPT. There is no back-history in
 * this system, so the keeping starts now and the rank is refused until there is
 * enough of it. Ranking today against three days would be worse than saying
 * nothing, because it produces a number that looks like the real thing.
 */

const MINIMUM_SESSIONS = 30;      // below this a rank is noise wearing a percent sign
const IDEAL_SESSIONS = 252;       // a trading year, which is what the convention means

function database(db) {
  if (db) return db;
  const { SqliteTradingDatabase, DB_PATH } = require("./db-sqlite");
  if (!database._shared) database._shared = new SqliteTradingDatabase(DB_PATH);
  return database._shared;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/**
 * Write one session's volatility surface for one underlying.
 *
 * Idempotent by (symbol, session_date): running the recorder twenty times in a
 * session stores one row, and re-running it after the close updates that row
 * rather than stacking duplicates that would then corrupt every percentile.
 */
function recordSnapshot({ symbol, sessionDate, atmIvPct, frontExpiry = null, termSlopePct = null, skewPoints = null, underlyingPrice = null }, { db = null, now = Date.now() } = {}) {
  const handle = database(db);
  const name = String(symbol || "").toUpperCase();
  const day = String(sessionDate || "").slice(0, 10);
  const iv = Number(atmIvPct);
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, reason: "INCOMPLETE_KEY" };
  if (!(iv > 1 && iv < 300)) return { ok: false, reason: "IMPLAUSIBLE_IV" };

  handle.db.prepare(`
    INSERT INTO iv_history (symbol, session_date, atm_iv_pct, front_expiry, term_slope_pct, skew_points, underlying_price, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, session_date) DO UPDATE SET
      atm_iv_pct = excluded.atm_iv_pct,
      front_expiry = excluded.front_expiry,
      term_slope_pct = excluded.term_slope_pct,
      skew_points = excluded.skew_points,
      underlying_price = excluded.underlying_price,
      recorded_at = excluded.recorded_at
  `).run(name, day, round2(iv), frontExpiry, round2(termSlopePct), round2(skewPoints), round2(underlyingPrice), new Date(now).toISOString());
  return { ok: true, symbol: name, sessionDate: day };
}

/**
 * IV rank and IV percentile for one underlying, or an honest refusal.
 *
 * `todayIvPct` may be supplied so the rank can be computed intraday against a
 * live reading without writing it; otherwise the most recent stored session is
 * used.
 */
function ivRank(symbol, { db = null, todayIvPct = null, windowSessions = IDEAL_SESSIONS, minimumSessions = MINIMUM_SESSIONS } = {}) {
  const handle = database(db);
  const name = String(symbol || "").toUpperCase();
  const rows = handle.db.prepare(
    "SELECT session_date, atm_iv_pct FROM iv_history WHERE symbol = ? ORDER BY session_date DESC LIMIT ?"
  ).all(name, Math.max(minimumSessions, windowSessions));

  const history = rows.map((r) => Number(r.atm_iv_pct)).filter((v) => v > 0);
  const current = Number.isFinite(Number(todayIvPct)) ? Number(todayIvPct) : history[0];

  if (!(current > 0) || history.length < minimumSessions) {
    return {
      available: false,
      reason: "INSUFFICIENT_HISTORY",
      sessionsStored: history.length,
      sessionsNeeded: minimumSessions,
      currentIvPct: current > 0 ? round2(current) : null,
      note: `${history.length} of the ${minimumSessions} sessions needed. Ranking today against `
        + `${history.length} days would produce a number that looks like the real thing and is not. `
        + `The history starts accumulating from the first session this ran.`
    };
  }

  const low = Math.min(...history);
  const high = Math.max(...history);
  const span = high - low;
  const rank = span > 0 ? (100 * (current - low)) / span : 50;
  const below = history.filter((v) => v < current).length;
  const percentile = (100 * below) / history.length;

  // Rank and percentile disagreeing IS the finding: one violent spike in the
  // window drags `high` up and pins every later day near a low rank, while the
  // percentile -- which counts days rather than measuring distance -- is
  // unmoved. When they part company, trust the percentile and say why.
  const divergence = Math.abs(rank - percentile);

  return {
    available: true,
    symbol: name,
    currentIvPct: round2(current),
    ivRank: round2(Math.max(0, Math.min(100, rank))),
    ivPercentile: round2(percentile),
    lowIvPct: round2(low),
    highIvPct: round2(high),
    sessionsStored: history.length,
    windowFrom: rows[rows.length - 1]?.session_date || null,
    divergence: round2(divergence),
    distorted: divergence > 25,
    reading: rank >= 50 && percentile >= 50
      ? "EXPENSIVE_FOR_THIS_NAME"
      : rank <= 30 && percentile <= 30
        ? "CHEAP_FOR_THIS_NAME"
        : "MIDDLING_FOR_THIS_NAME",
    meaning: divergence > 25
      ? `Rank ${round2(rank)} and percentile ${round2(percentile)} disagree sharply, which means one spike `
        + `in the window is stretching the range. The percentile is the one to read.`
      : rank >= 50
        ? "Implied volatility is in the upper half of where this name has traded. You are paying up for movement."
        : "Implied volatility is in the lower half of where this name has traded. Movement is on sale, "
          + "which is the side a buyer wants -- though cheap can stay cheap.",
    maturity: history.length >= IDEAL_SESSIONS ? "FULL_YEAR" : "PARTIAL_WINDOW"
  };
}

const REMOTE_PATH = "k2/iv-history.json";

/**
 * THE HISTORY MUST OUTLIVE THE DISK, or it can never reach thirty sessions.
 *
 * Render wipes the container's disk on every deploy. The signal ledger was
 * already mirrored to a durable archive for exactly that reason -- and this
 * table was not, so every single deploy reset the implied-volatility history to
 * zero. Thirty sessions were unreachable: the code would have counted to two or
 * three, been wiped, and started again, for as long as anyone kept deploying.
 * Measured on the live host this morning: 216 rows written locally, 0 rows on
 * Render.
 *
 * A feature that resets whenever the code changes is not a slow feature. It is
 * a broken one, and it would have looked like patience.
 */
async function syncHistoryToRemote({ db = null } = {}) {
  const google = require("./google-store");
  if (!google.googleStoreConfigured()) return { ok: false, reason: "GOOGLE_STORE_NOT_CONFIGURED" };
  const handle = database(db);
  try {
    const rows = handle.db.prepare(
      "SELECT symbol, session_date, atm_iv_pct, front_expiry, term_slope_pct, skew_points, underlying_price, recorded_at FROM iv_history"
    ).all();
    const remote = await google.readGoogleDocument(REMOTE_PATH, null);

    // Union by (symbol, session). A past session is a fact and is never
    // rewritten by a later run; only genuinely new sessions are added.
    const merged = new Map();
    for (const row of (remote?.data?.rows || [])) merged.set(`${row.symbol}|${row.session_date}`, row);
    for (const row of rows) {
      const key = `${row.symbol}|${row.session_date}`;
      if (!merged.has(key)) merged.set(key, row);
    }
    const out = [...merged.values()];
    await google.writeGoogleDocument(REMOTE_PATH, { version: 1, rows: out }, remote?.etag);
    return { ok: true, stored: out.length, added: out.length - (remote?.data?.rows || []).length };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/** Pull the history back after a deploy wiped the disk. */
async function restoreHistoryFromRemote({ db = null } = {}) {
  const google = require("./google-store");
  if (!google.googleStoreConfigured()) return { ok: false, reason: "GOOGLE_STORE_NOT_CONFIGURED" };
  const handle = database(db);
  try {
    const remote = await google.readGoogleDocument(REMOTE_PATH, null);
    const rows = remote?.data?.rows || [];
    if (!rows.length) return { ok: true, restored: 0, reason: "ARCHIVE_EMPTY" };
    const insert = handle.db.prepare(`
      INSERT INTO iv_history (symbol, session_date, atm_iv_pct, front_expiry, term_slope_pct, skew_points, underlying_price, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, session_date) DO NOTHING
    `);
    let restored = 0;
    for (const row of rows) {
      if (!row?.symbol || !row?.session_date || !(Number(row.atm_iv_pct) > 0)) continue;
      insert.run(String(row.symbol), String(row.session_date).slice(0, 10), Number(row.atm_iv_pct),
        row.front_expiry || null, row.term_slope_pct ?? null, row.skew_points ?? null,
        row.underlying_price ?? null, row.recorded_at || new Date().toISOString());
      restored += 1;
    }
    return { ok: true, restored, sessions: new Set(rows.map((r) => r.session_date)).size };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/** How much history exists, so the desk can say when the rank becomes usable. */
function historyDepth({ db = null } = {}) {
  const handle = database(db);
  const row = handle.db.prepare(
    "SELECT COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols, COUNT(DISTINCT session_date) AS sessions, "
    + "MIN(session_date) AS firstDay, MAX(session_date) AS lastDay FROM iv_history"
  ).get();
  return {
    rows: row.rows, symbols: row.symbols, sessions: row.sessions,
    firstSession: row.firstDay, lastSession: row.lastDay,
    sessionsNeeded: MINIMUM_SESSIONS,
    usable: row.sessions >= MINIMUM_SESSIONS,
    note: row.sessions >= MINIMUM_SESSIONS
      ? `${row.sessions} sessions stored; IV rank is live.`
      : `${row.sessions} of ${MINIMUM_SESSIONS} sessions. IV rank turns on automatically once there are enough.`
  };
}

module.exports = {
  recordSnapshot, ivRank, historyDepth,
  syncHistoryToRemote, restoreHistoryFromRemote, REMOTE_PATH,
  MINIMUM_SESSIONS, IDEAL_SESSIONS
};
