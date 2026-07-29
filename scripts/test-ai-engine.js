const assert = require("node:assert/strict");
const { buyLevels, mondayOpening, emptySymbolState, processSymbol, quantSizing } = require("../api/_lib/ai-engine");

const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);
function result(days, price, state = "REGULAR") {
  return {
    meta: { regularMarketPrice: price, marketState: state },
    timestamp: days.map((day) => ts(day.time)),
    indicators: { quote: [{
      open: days.map((day) => day.open), high: days.map((day) => day.high),
      low: days.map((day) => day.low), close: days.map((day) => day.close),
      volume: days.map(() => 100000)
    }] }
  };
}

const friday = { time: "2026-07-17T10:00:00Z", open: 498, high: 504, low: 496, close: 500 };
const monday = { time: "2026-07-20T10:00:00Z", open: 497, high: 500, low: 469, close: 472 };
const tuesday = { time: "2026-07-21T10:00:00Z", open: 474, high: 500, low: 473, close: 493 };

assert.deepEqual(buyLevels(500), [490, 480.2, 470.6, 461.18, 451.96]);
assert.deepEqual(mondayOpening(result([friday], 500, "CLOSED")), { weekKey: "2026-07-13", barDate: "2026-07-17", price: 498 });
assert.deepEqual(mondayOpening(result([friday, monday], 472)), { weekKey: "2026-07-20", barDate: "2026-07-20", price: 497 });
assert.equal(quantSizing({ signals: { riskBudgetMultiplier: .5, riskState: "high", evidenceScore: -2 }, analogModel: { ready: true, probabilityUp5Pct: 40 } }).multiplier, .25);

const first = processSymbol(emptySymbolState("TEST"), result([friday, monday], 472), new Date("2026-07-20T10:01:00Z").getTime());
assert.equal(first.state.lots.length, 2, "Monday cumulative fall should fill every crossed 2% level");
assert.deepEqual(first.state.triggeredLevels, [true, true, false, false, false]);
assert.equal(first.events.filter((event) => event.action === "sell").length, 0, "same-candle exits must be forbidden");
assert.ok(first.state.lots.every((lot) => lot.quantity === Math.floor(40000 / lot.price)));

const repeated = processSymbol(first.state, result([friday, monday], 472), new Date("2026-07-20T10:05:00Z").getTime());
assert.equal(repeated.events.length, 0, "the runner must be idempotent within the same session");

const second = processSymbol(repeated.state, result([friday, monday, tuesday], 493), new Date("2026-07-21T10:01:00Z").getTime());
assert.equal(second.state.lots.length, 0, "Tuesday high should exit both older lots at their 2% targets");
assert.equal(second.events.filter((event) => event.action === "sell").length, 2);
assert.ok(second.state.realizedPnl > 0);
assert.ok(second.state.cash > 200000, "realized paper profit should return to the stock cash ledger");
assert.equal(second.state.observations.length, 3, "daily observations should deduplicate by market session");

const longHistory = Array.from({ length: 1400 }, (_, index) => ({
  time: new Date(Date.UTC(2021, 0, 1 + index)).toISOString(),
  open: 100 + index, high: 102 + index, low: 98 + index, close: 101 + index
}));
const historyRun = processSymbol(emptySymbolState("HISTORY"), result(longHistory, 1500, "CLOSED"), new Date("2026-07-21T10:01:00Z").getTime());
assert.equal(historyRun.state.observations.length, 1300, "history should retain the latest five years / 1,300 sessions");

const capped = emptySymbolState("CAPTEST");
capped.anchor = { weekKey: "2026-07-13", barDate: "2026-07-17", price: 500 };
capped.levels = buyLevels(500);
capped.cash = 100000;
capped.lots = [{ id: "old-lot", symbol: "CAPTEST", price: 500, quantity: 380, amount: 190000, target: 510, boughtSession: "2026-07-16", anchorWeek: "2026-07-10", level: 1 }];
const cappedRun = processSymbol(capped, result([friday, { ...monday, low: 420 }], 472), new Date("2026-07-20T10:01:00Z").getTime());
const deployed = cappedRun.state.lots.reduce((sum, lot) => sum + Number(lot.amount), 0);
assert.ok(deployed <= 200000, `deployed capital must stay at or below ₹2 lakh, received ${deployed}`);
assert.equal(cappedRun.events.filter((event) => event.action === "buy").length, 1, "remaining cap, not paper profits, limits new buys");

console.log("AI engine tests passed");
