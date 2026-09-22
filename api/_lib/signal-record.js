"use strict";

/**
 * What the signals ACTUALLY earned -- stored in the database, with the rest.
 *
 * Every other number on this desk is a forecast, a price or a probability.
 * This is the only one that is a RESULT: if you had bought what the card said,
 * at the price it showed, and sold where it told you to, what happened?
 *
 * This lived briefly in its own JSON file while the schema for it already
 * existed in SQLite. That was wrong. A second store means two answers to the
 * same question and eventually they disagree, so the ledger is the
 * `signals_lifecycle` table, alongside positions, trades and audit events, in
 * one file under one set of guarantees.
 *
 * WHY IT IS BUILT THIS WAY. This system once shipped a 71.4% win rate and
 * Rs 51,492.50 of profit written by a seed function and never traded, and two
 * test suites asserted the fiction. The design exists to make that impossible:
 *
 *   - Entry price is written ONCE. The update path touches the mark, the P&L
 *     and the clock -- entry_price never appears in a SET clause.
 *   - Every price carries its provenance. A row whose entry came from a live
 *     broker book must not look identical to one that came from a model.
 *   - Back-dating is refused, because every fabricated record is built by
 *     writing yesterday's winners into today's ledger.
 *   - A position closes only against an OBSERVED price.
 *   - The win rate counts closed positions only. An unrealised mark is not a
 *     win, and counting it as one is the oldest trick there is.
 *
 * The result may be unflattering. The out-of-sample test failed at t = 1.25
 * against a 1.6648 hurdle and P(profit) across these cards has a median of 35%.
 * An honest record of a strategy that does not work is worth more than a
 * flattering one that was never traded.
 */

const REMOTE_PATH = "k2/signal-record.json";

// A signal issued more than this far from now is a back-date and is refused.
const MAX_BACKDATE_MS = 10 * 60 * 1000;

const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

let sharedDb = null;

/**
 * The last thing the backup actually DID, on this host.
 *
 * "Configured" and "working" are different facts. A URL and a secret being
 * present says nothing about whether this container can reach Google -- a
 * blocked egress, a revoked deployment or a mistyped secret all look identical
 * from the outside, and every one of them means the ledger is not really
 * durable. So the outcome of each attempt is kept and reported, and the desk
 * says "verified" only once a call has succeeded from HERE.
 */
let lastBackup = { attemptedAt: null, ok: null, detail: "No backup attempted yet on this host." };

function backupStatus() {
  return { ...lastBackup };
}

let lastRestore = { attemptedAt: null, ok: null, detail: "No restore attempted yet on this host." };
function noteRestore(ok, detail) {
  lastRestore = { attemptedAt: new Date().toISOString(), ok, detail };
}
function restoreStatus() { return { ...lastRestore }; }

function noteBackup(ok, detail) {
  lastBackup = { attemptedAt: new Date().toISOString(), ok, detail };
  return lastBackup;
}

/** The one database. Callers may pass their own, which is how tests stay clean. */
function database(db) {
  if (db) return db;
  if (!sharedDb) {
    const { SqliteTradingDatabase } = require("./db-sqlite");
    sharedDb = new SqliteTradingDatabase();
  }
  return sharedDb;
}

/** One signal per contract per day, so the same card seen twice is one row. */
function signalId({ symbol, strike, right, expiry, day }) {
  return require("node:crypto").createHash("sha1")
    .update([symbol, strike, right, expiry, day].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Record a signal at the price it was shown at.
 *
 * Returns what happened, so a caller can never mistake "already recorded" for
 * "recorded again" and count one signal twice.
 */
function record(signal, { now = Date.now(), db = null } = {}) {
  const handle = database(db);
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

  const issued = signal.issuedAt ? Date.parse(signal.issuedAt) : now;
  if (!Number.isFinite(issued) || Math.abs(now - issued) > MAX_BACKDATE_MS) {
    try { handle.logAuditEvent("SIGNAL_BACKDATE_REFUSED", { symbol, strike, right, issuedAt: signal.issuedAt }); }
    catch (error) { /* the refusal stands whether or not it could be logged */ }
    return { ok: false, reason: "BACKDATED_OR_FUTURE_SIGNAL_REFUSED" };
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const id = signalId({ symbol, strike, right, expiry, day });
  if (handle.db.prepare("SELECT id FROM signals_lifecycle WHERE id = ?").get(id)) {
    return { ok: true, status: "ALREADY_RECORDED", id };
  }

  const iso = new Date(now).toISOString();
  const horizon = Math.max(1, Math.ceil((Date.parse(`${expiry}T15:30:00+05:30`) - now) / 86400000));
  handle.db.prepare(`
    INSERT INTO signals_lifecycle (
      id, symbol, trading_symbol, asset_class, side, option_type, strike, lot_size,
      entry_price, current_price, target1, target2, stop_loss, issued_at, closed_at,
      days_active, horizon_days, status, exit_reason, pnl_points, pnl_pct, pnl_rupees,
      created_at, updated_at, entry_price_source, entry_executable,
      probability_of_profit_pct, volatility_verdict, expiry,
      estimated_touch_pct, estimated_days_to_target, max_price_seen, min_price_seen, marks_taken
    ) VALUES (?, ?, ?, 'OPTION', 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, 'ACTIVE', null, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, symbol, `${symbol}${strike}${right}`, right, strike, lotSize,
    round2(entryPrice), round2(entryPrice),
    num(signal.targetPrice) ?? 0, num(signal.targetPrice) ?? 0, num(signal.stopPrice) ?? 0,
    iso, horizon, iso, iso,
    String(signal.priceSource), signal.executable === true ? 1 : 0,
    num(signal.probabilityOfProfitPct), signal.volatilityVerdict || null, expiry,
    // THE PREDICTION, stored at the moment it was made. Without these two the
    // desk can say "70.5% chance, usually about 1.2 days" forever and never once
    // be held to it.
    num(signal.estimatedTouchPct), num(signal.estimatedDaysToTarget),
    round2(entryPrice), round2(entryPrice)
  );
  return { ok: true, status: "RECORDED", id };
}

/**
 * Mark open positions against observed prices, closing those that reached a
 * level or ran out of time.
 *
 * `quoteFor(position)` must return { price, source } from a real book or an
 * exchange price, or null. A modelled number here would put a fabricated result
 * into the one place on this desk meant to hold only outcomes.
 */
function markToMarket(quoteFor, { now = Date.now(), db = null } = {}) {
  const handle = database(db);
  const open = handle.db.prepare("SELECT * FROM signals_lifecycle WHERE status = 'ACTIVE'").all();
  let marked = 0, closed = 0;

  for (const row of open) {
    const quote = typeof quoteFor === "function"
      ? quoteFor({ symbol: row.symbol, strike: row.strike, right: row.option_type, expiry: row.expiry })
      : null;
    const price = num(quote?.price);
    // No observable price means no mark. Marking it flat would report "no
    // change" as a finding when the truth is that nothing was seen.
    if (!(price > 0)) continue;

    const pnlPoints = round2(price - row.entry_price);
    const iso = new Date(now).toISOString();
    const daysActive = round2(Math.max(0, now - Date.parse(row.issued_at)) / 86400000);

    // HOW FAR IT ACTUALLY GOT. A position that reached 96% of its target and
    // fell back is a completely different result from one that never moved, and
    // the old ledger recorded them identically -- both simply "ACTIVE".
    const high = Math.max(num(row.max_price_seen) ?? row.entry_price, price);
    const low = Math.min(num(row.min_price_seen) ?? row.entry_price, price);
    const newHigh = high > (num(row.max_price_seen) ?? row.entry_price);

    // Only the mark and its consequences move. entry_price is never in this SET.
    handle.db.prepare(`
      UPDATE signals_lifecycle
      SET current_price = ?, days_active = ?, pnl_points = ?, pnl_pct = ?, pnl_rupees = ?, updated_at = ?,
          max_price_seen = ?, min_price_seen = ?, max_price_seen_at = ?, marks_taken = marks_taken + 1
      WHERE id = ?
    `).run(
      round2(price), daysActive, pnlPoints,
      round2((pnlPoints / row.entry_price) * 100),
      Math.round(pnlPoints * row.lot_size), iso,
      round2(high), round2(low), newHigh ? iso : (row.max_price_seen_at || iso), row.id
    );

    // THE WHOLE PATH, not just where it ended up. Every mark is kept so the
    // estimate can be scored later against what actually happened hour by hour,
    // rather than only as a hit or a miss.
    try {
      const span = row.target1 > row.entry_price ? row.target1 - row.entry_price : null;
      handle.db.prepare(`
        INSERT INTO signal_marks (
          signal_id, symbol, price, price_source, pnl_points, pnl_pct,
          fraction_of_target, hours_since_issue, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.symbol, round2(price), String(quote.source || "UNKNOWN"),
        pnlPoints, round2((pnlPoints / row.entry_price) * 100),
        span ? round2(pnlPoints / span, 4) : null,
        round2(Math.max(0, now - Date.parse(row.issued_at)) / 3_600_000),
        iso
      );
    } catch (error) {
      // The mark itself already landed. Losing the path entry is a loss of
      // detail, never a reason to drop the position update.
    }
    marked += 1;

    const expired = row.expiry ? Date.parse(`${row.expiry}T15:30:00+05:30`) <= now : false;
    let reason = null;
    if (row.target1 > 0 && price >= row.target1) reason = "TARGET_HIT";
    else if (row.stop_loss > 0 && price <= row.stop_loss) reason = "STOP_HIT";
    else if (expired) reason = "EXPIRED";

    if (reason) {
      // HOW LONG IT ACTUALLY TOOK, against how long we said it would. Hours, not
      // days, because most of these targets are reached inside a single session
      // and a day count would round the whole answer away.
      const hours = round2(Math.max(0, now - Date.parse(row.issued_at)) / 3_600_000);
      handle.db.prepare(`
        UPDATE signals_lifecycle
        SET status = 'CLOSED', closed_at = ?, exit_reason = ?, exit_price_source = ?, updated_at = ?,
            target_hit_at = ?, hours_to_target = ?, stop_hit_at = ?, hours_to_stop = ?
        WHERE id = ?
      `).run(
        iso, reason, quote.source || null, iso,
        reason === "TARGET_HIT" ? iso : null,
        reason === "TARGET_HIT" ? hours : null,
        reason === "STOP_HIT" ? iso : null,
        reason === "STOP_HIT" ? hours : null,
        row.id
      );
      closed += 1;
    }
  }
  return { marked, closed };
}

/**
 * The track record, from closed positions only.
 *
 * Absence is reported as absence: nulls rather than zeros. A win rate of 0% and
 * "nothing has closed yet" are different facts and must not render alike.
 */
/**
 * WAS THE ESTIMATE ANY GOOD?
 *
 * The desk tells you a target is 70.5% likely and usually reached in about 1.2
 * days. Until now nothing recorded whether it was, so the estimate could have
 * been wrong every single time and the track record would have looked the same.
 *
 * This compares what was PREDICTED at the moment of the signal against what the
 * market actually did. Two questions, and they are different:
 *
 *   CALIBRATION   of everything we called 70% likely, did roughly 70% happen?
 *                 An estimator can be well calibrated and still useless, but one
 *                 that is badly calibrated is worse than none -- it is a number
 *                 that sounds like knowledge.
 *   TIMING        when it did happen, did it take as long as we said?
 *                 A target that arrives in a fifth of the predicted time is
 *                 being reached by noise, not by the move we described.
 *
 * Nothing here is reported until there is enough closed history to mean
 * anything. A hit rate over three trades is an anecdote with a percent sign.
 */
/**
 * WHERE EVERY NUMBER IS STORED, counted rather than described.
 *
 * "Trust me, it is being recorded" is worth nothing. This reports the actual
 * row counts in the actual tables, the file they live in, and whether the
 * durable archive has ever succeeded from this host -- so the claim can be
 * checked instead of believed.
 */
function storageReport({ db = null } = {}) {
  const handle = database(db);
  const count = (table) => {
    try { return handle.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
    catch (error) { return null; }
  };
  const first = (table, column) => {
    try { return handle.db.prepare(`SELECT MIN(${column}) AS v FROM ${table}`).get().v; }
    catch (error) { return null; }
  };
  const backup = backupStatus();
  const google = require("./google-store");
  return {
    ok: true,
    databaseFile: handle.file || handle.dbPath || require("./db-sqlite").DB_PATH || null,
    tables: {
      signals_lifecycle: { rows: count("signals_lifecycle"), holds: "One row per contract the desk showed: entry, target, stop, the predicted probability and predicted days, and how it ended." },
      signal_marks: { rows: count("signal_marks"), holds: "One row per observation on an open signal: the price, where the price came from, and how far toward target it had travelled." },
      trades: { rows: count("trades"), holds: "Closed executions with realised profit and loss." },
      audit_events: { rows: count("audit_events"), holds: "Every refusal and every guard that fired, with its reason." },
      ticks_history: { rows: count("ticks_history"), holds: "Underlying prices with the technical read attached at that moment." },
      macro_snapshots: { rows: count("macro_snapshots"), holds: "India VIX and the macro gate, session by session." },
      iv_history: {
        rows: count("iv_history"),
        holds: "One implied-volatility surface per name per session -- at-the-money IV, term structure slope "
          + "and skew. This cannot be back-filled, so IV rank only becomes possible from the day the keeping "
          + "started. It turns on by itself once there are thirty sessions."
      }
    },
    oldestSignal: first("signals_lifecycle", "issued_at"),
    volatilityHistory: (() => {
      try { return require("./iv-rank").historyDepth({ db: handle }); }
      catch (error) { return null; }
    })(),
    oldestMark: first("signal_marks", "recorded_at"),
    durableArchive: {
      configured: google.googleStoreConfigured(),
      // WRITE and READ are reported separately and the write is the one that
      // matters. A restore proves the archive is reachable; only a write proves
      // anything recorded today will still exist after the next deploy.
      lastAttemptAt: backup?.attemptedAt || null,
      lastResult: backup?.ok === null ? "NEVER_ATTEMPTED" : (backup?.ok ? "OK" : "FAILED"),
      detail: backup?.detail || null,
      read: (() => {
        const r = restoreStatus();
        return {
          lastAttemptAt: r.attemptedAt,
          lastResult: r.ok === null ? "NEVER_ATTEMPTED" : (r.ok ? "OK" : "FAILED"),
          detail: r.detail
        };
      })(),
      why: "Render wipes the disk on every deploy, so the SQLite file above is temporary. "
        + "The archive is the copy that survives, and it is mirrored every five minutes and again on shutdown."
    },
    howToSee: [
      "Settings & Track Record -- the calibration panel and the audited ledger of closed signals.",
      "Closed Ledger -- every realised trade with entry, exit and profit.",
      "/api/state -- the whole payload this page is drawn from, as JSON."
    ]
  };
}

/** Every observation ever taken on one signal, oldest first. */
function markHistory(signalId, { db = null, limit = 500 } = {}) {
  const handle = database(db);
  return handle.db.prepare(
    "SELECT * FROM signal_marks WHERE signal_id = ? ORDER BY recorded_at ASC LIMIT ?"
  ).all(String(signalId), limit);
}

function calibration({ db = null, minimumSample = 10 } = {}) {
  const handle = database(db);
  const rows = handle.db.prepare(
    "SELECT * FROM signals_lifecycle WHERE estimated_touch_pct IS NOT NULL"
  ).all();
  const settled = rows.filter((r) => r.status === "CLOSED");

  if (settled.length < minimumSample) {
    return {
      ok: true,
      hasEnoughHistory: false,
      settled: settled.length,
      open: rows.length - settled.length,
      minimumSample,
      note: `${settled.length} of the ${minimumSample} closed signals needed before an estimate can be judged. `
        + "A hit rate over a handful of trades is an anecdote with a percent sign on it."
    };
  }

  // Calibration by decile of predicted probability. Buckets with nothing in them
  // are reported as empty rather than silently dropped, because a missing bucket
  // and a bucket that failed look identical once they are gone.
  const buckets = [];
  for (let low = 0; low < 100; low += 20) {
    const inBand = settled.filter((r) => r.estimated_touch_pct >= low && r.estimated_touch_pct < low + 20);
    const hit = inBand.filter((r) => r.exit_reason === "TARGET_HIT").length;
    buckets.push({
      predictedBand: `${low}-${low + 20}%`,
      signals: inBand.length,
      predictedPct: inBand.length
        ? round2(inBand.reduce((sum, r) => sum + r.estimated_touch_pct, 0) / inBand.length)
        : null,
      actualPct: inBand.length ? round2((100 * hit) / inBand.length) : null,
      hit
    });
  }

  const hits = settled.filter((r) => r.exit_reason === "TARGET_HIT");
  const timed = hits.filter((r) => r.hours_to_target > 0 && r.estimated_days_to_target > 0);
  const ratios = timed.map((r) => (r.hours_to_target / 24) / r.estimated_days_to_target).sort((a, b) => a - b);

  const meanPredicted = round2(settled.reduce((sum, r) => sum + r.estimated_touch_pct, 0) / settled.length);
  const actualHitPct = round2((100 * hits.length) / settled.length);

  // How close did the ones that MISSED actually get? A book that repeatedly
  // reaches 95% of its target is telling you the target is slightly too far,
  // which is a fixable problem. One that never gets past 40% is telling you
  // something else entirely.
  const missed = settled.filter((r) => r.exit_reason !== "TARGET_HIT" && r.target1 > 0 && r.max_price_seen > 0);
  const reach = missed.map((r) => (r.max_price_seen - r.entry_price) / (r.target1 - r.entry_price))
    .filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

  return {
    ok: true,
    hasEnoughHistory: true,
    settled: settled.length,
    open: rows.length - settled.length,
    predictedHitPct: meanPredicted,
    actualHitPct,
    calibrationGapPct: round2(actualHitPct - meanPredicted),
    verdict: Math.abs(actualHitPct - meanPredicted) <= 10
      ? "ESTIMATE_TRACKS_REALITY"
      : actualHitPct < meanPredicted ? "ESTIMATE_IS_OPTIMISTIC" : "ESTIMATE_IS_PESSIMISTIC",
    buckets,
    timing: {
      measured: timed.length,
      medianEstimatedDays: timed.length
        ? round2(timed.map((r) => r.estimated_days_to_target).sort((a, b) => a - b)[Math.floor(timed.length / 2)])
        : null,
      medianActualDays: timed.length
        ? round2(timed.map((r) => r.hours_to_target / 24).sort((a, b) => a - b)[Math.floor(timed.length / 2)])
        : null,
      medianActualOverEstimated: ratios.length ? round2(ratios[Math.floor(ratios.length / 2)]) : null,
      note: "Above 1.0 means it took longer than predicted; below means it arrived sooner."
    },
    nearMisses: {
      measured: reach.length,
      medianFractionOfTargetReached: reach.length ? round2(reach[Math.floor(reach.length / 2)]) : null,
      reachedOver90Pct: reach.filter((v) => v >= 0.9).length,
      note: "Of the signals that did NOT hit, how far toward the target they actually travelled."
    }
  };
}

function trackRecord({ db = null } = {}) {
  const handle = database(db);
  const rows = handle.db.prepare("SELECT * FROM signals_lifecycle").all();
  const closed = rows.filter((r) => r.status === "CLOSED");
  const open = rows.filter((r) => r.status === "ACTIVE");

  if (!closed.length) {
    return {
      available: false,
      reason: rows.length ? "NO_POSITIONS_CLOSED_YET" : "NO_SIGNALS_RECORDED_YET",
      recorded: rows.length, open: open.length, closed: 0,
      winRatePct: null, totalPnlRupees: null
    };
  }

  const wins = closed.filter((r) => r.pnl_rupees > 0);
  const grossWin = wins.reduce((a, r) => a + r.pnl_rupees, 0);
  const grossLoss = Math.abs(closed.filter((r) => r.pnl_rupees < 0).reduce((a, r) => a + r.pnl_rupees, 0));
  const byReason = {};
  for (const r of closed) byReason[r.exit_reason] = (byReason[r.exit_reason] || 0) + 1;

  return {
    available: true,
    recorded: rows.length, open: open.length, closed: closed.length,
    wins: wins.length, losses: closed.length - wins.length,
    winRatePct: round2((wins.length / closed.length) * 100),
    totalPnlRupees: Math.round(closed.reduce((a, r) => a + r.pnl_rupees, 0)),
    averageReturnPct: round2(closed.reduce((a, r) => a + r.pnl_pct, 0) / closed.length),
    // Undefined rather than infinite when nothing lost: a profit factor with no
    // denominator is an unanswerable question, not a very large number.
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    profitFactorNote: grossLoss > 0 ? null : "Undefined: no losing trades yet, so there is no denominator.",
    closedBy: byReason,
    firstSignalAt: rows.reduce((a, r) => (!a || r.issued_at < a ? r.issued_at : a), null),
    basis: "OBSERVED_PRICES_ONLY"
  };
}

/** The ledger in the shape the desk's scorecard already reads. */
function accuracyView({ db = null } = {}) {
  const handle = database(db);
  const summary = trackRecord({ db: handle });
  const closed = handle.db.prepare(
    "SELECT * FROM signals_lifecycle WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 100"
  ).all();
  const days = closed.map((r) => r.days_active).filter((d) => Number.isFinite(d));

  return {
    hasTrackRecord: summary.available,
    totalSignals: summary.closed || 0,
    winCount: summary.wins || 0,
    lossCount: summary.losses || 0,
    winRatePct: summary.winRatePct,
    totalFollowPnl: summary.totalPnlRupees,
    profitFactor: summary.profitFactor,
    avgDaysOnScreen: days.length ? round2(days.reduce((a, b) => a + b, 0) / days.length) : null,
    openPositions: summary.open || 0,
    recordedTotal: summary.recorded || 0,
    source: "SIGNALS_LIFECYCLE_TABLE",
    basis: summary.basis || "OBSERVED_PRICES_ONLY",
    archived: closed.map((r) => ({
      signal_id: r.id,
      trading_symbol: r.trading_symbol,
      instrument_type: r.option_type,
      lot_size: r.lot_size,
      issued_at: r.issued_at,
      entry_price: r.entry_price,
      exit_price: r.current_price,
      status: r.exit_reason,
      pnl_rupees: r.pnl_rupees,
      entry_source: r.entry_price_source,
      exit_source: r.exit_price_source
    }))
  };
}

/**
 * Back the database up off the box.
 *
 * SQLite is the store, but on Render's free tier it sits on a disk wiped by
 * every deploy. A track record that resets whenever the code changes is not a
 * track record, so the signal rows mirror to the Apps Script store and are
 * restored on boot. This backs up the ONE store rather than being a second one:
 * nothing reads from it except the restore path.
 */
async function syncToRemote({ db = null } = {}) {
  const google = require("./google-store");
  if (!google.googleStoreConfigured()) return { ok: false, reason: "GOOGLE_STORE_NOT_CONFIGURED" };
  const handle = database(db);
  try {
    const rows = handle.db.prepare("SELECT * FROM signals_lifecycle").all();
    const remote = await google.readGoogleDocument(REMOTE_PATH, null);
    const merged = mergeRows(remote?.data?.rows || [], rows);
    await google.writeGoogleDocument(REMOTE_PATH, { version: 2, rows: merged }, remote?.etag);
    noteBackup(true, `Wrote ${merged.length} rows to the archive.`);
    return { ok: true, positions: merged.length };
  } catch (error) {
    // A failed backup must never disturb the live ledger -- but it must be
    // visible, or the desk will keep claiming durability it does not have.
    noteBackup(false, `Write failed: ${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/** Restore after a deploy wiped the disk. */
async function restoreFromRemote({ db = null } = {}) {
  const google = require("./google-store");
  if (!google.googleStoreConfigured()) return { ok: false, reason: "GOOGLE_STORE_NOT_CONFIGURED" };
  const handle = database(db);
  try {
    const remote = await google.readGoogleDocument(REMOTE_PATH, null);
    const rows = remote?.data?.rows;
    if (!Array.isArray(rows) || !rows.length) {
      // Reaching the store and finding it empty still proves the link works.
      noteRestore(true, "Reached the archive; nothing stored there yet.");
      return { ok: false, reason: "NOTHING_STORED_REMOTELY" };
    }
    const columns = new Set(handle.db.prepare("PRAGMA table_info(signals_lifecycle)").all().map((c) => c.name));
    let restored = 0;
    for (const row of rows) {
      // Never overwrite a local row: the live database is the authority, and a
      // stale backup must not reopen something that has since closed.
      if (handle.db.prepare("SELECT id FROM signals_lifecycle WHERE id = ?").get(row.id)) continue;
      const names = Object.keys(row).filter((k) => columns.has(k));
      if (!names.length) continue;
      handle.db.prepare(
        `INSERT INTO signals_lifecycle (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
      ).run(...names.map((k) => row[k]));
      restored += 1;
    }
    // A RESTORE IS A READ. It must not set the flag that says the backup works,
    // which is exactly what it was doing: the panel read "ARCHIVE: OK" on a host
    // whose WRITE path had never once been exercised, because the ledger mirror
    // skips while the ledger is empty and the ledger has been empty every time.
    // Durability needs the write to work, and only a write can prove it.
    noteRestore(true, `Restored ${restored} rows from the archive.`);
    return { ok: true, positions: restored };
  } catch (error) {
    noteBackup(false, `Restore failed: ${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * Union by id, local winning. A CLOSED row is never replaced by an open one,
 * whichever side holds it: two containers both writing would otherwise let a
 * later, emptier snapshot erase finished trades.
 */
function mergeRows(remoteRows, localRows) {
  const byId = new Map();
  for (const row of remoteRows || []) byId.set(row.id, row);
  for (const row of localRows || []) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing?.status === "CLOSED" && row.status !== "CLOSED" ? existing : row);
  }
  return [...byId.values()];
}

module.exports = {
  MAX_BACKDATE_MS, REMOTE_PATH,
  accuracyView, backupStatus, restoreStatus, database, markToMarket, mergeRows, record,
  calibration,
  markHistory,
  storageReport,
  restoreFromRemote, signalId, syncToRemote, trackRecord
};
