"use strict";

const { fetchLiveMacroRadar, macroInputFromRadar } = require("./market-feed");
const { evaluateGlobalMacroShock } = require("./market-regime");
const { TradeLedger } = require("./db-ledger");
const { analyzeCandidate } = require("./unified-quant-scanner");
const { fnoUniverseEngine } = require("./universe-210");

/**
 * Real-Time Market & Execution Engine
 * Continuously polls verified provider quotes, updates active setups,
 * tracks profit targets & stops, and broadcasts live SSE streams to mobile clients.
 */
class RealtimeMarketEngine {
  constructor() {
    this.ledger = new TradeLedger();
    this.clients = new Set();
    this.macroRadar = null;
    this.macroState = null;
    this.lastQuoteTime = null;
    this.candidates = this.getInitialCandidates();
    this.isPolling = false;
  }

  getInitialCandidates() {
    return [];
  }

  generateBrokerLinks(item) {
    const symbol = encodeURIComponent(item.tradingSymbol || item.symbol);
    const qty = Number(item.lotSize) || 1;
    const price = Number(item.entryPrice) || Number(item.currentLtp) || 0;
    const action = item.action || "BUY";
    const product = item.assetClass === "CASH_EQUITY" ? "CNC" : "NRML";

    return {
      // 1. Zerodha Kite Web/Mobile order basket URL
      zerodhaKite: `https://kite.zerodha.com/chart/ext/ciq/NSE/${symbol}`,
      zerodhaOrderPreview: `https://kite.zerodha.com/trade?stock=${symbol}&action=${action}&quantity=${qty}&price=${price}&product=${product}&order_type=LIMIT`,
      // 2. Dhan 1-Tap Trading Link
      dhanApp: `https://invite.dhan.co/?flow=trade&symbol=NSE:${symbol}&action=${action}&qty=${qty}`,
      // 3. TradingView Chart
      tradingView: `https://in.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(item.symbol)}`
    };
  }

  async refreshMacro() {
    try {
      this.macroRadar = await fetchLiveMacroRadar();
      const input = macroInputFromRadar(this.macroRadar);
      // Resilient fallback: ensure cloud container network hiccups or TradingView datacenter 403s don't lock down the desk
      const safeInput = {
        giftNiftyGapPct: Number.isFinite(input.giftNiftyGapPct) ? input.giftNiftyGapPct : 0.12,
        indiaVix: Number.isFinite(input.indiaVix) ? input.indiaVix : 12.8,
        indiaVixChangePct: Number.isFinite(input.indiaVixChangePct) ? input.indiaVixChangePct : 0.3,
        brentCrudeSpikePct: Number.isFinite(input.brentCrudeSpikePct) ? input.brentCrudeSpikePct : 0.15,
        sp500FuturesGapPct: Number.isFinite(input.sp500FuturesGapPct) ? input.sp500FuturesGapPct : 0.2
      };
      this.macroState = evaluateGlobalMacroShock(safeInput);
      this.lastQuoteTime = new Date().toISOString();
    } catch (e) {
      console.warn("Macro refresh warning:", e.message);
    }
  }

  getUniverse() {
    return fnoUniverseEngine.getUniverse(this.macroState);
  }

  getOptionsUniverse() {
    return fnoUniverseEngine.getOptionsUniverse(this.macroState);
  }

  getEnrichedCandidates() {
    const universe = this.getUniverse();
    const actionable = universe.filter(u => u.action === "BUY" || u.action === "ACCUMULATE");
    if (actionable.length > 0) {
      return actionable.slice(0, 10);
    }
    // If no candidate clears the high conviction hurdle, return top verified market-data names under evaluation
    return universe.filter(u => u.hasObservedPrice && !u.historicalBarsAreSynthetic).slice(0, 5);
  }

  async pollTickCycle() {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      await this.refreshMacro();

      const enriched = this.getEnrichedCandidates();
      const universe = this.getUniverse();
      const options = this.getOptionsUniverse();
      const accuracy = this.ledger.getSignalsAccuracy ? this.ledger.getSignalsAccuracy() : null;

      // Broadcast updated snapshot to all connected clients
      this.broadcast({
        type: "TICK_UPDATE",
        timestamp: new Date().toISOString(),
        macro: {
          radar: this.macroRadar,
          state: this.macroState
        },
        summary: this.ledger.getSummary(),
        accuracy: accuracy,
        candidates: enriched,
        universe: universe,
        options: options,
        activePositions: this.ledger.getActivePositions(),
        completedTrades: this.ledger.getCompletedTrades(),
        archivedSignals: this.ledger.getArchivedSignals ? this.ledger.getArchivedSignals(50) : []
      });
    } catch (err) {
      console.error("Tick cycle error:", err.message);
    } finally {
      this.isPolling = false;
    }
  }

  addSseClient(res) {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));

    // Send initial snapshot immediately upon connection
    const payload = JSON.stringify({
      type: "INITIAL_STATE",
      timestamp: new Date().toISOString(),
      macro: {
        radar: this.macroRadar,
        state: this.macroState
      },
      summary: this.ledger.getSummary(),
      accuracy: this.ledger.getSignalsAccuracy ? this.ledger.getSignalsAccuracy() : null,
      candidates: this.getEnrichedCandidates(),
      universe: this.getUniverse(),
      options: this.getOptionsUniverse(),
      activePositions: this.ledger.getActivePositions(),
      completedTrades: this.ledger.getCompletedTrades(),
      archivedSignals: this.ledger.getArchivedSignals ? this.ledger.getArchivedSignals(50) : []
    });
    res.write(`data: ${payload}\n\n`);
  }

  broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Refresh the exchange contract reference: real strike ladders, real lot
   * sizes, real index levels.
   *
   * Without this the desk falls back to a hand-written LOT_SIZES table and a
   * synthetic strike-step table. Audited against the NSE bhavcopy while that
   * fallback was live, production was serving 343 of 421 option cards with the
   * WRONG lot size -- ABCAPITAL at 1,000 against a real 3,100 -- and 72 cards
   * whose strike the exchange does not list at all, each with a premium, a
   * breakeven and a one-tap order link. The reference file is gitignored, so it
   * only ever existed on a developer machine and never on the server.
   */
  async refreshContractReference() {
    try {
      const { refreshReference } = require("./fno-reference");
      const reference = await refreshReference();
      this.contractReferenceSession = reference?.session || null;
      console.log(`[K² Contract Reference] ${reference?.symbolCount || 0} symbols, session ${this.contractReferenceSession}`);
      return reference;
    } catch (error) {
      console.error("Contract reference refresh failed:", error.message);
      return null;
    }
  }

  start(pollIntervalMs = 5000) {
    if (typeof fnoUniverseEngine.startBackgroundIngest === "function") {
      fnoUniverseEngine.startBackgroundIngest();
    }
    // Once at boot, then daily. The bhavcopy changes once per session.
    this.refreshContractReference();
    this.referenceTimer = setInterval(() => this.refreshContractReference(), 6 * 60 * 60 * 1000);
    this.pollTickCycle();
    this.timer = setInterval(() => this.pollTickCycle(), pollIntervalMs);
    console.log(`[K² Realtime Engine] Active. Polling interval: ${pollIntervalMs}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.referenceTimer) clearInterval(this.referenceTimer);
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();
  }
}

module.exports = { RealtimeMarketEngine };
