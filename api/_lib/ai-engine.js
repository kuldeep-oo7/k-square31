const crypto = require("node:crypto");
const { resultBars } = require("./market-feed");

const DAY = 86_400_000;
const CONFIG = Object.freeze({
  budgetPerStock: 200_000,
  slots: 5,
  slotBudget: 40_000,
  buyStepPct: 3,
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

function completedFriday(result, nowMs = Date.now()) {
  const bars = resultBars(result);
  if (!bars.length) throw new Error("No usable daily bars");
  const now = indiaParts(nowMs);
  const today = `${now.year}-${now.month}-${now.day}`;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const beforeFridayClose = weekday === 5 && (Number(now.hour) < 16 || result.meta?.marketState === "REGULAR");
  let daysBack = (weekday - 5 + 7) % 7;
  if (beforeFridayClose) daysBack = 7;
  const weekKey = dateMinus(today, daysBack);
  const eligible = bars.filter((bar) => localDate(bar.timestamp * 1000) <= weekKey);
  const bar = eligible.at(-1);
  if (!bar) throw new Error("Friday reference is unavailable");
  return { weekKey, barDate: localDate(bar.timestamp * 1000), price: round(bar.close) };
}

function buyLevels(anchorPrice) {
  return Array.from({ length: CONFIG.slots }, (_, index) => round(anchorPrice * (0.97 ** (index + 1))));
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

function processSymbol(previous, result, nowMs = Date.now()) {
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
  const reference = completedFriday(result, nowMs);
  const anchorChanged = state.anchor?.weekKey !== reference.weekKey;
  const events = [];

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

  const anchorSession = sessionDate === reference.barDate;
  if (!anchorSession) {
    state.levels.forEach((levelPrice, index) => {
      if (state.triggeredLevels[index] || bar.low > levelPrice) return;
      const deployed = (state.lots || []).reduce((sum, lot) => sum + Number(lot.amount || lot.quantity * lot.price), 0);
      const remainingCapacity = Math.max(0, CONFIG.budgetPerStock - deployed);
      const available = Math.min(CONFIG.slotBudget, Number(state.cash), remainingCapacity);
      const quantity = Math.floor(available / levelPrice);
      if (quantity < 1) return;
      const amount = round(quantity * levelPrice);
      const id = transactionId(state.symbol, reference.weekKey, `B${index + 1}`);
      state.cash = round(Number(state.cash) - amount);
      state.triggeredLevels[index] = true;
      const lot = {
        id, symbol: state.symbol, price: levelPrice, quantity, amount,
        target: round(levelPrice * 1.02), boughtSession: sessionDate,
        anchorWeek: reference.weekKey, level: index + 1, time: nowMs
      };
      state.lots.push(lot);
      events.push({
        id, action: "buy", symbol: state.symbol, price: levelPrice, quantity,
        amount, pnl: 0, reason: `Friday close minus ${CONFIG.buyStepPct * (index + 1)}% compounded`,
        time: nowMs, session: sessionDate, anchorWeek: reference.weekKey, level: index + 1
      });
    });
  }

  const livePrice = Number(result.meta?.regularMarketPrice);
  state.lastPrice = round(Number.isFinite(livePrice) ? livePrice : bar.close);
  state.lastSession = sessionDate;
  state.updatedAt = new Date(nowMs).toISOString();
  state.transactions = [...events.reverse(), ...(state.transactions || [])].slice(0, 60);
  return { state, events: events.reverse(), anchorChanged };
}

function summarizeSymbol(state) {
  const { observations, ...publicState } = state;
  const marketValue = round((state.lots || []).reduce((sum, lot) => sum + lot.quantity * Number(state.lastPrice || lot.price), 0));
  const invested = round((state.lots || []).reduce((sum, lot) => sum + lot.quantity * lot.price, 0));
  const openPnl = round(marketValue - invested);
  const untriggered = (state.levels || []).map((price, index) => ({ price, level: index + 1, triggered: Boolean(state.triggeredLevels?.[index]) })).filter((level) => !level.triggered);
  const sellTargets = (state.lots || []).map((lot) => lot.target).sort((a, b) => a - b);
  return { ...publicState, historySessions: Array.isArray(observations) ? observations.length : 0, marketValue, invested, openPnl, nextBuy: untriggered[0] || null, nextSell: sellTargets[0] || null };
}

module.exports = { CONFIG, buyLevels, completedFriday, emptySymbolState, processSymbol, summarizeSymbol };
