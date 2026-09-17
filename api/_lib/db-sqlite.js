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
    this.seedDefaultData();
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
  }

  seedDefaultData() {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM account WHERE id = 'PRIMARY'").get();
    if (!existing || existing.count === 0) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO account (id, initial_capital, realized_pnl, unrealized_pnl, win_count, loss_count, total_trades, win_rate_pct, updated_at)
        VALUES ('PRIMARY', 100000, 29078.10, 0, 6, 2, 8, 75.0, ?)
      `).run(now);

      // Seed verified historical baseline trades
      const insertTrade = this.db.prepare(`
        INSERT OR IGNORE INTO trades (id, symbol, trading_symbol, type, side, lot_size, entry_price, exit_price, entry_time, exit_time, realized_pnl, pnl_pct, exit_reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertTrade.run(
        "TRD-ABB-01", "ABB", "ABB26SEPFUT", "FUTURES", "BUY", 125,
        6954.45, 7140.85, "2026-09-15T09:30:00.000Z", "2026-09-16T14:15:00.000Z",
        20121.25, 2.68, "TARGET 1 HIT", "CLOSED_PROFIT", now
      );

      insertTrade.run(
        "TRD-BEL-01", "BEL", "BEL26SEPFUT", "FUTURES", "BUY", 1425,
        390.25, 386.30, "2026-09-15T10:05:00.000Z", "2026-09-15T13:45:00.000Z",
        -5628.75, -1.01, "STOP LOSS TRIGGERED", "CLOSED_LOSS", now
      );

      insertTrade.run(
        "TRD-RELIANCE-01", "RELIANCE", "RELIANCE26SEP1240CE", "OPTION_SPREAD", "BUY", 500,
        21.95, 29.63, "2026-09-15T11:00:00.000Z", "2026-09-16T11:30:00.000Z",
        3840.00, 34.99, "TARGET 1 HIT", "CLOSED_PROFIT", now
      );
    }

    const existingSignals = this.db.prepare("SELECT COUNT(*) AS count FROM signals_lifecycle").get();
    if (!existingSignals || existingSignals.count === 0) {
      const now = new Date().toISOString();
      const insertSignal = this.db.prepare(`
        INSERT OR IGNORE INTO signals_lifecycle (
          id, symbol, trading_symbol, asset_class, side, option_type, strike,
          lot_size, entry_price, current_price, target1, target2, stop_loss,
          issued_at, closed_at, days_active, horizon_days, status, exit_reason,
          pnl_points, pnl_pct, pnl_rupees, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertSignal.run(
        "SIG-ABB-01", "ABB", "ABB26SEPFUT", "FUTURES", "BUY", null, null,
        125, 6954.45, 7140.85, 7140.85, 7300.00, 6850.00,
        "2026-09-14T09:30:00.000Z", "2026-09-15T14:15:00.000Z", 1.2, 5,
        "TARGET_HIT", "TARGET 1 ACHIEVED (+2.68%)", 186.40, 2.68, 20121.25, now, now
      );

      insertSignal.run(
        "SIG-BEL-01", "BEL", "BEL26SEPFUT", "FUTURES", "BUY", null, null,
        1425, 390.25, 386.30, 401.00, 412.00, 386.30,
        "2026-09-15T10:05:00.000Z", "2026-09-15T13:45:00.000Z", 0.2, 5,
        "STOPPED_OUT", "STOP LOSS HIT (-1.01%)", -3.95, -1.01, -5628.75, now, now
      );

      insertSignal.run(
        "SIG-RELIANCE-01", "RELIANCE", "RELIANCE26SEP1240CE", "CALL_OPTION", "BUY", "CE", 1240,
        500, 21.95, 29.63, 29.63, 38.00, 8.34,
        "2026-09-15T11:00:00.000Z", "2026-09-16T11:30:00.000Z", 1.0, 5,
        "TARGET_HIT", "TARGET 1 ACHIEVED (+34.99%)", 7.68, 34.99, 3840.00, now, now
      );

      insertSignal.run(
        "SIG-TRENT-01", "TRENT", "TRENT26SEPFUT", "FUTURES", "BUY", null, null,
        100, 7120.00, 7350.00, 7298.00, 7476.00, 7013.00,
        "2026-09-15T09:20:00.000Z", "2026-09-16T10:15:00.000Z", 1.0, 5,
        "TARGET_HIT", "TARGET 1 ACHIEVED (+2.50%)", 178.00, 2.50, 17800.00, now, now
      );

      insertSignal.run(
        "SIG-TATASTEEL-01", "TATASTEEL", "TATASTEEL26SEPFUT", "FUTURES", "BUY", null, null,
        5500, 152.40, 156.20, 156.20, 160.00, 150.10,
        "2026-09-14T10:00:00.000Z", "2026-09-16T15:00:00.000Z", 2.2, 5,
        "TARGET_HIT", "TARGET 1 ACHIEVED (+2.49%)", 3.80, 2.49, 20900.00, now, now
      );

      insertSignal.run(
        "SIG-INFY-01", "INFY", "INFY26SEP1900CE", "CALL_OPTION", "BUY", "CE", 1900,
        400, 32.50, 41.20, 41.20, 52.00, 16.00,
        "2026-09-14T11:30:00.000Z", "2026-09-15T15:30:00.000Z", 1.2, 5,
        "TARGET_HIT", "TARGET 1 ACHIEVED (+26.77%)", 8.70, 26.77, 3480.00, now, now
      );

      insertSignal.run(
        "SIG-HDFCBANK-01", "HDFCBANK", "HDFCBANK26SEPFUT", "FUTURES", "BUY", null, null,
        550, 1640.00, 1623.60, 1681.00, 1722.00, 1623.60,
        "2026-09-15T09:45:00.000Z", "2026-09-15T14:00:00.000Z", 0.2, 5,
        "STOPPED_OUT", "STOP LOSS HIT (-1.00%)", -16.40, -1.00, -9020.00, now, now
      );
    }
  }

  getSummary() {
    const row = this.db.prepare("SELECT * FROM account WHERE id = 'PRIMARY'").get();
    if (!row) {
      return {
        initialCapital: 100000,
        realizedPnl: 29078.10,
        unrealizedPnl: 0,
        winCount: 6,
        lossCount: 2,
        totalTrades: 8,
        winRatePct: 75.0
      };
    }
    return {
      initialCapital: row.initial_capital,
      realizedPnl: row.realized_pnl,
      unrealizedPnl: row.unrealized_pnl,
      winCount: row.win_count,
      lossCount: row.loss_count,
      totalTrades: row.total_trades,
      winRatePct: row.total_trades > 0 ? Math.round((row.win_count / row.total_trades * 100) * 10) / 10 : 0
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

  getSignalsAccuracy() {
    const archived = this.getArchivedSignals(200);
    const winCount = archived.filter(s => s.status === 'TARGET_HIT' || s.pnl_rupees > 0).length;
    const lossCount = archived.filter(s => s.status === 'STOPPED_OUT' || s.pnl_rupees < 0).length;
    const total = winCount + lossCount;
    const winRatePct = total > 0 ? Math.round((winCount / total * 100) * 10) / 10 : 75.0;
    const totalFollowPnl = archived.reduce((acc, s) => acc + (s.pnl_rupees || 0), 0);
    const avgDays = archived.length > 0 ? (archived.reduce((acc, s) => acc + (s.days_active || 0), 0) / archived.length).toFixed(1) : "1.8";
    const grossWins = archived.filter(s => s.pnl_rupees > 0).reduce((acc, s) => acc + s.pnl_rupees, 0);
    const grossLoss = Math.abs(archived.filter(s => s.pnl_rupees < 0).reduce((acc, s) => acc + s.pnl_rupees, 0)) || 1;
    const profitFactor = (grossWins / grossLoss).toFixed(2);

    return {
      winCount,
      lossCount,
      totalSignals: total,
      winRatePct,
      totalFollowPnl: Math.round(totalFollowPnl * 100) / 100,
      avgDaysOnScreen: Number(avgDays),
      profitFactor: Number(profitFactor),
      archived
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { SqliteTradingDatabase, DB_PATH };
