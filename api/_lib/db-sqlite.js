"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.resolve(__dirname, "../../.private/k2-trading.db");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class SqliteTradingDatabase {
  constructor(dbPath = DB_PATH) {
    ensureDir(dbPath);
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initTables();
    this.ensureAccountRow();
  }

  initPragmas() {
    // Enable WAL (Write-Ahead Logging) for maximum read/write concurrency and sub-millisecond latency
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  initTables() {
    this.db.exec(`
      -- Account Equity & Aggregate Statistics Table
      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        initial_capital REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        win_count INTEGER NOT NULL DEFAULT 0,
        loss_count INTEGER NOT NULL DEFAULT 0,
        total_trades INTEGER NOT NULL DEFAULT 0,
        win_rate_pct REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Active Monitored Positions Table
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        side TEXT NOT NULL,
        lot_size INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        target1 REAL NOT NULL,
        target2 REAL NOT NULL,
        stop_loss REAL NOT NULL,
        capital_required REAL NOT NULL,
        pnl_rupees REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Immutable Closed Trade Ledger Table
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        type TEXT NOT NULL,
        side TEXT NOT NULL,
        lot_size INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        entry_time TEXT NOT NULL,
        exit_time TEXT NOT NULL,
        realized_pnl REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        exit_reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Global Macro & Volatility Shock Time-Series Archive
      CREATE TABLE IF NOT EXISTS macro_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gift_nifty REAL,
        india_vix REAL,
        brent_crude REAL,
        sp500_futures REAL,
        regime_severity TEXT NOT NULL,
        action_directive TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      -- Tick-by-Tick High-Frequency Analytics Archive
      CREATE TABLE IF NOT EXISTS ticks_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        volume REAL NOT NULL,
        neural_score REAL,
        candlestick_pattern TEXT,
        chart_pattern TEXT,
        recorded_at TEXT NOT NULL
      );

      -- Immutable Forensic Audit Event Trail
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Signals Lifecycle, Provenance & Follow-Trade Performance Archive
      CREATE TABLE IF NOT EXISTS signals_lifecycle (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        side TEXT NOT NULL,
        option_type TEXT,
        strike REAL,
        lot_size INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        target1 REAL NOT NULL,
        target2 REAL NOT NULL,
        stop_loss REAL NOT NULL,
        issued_at TEXT NOT NULL,
        closed_at TEXT,
        days_active REAL NOT NULL DEFAULT 0,
        horizon_days INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL,
        exit_reason TEXT,
        pnl_points REAL NOT NULL DEFAULT 0,
        pnl_pct REAL NOT NULL DEFAULT 0,
        pnl_rupees REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Performance Indices
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time);
      CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks_history(symbol, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_macro_recorded_at ON macro_snapshots(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_signals_status ON signals_lifecycle(status);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals_lifecycle(symbol);
    `);
    this.migrateSignalProvenance();
  }

  /**
   * Adds provenance columns to signals_lifecycle.
   *
   * A price without a source is the defect this desk keeps producing: the row
   * looks identical whether the number came from a live broker book, the
   * exchange's settled close, or a model. A track record cannot be audited
   * unless every entry and exit says where its price came from, so these
   * columns are what make the ledger checkable rather than merely stored.
   *
   * SQLite has no ADD COLUMN IF NOT EXISTS, so the existing columns are read
   * first. This runs on every boot and must stay idempotent.
   */
  migrateSignalProvenance() {
    const existing = new Set(
      this.db.prepare("PRAGMA table_info(signals_lifecycle)").all().map((row) => row.name)
    );
    const columns = [
      ["entry_price_source", "TEXT"],
      ["exit_price_source", "TEXT"],
      ["entry_executable", "INTEGER NOT NULL DEFAULT 0"],
      ["probability_of_profit_pct", "REAL"],
      ["volatility_verdict", "TEXT"],
      ["expiry", "TEXT"]
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE signals_lifecycle ADD COLUMN ${name} ${type};`);
      }
    }
  }

  /**
   * Creates the single account row a fresh install needs, with ZERO history.
   *
   * This method previously inserted an invented track record -- an account at
   * +Rs 29,078.10 across 6 wins and 2 losses, three completed trades, and seven
   * closed signals worth +Rs 51,492.50 at a 71.4% win rate -- under a comment
   * calling them "verified historical baseline trades". None of it was traded.
   * Those rows reached the live deployment and were served from /api/state as
   * the desk's audited performance, which is the most dangerous thing software
   * like this can do: it invites real money on the strength of a result that
   * never happened. An untraded ledger reports nothing, and nothing is the
   * honest answer.
   */
  ensureAccountRow() {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM account WHERE id = 'PRIMARY'").get();
    if (!existing || existing.count === 0) {
      this.db.prepare(`
        INSERT INTO account (id, initial_capital, realized_pnl, unrealized_pnl, win_count, loss_count, total_trades, win_rate_pct, updated_at)
        VALUES ('PRIMARY', ?, 0, 0, 0, 0, 0, 0, ?)
      `).run(Number(process.env.K2_INITIAL_CAPITAL) || 100000, new Date().toISOString());
    }
  }

  getSummary() {
    const row = this.db.prepare("SELECT * FROM account WHERE id = 'PRIMARY'").get();
    // A missing account row means the ledger is not initialised. Reporting a
    // win rate for it would be reporting a number nobody earned.
    if (!row) {
      return {
        initialCapital: Number(process.env.K2_INITIAL_CAPITAL) || 100000,
        realizedPnl: 0,
        unrealizedPnl: 0,
        winCount: 0,
        lossCount: 0,
        totalTrades: 0,
        winRatePct: null,
        hasTrackRecord: false
      };
    }
    return {
      initialCapital: row.initial_capital,
      realizedPnl: row.realized_pnl,
      unrealizedPnl: row.unrealized_pnl,
      winCount: row.win_count,
      lossCount: row.loss_count,
      totalTrades: row.total_trades,
      winRatePct: row.total_trades > 0 ? Math.round((row.win_count / row.total_trades * 100) * 10) / 10 : null,
      hasTrackRecord: row.total_trades > 0
    };
  }

  getActivePositions() {
    const rows = this.db.prepare("SELECT * FROM positions ORDER BY opened_at DESC").all();
    return rows.map(r => ({
      id: r.id,
      candidateId: r.candidate_id,
      symbol: r.symbol,
      tradingSymbol: r.trading_symbol,
      assetClass: r.asset_class,
      side: r.side,
      lotSize: r.lot_size,
      entryPrice: r.entry_price,
      currentPrice: r.current_price,
      target1: r.target1,
      target2: r.target2,
      stopLoss: r.stop_loss,
      capitalRequired: r.capital_required,
      pnlRupees: r.pnl_rupees,
      status: r.status,
      openedAt: r.opened_at,
      updatedAt: r.updated_at
    }));
  }

  getCompletedTrades(limit = 50) {
    const rows = this.db.prepare("SELECT * FROM trades ORDER BY exit_time DESC LIMIT ?").all(limit);
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      tradingSymbol: r.trading_symbol,
      type: r.type,
      side: r.side,
      lotSize: r.lot_size,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      entryTime: r.entry_time,
      exitTime: r.exit_time,
      realizedPnl: r.realized_pnl,
      pnlPct: r.pnl_pct,
      exitReason: r.exit_reason,
      status: r.status,
      createdAt: r.created_at
    }));
  }

  openPosition(candidate, fillPrice) {
    const entry = Number(fillPrice || candidate.entryPrice);
    const now = new Date().toISOString();
    const posId = `POS-${Date.now()}-${candidate.symbol}`;

    this.db.prepare(`
      INSERT INTO positions (
        id, candidate_id, symbol, trading_symbol, asset_class, side,
        lot_size, entry_price, current_price, target1, target2, stop_loss,
        capital_required, pnl_rupees, status, opened_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?)
    `).run(
      posId, candidate.id, candidate.symbol, candidate.tradingSymbol || candidate.symbol,
      candidate.assetClass, candidate.action || "BUY", candidate.lotSize || 1,
      entry, entry, candidate.target1, candidate.target2, candidate.stopLoss,
      candidate.capitalRequired || (entry * candidate.lotSize), now, now
    );

    this.logAuditEvent("POSITION_OPENED", JSON.stringify({ posId, symbol: candidate.symbol, entry }));
    return { ...candidate, id: posId, candidateId: candidate.id, entryPrice: entry, status: "ACTIVE" };
  }

  closePosition(posId, exitPrice, reason = "MANUAL_EXIT") {
    const pos = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(posId);
    if (!pos) return null;

    const exit = Number(exitPrice);
    const now = new Date().toISOString();
    const pnlPerUnit = pos.side === "BUY" ? exit - pos.entry_price : pos.entry_price - exit;
    const realizedPnl = Math.round((pnlPerUnit * pos.lot_size + Number.EPSILON) * 100) / 100;
    const pnlPct = Math.round(((exit - pos.entry_price) / pos.entry_price * 100) * 100) / 100;
    const isWin = realizedPnl > 0;

    // Execute atomic SQLite transaction
    this.db.exec("BEGIN TRANSACTION;");
    try {
      // 1. Delete active position
      this.db.prepare("DELETE FROM positions WHERE id = ?").run(posId);

      // 2. Insert into completed trades ledger
      const tradeId = `TRD-${Date.now()}-${pos.symbol}`;
      this.db.prepare(`
        INSERT INTO trades (
          id, symbol, trading_symbol, type, side, lot_size, entry_price, exit_price,
          entry_time, exit_time, realized_pnl, pnl_pct, exit_reason, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tradeId, pos.symbol, pos.trading_symbol, pos.asset_class, pos.side,
        pos.lot_size, pos.entry_price, exit, pos.opened_at, now,
        realizedPnl, pnlPct, reason, isWin ? "CLOSED_PROFIT" : "CLOSED_LOSS", now
      );

      // 3. Update primary account statistics
      const acct = this.db.prepare("SELECT * FROM account WHERE id = 'PRIMARY'").get();
      const newRealized = acct.realized_pnl + realizedPnl;
      const newWinCount = acct.win_count + (isWin ? 1 : 0);
      const newLossCount = acct.loss_count + (isWin ? 0 : 1);
      const newTotal = acct.total_trades + 1;
      const newWinRate = Math.round((newWinCount / newTotal * 100) * 10) / 10;

      this.db.prepare(`
        UPDATE account
        SET realized_pnl = ?, win_count = ?, loss_count = ?, total_trades = ?, win_rate_pct = ?, updated_at = ?
        WHERE id = 'PRIMARY'
      `).run(newRealized, newWinCount, newLossCount, newTotal, newWinRate, now);

      this.db.exec("COMMIT;");
      this.logAuditEvent("POSITION_CLOSED", JSON.stringify({ posId, tradeId, realizedPnl, reason }));

      return { tradeId, realizedPnl, pnlPct, isWin };
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  recordMacroSnapshot({ giftNifty, indiaVix, brentCrude, sp500Futures, severity, directive }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO macro_snapshots (gift_nifty, india_vix, brent_crude, sp500_futures, regime_severity, action_directive, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(giftNifty) || null, Number(indiaVix) || null,
      Number(brentCrude) || null, Number(sp500Futures) || null,
      severity || "NORMAL", directive || "STANDARD_EXECUTION", now
    );
  }

  recordTick({ symbol, price, volume, neuralScore, candlestickPattern, chartPattern }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO ticks_history (symbol, price, volume, neural_score, candlestick_pattern, chart_pattern, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      symbol, Number(price), Number(volume || 0),
      Number(neuralScore) || null, candlestickPattern || null,
      chartPattern || null, now
    );
  }

  logAuditEvent(eventType, details) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO audit_events (event_type, details, created_at)
      VALUES (?, ?, ?)
    `).run(eventType, typeof details === "object" ? JSON.stringify(details) : String(details), now);
  }

  recordOrUpdateSignal(sig) {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM signals_lifecycle WHERE id = ?").get(sig.id);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO signals_lifecycle (
          id, symbol, trading_symbol, asset_class, side, option_type, strike,
          lot_size, entry_price, current_price, target1, target2, stop_loss,
          issued_at, closed_at, days_active, horizon_days, status, exit_reason,
          pnl_points, pnl_pct, pnl_rupees, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, 'ACTIVE', null, 0, 0, 0, ?, ?)
      `).run(
        sig.id, sig.symbol, sig.tradingSymbol || sig.symbol,
        sig.assetClass || "FUTURES", sig.side || "BUY", sig.optionType || null, sig.strike || null,
        sig.lotSize || 1, Number(sig.entryPrice), Number(sig.currentPrice || sig.entryPrice),
        Number(sig.target1), Number(sig.target2), Number(sig.stopLoss),
        sig.issuedAt || now, Number(sig.horizonDays || 5), now, now
      );
      return;
    }

    if (existing.status === "ACTIVE") {
      const current = Number(sig.currentPrice || existing.current_price);
      const entry = existing.entry_price;
      const pnlPerUnit = existing.side === "BUY" ? current - entry : entry - current;
      const pnlPoints = Math.round(pnlPerUnit * 100) / 100;
      const pnlPct = Math.round((pnlPerUnit / entry * 100) * 100) / 100;
      const pnlRupees = Math.round(pnlPoints * existing.lot_size * 100) / 100;
      const elapsedMs = Math.max(0, Date.now() - new Date(existing.issued_at).getTime());
      const daysActive = Math.round((elapsedMs / (1000 * 60 * 60 * 24)) * 10) / 10;

      this.db.prepare(`
        UPDATE signals_lifecycle
        SET current_price = ?, days_active = ?, pnl_points = ?, pnl_pct = ?, pnl_rupees = ?, updated_at = ?
        WHERE id = ?
      `).run(current, daysActive, pnlPoints, pnlPct, pnlRupees, now, sig.id);
    }
  }

  archiveSignal(sigId, exitPrice, reason = "TARGET_HIT") {
    const sig = this.db.prepare("SELECT * FROM signals_lifecycle WHERE id = ?").get(sigId);
    if (!sig || sig.status !== "ACTIVE") return null;

    const exit = Number(exitPrice);
    const now = new Date().toISOString();
    const pnlPerUnit = sig.side === "BUY" ? exit - sig.entry_price : sig.entry_price - exit;
    const pnlPoints = Math.round(pnlPerUnit * 100) / 100;
    const pnlPct = Math.round((pnlPerUnit / sig.entry_price * 100) * 100) / 100;
    const pnlRupees = Math.round(pnlPoints * sig.lot_size * 100) / 100;
    const elapsedMs = Math.max(0, Date.now() - new Date(sig.issued_at).getTime());
    const daysActive = Math.round((elapsedMs / (1000 * 60 * 60 * 24)) * 10) / 10;

    let newStatus = "ARCHIVED";
    if (reason.includes("TARGET")) newStatus = "TARGET_HIT";
    else if (reason.includes("STOP")) newStatus = "STOPPED_OUT";
    else if (reason.includes("EXPIRED")) newStatus = "EXPIRED_REMOVED";

    this.db.prepare(`
      UPDATE signals_lifecycle
      SET current_price = ?, closed_at = ?, days_active = ?, status = ?, exit_reason = ?,
          pnl_points = ?, pnl_pct = ?, pnl_rupees = ?, updated_at = ?
      WHERE id = ?
    `).run(exit, now, daysActive, newStatus, reason, pnlPoints, pnlPct, pnlRupees, now, sigId);

    return { sigId, newStatus, pnlRupees, daysActive };
  }

  getActiveSignals() {
    return this.db.prepare("SELECT * FROM signals_lifecycle WHERE status = 'ACTIVE' ORDER BY issued_at DESC").all();
  }

  getArchivedSignals(limit = 100) {
    return this.db.prepare("SELECT * FROM signals_lifecycle WHERE status != 'ACTIVE' ORDER BY closed_at DESC LIMIT ?").all(limit);
  }

  /**
   * Realised accuracy of closed signals.
   *
   * Every statistic here is null until there is something to compute it from.
   * The previous version substituted a 75.0% win rate, a 1.8-day average hold
   * and a profit factor divided by a floor of one rupee whenever the ledger was
   * empty or lossless, so a desk that had never traded still displayed a
   * healthy record. A statistic with no observations behind it is not a
   * conservative default; it is a fabricated one.
   */
  getSignalsAccuracy() {
    const archived = this.getArchivedSignals(200);
    // Classify each closed signal exactly once. The old pair of independent
    // filters counted a TARGET_HIT that closed negative as both a win and a
    // loss, so winCount + lossCount could exceed the number of signals.
    let winCount = 0;
    let lossCount = 0;
    let grossWins = 0;
    let grossLoss = 0;
    let totalFollowPnl = 0;
    let daysSum = 0;
    for (const signal of archived) {
      const pnl = Number(signal.pnl_rupees) || 0;
      totalFollowPnl += pnl;
      daysSum += Number(signal.days_active) || 0;
      const isWin = pnl > 0 || (pnl === 0 && signal.status === "TARGET_HIT");
      const isLoss = pnl < 0 || (pnl === 0 && signal.status === "STOPPED_OUT");
      if (isWin) { winCount += 1; grossWins += pnl; }
      else if (isLoss) { lossCount += 1; grossLoss += Math.abs(pnl); }
    }
    const total = winCount + lossCount;

    return {
      winCount,
      lossCount,
      totalSignals: total,
      // Null, never a stand-in number, when nothing has closed.
      winRatePct: total > 0 ? Math.round((winCount / total * 100) * 10) / 10 : null,
      totalFollowPnl: archived.length ? Math.round(totalFollowPnl * 100) / 100 : null,
      avgDaysOnScreen: archived.length ? Number((daysSum / archived.length).toFixed(1)) : null,
      // A profit factor needs losses to divide by. With none, the ratio is
      // undefined; flooring the denominator at one rupee manufactured a huge
      // number out of an empty denominator.
      profitFactor: grossLoss > 0 ? Number((grossWins / grossLoss).toFixed(2)) : null,
      grossWins: Math.round(grossWins * 100) / 100,
      grossLoss: Math.round(grossLoss * 100) / 100,
      hasTrackRecord: total > 0,
      archived
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { SqliteTradingDatabase, DB_PATH };
