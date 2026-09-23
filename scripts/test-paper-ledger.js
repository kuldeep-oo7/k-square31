"use strict";

/**
 * THE TRACK RECORD MUST NOT FLATTER ITSELF.
 *
 * Every ambiguity in a twenty-minute view of the market has a generous reading
 * and a harsh one. These tests pin the harsh one, because a record that reads
 * better than what happened is worse than no record: it is the thing money gets
 * sized on.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("./paper-ledger");

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label); }
}

const at = (hhmm, day = "2026-09-24") => Date.parse(day + "T" + hhmm + ":00+05:30");
const feed = (hhmm, day = "24-Sep-2026") => day + " " + hhmm + ":00";
const q = (ltp, high, low, hhmm, day, open = null) =>
  ({ ltp, high, low, open, exchangeFeedTime: feed(hhmm, day) });

function futTrade(extra = {}) {
  return L.tradeFromLevel({
    kind: "FUT", symbol: "LT", contract: "LT26OCTFUT", expiry: "2026-10-27",
    buy: 99.2, target: 101.68, target2: 104.16, stop: 97.71,
    sessionDate: "2026-09-24", shownAt: new Date(at("09:33")).toISOString(),
    anchorSource: "FUTURES_LIVE", ...extra
  });
}

console.log("paper ledger:");

// --- construction -----------------------------------------------------------
{
  const t = futTrade();
  check("a frozen level becomes a WAITING trade", t && t.status === "WAITING");
  check("its id names the session, the kind and the contract", t.id === "2026-09-24|FUT|LT26OCTFUT");
  check("a level with no stop is refused rather than scored",
    L.tradeFromLevel({ kind: "FUT", contract: "X", buy: 100, target: 102, stop: 0, sessionDate: "2026-09-24", shownAt: "x" }) === null);
}

// --- the fill ---------------------------------------------------------------
{
  const t = futTrade();
  // Baseline at the moment of showing: the day's low was ALREADY 98 at 09:20,
  // below the 99.2 limit. That low happened before the level existed.
  t.obs = { date: "2026-09-24", high: 100.5, low: 98.0, last: 100.0 };
  L.observe(t, q(100.1, 100.5, 98.0, "09:53"), at("09:53"));
  check("a low from BEFORE the level was shown cannot fill it", t.status === "WAITING");
  L.observe(t, q(99.6, 100.5, 97.9, "10:13"), at("10:13"));
  check("a NEW low under the limit fills it", t.status === "OPEN");
  check("the fill is recorded at the limit, never better", t.buy === 99.2);
  check("hours from shown to filled are recorded", t.hoursToFill === 0.67);
}

// --- the fill window --------------------------------------------------------
{
  const t = futTrade();
  t.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  // In one window the price dipped to 99.0 (fill) and ran to 102 (past target).
  L.observe(t, q(101.9, 102.0, 99.0, "09:53"), at("09:53"));
  check("a target inside the fill window is NOT counted", t.status === "OPEN");

  const s = futTrade();
  s.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  // In one window it dipped through the limit AND the stop.
  L.observe(s, q(98.5, 100.2, 97.5, "09:53"), at("09:53"));
  check("a stop inside the fill window IS counted", s.status === "STOP");
  check("and it exits at the stop, a loss", s.pnl && s.pnl.perUnit === round2(97.71 - 99.2));
}

// --- target, stop, and both -------------------------------------------------
{
  const t = futTrade();
  t.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  L.observe(t, q(99.3, 100.2, 99.1, "09:53"), at("09:53"));           // fill
  L.observe(t, q(101.5, 101.8, 99.1, "11:13"), at("11:13"));          // new high 101.8 >= 101.68
  check("a new high at the target closes it as TARGET", t.status === "TARGET");
  check("it exits at the target price", t.exitPrice === 101.68);
  check("hours from fill to target are recorded", t.hoursFillToExit === 1.33);
  check("profit is recorded per unit and as a percent", t.pnl.perUnit === 2.48 && t.pnl.pct === 2.5);
  check("futures profit is labelled GROSS, not dressed up as net", t.pnl.basis === "GROSS");

  const b = futTrade();
  b.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  L.observe(b, q(99.3, 100.2, 99.1, "09:53"), at("09:53"));           // fill
  L.observe(b, q(100.0, 102.0, 97.0, "10:13"), at("10:13"));          // target AND stop in one window
  check("target and stop in one window is a STOP", b.status === "STOP");
}

// --- day orders and new sessions --------------------------------------------
{
  const t = futTrade();
  t.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  // Next morning the price is far below the limit. Yesterday's order is dead.
  L.observe(t, q(98.0, 98.5, 97.0, "09:33", "25-Sep-2026"), at("09:33", "2026-09-25"));
  check("tomorrow's low never fills today's limit: it is UNFILLED", t.status === "UNFILLED");
  check("an unfilled order has no profit and no loss", t.pnl === null);

  const s = futTrade();
  s.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  L.settle(s, at("15:35"));
  check("a limit still waiting after 15:30 is UNFILLED", s.status === "UNFILLED");

  const g = futTrade();
  g.obs = { date: "2026-09-24", high: 100.2, low: 99.9, last: 100.0 };
  L.observe(g, q(99.3, 100.2, 99.1, "09:53"), at("09:53"));           // fill today
  // Tomorrow it opens at 96.5, below the 97.71 stop.
  L.observe(g, q(96.8, 97.2, 96.4, "09:33", "25-Sep-2026", 96.5), at("09:33", "2026-09-25"));
  check("a gap down through the stop exits at the OPEN, not the stop", g.status === "STOP" && g.exitPrice === 96.5);
}

// --- time-based endings -----------------------------------------------------
{
  const f = futTrade();
  f.status = "OPEN"; f.filledAt = new Date(at("09:53")).toISOString(); f.last = 100.4;
  f.sessionsHeld = L.FUTURES_MAX_SESSIONS;
  L.settle(f, at("15:40"));
  check("a futures trade held twenty sessions is TIMED_OUT at the last price", f.status === "TIMED_OUT" && f.exitPrice === 100.4);

  // An INDEX option settles in cash, so it may be held to expiry.
  const o = L.tradeFromLevel({
    kind: "CE", symbol: "NIFTY", contract: "NIFTY26OCT26000CE", expiry: "2026-10-27",
    strike: 26000, optionType: "CE", lotSize: 75,
    buy: 32, target: 48, stop: 16, sessionDate: "2026-09-24", shownAt: new Date(at("09:33")).toISOString()
  });
  o.status = "OPEN"; o.filledAt = o.shownAt; o.last = 0;
  L.settle(o, Date.parse("2026-10-21T15:31:00+05:30"));
  check("an index option is NOT taken off early: it is cash-settled", o.status === "OPEN");
  L.settle(o, Date.parse("2026-10-27T15:31:00+05:30"));
  check("an index option still open at expiry is EXPIRED", o.status === "EXPIRED");
  check("expiring worthless loses the whole premium and the buy charges",
    o.pnl.netPerLot === -(32 * 75) - 20 && o.pnl.basis === "NET");

  // A STOCK option is physically settled: taken off before delivery margins.
  const so = L.tradeFromLevel({
    kind: "PE", symbol: "TATAPOWER", contract: "TATAPOWER26OCT380PE", expiry: "2026-10-27",
    strike: 380, optionType: "PE", lotSize: 1450,
    buy: 12.75, target: 19.13, stop: 6.38, sessionDate: "2026-09-24", shownAt: new Date(at("09:33")).toISOString()
  });
  so.status = "OPEN"; so.filledAt = so.shownAt; so.last = 14.2;
  check("exit-by for a Tuesday 27 Oct expiry is Wednesday 21 Oct", L.exitByDate("2026-10-27") === "2026-10-21");
  L.settle(so, Date.parse("2026-10-21T15:00:00+05:30"));
  check("a stock option is still open before the close of its exit-by day", so.status === "OPEN");
  L.settle(so, Date.parse("2026-10-21T15:31:00+05:30"));
  check("a stock option is TIME_EXIT at the last price when delivery margins begin",
    so.status === "TIME_EXIT" && so.exitPrice === 14.2);

  const sf = futTrade();
  sf.status = "OPEN"; sf.filledAt = new Date(at("09:53")).toISOString(); sf.last = 100.9;
  L.settle(sf, Date.parse("2026-10-21T15:31:00+05:30"));
  check("a stock FUTURE is taken off too -- futures are physically settled as well", sf.status === "TIME_EXIT");

  const w = L.tradeFromLevel({
    kind: "CE", symbol: "JINDALSTEL", contract: "JINDALSTEL26OCT1180CE", expiry: "2026-10-27",
    strike: 1180, optionType: "CE", lotSize: 625,
    buy: 32, target: 48, stop: 16, sessionDate: "2026-09-24", shownAt: new Date(at("09:33")).toISOString()
  });
  w.obs = { date: "2026-09-24", high: 33, low: 31.9, last: 32.1 };
  L.observe(w, q(31.8, 33, 31.5, "09:53"), at("09:53"));              // fill
  L.observe(w, q(47, 48.5, 31.5, "12:13"), at("12:13"));              // target
  check("an option target is recorded NET of every charge, and below the gross",
    w.status === "TARGET" && w.pnl.basis === "NET" && w.pnl.netPerLot < w.pnl.perLot && w.pnl.netPerLot > 0);
}

// --- storage ----------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-ledger-"));
  const now = at("09:33");
  const led = L.openLedger({ dir, now });
  const a = futTrade();
  const b = futTrade({ contract: "WIPRO26OCTFUT", symbol: "WIPRO" });
  check("a trade is added once", led.add(a, q(100, 100.2, 99.9, "09:33")) === true);
  check("and the same trade twice is refused", led.add(futTrade(), null) === false);
  led.add(b, q(100, 100.2, 99.9, "09:33"));
  led.markAll((t) => t.contract === "LT26OCTFUT" ? q(99.0, 100.2, 97.0, "09:53") : q(100.1, 100.3, 99.9, "09:53"), at("09:53"));
  const saved = led.save();
  check("a trade that finished moves out of open.json", saved.open === 1 && saved.closedNow === 1);
  const month = JSON.parse(fs.readFileSync(path.join(dir, "closed-2026-09.json"), "utf8"));
  check("and into that month's closed file", month.trades.length === 1 && month.trades[0].status === "STOP");

  const again = L.openLedger({ dir, now: at("10:13") });
  check("the running trade is still there next build", again.open.length === 1 && again.open[0].contract === "WIPRO26OCTFUT");
  check("a finished trade cannot be re-added the same month", again.add(futTrade(), null) === false);

  const summary = L.summarize(again.open, again.allClosed());
  check("the summary counts one stop and one still waiting", summary.ALL.stop === 1 && summary.ALL.waiting === 1);
  check("hit rate is 0 of 1 resolved, not 0 of 2 shown", summary.ALL.hitRatePct === 0 && summary.ALL.resolved === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the expected-time maths ------------------------------------------------
{
  const up = L.firstPassage({ from: 100, to: 100.8, sigma: 0.25, tradingDays: 1 });
  const down = L.firstPassage({ from: 100, to: 99.2, sigma: 0.25, tradingDays: 1 });
  check("a buy limit below the price is at least as likely as the same move up", down.probabilityPct >= up.probabilityPct);
  check("a 0.8% move at 25% vol in one session is roughly a coin flip, not a certainty",
    down.probabilityPct > 50 && down.probabilityPct < 70);
  check("no volatility, no estimate -- never a made-up number", L.firstPassage({ from: 100, to: 99, sigma: 0, tradingDays: 1 }) === null);
}

function round2(v) { return Math.round(v * 100) / 100; }

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
