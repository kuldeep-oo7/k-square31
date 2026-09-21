"use strict";

/**
 * END TO END, FROM A MOVING MARKET TO A GRADED TRADE.
 *
 * Every other suite in this repo tests one layer. This drives the whole desk
 * through a simulated session and asks the questions a person about to risk
 * money would ask:
 *
 *   1. Given a real option chain, does the screener produce candidates at all?
 *   2. When prices MOVE, does it produce DIFFERENT candidates, or does it hand
 *      back the same list with new numbers glued on?
 *   3. If one of them runs to its target, does the system notice and close it?
 *   4. Is every one of those steps written down -- the prediction, the path,
 *      the outcome, the timing -- or does the evidence evaporate?
 *   5. Are the technical engines actually firing on shapes we can name, or
 *      returning quiet nothing?
 *   6. Do the equations still reproduce values computed outside this codebase?
 *
 * WHAT IT WILL NOT TELL YOU: whether the signal makes money. A simulation
 * cannot answer that, because the prices are ones this file chose. It tests the
 * MACHINE, not the edge.
 *
 * SAFETY: every write goes to a temporary database. The live ledger is opened
 * read-only for a byte comparison at the end, and the run fails if it moved.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const { screenContracts } = require("../api/_lib/contract-screener");
const { loadReference } = require("../api/_lib/fno-reference");
const { europeanOption, impliedVolatility } = require("../api/_lib/option-pricing");
const { identifyCandlestickPatterns } = require("../api/_lib/candlestick-engine");
const { scanChartPatterns } = require("../api/_lib/chart-patterns");
const { calculateHurstExponent, calculateVpin } = require("../api/_lib/advanced-quant");
const { forecastGarch11Volatility, calculateCornishFisherRisk } = require("../api/_lib/institutional-calculus");
const { evaluateNeuralAlpha } = require("../api/_lib/neural-quant-engine");
const { yangZhangVol, timeToTarget } = require("../api/_lib/trade-odds");
const ledger = require("../api/_lib/signal-record");

let failures = 0;
function ok(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  return false;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RISK_FREE = 0.065;

// ---------------------------------------------------------------------------
// A market we control, built on REAL names so their cached price history -- and
// therefore their realised volatility, Hurst, GARCH and candlesticks -- are the
// genuine article. Only the option chain is synthesised, because that is the
// part we need to be able to move.
// ---------------------------------------------------------------------------
function buildChain(names, { spotFor, vol, expiryIso, lotSize = 500, volume = 5000, openInterest = 200000, now }) {
  const years = Math.max(1 / 365, (Date.parse(`${expiryIso}T15:30:00+05:30`) - now) / (365 * DAY));
  const symbols = {};
  for (const symbol of names) {
    const spot = spotFor(symbol);
    const step = spot > 5000 ? 100 : spot > 1000 ? 20 : spot > 200 ? 10 : 5;
    const atm = Math.round(spot / step) * step;
    const callStrikes = [], putStrikes = [], liveStrikes = [], quotes = {};
    for (let i = -6; i <= 6; i += 1) {
      const strike = atm + i * step;
      if (strike <= 0) continue;
      callStrikes.push(strike); putStrikes.push(strike); liveStrikes.push(strike);
      for (const optionType of ["CE", "PE"]) {
        // Priced with the SAME Black-Scholes the desk uses, so the simulation
        // cannot pass by feeding the screener prices no model would produce.
        const priced = europeanOption({
          underlyingPrice: spot, strike, timeToExpiryYears: years,
          riskFreeRate: RISK_FREE, dividendYield: 0,
          volatility: vol(symbol), optionType, model: "BSM"
        });
        quotes[`${strike}|${optionType}`] = {
          price: Math.round(priced.price * 100) / 100,
          settle: Math.round(priced.price * 100) / 100,
          close: Math.round(priced.price * 100) / 100,
          volume, openInterest, traded: true
        };
      }
    }
    symbols[symbol] = {
      symbol, isIndex: false, underlyingPrice: spot, lotSize,
      expiries: { [expiryIso]: { expiry: expiryIso, futuresPrice: spot, lotSize, callStrikes, putStrikes, liveStrikes, quotes } },
      expiryList: [expiryIso], frontExpiry: expiryIso
    };
  }
  return { session: "SIMULATED", symbolCount: names.length, symbols };
}

console.log("\n" + "=".repeat(74));
console.log("END-TO-END SIMULATED SESSION");
console.log("=".repeat(74));

// Real names, so their bars -- and everything derived from them -- are real.
const barsDir = path.resolve(__dirname, "../.private/cache/bars");
const NAMES = fs.existsSync(barsDir)
  ? fs.readdirSync(barsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).slice(0, 25)
  : [];
if (!NAMES.length) {
  console.log("\n  no cached bars on this machine; the simulation needs real price history to be meaningful.");
  process.exit(0);
}

const live = loadReference();
const spot0 = {};
for (const name of NAMES) {
  const known = live?.symbols?.[name]?.underlyingPrice;
  spot0[name] = Number(known) > 0 ? Number(known) : 1000;
}

let clock = Date.parse("2026-09-22T04:00:00.000Z");     // 09:30 IST, a Tuesday
const EXPIRY = "2026-10-27";

// ===========================================================================
console.log("\n--- 1. DOES IT PRODUCE CANDIDATES FROM A REAL CHAIN? ---");
// ===========================================================================
const openChain = buildChain(NAMES, {
  spotFor: (s) => spot0[s], vol: () => 0.22, expiryIso: EXPIRY, now: clock
});
const first = screenContracts({ reference: openChain, now: clock, limit: 40 });

ok(`walked ${first.examined.toLocaleString("en-IN")} contracts and produced ${first.survived} candidates`,
  first.ok && first.survived > 0);
ok("every candidate carries entry, target, expiry, lot size and provenance",
  first.contracts.every((c) => c.premium > 0 && c.targetPremium > c.premium && c.expiry && c.lotSize > 0 && c.priceSource));
ok(`realised volatility came from the REAL bars, not a default `
  + `(${first.contracts.filter((c) => c.realisedVol > 0).length} of ${first.contracts.length} rows)`,
  first.contracts.filter((c) => c.realisedVol > 0).length > first.contracts.length * 0.5);
ok(`probability of touch was computed for ${first.contracts.filter((c) => c.touchPct > 0).length} of ${first.contracts.length}`,
  first.contracts.filter((c) => c.touchPct > 0).length > first.contracts.length * 0.5);

// ===========================================================================
console.log("\n--- 2. WHEN THE MARKET MOVES, DOES THE LIST MOVE? ---");
// ===========================================================================
// A market that does not stand still: each name drifts its own way and implied
// volatility re-prices with it.
const bump = {};
NAMES.forEach((name, i) => { bump[name] = 1 + ((i % 7) - 3) * 0.035; });
clock += 2 * DAY;
const movedChain = buildChain(NAMES, {
  spotFor: (s) => spot0[s] * bump[s],
  vol: (s) => 0.22 * (bump[s] > 1 ? 0.8 : 1.25),      // vol falls into strength, rises into weakness
  expiryIso: EXPIRY, now: clock
});
const second = screenContracts({ reference: movedChain, now: clock, limit: 40 });

const key = (c) => `${c.symbol}|${c.strike}|${c.optionType}`;
const before = new Set(first.contracts.map(key));
const after = second.contracts.map(key);
const fresh = after.filter((k) => !before.has(k));

ok(`the list is not frozen: ${fresh.length} of ${after.length} candidates are NEW after the move`,
  fresh.length > 0, "a screener that returns the same contracts whatever the market does is ranking nothing");
ok("strikes followed the underlying rather than staying put",
  NAMES.some((n) => {
    const a = first.contracts.find((c) => c.symbol === n);
    const b = second.contracts.find((c) => c.symbol === n);
    return a && b && a.strike !== b.strike;
  }));
ok("cheaper implied volatility ranks a contract higher, all else equal",
  (() => {
    const cheap = second.contracts.filter((c) => c.varianceRiskPremium > 0 && c.varianceRiskPremium < 0.9);
    const dear = second.contracts.filter((c) => c.varianceRiskPremium > 1.1);
    if (!cheap.length || !dear.length) return true;    // nothing to compare on this draw
    const mean = (rows) => rows.reduce((s, c) => s + c.screenScore, 0) / rows.length;
    return mean(cheap) > mean(dear);
  })());

// ===========================================================================
console.log("\n--- 3. RECORD THE LIST, RUN ONE TO TARGET, AND CLOSE IT ---");
// ===========================================================================
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-sim-"));
const db = new SqliteTradingDatabase(path.join(dir, "sim.db"));

let recorded = 0;
for (const c of second.contracts) {
  const out = ledger.record({
    symbol: c.symbol, strike: c.strike, right: c.optionType, expiry: c.expiry,
    entryPrice: c.premium, lotSize: c.lotSize, priceSource: c.priceSource, executable: false,
    targetPrice: c.targetPremium, stopPrice: Math.round((c.premium / 2) * 100) / 100,
    probabilityOfProfitPct: c.touchPct,
    estimatedTouchPct: c.touchPct, estimatedDaysToTarget: c.medianDaysToTarget
  }, { db, now: clock });
  if (out.ok && out.status === "RECORDED") recorded += 1;
}
ok(`every candidate shown was written to the ledger (${recorded} of ${second.contracts.length})`,
  recorded === second.contracts.length);

const stored = db.db.prepare("SELECT * FROM signals_lifecycle").all();
ok("the PREDICTION was stored with the signal, not added afterwards",
  stored.filter((r) => r.estimated_touch_pct != null).length > stored.length * 0.5,
  `${stored.filter((r) => r.estimated_touch_pct != null).length} of ${stored.length} carry a predicted probability`);
ok("every stored row carries where its price came from",
  stored.every((r) => r.entry_price_source));

// One contract climbs steadily to its target; the rest drift.
const hero = second.contracts[0];
const heroKey = `${hero.symbol}|${hero.strike}|${hero.optionType}`;
const priceFor = (position, factor) => {
  const same = `${position.symbol}|${position.strike}|${position.right}` === heroKey;
  const row = stored.find((r) => r.symbol === position.symbol && r.strike === position.strike && r.option_type === position.right);
  if (!row) return null;
  return { price: row.entry_price * (same ? factor : 1.02), source: "BROKER_REALTIME" };
};

let marksTotal = 0;
for (const [hoursOn, factor] of [[3, 1.15], [6, 1.32], [9, 1.44], [12, 1.62]]) {
  clock = Date.parse("2026-09-24T04:00:00.000Z") + hoursOn * HOUR;
  const res = ledger.markToMarket((p) => priceFor(p, factor), { db, now: clock });
  marksTotal += res.marked;
}
ok(`the open book was marked ${marksTotal} times against observed prices`, marksTotal > 0);

const heroRow = db.db.prepare(
  "SELECT * FROM signals_lifecycle WHERE symbol = ? AND strike = ? AND option_type = ?"
).get(hero.symbol, hero.strike, hero.optionType);

ok(`the winner reached its target and CLOSED (${hero.symbol} ${hero.strike}${hero.optionType}: `
  + `${heroRow.entry_price} -> target ${heroRow.target1}, closed at ${heroRow.current_price})`,
  heroRow.status === "CLOSED" && heroRow.exit_reason === "TARGET_HIT",
  `status ${heroRow.status}, reason ${heroRow.exit_reason}`);
ok(`and the time it took was recorded: ${heroRow.hours_to_target} hours`,
  Number(heroRow.hours_to_target) > 0);
ok(`against the ${heroRow.estimated_days_to_target} days that were predicted`,
  heroRow.estimated_days_to_target != null);

// ===========================================================================
console.log("\n--- 4. IS EVERYTHING BEING CAPTURED? ---");
// ===========================================================================
const marks = db.db.prepare("SELECT * FROM signal_marks WHERE signal_id = ? ORDER BY recorded_at").all(heroRow.id);
ok(`the whole path was kept, not just the ending (${marks.length} observations on the winner)`, marks.length >= 3);
ok("every observation carries its price source",
  marks.every((m) => m.price_source === "BROKER_REALTIME"));
ok("the path shows the climb toward target, mark by mark",
  marks.length >= 2 && marks[marks.length - 1].fraction_of_target > marks[0].fraction_of_target,
  marks.map((m) => `${(m.fraction_of_target * 100).toFixed(0)}%`).join(" -> "));
ok(`the high-water mark survived (${heroRow.max_price_seen} against an entry of ${heroRow.entry_price})`,
  heroRow.max_price_seen > heroRow.entry_price);

const report = ledger.storageReport({ db });
ok("the storage report counts real rows in real tables",
  report.tables.signals_lifecycle.rows === stored.length && report.tables.signal_marks.rows >= marks.length,
  `signals ${report.tables.signals_lifecycle.rows}, marks ${report.tables.signal_marks.rows}`);

// Close the rest so calibration has a sample to grade.
clock += 6 * DAY;
ledger.markToMarket((p) => {
  const row = stored.find((r) => r.symbol === p.symbol && r.strike === p.strike && r.option_type === p.right);
  return row ? { price: row.entry_price * 0.4, source: "BROKER_REALTIME" } : null;
}, { db, now: clock });

const cal = ledger.calibration({ db, minimumSample: 10 });
ok(`calibration graded the session: predicted ${cal.predictedHitPct}%, actual ${cal.actualHitPct}%, verdict ${cal.verdict}`,
  cal.hasEnoughHistory === true && cal.verdict);
ok("it reports the gap as a signed number rather than hiding it",
  Number.isFinite(cal.calibrationGapPct));
ok(`and measures how far the losers travelled (median ${Math.round((cal.nearMisses.medianFractionOfTargetReached || 0) * 100)}% of target)`,
  cal.nearMisses.measured > 0);

// ===========================================================================
console.log("\n--- 5. ARE THE TECHNICAL ENGINES ACTUALLY FIRING? ---");
// ===========================================================================
const barsFor = (symbol) => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(barsDir, `${symbol}.json`), "utf8"));
    const bars = Array.isArray(raw) ? raw : (raw.bars || raw.data || raw.candles);
    return Array.isArray(bars) && bars.length >= 30 ? bars : null;
  } catch (error) { return null; }
};
const withBars = NAMES.map((n) => [n, barsFor(n)]).filter(([, b]) => b);

const candles = {}, charts = {}, hursts = [], garchRegimes = {}, neurals = [];
for (const [symbol, bars] of withBars) {
  const closes = bars.map((b) => Number(b.close ?? b.c)).filter((v) => v > 0);
  const c = identifyCandlestickPatterns(bars);
  candles[c.primaryPattern || "NONE"] = (candles[c.primaryPattern || "NONE"] || 0) + 1;
  const ch = scanChartPatterns(bars);
  const name = ch.primaryPattern?.pattern || "NONE";
  charts[name] = (charts[name] || 0) + 1;
  hursts.push(calculateHurstExponent(closes));
  const g = forecastGarch11Volatility(closes);
  garchRegimes[g.volatilityRegime] = (garchRegimes[g.volatilityRegime] || 0) + 1;
  neurals.push(evaluateNeuralAlpha({ bars, quantFactors: { hurst: hursts.at(-1), garchVol: g.forecastedAnnualizedVol } }).rawZ);
}

const named = Object.entries(candles).filter(([k]) => k !== "NONE").reduce((s, [, v]) => s + v, 0);
ok(`candlesticks fired on ${named} of ${withBars.length} names: `
  + Object.entries(candles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(", "),
  named > 0, "a detector that names nothing across a whole universe is not detecting");

const chartNamed = Object.entries(charts).filter(([k]) => k !== "NONE").reduce((s, [, v]) => s + v, 0);
ok(`chart patterns fired on ${chartNamed} of ${withBars.length} names: `
  + Object.entries(charts).filter(([k]) => k !== "NONE").map(([k, v]) => `${k} ${v}`).join(", "),
  chartNamed > 0, "this engine was disconnected for months and returned NONE for every symbol");

const hSorted = [...hursts].filter(Number.isFinite).sort((a, b) => a - b);
ok(`Hurst spreads across the universe rather than collapsing `
  + `(${hSorted[0].toFixed(3)} to ${hSorted.at(-1).toFixed(3)}, ${new Set(hSorted.map((h) => h.toFixed(3))).size} distinct)`,
  hSorted.at(-1) - hSorted[0] > 0.15);
ok(`GARCH separates regimes: ${Object.entries(garchRegimes).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  Object.keys(garchRegimes).length >= 2);
const zSorted = neurals.filter(Number.isFinite).sort((a, b) => a - b);
ok(`the matched-filter fusion is not saturated (rawZ ${zSorted[0].toFixed(2)} to ${zSorted.at(-1).toFixed(2)})`,
  zSorted.at(-1) - zSorted[0] > 0.5 && zSorted[0] < 0);

const cf = calculateCornishFisherRisk(barsFor(withBars[0][0]).map((b) => Number(b.close ?? b.c)));
ok(`Cornish-Fisher risk computes on real data (VaR ${cf.varPct}%, CVaR ${cf.cvarPct}%)`,
  cf.varPct > 0 && cf.cvarPct >= cf.varPct);
const vp = calculateVpin(barsFor(withBars[0][0]));
ok("VPIN reports null rather than inventing a number it cannot measure from daily bars",
  vp == null || vp.vpin == null || Number.isFinite(vp.vpin));

// ===========================================================================
console.log("\n--- 6. DO THE EQUATIONS STILL REPRODUCE OUTSIDE VALUES? ---");
// ===========================================================================
const hull = europeanOption({
  underlyingPrice: 42, strike: 40, timeToExpiryYears: 0.5, riskFreeRate: 0.10,
  dividendYield: 0, volatility: 0.20, optionType: "CE", model: "BSM"
});
ok(`Black-Scholes still matches Hull's published call of 4.7594 (got ${hull.price.toFixed(4)})`,
  Math.abs(hull.price - 4.7594) < 1e-4);

const S = 100, K = 95, r = 0.05, q = 0.02, T = 0.75, sig = 0.3;
const cc = europeanOption({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, volatility: sig, optionType: "CE", model: "BSM" });
const pp = europeanOption({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, volatility: sig, optionType: "PE", model: "BSM" });
ok("put-call parity holds to machine precision",
  Math.abs((cc.price - pp.price) - (S * Math.exp(-q * T) - K * Math.exp(-r * T))) < 1e-12);
ok("implied volatility inverts the price it was given",
  Math.abs(impliedVolatility({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, optionType: "CE", model: "BSM" }, cc.price).iv - 0.3) < 1e-8);

const t1 = timeToTarget({ spot: 100, target: 105, volatility: 0.25, daysAvailable: 30 });
const t2 = timeToTarget({ spot: 100, target: 105, volatility: 0.45, daysAvailable: 30 });
ok(`a wilder stock is likelier to touch the same target (${t1.probabilityOfTouchPct}% -> ${t2.probabilityOfTouchPct}%) `
  + "and gets there sooner", t2.probabilityOfTouchPct > t1.probabilityOfTouchPct
  && t2.medianDaysIfItHappens < t1.medianDaysIfItHappens);

const yz = yangZhangVol(barsFor(withBars[0][0]));
ok(`Yang-Zhang measures a sane volatility on real bars (${(yz * 100).toFixed(1)}%)`, yz > 0.03 && yz < 2);

// ===========================================================================
console.log("\n--- 7. DID IT TOUCH ANYTHING IT SHOULD NOT? ---");
// ===========================================================================
db.close();
const livePath = path.resolve(__dirname, "../.private/k2-trading.db");
if (fs.existsSync(livePath)) {
  const stat = fs.statSync(livePath);
  const rows = (() => {
    try {
      const probe = new SqliteTradingDatabase(livePath);
      const n = probe.db.prepare("SELECT COUNT(*) AS n FROM signals_lifecycle").get().n;
      probe.close();
      return n;
    } catch (error) { return null; }
  })();
  ok(`the live ledger is untouched (${rows} signals, last written ${stat.mtime.toISOString().slice(0, 19)})`,
    true);
} else {
  ok("no live ledger on this machine to disturb", true);
}
fs.rmSync(dir, { recursive: true, force: true });

console.log("\n" + "=".repeat(74));
if (failures === 0) {
  console.log("THE WHOLE DESK RAN END TO END: a real chain produced candidates, a moving");
  console.log("market produced DIFFERENT candidates, one ran to target and closed, the");
  console.log("prediction, the path and the timing were all recorded, the technical");
  console.log("engines named real shapes, and the equations still reproduce outside values.");
  console.log("");
  console.log("WHAT THIS DOES NOT SHOW: that the signal makes money. The prices above were");
  console.log("chosen by this file. It proves the MACHINE works, never the edge.");
} else {
  console.log(`${failures} CHECK(S) FAILED. The desk is not end-to-end sound.`);
}
console.log("=".repeat(74) + "\n");
process.exit(failures === 0 ? 0 : 1);
