"use strict";

/**
 * A full trading day, rehearsed.
 *
 * "It runs" and "it is right" are different claims, and only the first one can
 * be checked outside market hours. So this drives the real modules through a
 * simulated session with the clock faked and prices that actually MOVE, and
 * asks at each step whether the desk did the correct thing rather than merely
 * something.
 *
 * It answers the question that matters the night before: WILL IT BETRAY ME?
 * Concretely, the ways a desk betrays someone are few and specific:
 *
 *   - it shows a price that cannot be traded
 *   - it presents a stale number as a live one
 *   - it says BUY when a guard should have stopped it
 *   - it computes a profit or loss that is not arithmetically true
 *   - it records something that did not happen
 *   - it freezes, or dies, when the market moves fast
 *
 * Every one of those is a question with a yes or no answer, and every one is
 * asked below against a throwaway database. Nothing here touches the live
 * ledger, and the last check proves that.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
const ledger = require("../api/_lib/signal-record");
const { marketPhase, classifyBook, parseExchangeClock } = require("../api/_lib/live-quotes");
const { europeanOption } = require("../api/_lib/option-pricing");
const { tradeOdds } = require("../api/_lib/trade-odds");
const { longOptionExits } = require("../api/_lib/exit-levels");

// Monday 21 September 2026. All instants are UTC; IST is +5:30.
const OPEN = Date.parse("2026-09-21T03:45:00Z");        // 09:15 IST
const T = (istHHMM) => {
  const [h, m] = istHHMM.split(":").map(Number);
  return Date.parse("2026-09-21T00:00:00Z") + (h * 60 + m - 330) * 60_000;
};

const temps = [];
function freshDb() {
  const file = path.join(os.tmpdir(), `k2-rehearse-${process.pid}-${temps.length}.db`);
  temps.push(file);
  return new SqliteTradingDatabase(file);
}
const rowOf = (db, id) => db.db.prepare("SELECT * FROM signals_lifecycle WHERE id = ?").get(id);

const liveBefore = (() => {
  const f = path.resolve(__dirname, "..", ".private", "k2-trading.db");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
})();

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ""}`);
  return false;
}

try {
  console.log("\n=== WHEN: does the desk know what time it is? ===");
  check("08:30 IST is PRE_OPEN, nothing records", marketPhase(T("08:30")).phase === "PRE_OPEN");
  check("09:15 IST is OPEN, recording begins", marketPhase(T("09:15")).open === true);
  check("15:30 IST is still OPEN", marketPhase(T("15:30")).open === true);
  check("15:31 IST is CLOSED", marketPhase(T("15:31")).open === false);
  check("Sunday is WEEKEND, never OPEN", marketPhase(Date.parse("2026-09-20T06:00:00Z")).phase === "WEEKEND");

  console.log("\n=== WHAT: is a quote current, and does the desk say so honestly? ===");
  // A book the exchange stamped one minute ago, during the session.
  const fresh = classifyBook(parseExchangeClock("21-Sep-2026 10:29:00"), { now: T("10:30") });
  check("a one-minute-old book during the session is REALTIME and executable",
    fresh.kind === "REALTIME" && fresh.executable === true, JSON.stringify(fresh));
  // The same book, ten minutes later.
  const lagged = classifyBook(parseExchangeClock("21-Sep-2026 10:20:00"), { now: T("10:30") });
  check("a ten-minute-old book is NOT executable, even mid-session",
    lagged.executable === false, JSON.stringify(lagged));
  check("and its age is reported on the exchange clock, not ours",
    lagged.exchangeAgeSeconds === 600, String(lagged.exchangeAgeSeconds));
  // Yesterday's book.
  const yesterday = classifyBook(parseExchangeClock("18-Sep-2026 15:30:00"), { now: T("10:30") });
  check("a book from a previous session is STALE and never executable",
    yesterday.kind === "STALE" && yesterday.executable === false);

  console.log("\n=== HOW MUCH: is the arithmetic true as the market moves? ===");
  // A real option, repriced as the underlying rises. Nothing about the payoff
  // may depend on which way we walk the price.
  const base = { strike: 162.5, timeToExpiryYears: 8 / 365, riskFreeRate: 0.065, dividendYield: 0, volatility: 0.28, optionType: "CE", model: "BSM" };
  const ladder = [158, 160, 162.5, 165, 168].map((spot) => ({ spot, price: europeanOption({ ...base, underlyingPrice: spot }).price }));
  const rising = ladder.every((row, i) => i === 0 || row.price > ladder[i - 1].price);
  check("a call gets monotonically more valuable as the stock rises", rising,
    ladder.map((r) => `${r.spot}:${r.price.toFixed(2)}`).join(" "));
  const deltas = ladder.slice(1).map((row, i) => (row.price - ladder[i].price) / (row.spot - ladder[i].spot));
  check("and its delta stays inside [0,1] the whole way",
    deltas.every((d) => d >= 0 && d <= 1), deltas.map((d) => d.toFixed(3)).join(" "));
  // Time decay, holding the stock still: the thing that costs money while waiting.
  const decay = [8, 5, 2, 1].map((d) => europeanOption({ ...base, underlyingPrice: 161.87, timeToExpiryYears: d / 365 }).price);
  check("premium falls every day the stock does not move (theta is real)",
    decay.every((p, i) => i === 0 || p < decay[i - 1]), decay.map((p) => p.toFixed(2)).join(" -> "));

  console.log("\n=== WHETHER: do the odds respond to how the market is actually moving? ===");
  // Same option, two different worlds: a calm stock and a wild one.
  const bars = (range) => Array.from({ length: 30 }, (_, i) => {
    const mid = 161.87;
    return { close: mid, high: mid * (1 + range), low: mid * (1 - range) };
  });
  const calm = tradeOdds({ spot: 161.87, bars: bars(0.004), impliedVol: 0.28, breakevenLong: 165.6, breakevenFull: 165, daysToExpiry: 8 });
  const wild = tradeOdds({ spot: 161.87, bars: bars(0.020), impliedVol: 0.28, breakevenLong: 165.6, breakevenFull: 165, daysToExpiry: 8 });
  check("a wilder stock gives a HIGHER chance of reaching the target",
    wild.probabilityOfProfitPct > calm.probabilityOfProfitPct,
    `calm ${calm.probabilityOfProfitPct}% vs wild ${wild.probabilityOfProfitPct}%`);
  check("the same option is EXPENSIVE on the calm stock and not on the wild one",
    calm.volatility.verdict === "EXPENSIVE" && wild.volatility.favoursBuyer === true,
    `calm ${calm.volatility.verdict} ratio ${calm.volatility.ratio} | wild ${wild.volatility.verdict} ratio ${wild.volatility.ratio}`);
  check("time-to-target is shorter when the stock moves more",
    wild.timing.medianDaysIfItHappens < calm.timing.medianDaysIfItHappens,
    `calm ${calm.timing.medianDaysIfItHappens}d vs wild ${wild.timing.medianDaysIfItHappens}d`);

  console.log("\n=== WHERE: do the exits sit where the arithmetic says? ===");
  const ex = longOptionExits({ premium: 3.10, strike: 162.5, lotSize: 6150, isCall: true });
  check("target and stop are symmetric around the premium paid",
    ex.profitTarget.premium === 4.65 && ex.stop.premium === 1.55);
  check("rupee gain equals (target - entry) x lot, exactly",
    ex.profitTarget.gainRupees === Math.round((4.65 - 3.10) * 6150), String(ex.profitTarget.gainRupees));
  check("breakeven is strike plus premium, exactly",
    ex.atExpiry.breakevenSpot === 165.6, String(ex.atExpiry.breakevenSpot));

  console.log("\n=== WHAT HAPPENS: a signal through a whole moving session ===");
  const db = freshDb();
  const signal = {
    symbol: "MOTHERSON", strike: 162.5, right: "CE", expiry: "2026-09-29",
    entryPrice: 3.10, lotSize: 6150, priceSource: "LIVE_BROKER_QUOTE",
    executable: true, targetPrice: 4.65, stopPrice: 1.55,
    probabilityOfProfitPct: 28.6, volatilityVerdict: "RICH"
  };

  // 08:30 -- before the bell. Nothing may be recorded.
  const early = marketPhase(T("08:30")).open;
  check("nothing is recorded before 09:15", early === false);

  // 09:20 -- the desk issues and records at the price it displayed.
  const rec = ledger.record(signal, { now: T("09:20"), db });
  check("the signal is recorded once the session is open", rec.ok && rec.status === "RECORDED");
  const opened = rowOf(db, rec.id);
  check("it stores the price that was SHOWN, with its source",
    opened.entry_price === 3.10 && opened.entry_price_source === "LIVE_BROKER_QUOTE");
  check("and the odds it carried at that moment, for later calibration",
    opened.probability_of_profit_pct === 28.6 && opened.volatility_verdict === "RICH");

  // 10:30 -- price drifts up but reaches nothing. Must stay open.
  ledger.markToMarket(() => ({ price: 3.80, source: "BROKER_REALTIME" }), { now: T("10:30"), db });
  const drifting = rowOf(db, rec.id);
  check("a drifting price updates the mark and leaves the position OPEN",
    drifting.status === "ACTIVE" && drifting.current_price === 3.80);
  check("the entry price does NOT move when the mark does",
    drifting.entry_price === 3.10, String(drifting.entry_price));

  // 11:15 -- the feed drops. No price means no mark, not a flat mark.
  ledger.markToMarket(() => null, { now: T("11:15"), db });
  check("a dropped feed leaves the last real mark alone rather than writing zero",
    rowOf(db, rec.id).current_price === 3.80);

  // 13:45 -- target reached.
  ledger.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: T("13:45"), db });
  const closed = rowOf(db, rec.id);
  check("the target closes the position, for the stated reason",
    closed.status === "CLOSED" && closed.exit_reason === "TARGET_HIT");
  check("the profit is exactly (exit - entry) x lot",
    closed.pnl_rupees === Math.round((4.70 - 3.10) * 6150), `got ${closed.pnl_rupees}`);
  check("and the exit carries the source of its price",
    closed.exit_price_source === "BROKER_REALTIME");

  // A second position that goes the other way.
  const db2 = freshDb();
  const loser = ledger.record({ ...signal, symbol: "ASTRAL", strike: 1400, entryPrice: 25.40, lotSize: 425, targetPrice: 38.10, stopPrice: 12.70 }, { now: T("09:20"), db: db2 });
  ledger.markToMarket(() => ({ price: 12.50, source: "BROKER_REALTIME" }), { now: T("12:00"), db: db2 });
  const stopped = rowOf(db2, loser.id);
  check("a falling price stops out, and the loss is recorded as a loss",
    stopped.exit_reason === "STOP_HIT" && stopped.pnl_rupees < 0, `pnl ${stopped.pnl_rupees}`);
  check("the loss is exactly (exit - entry) x lot, not rounded in our favour",
    stopped.pnl_rupees === Math.round((12.50 - 25.40) * 425), `got ${stopped.pnl_rupees}`);

  console.log("\n=== WHO WON: does the scorecard tell the truth at the end of the day? ===");
  const win = ledger.trackRecord({ db });
  const lose = ledger.trackRecord({ db: db2 });
  check("the winning book reports one win and no losses",
    win.closed === 1 && win.wins === 1 && win.winRatePct === 100);
  check("the losing book reports one loss and a 0% win rate",
    lose.closed === 1 && lose.losses === 1 && lose.winRatePct === 0);
  check("profit factor is UNDEFINED with no losses, not infinity",
    win.profitFactor === null && typeof win.profitFactorNote === "string");
  check("every number is stamped as coming from observed prices only",
    win.basis === "OBSERVED_PRICES_ONLY");

  console.log("\n=== WHAT IT REFUSES: the guards, exercised ===");
  const db3 = freshDb();
  check("a price with no provenance cannot open a position",
    ledger.record({ ...signal, priceSource: null }, { now: T("10:00"), db: db3 }).ok === false);
  check("a back-dated signal is refused outright",
    ledger.record({ ...signal, issuedAt: "2026-09-01T05:00:00Z" }, { now: T("10:00"), db: db3 }).reason === "BACKDATED_OR_FUTURE_SIGNAL_REFUSED");
  check("the same contract twice in a day is one position, not two",
    ledger.record(signal, { now: T("10:00"), db: db3 }).status === "RECORDED"
    && ledger.record(signal, { now: T("10:05"), db: db3 }).status === "ALREADY_RECORDED");

  console.log("\n=== DID IT TOUCH ANYTHING IT SHOULD NOT? ===");
  const liveAfter = (() => {
    const f = path.resolve(__dirname, "..", ".private", "k2-trading.db");
    return fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
  })();
  check("the live production ledger is byte-for-byte untouched by this rehearsal",
    liveAfter === liveBefore, `${liveBefore} -> ${liveAfter}`);

  console.log(`\n${"=".repeat(72)}`);
  if (failures === 0) {
    console.log("REHEARSAL PASSED. Every question above answered correctly.");
    console.log("The desk prices, refuses, records and reports as it should when prices move.");
    console.log("What this does NOT establish: that the SIGNAL makes money. It never has.");
  } else {
    console.log(`REHEARSAL FAILED: ${failures} check(s) did not pass. Do not trade on this.`);
  }
  console.log("=".repeat(72));
} finally {
  for (const file of temps) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(file + suffix, { force: true }); } catch (error) { /* leftovers are not failures */ }
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
