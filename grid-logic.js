(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.K2_GRID = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createGrid() {
  const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  function levels(anchor, stepPct = 2, slots = 5) {
    const base = Number(anchor);
    const step = 1 - Number(stepPct) / 100;
    if (!(base > 0) || !(step > 0 && step < 1)) return [];
    return Array.from({ length: slots }, (_, index) => round(base * (step ** (index + 1))));
  }

  function exitLevels(anchor, stepPct = 2, slots = 5, position = "long") {
    const base = Number(anchor);
    const direction = position === "short" ? -1 : 1;
    const step = 1 + direction * Number(stepPct) / 100;
    if (!(base > 0) || !(step > 0)) return [];
    return Array.from({ length: slots }, (_, index) => round(base * (step ** (index + 1))));
  }

  function weeklySignal(anchor, current, stepPct = 2) {
    const price = Number(current);
    const buyLevels = levels(anchor, stepPct, 5);
    if (!(price > 0) || !buyLevels.length) return { action: "loading", buyLevels, sellAt: null, reachedBuyLevel: 0 };
    const reachedBuyLevel = buyLevels.reduce((deepest, level, index) => price <= level ? index + 1 : deepest, 0);
    const sellAt = round(Number(anchor) * (1 + Number(stepPct) / 100));
    const action = price >= sellAt ? "sell" : reachedBuyLevel ? "buy" : "wait";
    return { action, buyLevels, sellAt, reachedBuyLevel, weeklyMovePct: (price / Number(anchor) - 1) * 100 };
  }

  function futureSignal(current, weeklyBuy, weeklySell) {
    const price = Number(current);
    const buyLine = Number(weeklyBuy);
    const sellLine = Number(weeklySell);
    if (!(price > 0) || !(buyLine > 0) || !(sellLine > 0)) return { action: "loading", buyAt: null, sellAt: null };
    const action = price <= buyLine ? "buy" : price >= sellLine ? "sell" : "wait";
    return { action, buyAt: round(buyLine), sellAt: round(sellLine) };
  }

  function lotExit(lots, current, stepPct = 2, position = "long") {
    const price = Number(current);
    const direction = position === "short" ? -1 : 1;
    const eligible = (Array.isArray(lots) ? lots : []).filter((lot) => {
      const target = Number(lot.price) * (1 + direction * Number(stepPct) / 100);
      return direction > 0 ? price >= target : price <= target;
    });
    return {
      eligible,
      quantity: eligible.reduce((sum, lot) => sum + Number(lot.quantity || 0), 0),
      nextTarget: (Array.isArray(lots) ? lots : []).reduce((target, lot) => {
        const value = round(Number(lot.price) * (1 + direction * Number(stepPct) / 100));
        if (!Number.isFinite(value)) return target;
        return target === null || (direction > 0 ? value < target : value > target) ? value : target;
      }, null)
    };
  }

  function bracketSignal(current, entryPrice, targetPrice, stopLossPrice) {
    const price = Number(current);
    const entry = Number(entryPrice);
    const target = Number(targetPrice);
    const stop = Number(stopLossPrice);
    if (!(price > 0) || !(entry > 0) || !(target > 0) || !(stop > 0)) {
      return { status: "pending", label: "Awaiting Trigger" };
    }
    if (price >= target) return { status: "target_hit", label: "Target Reached (Take Profit)" };
    if (price <= stop) return { status: "stopped_out", label: "Invalidated (Stop Loss Hit)" };
    if (price <= entry * 1.005 && price >= stop) return { status: "in_zone", label: "Buy / Entry Zone" };
    return { status: "active", label: "Trade Active" };
  }

  return { bracketSignal, exitLevels, futureSignal, levels, lotExit, weeklySignal };
});

