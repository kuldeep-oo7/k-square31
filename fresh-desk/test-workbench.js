"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { analyse, levels, RULES } = require("./engine");
const { candleFacts, aggregate, tickRound } = require("./analysis");
const { fixture, cases, demoNow } = require("./demo");
const { openTrade, closeTrade, observe, summary } = require("./paper");
const { replayTrade } = require("./replay");
const { collect, candles } = require("./feed");
const { collectCrypto } = require("./crypto-feed");
const { buildSnapshot } = require("./runtime");
const { render } = require("./view");
let count = 0;
function check(name, fn) { try { fn(); count++; } catch (e) { e.message = name + ": " + e.message; throw e; } }
const evaluate = (input, now = demoNow) => analyse(input, { now, tradingSession: true });
const change = (fn, sign = 1) => { const f = fixture(sign > 0 ? "DEMO-UP" : "DEMO-DOWN", sign); fn(f); return evaluate(f); };
for (const input of cases()) check(input.symbol, () => {
  const r = evaluate(input), p = r.plans[0], family = input.symbol.replace(/^DEMO-/, "").replace(/-(UP|DOWN)$/, "").replace(/-/g, "_");
  assert.equal(p.family, family); assert.equal(p.side, input.symbol.endsWith("UP") ? "BUY" : "SELL");
  assert.equal(r.assessments.length, 8); assert.deepEqual(r.evaluatedSides, ["BUY", "SELL"]);
  assert.equal(p.status, "UNVALIDATED_RESEARCH"); assert.ok(p.rewardRisk >= RULES.minimumRewardRisk);
  assert.ok(Math.abs(p.goalTarget - p.entry) / p.entry >= 0.03 - 1e-9); assert.notEqual(p.target, p.goalTarget);
});
check("mirrored setup prices and risk are symmetric", () => { for (const family of RULES.families) {
  const a = evaluate(fixture("LONG", 1, family)).plans[0], b = evaluate(fixture("SHORT", -1, family)).plans[0];
  assert.ok(Math.abs(a.entry + b.entry - 200) < 1e-7); assert.ok(Math.abs(a.stop + b.stop - 200) < 1e-7); assert.ok(Math.abs(a.target + b.target - 200) < 1e-7);
} });
check("legacy mood cannot veto buys", () => assert.equal(change((f) => { f.marketRegime = "BEAR_HOSTILE"; f.action = "SELL"; }).plans[0].side, "BUY"));
check("unfinished candle cannot change a completed signal", () => {
  const a = fixture(), b = structuredClone(a); b.bars.push({ ...b.bars.at(-1), at: new Date(demoNow - 20000).toISOString(), open: 500, high: 900, low: 400, close: 800, volume: 1e8 }); assert.deepEqual(evaluate(a), evaluate(b));
});
check("invalid OHLC, null candles and mixed contracts fail closed", () => {
  for (const edit of [(f) => f.bars[2].high = 90, (f) => f.bars[2] = null, (f) => f.bars[2].expiry = "2026-12-29"]) assert.equal(change(edit).reason, "INVALID_CANDLE");
});
check("gaps, duplicate candles and missing session anchor are rejected", () => {
  for (const edit of [(f) => f.bars.splice(3, 1), (f) => f.bars.push(f.bars[3]), (f) => f.bars.shift()]) assert.equal(change(edit).reason, "MISSING_OR_DUPLICATE_CANDLES");
});
check("future bars and stale signals are rejected", () => {
  assert.equal(change((f) => f.bars.push({ ...f.bars.at(-1), at: new Date(demoNow - 20000 + 300000).toISOString() })).reason, "FUTURE_CANDLE");
  assert.equal(evaluate(fixture(), demoNow + 300000).reason, "SIGNAL_STALE");
});
for (const sign of [1, -1]) {
  check("fresh post-signal quote, side " + sign, () => {
    for (const edit of [(f) => f.quote.at = new Date(demoNow - 30000).toISOString(), (f) => f.quote.at = new Date(demoNow + 60000).toISOString(), (f) => f.quote.expiry = "2026-12-29"]) assert.equal(change(edit, sign).reason, "FRESH_POST_SIGNAL_QUOTE_REQUIRED");
  });
  check("ban, spread, gap and risk gates, side " + sign, () => {
    assert.equal(change((f) => f.eligibility = null, sign).reason, "BAN_STATUS_UNVERIFIED");
    assert.equal(change((f) => f.eligibility.state = "BANNED", sign).reason, "NSE_BAN_NEW_ENTRY");
    assert.equal(change((f) => f.quote.ask += 1, sign).reason, "SPREAD_TOO_WIDE");
    assert.equal(change((f) => { f.quote.bid += sign; f.quote.ask += sign; }, sign).plans.length, 0);
    assert.equal(change((f) => f.bars.at(-1).volume = 100, sign).plans.some((p) => p.family === "STRUCTURE_BREAKOUT"), false);
  });
}
check("calendar and session closure do not invent quotes", () => {
  assert.equal(analyse(fixture(), { now: demoNow }).reason, "CALENDAR_UNVERIFIED");
  assert.equal(evaluate(fixture(), Date.parse("2026-10-28T15:01:00+05:30")).reason, "OUTSIDE_ENTRY_SESSION");
  assert.equal(change((f) => f.tickSize = null).reason, "TICK_MISSING_OR_INVALID");
  assert.equal(change((f) => f.market = {}).reason, "CONTRACT_OR_SOURCE_UNVERIFIED");
});
function forex(sign = 1) {
  const f = fixture("EURUSD", sign); f.market = "FOREX"; f.instrumentId = "IMPORT|EURUSD"; f.source = "USER_FOREX_IMPORT"; f.currency = "USD"; f.expiry = null;
  f.sessionStart = f.bars[0].at; f.isOpen = true; f.tradeable = true; f.canShort = true; f.tickSize = 0.00001; f.volumeKind = "TICK_VOLUME";
  for (const b of f.bars) { b.expiry = null; for (const key of ["open", "high", "low", "close"]) b[key] /= 100; }
  f.quote.expiry = null; f.quote.bid /= 100; f.quote.ask /= 100; return f;
}
check("forex fractional ticks and tick-volume provenance", () => { const r = evaluate(forex()); assert.equal(r.plans[0].side, "BUY"); assert.equal(r.plans[0].tickSize, 0.00001); assert.equal(r.evidence.volumeKind, "TICK_VOLUME"); });
check("crypto spot does not manufacture a naked-short ticket", () => { const f = forex(-1); f.market = "CRYPTO_SPOT"; f.canShort = false; const r = evaluate(f); assert.equal(r.plans.length, 0); assert.ok(r.assessments.some((a) => a.rejection === "SHORT_NOT_SUPPORTED_OR_UNVERIFIED")); });
check("unknown volume cannot confirm a breakout", () => { const f = forex(); f.volumeKind = "UNKNOWN"; assert.equal(evaluate(f).plans.some((p) => p.family === "STRUCTURE_BREAKOUT"), false); });
check("completed higher-timeframe aggregation discards partial group", () => { const b = fixture().bars; assert.equal(aggregate(b.slice(0, 32), 3).length, 10); assert.equal(aggregate(b.slice(0, 30), 3).at(-1).close, b[29].close); });
check("candles describe observed geometry, not a probability", () => {
  const c = candleFacts({ open: 100, close: 100.1, high: 100.15, low: 99.5 }); assert.ok(c.names.includes("LOWER_WICK_REJECTION")); assert.equal(c.probability, undefined);
});
check("target rounding, invalid risk and consumed structural reward", () => {
  assert.equal(levels({ side: "BUY", entry: 1000, stop: 990, tickSize: 0.05 }).goalTarget, 1030);
  assert.equal(levels({ side: "SELL", entry: 1000, stop: 1010, tickSize: 0.05 }).goalTarget, 970);
  assert.throws(() => levels({ side: "BUY", entry: 100, stop: 99, target: 100.5, tickSize: 0.01 }), /INSUFFICIENT_ROOM/);
  assert.throws(() => levels({ side: "BUY", entry: 100, stop: 101, tickSize: 0.01 }));
  assert.equal(tickRound(1.000021, 0.00001, true), 1.00003);
});
const plan = evaluate(fixture()).plans[0];
check("paper entry freezes levels; duplicate and stale entries rejected", () => {
  const book = openTrade([], plan, { fill: plan.entry, quantity: 20, now: demoNow }); assert.equal(book[0].stop, plan.stop); assert.equal(book[0].target, plan.target);
  assert.throws(() => openTrade(book, plan, { fill: plan.entry, quantity: 20, now: demoNow }), /ALREADY_RECORDED/);
  assert.throws(() => openTrade([], plan, { fill: plan.entry, quantity: 20, now: demoNow + 300000 }), /EXPIRED/);
  assert.throws(() => openTrade([], plan, { fill: plan.entry, quantity: 1, now: demoNow }), /QUANTITY/);
});
check("same-day target uses post-entry quote; earlier extremes cannot close", () => {
  const book = openTrade([], plan, { fill: plan.entry, quantity: 20, now: demoNow }), t = book[0], q = { instrumentId: t.instrumentId, at: new Date(demoNow - 1000).toISOString(), bid: plan.target + 1, ask: plan.target + 1.05, high: 10000 };
  assert.equal(observe(book, { [t.instrumentId]: q }, demoNow)[0].status, "OPEN");
  q.at = new Date(demoNow + 1000).toISOString(); const result = observe(book, { [t.instrumentId]: q }, demoNow + 1000)[0]; assert.equal(result.status, "CLOSED"); assert.equal(result.exit.reason, "OBSERVED_TARGET"); assert.equal(result.exit.price, plan.target); assert.equal(result.exit.net, null);
});
check("short monitoring uses the ask, stop gaps use observed worse price", () => {
  const short = evaluate(fixture("SHORT", -1)).plans[0], book = openTrade([], short, { fill: short.entry, quantity: 20, now: demoNow }), t = book[0];
  const q = { instrumentId: t.instrumentId, at: new Date(demoNow + 1000).toISOString(), bid: short.stop + 1, ask: short.stop + 1.05 };
  const exit = observe(book, { [t.instrumentId]: q }, demoNow + 1000)[0].exit; assert.equal(exit.price, q.ask); assert.ok(exit.gross < 0);
});
check("manual costs stay distinct, currencies are never mixed", () => {
  const a = openTrade([], plan, { fill: plan.entry, quantity: 20, now: demoNow })[0], b = closeTrade(a, { price: plan.target, at: new Date(demoNow).toISOString(), costs: 2 });
  assert.ok(Math.abs(b.exit.net - (b.exit.gross - 2)) < 1e-9); const stats = summary([b, { ...b, currency: "USD" }]); assert.equal(Object.keys(stats.byCurrency).length, 2);
  assert.throws(() => closeTrade(b, { price: 1, at: new Date(demoNow).toISOString() }), /ALREADY_CLOSED/);
});
check("expiry with missing price is visibly unresolved", () => { const t = openTrade([], plan, { fill: plan.entry, quantity: 20, now: demoNow })[0]; assert.equal(observe([t], {}, Date.parse(t.exitBy) + 1000)[0].reviewRequired, "EXPIRY_EXIT_DATA_REQUIRED"); });
check("OHLC replay exits immediately and resolves ambiguous bars conservatively", () => {
  const p = { side: "BUY", entry: 100, stop: 98, target: 104 }, b = { at: new Date(demoNow).toISOString(), open: 100, high: 105, low: 99, close: 104 };
  assert.equal(replayTrade(p, [b], { entryAt: b.at }).reason, "TARGET");
  assert.equal(replayTrade(p, [{ ...b, low: 97 }], { entryAt: b.at }).reason, "AMBIGUOUS_STOP_FIRST");
  assert.equal(replayTrade(p, [{ ...b, open: 96, low: 95 }], { entryAt: b.at }).price, 96);
  assert.equal(replayTrade(p, [], { entryAt: b.at }).status, "CENSORED");
});
check("HTML source and symbols cannot inject script", () => {
  const html = render({ demo: false, builtAt: new Date(demoNow).toISOString(), state: "WAIT", errors: ["<script>bad</script>"], results: [{ symbol: "<img onerror=x>", plans: [], assessments: [] }] });
  assert.ok(!html.includes("<img onerror=x>")); assert.ok(html.includes("&lt;script&gt;bad&lt;/script&gt;"));
});
check("new engine imports no legacy strategy or rating", () => { const src = fs.readFileSync(path.join(__dirname, "strategy-engine.js"), "utf8"); assert.ok(!/\.\.\/api|market-direction|gm-technical|kronos|neural|rating/.test(src)); });
(async () => {
  const closed = await collect(null, { now: Date.parse("2026-10-28T22:00:00+05:30"), masterFeed: async () => { throw Error("must not fetch after session"); } }); assert.equal(closed.state, "MARKET_CLOSED"); count++;
  const cutoff = await collect(null, { now: Date.parse("2026-10-28T15:10:00+05:30") }); assert.equal(cutoff.state, "ENTRY_WINDOW_CLOSED"); count++;
  const monitoring = await require("./position-quotes").positionQuotes([{ instrumentId: "NSE|TEST", market: "NSE_FUTURES", symbol: "TEST", expiry: "2026-11-23", status: "OPEN" }], { now: Date.parse("2026-10-28T15:10:00+05:30"), nseQuotes: async () => ({ ok: true, quotes: { "TEST|2026-11-23": { bid: 100, ask: 100.05, exchangeFeedTime: "28-Oct-2026 15:10:00" } } }) }); assert.equal(monitoring.quotes["NSE|TEST"].bid, 100); count++;
  const denied = await candles({ contract: { token: "dummy" }, symbol: "TEST", expiry: "2026-11-23", session: "2026-10-28", now: demoNow, credentials: {}, fetchImpl: async () => { const e = Error(); e.cause = { code: "EACCES" }; throw e; } }); assert.equal(denied.reason, "NETWORK_ACCESS_DENIED"); count++;
  const expired = await candles({ contract: { token: "dummy" }, symbol: "TEST", expiry: "2026-11-23", session: "2026-10-28", now: demoNow, credentials: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, errorCode: "AG8001" }) }) }); assert.equal(expired.reason, "ANGEL_SESSION_EXPIRED"); count++;
  const master = { fetchedAt: new Date(demoNow).toISOString(), futures: { "DEMO-UP|2026-11-23": { token: "dummy", exchange: "NFO", tickSize: 0.05 } } };
  const collected = await collect(["DEMO-UP"], { now: demoNow, clockNow: () => demoNow, loadMaster: () => master, readFile: () => ({ tradeDate: "2026-10-28", symbols: [], source: "SYNTHETIC" }), credentials: {}, candleFeed: async () => ({ ok: true, bars: fixture().bars }), quoteFeed: async () => ({ quotes: { "DEMO-UP|2026-11-23": { ...fixture().quote, exchangeFeedTime: "28-Oct-2026 12:00:10" } } }) }); assert.equal(evaluate(collected.inputs[0]).plans[0].side, "BUY"); count++;
  let attempts = 0, paused = 0;
  const retried = await collect(["DEMO-UP"], { now: demoNow, clockNow: () => demoNow, loadMaster: () => master, readFile: () => ({ tradeDate: "2026-10-28", symbols: [], source: "SYNTHETIC" }), credentials: {}, pauseMs: 0, pause: async () => paused++, ensureSession: async () => { throw Error("burst should not need login"); }, candleFeed: async () => ++attempts === 1 ? { ok: false, reason: "ANGEL_SESSION_EXPIRED" } : { ok: true, bars: fixture().bars }, quoteFeed: async () => ({ quotes: {} }) }); assert.equal(attempts, 2); assert.equal(paused, 1); assert.equal(retried.coverage.available, 1); count++;
  const partialMaster = { ...master, futures: { ...master.futures, "SECOND|2026-11-23": { token: "second", exchange: "NFO", tickSize: 0.05 } } };
  let calls = 0;
  const partial = await collect(null, { now: demoNow, clockNow: () => demoNow, loadMaster: () => partialMaster, readFile: () => ({ tradeDate: "2026-10-28", symbols: [], source: "SYNTHETIC" }), credentials: {}, candleFeed: async () => ++calls === 1 ? { ok: true, bars: fixture().bars } : { ok: false, reason: "NETWORK_ACCESS_DENIED" }, quoteFeed: async () => ({ quotes: {} }) }); assert.equal(partial.state, "PARTIAL_SCAN"); assert.equal(partial.coverage.requested, 2); count++;
  const stale = await collect(null, { now: demoNow, loadMaster: () => null, masterFeed: async () => ({ ...master, fetchedAt: "2026-10-27T23:00:00+05:30" }) }); assert.equal(stale.state, "DATA_UNAVAILABLE"); count++;
  const missingBan = await collect(null, { now: demoNow, loadMaster: () => master, readFile: () => null, banFeed: async () => null }); assert.deepEqual(missingBan.errors, ["BAN_STATUS_UNVERIFIED"]); count++;
  const crypto = await collectCrypto(["BTCUSDT"], { now: demoNow, fetchImpl: async () => { const e = Error(); e.cause = { code: "EACCES" }; throw e; } }); assert.equal(crypto.state, "DATA_UNAVAILABLE"); assert.match(crypto.errors[0], /NETWORK_ACCESS_DENIED/); count++;
  const slow = await collectCrypto(["BTCUSDT"], { now: demoNow, fetchImpl: async (url) => ({ ok: true, json: async () => url.includes("exchangeInfo") ? { symbols: [{ symbol: "BTCUSDT", status: "TRADING", quoteAsset: "USDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }] }] } : url.includes("klines") ? [] : url.includes("bookTicker") ? { bidPrice: "100", askPrice: "101" } : { serverTime: demoNow - 300000 } }) }); assert.match(slow.errors[0], /QUOTE_TIME_UNVERIFIED/); count++;
  assert.equal(buildSnapshot({ inputs: cases(), tradingSession: true, state: "SYNTHETIC" }, { demo: true, now: demoNow }).results.length, 8); count++;
  assert.throws(() => buildSnapshot({ inputs: [{ bars: null }] }), /INVALID_CANDLE/); count++;
  console.log(`Fresh workbench: ${count} synthetic checks passed across strategies, market capabilities, causality, paper records, transport and conservative replay.`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
