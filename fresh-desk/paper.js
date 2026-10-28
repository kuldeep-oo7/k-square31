"use strict";
const crypto = require("node:crypto");
const { levels, clock } = require("./engine");
const { finite } = require("./analysis");
function openTrade(book, plan, { fill, quantity, now = Date.now() } = {}) {
  if (!plan?.id || plan.status !== "UNVALIDATED_RESEARCH" || !(now < clock(plan.validUntil)) || now < clock(plan.signalAt)) throw Error("PLAN_EXPIRED_OR_INVALID");
  if (plan.side === "SELL" && plan.canShort !== true) throw Error("SHORT_NOT_SUPPORTED_ON_THIS_INSTRUMENT");
  if (book.some((t) => t.planId === plan.id)) throw Error("PLAN_ALREADY_RECORDED");
  if (quantity < plan.minQuantity || plan.quantityStep && Math.abs(quantity / plan.quantityStep - Math.round(quantity / plan.quantityStep)) > 1e-6) throw Error("QUANTITY_OUTSIDE_INSTRUMENT_RULES");
  if (book.some((t) => t.instrumentId === plan.instrumentId && t.status === "OPEN")) throw Error("POSITION_ALREADY_OPEN_FOR_INSTRUMENT");
  const recalculated = levels({ ...plan, entry: fill, quantity });
  const trade = { ...plan, ...recalculated, id: crypto.randomUUID(), planId: plan.id, entryAt: new Date(now).toISOString(),
    status: "OPEN", entryBasis: "MANUALLY_RECORDED_PAPER_FILL", lastCheckedAt: null, exit: null };
  return [...book, trade];
}
function closeTrade(trade, { price, at, reason = "MANUAL", costs = null }) {
  if (trade.status !== "OPEN") throw Error("TRADE_ALREADY_CLOSED");
  if (!finite(price) || price <= 0 || !finite(clock(at)) || clock(at) < clock(trade.entryAt)
    || (costs !== null && (!finite(costs) || costs < 0))) throw Error("INVALID_EXIT");
  const sign = trade.side === "BUY" ? 1 : -1, gross = sign * (price - trade.entry) * trade.quantity;
  return { ...trade, status: "CLOSED", exit: { price, at, reason, costs, gross, net: costs === null ? null : gross - costs,
    grossPct: sign * (price / trade.entry - 1) * 100, basis: reason === "MANUAL" ? "MANUALLY_RECORDED_PAPER_FILL" : "OBSERVED_QUOTE_PAPER_EXIT" } };
}
function observe(book, quotes, now = Date.now()) {
  return book.map((t) => {
    if (t.status !== "OPEN") return t;
    const q = quotes[t.instrumentId], at = clock(q?.at);
    if (!q || q.instrumentId !== t.instrumentId || !finite(at) || at < clock(t.entryAt) || at <= (clock(t.lastCheckedAt) || 0)
      || now - at > 120000 || at > now + 30000 || ![q.bid, q.ask].every((v) => finite(v) && v > 0) || q.ask < q.bid) return t.exitBy && now >= clock(t.exitBy) ? { ...t, reviewRequired: "EXPIRY_EXIT_DATA_REQUIRED" } : t;
    const s = t.side === "BUY" ? 1 : -1, available = s > 0 ? q.bid : q.ask;
    if (s * (available - t.stop) <= 0) return closeTrade(t, { price: available, at: q.at, reason: "OBSERVED_STOP" });
    if (s * (available - t.target) >= 0) return closeTrade(t, { price: t.target, at: q.at, reason: "OBSERVED_TARGET" });
    if (t.exitBy && at >= clock(t.exitBy)) return closeTrade(t, { price: available, at: q.at, reason: "OBSERVED_EXPIRY_EXIT" });
    return { ...t, lastCheckedAt: q.at, lastPrice: available };
  });
}
function summary(book) {
  const closed = book.filter((t) => t.status === "CLOSED"), groups = {};
  for (const t of closed) {
    // Never add rupees, dollars and crypto units into a misleading common total.
    const key = t.currency, g = groups[key] ||= { closed: 0, gross: 0, net: 0, unknownCosts: 0 };
    g.closed++; g.gross += t.exit.gross; if (t.exit.net === null) g.unknownCosts++; else g.net += t.exit.net;
  }
  return { open: book.filter((t) => t.status === "OPEN").length, closed: closed.length, byCurrency: groups,
    verdict: "PAPER_OBSERVATIONS_NOT_VALIDATION" };
}
module.exports = { openTrade, closeTrade, observe, summary };
