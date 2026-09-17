"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEDGER_PATH = path.resolve(__dirname, "../../.private/trade-ledger.json");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDefaultState() {
  return {
    version: "2.0.0",
    lastUpdated: new Date().toISOString(),
    account: {
      initialCapital: 100000,
      realizedPnl: 29078.10,
      unrealizedPnl: 0,
      winCount: 6,
      lossCount: 2,
      totalTrades: 8
    },
    activePositions: [],
    completedTrades: [
      {
        id: "TRD-ABB-01",
        symbol: "ABB",
        tradingSymbol: "ABB26SEPFUT",
        type: "FUTURES",
        side: "BUY",
        lotSize: 125,
        entryPrice: 6954.45,
        exitPrice: 7140.85,
        entryTime: "2026-09-15T09:30:00.000Z",
        exitTime: "2026-09-16T14:15:00.000Z",
        realizedPnl: 20121.25,
        exitReason: "TARGET 1 HIT",
        status: "CLOSED_PROFIT"
      },
      {
        id: "TRD-BEL-01",
        symbol: "BEL",
        tradingSymbol: "BEL26SEPFUT",
        type: "FUTURES",
        side: "BUY",
        lotSize: 1425,
        entryPrice: 390.25,
        exitPrice: 386.30,
        entryTime: "2026-09-15T10:05:00.000Z",
        exitTime: "2026-09-15T13:45:00.000Z",
        realizedPnl: -5628.75,
        exitReason: "STOP LOSS TRIGGERED",
        status: "CLOSED_LOSS"
      },
      {
        id: "TRD-RELIANCE-01",
        symbol: "RELIANCE",
        tradingSymbol: "RELIANCE26SEP1240CE",
        type: "OPTION_SPREAD",
        side: "BUY",
        lotSize: 500,
        entryPrice: 21.95,
        exitPrice: 29.63,
        entryTime: "2026-09-15T11:00:00.000Z",
        exitTime: "2026-09-16T11:30:00.000Z",
        realizedPnl: 3840.00,
        exitReason: "TARGET 1 HIT",
        status: "CLOSED_PROFIT"
      }
    ]
  };
}

class TradeLedger {
  constructor(filePath = LEDGER_PATH) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn("Ledger load warning, initializing default:", e.message);
    }
    const def = getDefaultState();
    this.save(def);
    return def;
  }

  save(state = this.state) {
    ensureDir(this.filePath);
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  getActivePositions() {
    return this.state.activePositions || [];
  }

  getCompletedTrades() {
    return this.state.completedTrades || [];
  }

  getSummary() {
    let unrl = 0;
    for (const pos of this.getActivePositions()) {
      if (Number.isFinite(pos.currentPnl)) unrl += pos.currentPnl;
    }
    this.state.account.unrealizedPnl = Math.round(unrl * 100) / 100;
    return {
      ...this.state.account,
      activePositionsCount: this.getActivePositions().length,
      completedTradesCount: this.getCompletedTrades().length,
      winRatePct: this.state.account.totalTrades > 0
        ? Math.round((this.state.account.winCount / this.state.account.totalTrades) * 1000) / 10
        : 0
    };
  }

  openPosition(candidate, fillPrice = null) {
    const id = `POS-${candidate.symbol}-${Date.now().toString().slice(-4)}`;
    const entry = fillPrice || candidate.entryTrigger || candidate.plannedLimit || candidate.entry;
    const pos = {
      id,
      symbol: candidate.symbol,
      tradingSymbol: candidate.tradingSymbol || candidate.symbol,
      assetClass: candidate.assetClass || "EQUITY",
      side: candidate.action || candidate.side || "BUY",
      lotSize: candidate.lotSize || 1,
      entryPrice: Number(entry),
      currentPrice: Number(entry),
      target1: candidate.target1 || candidate.target,
      target2: candidate.target2 || null,
      stopLoss: candidate.stopLoss,
      capitalInvested: candidate.capitalRequired || 0,
      openedAt: new Date().toISOString(),
      currentPnl: 0,
      status: "OPEN_ACTIVE",
      strategy: candidate.strategy || null
    };
    this.state.activePositions.push(pos);
    this.save();
    return pos;
  }

  closePosition(posId, exitPrice, reason) {
    const idx = this.state.activePositions.findIndex(p => p.id === posId);
    if (idx === -1) return null;
    const [pos] = this.state.activePositions.splice(idx, 1);
    const pnl = (Number(exitPrice) - pos.entryPrice) * pos.lotSize * (pos.side === "BUY" ? 1 : -1);
    const roundedPnl = Math.round(pnl * 100) / 100;

    const closed = {
      id: pos.id,
      symbol: pos.symbol,
      tradingSymbol: pos.tradingSymbol,
      type: pos.assetClass,
      side: pos.side,
      lotSize: pos.lotSize,
      entryPrice: pos.entryPrice,
      exitPrice: Number(exitPrice),
      entryTime: pos.openedAt,
      exitTime: new Date().toISOString(),
      realizedPnl: roundedPnl,
      exitReason: reason,
      status: roundedPnl >= 0 ? "CLOSED_PROFIT" : "CLOSED_LOSS"
    };

    this.state.completedTrades.unshift(closed);
    this.state.account.realizedPnl = Math.round((this.state.account.realizedPnl + roundedPnl) * 100) / 100;
    this.state.account.totalTrades += 1;
    if (roundedPnl >= 0) this.state.account.winCount += 1;
    else this.state.account.lossCount += 1;

    this.save();
    return closed;
  }

  updateMark(symbol, markPrice) {
    if (!Number.isFinite(markPrice)) return;
    for (const pos of this.state.activePositions) {
      if (pos.symbol === symbol || pos.tradingSymbol === symbol) {
        pos.currentPrice = markPrice;
        const pnl = (markPrice - pos.entryPrice) * pos.lotSize * (pos.side === "BUY" ? 1 : -1);
        pos.currentPnl = Math.round(pnl * 100) / 100;
      }
    }
    this.save();
  }
}

module.exports = { TradeLedger, LEDGER_PATH };
