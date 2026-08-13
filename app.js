(() => {
  "use strict";

  const watchlist = Array.isArray(window.WATCHLIST) ? window.WATCHLIST : [];
  const bySymbol = new Map(watchlist.map((item, index) => [item.symbol, { ...item, index }]));
  const market = new Map();
  const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
  const compactCurrency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 2 });

  const state = {
    visibleLimit: 30,
    actionFilter: "all",
    portfolioFilters: { query: "", band: "all", sector: "all", cap: "all", model: "all", sort: "journal", action: "all" },
    currentSymbol: null,
    focusSymbol: watchlist[0]?.symbol || null,
    tradeSymbol: null,
    refreshing: false,
    user: null,
    displayName: null,
    csrf: null,
    databaseOnline: false,
    refreshTimer: null,
    ambientFrame: null,
    revealObserver: null,
    portfolio: emptyPortfolio(),
    aiLedger: emptyAiLedger(),
    aiSearch: "",
    aiCapFilter: "all",
    aiVisibleLimit: 50,
    aiRefreshTimer: null,
    portfolioRefreshTimer: null,
    aiLoading: false,
    aiError: null,
    aiSyncing: false,
    plannerKey: null,
    mobileFocusExpanded: false,
    mobileExpandedHoldings: new Set(),
    lastScrollAt: 0,
    marketRenderTimer: null
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
      config: { budgetPerStock: 200000, slots: 5, slotBudget: 40000, buyStepPct: 2, takeProfitPct: 2 },
      summary: { allocated: watchlist.length * 200000, cash: watchlist.length * 200000, marketValue: 0, invested: 0, openPnl: 0, realizedPnl: 0, openLots: 0, activeStocks: 0 },
      universe: { name: "Broad NSE universe", officialStocks: 0, continuityStocks: 0, totalStocks: 0, categories: { large: 0, mid: 0, small: 0, other: 0 } },
      stocks: [], transactions: [], updatedAt: null
    };
  }

  function loadCachedAiLedger() {
    try {
      const cached = JSON.parse(localStorage.getItem("k2-ai-ledger-v1"));
      return Array.isArray(cached?.stocks) && cached.stocks.length ? cached : null;
    } catch {
      return null;
    }
  }

  function cacheAiLedger(ledger) {
    try { localStorage.setItem("k2-ai-ledger-v1", JSON.stringify(ledger)); } catch { /* backend remains authoritative */ }
  }

  function loadPortfolio() {
    // A signed-in portfolio has exactly one authority: the private server store.
    // Never revive the retired workbook/localStorage portfolio on another device.
    return emptyPortfolio();
  }

  function savePortfolio() {
    // Deliberately do not persist broker or portfolio data in this browser.
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
    try {
      const response = await fetch(`/api/portfolio?fresh=${Date.now()}`, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Portfolio database unavailable");
      state.portfolio = payload.portfolio;
      state.databaseOnline = true;
      renderPortfolio();
      renderSummary();
    } catch (error) {
      state.databaseOnline = false;
      state.portfolio = emptyPortfolio();
      renderPortfolio();
      renderSummary();
      toast(`${error.message}. No browser-stored portfolio is being substituted.`);
    }
  }

  async function syncAiLedger() {
    if (state.user !== "ai" || state.aiSyncing) return;
    state.aiSyncing = true;
    state.aiLoading = true;
    state.aiError = null;
    if (!state.aiLedger.stocks?.length) renderAiPortfolio();
    renderSummary();
    try {
      let payload = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !payload; attempt += 1) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 25_000);
          const response = await fetch("/api/ai", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
          clearTimeout(timeout);
          const candidate = await response.json();
          if (!response.ok) throw new Error(candidate.error || "AI paper ledger unavailable");
          payload = candidate;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
        }
      }
      if (!payload) throw lastError || new Error("AI paper ledger unavailable");
      state.aiLedger = payload;
      cacheAiLedger(payload);
      el("lastUpdated").textContent = payload.updatedAt
        ? `AI scan ${new Date(payload.updatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`
        : "Waiting for first broad-market scan";
      state.databaseOnline = true;
      renderWatchlist();
      renderFocusMap();
    } catch (error) {
      state.databaseOnline = false;
      state.aiError = error.message || "AI paper ledger unavailable";
      toast(`${state.aiError}. Tap retry in the AI grid.`);
    } finally {
      state.aiLoading = false;
      state.aiSyncing = false;
      renderAiPortfolio();
      renderSummary();
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
    const return63 = Number(data.signals?.return63Pct) || 0;
    const sma20Gap = Number(data.signals?.sma20GapPct) || 0;
    const sma50Gap = Number(data.signals?.sma50GapPct) || 0;
    const downsideVol = Number(data.signals?.downsideVolatility63Pct) || 0;
    const drawdown = Number(data.signals?.maxDrawdown63Pct) || 0;
    const volumeRatio = Number(data.signals?.volumeRatio5To20) || 0;
    const adjustedMomentum = Number(data.signals?.volatilityAdjustedMomentum) || 0;
    const riskMultiplier = Number(data.signals?.riskBudgetMultiplier) || 0;
    const closeLocation = Number(data.signals?.closeLocationPct) || 0;
    const efficiency = Number(data.signals?.efficiencyRatio20) || 0;
    const autocorrelation = Number(data.signals?.returnAutocorrelation20) || 0;
    const parkinsonVol = Number(data.signals?.parkinsonVolatility20Pct) || 0;
    const entropy = Number(data.signals?.directionEntropy20Pct) || 0;
    const candlePattern = data.signals?.candlePattern || "balanced candle";
    const donchian = data.signals?.donchianState || "inside 20-session channel";
    const weeklySample = Number(data.empirical?.weeks) || 0;
    const downHit = Number.isFinite(data.empirical?.down2HitPct) ? Number(data.empirical.down2HitPct) : null;
    const upHit = Number.isFinite(data.empirical?.up2HitPct) ? Number(data.empirical.up2HitPct) : null;
    const analog = data.analogModel || {};
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
    const quarterMomentum = return63 > 4
      ? { tone: "calm", label: "Three-month trend is rising", note: "Medium-speed momentum supports the upside" }
      : return63 < -4
        ? { tone: "danger", label: "Three-month trend is falling", note: "Medium-speed momentum remains adverse" }
        : { tone: "neutral", label: "Three-month trend is flat", note: "No strong medium-speed direction" };
    const averageStack = sma20Gap > 0 && sma50Gap > 0
      ? { tone: "calm", label: "Above both trend averages", note: `20-session ${pct(sma20Gap)} · 50-session ${pct(sma50Gap)}` }
      : sma20Gap < 0 && sma50Gap < 0
        ? { tone: "danger", label: "Below both trend averages", note: `20-session ${pct(sma20Gap)} · 50-session ${pct(sma50Gap)}` }
        : { tone: "active", label: "Fast and slow trends disagree", note: `20-session ${pct(sma20Gap)} · 50-session ${pct(sma50Gap)}` };
    const downsideCard = downsideVol < 18
      ? { tone: "calm", label: "Contained downside movement", note: "Negative-return variation has been relatively small" }
      : downsideVol < 35
        ? { tone: "active", label: "Meaningful downside movement", note: "Size the trade with room for adverse swings" }
        : { tone: "danger", label: "Heavy downside movement", note: "Recent negative moves have been unusually wide" };
    const drawdownCard = drawdown < 8
      ? { tone: "calm", label: "Shallow three-month drawdown", note: "Smallest peak-to-trough damage in this band" }
      : drawdown < 16
        ? { tone: "active", label: "Visible three-month drawdown", note: "Recovery risk is material" }
        : { tone: "danger", label: "Deep three-month drawdown", note: "Trend damage is substantial" };
    const volumeCard = volumeRatio >= 1.25
      ? { tone: "active", label: "Participation is expanding", note: `${number(volumeRatio)}× the 20-session average volume` }
      : volumeRatio <= .7
        ? { tone: "neutral", label: "Participation is thin", note: `${number(volumeRatio)}× the 20-session average volume` }
        : { tone: "neutral", label: "Participation is normal", note: `${number(volumeRatio)}× the 20-session average volume` };
    const adjustedCard = adjustedMomentum > .15
      ? { tone: "calm", label: "Trend reward exceeds movement", note: "Three-month return is positive after volatility adjustment" }
      : adjustedMomentum < -.15
        ? { tone: "danger", label: "Adverse trend after risk adjustment", note: "Three-month direction remains negative versus movement" }
        : { tone: "neutral", label: "Little risk-adjusted direction", note: "Movement is not producing a clear trend" };
    const analogCard = !analog.ready
      ? { tone: "neutral", label: "Model is still data-limited", note: analog.reason || "More stored history is required" }
      : Number(analog.walkForwardAccuracyPct) < 52
        ? { tone: "active", label: "Analog model has weak validation", note: `${number(analog.walkForwardAccuracyPct)}% walk-forward accuracy across ${analog.validationTrades} tests` }
        : Number(analog.probabilityUp5Pct) >= 60
          ? { tone: "calm", label: "Similar histories leaned upward", note: `${analog.neighbours} nearest analogues · ${number(analog.walkForwardAccuracyPct)}% walk-forward accuracy` }
          : Number(analog.probabilityUp5Pct) <= 40
            ? { tone: "danger", label: "Similar histories leaned downward", note: `${analog.neighbours} nearest analogues · ${number(analog.walkForwardAccuracyPct)}% walk-forward accuracy` }
            : { tone: "neutral", label: "Similar histories are split", note: `${analog.neighbours} nearest analogues · ${number(analog.walkForwardAccuracyPct)}% walk-forward accuracy` };
    const candleCard = closeLocation >= 70
      ? { tone: "calm", label: "Session closed with buyers", note: `${candlePattern}; close finished in the top ${number(100 - closeLocation)}% of the candle` }
      : closeLocation <= 30
        ? { tone: "danger", label: "Session closed with sellers", note: `${candlePattern}; close finished in the bottom ${number(closeLocation)}% of the candle` }
        : { tone: "neutral", label: "Session closed near the middle", note: `${candlePattern}; no strong closing-location edge` };
    const efficiencyCard = efficiency >= .45
      ? { tone: "active", label: "Price path is directional", note: "A larger share of travelled distance became net movement" }
      : efficiency <= .2
        ? { tone: "neutral", label: "Price path is noisy", note: "Most movement reversed instead of travelling one way" }
        : { tone: "neutral", label: "Price path is mixed", note: "Neither a clean trend nor a fully choppy path" };
    const memoryCard = autocorrelation >= .2
      ? { tone: "active", label: "Recent returns show persistence", note: "Positive moves more often followed positive moves; sample is short" }
      : autocorrelation <= -.2
        ? { tone: "active", label: "Recent returns show reversal", note: "Moves more often reversed on the next session; sample is short" }
        : { tone: "neutral", label: "Little short-term memory", note: "Lag-one returns do not show a stable direction" };
    const entropyCard = entropy <= 75
      ? { tone: "active", label: "Direction has some structure", note: "Up/down signs are less evenly mixed than maximum randomness" }
      : { tone: "neutral", label: "Direction is highly mixed", note: "Up/down signs are close to maximum uncertainty" };
    const channelCard = donchian.includes("upside")
      ? { tone: "calm", label: "Price cleared its prior channel", note: `Prior 20-session ceiling ${money(data.signals?.donchianHigh20)}` }
      : donchian.includes("downside")
        ? { tone: "danger", label: "Price broke its prior channel", note: `Prior 20-session floor ${money(data.signals?.donchianLow20)}` }
        : { tone: "neutral", label: "Price remains inside its channel", note: `${money(data.signals?.donchianLow20)} to ${money(data.signals?.donchianHigh20)}` };
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
      { name: "Market sensitivity · Beta", value: number(beta), ...betaCard },
      { name: "Medium trend · 3 months", value: pct(return63), ...quarterMomentum },
      { name: "Trend stack · 20 / 50", value: `${pct(sma20Gap)} / ${pct(sma50Gap)}`, ...averageStack },
      { name: "Downside volatility · 3 months", value: `${number(downsideVol)}%`, ...downsideCard },
      { name: "Maximum drawdown · 3 months", value: `${number(drawdown)}%`, ...drawdownCard },
      { name: "Volume participation · 5 / 20", value: `${number(volumeRatio)}×`, ...volumeCard },
      { name: "Vol-adjusted momentum", value: number(adjustedMomentum), ...adjustedCard },
      { name: "Volatility-sized chunk", value: money(40_000 * riskMultiplier), tone: riskMultiplier < .65 ? "danger" : riskMultiplier < 1 ? "active" : "calm", label: `${number(riskMultiplier)}× size`, note: "A risk-scaled reference capped against the ₹40,000 chunk—not an order" },
      { name: "Historical weekly −2% touch", value: Number.isFinite(downHit) ? `${number(downHit)}%` : "—", tone: "neutral", label: `${data.empirical?.down2Hits || 0} of ${weeklySample} completed weeks`, note: weeklySample < 12 ? "Small sample—do not rely on this alone" : `95% interval ${number(data.empirical?.down2Interval95?.low)}–${number(data.empirical?.down2Interval95?.high)}%` },
      { name: "Historical weekly +2% touch", value: Number.isFinite(upHit) ? `${number(upHit)}%` : "—", tone: "neutral", label: `${data.empirical?.up2Hits || 0} of ${weeklySample} completed weeks`, note: weeklySample < 12 ? "Small sample—do not rely on this alone" : `95% interval ${number(data.empirical?.up2Interval95?.low)}–${number(data.empirical?.up2Interval95?.high)}%` },
      { name: "Walk-forward analog model · 5 days", value: analog.ready ? `${number(analog.probabilityUp5Pct)}% up` : "LEARNING", ...analogCard },
      { name: "Latest candle · OHLC", value: candlePattern.toUpperCase(), ...candleCard },
      { name: "Trend efficiency · 20 sessions", value: number(efficiency), ...efficiencyCard },
      { name: "Return memory · lag 1", value: number(autocorrelation), ...memoryCard },
      { name: "High–low volatility · Parkinson", value: `${number(parkinsonVol)}%`, tone: parkinsonVol > 45 ? "danger" : parkinsonVol > 28 ? "active" : "calm", label: parkinsonVol > 45 ? "Wide intraday movement" : parkinsonVol > 28 ? "Active intraday movement" : "Contained intraday movement", note: "Uses high–low ranges rather than only closing returns" },
      { name: "Directional uncertainty · Entropy", value: `${number(entropy)}%`, ...entropyCard },
      { name: "Breakout channel · 20 sessions", value: donchian.toUpperCase(), ...channelCard }
    ];
  }

  function weightedRecommendation(data, personal) {
    const model = data?.decisionModel || { score: 0, confidencePct: 0, components: [] };
    const score = Number(model.score) || 0;
    const components = Array.isArray(model.components) ? model.components : [];
    const confirmationNames = /trend|momentum|relative strength|candlestick|walk-forward|volume|strategy laboratory/i;
    const confirmations = components.filter((item) => confirmationNames.test(item.name || "") && Number(item.contribution) > .5).length;
    const contradictions = components.filter((item) => confirmationNames.test(item.name || "") && Number(item.contribution) < -.5).length;
    const confidence = Number(model.confidencePct) || 0;
    const riskBase = Math.min(1, Math.max(.25, Number(data?.signals?.riskBudgetMultiplier) || 1));
    const modelFactor = score <= -35 ? .5 : score < 0 ? .78 : score >= 35 ? 1.08 : 1;
    const amount = Math.min(40_000, 40_000 * riskBase * modelFactor);
    const buying = ["buy", "buy-hit"].includes(personal.action);
    const selling = ["sell", "sell-hit"].includes(personal.action);
    const entryConfirmed = buying && score >= 20 && confirmations >= 3 && contradictions <= 2 && confidence >= 15;
    if (personal.action === "both-hit") return { tone: "wait", label: "REVIEW — BOTH LINES TRADED", detail: "Daily data cannot prove which line traded first. This is not a new-entry signal until intraday order is known.", amount: 0, score, model, confirmations, contradictions, entryConfirmed: false };
    if (entryConfirmed) return { tone: "buy", label: "NEW BUY CONFIRMED", detail: "The GM-price trigger and " + confirmations + " independent technical/statistical checks agree. Risk-scaled maximum for this chunk: " + money(amount) + ".", amount, score, model, confirmations, contradictions, entryConfirmed: true };
    if (buying) {
      const failed = [score < 20 ? "model score " + number(score) + " is below +20" : null, confirmations < 3 ? "only " + confirmations + " independent confirmations" : null, contradictions > 2 ? contradictions + " important contradictions" : null, confidence < 15 ? "confidence strength " + number(confidence) + "% is below 15%" : null].filter(Boolean);
      return { tone: "wait", label: "REVIEW — PRICE TRIGGER, NO NEW BUY", detail: "The GM-price −2% event is recorded, but K² will not place it in New buys because " + failed.join(", ") + ". An existing position remains visible under Open trades.", amount: 0, score, model, confirmations, contradictions, entryConfirmed: false };
    }
    if (selling && score <= -20) return { tone: "sell", label: "SELL CONFIRMED — REDUCE ONE CHUNK", detail: "The sell line fired while the weighted model is bearish. The exit and broader evidence agree.", amount: 0, score, model, confirmations, contradictions };
    if (selling && score <= 0) return { tone: "sell", label: "SELL SOME — MIXED CONFIRMATION", detail: "The +2% line fired and the evidence is not strongly bullish. A staged reduction matches the rule.", amount: 0, score, model, confirmations, contradictions };
    if (selling) return { tone: "caution", label: "SELL LINE HIT — UPTREND STILL STRONG", detail: "The profit line fired, but the weighted model remains bullish. Reduce only the planned slice rather than treating the entire trend as finished.", amount: 0, score, model, confirmations, contradictions };
    if (score >= 28) return { tone: "watch", label: "HOLD — BULLISH WATCH", detail: "The evidence leans upward, but the weekly buy price has not been reached.", amount: 0, score, model, confirmations, contradictions };
    if (score <= -28) return { tone: "watch", label: "HOLD — BEARISH RISK WATCH", detail: "The evidence leans downward, but no mechanical sell event is active.", amount: 0, score, model, confirmations, contradictions };
    return { tone: "wait", label: "HOLD — NO WEIGHTED EDGE", detail: "Neither the weekly levels nor the weighted evidence justify a new action.", amount: 0, score, model, confirmations, contradictions };
  }

  function weightedCategory(recommendation, personal) {
    if (personal?.action === "both-hit" || personal?.action === "loading" || (["buy", "buy-hit"].includes(personal?.action) && !recommendation?.entryConfirmed)) return "alert";
    if (recommendation?.entryConfirmed) return "buy";
    if (recommendation?.label?.startsWith("SELL")) return "sell";
    return "hold";
  }

  function weightedModelMarkup(recommendation) {
    const components = recommendation.model?.components || [];
    return `<section class="weighted-model ${recommendation.tone}">
      <header><div><span>FINAL WEIGHTED DECISION</span><strong>${recommendation.label}</strong><p>${recommendation.detail}</p></div><div class="weighted-score"><b>${recommendation.score >= 0 ? "+" : ""}${number(recommendation.score)}</b><small>OF ±100</small></div></header>
      <div class="weight-grid">${components.map((item) => {
        const contribution = Number(item.contribution) || 0;
        const direction = contribution > .1 ? "positive" : contribution < -.1 ? "negative" : "neutral";
        return `<div class="weight-row ${direction}"><span><b>${item.name}</b><small>${item.note}</small></span><i><em style="width:${Math.min(100, Math.abs(contribution) / Math.max(1, Number(item.weight)) * 100)}%"></em></i><strong>${contribution >= 0 ? "+" : ""}${number(contribution)}<small>${number(item.weight)}% weight</small></strong></div>`;
      }).join("")}</div>
      <footer>Risk penalty: ${number(recommendation.model?.riskPenalty || 0)} points · Confidence strength: ${number(recommendation.model?.confidencePct || 0)}% · Every contribution is shown above.</footer>
    </section>`;
  }

  function candlestickSvg(data) {
    const series = (data?.series || []).slice(-20).filter((bar) => [bar.o, bar.h, bar.l, bar.c].every(Number.isFinite));
    if (series.length < 2) return `<div class="candle-empty">OHLC history is still loading.</div>`;
    const width = 720, height = 190, top = 12, bottom = 22;
    const low = Math.min(...series.map((bar) => bar.l));
    const high = Math.max(...series.map((bar) => bar.h));
    const range = Math.max(high - low, high * .001);
    const y = (value) => top + (high - value) / range * (height - top - bottom);
    const step = width / series.length;
    const bodyWidth = Math.max(4, Math.min(16, step * .55));
    const candles = series.map((bar, index) => {
      const x = step * index + step / 2;
      const bullish = bar.c >= bar.o;
      const bodyTop = Math.min(y(bar.o), y(bar.c));
      const bodyHeight = Math.max(2, Math.abs(y(bar.c) - y(bar.o)));
      return `<g class="${bullish ? "bull" : "bear"}"><line x1="${x}" y1="${y(bar.h)}" x2="${x}" y2="${y(bar.l)}"></line><rect x="${x - bodyWidth / 2}" y="${bodyTop}" width="${bodyWidth}" height="${bodyHeight}"></rect></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Last ${series.length} daily candlesticks"><line class="candle-grid" x1="0" y1="${y(high)}" x2="${width}" y2="${y(high)}"></line><line class="candle-grid" x1="0" y1="${y(low)}" x2="${width}" y2="${y(low)}"></line>${candles}<text x="0" y="${height - 4}">${new Date(series[0].t * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</text><text x="${width}" y="${height - 4}" text-anchor="end">${new Date(series.at(-1).t * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</text></svg>`;
  }

  function candleMarkup(data) {
    const candle = data?.candleStudy || {};
    const direction = Number(candle.directionScore) > .15 ? "bullish" : Number(candle.directionScore) < -.15 ? "bearish" : "neutral";
    const reading = direction === "bullish" ? "BULLISH CANDLE EVIDENCE" : direction === "bearish" ? "BEARISH CANDLE EVIDENCE" : "NEUTRAL CANDLE EVIDENCE";
    return `<section class="candle-desk ${direction}">
      <header><div><span>DAILY OHLC · ORIGINAL CANDLE STRUCTURE</span><strong>${String(candle.pattern || data?.signals?.candlePattern || "balanced candle").toUpperCase()}</strong><p>${reading}. This input receives 10% of the final model, and its weight is shrunk when the stock has too few comparable historical cases.</p></div><div><b>${candle.ready ? `${number(candle.winRatePct)}%` : "LEARNING"}</b><small>${candle.sample || 0} SAME-PATTERN CASES<br />${candle.ready ? `${pct(candle.averageNetReturnPct)} AVG AFTER COST` : "NEED 5 CASES"}</small></div></header>
      <div class="candle-chart">${candlestickSvg(data)}</div>
      <footer><span><i class="bull"></i> Close above open</span><span><i class="bear"></i> Close below open</span><b>Wicks show the complete daily high–low range.</b></footer>
    </section>`;
  }

  function strategyLabMarkup(data) {
    const lab = data?.strategyLab || {};
    if (!lab.ready) return `<section class="strategy-lab pending"><div><span>WALK-FORWARD STRATEGY LAB</span><strong>BUILDING HISTORY</strong><p>${lab.reason || "More stored sessions are required."}</p></div></section>`;
    const leaders = (lab.leaderboard || []).slice(0, 6);
    return `<section class="strategy-lab">
      <header><div><span>PER-STOCK WALK-FORWARD STRATEGY LAB</span><strong>${lab.passedFamilies || 0} OF ${lab.testedFamilies || 0} FAMILIES PASSED</strong><p>${lab.testedCandidates || 0} parameter variants tested chronologically across ${lab.sessions || 0} sessions. Assumed round-trip cost: ${number(lab.costAssumptionPct)}%.</p></div><b>${lab.selected?.family || "NO PASS"}<small>TOP VALIDATED FAMILY</small></b></header>
      <div class="strategy-table">${leaders.map((item) => `<div class="${item.passed ? "passed" : "rejected"}"><span><b>${item.family}</b><small>${item.selectedVariant}</small></span><strong>${item.passed ? "PASS" : "REJECT"}<small>${item.trades} OOS TRADES</small></strong><i>${number(item.winRatePct)}% win<small>${pct(item.averageNetReturnPct)} avg · hurdle ${pct(item.multipleTestHurdlePct)} · PF ${number(item.profitFactor)} · DD ${number(item.maxDrawdownPct)}%</small></i></div>`).join("")}</div>
      <div class="research-basis"><b>Published quantitative foundations</b><a href="https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Original-Paper-Data" target="_blank" rel="noopener">Cross-market trend</a><a href="https://www.nber.org/papers/w7613" target="_blank" rel="noopener">Algorithmic chart patterns</a><a href="https://www.nber.org/papers/w22208" target="_blank" rel="noopener">Volatility sizing</a><a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551" target="_blank" rel="noopener">Overfit correction</a></div>
      <footer>Expanding-window selection → unseen next block. Signals are formed at the close and tested from the next open, with costs deducted. Rejected families do not increase AI size.</footer>
    </section>`;
  }

  function evidenceReadout(data) {
    const score = Number(data?.signals?.evidenceScore) || 0;
    const risk = data?.signals?.riskState || "normal";
    if (risk === "high") return { tone: "danger", label: "HIGH MOVEMENT RISK", detail: "Trend evidence may exist, but volatility or drawdown is large enough to cut size first." };
    if (score >= 2) return { tone: risk === "elevated" ? "active" : "calm", label: "TREND EVIDENCE SUPPORTS UPSIDE", detail: "The 20/50 trend stack, three-month momentum and Nifty-relative strength are mostly aligned upward." };
    if (score <= -2) return { tone: "danger", label: "TREND EVIDENCE IS ADVERSE", detail: "The 20/50 trend stack, three-month momentum and Nifty-relative strength are mostly aligned downward." };
    return { tone: risk === "elevated" ? "active" : "neutral", label: "EVIDENCE IS MIXED", detail: "The independent trend checks disagree, so the Monday action should not be treated as strongly confirmed." };
  }

  function evidenceForAction(data, action) {
    const base = evidenceReadout(data);
    const score = Number(data?.signals?.evidenceScore) || 0;
    if (["buy", "buy-hit"].includes(action) && score <= -2) {
      return { tone: "danger", label: "BUY TRIGGER HIT — DOWNTREND CAUTION", detail: "Your Monday rule says buy one chunk, while the broader trend evidence is still falling. The smaller volatility-scaled amount is the cautious version of that rule." };
    }
    if (["sell", "sell-hit"].includes(action) && score >= 2) {
      return { tone: "active", label: "SELL TRIGGER HIT — UPTREND STILL STRONG", detail: "Your Monday rule says reduce one chunk, while broader trend evidence remains positive. This supports a staged reduction rather than treating the whole trend as finished." };
    }
    return base;
  }

  function exitPlan(item, data, live) {
    const base = item.assetType === "future" ? (Number(item.weeklyBase) || item.markPrice || item.average) : (Number(data?.weekly?.openingPrice) || item.average);
    const direction = item.position === "short" ? -1 : 1;
    const weeklyLevels = window.K2_GRID?.exitLevels(base, 2, 5, item.position) || [];
    const targets = weeklyLevels.map((price, index) => {
      const distance = Math.abs(price - live) / live * 100;
      const reached = direction > 0 ? live >= price : live <= price;
      const status = reached ? "reached" : Math.abs(price - live) <= live * .003 ? "close" : "waiting";
      return { price, distance, status, gainPct: direction * (price - base) / base * 100, step: index + 1 };
    });
    return { base, targets, slice: item.quantity / 5, riskLine: base * (1 - direction * .02), direction };
  }

  function positionFor(data) {
    return Math.max(2, Math.min(98, (data?.position ?? 0.5) * 100));
  }

  function currentPrice(symbol) {
    return market.get(symbol)?.price ?? bySymbol.get(symbol)?.snapshotPrice ?? null;
  }

  function updateTradePlanner() {
    const buy = Number(el("plannerBuy")?.value);
    const sell = Number(el("plannerSell")?.value);
    const amount = Number(el("plannerAmount")?.value);
    const output = el("plannerResult");
    if (!output) return;
    if (!(buy > 0) || !(sell > 0) || !(amount > 0)) {
      output.className = "planner-result";
      output.textContent = "Enter valid buy, sell and amount values to calculate the trade.";
      return;
    }
    const quantity = Math.floor(amount / buy);
    if (quantity < 1) {
      output.className = "planner-result negative";
      output.textContent = `The amount is smaller than one share at ${money(buy)}.`;
      return;
    }
    const deployed = quantity * buy;
    const exitValue = quantity * sell;
    const gross = exitValue - deployed;
    const move = (sell / buy - 1) * 100;
    const data = market.get(state.focusSymbol);
    const scaledCap = 40_000 * (Number(data?.signals?.riskBudgetMultiplier) || 1);
    output.className = `planner-result ${gross >= 0 ? "positive" : "negative"}`;
    output.innerHTML = `<b>${number(quantity)} whole shares</b> · uses ${money(deployed)} · leaves ${money(amount - deployed)} · gross ${gross >= 0 ? "+" : ""}${money(gross)} (${pct(move)}) before fees, tax and slippage.<small>Volatility-scaled reference for this script: ${money(scaledCap)} of a ₹40,000 chunk.</small>`;
  }

  function syncTradePlanner(force = false) {
    const symbol = state.focusSymbol || watchlist[0]?.symbol;
    const data = market.get(symbol);
    const symbolNode = el("plannerSymbol");
    if (!symbolNode || state.user === "ai") return;
    symbolNode.textContent = symbol || "—";
    if (!data) {
      el("plannerResult").textContent = `Waiting for ${symbol || "the selected script"} market data…`;
      return;
    }
    const source = el("plannerSource").value;
    const key = `${symbol}:${source}`;
    if (force || state.plannerKey !== key) {
      if (source === "weekly") {
        const signal = personalSignal(symbol, data);
        el("plannerBuy").value = Number(signal.buyAt || data.price).toFixed(2);
        el("plannerSell").value = Number(signal.sellAt || data.price).toFixed(2);
      } else if (source === "range") {
        el("plannerBuy").value = Number(data.ladder?.buy?.[0] || data.price).toFixed(2);
        el("plannerSell").value = Number(data.ladder?.sell?.[0] || data.price).toFixed(2);
      } else if (state.plannerKey?.split(":")[0] !== symbol) {
        el("plannerBuy").value = Number(data.price).toFixed(2);
        el("plannerSell").value = Number(data.price * 1.02).toFixed(2);
      }
      state.plannerKey = key;
    }
    updateTradePlanner();
  }

  function personalSignal(symbol, data, suppliedHolding = null) {
    const holding = suppliedHolding || holdings().find((item) => item.symbol === symbol);
    const isFuture = holding?.assetType === "future";
    const anchor = isFuture ? Number(holding.weeklyBase) : Number(data?.weekly?.openingPrice);
    const price = isFuture ? Number(holding.markPrice) : Number(data?.price);
    const grid = window.K2_GRID?.weeklySignal(anchor, price, 2) || { action: "loading", buyLevels: [], sellAt: null, reachedBuyLevel: 0 };
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
    const dailyLow = isFuture ? Number(holding.dailyLow) : Number(data?.daily?.low);
    const dailyHigh = isFuture ? Number(holding.dailyHigh) : Number(data?.daily?.high);
    if (isFuture) {
      const future = window.K2_GRID?.futureSignal(price, grid.buyLevels?.[0], grid.sellAt) || { action: "loading" };
      action = future.action;
      const isShort = holding.position === "short";
      label = action === "buy" ? (isShort ? "🟢 COVER ONE CHUNK" : "🟢 BUY ONE CHUNK") : action === "sell" ? (isShort ? "🔴 REDUCE SHORT" : "🔴 SELL ONE CHUNK") : action === "loading" ? "LOADING PRICE" : "🟡 HOLD — DO NOTHING";
      detail = action === "buy"
        ? `Now ${money(price)} is at or below the ${money(future.buyAt)} ${isShort ? "cover" : "buy"} line.`
        : action === "sell"
          ? `Now ${money(price)} is at or above the ${money(future.sellAt)} ${isShort ? "short-risk" : "sell"} line.`
          : `Now ${money(price)} is between the ${money(future.buyAt)} ${isShort ? "cover" : "buy"} line and ${money(future.sellAt)} ${isShort ? "risk" : "sell"} line.`;
      const buyHit = Number.isFinite(dailyLow) && dailyLow <= future.buyAt;
      const sellHit = Number.isFinite(dailyHigh) && dailyHigh >= future.sellAt;
      if (action === "wait" && buyHit && sellHit) {
        action = "both-hit";
        label = "🟠 BOTH LINES HIT TODAY";
        detail = `Today's low reached ${money(future.buyAt)} and today's high reached ${money(future.sellAt)}. The daily range cannot show which happened first.`;
      } else if (action === "wait" && sellHit) {
        action = "sell-hit";
        label = isShort ? "🔴 RISK LINE HIT TODAY" : "🔴 SELL LINE HIT TODAY";
        detail = `Today's high ${money(dailyHigh)} reached ${money(future.sellAt)}, but now the price is back below it.`;
      } else if (action === "wait" && buyHit) {
        action = "buy-hit";
        label = isShort ? "🟢 COVER LINE HIT TODAY" : "🟢 BUY LINE HIT TODAY";
        detail = `Today's low ${money(dailyLow)} reached ${money(future.buyAt)}, but now the price is back above it.`;
      }
      return { ...grid, ...future, action, label, detail, holding, isFuture, exit, current: price, dailyLow, dailyHigh };
    }
    const buyHitToday = Number.isFinite(dailyLow) && dailyLow <= Number(grid.buyLevels?.[0]);
    const sellHitToday = Number.isFinite(dailyHigh) && dailyHigh >= Number(grid.sellAt);
    if (action === "wait" && buyHitToday && sellHitToday) {
      action = "both-hit";
      label = "🟠 BOTH LINES HIT TODAY";
      detail = `Today's range crossed both ${money(grid.buyLevels?.[0])} and ${money(grid.sellAt)}. Daily data cannot prove which happened first, so review the intraday chart.`;
    } else if (action === "wait" && holding?.position === "short" && buyHitToday) {
      action = "buy-hit";
      label = "🟢 COVER LINE HIT TODAY";
      detail = `Today's low ${money(dailyLow)} crossed the ${money(grid.buyLevels?.[0])} cover line. Current price has moved back, but the opportunity occurred earlier today.`;
    } else if (action === "wait" && holding?.position === "short" && sellHitToday) {
      action = "sell-hit";
      label = "🔴 SHORT RISK LINE HIT TODAY";
      detail = `Today's high ${money(dailyHigh)} crossed the ${money(grid.sellAt)} short-risk line. Current price has moved back, but the event occurred earlier today.`;
    } else if (action === "wait" && sellHitToday) {
      action = "sell-hit";
      label = "🔴 SELL LINE HIT TODAY";
      detail = `Today's high ${money(dailyHigh)} crossed the ${money(grid.sellAt)} sell line. Current price is back below it, so the opportunity occurred earlier today.`;
    } else if (action === "wait" && buyHitToday) {
      action = "buy-hit";
      label = "🟢 BUY LINE HIT TODAY";
      detail = `Today's low ${money(dailyLow)} crossed the ${money(grid.buyLevels?.[0])} buy line. Current price has moved back above it, so the opportunity occurred earlier today.`;
    }
    return { ...grid, action, label, detail, holding, isFuture, exit, current: price, buyAt: grid.buyLevels?.[0], sellAt: grid.sellAt, dailyLow, dailyHigh };
  }

  function holdings() {
    const grouped = new Map();
    for (const lot of state.portfolio.lots) {
      const assetType = lot.assetType === "future" ? "future" : "equity";
      const position = lot.position === "short" ? "short" : "long";
      const key = lot.contractKey || (assetType === "future" ? `${lot.symbol}|FUT|${lot.expiry}|${position}` : `${lot.symbol}|EQ|long`);
      if (!grouped.has(key)) grouped.set(key, { key, symbol: lot.symbol, assetType, position, expiry: lot.expiry || null, market: lot.market || (assetType === "future" ? "NSEFUT" : "NSE"), quantity: 0, cost: 0, lots: 0, markCost: 0, brokerMtm: 0, hasBrokerMtm: false, exactMark: true, brokerClose: false, source: lot.source || null, weeklyBase: Number(lot.weeklyBase) || null, weekKey: lot.weekKey || null, dailyLow: Number(lot.dailyLow) || null, dailyHigh: Number(lot.dailyHigh) || null, dayKey: lot.dayKey || null });
      const item = grouped.get(key);
      item.quantity += Number(lot.quantity);
      item.cost += Number(lot.quantity) * Number(lot.price);
      item.markCost += Number(lot.quantity) * Number(lot.markPrice || lot.price);
      const lotMtm = Number(lot.mtm);
      if (assetType === "future" && Number.isFinite(lotMtm)) { item.brokerMtm += lotMtm; item.hasBrokerMtm = true; }
      if (assetType === "future" && !["exchange-live", "gm-mark"].includes(lot.markSource)) item.exactMark = false;
      if (assetType === "future" && lot.markSource === "broker-close") item.brokerClose = true;
      if (assetType === "future") {
        item.weeklyBase = Number(lot.weeklyBase) || item.weeklyBase;
        item.weekKey = lot.weekKey || item.weekKey;
        item.dailyLow = Number(lot.dailyLow) || item.dailyLow;
        item.dailyHigh = Number(lot.dailyHigh) || item.dailyHigh;
        item.dayKey = lot.dayKey || item.dayKey;
      }
      item.lots += 1;
    }
    return [...grouped.values()].map((item) => ({ ...item, average: item.quantity ? item.cost / item.quantity : 0, markPrice: item.quantity ? item.markCost / item.quantity : 0 }));
  }

  function portfolioMetrics() {
    const items = holdings();
    let value = 0;
    let cost = 0;
    let calculatedPnl = 0;
    let brokerMtm = 0;
    let totalQty = 0;
    for (const item of items) {
      const mark = item.assetType === "future" ? item.markPrice : (currentPrice(item.symbol) ?? item.average);
      value += mark * item.quantity;
      cost += item.cost;
      totalQty += item.quantity;
      calculatedPnl += (mark - item.average) * item.quantity * (item.position === "short" ? -1 : 1);
      if (item.assetType === "future" && item.hasBrokerMtm) brokerMtm += item.brokerMtm;
    }
    const hasFutures = items.some((item) => item.assetType === "future");
    const brokerMtmComplete = Boolean(items.length) && items.every((item) => item.assetType !== "future" || item.hasBrokerMtm);
    const verified = state.portfolio?.brokerSync?.verifiedComplete === true;
    const pnl = hasFutures && verified ? Number(state.portfolio.brokerSync.totalMtm) : hasFutures && brokerMtmComplete ? brokerMtm : calculatedPnl;
    const signedTotalQty = hasFutures && verified ? Number(state.portfolio.brokerSync.totalQuantity) : items.reduce((sum, item) => sum + item.quantity * (item.position === "short" ? -1 : 1), 0);
    return { items, value, cost, pnl, calculatedPnl, brokerMtm, brokerMtmComplete, totalQty, signedTotalQty, verified, pnlPct: cost ? (pnl / cost) * 100 : 0, hasFutures };
  }

  function brokerSyncTime() {
    const capturedAt = state.portfolio?.brokerSync?.capturedAt;
    if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) return "Waiting for verified GM snapshot";
    const age = Date.now() - Date.parse(capturedAt);
    const stamp = new Date(capturedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
    return age > 15 * 60_000 ? "STALE · " + stamp : stamp;
  }

  function portfolioActionCategory(item) {
    const data = market.get(item.symbol);
    if (!data) return "alert";
    const personal = personalSignal(item.symbol, data, item);
    return weightedCategory(weightedRecommendation(data, personal), personal);
  }

  function filteredPortfolioItems(items) {
    const filters = state.portfolioFilters;
    const query = filters.query.trim().toUpperCase();
    let filtered = items.filter((item) => {
      const metadata = bySymbol.get(item.symbol);
      return !query || item.symbol.includes(query) || metadata?.sector?.toUpperCase().includes(query);
    });
    if (filters.sector !== "all") filtered = filtered.filter((item) => bySymbol.get(item.symbol)?.sector === filters.sector);
    if (filters.cap !== "all") filtered = filtered.filter((item) => bySymbol.get(item.symbol)?.marketCapCategory === filters.cap);
    if (filters.model !== "all") filtered = filtered.filter((item) => market.get(item.symbol)?.signals?.marketRegime === filters.model);
    if (filters.action !== "all") filtered = filtered.filter((item) => portfolioActionCategory(item) === filters.action);
    if (filters.band !== "all") {
      filtered = filtered.filter((item) => {
        const regime = market.get(item.symbol)?.regime;
        return filters.band === "outside" ? regime === "below-range" || regime === "above-range" : regime === filters.band;
      });
    }
    filtered.sort((a, b) => {
      const aData = market.get(a.symbol);
      const bData = market.get(b.symbol);
      if (filters.sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (filters.sort === "pnl") {
        const aMark = a.assetType === "future" ? a.markPrice : (currentPrice(a.symbol) ?? a.average);
        const bMark = b.assetType === "future" ? b.markPrice : (currentPrice(b.symbol) ?? b.average);
        const aPnl = (aMark - a.average) * a.quantity * (a.position === "short" ? -1 : 1);
        const bPnl = (bMark - b.average) * b.quantity * (b.position === "short" ? -1 : 1);
        return bPnl - aPnl;
      }
      if (filters.sort === "change") return Math.abs(bData?.changePct ?? -Infinity) - Math.abs(aData?.changePct ?? -Infinity);
      if (filters.sort === "buy-pulse") return (bData?.signals?.pulseScore ?? -99) - (aData?.signals?.pulseScore ?? -99);
      if (filters.sort === "sell-pulse") return (aData?.signals?.pulseScore ?? 99) - (bData?.signals?.pulseScore ?? 99);
      if (filters.sort === "sector") return (bySymbol.get(a.symbol)?.sector || "").localeCompare(bySymbol.get(b.symbol)?.sector || "") || a.symbol.localeCompare(b.symbol);
      return 0;
    });
    return filtered;
  }

  function portfolioFiltersMarkup(items) {
    const filters = state.portfolioFilters;
    const sectors = [...new Set(items.map((item) => bySymbol.get(item.symbol)?.sector).filter(Boolean))].sort();
    const counts = { all: items.length, buy: 0, hold: 0, sell: 0, alert: 0 };
    items.forEach((item) => { counts[portfolioActionCategory(item)] += 1; });
    const selected = (value, current) => value === current ? " selected" : "";
    const sectorOptions = sectors.map((sector) => `<option value="${sector}"${selected(sector, filters.sector)}>${sector}</option>`).join("");
    return `<section class="portfolio-controls" aria-label="Filter synchronized portfolio positions">
      <div class="toolbar">
        <label class="search-box"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg><input data-portfolio-filter="query" type="search" placeholder="Find a portfolio symbol…" autocomplete="off"></label>
        <label class="select-wrap"><span>Band</span><select data-portfolio-filter="band"><option value="all"${selected("all", filters.band)}>All ranges</option><option value="lower-band"${selected("lower-band", filters.band)}>Lower band</option><option value="mid-band"${selected("mid-band", filters.band)}>Mid band</option><option value="upper-band"${selected("upper-band", filters.band)}>Upper band</option><option value="outside"${selected("outside", filters.band)}>Outside range</option></select></label>
        <label class="select-wrap"><span>Sector</span><select data-portfolio-filter="sector"><option value="all"${selected("all", filters.sector)}>All sectors</option>${sectorOptions}</select></label>
        <label class="select-wrap"><span>Market cap</span><select data-portfolio-filter="cap"><option value="all"${selected("all", filters.cap)}>All caps</option><option value="Large Cap"${selected("Large Cap", filters.cap)}>Large cap</option><option value="Mid Cap"${selected("Mid Cap", filters.cap)}>Mid cap</option><option value="Small Cap"${selected("Small Cap", filters.cap)}>Small cap</option></select></label>
        <label class="select-wrap"><span>Quant mode</span><select data-portfolio-filter="model"><option value="all"${selected("all", filters.model)}>All modes</option><option value="trend"${selected("trend", filters.model)}>Trend</option><option value="range"${selected("range", filters.model)}>Range</option><option value="transition"${selected("transition", filters.model)}>Transition</option><option value="volatile"${selected("volatile", filters.model)}>High volatility</option></select></label>
        <label class="select-wrap"><span>Sort</span><select data-portfolio-filter="sort"><option value="journal"${selected("journal", filters.sort)}>GM order</option><option value="buy-pulse"${selected("buy-pulse", filters.sort)}>Buy pulse first</option><option value="sell-pulse"${selected("sell-pulse", filters.sort)}>Sell pulse first</option><option value="pnl"${selected("pnl", filters.sort)}>P&amp;L high → low</option><option value="change"${selected("change", filters.sort)}>Daily move</option><option value="symbol"${selected("symbol", filters.sort)}>Symbol A–Z</option><option value="sector"${selected("sector", filters.sort)}>Sector A–Z</option></select></label>
      </div>
      <nav class="action-filters" aria-label="Filter portfolio by today's action">
        <button type="button" class="${filters.action === "all" ? "active" : ""}" data-portfolio-action="all">All <b>${counts.all}</b></button>
        <button type="button" class="${filters.action === "buy" ? "active" : ""}" data-portfolio-action="buy"><span>↓</span> Buy list <b>${counts.buy}</b></button>
        <button type="button" class="${filters.action === "hold" ? "active" : ""}" data-portfolio-action="hold"><span>•</span> Hold list <b>${counts.hold}</b></button>
        <button type="button" class="${filters.action === "sell" ? "active" : ""}" data-portfolio-action="sell"><span>↑</span> Sell list <b>${counts.sell}</b></button>
        <button type="button" class="${filters.action === "alert" ? "active" : ""}" data-portfolio-action="alert"><span>!</span> Review list <b>${counts.alert}</b></button>
      </nav>
    </section>`;
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
    if (state.user !== "ai" && state.actionFilter !== "all") {
      if (state.actionFilter === "owned") {
        const owned = new Set(holdings().map((item) => item.symbol));
        items = items.filter((item) => owned.has(item.symbol));
      } else {
        items = items.filter((item) => {
          const data = market.get(item.symbol);
          if (!data) return false;
          const personal = personalSignal(item.symbol, data);
          return weightedCategory(weightedRecommendation(data, personal), personal) === state.actionFilter;
        });
      }
    }
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
    if (state.user !== "ai") {
      const counts = { all: watchlist.length, owned: new Set(holdings().map((item) => item.symbol)).size, buy: 0, hold: 0, sell: 0, alert: 0 };
      watchlist.forEach((item) => {
        const data = market.get(item.symbol);
        if (!data) return;
        const personal = personalSignal(item.symbol, data);
        counts[weightedCategory(weightedRecommendation(data, personal), personal)] += 1;
      });
      el("actionAllCount").textContent = counts.all;
      el("actionOwnedCount").textContent = counts.owned;
      el("actionBuyCount").textContent = counts.buy;
      el("actionHoldCount").textContent = counts.hold;
      el("actionSellCount").textContent = counts.sell;
      el("actionAlertCount").textContent = counts.alert;
      el("actionFilters").querySelectorAll("[data-action-filter]").forEach((button) => button.classList.toggle("active", button.dataset.actionFilter === state.actionFilter));
    }
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
      const recommendation = personal ? weightedRecommendation(data, personal) : null;
      const mapMarkup = aiReady
        ? `<div class="range-values"><span>MONDAY ${money(aiStock.anchor.price)}</span><span>NEXT BUY ${money(aiStock.nextBuy?.price)}</span><span>NEXT SELL ${money(aiStock.nextSell)}</span></div><div class="range-track ai-track"><i class="price-pin" style="left:${focusPosition(Number(aiStock.lastPrice), Number(aiStock.levels?.at(-1)), Number(aiStock.anchor.price))}%"></i></div>`
        : data
          ? `<div class="range-values action-values"><span>BUY ≤ ${money(personal.buyAt)}</span><span>NOW ${money(data.price)}</span><span>SELL ≥ ${money(personal.sellAt)}</span></div><div class="range-track personal-track"><i class="price-pin" style="left:${focusPosition(data.price, personal.buyAt, personal.sellAt)}%"></i></div><small class="day-span">DAY ${money(data.daily?.low)} — ${money(data.daily?.high)}</small>`
          : `<div class="range-values"><span>${state.user === "ai" ? "Waiting for Monday grid" : "Fetching action prices"}</span><span>—</span></div><div class="range-loading"></div>`;
      const stateMarkup = aiReady ? `<span class="state-chip ${aiStock.lots?.length ? "lower-band" : "mid-band"}">${aiStock.lots?.length ? `${aiStock.lots.length} open lot${aiStock.lots.length === 1 ? "" : "s"}` : "Grid watching"}</span><small class="quant-link ${aiStock.openPnl >= 0 ? "positive" : "negative"}">${aiStock.nextBuy ? `B${aiStock.nextBuy.level} next · ${money(aiStock.nextBuy.price)}` : "Weekly levels evaluated"}</small>` : data ? `<span class="trade-suggestion ${recommendation.tone}">${recommendation.label}</span><small class="quant-link ${recommendation.score >= 0 ? "positive" : "negative"}">Weighted score ${recommendation.score >= 0 ? "+" : ""}${number(recommendation.score)} / 100 · ${recommendation.detail}</small>` : `<span class="state-chip">Loading</span><small class="map-link">Building weighted model →</small>`;
      return `
        <article class="stock-row ${item.symbol === state.focusSymbol ? "selected" : ""}" data-symbol="${item.symbol}" tabindex="0" ${item.symbol === state.focusSymbol ? 'aria-current="true"' : ""} aria-label="Show the complete analysis for ${item.symbol}">
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
      container.innerHTML = `<div class="focus-loading"><div><div class="empty-orbit">AI</div><b>Preparing ${symbol}'s Monday grid</b><p>The secured automation runner will store this week's Monday opening and five cumulative 2% levels.</p></div></div>`;
      return;
    }
    const levels = (stock.levels || []).map((price, index) => `<div class="chunk-row ${stock.triggeredLevels?.[index] ? "ai-triggered" : ""}"><span class="chunk-number">B${index + 1}</span><span class="chunk-copy"><b>${stock.triggeredLevels?.[index] ? "Paper filled" : stock.nextBuy?.level === index + 1 ? "Next trigger" : "Waiting"}</b><small>Compounded 2% step ${index + 1} · volatility-sized up to ₹40,000</small></span><strong class="chunk-price">${money(price)}</strong></div>`).join("");
    const exits = (stock.lots || []).slice().sort((a, b) => a.target - b.target).map((lot) => `<div class="chunk-row ai-exit"><span class="chunk-number">S${lot.level}</span><span class="chunk-copy"><b>Automatic paper exit</b><small>${number(lot.quantity)} shares · 2% above ${money(lot.price)}</small></span><strong class="chunk-price">${money(lot.target)}</strong></div>`).join("") || `<div class="ai-awaiting">Exit levels appear after a buy lot is filled. Each lot receives its own +2% target.</div>`;
    const weeklyMove = stock.lastPrice && stock.anchor.price ? (stock.lastPrice / stock.anchor.price - 1) * 100 : null;
    container.innerHTML = `<div class="focus-head"><div class="focus-name"><span class="symbol-avatar">${initials(symbol)}</span><div><p class="eyebrow" style="margin-bottom:5px"><span></span> AI MONDAY GRID</p><h2>${symbol}</h2><p>${snapshot.sector} · ${snapshot.marketCapCategory} · week ${stock.anchor.weekKey}</p></div></div><div class="focus-current"><span>Tracked price</span><strong>${money(stock.lastPrice)}</strong><small class="${weeklyMove >= 0 ? "positive" : "negative"}">${pct(weeklyMove)} from Monday</small></div></div>
      <div class="plain-rule"><b>Monday opening: ${money(stock.anchor.price)}.</b> The AI watches the cumulative weekly move, so five −0.5% days still trigger once the total crosses −2%. Each filled lot receives its own +2% exit.</div>
      <div class="ai-focus-equation"><span><small>MONDAY OPEN</small><b>${money(stock.anchor.price)}</b></span><i>→ −2% → −3.96% → −5.88% → −7.76% → −9.61%</i><span><small>CASH LEFT</small><b>${money(Number(stock.cash))}</b></span></div>
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
      syncTradePlanner();
      return;
    }

    const mondayBase = Number(data.weekly?.openingPrice) || Number(data.price);
    const actionLadder = {
      buy: window.K2_GRID?.levels(mondayBase, 2, 5) || [],
      sell: window.K2_GRID?.exitLevels(mondayBase, 2, 5, "long") || []
    };
    const minimum = actionLadder.buy[4];
    const maximum = actionLadder.sell[4];
    const labels = {
      buy: [
        ["Buy chunk 1", "2% below Monday open"],
        ["Buy chunk 2", "Second compounded 2% fall"],
        ["Buy chunk 3", "Third compounded 2% fall"],
        ["Buy chunk 4", "Fourth compounded 2% fall"],
        ["Buy chunk 5", "Fifth compounded 2% fall"]
      ],
      sell: [
        ["Sell chunk 1", "2% above Monday open"],
        ["Sell chunk 2", "Second compounded 2% rise"],
        ["Sell chunk 3", "Third compounded 2% rise"],
        ["Sell chunk 4", "Fourth compounded 2% rise"],
        ["Sell chunk 5", "Fifth compounded 2% rise"]
      ]
    };
    const chunks = (side) => actionLadder[side].map((price, index) => `
      <div class="chunk-row">
        <span class="chunk-number">${index + 1}</span>
        <span class="chunk-copy"><b>${labels[side][index][0]}</b><small>${labels[side][index][1]}</small></span>
        <strong class="chunk-price">${money(price)}</strong>
      </div>`).join("");
    const nodes = [
      ...actionLadder.buy.map((price, index) => `<span class="river-node buy" style="left:${focusPosition(price, minimum, maximum)}%"><i>B${index + 1}</i></span>`),
      ...actionLadder.sell.map((price, index) => `<span class="river-node sell" style="left:${focusPosition(price, minimum, maximum)}%"><i>S${index + 1}</i></span>`)
    ].join("");
    const currentSide = data.price < data.window.midpoint ? "below" : data.price > data.window.midpoint ? "above" : "at";
    const actionCopy = currentSide === "below" ? "The current price is on the buy side of the midpoint." : currentSide === "above" ? "The current price is on the sell side of the midpoint." : "The current price is at the midpoint.";
    const personal = personalSignal(symbol, data);
    const recommendation = weightedRecommendation(data, personal);
    const evidence = evidenceForAction(data, personal.action);
    const evidenceCards = indicatorCards(data);
    const actionPrice = personal.action === "buy"
      ? personal.buyLevels?.[Math.max(0, Number(personal.reachedBuyLevel || 1) - 1)]
      : personal.action === "sell" ? (personal.exit?.nextTarget || personal.sellAt) : data.price;
    container.classList.toggle("mobile-expanded", state.mobileFocusExpanded);
    container.innerHTML = `
      <section class="mobile-stock-brief ${recommendation.tone}">
        <header><div><span class="symbol-avatar">${initials(symbol)}</span><span><small>${snapshot.sector} · ${snapshot.marketCapCategory}</small><b>${symbol}</b></span></div><div><strong>${money(data.price)}</strong><small class="${data.changePct >= 0 ? "positive" : "negative"}">${pct(data.changePct)} today</small></div></header>
        <div class="mobile-action-line"><span>FINAL WEIGHTED ACTION · MECHANICAL EVENT: ${personal.label}</span><strong>${recommendation.label}</strong><p>${recommendation.detail}</p></div>
        <div class="mobile-decision-grid"><span><small>BUY AT OR BELOW</small><b>${money(personal.buyAt)}</b></span><span><small>NOW</small><b>${money(data.price)}</b></span><span><small>SELL AT OR ABOVE</small><b>${money(personal.sellAt)}</b></span></div>
        <div class="mobile-range-strip"><span><small>DAY LOW / HIGH</small><b>${money(data.daily?.low)} / ${money(data.daily?.high)}</b></span><span><small>31-DAY LOW / HIGH</small><b>${money(data.window.low)} / ${money(data.window.high)}</b></span><span><small>3-MONTH LOW / HIGH</small><b>${money(data.quarter?.low)} / ${money(data.quarter?.high)}</b></span></div>
        <div class="mobile-evidence"><span><small>MONDAY BASE</small><b>${money(mondayBase)}</b></span><span><small>WEIGHTED SCORE</small><b>${recommendation.score >= 0 ? "+" : ""}${number(recommendation.score)} / 100</b></span><span><small>ACTION PRICE</small><b>${money(actionPrice)}</b></span><span><small>WEIGHTED CHUNK</small><b>${recommendation.amount ? money(recommendation.amount) : "₹0 · WAIT"}</b></span></div>
        <footer><button type="button" data-focus-add="${symbol}">+ Add position</button><button type="button" class="secondary" data-toggle-mobile-focus aria-expanded="${state.mobileFocusExpanded}">${state.mobileFocusExpanded ? "Hide full analysis ↑" : "Full analysis & 10 levels ↓"}</button></footer>
      </section>
      <div class="focus-head">
        <div class="focus-name"><span class="symbol-avatar">${initials(symbol)}</span><div><p class="eyebrow" style="margin-bottom:5px"><span></span> Selected 10-chunk map</p><h2>${symbol}</h2><p>${snapshot.sector} · ${snapshot.marketCapCategory} · rank #${snapshot.marketCapRank} · ${data.window.sessions} sessions in 31 days</p></div></div>
        <div class="focus-current"><span>Current market price</span><strong>${money(data.price)}</strong><small class="${data.changePct >= 0 ? "positive" : "negative"}">${pct(data.changePct)} today</small></div>
      </div>
      <section class="weekly-call ${recommendation.tone}"><div><span>MECHANICAL MONDAY EVENT · ${personal.label} · BASE ${money(data.weekly?.openingPrice)}</span><h3>${recommendation.label}</h3><p>${recommendation.detail}</p><div class="call-thresholds daily-lines"><b>TODAY LOW ${money(data.daily?.low)}</b><b>NOW ${money(data.price)}</b><b>TODAY HIGH ${money(data.daily?.high)}</b></div></div><strong>${recommendation.score >= 0 ? "+" : ""}${number(recommendation.score)} / 100</strong></section>
      ${weightedModelMarkup(recommendation)}
      <section class="horizon-compare">
        <article><span>31-DAY RANGE · ${data.window.sessions} SESSIONS</span><div><b>${money(data.window.low)}<small>LOW</small></b><strong>${money(data.price)}<small>NOW</small></strong><b>${money(data.window.high)}<small>HIGH</small></b></div></article>
        <article><span>3-MONTH RANGE · ${data.quarter?.sessions || 0} SESSIONS</span><div><b>${money(data.quarter?.low)}<small>LOW</small></b><strong>${money(data.price)}<small>${number(data.quarter?.positionPct)}% OF RANGE</small></strong><b>${money(data.quarter?.high)}<small>HIGH</small></b></div></article>
      </section>
      <section class="evidence-banner ${evidence.tone}"><div><span>MULTI-MARKET EVIDENCE STACK · SCORE ${data.signals?.evidenceScore > 0 ? "+" : ""}${data.signals?.evidenceScore ?? 0} / 3</span><strong>${evidence.label}</strong><p>${evidence.detail}</p></div><b>${money(40_000 * (Number(data.signals?.riskBudgetMultiplier) || 1))}<small>VOL-SCALED CHUNK</small></b></section>
      ${candleMarkup(data)}
      ${strategyLabMarkup(data)}
      <details class="quant-vault"><summary><span>Open the full maths, statistics &amp; probability evidence</span><b>${evidenceCards.length} CHECKS</b></summary><div class="signal-grid">${evidenceCards.map((card) => `<article class="signal-card ${card.tone}"><span>${card.name}</span><div><strong>${card.value}</strong><b>${card.label}</b></div><p>${card.note}</p></article>`).join("")}</div><p class="probability-note"><b>Probability sample:</b> ${data.empirical?.weeks || 0} completed weeks from the available six-month history. A weekly high/low can prove a level was touched, but not whether the buy or sell happened first when both were reached. Historical frequency is not a forecast.</p></details>
      <p class="daily-range-title"><b>Today's live market range</b> · resets every trading day</p>
      <div class="daily-range focus-daily-range">
        <div><span>OBSERVED LOW</span><strong>${money(data.daily?.low)}</strong></div>
        <div class="decision-now"><span>CURRENT PRICE</span><strong>${money(data.price)}</strong></div>
        <div><span>OBSERVED HIGH</span><strong>${money(data.daily?.high)}</strong></div>
      </div>
      <div class="plain-rule"><b>Monday reset:</b> this week's action base is ${money(mondayBase)}. Five buy prices compound downward by 2%; five sell prices compound upward by 2%. The 31-day midpoint ${money(data.window.midpoint)} is comparison context only. ${actionCopy}</div>
      <div class="decision-river">
        <div class="river-line"></div>${nodes}
        <span class="river-bound low" style="left:${focusPosition(data.window.low, minimum, maximum)}%">31-DAY LOW<br>${money(data.window.low)}</span>
        <span class="river-bound mid" style="left:${focusPosition(mondayBase, minimum, maximum)}%">MONDAY BASE ${money(mondayBase)}</span>
        <span class="river-bound high" style="left:${focusPosition(data.window.high, minimum, maximum)}%">31-DAY HIGH<br>${money(data.window.high)}</span>
        <span class="current-flag" style="left:${focusPosition(data.price, minimum, maximum)}%"><span>NOW ${money(data.price)}</span></span>
      </div>
      <div class="chunk-grid">
        <div class="chunk-side buy"><div class="chunk-heading"><h3>5 Monday buy chunks ↓</h3><span>Compounded 2% steps</span></div>${chunks("buy")}</div>
        <div class="chunk-side sell"><div class="chunk-heading"><h3>5 Monday sell chunks ↑</h3><span>Compounded 2% steps</span></div>${chunks("sell")}</div>
      </div>
      <div class="chunk-explain"><p><b>Buying, in simple words:</b> Monday open is zero. A cumulative fall to −2%, −3.96%, −5.88%, −7.76% or −9.61% reaches the five buy chunks—even if the fall happens slowly across several days.</p><p><b>Selling, in simple words:</b> the five Monday reference levels are +2%, +4.04%, +6.12%, +8.24% and +10.41%. A new Monday creates a new weekly base.</p></div>
      <div class="focus-actions">${state.user === "ai" ? `<button data-open-ai-grid>VIEW ${symbol} IN AI PAPER GRID →</button>` : `<button data-focus-add="${symbol}">+ ADD ${symbol} TO PORTFOLIO</button>`}</div>`;
    syncTradePlanner();
  }

  function renderSummary() {
    if (state.user === "ai") {
      const summary = state.aiLedger.summary || emptyAiLedger().summary;
      const universe = state.aiLedger.universe || emptyAiLedger().universe;
      const universeCount = Number(universe.totalStocks) || state.aiLedger.stocks?.length || 0;
      const coveredCount = (state.aiLedger.stocks || []).filter((stock) => stock.anchor).length;
      const equity = Number(summary.cash) + Number(summary.marketValue);
      const totalPnl = equity - Number(summary.allocated);
      el("trackedCount").textContent = universeCount || "…";
      el("portfolioValueLabel").textContent = "Virtual portfolio";
      el("openPnlLabel").textContent = "Total P&L";
      el("portfolioValue").textContent = money(equity, true);
      const waitingForFirstLoad = state.aiLoading && !state.aiLedger.stocks?.length;
      el("holdingCount").textContent = waitingForFirstLoad ? "Loading AI portfolio…" : `${summary.activeStocks || 0} active stocks · ${summary.openLots || 0} lots`;
      el("openPnl").textContent = money(totalPnl, Math.abs(totalPnl) >= 100000);
      el("openPnl").className = totalPnl > 0 ? "positive" : totalPnl < 0 ? "negative" : "";
      el("openPnlPct").textContent = `${pct(summary.allocated ? totalPnl / summary.allocated * 100 : 0)} on virtual allocation`;
      el("portfolioBadge").textContent = waitingForFirstLoad ? "…" : universeCount;
      el("loadedCount").textContent = `${coveredCount} / ${universeCount || "…"}`;
      return;
    }
    const metrics = portfolioMetrics();
    el("trackedCount").textContent = watchlist.length;
    el("portfolioValueLabel").textContent = metrics.hasFutures ? "Reference notional" : "Portfolio value";
    el("openPnlLabel").textContent = metrics.hasFutures ? "Marked P&L" : "Open P&L";
    el("portfolioValue").textContent = money(metrics.value, metrics.value >= 100000);
    el("holdingCount").textContent = metrics.items.length ? (metrics.hasFutures ? `${metrics.items.length} GM positions · ${number(metrics.totalQty)} total qty` : `${metrics.items.length} holding${metrics.items.length === 1 ? "" : "s"}`) : "No positions yet";
    el("openPnl").textContent = money(metrics.pnl, Math.abs(metrics.pnl) >= 100000);
    el("openPnl").className = metrics.pnl > 0 ? "positive" : metrics.pnl < 0 ? "negative" : "";
    el("openPnlPct").textContent = metrics.items.length ? (metrics.hasFutures ? `GM snapshot · ${brokerSyncTime()}` : `${pct(metrics.pnlPct)} on tracked cost`) : "Add a position to begin";
    el("portfolioBadge").textContent = metrics.items.length;
    el("loadedCount").textContent = `${market.size} / ${watchlist.length}`;
  }

  function renderAiPortfolio() {
    const ledger = state.aiLedger || emptyAiLedger();
    const summary = ledger.summary || emptyAiLedger().summary;
    const config = ledger.config || emptyAiLedger().config;
    const container = el("portfolioContent");
    if (!ledger.stocks?.length && state.aiLoading) {
      container.innerHTML = `<section class="ai-load-state"><i></i><b>Loading the shared AI portfolio…</b><span>Reading the broad-market ledger. On a phone this can take a few seconds.</span></section>`;
      renderSummary();
      return;
    }
    if (!ledger.stocks?.length && state.aiError) {
      container.innerHTML = `<section class="ai-load-state error"><b>The AI portfolio did not load.</b><span>${state.aiError}</span><button type="button" data-retry-ai>Retry now</button></section>`;
      renderSummary();
      return;
    }
    const syncNotice = state.aiLoading ? `<div class="ai-sync-notice"><i></i>Refreshing the shared ledger… showing the last synchronized copy.</div>` : state.aiError ? `<div class="ai-sync-notice error">Refresh failed; showing the last synchronized copy. <button type="button" data-retry-ai>Retry</button></div>` : "";
    const equity = Number(summary.cash) + Number(summary.marketValue);
    const totalPnl = equity - Number(summary.allocated);
    const storage = ledger.storage || {};
    const universe = ledger.universe || emptyAiLedger().universe;
    const updated = ledger.updatedAt ? new Date(ledger.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "Waiting for first automation run";
    const query = state.aiSearch.trim().toLowerCase();
    const allStocks = ledger.stocks || [];
    const coveredCount = allStocks.filter((stock) => stock.anchor).length;
    const capKey = (stock) => stock.marketCapCategory === "Large Cap" ? "large" : stock.marketCapCategory === "Mid Cap" ? "mid" : stock.marketCapCategory === "Small Cap" ? "small" : "other";
    const capCounts = allStocks.reduce((counts, stock) => {
      counts[capKey(stock)] += 1;
      return counts;
    }, { large: 0, mid: 0, small: 0, other: 0 });
    const modelBreadth = allStocks.reduce((counts, stock) => {
      const score = Number(stock.quant?.decisionModel?.score);
      if (!Number.isFinite(score)) counts.learning += 1;
      else if (score >= 20) counts.constructive += 1;
      else if (score <= -20) counts.cautious += 1;
      else counts.mixed += 1;
      return counts;
    }, { constructive: 0, mixed: 0, cautious: 0, learning: 0 });
    const stocks = allStocks.filter((stock) => {
      const matchesCap = state.aiCapFilter === "all" || capKey(stock) === state.aiCapFilter;
      const matchesQuery = !query || `${stock.symbol} ${stock.sector} ${stock.marketCapCategory}`.toLowerCase().includes(query);
      return matchesCap && matchesQuery;
    });
    const visibleStocks = stocks.slice(0, state.aiVisibleLimit);

    const rows = visibleStocks.map((stock) => {
      const anchor = Number(stock.anchor?.price);
      const live = Number(stock.lastPrice);
      const weeklyMove = anchor && live ? (live / anchor - 1) * 100 : null;
      const accountPnl = Number(stock.cash) + Number(stock.marketValue) - config.budgetPerStock;
      const levels = (stock.levels || []).map((price, index) => {
        const filled = Boolean(stock.triggeredLevels?.[index]);
        const next = stock.nextBuy?.level === index + 1;
        const cumulative = (1 - .98 ** (index + 1)) * 100;
        return `<span class="ai-level ${filled ? "filled" : ""} ${next ? "next" : ""}"><i>B${index + 1}</i><b>${money(price)}</b><small>${filled ? "FILLED" : next ? "NEXT" : `−${number(cumulative)}% cumulative`}</small></span>`;
      }).join("") || `<span class="ai-awaiting">Monday reference pending</span>`;
      const targets = (stock.lots || []).slice().sort((a, b) => a.target - b.target).map((lot) => `<span class="ai-target"><i>S${lot.level}</i><b>${money(lot.target)}</b><small>${number(lot.quantity)} shares · +2%</small></span>`).join("") || `<span class="ai-awaiting">No purchased lot needs an exit yet</span>`;
      const status = !stock.anchor ? "Waiting for secure runner" : stock.lots?.length ? `${stock.lots.length} lot${stock.lots.length === 1 ? "" : "s"} waiting for +2%` : stock.nextBuy ? `Watching B${stock.nextBuy.level}` : "Five weekly slots evaluated";
      const quant = stock.quant || {};
      const signals = quant.signals || {};
      const analog = quant.analogModel || {};
      const sizing = quant.sizing || {};
      const decision = quant.decisionModel || {};
      const candle = quant.candleStudy || {};
      const strategy = quant.strategyLab || {};
      const quantMarkup = quant.updatedAt ? `<section class="ai-quant-evidence">
        <header><div><span>RECORDED DECISION EVIDENCE</span><b>${String(signals.marketRegime || "learning").toUpperCase()} · ${String(signals.riskState || "unknown").toUpperCase()} RISK</b></div><strong>${number((Number(sizing.multiplier) || 1) * 100)}%<small>OF ₹40K SLOT</small></strong></header>
        <div class="ai-quant-facts">
          <span><small>FINAL WEIGHTED SCORE</small><b>${Number(decision.score) >= 0 ? "+" : ""}${number(decision.score)} / 100</b></span>
          <span><small>TREND EVIDENCE</small><b>${Number(signals.evidenceScore) > 0 ? "+" : ""}${signals.evidenceScore ?? "—"} / 3</b></span>
          <span><small>RSI PRESSURE</small><b>${number(quant.window?.rsi14)}</b></span>
          <span><small>63-DAY MOMENTUM</small><b>${pct(signals.return63Pct)}</b></span>
          <span><small>MAX DRAWDOWN</small><b>${number(signals.maxDrawdown63Pct)}%</b></span>
          <span><small>VOLUME 5 / 20</small><b>${number(signals.volumeRatio5To20)}×</b></span>
          <span><small>ANALOGUE UP PROB.</small><b>${analog.ready ? `${number(analog.probabilityUp5Pct)}%` : "LEARNING"}</b></span>
          <span><small>CANDLE · 10% WEIGHT</small><b>${candle.pattern || signals.candlePattern || "—"} · ${candle.sample || 0} cases</b></span>
          <span><small>PATH EFFICIENCY</small><b>${number(signals.efficiencyRatio20)}</b></span>
          <span><small>STRATEGY LAB</small><b>${strategy.selected?.family || "No family passed"}</b></span>
          <span><small>LAB COVERAGE</small><b>${strategy.testedCandidates || 0} variants · ${strategy.passedFamilies || 0} passed</b></span>
        </div>
        ${strategy.ready ? `<div class="ai-strategy-mini">${(strategy.leaderboard || []).slice(0, 4).map((item) => `<span class="${item.passed ? "passed" : "rejected"}"><b>${item.family}</b><small>${item.passed ? "PASS" : "REJECT"} · ${item.trades} OOS trades · ${number(item.winRatePct)}% win · ${pct(item.averageNetReturnPct)} avg</small></span>`).join("")}</div>` : ""}
        <p><b>Fundamentals:</b> no verified earnings, balance-sheet or valuation feed is connected, so K² does not invent PE, EPS or debt data. The live decision uses price, volume, market-cap class, sector, risk scaling and walk-forward history.</p>
      </section>` : `<section class="ai-quant-evidence pending"><b>Quant evidence will appear after the next secured AI run.</b></section>`;
      return `<details class="ai-stock" data-ai-stock="${stock.symbol}">
        <summary>
          <span class="symbol-avatar">${initials(stock.symbol)}</span>
          <span class="ai-stock-name"><b>${stock.symbol}</b><small>${stock.sector} · ${stock.marketCapCategory}</small></span>
          <span><small>Monday open</small><b>${money(anchor)}</b></span>
          <span><small>Tracked price</small><b>${money(live)} <i class="${weeklyMove >= 0 ? "positive" : "negative"}">${pct(weeklyMove)}</i></b></span>
          <span><small>Virtual cash</small><b>${money(Number(stock.cash))}</b></span>
          <span><small>Stock P&amp;L</small><b class="${accountPnl >= 0 ? "positive" : "negative"}">${money(accountPnl)}</b></span>
          <em>${status}</em>
        </summary>
        <div class="ai-stock-body">
          <div><h4>Five cumulative weekly buy triggers</h4><p>Each slot is capped at ${money(config.slotBudget)}, risk-sized from the recorded quant snapshot, and resets to Monday open.</p><div class="ai-levels">${levels}</div></div>
          <div><h4>Open-lot sell triggers</h4><p>Every lot has its own target, exactly ${config.takeProfitPct}% above its paper fill.</p><div class="ai-levels sells">${targets}</div></div>
          ${quantMarkup}
          <footer><span>Anchor week <b>${stock.anchor?.weekKey || "—"}</b></span><span>Anchor session <b>${stock.anchor?.barDate || "—"}</b></span><span>Invested / hard cap <b>${money(stock.invested)} / ${money(config.budgetPerStock)}</b></span><span>Open P&amp;L <b class="${stock.openPnl >= 0 ? "positive" : "negative"}">${money(stock.openPnl)}</b></span></footer>
        </div>
      </details>`;
    }).join("");

    const labSnapshot = (ledger.stocks || []).find((stock) => stock.quant?.strategyLab?.ready)?.quant?.strategyLab || {};
    const recentTrades = (ledger.transactions || []).slice(0, 40);
    const buyCount = recentTrades.filter((trade) => trade.action === "buy").length;
    const sellCount = recentTrades.filter((trade) => trade.action === "sell").length;
    const activity = recentTrades.map((trade) => `<div class="ai-trade ${trade.action}">
      <span>${trade.action === "buy" ? "↓" : "↑"}</span><div><b>${trade.symbol} · ${trade.action.toUpperCase()}</b><small>${new Date(trade.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</small></div>
      <div><small>Level</small><b>${trade.action === "buy" ? `B${trade.level}` : "+2% exit"}</b></div><div><small>Quantity</small><b>${number(trade.quantity)}</b></div><div><small>Paper price</small><b>${money(trade.price)}</b></div><div><small>Realized</small><b class="${trade.pnl >= 0 ? "positive" : "negative"}">${trade.action === "sell" ? money(trade.pnl) : "—"}</b></div>
    </div>`).join("") || `<div class="ai-empty"><b>No paper trades yet.</b><span>The ledger is watching each stock's cumulative move from Monday open and will record the first crossed −2% level here.</span></div>`;

    container.innerHTML = `${syncNotice}<section class="ai-command">
      <div><p class="eyebrow"><span></span> AUTOMATIC · PAPER ONLY</p><h3>Broad Indian market grid + per-stock walk-forward laboratory</h3><p>The scanner covers the official Nifty 500—large, mid and small caps—plus ${universe.continuityStocks || 0} prior-watchlist symbol${universe.continuityStocks === 1 ? "" : "s"} retained so an old paper position is never erased. The Monday 2% grid is the control; ${labSnapshot.testedCandidates || "multiple"} strategy variants and weighted evidence adjust paper size.</p></div>
      <div class="ai-heart"><strong>AI</strong><i></i><span>SCANNING<br />${universe.totalStocks || allStocks.length} STOCKS</span></div>
    </section>
    <section class="ai-universe-board">
      <header><div><span>OFFICIAL BROAD-MARKET COVERAGE</span><h3>${universe.name || "Nifty 500 broad market"}</h3><p>${coveredCount} of ${universe.totalStocks || allStocks.length} symbols currently have a stored Monday anchor and market history.</p></div><a href="${universe.sourceUrl || "https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500"}" target="_blank" rel="noopener">NSE Indices source ↗</a></header>
      <div class="ai-cap-coverage">
        <button type="button" class="${state.aiCapFilter === "all" ? "active" : ""}" data-ai-cap="all"><small>ALL</small><b>${allStocks.length}</b><span>Broad universe</span></button>
        <button type="button" class="${state.aiCapFilter === "large" ? "active" : ""}" data-ai-cap="large"><small>LARGE CAP</small><b>${capCounts.large}</b><span>Nifty 100</span></button>
        <button type="button" class="${state.aiCapFilter === "mid" ? "active" : ""}" data-ai-cap="mid"><small>MID CAP</small><b>${capCounts.mid}</b><span>Ranks 101–250</span></button>
        <button type="button" class="${state.aiCapFilter === "small" ? "active" : ""}" data-ai-cap="small"><small>SMALL CAP</small><b>${capCounts.small}</b><span>Ranks 251–500 + continuity</span></button>
      </div>
      <div class="ai-market-breadth"><span class="positive"><small>CONSTRUCTIVE ≥ +20</small><b>${modelBreadth.constructive}</b></span><span><small>MIXED −19 TO +19</small><b>${modelBreadth.mixed}</b></span><span class="negative"><small>CAUTIOUS ≤ −20</small><b>${modelBreadth.cautious}</b></span><span><small>BUILDING HISTORY</small><b>${modelBreadth.learning}</b></span></div>
      <p class="ai-model-truth"><b>Model type:</b> deterministic quantitative ensemble + chronological walk-forward tests. No trained neural network is currently deployed. “Learning” means history is still being collected, not that a deep-learning model is training.</p>
    </section>
    <div class="portfolio-summary ai-summary">
      <article class="portfolio-mini"><span>Virtual allocation</span><strong>${money(summary.allocated)}</strong></article>
      <article class="portfolio-mini"><span>Total equity</span><strong>${money(equity)}</strong></article>
      <article class="portfolio-mini"><span>Deployed cost</span><strong>${money(summary.invested)}</strong></article>
      <article class="portfolio-mini"><span>Total P&amp;L</span><strong class="${totalPnl >= 0 ? "positive" : "negative"}">${money(totalPnl)}</strong></article>
      <article class="portfolio-mini"><span>Open lots</span><strong>${summary.openLots || 0}</strong></article>
      <article class="portfolio-mini"><span>Last secured run</span><strong class="ai-time">${updated}</strong></article>
      <article class="portfolio-mini"><span>Historical vault</span><strong>${number(storage.totalHistoryRows || 0)} rows</strong><small>${number(storage.minimumHistorySessions || 0)}–${number(storage.maximumHistorySessions || 0)} sessions per stock</small></article>
      <article class="portfolio-mini"><span>Operational database</span><strong class="${storage.googleSheetsArchive === "connected" ? "positive" : ""}">${storage.operationalDatabase || "Not available"}</strong><small>${storage.googleSheetsArchive === "connected" ? "Private ledger + compressed five-year price history" : "Google Sheet endpoint and secret are not connected"}</small></article>
    </div>
    <div class="portfolio-intro ai-activity-head"><div><p class="eyebrow"><span></span> MACHINE AUDIT TRAIL</p><h2>What AI bought and sold.</h2></div><p><b>${buyCount} buys · ${sellCount} sells</b> in the latest ${recentTrades.length} records. Every paper fill preserves its rule, quantity, price, quant size and timestamp.</p></div>
    <div class="ai-trades">${activity}</div>
    <label class="ai-search"><span>⌕</span><input id="aiGridSearch" type="search" placeholder="Find a stock inside the AI grid…" /></label>
    <div class="ai-ledger-head"><span>Showing ${visibleStocks.length} of ${stocks.length} matching stocks</span><span>Monday reference</span><span>Live / latest</span><span>Cash</span><span>P&amp;L</span></div>
    <div class="ai-stock-list">${rows || `<div class="ai-empty"><b>No stock matches this search.</b></div>`}</div>
    ${visibleStocks.length < stocks.length ? `<button type="button" class="ai-load-more" data-ai-more>Show ${Math.min(50, stocks.length - visibleStocks.length)} more stocks ↓</button>` : ""}
    `;
    const input = el("aiGridSearch");
    if (input) {
      input.value = state.aiSearch;
      input.addEventListener("input", () => { state.aiSearch = input.value; state.aiVisibleLimit = 50; renderAiPortfolio(); requestAnimationFrame(() => { const next = el("aiGridSearch"); next?.focus(); next?.setSelectionRange(state.aiSearch.length, state.aiSearch.length); }); });
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

    const filteredItems = filteredPortfolioItems(metrics.items);


    const cards = filteredItems.map((item) => {
      const isFuture = item.assetType === "future";
      const live = isFuture ? item.markPrice : (currentPrice(item.symbol) ?? item.average);
      const spot = currentPrice(item.symbol);
      const data = market.get(item.symbol);
      const value = live * item.quantity;
      const direction = item.position === "short" ? -1 : 1;
      const pnlValue = isFuture && item.hasBrokerMtm ? item.brokerMtm : (live - item.average) * item.quantity * direction;
      const pnlPercent = item.cost ? (pnlValue / item.cost) * 100 : 0;
      const weeklyBase = isFuture ? (Number(item.weeklyBase) || live) : (Number(data?.weekly?.openingPrice) || item.average);
      const weeklyReference = isFuture ? live : (Number(data?.price) || live);

      const weeklyPnlPct = weeklyBase ? direction * (weeklyReference / weeklyBase - 1) * 100 : 0;
      const plan = exitPlan(item, data, live);
      const suggestion = data ? personalSignal(item.symbol, data, item) : { action: "loading", label: "LOADING WEEKLY CALL", detail: "Waiting for the latest market session" };
      const recommendation = data ? weightedRecommendation(data, suggestion) : { tone: "wait", label: "WAITING FOR EVIDENCE", detail: "The current technical and statistical evidence is still loading." };
      const lastTarget = plan.targets.at(-1).price;
      const progress = Math.max(0, Math.min(100, direction * (live - plan.base) / Math.abs(lastTarget - plan.base) * 100));
      const flagProgress = Math.max(4, Math.min(96, progress));
      const targets = plan.targets.map((target, index) => {
        const content = `<span><b>${item.position === "short" ? "C" : "S"}${index + 1}</b><i>${isFuture && !item.exactMark && !item.brokerClose ? "planned level" : target.status === "reached" ? "Reached ✓" : target.status === "close" ? "Very close" : `${number(Math.max(0, target.distance))}% away`}</i></span><strong>${money(target.price)}</strong><small>${pct(target.gainPct)} · 2% step ${target.step} · ${number(plan.slice)} units</small>`;
        return isFuture ? `<div class="exit-band future-band">${content}</div>` : `<button class="exit-band ${target.status}" data-exit-band data-exit-symbol="${item.symbol}" data-exit-price="${target.price}" data-exit-qty="${plan.slice}">${content}</button>`;
      }).join("");
      const expiry = item.expiry ? new Date(`${item.expiry}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "";
      const instrumentCopy = isFuture ? `${item.market} · ${expiry} · ${item.position.toUpperCase()} ${number(item.quantity)}` : `${bySymbol.get(item.symbol)?.marketCapCategory || "Equity"} · ${number(item.quantity)} units · ${item.lots} lot${item.lots === 1 ? "" : "s"}`;
      const markCopy = isFuture && item.brokerClose ? "Closing price" : isFuture && item.exactMark ? "Synchronized GM price" : isFuture ? "Broker snapshot" : "Live price";
      const actionMarkup = isFuture ? `<span class="contract-chip ${item.position}">${item.position === "short" ? "SHORT FUTURE" : "LONG FUTURE"}</span>` : `<button class="small-button" data-open-buy="${item.symbol}">Add</button><button class="small-button sell" data-open-sell="${item.symbol}">Reduce</button>`;
      const suggestionAction = !isFuture && suggestion.action === "buy" ? `<button class="suggestion-button" data-open-buy="${item.symbol}">Open buy ticket</button>` : !isFuture && suggestion.action === "sell" ? `<button class="suggestion-button" data-open-sell="${item.symbol}">Open sell ticket</button>` : "";
      const mobileExpanded = state.mobileExpandedHoldings.has(item.symbol);
      const mobileHoldingBrief = `<section class="mobile-holding-brief ${suggestion.action}">
        <div><span><small>CURRENT DECISION</small><strong>${recommendation.label}</strong></span><span><small>VERIFIED WEEKLY GM BASE</small><b>${money(weeklyBase)}</b></span><span><small>MOVE FROM WEEKLY BASE</small><b class="${weeklyPnlPct >= 0 ? "positive" : "negative"}">${pct(weeklyPnlPct)} · signal only</b></span></div>
        <div class="mobile-decision-grid"><span><small>BUY ≤</small><b>${money(suggestion.buyAt)}</b></span><span><small>NOW</small><b>${money(suggestion.current ?? live)}</b></span><span><small>SELL ≥</small><b>${money(suggestion.sellAt)}</b></span></div>
        <button type="button" data-toggle-mobile-holding="${item.symbol}" aria-expanded="${mobileExpanded}">${mobileExpanded ? "Hide levels and maths ↑" : "Show levels and maths ↓"}</button>
      </section>`;
      const holdingEvidence = data ? (() => {
        const evidence = evidenceForAction(data, suggestion.action);
        return `<details class="holding-evidence"><summary><span>31-DAY + 3-MONTH + QUANT CHECK</span><b class="${evidence.tone}">${evidence.label}</b></summary><div><span><small>31-day low / high</small><b>${money(data.window.low)} / ${money(data.window.high)}</b></span><span><small>3-month low / high</small><b>${money(data.quarter?.low)} / ${money(data.quarter?.high)}</b></span><span><small>3-month return</small><b class="${Number(data.signals?.return63Pct) >= 0 ? "positive" : "negative"}">${pct(Number(data.signals?.return63Pct))}</b></span><span><small>Max drawdown</small><b>${number(data.signals?.maxDrawdown63Pct)}%</b></span><span><small>Risk-sized chunk</small><b>${money(40_000 * (Number(data.signals?.riskBudgetMultiplier) || 1))}</b></span></div><p>${evidence.detail} Open ${item.symbol} from the watchlist for the full evidence stack and probability sample.</p></details>`;
      })() : "";
      return `<article class="holding-shell ${mobileExpanded ? "mobile-expanded" : ""}" data-holding-symbol="${item.symbol}"><div class="holding-card">
        <div class="symbol-cell"><span class="symbol-avatar">${initials(item.symbol)}</span><div><b>${item.symbol}${isFuture ? " FUT" : ""}</b><small>${instrumentCopy}</small></div></div>
        <div class="holding-metric"><span>Average entry</span><strong>${money(item.average)}</strong></div>
        <div class="holding-metric"><span>${markCopy} · notional</span><strong>${money(live)} · ${money(value)}</strong>${isFuture && Number.isFinite(spot) ? `<small class="spot-reference">Spot reference ${money(spot)}</small>` : ""}</div>
        <div class="holding-metric"><span>Open P&amp;L</span><strong class="${pnlValue >= 0 ? "positive" : "negative"}">${isFuture && !item.exactMark && !item.brokerClose ? "Awaiting futures LTP" : `${money(pnlValue)} · ${pct(pnlPercent)}`}</strong></div>
        <div class="holding-actions">${actionMarkup}</div>
      </div>${mobileHoldingBrief}<section class="portfolio-call ${recommendation.tone}"><div><span>OPEN-TRADE DECISION</span><strong>${recommendation.label}</strong><p>${recommendation.detail}</p><div class="weekly-book-strip"><span>VERIFIED WEEKLY GM BASE ${money(weeklyBase)}</span><b class="${weeklyPnlPct >= 0 ? "positive" : "negative"}">${pct(weeklyPnlPct)} from weekly base</b><small>Signal distance only—not profit or loss. GM MTM above is the authoritative P&amp;L.</small></div><div class="decision-levels"><div class="decision-buy"><span>${item.position === "short" ? "COVER AT OR BELOW" : "BUY AT OR BELOW"}</span><strong>${money(suggestion.buyAt)}</strong></div><div class="decision-now"><span>CURRENT PRICE</span><strong>${money(suggestion.current)}</strong></div><div class="decision-sell"><span>${item.position === "short" ? "RISK AT OR ABOVE" : "SELL AT OR ABOVE"}</span><strong>${money(suggestion.sellAt)}</strong></div></div><span class="daily-range-title">TODAY'S OBSERVED GM RANGE</span><div class="daily-range"><div><span>${isFuture ? "OBSERVED GM LOW" : "DAILY LOW"}</span><strong>${money(isFuture ? item.dailyLow : data?.daily?.low)}</strong></div><div><span>NOW</span><strong>${money(suggestion.current)}</strong></div><div><span>${isFuture ? "OBSERVED GM HIGH" : "DAILY HIGH"}</span><strong>${money(isFuture ? item.dailyHigh : data?.daily?.high)}</strong></div></div>${isFuture ? `<small class="price-source-note">Action and P&amp;L use the synchronized GM futures mark ${money(live)}. Spot evidence is shown separately for technical context.</small>` : ""}</div>${suggestionAction}</section>${holdingEvidence}<section class="exit-plan">
        <div class="exit-plan-head"><div><span>${item.position === "short" ? "FIVE 2% COVER CHUNKS · BELOW" : "FIVE 2% SELL CHUNKS · ABOVE"} ${money(plan.base)} VERIFIED WEEKLY GM BASE</span><h3>${item.position === "short" ? "Every further 2% fall → cover one slice" : "Every further 2% rise → sell one slice"}</h3></div><p>Even split: ${number(plan.slice)} of ${number(item.quantity)} units per chunk. Every level uses the verified weekly GM futures base and resets with the first valid Monday market capture.</p></div>
        <div class="exit-progress ${item.position === "short" ? "short-progress" : ""} ${isFuture && !item.exactMark && !item.brokerClose ? "snapshot-progress" : ""}"><span style="width:${progress}%"></span><i style="left:${flagProgress}%">${item.brokerClose ? "CLOSE" : isFuture && !item.exactMark ? "ENTRY MARK" : "NOW"} ${money(live)}</i><b>BASE ${money(plan.base)}</b><b>FINAL ${money(lastTarget)}</b></div>
        <div class="exit-bands">${targets}</div>
        <p class="exit-risk"><b>Verified weekly GM-base 2% rule:</b> the first ${item.position === "short" ? "cover" : "sell"} line is ${money(plan.targets[0]?.price)} and the opposite 2% line is ${money(plan.riskLine)}. Average entry is used only for P&amp;L—not for action levels.</p>
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
      ${portfolioFiltersMarkup(metrics.items)}
      <p class="action-filter-status portfolio-filter-status">Showing ${filteredItems.length} of ${metrics.items.length} portfolio position${metrics.items.length === 1 ? "" : "s"}.${state.user === "shah@kamlesh" ? " Source: latest synchronized GM Global snapshot." : ""}</p>
      <div class="portfolio-summary">
        <article class="portfolio-mini"><span>${metrics.hasFutures ? "Reference notional" : "Market value"}</span><strong>${money(metrics.value)}</strong></article>
        <article class="portfolio-mini"><span>${metrics.hasFutures ? "Entry notional" : "Invested cost"}</span><strong>${money(metrics.cost)}</strong></article>
        ${metrics.hasFutures ? `<article class="portfolio-mini"><span>GM reported MTM</span><strong class="${metrics.pnl >= 0 ? "positive" : "negative"}">${money(metrics.pnl)}</strong><small>Broker value—not an underlying proxy</small></article>
        <article class="portfolio-mini"><span>GM signed net quantity</span><strong>${number(metrics.signedTotalQty)}</strong><small>${number(metrics.totalQty)} absolute · ${metrics.items.length} open positions</small></article>
        <article class="portfolio-mini"><span>Latest GM snapshot</span><strong class="${state.databaseOnline ? "positive" : "negative"}">${brokerSyncTime()}</strong><small>${state.portfolio?.brokerSync?.source === "gm-extension" ? "Automatic browser bridge" : "Synchronized broker source"}</small></article>` : `<article class="portfolio-mini"><span>Realized P&amp;L</span><strong class="${state.portfolio.realizedPnl >= 0 ? "positive" : "negative"}">${money(state.portfolio.realizedPnl)}</strong></article>
        <article class="portfolio-mini"><span>Private database</span><strong class="${state.databaseOnline ? "positive" : "negative"}">${state.databaseOnline ? "Synchronized" : "Offline copy"}</strong></article>`}
      </div>
      <div class="holdings-list">${cards || `<div class="empty-portfolio"><div><div class="empty-orbit">⌕</div><h3>No portfolio position matches</h3><p>Change the action, symbol, sector, market-cap, range or quant filter.</p><button class="empty-reset" type="button" data-reset-portfolio-filters>Show every portfolio position</button></div></div>`}</div>
      ${transactions ? `<div class="portfolio-intro" style="padding-top:55px;padding-bottom:20px"><div><p class="eyebrow"><span></span> Recent activity</p><h2 style="font-size:38px">Lot journal</h2></div></div><div class="holdings-list">${transactions}</div>` : ""}`;
    const portfolioSearch = container.querySelector('[data-portfolio-filter="query"]');
    if (portfolioSearch) portfolioSearch.value = state.portfolioFilters.query;
    renderSummary();
  }

  function setFeedStatus(kind, text) {
    feedPill.className = `feed-pill ${kind || ""}`;
    feedPill.querySelector("span").textContent = text;
  }

  function renderMarketViewsStable() {
    clearTimeout(state.marketRenderTimer);
    const run = () => {
      const scrollingFor = Date.now() - state.lastScrollAt;
      if (scrollingFor < 260) {
        state.marketRenderTimer = setTimeout(run, 280 - scrollingFor);
        return;
      }
      const row = document.elementFromPoint(Math.min(window.innerWidth / 2, 220), Math.min(170, window.innerHeight / 3))?.closest?.("[data-symbol]");
      const anchorSymbol = row?.dataset?.symbol;
      const anchorTop = row?.getBoundingClientRect().top;
      const previousY = window.scrollY;
      renderWatchlist();
      renderFocusMap();
      if (el("portfolioPanel").classList.contains("active")) renderPortfolio();
      if (state.currentSymbol) renderDrawer(state.currentSymbol);
      requestAnimationFrame(() => {
        const replacement = anchorSymbol ? stockList.querySelector(`[data-symbol="${CSS.escape(anchorSymbol)}"]`) : null;
        if (replacement && Number.isFinite(anchorTop)) {
          const shift = replacement.getBoundingClientRect().top - anchorTop;
          if (Math.abs(shift) > 1) window.scrollBy({ top: shift, left: 0, behavior: "instant" });
        } else if (Math.abs(window.scrollY - previousY) > 2) {
          window.scrollTo({ top: previousY, left: 0, behavior: "instant" });
        }
      });
    };
    const delay = Math.max(0, 280 - (Date.now() - state.lastScrollAt));
    state.marketRenderTimer = setTimeout(run, delay);
  }

  async function fetchSymbols(symbols) {
    const unique = [...new Set(symbols)].filter(Boolean);
    const batches = Array.from({ length: Math.ceil(unique.length / 10) }, (_, index) => unique.slice(index * 10, index * 10 + 10));
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor];
        cursor += 1;
        try {
          const response = await fetch(`/api/market?symbols=${encodeURIComponent(batch.join(","))}`);
          const payload = await response.json();
          for (const item of payload.data || []) market.set(item.symbol, item);
          if (!response.ok && !payload.data?.length) throw new Error(payload.error || payload.errors?.[0]?.message || "Market feed unavailable");
        } catch (error) {
          console.warn("K² market batch failed", batch, error);
        }
        completed += 1;
        if (state.user !== "ai") el("loadedCount").textContent = `${market.size} / ${watchlist.length}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, () => worker()));
    renderMarketViewsStable();
  }

  async function refreshAll() {
    if (state.refreshing || !state.user) return;
    state.refreshing = true;
    refreshButton.classList.add("spinning");
    setFeedStatus("", "Updating 31-day maps");
    const owned = holdings().map((item) => item.symbol);
    const allSymbols = [...new Set([...owned, ...watchlist.map((item) => item.symbol)])];
    const firstScreen = [...new Set([state.focusSymbol, ...filteredWatchlist().slice(0, 30).map((item) => item.symbol), ...owned.slice(0, 10)])].filter(Boolean);
    await fetchSymbols(firstScreen);
    const prioritySet = new Set(firstScreen);
    const remaining = allSymbols.filter((symbol) => !prioritySet.has(symbol));
    if (remaining.length) {
      setFeedStatus("", `Updating ${remaining.length} background symbols`);
      await fetchSymbols(remaining);
    }
    state.refreshing = false;
    refreshButton.classList.remove("spinning");
    if (market.size) {
      setFeedStatus("live", "Market feed connected");
      el("lastUpdated").textContent = state.user === "ai" && state.aiLedger.updatedAt
        ? `AI scan ${new Date(state.aiLedger.updatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`
        : `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
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
      el("lastUpdated").textContent = state.user === "ai" && state.aiLedger.updatedAt
        ? `AI scan ${new Date(state.aiLedger.updatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`
        : `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
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
      <p class="daily-range-title"><b>Today's live market range</b> · resets every trading day</p>
      <div class="daily-range drawer-daily-range">
        <div><span>DAILY LOW</span><strong>${money(data.daily?.low)}</strong></div>
        <div class="decision-now"><span>CURRENT PRICE</span><strong>${money(data.price)}</strong></div>
        <div><span>DAILY HIGH</span><strong>${money(data.daily?.high)}</strong></div>
      </div>
      <div class="drawer-chart">${chartSvg(data)}</div>
      <div class="range-stats range-core">
        <div class="range-stat"><span>31-day low</span><strong>${money(data.window.low)}</strong></div>
        <div class="range-stat"><span>Midpoint</span><strong>${money(data.window.midpoint)}</strong></div>
        <div class="range-stat"><span>31-day high</span><strong>${money(data.window.high)}</strong></div>
      </div>
      <div class="range-stats range-quarter">
        <div class="range-stat"><span>3-month low</span><strong>${money(data.quarter?.low)}</strong></div>
        <div class="range-stat"><span>3-month location</span><strong>${number(data.quarter?.positionPct)}%</strong></div>
        <div class="range-stat"><span>3-month high</span><strong>${money(data.quarter?.high)}</strong></div>
      </div>
      ${(() => { const pulse = pulseDescription(data); return `<section class="trade-pulse ${pulse.tone}"><div class="pulse-orb"><b>${data.signals?.pulseScore > 0 ? "+" : ""}${data.signals?.pulseScore ?? 0}</b><span>of ±3</span></div><div><span>K² REGIME ENGINE · ${String(data.signals?.marketRegime || "transition").toUpperCase()}</span><h3>${pulse.label}</h3><p>${pulse.detail}. ${pulse.method}</p></div></section>`; })()}
      ${(() => { const evidence = evidenceReadout(data); return `<section class="evidence-banner drawer-evidence ${evidence.tone}"><div><span>CROSS-MARKET EVIDENCE · ${data.signals?.evidenceScore > 0 ? "+" : ""}${data.signals?.evidenceScore ?? 0} / 3</span><strong>${evidence.label}</strong><p>${evidence.detail}</p></div><b>${money(40_000 * (Number(data.signals?.riskBudgetMultiplier) || 1))}<small>VOL-SCALED CHUNK</small></b></section>`; })()}
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

  async function selectFullAnalysis(symbol) {
    if (!symbol) return;
    closeDrawer();
    state.focusSymbol = symbol;
    state.mobileFocusExpanded = true;
    renderWatchlist();
    renderFocusMap();
    el("focusMap").scrollIntoView({ block: "start", behavior: "auto" });
    el("focusMap").focus?.({ preventScroll: true });
    if (!market.has(symbol)) {
      setFeedStatus("", `Loading ${symbol} analysis`);
      await fetchSymbols([symbol]);
      if (state.focusSymbol === symbol) {
        renderFocusMap();
        el("focusMap").scrollIntoView({ block: "start", behavior: "auto" });
      }
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
    const phone = window.matchMedia("(max-width: 700px)").matches;
    let width = 0, height = 0, points = [], pointer = { x: -999, y: -999 }, scrollPhase = 0, lastFrame = 0, lastSpark = 0;
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = phone ? Math.min(16, Math.max(10, Math.round(width * height / 36000))) : Math.min(54, Math.max(22, Math.round(width * height / 26000)));
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
      if (phone && Date.now() - state.lastScrollAt < 180) {
        if (!reduced) state.ambientFrame = requestAnimationFrame(draw);
        return;
      }
      const frameInterval = phone ? 82 : 32;
      if (time - lastFrame < frameInterval && !reduced) { state.ambientFrame = requestAnimationFrame(draw); return; }
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
      const count = burst ? (phone ? 2 : 5) : 1;
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
    const selector = ".hero-copy,.k2-bond-stage,.snapshot-card,.section-tabs,.toolbar,.trade-planner,.method-strip,.focus-map,.horizon-compare,.evidence-banner,.stock-row,.portfolio-intro,.portfolio-mini,.holding-shell,.signal-card,.exit-band,.system-note";
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

  async function activateSession(session) {
    state.user = session.username;
    state.displayName = session.displayName || session.username;
    state.csrf = session.csrf;
    const aiMode = state.user === "ai";
    state.portfolio = loadPortfolio();
    state.aiLedger = aiMode ? (loadCachedAiLedger() || emptyAiLedger()) : emptyAiLedger();
    state.aiCapFilter = "all";
    state.aiVisibleLimit = 50;
    state.aiLoading = aiMode;
    state.aiError = null;
    state.plannerKey = null;
    state.actionFilter = "all";
    state.portfolioFilters = { query: "", band: "all", sector: "all", cap: "all", model: "all", sort: "journal", action: "all" };
    el("actionFilterStatus").hidden = true;
    el("tradePlanner").hidden = aiMode;
    el("actionFilters").hidden = aiMode;
    el("trackedLabel").textContent = aiMode ? "AI broad universe" : "Tracked universe";
    el("trackedDescription").textContent = aiMode ? "Nifty 500 large + mid + small cap coverage" : "symbols from journal (1).xlsx";
    el("loadedLabel").textContent = aiMode ? "Scan coverage" : "Live map";
    el("watchlistTabLabel").textContent = aiMode ? "Original 130" : "Watchlist";
    el("portfolioTabLabel").textContent = aiMode ? "AI Broad Grid" : "Portfolio";
    el("portfolioOverline").textContent = aiMode ? "Autonomous Monday-grid laboratory" : "Private cloud portfolio";
    el("portfolioHeading").innerHTML = aiMode ? `The machine watches,<br /><em>the ledger remembers.</em>` : `Your positions,<br /><em>measured live.</em>`;
    el("portfolioIntroCopy").textContent = aiMode
      ? "K² scans a broad Indian large-, mid- and small-cap universe from Monday opening anchors. Every simulated fill is automatic, isolated and auditable across devices."
      : state.user === "shah@kamlesh"
        ? "This account follows the latest synchronized GM Global portfolio snapshot. Search and action filters use K² market and quant evidence for only those open GM positions."
        : "Entry lots are stored securely under your signed-in account and follow you across devices. Current value and open P&L move with the same market feed as your watchlist.";
    el("methodCopy").innerHTML = aiMode
      ? "<b>AI weekly rule:</b> Monday opening becomes the anchor; five risk-sized slots compound downward by 2%; every filled lot receives its own automatic +2% paper exit and a stored quant decision snapshot."
      : "<b>Action rule:</b> Monday opening is the base for all five buy and five sell prices. The 31-day and three-month ranges remain context—not the weekly action base.";
    el("userName").textContent = state.displayName;
    el("userPill").classList.remove("hidden");
    el("authGate").classList.add("signed-in");
    el("loginPassword").value = "";
    el("loginError").textContent = "";
    renderWatchlist();
    renderFocusMap();
    renderPortfolio();
    renderSummary();
    if (aiMode) {
      document.querySelectorAll(".tab-button").forEach((node) => node.classList.toggle("active", node.dataset.tab === "portfolio"));
      document.querySelectorAll(".workspace-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "portfolioPanel"));
    }
    if (aiMode) void syncAiLedger(); else void syncServerPortfolio();
    if (!market.size) void refreshAll(); else void refreshPriority();
    if (!state.refreshTimer) state.refreshTimer = setInterval(refreshPriority, 60_000);
    if (aiMode && !state.aiRefreshTimer) state.aiRefreshTimer = setInterval(syncAiLedger, 60_000);
    if (!aiMode && !state.portfolioRefreshTimer) state.portfolioRefreshTimer = setInterval(() => { if (!document.hidden && state.user) void syncServerPortfolio(); }, 60_000);
  }

  function showLogin() {
    state.user = null;
    state.displayName = null;
    state.csrf = null;
    state.databaseOnline = false;
    state.portfolio = emptyPortfolio();
    state.aiLedger = emptyAiLedger();
    state.aiSearch = "";
    state.aiLoading = false;
    state.aiError = null;
    state.aiSyncing = false;
    state.plannerKey = null;
    state.actionFilter = "all";
    state.portfolioFilters = { query: "", band: "all", sector: "all", cap: "all", model: "all", sort: "journal", action: "all" };
    el("actionFilterStatus").hidden = true;
    el("tradePlanner").hidden = false;
    el("actionFilters").hidden = false;
    clearInterval(state.aiRefreshTimer);
    state.aiRefreshTimer = null;
    clearInterval(state.portfolioRefreshTimer);
    state.portfolioRefreshTimer = null;
    el("trackedLabel").textContent = "Tracked universe";
    el("trackedDescription").textContent = "symbols from journal (1).xlsx";
    el("loadedLabel").textContent = "Live map";
    el("watchlistTabLabel").textContent = "Watchlist";
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
    if (row) void selectFullAnalysis(row.dataset.symbol);
  });
  stockList.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-symbol]")) {
      event.preventDefault();
      void selectFullAnalysis(event.target.dataset.symbol);
    }
  });

  el("portfolioContent").addEventListener("click", (event) => {
    if (event.target.closest("[data-retry-ai]")) { syncAiLedger(); return; }
    const portfolioAction = event.target.closest("[data-portfolio-action]");
    if (portfolioAction) {
      state.portfolioFilters.action = portfolioAction.dataset.portfolioAction;
      renderPortfolio();
      return;
    }
    if (event.target.closest("[data-reset-portfolio-filters]")) {
      state.portfolioFilters = { query: "", band: "all", sector: "all", cap: "all", model: "all", sort: "journal", action: "all" };
      renderPortfolio();
      return;
    }
    const aiCap = event.target.closest("[data-ai-cap]");
    if (aiCap) {
      state.aiCapFilter = aiCap.dataset.aiCap;
      state.aiVisibleLimit = 50;
      renderAiPortfolio();
      return;
    }
    if (event.target.closest("[data-ai-more]")) {
      state.aiVisibleLimit += 50;
      renderAiPortfolio();
      return;
    }
    const mobileHolding = event.target.closest("[data-toggle-mobile-holding]");
    if (mobileHolding) {
      const symbol = mobileHolding.dataset.toggleMobileHolding;
      const shell = mobileHolding.closest(".holding-shell");
      const expanded = !state.mobileExpandedHoldings.has(symbol);
      if (expanded) state.mobileExpandedHoldings.add(symbol); else state.mobileExpandedHoldings.delete(symbol);
      shell?.classList.toggle("mobile-expanded", expanded);
      mobileHolding.setAttribute("aria-expanded", String(expanded));
      mobileHolding.textContent = expanded ? "Hide levels and maths ↑" : "Show levels and maths ↓";
      return;
    }
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
  el("portfolioContent").addEventListener("input", (event) => {
    const input = event.target.closest('[data-portfolio-filter="query"]');
    if (!input) return;
    state.portfolioFilters.query = input.value;
    renderPortfolio();
    requestAnimationFrame(() => {
      const next = el("portfolioContent").querySelector('[data-portfolio-filter="query"]');
      next?.focus({ preventScroll: true });
      next?.setSelectionRange(state.portfolioFilters.query.length, state.portfolioFilters.query.length);
    });
  });
  el("portfolioContent").addEventListener("change", (event) => {
    const control = event.target.closest("[data-portfolio-filter]");
    if (!control || control.dataset.portfolioFilter === "query") return;
    state.portfolioFilters[control.dataset.portfolioFilter] = control.value;
    renderPortfolio();
  });
  el("drawerContent").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-ai-grid]")) { closeDrawer(); document.querySelector('[data-tab="portfolio"]').click(); return; }
    const add = event.target.closest("[data-drawer-add]");
    if (add) { closeDrawer(); openTrade(add.dataset.drawerAdd); }
  });
  el("focusMap").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-ai-grid]")) { document.querySelector('[data-tab="portfolio"]').click(); return; }
    const mobileToggle = event.target.closest("[data-toggle-mobile-focus]");
    if (mobileToggle) {
      state.mobileFocusExpanded = !state.mobileFocusExpanded;
      el("focusMap").classList.toggle("mobile-expanded", state.mobileFocusExpanded);
      mobileToggle.setAttribute("aria-expanded", String(state.mobileFocusExpanded));
      mobileToggle.textContent = state.mobileFocusExpanded ? "Hide full analysis ↑" : "Full analysis & 10 levels ↓";
      return;
    }
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
  el("actionFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action-filter]");
    if (!button) return;
    state.actionFilter = button.dataset.actionFilter;
    state.visibleLimit = 30;
    renderWatchlist();
    const filtered = filteredWatchlist();
    const status = el("actionFilterStatus");
    if (state.actionFilter === "all") {
      status.hidden = true;
    } else {
      const label = state.actionFilter === "alert" ? "REVIEW" : state.actionFilter.toUpperCase();
      status.hidden = false;
      status.textContent = filtered.length
        ? `Showing ${filtered.length} ${label} stock${filtered.length === 1 ? "" : "s"}. First match: ${filtered[0].symbol}.`
        : `No ${label} stocks match the other filters right now.`;
    }
    if (filtered[0]) {
      state.focusSymbol = filtered[0].symbol;
      state.mobileFocusExpanded = false;
      renderFocusMap();
      requestAnimationFrame(() => {
        const firstRow = stockList.querySelector(`[data-symbol="${CSS.escape(filtered[0].symbol)}"]`);
        firstRow?.scrollIntoView({ block: "start", behavior: "instant" });
        firstRow?.focus({ preventScroll: true });
      });
      toast(`${filtered.length} ${state.actionFilter === "alert" ? "review" : state.actionFilter} stock${filtered.length === 1 ? "" : "s"} shown.`);
    }
  });
  el("searchInput").addEventListener("input", () => {
    state.visibleLimit = 30;
    renderWatchlist();
    const first = filteredWatchlist()[0];
    if (el("searchInput").value.trim() && first) {
      state.focusSymbol = first.symbol;
      renderFocusMap();
    }
  });
  [el("bandFilter"), el("sectorFilter"), el("capFilter"), el("modelFilter"), el("sortSelect")].forEach((node) => node.addEventListener("change", () => { state.visibleLimit = 30; renderWatchlist(); }));
  [el("plannerBuy"), el("plannerSell")].forEach((node) => node.addEventListener("input", () => { el("plannerSource").value = "custom"; state.plannerKey = `${state.focusSymbol}:custom`; updateTradePlanner(); }));
  el("plannerAmount").addEventListener("input", updateTradePlanner);
  el("plannerSource").addEventListener("change", () => syncTradePlanner(true));

  let scrollIdleTimer;
  window.addEventListener("scroll", () => {
    state.lastScrollAt = Date.now();
    document.body.classList.add("is-scrolling");
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => document.body.classList.remove("is-scrolling"), 180);
  }, { passive: true });

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
    el("methodModal").classList.remove("open");
  });

  if ("serviceWorker" in navigator) window.addEventListener("load", async () => {
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(registrations.map((registration) => registration.unregister())).catch(() => {});
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.filter((key) => key.startsWith("k2-")).map((key) => caches.delete(key))).catch(() => {});
    if (navigator.serviceWorker.controller && !sessionStorage.getItem("k2-cache-retired-23")) {
      sessionStorage.setItem("k2-cache-retired-23", "1");
      const url = new URL(location.href);
      url.searchParams.set("k2v", "23");
      location.replace(url.href);
    }
  });
  bootstrapAuth();
})();
