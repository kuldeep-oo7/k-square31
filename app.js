(() => {
  "use strict";

  const watchlist = Array.isArray(window.WATCHLIST) ? window.WATCHLIST : [];
  const bySymbol = new Map(watchlist.map((item, index) => [item.symbol, { ...item, index }]));
  const market = new Map();
  const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
  const compactCurrency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 2 });

  const state = {
    visibleLimit: 30,
    currentSymbol: null,
    focusSymbol: watchlist[0]?.symbol || null,
    tradeSymbol: null,
    refreshing: false,
    user: null,
    displayName: null,
    csrf: null,
    databaseOnline: false,
    refreshTimer: null,
    storyFrame: null,
    ambientFrame: null,
    revealObserver: null,
    portfolio: emptyPortfolio(),
    aiLedger: emptyAiLedger(),
    aiSearch: "",
    aiRefreshTimer: null
  };

  const el = (id) => document.getElementById(id);
  const stockList = el("stockList");
  const feedPill = el("feedPill");
  const refreshButton = el("refreshButton");

  function emptyPortfolio() {
    return { version: 2, lots: [], realizedPnl: 0, transactions: [] };
  }

  function emptyAiLedger() {
    return {
      config: { budgetPerStock: 200000, slots: 5, slotBudget: 40000, buyStepPct: 3, takeProfitPct: 2 },
      summary: { allocated: watchlist.length * 200000, cash: watchlist.length * 200000, marketValue: 0, invested: 0, openPnl: 0, realizedPnl: 0, openLots: 0, activeStocks: 0 },
      stocks: [], transactions: [], updatedAt: null
    };
  }

  function loadPortfolio() {
    if (!state.user) return emptyPortfolio();
    try {
      const userKey = `k2-portfolio-v2:${state.user}`;
      let raw = localStorage.getItem(userKey);
      const legacy = localStorage.getItem("pivot31-portfolio-v1");
      if (!raw && legacy && !localStorage.getItem("k2-legacy-portfolio-owner")) {
        raw = legacy;
        localStorage.setItem(userKey, legacy);
        localStorage.setItem("k2-legacy-portfolio-owner", state.user);
      }
      const stored = JSON.parse(raw);
      return {
        lots: Array.isArray(stored?.lots) ? stored.lots : [],
        realizedPnl: Number(stored?.realizedPnl) || 0,
        transactions: Array.isArray(stored?.transactions) ? stored.transactions : []
      };
    } catch {
      return emptyPortfolio();
    }
  }

  function savePortfolio() {
    if (state.user) localStorage.setItem(`k2-portfolio-v2:${state.user}`, JSON.stringify(state.portfolio));
  }

  async function portfolioMutation(action, symbol, price, quantity, requestId = crypto.randomUUID()) {
    const response = await fetch("/api/portfolio", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-K2-CSRF": state.csrf },
      body: JSON.stringify({ action, symbol, price, quantity, requestId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Portfolio update failed");
    return payload.portfolio;
  }

  async function syncServerPortfolio() {
    const cached = state.portfolio;
    try {
      const response = await fetch("/api/portfolio", { credentials: "same-origin" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Portfolio database unavailable");
      let server = payload.portfolio;
      if (!server.lots.length && cached.lots.length) {
        for (const lot of cached.lots) {
          server = await portfolioMutation("buy", lot.symbol, Number(lot.price), Number(lot.quantity), `migration-${String(lot.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}`);
        }
      }
      state.portfolio = server;
      state.databaseOnline = true;
      savePortfolio();
      renderPortfolio();
      renderSummary();
    } catch (error) {
      state.databaseOnline = false;
      toast(`${error.message}. Showing the last synchronized copy.`);
    }
  }

  async function syncAiLedger() {
    if (state.user !== "ai") return;
    try {
      const response = await fetch("/api/ai", { credentials: "same-origin" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI paper ledger unavailable");
      state.aiLedger = payload;
      state.databaseOnline = true;
      renderWatchlist();
      renderFocusMap();
      renderAiPortfolio();
      renderSummary();
    } catch (error) {
      state.databaseOnline = false;
      toast(error.message || "AI paper ledger unavailable");
    }
  }

  function money(value, compact = false) {
    return Number.isFinite(value) ? (compact ? compactCurrency : currency).format(value) : "—";
  }

  function number(value) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: value >= 1000 ? 1 : 2 }).format(value);
  }

  function pct(value) {
    if (!Number.isFinite(value)) return "—";
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  }

  function initials(symbol) {
    return symbol.replace(/[^A-Z0-9]/g, "").slice(0, 2);
  }

  function regimeLabel(regime) {
    return ({
      "below-range": "Below range",
      "lower-band": "Lower band",
      "mid-band": "Mid range",
      "upper-band": "Upper band",
      "above-range": "Above range"
    })[regime] || "Loading";
  }

  function pulseDescription(data) {
    const score = Number(data?.signals?.pulseScore) || 0;
    const agreement = Number(data?.signals?.pulseAgreementPct) || 0;
    const mode = data?.signals?.marketRegime || "transition";
    if (mode === "volatile") return { tone: "negative", label: "Shock detected — risk first", detail: "Volatility, acceleration or multi-session displacement tripped the veto", method: "The reversal and trend verdicts are suppressed until movement normalizes." };
    if (mode === "transition") return { tone: "caution", label: "Transition — wait for clarity", detail: "The path is neither cleanly trending nor reliably ranging", method: "K² withholds a direction until one regime becomes measurable." };
    if (mode === "trend" && score >= 2) return { tone: "positive", label: "Uptrend alignment", detail: `${number(agreement)}% agreement in trend mode`, method: "Five-session momentum, EMA direction and Nifty-relative strength are active." };
    if (mode === "trend" && score <= -2) return { tone: "negative", label: "Downtrend alignment", detail: `${number(agreement)}% agreement in trend mode`, method: "Five-session momentum, EMA direction and Nifty-relative strength are active." };
    if (mode === "range" && score >= 2) return { tone: "positive", label: "Lower extreme — reversal watch", detail: `${number(agreement)}% agreement in range mode`, method: "Range location, RSI pressure and statistical stretch are active." };
    if (mode === "range" && score <= -2) return { tone: "negative", label: "Upper extreme — protect profits", detail: `${number(agreement)}% agreement in range mode`, method: "Range location, RSI pressure and statistical stretch are active." };
    return { tone: "caution", label: `${mode === "trend" ? "Trend" : "Range"} signals are mixed`, detail: "The active model does not have enough agreement", method: "No directional label is forced when the evidence conflicts." };
  }

  function indicatorCards(data) {
    const atrPct = Number(data.signals?.atrPct) || 0;
    const volatility = Number(data.window.annualizedVolatilityPct) || 0;
    const rsiValue = Number(data.window.rsi14);
    const trend = Number(data.signals?.emaSpreadPct) || 0;
    const momentum = Number(data.signals?.return5Pct) || 0;
    const zScore = Number(data.signals?.zScore20) || 0;
    const acceleration = Number(data.signals?.accelerationPct) || 0;
    const trendFit = Number(data.signals?.trendFitPct) || 0;
    const relativeStrength = Number(data.signals?.relativeStrength20Pct) || 0;
    const beta = Number(data.signals?.beta20) || 0;
    const correlation = Number(data.signals?.correlation20) || 0;
    const atr = atrPct < 1.5
      ? { tone: "calm", label: "Calm daily movement", note: `About ${number(atrPct)}% or ${money(data.window.atr14)} per day` }
      : atrPct < 3
        ? { tone: "active", label: "Active daily movement", note: `About ${number(atrPct)}% or ${money(data.window.atr14)} per day` }
        : { tone: "danger", label: "Very wide daily movement", note: `About ${number(atrPct)}% or ${money(data.window.atr14)} per day` };
    const vol = volatility < 25
      ? { tone: "calm", label: "Relatively calm", note: "Smaller position swings" }
      : volatility < 45
        ? { tone: "active", label: "Fast-moving", note: "Expect meaningful price swings" }
        : { tone: "danger", label: "High movement risk", note: "Wide and sudden swings are normal" };
    const pressure = rsiValue <= 30
      ? { tone: "active", label: "Selling is stretched", note: "Possible bounce, but sellers still control" }
      : rsiValue < 45
        ? { tone: "danger", label: "Sellers control", note: "Recent closes lean downward" }
        : rsiValue <= 55
          ? { tone: "neutral", label: "Pressure is balanced", note: "Neither side has clear control" }
          : rsiValue < 70
            ? { tone: "calm", label: "Buyers control", note: "Recent closes lean upward" }
            : { tone: "active", label: "Buying is stretched", note: "Strong, but pullback risk is elevated" };
    const trendCard = trend > .25
      ? { tone: "calm", label: "Short trend above long trend", note: `${pct(trend)} EMA spread` }
      : trend < -.25
        ? { tone: "danger", label: "Short trend below long trend", note: `${pct(trend)} EMA spread` }
        : { tone: "neutral", label: "Trend is flat", note: "Short and long averages are close" };
    const momentumCard = momentum > 1
      ? { tone: "calm", label: "Positive five-day velocity", note: `${pct(momentum)} over five sessions` }
      : momentum < -1
        ? { tone: "danger", label: "Negative five-day velocity", note: `${pct(momentum)} over five sessions` }
        : { tone: "neutral", label: "Little five-day movement", note: `${pct(momentum)} over five sessions` };
    const stretch = zScore < -1
      ? { tone: "active", label: "Below its 20-day norm", note: `${number(Math.abs(zScore))} standard deviations lower` }
      : zScore > 1
        ? { tone: "active", label: "Above its 20-day norm", note: `${number(zScore)} standard deviations higher` }
        : { tone: "neutral", label: "Near its 20-day norm", note: `${number(zScore)} standard deviations` };
    const accelerationCard = acceleration > 1
      ? { tone: "calm", label: "Upward movement is strengthening", note: "Latest three sessions improved versus the prior three" }
      : acceleration < -1
        ? { tone: "danger", label: "Downward movement is strengthening", note: "Latest three sessions weakened versus the prior three" }
        : { tone: "neutral", label: "Movement speed is stable", note: "Little change between consecutive three-session moves" };
    const fitCard = trendFit >= 65
      ? { tone: "active", label: "Clean directional path", note: `${number(trendFit)}% of 10-session movement fits one line` }
      : trendFit >= 35
        ? { tone: "neutral", label: "Partly directional", note: `${number(trendFit)}% trend fit; some noise remains` }
        : { tone: "neutral", label: "Choppy path", note: `Only ${number(trendFit)}% trend fit; false breaks are likelier` };
    const relativeCard = relativeStrength > 2
      ? { tone: "calm", label: "Beating Nifty 50", note: `${pct(relativeStrength)} relative performance over 20 sessions` }
      : relativeStrength < -2
        ? { tone: "danger", label: "Lagging Nifty 50", note: `${pct(relativeStrength)} relative performance over 20 sessions` }
        : { tone: "neutral", label: "Moving near Nifty 50", note: `${pct(relativeStrength)} relative performance over 20 sessions` };
    const betaCard = beta > 1.3
      ? { tone: "danger", label: "Amplifies market movement", note: `Beta ${number(beta)} · correlation ${number(correlation)}` }
      : beta < .7
        ? { tone: "calm", label: "Less market-sensitive", note: `Beta ${number(beta)} · correlation ${number(correlation)}` }
        : { tone: "neutral", label: "Market-like sensitivity", note: `Beta ${number(beta)} · correlation ${number(correlation)}` };
    return [
      { name: "Daily movement · ATR", value: money(data.window.atr14), ...atr },
      { name: "Movement intensity · Volatility", value: `${number(volatility)}%`, ...vol },
      { name: "Buyer/seller pressure · RSI", value: number(rsiValue), ...pressure },
      { name: "Trend direction · EMA", value: pct(trend), ...trendCard },
      { name: "Price velocity · 5 sessions", value: pct(momentum), ...momentumCard },
      { name: "Statistical stretch · Z-score", value: number(zScore), ...stretch },
      { name: "Price acceleration · 3 vs 3", value: pct(acceleration), ...accelerationCard },
      { name: "Trend coherence · R²", value: `${number(trendFit)}%`, ...fitCard },
      { name: "Relative strength · vs Nifty", value: pct(relativeStrength), ...relativeCard },
      { name: "Market sensitivity · Beta", value: number(beta), ...betaCard }
    ];
  }

  function exitPlan(item, data, live) {
    const underlyingPrice = Number(data?.price) || item.average;
    const underlyingAtrPct = underlyingPrice ? (Number(data?.window?.atr14) || underlyingPrice * .01) / underlyingPrice : .01;
    const atr = Math.max(item.average * underlyingAtrPct, item.average * .005);
    const factors = [.5, 1, 1.5, 2, 3];
    const direction = item.position === "short" ? -1 : 1;
    const targets = factors.map((factor, index) => {
      const price = item.average + direction * atr * factor;
      const distance = Math.abs(price - live) / live * 100;
      const reached = direction > 0 ? live >= price : live <= price;
      const status = reached ? "reached" : Math.abs(price - live) <= Math.max(atr * .25, live * .003) ? "close" : "waiting";
      return { price, distance, status, gainPct: direction * (price - item.average) / item.average * 100, rMultiple: factor };
    });
    return { atr, targets, slice: item.quantity / 5, riskLine: item.average - direction * atr, direction };
  }

  function positionFor(data) {
    return Math.max(2, Math.min(98, (data?.position ?? 0.5) * 100));
  }

  function currentPrice(symbol) {
    return market.get(symbol)?.price ?? bySymbol.get(symbol)?.snapshotPrice ?? null;
  }

  function personalSignal(symbol, data, suppliedHolding = null) {
    const anchor = Number(data?.weekly?.openingPrice);
    const price = Number(data?.price);
    const grid = window.K2_GRID?.weeklySignal(anchor, price, 2) || { action: "loading", buyLevels: [], sellAt: null, reachedBuyLevel: 0 };
    const holding = suppliedHolding || holdings().find((item) => item.symbol === symbol);
    const isFuture = holding?.assetType === "future";
    const lots = state.portfolio.lots.filter((lot) => lot.symbol === symbol && lot.assetType !== "future");
    const exit = !isFuture ? window.K2_GRID?.lotExit(lots, price, 2, holding?.position) : null;
    let action = grid.action;
    let label = action === "buy" ? "🟢 BUY SOME" : action === "sell" ? "🔴 SELL SOME" : action === "loading" ? "LOADING PRICES" : "🟡 HOLD — NO ACTION";
    let detail = action === "buy" ? `Buy level ${grid.reachedBuyLevel} at ${money(grid.buyLevels?.[grid.reachedBuyLevel - 1])} has been reached. Use no more than ${money(40_000)} for this chunk.` : action === "sell" ? `Price crossed the ${money(grid.sellAt)} sell line, 2% above Monday's opening reference.` : `Hold until price reaches the ${money(grid.buyLevels?.[0])} buy line or ${money(grid.sellAt)} sell line.`;
    if (exit?.quantity > 0) {
      action = holding?.position === "short" ? "buy" : "sell";
      label = holding?.position === "short" ? "🟢 COVER SOME" : "🔴 SELL SOME";
      detail = `${number(exit.quantity)} stored units have reached their individual 2% profit target.`;
    } else if (holding && exit?.nextTarget) {
      detail = `${holding.position === "short" ? "Cover" : "Sell"} the next stored lot at ${money(exit.nextTarget)}. Until then, hold.`;
    }
    if (isFuture) {
      if (holding.position === "short") {
        label = action === "buy" ? "🟢 COVER SOME" : action === "sell" ? "🔴 SHORT RISK — REVIEW" : "🟡 HOLD — NO ACTION";
        detail = action === "buy" ? `The underlying reached the ${money(grid.buyLevels?.[0])} cover line; the short-position rule says take some profit.` : action === "sell" ? `The underlying crossed the ${money(grid.sellAt)} risk line against the short position; review the contract before acting.` : `Hold until the underlying reaches ${money(grid.buyLevels?.[0])} to cover or ${money(grid.sellAt)} for a risk review.`;
      } else {
        label = action === "buy" ? "🟢 BUY SOME" : action === "sell" ? "🔴 SELL SOME" : "🟡 HOLD — NO ACTION";
        detail = action === "buy" ? `The underlying crossed the ${money(grid.buyLevels?.[0])} buy line. Buy no more than ${money(40_000)} after confirming the futures price.` : action === "sell" ? `The underlying crossed the ${money(grid.sellAt)} sell line. Sell one chunk after confirming the futures price.` : `Do nothing until the underlying reaches ${money(grid.buyLevels?.[0])} to buy or ${money(grid.sellAt)} to sell.`;
      }
    }
    return { ...grid, action, label, detail, holding, isFuture, exit, current: price, buyAt: grid.buyLevels?.[0], sellAt: grid.sellAt };
  }

  function holdings() {
    const grouped = new Map();
    for (const lot of state.portfolio.lots) {
      const assetType = lot.assetType === "future" ? "future" : "equity";
      const position = lot.position === "short" ? "short" : "long";
      const key = lot.contractKey || (assetType === "future" ? `${lot.symbol}|FUT|${lot.expiry}|${position}` : `${lot.symbol}|EQ|long`);
      if (!grouped.has(key)) grouped.set(key, { key, symbol: lot.symbol, assetType, position, expiry: lot.expiry || null, market: lot.market || (assetType === "future" ? "NSEFUT" : "NSE"), quantity: 0, cost: 0, lots: 0, markCost: 0, exactMark: true, source: lot.source || null });
      const item = grouped.get(key);
      item.quantity += Number(lot.quantity);
      item.cost += Number(lot.quantity) * Number(lot.price);
      item.markCost += Number(lot.quantity) * Number(lot.markPrice || lot.price);
      if (assetType === "future" && lot.markSource !== "exchange-live") item.exactMark = false;
      item.lots += 1;
    }
    return [...grouped.values()].map((item) => ({ ...item, average: item.quantity ? item.cost / item.quantity : 0, markPrice: item.quantity ? item.markCost / item.quantity : 0 }));
  }

  function portfolioMetrics() {
    const items = holdings();
    let value = 0;
    let cost = 0;
    let pnl = 0;
    for (const item of items) {
      const mark = item.assetType === "future" ? item.markPrice : (currentPrice(item.symbol) ?? item.average);
      value += mark * item.quantity;
      cost += item.cost;
      pnl += (mark - item.average) * item.quantity * (item.position === "short" ? -1 : 1);
    }
    return { items, value, cost, pnl, pnlPct: cost ? (pnl / cost) * 100 : 0, hasFutures: items.some((item) => item.assetType === "future") };
  }

  function filteredWatchlist() {
    const query = el("searchInput").value.trim().toUpperCase();
    const band = el("bandFilter").value;
    const sector = el("sectorFilter").value;
    const cap = el("capFilter").value;
    const model = el("modelFilter").value;
    const sort = el("sortSelect").value;
    let items = watchlist.filter((item) => !query || item.symbol.includes(query) || item.sector.toUpperCase().includes(query));
    if (sector !== "all") items = items.filter((item) => item.sector === sector);
    if (cap !== "all") items = items.filter((item) => item.marketCapCategory === cap);
    if (model !== "all") items = items.filter((item) => market.get(item.symbol)?.signals?.marketRegime === model);
    if (band !== "all") {
      items = items.filter((item) => {
        const regime = market.get(item.symbol)?.regime;
        return band === "outside" ? regime === "below-range" || regime === "above-range" : regime === band;
      });
    }
    items.sort((a, b) => {
      if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (sort === "position") return (market.get(a.symbol)?.position ?? 2) - (market.get(b.symbol)?.position ?? 2);
      if (sort === "change") return Math.abs(market.get(b.symbol)?.changePct ?? -Infinity) - Math.abs(market.get(a.symbol)?.changePct ?? -Infinity);
      if (sort === "buy-pulse") return (market.get(b.symbol)?.signals?.pulseScore ?? -99) - (market.get(a.symbol)?.signals?.pulseScore ?? -99);
      if (sort === "sell-pulse") return (market.get(a.symbol)?.signals?.pulseScore ?? 99) - (market.get(b.symbol)?.signals?.pulseScore ?? 99);
      if (sort === "relative") return (market.get(b.symbol)?.signals?.relativeStrength20Pct ?? -99) - (market.get(a.symbol)?.signals?.relativeStrength20Pct ?? -99);
      if (sort === "cap-rank") return (a.marketCapRank ?? Infinity) - (b.marketCapRank ?? Infinity);
      if (sort === "sector") return a.sector.localeCompare(b.sector) || a.symbol.localeCompare(b.symbol);
      return bySymbol.get(a.symbol).index - bySymbol.get(b.symbol).index;
    });
    return items;
  }

  function renderWatchlist() {
    const filtered = filteredWatchlist();
    const visible = filtered.slice(0, state.visibleLimit);
    stockList.innerHTML = visible.map((item) => {
      const data = market.get(item.symbol);
      const price = data?.price ?? item.snapshotPrice;
      const change = data?.changePct ?? item.snapshotChangePct;
      const changeClass = change > 0 ? "positive" : change < 0 ? "negative" : "";
      const source = `${item.sector} · ${item.marketCapCategory}`;
      const aiStock = state.user === "ai" ? state.aiLedger.stocks?.find((stock) => stock.symbol === item.symbol) : null;
      const aiReady = Boolean(aiStock?.anchor);
      const personal = state.user !== "ai" && data ? personalSignal(item.symbol, data) : null;
      const mapMarkup = aiReady ? `<div class="range-values"><span>FRIDAY ${money(aiStock.anchor.price)}</span><span>NEXT BUY ${money(aiStock.nextBuy?.price)}</span><span>NEXT SELL ${money(aiStock.nextSell)}</span></div><div class="range-track ai-track"><i class="price-pin" style="left:${focusPosition(Number(aiStock.lastPrice), Number(aiStock.levels?.at(-1)), Number(aiStock.anchor.price))}%"></i></div>` : data ? `<div class="range-values"><span>TODAY LOW ${money(data.daily?.low)}</span><span>NOW ${money(data.price)}</span><span>TODAY HIGH ${money(data.daily?.high)}</span></div><div class="range-track personal-track"><i class="price-pin" style="left:${focusPosition(data.price, data.daily?.low, data.daily?.high)}%"></i></div>` : `<div class="range-values"><span>${state.user === "ai" ? "Waiting for Friday grid" : "Fetching today's range"}</span><span>—</span></div><div class="range-loading"></div>`;
      const stateMarkup = aiReady ? `<span class="state-chip ${aiStock.lots?.length ? "lower-band" : "mid-band"}">${aiStock.lots?.length ? `${aiStock.lots.length} open lot${aiStock.lots.length === 1 ? "" : "s"}` : "Grid watching"}</span><small class="quant-link ${aiStock.openPnl >= 0 ? "positive" : "negative"}">${aiStock.nextBuy ? `B${aiStock.nextBuy.level} next · ${money(aiStock.nextBuy.price)}` : "Weekly levels evaluated"}</small>` : data ? `<span class="trade-suggestion ${personal.action}">${personal.label}</span><small class="quant-link ${pulseDescription(data).tone}">${personal.detail}</small>` : `<span class="state-chip">Loading</span><small class="map-link">Building 2% grid →</small>`;
      return `
        <article class="stock-row" data-symbol="${item.symbol}" tabindex="0" aria-label="Open ${item.symbol} range detail">
          <div class="symbol-cell"><span class="symbol-avatar">${initials(item.symbol)}</span><div><b>${item.symbol}</b><small>${source}</small></div></div>
          <div class="price-cell"><strong>${money(price)}</strong><small class="${changeClass}">${pct(change)} today</small></div>
          <div class="range-cell">${mapMarkup}</div>
          <div class="state-cell">${stateMarkup}</div>
          ${state.user === "ai" ? `<span class="ai-eye" aria-label="AI paper tracking active">AI</span>` : `<button class="add-button" data-add="${item.symbol}" aria-label="Add ${item.symbol} to portfolio">+</button>`}
        </article>`;
    }).join("") || `<div class="empty-portfolio"><div><div class="empty-orbit">✓</div><h3>No stocks in this filter</h3><p>${el("bandFilter").value === "outside" ? "Nothing is trading beyond its 31-day high or low right now. That is a market result—not an error." : "No ticker matches the current search, sector, market-cap, range and quant-mode filters."}</p><button class="empty-reset" data-reset-filters>Show the full watchlist</button></div></div>`;

    const more = el("loadMoreButton");
    more.hidden = state.visibleLimit >= filtered.length;
    more.innerHTML = `Show ${Math.max(0, Math.min(30, filtered.length - state.visibleLimit))} more symbols <span>↓</span>`;
    el("watchlistBadge").textContent = watchlist.length;
  }

  function focusPosition(value, minimum, maximum) {
    if (!Number.isFinite(value) || maximum === minimum) return 50;
    return Math.max(2, Math.min(98, 2 + ((value - minimum) / (maximum - minimum)) * 96));
  }

  function renderAiFocusMap(symbol, stock, snapshot) {
    const container = el("focusMap");
    if (!stock?.anchor) {
      container.innerHTML = `<div class="focus-loading"><div><div class="empty-orbit">AI</div><b>Preparing ${symbol}'s Friday grid</b><p>The secured automation runner will store the latest completed Friday close and five compounded 3% levels.</p></div></div>`;
      return;
    }
    const levels = (stock.levels || []).map((price, index) => `<div class="chunk-row ${stock.triggeredLevels?.[index] ? "ai-triggered" : ""}"><span class="chunk-number">B${index + 1}</span><span class="chunk-copy"><b>${stock.triggeredLevels?.[index] ? "Paper filled" : stock.nextBuy?.level === index + 1 ? "Next trigger" : "Waiting"}</b><small>3% compounded step ${index + 1} · up to ₹40,000</small></span><strong class="chunk-price">${money(price)}</strong></div>`).join("");
    const exits = (stock.lots || []).slice().sort((a, b) => a.target - b.target).map((lot) => `<div class="chunk-row ai-exit"><span class="chunk-number">S${lot.level}</span><span class="chunk-copy"><b>Automatic paper exit</b><small>${number(lot.quantity)} shares · 2% above ${money(lot.price)}</small></span><strong class="chunk-price">${money(lot.target)}</strong></div>`).join("") || `<div class="ai-awaiting">Exit levels appear after a buy lot is filled. Each lot receives its own +2% target.</div>`;
    const weeklyMove = stock.lastPrice && stock.anchor.price ? (stock.lastPrice / stock.anchor.price - 1) * 100 : null;
    container.innerHTML = `<div class="focus-head"><div class="focus-name"><span class="symbol-avatar">${initials(symbol)}</span><div><p class="eyebrow" style="margin-bottom:5px"><span></span> AI FRIDAY GRID</p><h2>${symbol}</h2><p>${snapshot.sector} · ${snapshot.marketCapCategory} · anchor week ${stock.anchor.weekKey}</p></div></div><div class="focus-current"><span>Tracked price</span><strong>${money(stock.lastPrice)}</strong><small class="${weeklyMove >= 0 ? "positive" : "negative"}">${pct(weeklyMove)} from Friday</small></div></div>
      <div class="plain-rule"><b>Friday close: ${money(stock.anchor.price)}.</b> The AI reserves five slots of up to ₹40,000. It buys once at every compounded 3% fall and sells each purchased lot separately after a 2% recovery.</div>
      <div class="ai-focus-equation"><span><small>FRIDAY</small><b>${money(stock.anchor.price)}</b></span><i>→ −3% → −3% → −3% → −3% → −3%</i><span><small>CASH LEFT</small><b>${money(Number(stock.cash))}</b></span></div>
      <div class="chunk-grid"><div class="chunk-side buy"><div class="chunk-heading"><h3>Five weekly buy slots ↓</h3><span>Whole-share paper fills</span></div>${levels}</div><div class="chunk-side sell"><div class="chunk-heading"><h3>Active +2% exits ↑</h3><span>One target per filled lot</span></div>${exits}</div></div>
      <div class="chunk-explain"><p><b>No same-candle trick:</b> a lot bought from today's low cannot be sold using today's earlier high because daily data cannot prove which happened first.</p><p><b>Budget discipline:</b> every stock has an isolated ₹2,00,000 ledger. Manual clicks cannot alter the AI account.</p></div>
      <div class="focus-actions"><button data-open-ai-grid>OPEN COMPLETE AI PAPER LEDGER →</button></div>`;
  }

  function renderFocusMap() {
    const container = el("focusMap");
    const symbol = state.focusSymbol || watchlist[0]?.symbol;
    const data = market.get(symbol);
    const snapshot = bySymbol.get(symbol);
    if (!symbol) return;
    if (state.user === "ai") {
      const aiStock = state.aiLedger.stocks?.find((stock) => stock.symbol === symbol);
      renderAiFocusMap(symbol, aiStock, snapshot);
      return;
    }
    if (!data) {
      container.innerHTML = `<div class="focus-loading"><div><div class="empty-orbit">10</div><b>Building the 10-chunk map for ${symbol}</b><p>Fetching its rolling 31-day high, low, midpoint and volatility…</p></div></div>`;
      return;
    }

    const minimum = data.ladder.buy[4];
    const maximum = data.ladder.sell[4];
    const labels = {
      buy: [
        ["First buy level", "Below the midpoint"],
        ["Second buy level", "Deeper inside the range"],
        ["Near monthly low", "Last level inside the range"],
        ["Below monthly low", "Outside the 31-day range"],
        ["Deep buy extension", "Farthest buy chunk"]
      ],
      sell: [
        ["First sell level", "Above the midpoint"],
        ["Second sell level", "Higher inside the range"],
        ["Near monthly high", "Last level inside the range"],
        ["Above monthly high", "Outside the 31-day range"],
        ["Extended sell level", "Farthest sell chunk"]
      ]
    };
    const chunks = (side) => data.ladder[side].map((price, index) => `
      <div class="chunk-row ${index >= 3 ? "outside-chunk" : ""}">
        <span class="chunk-number">${index + 1}</span>
        <span class="chunk-copy"><b>${labels[side][index][0]}</b><small>${labels[side][index][1]}</small></span>
        <strong class="chunk-price">${money(price)}</strong>
      </div>`).join("");
    const nodes = [
      ...data.ladder.buy.map((price, index) => `<span class="river-node buy ${index >= 3 ? "outside" : ""}" style="left:${focusPosition(price, minimum, maximum)}%"><i>B${index + 1}</i></span>`),
      ...data.ladder.sell.map((price, index) => `<span class="river-node sell ${index >= 3 ? "outside" : ""}" style="left:${focusPosition(price, minimum, maximum)}%"><i>S${index + 1}</i></span>`)
    ].join("");
    const currentSide = data.price < data.window.midpoint ? "below" : data.price > data.window.midpoint ? "above" : "at";
    const actionCopy = currentSide === "below" ? "The current price is on the buy side of the midpoint." : currentSide === "above" ? "The current price is on the sell side of the midpoint." : "The current price is at the midpoint.";
    const personal = personalSignal(symbol, data);
    container.innerHTML = `
      <div class="focus-head">
        <div class="focus-name"><span class="symbol-avatar">${initials(symbol)}</span><div><p class="eyebrow" style="margin-bottom:5px"><span></span> Selected 10-chunk map</p><h2>${symbol}</h2><p>${snapshot.sector} · ${snapshot.marketCapCategory} · rank #${snapshot.marketCapRank} · ${data.window.sessions} sessions in 31 days</p></div></div>
        <div class="focus-current"><span>Current market price</span><strong>${money(data.price)}</strong><small class="${data.changePct >= 0 ? "positive" : "negative"}">${pct(data.changePct)} today</small></div>
      </div>
      <section class="weekly-call ${personal.action}"><div><span>K² WEEKLY 2% CALL · MONDAY OPEN ${money(data.weekly?.openingPrice)}</span><h3>${personal.label}</h3><p>${personal.detail}</p><div class="call-thresholds daily-lines"><b>TODAY LOW ${money(data.daily?.low)}</b><b>NOW ${money(data.price)}</b><b>TODAY HIGH ${money(data.daily?.high)}</b></div></div><strong>${personal.action === "buy" ? money(personal.buyLevels?.[personal.reachedBuyLevel - 1]) : personal.action === "sell" ? money(personal.exit?.nextTarget || personal.sellAt) : money(data.price)}</strong></section>
      <div class="plain-rule"><b>Read this from the centre:</b> the midpoint is ${money(data.window.midpoint)}. Moving left gives five progressively lower buy chunks; moving right gives five progressively higher sell chunks. ${actionCopy}</div>
      <div class="decision-river">
        <div class="river-line"></div>${nodes}
        <span class="river-bound low" style="left:${focusPosition(data.window.low, minimum, maximum)}%">31-DAY LOW<br>${money(data.window.low)}</span>
        <span class="river-bound mid" style="left:${focusPosition(data.window.midpoint, minimum, maximum)}%">MIDPOINT ${money(data.window.midpoint)}</span>
        <span class="river-bound high" style="left:${focusPosition(data.window.high, minimum, maximum)}%">31-DAY HIGH<br>${money(data.window.high)}</span>
        <span class="current-flag" style="left:${focusPosition(data.price, minimum, maximum)}%"><span>NOW ${money(data.price)}</span></span>
      </div>
      <div class="chunk-grid">
        <div class="chunk-side buy"><div class="chunk-heading"><h3>5 buy chunks ↓</h3><span>All below midpoint</span></div>${chunks("buy")}</div>
        <div class="chunk-side sell"><div class="chunk-heading"><h3>5 sell chunks ↑</h3><span>All above midpoint</span></div>${chunks("sell")}</div>
      </div>
      <div class="chunk-explain"><p><b>Buying, in simple words:</b> chunk 1 is the first lower price. If the stock falls further, chunks 2–5 spread the entry instead of putting everything at one price. Buy 4 and 5 are below the monthly low.</p><p><b>Selling, in simple words:</b> chunk 1 is the first higher price. Chunks 2–5 step upward so the position can be reduced gradually. Sell 4 and 5 are above the monthly high.</p></div>
      <div class="focus-actions">${state.user === "ai" ? `<button data-open-ai-grid>VIEW ${symbol} IN AI PAPER GRID →</button>` : `<button data-focus-add="${symbol}">+ ADD ${symbol} TO PORTFOLIO</button>`}</div>`;
  }

  function renderSummary() {
    if (state.user === "ai") {
      const summary = state.aiLedger.summary || emptyAiLedger().summary;
      const equity = Number(summary.cash) + Number(summary.marketValue);
      const totalPnl = equity - Number(summary.allocated);
      el("trackedCount").textContent = watchlist.length;
      el("portfolioValueLabel").textContent = "Virtual portfolio";
      el("openPnlLabel").textContent = "Total P&L";
      el("portfolioValue").textContent = money(equity, true);
      el("holdingCount").textContent = `${summary.activeStocks || 0} active stocks · ${summary.openLots || 0} lots`;
      el("openPnl").textContent = money(totalPnl, Math.abs(totalPnl) >= 100000);
      el("openPnl").className = totalPnl > 0 ? "positive" : totalPnl < 0 ? "negative" : "";
      el("openPnlPct").textContent = `${pct(summary.allocated ? totalPnl / summary.allocated * 100 : 0)} on virtual allocation`;
      el("portfolioBadge").textContent = summary.activeStocks || 0;
      el("loadedCount").textContent = `${market.size} / ${watchlist.length}`;
      return;
    }
    const metrics = portfolioMetrics();
    el("trackedCount").textContent = watchlist.length;
    el("portfolioValueLabel").textContent = metrics.hasFutures ? "Reference notional" : "Portfolio value";
    el("openPnlLabel").textContent = metrics.hasFutures ? "Marked P&L" : "Open P&L";
    el("portfolioValue").textContent = money(metrics.value, metrics.value >= 100000);
    el("holdingCount").textContent = metrics.items.length ? `${metrics.items.length} holding${metrics.items.length === 1 ? "" : "s"}` : "No positions yet";
    el("openPnl").textContent = money(metrics.pnl, Math.abs(metrics.pnl) >= 100000);
    el("openPnl").className = metrics.pnl > 0 ? "positive" : metrics.pnl < 0 ? "negative" : "";
    el("openPnlPct").textContent = metrics.items.length ? `${pct(metrics.pnlPct)} on ${metrics.hasFutures ? "entry notional" : "tracked cost"}` : "Add a position to begin";
    el("portfolioBadge").textContent = metrics.items.length;
    el("loadedCount").textContent = `${market.size} / ${watchlist.length}`;
  }

  function renderAiPortfolio() {
    const ledger = state.aiLedger || emptyAiLedger();
    const summary = ledger.summary || emptyAiLedger().summary;
    const config = ledger.config || emptyAiLedger().config;
    const container = el("portfolioContent");
    const equity = Number(summary.cash) + Number(summary.marketValue);
    const totalPnl = equity - Number(summary.allocated);
    const updated = ledger.updatedAt ? new Date(ledger.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "Waiting for first automation run";
    const query = state.aiSearch.trim().toLowerCase();
    const stocks = (ledger.stocks || []).filter((stock) => !query || `${stock.symbol} ${stock.sector} ${stock.marketCapCategory}`.toLowerCase().includes(query));

    const rows = stocks.map((stock) => {
      const anchor = Number(stock.anchor?.price);
      const live = Number(stock.lastPrice);
      const weeklyMove = anchor && live ? (live / anchor - 1) * 100 : null;
      const accountPnl = Number(stock.cash) + Number(stock.marketValue) - config.budgetPerStock;
      const levels = (stock.levels || []).map((price, index) => {
        const filled = Boolean(stock.triggeredLevels?.[index]);
        const next = stock.nextBuy?.level === index + 1;
        return `<span class="ai-level ${filled ? "filled" : ""} ${next ? "next" : ""}"><i>B${index + 1}</i><b>${money(price)}</b><small>${filled ? "FILLED" : next ? "NEXT" : `${3 * (index + 1)}% step`}</small></span>`;
      }).join("") || `<span class="ai-awaiting">Friday reference pending</span>`;
      const targets = (stock.lots || []).slice().sort((a, b) => a.target - b.target).map((lot) => `<span class="ai-target"><i>S${lot.level}</i><b>${money(lot.target)}</b><small>${number(lot.quantity)} shares · +2%</small></span>`).join("") || `<span class="ai-awaiting">No purchased lot needs an exit yet</span>`;
      const status = !stock.anchor ? "Waiting for secure runner" : stock.lots?.length ? `${stock.lots.length} lot${stock.lots.length === 1 ? "" : "s"} waiting for +2%` : stock.nextBuy ? `Watching B${stock.nextBuy.level}` : "Five weekly slots evaluated";
      return `<details class="ai-stock" data-ai-stock="${stock.symbol}">
        <summary>
          <span class="symbol-avatar">${initials(stock.symbol)}</span>
          <span class="ai-stock-name"><b>${stock.symbol}</b><small>${stock.sector} · ${stock.marketCapCategory}</small></span>
          <span><small>Friday close</small><b>${money(anchor)}</b></span>
          <span><small>Tracked price</small><b>${money(live)} <i class="${weeklyMove >= 0 ? "positive" : "negative"}">${pct(weeklyMove)}</i></b></span>
          <span><small>Virtual cash</small><b>${money(Number(stock.cash))}</b></span>
          <span><small>Stock P&amp;L</small><b class="${accountPnl >= 0 ? "positive" : "negative"}">${money(accountPnl)}</b></span>
          <em>${status}</em>
        </summary>
        <div class="ai-stock-body">
          <div><h4>Five compounded buy triggers</h4><p>Each slot can use up to ${money(config.slotBudget)} and fires once per Friday week.</p><div class="ai-levels">${levels}</div></div>
          <div><h4>Open-lot sell triggers</h4><p>Every lot has its own target, exactly ${config.takeProfitPct}% above its paper fill.</p><div class="ai-levels sells">${targets}</div></div>
          <footer><span>Anchor week <b>${stock.anchor?.weekKey || "—"}</b></span><span>Anchor session <b>${stock.anchor?.barDate || "—"}</b></span><span>Invested / hard cap <b>${money(stock.invested)} / ${money(config.budgetPerStock)}</b></span><span>Open P&amp;L <b class="${stock.openPnl >= 0 ? "positive" : "negative"}">${money(stock.openPnl)}</b></span></footer>
        </div>
      </details>`;
    }).join("");

    const activity = (ledger.transactions || []).slice(0, 30).map((trade) => `<div class="ai-trade ${trade.action}">
      <span>${trade.action === "buy" ? "↓" : "↑"}</span><div><b>${trade.symbol} · ${trade.action.toUpperCase()}</b><small>${new Date(trade.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</small></div>
      <div><small>Level</small><b>${trade.action === "buy" ? `B${trade.level}` : "+2% exit"}</b></div><div><small>Quantity</small><b>${number(trade.quantity)}</b></div><div><small>Paper price</small><b>${money(trade.price)}</b></div><div><small>Realized</small><b class="${trade.pnl >= 0 ? "positive" : "negative"}">${trade.action === "sell" ? money(trade.pnl) : "—"}</b></div>
    </div>`).join("") || `<div class="ai-empty"><b>No paper trades yet.</b><span>The ledger is waiting for a stock to cross one of its Friday-based 3% levels.</span></div>`;

    container.innerHTML = `<section class="ai-command">
      <div><p class="eyebrow"><span></span> AUTOMATIC · PAPER ONLY</p><h3>Friday close → five 3% drops → individual 2% exits</h3><p>All ${watchlist.length} stocks are checked every 15 minutes through the NSE market day, Monday–Friday. Each has a hard concurrent deployment cap of ${money(config.budgetPerStock)} and five slots of up to ${money(config.slotBudget)}. Every automatic buy and sell appears below.</p></div>
      <div class="ai-heart"><strong>AI</strong><i></i><span>WATCHING<br />${watchlist.length} STOCKS</span></div>
    </section>
    <div class="portfolio-summary ai-summary">
      <article class="portfolio-mini"><span>Virtual allocation</span><strong>${money(summary.allocated)}</strong></article>
      <article class="portfolio-mini"><span>Total equity</span><strong>${money(equity)}</strong></article>
      <article class="portfolio-mini"><span>Deployed cost</span><strong>${money(summary.invested)}</strong></article>
      <article class="portfolio-mini"><span>Total P&amp;L</span><strong class="${totalPnl >= 0 ? "positive" : "negative"}">${money(totalPnl)}</strong></article>
      <article class="portfolio-mini"><span>Open lots</span><strong>${summary.openLots || 0}</strong></article>
      <article class="portfolio-mini"><span>Last secured run</span><strong class="ai-time">${updated}</strong></article>
    </div>
    <label class="ai-search"><span>⌕</span><input id="aiGridSearch" type="search" placeholder="Find a stock inside the AI grid…" /></label>
    <div class="ai-ledger-head"><span>${stocks.length} of ${ledger.stocks?.length || 0} stocks</span><span>Friday reference</span><span>Live / latest</span><span>Cash</span><span>P&amp;L</span></div>
    <div class="ai-stock-list">${rows || `<div class="ai-empty"><b>No stock matches this search.</b></div>`}</div>
    <div class="portfolio-intro ai-activity-head"><div><p class="eyebrow"><span></span> MACHINE AUDIT TRAIL</p><h2>Every automatic move.</h2></div><p>Paper fills record the rule, level, quantity, reference week and timestamp so the model can be judged rather than trusted blindly.</p></div>
    <div class="ai-trades">${activity}</div>`;
    const input = el("aiGridSearch");
    if (input) {
      input.value = state.aiSearch;
      input.addEventListener("input", () => { state.aiSearch = input.value; renderAiPortfolio(); requestAnimationFrame(() => { const next = el("aiGridSearch"); next?.focus(); next?.setSelectionRange(state.aiSearch.length, state.aiSearch.length); }); });
    }
    renderSummary();
  }

  function renderPortfolio() {
    if (state.user === "ai") { renderAiPortfolio(); return; }
    const metrics = portfolioMetrics();
    const container = el("portfolioContent");
    if (!metrics.items.length) {
      container.innerHTML = `<div class="empty-portfolio"><div><div class="empty-orbit">+</div><h3>Your portfolio is waiting</h3><p>Use any plus button in the watchlist, then enter your actual price and quantity.</p></div></div>`;
      renderSummary();
      return;
    }

    const cards = metrics.items.map((item) => {
      const isFuture = item.assetType === "future";
      const live = isFuture ? item.markPrice : (currentPrice(item.symbol) ?? item.average);
      const spot = currentPrice(item.symbol);
      const data = market.get(item.symbol);
      const value = live * item.quantity;
      const direction = item.position === "short" ? -1 : 1;
      const pnlValue = (live - item.average) * item.quantity * direction;
      const pnlPercent = item.cost ? (pnlValue / item.cost) * 100 : 0;
      const plan = exitPlan(item, data, live);
      const suggestion = data ? personalSignal(item.symbol, data, item) : { action: "loading", label: "LOADING WEEKLY CALL", detail: "Waiting for the latest market session" };
      const lastTarget = plan.targets.at(-1).price;
      const progress = Math.max(0, Math.min(100, direction * (live - item.average) / Math.abs(lastTarget - item.average) * 100));
      const flagProgress = Math.max(4, Math.min(96, progress));
      const targets = plan.targets.map((target, index) => {
        const content = `<span><b>${item.position === "short" ? "C" : "S"}${index + 1}</b><i>${isFuture && !item.exactMark ? "planned level" : target.status === "reached" ? "Reached ✓" : target.status === "close" ? "Very close" : `${number(Math.max(0, target.distance))}% away`}</i></span><strong>${money(target.price)}</strong><small>${pct(target.gainPct)} · ${number(target.rMultiple)} ATR · ${number(plan.slice)} units</small>`;
        return isFuture ? `<div class="exit-band future-band">${content}</div>` : `<button class="exit-band ${target.status}" data-exit-band data-exit-symbol="${item.symbol}" data-exit-price="${target.price}" data-exit-qty="${plan.slice}">${content}</button>`;
      }).join("");
      const expiry = item.expiry ? new Date(`${item.expiry}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "";
      const instrumentCopy = isFuture ? `${item.market} · ${expiry} · ${item.position.toUpperCase()} ${number(item.quantity)}` : `${bySymbol.get(item.symbol)?.marketCapCategory || "Equity"} · ${number(item.quantity)} units · ${item.lots} lot${item.lots === 1 ? "" : "s"}`;
      const markCopy = isFuture && !item.exactMark ? "Broker snapshot" : "Live price";
      const actionMarkup = isFuture ? `<span class="contract-chip ${item.position}">${item.position === "short" ? "SHORT FUTURE" : "LONG FUTURE"}</span>` : `<button class="small-button" data-open-buy="${item.symbol}">Add</button><button class="small-button sell" data-open-sell="${item.symbol}">Reduce</button>`;
      const suggestionAction = !isFuture && suggestion.action === "buy" ? `<button class="suggestion-button" data-open-buy="${item.symbol}">Open buy ticket</button>` : !isFuture && suggestion.action === "sell" ? `<button class="suggestion-button" data-open-sell="${item.symbol}">Open sell ticket</button>` : "";
      return `<article class="holding-shell"><div class="holding-card">
        <div class="symbol-cell"><span class="symbol-avatar">${initials(item.symbol)}</span><div><b>${item.symbol}${isFuture ? " FUT" : ""}</b><small>${instrumentCopy}</small></div></div>
        <div class="holding-metric"><span>Average entry</span><strong>${money(item.average)}</strong></div>
        <div class="holding-metric"><span>${markCopy} · notional</span><strong>${money(live)} · ${money(value)}</strong>${isFuture && Number.isFinite(spot) ? `<small class="spot-reference">Spot reference ${money(spot)}</small>` : ""}</div>
        <div class="holding-metric"><span>Open P&amp;L</span><strong class="${pnlValue >= 0 ? "positive" : "negative"}">${isFuture && !item.exactMark ? "Awaiting futures LTP" : `${money(pnlValue)} · ${pct(pnlPercent)}`}</strong></div>
        <div class="holding-actions">${actionMarkup}</div>
      </div><section class="portfolio-call ${suggestion.action}"><div><span>${isFuture ? "K² SIMPLE ACTION · USING UNDERLYING PRICE" : "K² SIMPLE ACTION · 2% RULE"}</span><strong>${suggestion.label}</strong><p>${suggestion.detail}</p><div class="call-thresholds rule-lines"><b>${item.position === "short" ? "COVER" : "BUY"} ≤ ${money(suggestion.buyAt)}</b><b>MON OPEN ${money(data?.weekly?.openingPrice)}</b><b>${item.position === "short" ? "RISK" : "SELL"} ≥ ${money(suggestion.sellAt)}</b></div><div class="call-thresholds daily-lines"><b>TODAY LOW ${money(data?.daily?.low)}</b><b>NOW ${money(suggestion.current)}</b><b>TODAY HIGH ${money(data?.daily?.high)}</b></div></div>${suggestionAction}</section><section class="exit-plan">
        <div class="exit-plan-head"><div><span>${item.position === "short" ? "FIVE COVER BANDS · BELOW" : "YOUR FIVE EXIT BANDS · ABOVE"} ${money(item.average)} ENTRY</span><h3>${item.position === "short" ? "Price falls → cover one slice" : "Price rises → reduce one slice"}</h3></div><p>Even split: ${number(plan.slice)} of ${number(item.quantity)} units per band. ${isFuture ? "Levels scale the underlying ATR to the contract entry; exact futures LTP is required before a level can be marked reached." : "Tap any band to prefill the reduction."}</p></div>
        <div class="exit-progress ${item.position === "short" ? "short-progress" : ""} ${isFuture && !item.exactMark ? "snapshot-progress" : ""}"><span style="width:${progress}%"></span><i style="left:${flagProgress}%">${isFuture && !item.exactMark ? "ENTRY MARK" : "NOW"} ${money(live)}</i><b>ENTRY ${money(item.average)}</b><b>FINAL ${money(lastTarget)}</b></div>
        <div class="exit-bands">${targets}</div>
        <p class="exit-risk"><b>${isFuture ? "Contract valuation status:" : "Movement-risk reference:"}</b> ${isFuture ? `The imported broker table supplied MTM 0.00 but no current futures LTP, so K² preserves the entry mark and shows ${Number.isFinite(spot) ? `the ${money(spot)} underlying spot` : "underlying spot"} separately—never as the futures price. ` : ""}One ATR adverse reference is ${money(plan.riskLine)}.${data ? ` The calculation uses the underlying ${number(data.signals?.atrPct)}% ATR.` : " Live range data is loading."}</p>
      </section></article>`;
    }).join("");

    const transactions = state.portfolio.transactions.slice(0, 6).map((transaction) => `
      <div class="holding-card">
        <div class="symbol-cell"><span class="symbol-avatar">${transaction.action === "buy" ? "+" : transaction.action === "import" ? "↻" : "−"}</span><div><b>${transaction.action === "import" ? "Broker snapshot" : transaction.symbol}</b><small>${new Date(transaction.time).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div></div>
        <div class="holding-metric"><span>Action</span><strong>${transaction.action === "buy" ? "Added" : transaction.action === "import" ? "Imported" : "Reduced"}</strong></div>
        <div class="holding-metric"><span>Quantity</span><strong>${transaction.action === "import" ? `${number(transaction.count)} contracts` : number(transaction.quantity)}</strong></div>
        <div class="holding-metric"><span>Price</span><strong>${transaction.action === "import" ? "Exact snapshot" : money(transaction.price)}</strong></div><div></div>
      </div>`).join("");

    container.innerHTML = `
      <div class="portfolio-summary">
        <article class="portfolio-mini"><span>${metrics.hasFutures ? "Reference notional" : "Market value"}</span><strong>${money(metrics.value)}</strong></article>
        <article class="portfolio-mini"><span>${metrics.hasFutures ? "Entry notional" : "Invested cost"}</span><strong>${money(metrics.cost)}</strong></article>
        <article class="portfolio-mini"><span>${metrics.hasFutures ? "Realized P&L" : "Realized P&amp;L"}</span><strong class="${state.portfolio.realizedPnl >= 0 ? "positive" : "negative"}">${money(state.portfolio.realizedPnl)}</strong></article>
        <article class="portfolio-mini"><span>Private database</span><strong class="${state.databaseOnline ? "positive" : "negative"}">${state.databaseOnline ? "Synchronized" : "Offline copy"}</strong></article>
      </div>
      <div class="holdings-list">${cards}</div>
      ${transactions ? `<div class="portfolio-intro" style="padding-top:55px;padding-bottom:20px"><div><p class="eyebrow"><span></span> Recent activity</p><h2 style="font-size:38px">Lot journal</h2></div></div><div class="holdings-list">${transactions}</div>` : ""}`;
    renderSummary();
  }

  function setFeedStatus(kind, text) {
    feedPill.className = `feed-pill ${kind || ""}`;
    feedPill.querySelector("span").textContent = text;
  }

  async function fetchSymbols(symbols) {
    const unique = [...new Set(symbols)].filter(Boolean);
    for (let start = 0; start < unique.length; start += 8) {
      const batch = unique.slice(start, start + 8);
      try {
        const response = await fetch(`/api/market?symbols=${encodeURIComponent(batch.join(","))}`);
        const payload = await response.json();
        for (const item of payload.data || []) market.set(item.symbol, item);
        if (!response.ok && !payload.data?.length) throw new Error(payload.error || payload.errors?.[0]?.message || "Market feed unavailable");
      } catch (error) {
        console.warn("K² market batch failed", batch, error);
      }
      renderWatchlist();
      renderFocusMap();
      renderPortfolio();
      if (state.currentSymbol) renderDrawer(state.currentSymbol);
      el("loadedCount").textContent = `${market.size} / ${watchlist.length}`;
    }
  }

  async function refreshAll() {
    if (state.refreshing || !state.user) return;
    state.refreshing = true;
    refreshButton.classList.add("spinning");
    setFeedStatus("", "Updating 31-day maps");
    const owned = holdings().map((item) => item.symbol);
    const symbols = [...new Set([...owned, ...watchlist.map((item) => item.symbol)])];
    await fetchSymbols(symbols);
    state.refreshing = false;
    refreshButton.classList.remove("spinning");
    if (market.size) {
      setFeedStatus("live", "Market feed connected");
      el("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
    } else {
      setFeedStatus("error", "Using workbook snapshot");
      el("lastUpdated").textContent = "Live feed unavailable";
    }
    renderSummary();
  }

  async function refreshPriority() {
    if (state.refreshing || !state.user || document.hidden) return;
    const visible = filteredWatchlist().slice(0, state.visibleLimit).map((item) => item.symbol);
    const owned = holdings().map((item) => item.symbol);
    await fetchSymbols([...new Set([...owned, ...visible])]);
    if (market.size) {
      setFeedStatus("live", "Market feed connected");
      el("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
    }
  }

  function chartSvg(data) {
    const series = data.series || [];
    if (series.length < 2) return "";
    const width = 560, height = 160, top = 12, bottom = 20;
    const min = Math.min(...series.map((item) => item.l));
    const max = Math.max(...series.map((item) => item.h));
    const spread = max - min || 1;
    const x = (index) => (index / (series.length - 1)) * width;
    const y = (value) => top + ((max - value) / spread) * (height - top - bottom);
    const path = series.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item.c).toFixed(1)}`).join(" ");
    const area = `${path} L${width},${height - bottom} L0,${height - bottom} Z`;
    const start = new Date(series[0].t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    const end = new Date(series.at(-1).t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="31-day closing price chart">
      <defs><linearGradient id="chartArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f59d9" stop-opacity=".25"/><stop offset="1" stop-color="#6f59d9" stop-opacity="0"/></linearGradient></defs>
      <line class="chart-guide" x1="0" y1="${y(max)}" x2="${width}" y2="${y(max)}"/><line class="chart-guide" x1="0" y1="${y(min)}" x2="${width}" y2="${y(min)}"/>
      <path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>
      <text class="chart-label" x="0" y="${height}">${start}</text><text class="chart-label" x="${width}" y="${height}" text-anchor="end">${end}</text>
      <text class="chart-label" x="${width}" y="${y(max) - 5}" text-anchor="end">${money(max)}</text><text class="chart-label" x="${width}" y="${y(min) - 5}" text-anchor="end">${money(min)}</text>
    </svg>`;
  }

  function ladderLocation(data) {
    const levels = [
      ...data.ladder.buy.map((price, index) => ({ id: `B${index + 1}`, price, label: `Buy ${index + 1}` })).reverse(),
      { id: "MID", price: data.window.midpoint, label: "midpoint" },
      ...data.ladder.sell.map((price, index) => ({ id: `S${index + 1}`, price, label: `Sell ${index + 1}` }))
    ];
    const tradeLevels = levels.filter((level) => level.id !== "MID");
    const nearest = tradeLevels.reduce((best, level) => Math.abs(level.price - data.price) < Math.abs(best.price - data.price) ? level : best, tradeLevels[0]);
    let location;
    const exact = levels.find((level) => Math.abs(level.price - data.price) < Math.max(.005, data.price * .00001));
    if (exact) location = `at ${exact.id}`;
    else if (data.price < levels[0].price) location = `below ${levels[0].id} — beyond the deepest buy level`;
    else if (data.price > levels.at(-1).price) location = `above ${levels.at(-1).id} — beyond the highest sell level`;
    else {
      const upperIndex = levels.findIndex((level) => data.price <= level.price);
      const upper = levels[upperIndex];
      const lower = levels[Math.max(0, upperIndex - 1)];
      location = lower.id === upper.id ? `at ${upper.id}` : `between ${lower.id} and ${upper.id}`;
    }
    const distancePct = Math.abs(nearest.price - data.price) / data.price * 100;
    return {
      location,
      nearest,
      distancePct,
      side: data.price < data.window.midpoint ? "BUY-SIDE HALF" : "SELL-SIDE HALF"
    };
  }

  function renderDrawer(symbol) {
    if (state.currentSymbol !== symbol) return;
    const item = bySymbol.get(symbol);
    const data = market.get(symbol);
    const container = el("drawerContent");
    if (!data) {
      container.innerHTML = `<div class="drawer-header"><div class="drawer-symbol"><span class="symbol-avatar">${initials(symbol)}</span><div><h2 id="drawerTitle">${symbol}</h2><p>${item?.sector} · ${item?.marketCapCategory} · loading range</p></div></div><div class="drawer-price"><strong>${money(item?.snapshotPrice)}</strong><span>Workbook snapshot</span></div></div><div class="drawer-chart"><div class="range-loading" style="margin-top:80px"></div></div><p class="formula-note">Fetching the latest quote and 31-calendar-day high/low map…</p>`;
      return;
    }
    const changeClass = data.changePct >= 0 ? "positive" : "negative";
    const time = new Date(data.exchangeTime * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    const location = ladderLocation(data);
    const steps = (values, type) => values.map((value, index) => {
      const id = `${type === "buy" ? "B" : "S"}${index + 1}`;
      const nearest = id === location.nearest.id;
      return `<div class="ladder-step ${index >= 3 ? "outside-step" : ""} ${nearest ? "nearest-step" : ""}"><i>${index + 1}</i><small>${nearest ? `NEXT · ${number(location.distancePct)}% away` : index >= 3 ? "outside range" : index === 2 ? "range edge" : "inside range"}</small><strong>${money(value)}</strong></div>`;
    }).join("");
    container.innerHTML = `
      <div class="drawer-header">
        <div class="drawer-symbol"><span class="symbol-avatar">${initials(symbol)}</span><div><h2 id="drawerTitle">${symbol}</h2><p>${item?.sector} · ${item?.marketCapCategory} · quote ${time}</p></div></div>
        <div class="drawer-price"><strong>${money(data.price)}</strong><span class="${changeClass}">${pct(data.changePct)} today</span></div>
      </div>
      <div class="drawer-chart">${chartSvg(data)}</div>
      <div class="range-stats range-core">
        <div class="range-stat"><span>31-day low</span><strong>${money(data.window.low)}</strong></div>
        <div class="range-stat"><span>Midpoint</span><strong>${money(data.window.midpoint)}</strong></div>
        <div class="range-stat"><span>31-day high</span><strong>${money(data.window.high)}</strong></div>
      </div>
      ${(() => { const pulse = pulseDescription(data); return `<section class="trade-pulse ${pulse.tone}"><div class="pulse-orb"><b>${data.signals?.pulseScore > 0 ? "+" : ""}${data.signals?.pulseScore ?? 0}</b><span>of ±3</span></div><div><span>K² REGIME ENGINE · ${String(data.signals?.marketRegime || "transition").toUpperCase()}</span><h3>${pulse.label}</h3><p>${pulse.detail}. ${pulse.method}</p></div></section>`; })()}
      <div class="signal-grid">${indicatorCards(data).map((card) => `<article class="signal-card ${card.tone}"><span>${card.name}</span><div><strong>${card.value}</strong><b>${card.label}</b></div><p>${card.note}</p></article>`).join("")}</div>
      <p class="signal-key"><b>Colour key:</b> green = constructive or calmer · coral = adverse or high-risk · amber = stretched/active · grey = neutral. No colour is a promise.</p>
      <div class="ladder-title"><h3>Five-chunk price map</h3><span>${data.window.sessions} market sessions in 31 days</span></div>
      <section class="live-ladder-location"><div><span>LIVE LOCATION · ${location.side}</span><strong>NOW ${money(data.price)}</strong></div><div><h4>${location.location}</h4><p>Nearest level: <b>${location.nearest.id} at ${money(location.nearest.price)}</b> · ${number(location.distancePct)}% away · Quant verdict: <b>${pulseDescription(data).label}</b></p></div></section>
      <div class="ladder-columns"><div class="ladder-column buy"><span>BUY-SIDE LEVELS ↓</span>${steps(data.ladder.buy, "buy")}</div><div class="ladder-column sell"><span>SELL-SIDE LEVELS ↑</span>${steps(data.ladder.sell, "sell")}</div></div>
      ${state.user === "ai" ? `<button class="drawer-action" data-open-ai-grid>OPEN AI PAPER GRID →</button>` : `<button class="drawer-action" data-drawer-add="${symbol}">ADD ${symbol} TO PORTFOLIO →</button>`}
      <p class="formula-note">Range state: <b>${regimeLabel(data.regime)}</b>. Levels are mechanical reference points based only on rolling high, low, and ATR—not a forecast. Levels 4–5 deliberately sit outside the observed range and may never trade.</p>`;
  }

  async function openDrawer(symbol) {
    state.currentSymbol = symbol;
    el("detailDrawer").classList.add("open");
    el("detailDrawer").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    renderDrawer(symbol);
    if (!market.has(symbol)) {
      await fetchSymbols([symbol]);
      renderDrawer(symbol);
    }
  }

  function closeDrawer() {
    state.currentSymbol = null;
    el("detailDrawer").classList.remove("open");
    el("detailDrawer").setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function openTrade(symbol, action = "buy") {
    if (state.user === "ai") { toast("The AI account records only automatic paper fills."); return; }
    state.tradeSymbol = symbol;
    const holding = holdings().find((item) => item.symbol === symbol);
    const price = currentPrice(symbol) ?? holding?.average ?? "";
    el("tradeAction").value = action;
    el("tradeTitle").textContent = action === "buy" ? "Add a position" : "Reduce a position";
    el("tradeSymbol").textContent = `${symbol} · NSE`;
    el("priceLabel").textContent = action === "buy" ? "Your entry price" : "Your exit price";
    el("tradeSubmit").innerHTML = action === "buy" ? "Add to portfolio <span>→</span>" : "Record reduction <span>→</span>";
    el("tradePrice").value = Number.isFinite(price) ? price : "";
    el("tradeQuantity").value = action === "sell" && holding ? holding.quantity : "";
    el("tradeQuantity").max = action === "sell" && holding ? holding.quantity : "";
    el("quantityHint").textContent = action === "sell" && holding ? `Available: ${number(holding.quantity)}` : "Shares or units";
    el("livePriceHint").textContent = `Latest tracked price: ${money(currentPrice(symbol))}`;
    updateOrderAmount();
    el("tradeModal").classList.add("open");
    el("tradeModal").setAttribute("aria-hidden", "false");
    setTimeout(() => el("tradePrice").focus(), 100);
  }

  function closeTrade() {
    el("tradeModal").classList.remove("open");
    el("tradeModal").setAttribute("aria-hidden", "true");
    state.tradeSymbol = null;
  }

  function updateOrderAmount() {
    const price = Number(el("tradePrice").value);
    const quantity = Number(el("tradeQuantity").value);
    el("orderAmount").textContent = money(price * quantity || 0);
  }

  function addLot(symbol, price, quantity) {
    state.portfolio.lots.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, symbol, price, quantity, time: Date.now() });
  }

  function sellLots(symbol, price, quantity) {
    let remaining = quantity;
    let realized = 0;
    const next = [];
    for (const lot of state.portfolio.lots) {
      if (lot.symbol !== symbol || remaining <= 0) { next.push(lot); continue; }
      const used = Math.min(remaining, Number(lot.quantity));
      realized += (price - Number(lot.price)) * used;
      remaining -= used;
      const left = Number(lot.quantity) - used;
      if (left > 0.0000001) next.push({ ...lot, quantity: left });
    }
    state.portfolio.lots = next;
    state.portfolio.realizedPnl += realized;
    return realized;
  }

  function toast(message) {
    const node = el("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 2800);
  }

  function populateSectorFilter() {
    const select = el("sectorFilter");
    const sectors = [...new Set(watchlist.map((item) => item.sector))].sort();
    select.innerHTML = `<option value="all">All sectors</option>${sectors.map((sector) => `<option value="${sector}">${sector}</option>`).join("")}`;
  }

  function startAmbientExperience() {
    const canvas = el("k2Ambient");
    const context = canvas?.getContext("2d");
    if (!context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, points = [], pointer = { x: -999, y: -999 }, scrollPhase = 0, lastFrame = 0, lastSpark = 0;
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(54, Math.max(22, Math.round(width * height / 26000)));
      points = Array.from({ length: count }, (_, index) => ({
        x: Math.random() * width, y: Math.random() * height,
        vx: (Math.random() - .5) * .16, vy: (Math.random() - .5) * .16,
        size: index % 9 === 0 ? 2.1 : .7 + Math.random() * 1.1,
        colour: index % 3
      }));
    };
    const draw = (time = 0) => {
      if (document.body.classList.contains("fx-quiet")) {
        context.clearRect(0, 0, width, height);
        if (!reduced) state.ambientFrame = requestAnimationFrame(draw);
        return;
      }
      if (time - lastFrame < 32 && !reduced) { state.ambientFrame = requestAnimationFrame(draw); return; }
      lastFrame = time;
      context.clearRect(0, 0, width, height);
      const idleBoost = document.body.classList.contains("k2-idle") ? 1.65 : 1;
      points.forEach((point, index) => {
        if (!reduced) {
          const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y) || 1;
          if (distance < 150) { point.vx += (pointer.x - point.x) / distance * .002; point.vy += (pointer.y - point.y) / distance * .002; }
          point.x += point.vx * idleBoost; point.y += point.vy * idleBoost;
        }
        if (point.x < -15) point.x = width + 15; if (point.x > width + 15) point.x = -15;
        if (point.y < -15) point.y = height + 15; if (point.y > height + 15) point.y = -15;
        const visualY = (point.y + scrollPhase * (index % 3 - 1) + height) % height;
        context.beginPath(); context.arc(point.x, visualY, point.size, 0, Math.PI * 2);
        context.fillStyle = point.colour === 0 ? "rgba(111,89,217,.7)" : point.colour === 1 ? "rgba(22,122,98,.58)" : "rgba(255,130,111,.58)"; context.fill();
        for (let otherIndex = index + 1; otherIndex < points.length; otherIndex += 1) {
          const other = points[otherIndex];
          const otherY = (other.y + scrollPhase * (otherIndex % 3 - 1) + height) % height;
          const distance = Math.hypot(point.x - other.x, visualY - otherY);
          if (distance < 105) { context.beginPath(); context.moveTo(point.x, visualY); context.lineTo(other.x, otherY); context.strokeStyle = `rgba(111,89,217,${(1 - distance / 105) * .11 * idleBoost})`; context.stroke(); }
        }
      });
      if (!reduced) state.ambientFrame = requestAnimationFrame(draw);
    };
    const spawnSpark = (x, y, burst = false) => {
      if (!state.user || reduced) return;
      const marks = ["✦", "♡", "K²", "✨", "⚡", "📈"];
      const count = burst ? 5 : 1;
      for (let index = 0; index < count; index += 1) {
        const spark = document.createElement("span");
        spark.className = "gesture-spark"; spark.textContent = marks[Math.floor(Math.random() * marks.length)];
        spark.style.left = `${x + (Math.random() - .5) * 24}px`; spark.style.top = `${y + (Math.random() - .5) * 12}px`;
        spark.style.setProperty("--spark-x", `${(Math.random() - .5) * 105}px`);
        spark.style.setProperty("--spark-size", `${12 + Math.random() * 9}px`);
        spark.style.animationDelay = `${index * 35}ms`;
        el("gestureSparks").appendChild(spark);
        setTimeout(() => spark.remove(), 1650);
      }
      if (burst) {
        const ripple = document.createElement("i"); ripple.className = "gesture-ripple";
        ripple.style.left = `${x}px`; ripple.style.top = `${y}px`; el("gestureSparks").appendChild(ripple);
        setTimeout(() => ripple.remove(), 900);
      }
    };
    let idleTimer;
    const wake = () => { document.body.classList.remove("k2-idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add("k2-idle"), 8000); };
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", () => { scrollPhase = window.scrollY * .025; wake(); }, { passive: true });
    document.addEventListener("pointermove", (event) => {
      pointer = { x: event.clientX, y: event.clientY }; wake();
      if (event.buttons && performance.now() - lastSpark > 110) { spawnSpark(event.clientX, event.clientY); lastSpark = performance.now(); }
    }, { passive: true });
    document.addEventListener("pointerdown", (event) => { spawnSpark(event.clientX, event.clientY, true); wake(); }, { passive: true });
    document.addEventListener("keydown", wake, { passive: true });
    resize(); draw(); wake();
  }

  function initializeLivingField() {
    const button = el("fxToggleButton");
    const stage = el("k2BondStage");
    const hero = document.querySelector(".hero");
    const quiet = localStorage.getItem("k2-fx-mode") === "quiet" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const setMode = (isQuiet) => {
      document.body.classList.toggle("fx-quiet", isQuiet);
      button.setAttribute("aria-pressed", String(!isQuiet));
      button.querySelector("span").textContent = isQuiet ? "FX QUIET" : "FX LIVE";
      localStorage.setItem("k2-fx-mode", isQuiet ? "quiet" : "live");
    };
    setMode(quiet);
    button.addEventListener("click", () => setMode(!document.body.classList.contains("fx-quiet")));
    stage.addEventListener("pointermove", (event) => {
      if (document.body.classList.contains("fx-quiet")) return;
      const rect = stage.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - .5;
      const y = (event.clientY - rect.top) / rect.height - .5;
      stage.style.setProperty("--tilt-x", `${(x * 13).toFixed(2)}deg`);
      stage.style.setProperty("--tilt-y", `${(-y * 10).toFixed(2)}deg`);
    });
    stage.addEventListener("pointerleave", () => { stage.style.setProperty("--tilt-x", "0deg"); stage.style.setProperty("--tilt-y", "0deg"); });
    hero.addEventListener("pointermove", (event) => {
      const rect = hero.getBoundingClientRect();
      hero.style.setProperty("--hero-x", `${(((event.clientX - rect.left) / rect.width - .5) * 8).toFixed(2)}%`);
      hero.style.setProperty("--hero-y", `${(((event.clientY - rect.top) / rect.height - .5) * 8).toFixed(2)}%`);
    });
    const updateScroll = () => {
      document.documentElement.style.setProperty("--k2-scroll", String(Math.min(12, window.scrollY / 240)));
      const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      el("scrollVfx").style.setProperty("--scroll-progress", (window.scrollY / maximum).toFixed(4));
    };
    window.addEventListener("scroll", updateScroll, { passive: true }); updateScroll();
  }

  function initializeRevealChoreography() {
    const selector = ".hero-copy,.k2-bond-stage,.snapshot-card,.section-tabs,.toolbar,.method-strip,.focus-map,.stock-row,.portfolio-intro,.portfolio-mini,.holding-shell,.signal-card,.exit-band,.system-note";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in-view"); observer.unobserve(entry.target);
      });
    }, { threshold: .08, rootMargin: "0px 0px -5% 0px" });
    const attach = (root = document) => {
      const nodes = [];
      if (root.nodeType === 1 && root.matches?.(selector)) nodes.push(root);
      root.querySelectorAll?.(selector).forEach((node) => nodes.push(node));
      nodes.forEach((node, index) => {
        if (node.classList.contains("reveal-item")) return;
        node.classList.add("reveal-item");
        node.style.setProperty("--reveal-delay", `${(index % 6) * 55}ms`);
        if (reduced) node.classList.add("in-view"); else state.revealObserver.observe(node);
      });
    };
    attach(document);
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === 1) attach(node);
    }))).observe(document.body, { childList: true, subtree: true });
  }

  function startStoryCanvas() {
    const canvas = el("dedicationCanvas");
    const context = canvas.getContext("2d");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, particles = [];
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(90, Math.max(34, Math.round((width * height) / 19000)));
      particles = Array.from({ length: count }, (_, index) => ({
        x: Math.random() * width, y: Math.random() * height,
        vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22,
        radius: index % 11 === 0 ? 2.2 : Math.random() * 1.3 + .4,
        hue: index % 3
      }));
    };
    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        if (!reduced) { particle.x += particle.vx; particle.y += particle.vy; }
        if (particle.x < -10) particle.x = width + 10; if (particle.x > width + 10) particle.x = -10;
        if (particle.y < -10) particle.y = height + 10; if (particle.y > height + 10) particle.y = -10;
        context.beginPath(); context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = particle.hue === 0 ? "rgba(168,223,197,.9)" : particle.hue === 1 ? "rgba(240,204,85,.75)" : "rgba(255,255,255,.62)"; context.fill();
        for (let j = i + 1; j < particles.length; j += 1) {
          const other = particles[j], distance = Math.hypot(particle.x - other.x, particle.y - other.y);
          if (distance < 110) { context.beginPath(); context.moveTo(particle.x, particle.y); context.lineTo(other.x, other.y); context.strokeStyle = `rgba(168,223,197,${(1 - distance / 110) * .14})`; context.stroke(); }
        }
      }
      if (!reduced) state.storyFrame = requestAnimationFrame(draw);
    };
    resize(); draw();
    window.addEventListener("resize", resize, { once: true });
  }

  function showStory(force = false) {
    if (!state.user) return;
    const lastSeen = Number(localStorage.getItem(`k2-story-seen:${state.user}`)) || 0;
    if (!force && Date.now() - lastSeen < 24 * 60 * 60 * 1000) return;
    const intro = el("dedicationIntro");
    intro.classList.add("open");
    intro.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    cancelAnimationFrame(state.storyFrame);
    startStoryCanvas();
  }

  function closeStory() {
    const intro = el("dedicationIntro");
    intro.classList.remove("open");
    intro.setAttribute("aria-hidden", "true");
    cancelAnimationFrame(state.storyFrame);
    state.storyFrame = null;
    if (state.user) localStorage.setItem(`k2-story-seen:${state.user}`, String(Date.now()));
    document.body.style.overflow = "";
  }

  async function activateSession(session) {
    state.user = session.username;
    state.displayName = session.displayName || session.username;
    state.csrf = session.csrf;
    state.portfolio = loadPortfolio();
    state.aiLedger = emptyAiLedger();
    const aiMode = state.user === "ai";
    el("portfolioTabLabel").textContent = aiMode ? "AI Paper Grid" : "Portfolio";
    el("portfolioOverline").textContent = aiMode ? "Autonomous Friday-grid laboratory" : "Private cloud portfolio";
    el("portfolioHeading").innerHTML = aiMode ? `The machine watches,<br /><em>the ledger remembers.</em>` : `Your positions,<br /><em>measured live.</em>`;
    el("portfolioIntroCopy").textContent = aiMode
      ? "K² AI paper-trades the complete workbook universe from Friday closing anchors. Every simulated fill is automatic, isolated and auditable across devices."
      : "Entry lots are stored securely under your signed-in account and follow you across devices. Current value and open P&L move with the same market feed as your watchlist.";
    el("methodCopy").innerHTML = aiMode
      ? "<b>AI weekly rule:</b> completed Friday close becomes the anchor; five ₹40,000 slots compound downward by 3%; every filled lot receives its own automatic +2% paper exit."
      : "<b>How it works:</b> five buy chunks step down below the 31-day midpoint; five sell chunks step up above it. Levels 4–5 deliberately extend beyond the monthly low or high.";
    el("userName").textContent = state.displayName;
    el("userPill").classList.remove("hidden");
    el("authGate").classList.add("signed-in");
    el("loginPassword").value = "";
    el("loginError").textContent = "";
    renderWatchlist();
    renderFocusMap();
    renderPortfolio();
    renderSummary();
    setTimeout(() => showStory(false), 250);
    if (aiMode) await syncAiLedger(); else await syncServerPortfolio();
    if (!market.size) refreshAll(); else refreshPriority();
    if (!state.refreshTimer) state.refreshTimer = setInterval(refreshPriority, 60_000);
    if (aiMode && !state.aiRefreshTimer) state.aiRefreshTimer = setInterval(syncAiLedger, 60_000);
  }

  function showLogin() {
    state.user = null;
    state.displayName = null;
    state.csrf = null;
    state.databaseOnline = false;
    closeStory();
    state.portfolio = emptyPortfolio();
    state.aiLedger = emptyAiLedger();
    state.aiSearch = "";
    clearInterval(state.aiRefreshTimer);
    state.aiRefreshTimer = null;
    el("portfolioTabLabel").textContent = "Portfolio";
    el("userPill").classList.add("hidden");
    el("authGate").classList.remove("signed-in");
    setTimeout(() => el("loginUsername").focus(), 100);
  }

  async function bootstrapAuth() {
    populateSectorFilter();
    el("bandFilter").value = "all";
    el("sectorFilter").value = "all";
    el("capFilter").value = "all";
    el("modelFilter").value = "all";
    el("sortSelect").value = "journal";
    renderWatchlist();
    renderFocusMap();
    renderPortfolio();
    renderSummary();
    try {
      const response = await fetch("/api/auth", { credentials: "same-origin" });
      const session = await response.json();
      if (response.ok && session.authenticated) await activateSession(session);
      else showLogin();
    } catch {
      el("loginError").textContent = "The sign-in service is unavailable. Please reload.";
      showLogin();
    }
  }

  stockList.addEventListener("click", (event) => {
    const reset = event.target.closest("[data-reset-filters]");
    if (reset) { el("searchInput").value = ""; el("bandFilter").value = "all"; el("sectorFilter").value = "all"; el("capFilter").value = "all"; el("modelFilter").value = "all"; state.visibleLimit = 30; renderWatchlist(); return; }
    const add = event.target.closest("[data-add]");
    if (add) { event.stopPropagation(); openTrade(add.dataset.add); return; }
    const row = event.target.closest("[data-symbol]");
    if (row) { state.focusSymbol = row.dataset.symbol; renderFocusMap(); openDrawer(row.dataset.symbol); }
  });
  stockList.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-symbol]")) openDrawer(event.target.dataset.symbol);
  });

  el("portfolioContent").addEventListener("click", (event) => {
    const exitBand = event.target.closest("[data-exit-band]");
    const buy = event.target.closest("[data-open-buy]");
    const sell = event.target.closest("[data-open-sell]");
    if (exitBand) {
      openTrade(exitBand.dataset.exitSymbol, "sell");
      el("tradePrice").value = Number(exitBand.dataset.exitPrice).toFixed(2);
      el("tradeQuantity").value = Number(exitBand.dataset.exitQty).toFixed(4).replace(/\.?0+$/, "");
      updateOrderAmount();
      return;
    }
    if (buy) openTrade(buy.dataset.openBuy, "buy");
    if (sell) openTrade(sell.dataset.openSell, "sell");
  });
  el("drawerContent").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-ai-grid]")) { closeDrawer(); document.querySelector('[data-tab="portfolio"]').click(); return; }
    const add = event.target.closest("[data-drawer-add]");
    if (add) { closeDrawer(); openTrade(add.dataset.drawerAdd); }
  });
  el("focusMap").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-ai-grid]")) { document.querySelector('[data-tab="portfolio"]').click(); return; }
    const add = event.target.closest("[data-focus-add]");
    if (add) openTrade(add.dataset.focusAdd, "buy");
  });

  el("tradeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const symbol = state.tradeSymbol;
    const action = el("tradeAction").value;
    const price = Number(el("tradePrice").value);
    const quantity = Number(el("tradeQuantity").value);
    if (!symbol || !(price > 0) || !(quantity > 0)) return;
    const holding = holdings().find((item) => item.symbol === symbol);
    if (action === "sell" && (!holding || quantity > holding.quantity + 0.0000001)) {
      toast("Quantity is larger than the tracked holding.");
      return;
    }
    const button = el("tradeSubmit");
    button.disabled = true;
    button.innerHTML = "Saving securely…";
    try {
      state.portfolio = await portfolioMutation(action, symbol, price, quantity);
      state.databaseOnline = true;
      savePortfolio();
      closeTrade();
      renderPortfolio();
      renderSummary();
      toast(action === "buy" ? `${symbol} added and synchronized.` : `${symbol} reduction synchronized.`);
    } catch (error) {
      state.databaseOnline = false;
      toast(error.message || "Portfolio update failed");
    } finally {
      button.disabled = false;
      button.innerHTML = action === "buy" ? "Add to portfolio <span>→</span>" : "Record reduction <span>→</span>";
    }
  });

  [el("tradePrice"), el("tradeQuantity")].forEach((node) => node.addEventListener("input", updateOrderAmount));
  document.querySelectorAll("[data-close-modal]").forEach((node) => node.addEventListener("click", closeTrade));
  el("drawerClose").addEventListener("click", closeDrawer);
  el("drawerBackdrop").addEventListener("click", closeDrawer);
  document.querySelectorAll("[data-close-method]").forEach((node) => node.addEventListener("click", () => el("methodModal").classList.remove("open")));
  el("methodButton").addEventListener("click", () => el("methodModal").classList.add("open"));
  refreshButton.addEventListener("click", () => { refreshAll(); if (state.user === "ai") syncAiLedger(); });
  el("loadMoreButton").addEventListener("click", () => { state.visibleLimit += 30; renderWatchlist(); refreshPriority(); });
  [el("searchInput"), el("bandFilter"), el("sectorFilter"), el("capFilter"), el("modelFilter"), el("sortSelect")].forEach((node) => node.addEventListener(node.tagName === "INPUT" ? "input" : "change", () => { state.visibleLimit = 30; renderWatchlist(); }));

  el("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = el("loginButton");
    button.disabled = true;
    button.innerHTML = "Checking account…";
    el("loginError").textContent = "";
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: el("loginUsername").value, password: el("loginPassword").value })
      });
      const session = await response.json();
      if (!response.ok) throw new Error(session.error || "Sign-in failed.");
      await activateSession(session);
    } catch (error) {
      el("loginError").textContent = error.message || "Sign-in failed.";
    } finally {
      button.disabled = false;
      button.innerHTML = "Enter range desk <span>→</span>";
    }
  });

  el("logoutButton").addEventListener("click", async () => {
    try { await fetch("/api/auth", { method: "DELETE", credentials: "same-origin", headers: { "X-K2-CSRF": state.csrf } }); } catch { /* local logout still proceeds */ }
    showLogin();
  });
  el("replayStoryButton").addEventListener("click", () => showStory(true));
  el("storySkip").addEventListener("click", closeStory);
  el("storyEnter").addEventListener("click", closeStory);
  el("dedicationIntro").addEventListener("pointermove", (event) => {
    const x = (event.clientX / window.innerWidth - .5) * 2;
    const y = (event.clientY / window.innerHeight - .5) * 2;
    el("dedicationIntro").style.setProperty("--story-x", `${(x * 10).toFixed(2)}px`);
    el("dedicationIntro").style.setProperty("--story-y", `${(y * 10).toFixed(2)}px`);
  });

  document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((node) => node.classList.toggle("active", node === button));
    document.querySelectorAll(".workspace-panel").forEach((panel) => panel.classList.remove("active"));
    el(button.dataset.tab === "watchlist" ? "watchlistPanel" : "portfolioPanel").classList.add("active");
    if (button.dataset.tab === "portfolio") renderPortfolio();
  }));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeDrawer();
    closeTrade();
    closeStory();
    el("methodModal").classList.remove("open");
  });

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));
  initializeLivingField();
  startAmbientExperience();
  initializeRevealChoreography();
  bootstrapAuth();
})();
