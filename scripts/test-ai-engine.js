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
const weightedSize = quantSizing({
  signals: { riskBudgetMultiplier: 1, riskState: "normal", evidenceScore: 0 },
  decisionModel: { score: -45 },
  strategyLab: { ready: true, selected: { passed: true, currentSignal: -1, family: "Test bearish family" } },
  candleStudy: { directionScore: -0.5, pattern: "bearish test" }
});
assert.ok(weightedSize.multiplier < .5, "adverse weighted, strategy and candle evidence must reduce AI size");
assert.ok(weightedSize.reasons.some((reason) => reason.includes("weighted evidence")));

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

// The desk carries nothing over the weekend: a leg still open on Friday is
// booked at that close, win or lose, and no new rung is opened that session.
const fridayBar = { time: "2026-07-24T10:00:00Z", open: 490, high: 492, low: 470, close: 480 };
const openWeek = emptySymbolState("BOOKOUT");
openWeek.anchor = { weekKey: "2026-07-20", barDate: "2026-07-20", price: 497 };
openWeek.levels = buyLevels(497);
openWeek.triggeredLevels = [true, false, false, false, false];
openWeek.cash = 160000;
openWeek.lots = [{ id: "week-lot", symbol: "BOOKOUT", price: 487.06, quantity: 82, amount: 39938.92, target: 496.8, boughtSession: "2026-07-21", anchorWeek: "2026-07-20", level: 1 }];
const booked = processSymbol(openWeek, result([friday, monday, tuesday, fridayBar], 480), new Date("2026-07-24T10:01:00Z").getTime());
assert.equal(booked.state.lots.length, 0, "Friday must close every open leg");
const bookEvent = booked.events.find((event) => event.action === "sell");
assert.match(bookEvent.reason, /Friday book-out/);
assert.equal(bookEvent.price, 480, "the leg is booked at the Friday close");
assert.ok(booked.state.realizedPnl < 0, "a losing week is booked, never carried");
assert.equal(booked.events.filter((event) => event.action === "buy").length, 0, "Friday's dip through a rung must not open a leg that closes the same session");

// A leg belonging to an earlier week is booked at the last close of its own
// week, which also covers a Friday holiday discovered only on Monday.
const stale = emptySymbolState("CARRY");
stale.anchor = { weekKey: "2026-07-13", barDate: "2026-07-17", price: 498 };
stale.levels = buyLevels(498);
stale.cash = 160000;
stale.lots = [{ id: "old-lot", symbol: "CARRY", price: 500, quantity: 80, amount: 40000, target: 510, boughtSession: "2026-07-16", anchorWeek: "2026-07-13", level: 1 }];
const rolled = processSymbol(stale, result([friday, monday], 472), new Date("2026-07-20T10:01:00Z").getTime());
assert.equal(rolled.state.lots.filter((lot) => lot.anchorWeek === "2026-07-13").length, 0, "last week's leg cannot survive into the new week");
const carryEvent = rolled.events.find((event) => /Weekly book-out/.test(event.reason || ""));
assert.equal(carryEvent.price, 500, "booked at the last close of its own week");
assert.equal(carryEvent.session, "2026-07-17");

// Within a week the ₹2 lakh cap still binds.
const capped = emptySymbolState("CAPTEST");
capped.anchor = { weekKey: "2026-07-20", barDate: "2026-07-20", price: 497 };
capped.levels = buyLevels(497);
capped.triggeredLevels = [true, false, false, false, false];
capped.cash = 100000;
capped.lots = [{ id: "big-lot", symbol: "CAPTEST", price: 487.06, quantity: 390, amount: 190000, target: 600, boughtSession: "2026-07-20", anchorWeek: "2026-07-20", level: 1 }];
const cappedRun = processSymbol(capped, result([friday, monday, { ...tuesday, low: 420 }], 493), new Date("2026-07-21T10:01:00Z").getTime());
const deployed = cappedRun.state.lots.reduce((sum, lot) => sum + Number(lot.amount), 0);
assert.ok(deployed <= 200000, `deployed capital must stay at or below ₹2 lakh, received ${deployed}`);
assert.equal(cappedRun.events.filter((event) => event.action === "buy").length, 1, "remaining cap, not paper profits, limits new buys");
assert.ok(cappedRun.state.lots.every((lot) => Number(lot.amount) >= 5000), "leftover capacity must not open a ticket too small to cover its round trip");

console.log("AI engine tests passed");
