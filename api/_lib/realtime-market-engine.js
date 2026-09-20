"use strict";

const { fetchLiveMacroRadar, macroInputFromRadar } = require("./market-feed");
const { evaluateGlobalMacroShock } = require("./market-regime");
const { TradeLedger } = require("./db-ledger");
const { analyzeCandidate } = require("./unified-quant-scanner");
const { fnoUniverseEngine } = require("./universe-210");

// Shorter than the poll interval, so the desk still refreshes every cycle.
const UNIVERSE_CACHE_MS = 2500;

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
    this.universeCache = null;
    this.universeCacheAt = 0;
    this.universeCacheMacro = null;
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

  /**
   * The computed universe, cached for a few seconds.
   *
   * This recomputed all 210 names on EVERY caller -- and /api/state calls it
   * three times over, directly and through getEnrichedCandidates and
   * getOptionsUniverse. Each pass costs about 260ms and allocates roughly
   * 40 MB, so a page polling every four seconds kept a 512 MB host churning
   * hundreds of megabytes a minute. Resident memory measured 313 MB under
   * ordinary load, which is how Friday ended in 502s.
   *
   * The inputs only change when the engine ticks, so recomputing per caller
   * bought nothing. The TTL is deliberately shorter than the poll interval:
   * the desk still refreshes every cycle, it just stops rebuilding the same
   * answer three times inside one request.
   */
  getUniverse() {
    const now = Date.now();
    if (this.universeCache && now - this.universeCacheAt < UNIVERSE_CACHE_MS
      && this.universeCacheMacro === this.macroState) {
      return this.universeCache;
    }
    this.universeCache = fnoUniverseEngine.getUniverse(this.macroState);
    this.universeCacheAt = now;
    // Cached against the macro state it was computed under: a shield change
    // must invalidate immediately rather than wait out the timer.
    this.universeCacheMacro = this.macroState;
    return this.universeCache;
  }

  /** Drop the cache, for callers that must see a recomputation now. */
  invalidateUniverseCache() {
    this.universeCache = null;
    this.universeCacheAt = 0;
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


  async refreshBrokerInstruments() {
    try {
      const brokers = require("./broker-feed");
      for (const provider of brokers.PROVIDERS) {
        if (brokers.loadInstruments(provider)) continue;
        const master = await brokers.refreshInstruments(provider);
        console.log(`[K² Broker Instruments] ${provider}: ${master.underlyingCount} underlyings${master.optionCount ? `, ${master.optionCount} contracts` : ""}`);
      }
    } catch (error) {
      console.error("Broker instrument refresh failed:", error.message);
    }
  }

  async maintainBrokerSessions() {
    try {
      const auth = require("./broker-auth");
      const status = auth.sessionStatus();
      if (status.angelone.canAutoRefresh) {
        const result = await auth.angelEnsureSession();
        console.log(result.ok
          ? `[K² Broker Session] Angel One rotated via ${result.rotated}`
          : `[K² Broker Session] Angel One rotation failed: ${result.reason}`);
      }
      if (status.upstox.hasToken && status.upstox.expiringSoon) {
        console.warn(`[K² Broker Session] Upstox token expires in ${status.upstox.hoursRemaining}h and cannot auto-refresh. Re-authorise: ${status.upstox.loginUrl || "set UPSTOX_API_KEY and UPSTOX_REDIRECT_URI"}`);
      }
      return status;
    } catch (error) {
      console.error("Broker session maintenance failed:", error.message);
      return null;
    }
  }

  /**
   * Record what the desk is recommending, and mark what it already recorded.
   *
   * This is the paper-trading loop: every actionable option card is written
   * down at the price it was shown at, then marked against observed prices
   * until it hits its target, its stop, or expiry. After a month it answers the
   * only question that matters -- did following this desk make money?
   *
   * It records ONLY while the market is open, because a signal issued against a
   * closing book is not a signal anyone could have acted on, and a track record
   * built from prices nobody could trade at is the same fiction as a seeded one.
   */
  recordSignals() {
    try {
      const ledger = require("./signal-record");
      const live = require("./live-quotes");
      const phase = live.marketPhase();
      if (!phase.open) return { ok: false, reason: "MARKET_CLOSED_NOT_RECORDING" };

      const cards = fnoUniverseEngine.getOptionsUniverse(this.macroState) || [];
      let recorded = 0, refused = 0;

      for (const card of cards) {
        if (!(card.action === "BUY" || card.action === "ACCUMULATE")) continue;
        if (card.available === false) continue;
        // A modelled premium must never open a paper position: the record would
        // then be measuring the model against itself.
        if (!card.priceSource || String(card.priceSource).startsWith("THEORETICAL")) continue;
        const exits = card.legExits;
        if (!exits?.available) continue;

        const result = ledger.record({
          symbol: card.symbol, strike: card.strike, right: card.type || card.optionType,
          expiry: card.expiry, entryPrice: card.entryPrice, lotSize: card.lotSize,
          priceSource: card.priceSource, executable: card.executable,
          targetPrice: exits.profitTarget?.premium, stopPrice: exits.stop?.premium,
          probabilityOfProfitPct: card.odds?.probabilityOfProfitPct,
          volatilityVerdict: card.odds?.volatility?.verdict
        });
        if (result.ok && result.status === "RECORDED") recorded += 1;
        else if (!result.ok) refused += 1;
      }

      // Mark the open book against whatever the desk can currently observe.
      const priceFor = (position) => {
        const quote = live.liveQuote(position.symbol, position.expiry, position.strike, position.right);
        if (quote && quote.bid > 0 && quote.ask > 0) {
          return { price: (quote.bid + quote.ask) / 2, source: `BROKER_${quote.freshness}` };
        }
        const reference = require("./fno-reference");
        const settled = reference.tradedQuote(position.symbol, position.strike, position.right, position.expiry);
        return settled?.price > 0 ? { price: settled.price, source: "EXCHANGE_SETTLED_PRICE" } : null;
      };
      const marks = ledger.markToMarket(priceFor);

      if (recorded || marks.closed) {
        console.log(`[K² Ledger] recorded ${recorded}, marked ${marks.marked}, closed ${marks.closed}`);
        // Mirror only when something actually changed. The ephemeral disk means
        // an unmirrored close is a closed trade that disappears on next deploy.
        ledger.syncToRemote().then((sync) => {
          if (!sync.ok && sync.reason !== "GOOGLE_STORE_NOT_CONFIGURED") {
            console.error("Ledger mirror failed:", sync.reason);
          }
        }).catch(() => {});
      }
      return { ok: true, recorded, refused, ...marks };
    } catch (error) {
      console.error("Signal recording failed:", error.message);
      return { ok: false, reason: error.message };
    }
  }

  /**
   * Refresh company fundamentals for the universe.
   *
   * These were never fetched. The cache directory did not exist, so
   * getCachedFundamentals returned null for all 210 names, and two things that
   * LOOK like they protect the desk quietly did nothing at all:
   *
   *   - the balance-sheet adjustment in the composite ranking never fired, so a
   *     name with debt-to-equity over 200 was scored exactly like one without
   *   - THE EARNINGS VETO NEVER FIRED. earningsVeto reads
   *     fund?.events?.insideTradingWeek, and with no fundamentals that is
   *     undefined for every symbol. The desk could recommend buying premium on
   *     a stock reporting that week, which is the one setup where being right
   *     about direction still loses: implied volatility collapses on the
   *     announcement and takes the long option with it.
   *
   * Fetched slowly and cached for a day. Fundamentals change quarterly; there
   * is no reason to hurry, and pacing keeps this away from rate limits.
   */
  async refreshFundamentals({ batchSize = 8, pauseMs = 1200 } = {}) {
    try {
      const { fundamentals } = require("./fundamentals");
      const symbols = fnoUniverseEngine.getUniverse(this.macroState).map((row) => row.symbol);
      let fetched = 0, failed = 0;
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map((symbol) => fundamentals(symbol)));
        for (const result of results) {
          if (result.status === "fulfilled" && result.value?.available) fetched += 1;
          else failed += 1;
        }
        if (i + batchSize < symbols.length) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      console.log(`[K² Fundamentals] ${fetched} of ${symbols.length} refreshed (${failed} unavailable)`);
      return { ok: fetched > 0, fetched, failed };
    } catch (error) {
      // Missing fundamentals must not take the desk down; it degrades to no
      // balance-sheet adjustment and no earnings veto, which is where it has
      // been all along -- but now it is reported rather than silent.
      console.error("Fundamentals refresh failed:", error.message);
      return { ok: false, reason: error.message };
    }
  }

  /** Cold-start sequence: each step needs the one before it. */
  async bootstrap() {
    try {
      // The bhavcopy changes once per session, and every strike, lot size and
      // settled price on the desk is read from it.
      await this.refreshContractReference();
      // The Angel instrument master is what turns a symbol into a tradeable
      // token. Dhan's scrip master was fetched here for a feed this account
      // does not have; the Dhan ORDER link on the cards is unaffected.
      await this.refreshBrokerInstruments();
      // Angel One can hold its own session from a TOTP secret. Upstox cannot --
      // it issues no refresh token -- so it is watched and warned about instead.
      await this.maintainBrokerSessions();
      // Live books for the names the desk is actually recommending. Refreshing
      // all 210 would take minutes under broker rate limits and the first quotes
      // would be stale before the last arrived, so this follows the picks.
      await this.refreshLiveQuotes();
      // Pull the durable ledger back. Render's free disk is wiped on every
      // deploy, so without this the track record restarts from nothing each
      // time the code changes -- which is not a track record.
      // Fundamentals last: slow, paced, and nothing above depends on it.
      this.refreshFundamentals();
      this.fundamentalsTimer = setInterval(() => this.refreshFundamentals(), 12 * 60 * 60 * 1000);
      const restored = await require("./signal-record").restoreFromRemote();
      if (restored.ok) console.log(`[K² Ledger] restored ${restored.positions} positions from the durable store`);
    } catch (error) {
      // A failed bootstrap leaves the desk on exchange settled prices, which is
      // a labelled and honest state, so it must never take the server down.
      console.error("Bootstrap incomplete, desk stays on settled prices:", error.message);
    }
  }

  async refreshLiveQuotes({ limit = 12 } = {}) {
    try {
      const live = require("./live-quotes");
      const reference = require("./fno-reference");
      const contractRef = reference.loadReference();
      if (!contractRef) return null;
      const universe = fnoUniverseEngine.getUniverse(this.macroState);
      const picks = universe
        .filter((row) => row.action === "BUY" || row.action === "ACCUMULATE")
        .slice(0, limit);
      const requests = picks.map((row) => {
        const near = reference.nearestListedStrike(row.symbol, row.spotPrice, { reference: contractRef });
        return near ? { symbol: row.symbol, expiry: near.expiry, referencePrice: row.spotPrice } : null;
      }).filter(Boolean);
      if (!requests.length) return null;
      const result = await live.refreshQuotes(requests);
      if (result.ok) console.log(`[K² Live Quotes] ${result.refreshed}/${result.requested} chains from ${result.provider}`);

      // The FUTURES price, for every listed name, because an Indian stock
      // option is priced off its future and the cash share is off by as much as
      // 2.5%. Cheap to fetch -- one quote per symbol, batched 50 at a time.
      try {
        const all = fnoUniverseEngine.getUniverse(this.macroState).map((row) => {
          const entry = contractRef?.symbols?.[row.symbol];
          return entry?.frontExpiry ? { symbol: row.symbol, expiry: entry.frontExpiry } : null;
        }).filter(Boolean);
        const futures = await live.refreshFutures(all);
        if (futures.ok) console.log(`[K² Live Futures] ${futures.count} forwards refreshed`);
      } catch (error) {
        console.error("Futures refresh failed:", error.message);
      }
      // Say plainly, in the server log, whether the feed is usable. The way
      // this fails is quiet -- nothing throws and every test passes -- so it
      // has to announce itself rather than wait to be asked.
      const check = live.diagnose();
      if (!check.ok) console.warn(`[K² Feed] ${check.verdict}: ${check.headline}`);
      return result;
    } catch (error) {
      console.error("Live quote refresh failed:", error.message);
      return null;
    }
  }

  start(pollIntervalMs = 5000) {
    if (typeof fnoUniverseEngine.startBackgroundIngest === "function") {
      fnoUniverseEngine.startBackgroundIngest();
    }
    // Keep retrying the symbols that have no bars yet. The first pass is one
    // shot, and on a shared outbound IP a large fraction of it fails; without
    // this the desk serves those names with no odds for the whole session.
    this.barRetryTimer = setInterval(() => {
      if (typeof fnoUniverseEngine.retryMissingBars !== "function") return;
      fnoUniverseEngine.retryMissingBars().then((result) => {
        if (result.retried) {
          console.log(`[K² Bars] retried ${result.retried}, recovered ${result.recovered}, ${result.remaining} still missing`);
        }
      }).catch(() => {});
    }, 5 * 60 * 1000);
    // Boot in dependency order rather than all at once. A quote request needs
    // the contract reference, the instrument master and a live session, and on
    // a cold deploy none of the three exist yet -- .private is not in the repo,
    // so the server builds its own. Fired in parallel these race and the first
    // quote refresh loses, which the 90s timer would paper over while logging a
    // failure that was really just ordering.
    this.bootstrap();
    this.quoteTimer = setInterval(() => this.refreshLiveQuotes(), 90 * 1000);
    // Paper-trade the desk's own signals, on the same cadence as the quotes
    // that mark them.
    this.ledgerTimer = setInterval(() => this.recordSignals(), 90 * 1000);
    this.sessionTimer = setInterval(() => this.maintainBrokerSessions(), 60 * 60 * 1000);
    this.referenceTimer = setInterval(() => this.refreshContractReference(), 6 * 60 * 60 * 1000);
    this.pollTickCycle();
    this.timer = setInterval(() => this.pollTickCycle(), pollIntervalMs);
    console.log(`[K² Realtime Engine] Active. Polling interval: ${pollIntervalMs}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.referenceTimer) clearInterval(this.referenceTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    if (this.quoteTimer) clearInterval(this.quoteTimer);
    if (this.ledgerTimer) clearInterval(this.ledgerTimer);
    if (this.fundamentalsTimer) clearInterval(this.fundamentalsTimer);
    if (this.barRetryTimer) clearInterval(this.barRetryTimer);
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();
  }
}

module.exports = { RealtimeMarketEngine };
