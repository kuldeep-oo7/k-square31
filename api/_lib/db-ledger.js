"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SqliteTradingDatabase, DB_PATH } = require("./db-sqlite");

const LEDGER_PATH = path.resolve(__dirname, "../../.private/trade-ledger.json");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class TradeLedger {
  constructor(dbPath = DB_PATH, jsonPath = LEDGER_PATH) {
    this.jsonPath = jsonPath;
    this.sqlite = new SqliteTradingDatabase(dbPath);
    this.syncJsonMirror();
  }

  syncJsonMirror() {
    try {
      ensureDir(this.jsonPath);
      const summary = this.sqlite.getSummary();
      const active = this.sqlite.getActivePositions();
      const completed = this.sqlite.getCompletedTrades();

      const state = {
        version: "3.0.0-sqlite",
        databaseType: "SQLite (node:sqlite WAL)",
        databasePath: this.sqlite.dbPath,
        lastUpdated: new Date().toISOString(),
        account: {
          initialCapital: summary.initialCapital,
          realizedPnl: summary.realizedPnl,
          unrealizedPnl: summary.unrealizedPnl,
          winCount: summary.winCount,
          lossCount: summary.lossCount,
          totalTrades: summary.totalTrades,
          winRatePct: summary.winRatePct
        },
        activePositions: active,
        completedTrades: completed
      };

      fs.writeFileSync(this.jsonPath, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.warn("JSON mirror sync warning:", e.message);
    }
  }

  getActivePositions() {
    return this.sqlite.getActivePositions();
  }

  getCompletedTrades(limit = 50) {
    return this.sqlite.getCompletedTrades(limit);
  }

  getSummary() {
    return this.sqlite.getSummary();
  }

  openPosition(candidate, fillPrice = null) {
    const pos = this.sqlite.openPosition(candidate, fillPrice);
    this.syncJsonMirror();
    return pos;
  }

  closePosition(posId, exitPrice, reason = "MANUAL_EXIT") {
    const closed = this.sqlite.closePosition(posId, exitPrice, reason);
    this.syncJsonMirror();
    return closed;
  }

  recordTick(tickData) {
    this.sqlite.recordTick(tickData);
  }

  recordMacroSnapshot(macroData) {
    this.sqlite.recordMacroSnapshot(macroData);
  }
}

module.exports = { TradeLedger, LEDGER_PATH, DB_PATH };
