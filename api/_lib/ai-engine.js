const crypto = require("node:crypto");
const { resultBars } = require("./market-feed");

const DAY = 86_400_000;
const CONFIG = Object.freeze({
  budgetPerStock: 200_000,
  slots: 5,
  slotBudget: 40_000,
  buyStepPct: 2,
  takeProfitPct: 2,
  historySessionLimit: 1_300
});

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function indiaParts(milliseconds) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(milliseconds));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDate(milliseconds) {
  const part = indiaParts(milliseconds);
  return `${part.year}-${part.month}-${part.day}`;
}

function dateMinus(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * DAY).toISOString().slice(0, 10);
}

function mondayOpening(result) {
  const bars = resultBars(result);
  if (!bars.length) throw new Error("No usable daily bars");
  const latest = bars.at(-1);
  const latestDate = localDate(latest.timestamp * 1000);
  const weekday = new Date(`${latestDate}T12:00:00Z`).getUTCDay();
  const weekKey = dateMinus(latestDate, (weekday + 6) % 7);
  const sessions = bars.filter((bar) => localDate(bar.timestamp * 1000) >= weekKey);
  const first = sessions[0] || latest;
  return {
    weekKey,
    barDate: localDate(first.timestamp * 1000),
    price: round(Number.isFinite(first.open) ? first.open : first.close)
  };
}

function buyLevels(anchorPrice) {
  return Array.from({ length: CONFIG.slots }, (_, index) => round(anchorPrice * (0.98 ** (index + 1))));
}

function quantSizing(context = {}) {
  const signals = context.signals || {};
  const analog = context.analogModel || {};
  const empirical = context.empirical || {};
  const decision = context.decisionModel || {};
  const strategy = context.strategyLab?.selected || null;
  const candle = context.candleStudy || {};
  let multiplier = Number(signals.riskBudgetMultiplier);
  multiplier = Number.isFinite(multiplier) ? Math.max(0.25, Math.min(1, multiplier)) : 1;
  const reasons = [`volatility sizing ${round(multiplier * 100)}%`];
  if (signals.riskState === "high") {
    multiplier *= 0.65;
    reasons.push("high-risk regime");
  } else if (signals.riskState === "elevated") {
    multiplier *= 0.82;
    reasons.push("elevated-risk regime");
  }
  if (Number(signals.evidenceScore) <= -2) {
    multiplier *= 0.75;
    reasons.push("weak trend evidence");
  }
  if (analog.ready && Number(analog.probabilityUp5Pct) < 45) {
    multiplier *= 0.8;
    reasons.push("historical analogues below 45%");
  } else if (analog.ready && Number(analog.probabilityUp5Pct) >= 60) {
    multiplier *= 1.08;
    reasons.push("historical analogues at least 60%");
  }
  if (Number.isFinite(empirical.down2HitPct) && Number(empirical.down2HitPct) < 25) {
    multiplier *= 0.9;
    reasons.push("rare weekly 2% dip");
  }
  if (Number(decision.score) <= -35) {
    multiplier *= 0.5;
    reasons.push(`weighted evidence ${round(decision.score)} / 100`);
  } else if (Number(decision.score) < 0) {
    multiplier *= 0.78;
    reasons.push(`mixed-adverse evidence ${round(decision.score)} / 100`);
  } else if (Number(decision.score) >= 35) {
    multiplier *= 1.08;
    reasons.push(`weighted evidence ${round(decision.score)} / 100`);
  }
  if (strategy?.passed && Number(strategy.currentSignal) > 0) {
    multiplier *= 1.08;
    reasons.push(`${strategy.family} walk-forward pass`);
  } else if (strategy?.passed && Number(strategy.currentSignal) < 0) {
    multiplier *= 0.7;
    reasons.push(`${strategy.family} currently bearish`);
  } else if (context.strategyLab?.ready && !strategy) {
    multiplier *= 0.85;
    reasons.push("no strategy family passed validation");
  }
  if (Number(candle.directionScore) < -0.35) {
    multiplier *= 0.85;
    reasons.push(`${candle.pattern || "bearish candle"} caution`);
  } else if (Number(candle.directionScore) > 0.35 && Number(candle.sample) >= 5) {
    multiplier *= 1.04;
    reasons.push(`${candle.pattern} confirmation`);
  }
  multiplier = Math.max(0.25, Math.min(1, multiplier));
  return { multiplier: round(multiplier, 4), reasons };
}

function emptySymbolState(symbol) {
  return {
    symbol,
    cash: CONFIG.budgetPerStock,
    realizedPnl: 0,
    lots: [],
    anchor: null,
    levels: [],
    triggeredLevels: Array(CONFIG.slots).fill(false),
    lastPrice: null,
    lastSession: null,
    observations: [],
    transactions: [],
    updatedAt: null
  };
}

function transactionId(...parts) {
  return crypto.createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32);
}

function processSymbol(previous, result, nowMs = Date.now(), context = {}) {
  const state = { ...emptySymbolState(previous?.symbol), ...structuredClone(previous || {}) };
  const bars = resultBars(result);
  if (!bars.length) throw new Error("No usable market bars");
  const bar = bars.at(-1);
  const sessionDate = localDate(bar.timestamp * 1000);
  const observationMap = new Map((Array.isArray(state.observations) ? state.observations : []).map((item) => [item.session, item]));
  bars.forEach((item) => {
    const session = localDate(item.timestamp * 1000);
    observationMap.set(session, {
      session,
      open: round(item.open ?? item.close), high: round(item.high), low: round(item.low), close: round(item.close),
      volume: Number.isFinite(item.volume) ? Math.round(item.volume) : null
    });
  });
  state.observations = [...observationMap.values()]
    .sort((left, right) => left.session.localeCompare(right.session))
    .slice(-CONFIG.historySessionLimit);
  const reference = mondayOpening(result);
  const anchorChanged = state.anchor?.weekKey !== reference.weekKey;
  const events = [];
  const sizing = quantSizing(context);

  // Existing lots may exit on a later session. Newly filled lots are never sold
  // against the same daily candle because the high/low ordering is unknown.
  const remainingLots = [];
  for (const lot of Array.isArray(state.lots) ? state.lots : []) {
    if (lot.boughtSession !== sessionDate && bar.high >= lot.target) {
      const proceeds = round(lot.quantity * lot.target);
      const pnl = round((lot.target - lot.price) * lot.quantity);
      state.cash = round(Number(state.cash) + proceeds);
      state.realizedPnl = round(Number(state.realizedPnl) + pnl);
      events.push({
        id: transactionId(lot.id, "SELL"), action: "sell", symbol: state.symbol,
        price: lot.target, quantity: lot.quantity, amount: proceeds, pnl,
        reason: "2% lot target reached", time: nowMs, session: sessionDate,
        anchorWeek: lot.anchorWeek, level: lot.level
      });
    } else remainingLots.push(lot);
  }
  state.lots = remainingLots;

  if (anchorChanged) {
    state.anchor = reference;
    state.levels = buyLevels(reference.price);
    state.triggeredLevels = Array(CONFIG.slots).fill(false);
  }

  state.levels.forEach((levelPrice, index) => {
    if (state.triggeredLevels[index] || bar.low > levelPrice) return;
    const deployed = (state.lots || []).reduce((sum, lot) => sum + Number(lot.amount || lot.quantity * lot.price), 0);
    const remainingCapacity = Math.max(0, CONFIG.budgetPerStock - deployed);
    const modelBudget = round(CONFIG.slotBudget * sizing.multiplier);
    const available = Math.min(modelBudget, Number(state.cash), remainingCapacity);
    const quantity = Math.floor(available / levelPrice);
    if (quantity < 1) return;
    const amount = round(quantity * levelPrice);
    const id = transactionId(state.symbol, reference.weekKey, `B${index + 1}`);
    state.cash = round(Number(state.cash) - amount);
    state.triggeredLevels[index] = true;
    const lot = {
      id, symbol: state.symbol, price: levelPrice, quantity, amount,
      target: round(levelPrice * 1.02), boughtSession: sessionDate,
      anchorWeek: reference.weekKey, level: index + 1, time: nowMs,
      quantMultiplier: sizing.multiplier
    };
    state.lots.push(lot);
    events.push({
      id, action: "buy", symbol: state.symbol, price: levelPrice, quantity,
      amount, pnl: 0,
      reason: `Monday open minus compounded 2% step ${index + 1}; ${sizing.reasons.join(", ")}`,
      time: nowMs, session: sessionDate, anchorWeek: reference.weekKey, level: index + 1,
      quantMultiplier: sizing.multiplier
    });
  });

  const livePrice = Number(result.meta?.regularMarketPrice);
  state.lastPrice = round(Number.isFinite(livePrice) ? livePrice : bar.close);
  state.lastSession = sessionDate;
  state.updatedAt = new Date(nowMs).toISOString();
  state.quant = {
    updatedAt: state.updatedAt,
    sizing,
    signals: context.signals || null,
    empirical: context.empirical || null,
    analogModel: context.analogModel || null,
    candleStudy: context.candleStudy || null,
    strategyLab: context.strategyLab || null,
    decisionModel: context.decisionModel || null,
    window: context.window || null,
    quarter: context.quarter || null
  };
  state.transactions = [...events.reverse(), ...(state.transactions || [])].slice(0, 60);
  return { state, events: events.reverse(), anchorChanged };
}

function summarizeSymbol(state) {
  const { observations, ...publicState } = state;
  if (publicState.quant) {
    const quant = publicState.quant;
    const strategy = quant.strategyLab || {};
    publicState.quant = {
      updatedAt: quant.updatedAt,
      sizing: quant.sizing,
      signals: quant.signals,
      analogModel: quant.analogModel ? {
        ready: quant.analogModel.ready,
        sample: quant.analogModel.sample,
        probabilityUp5Pct: quant.analogModel.probabilityUp5Pct,
        averageForward5Pct: quant.analogModel.averageForward5Pct
      } : null,
      candleStudy: quant.candleStudy,
      strategyLab: {
        ready: strategy.ready,
        testedCandidates: strategy.testedCandidates,
        testedFamilies: strategy.testedFamilies,
        passedFamilies: strategy.passedFamilies,
        selected: strategy.selected,
        leaderboard: Array.isArray(strategy.leaderboard) ? strategy.leaderboard.slice(0, 6) : []
      },
      decisionModel: quant.decisionModel ? {
        score: quant.decisionModel.score,
        confidencePct: quant.decisionModel.confidencePct,
        components: quant.decisionModel.components
      } : null,
      window: quant.window ? { rsi14: quant.window.rsi14 } : null
    };
  }
  const marketValue = round((state.lots || []).reduce((sum, lot) => sum + lot.quantity * Number(state.lastPrice || lot.price), 0));
  const invested = round((state.lots || []).reduce((sum, lot) => sum + lot.quantity * lot.price, 0));
  const openPnl = round(marketValue - invested);
  const untriggered = (state.levels || []).map((price, index) => ({ price, level: index + 1, triggered: Boolean(state.triggeredLevels?.[index]) })).filter((level) => !level.triggered);
  const sellTargets = (state.lots || []).map((lot) => lot.target).sort((a, b) => a - b);
  return { ...publicState, historySessions: Array.isArray(observations) ? observations.length : 0, marketValue, invested, openPnl, nextBuy: untriggered[0] || null, nextSell: sellTargets[0] || null };
}

module.exports = { CONFIG, buyLevels, mondayOpening, emptySymbolState, processSymbol, quantSizing, summarizeSymbol };
