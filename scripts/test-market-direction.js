"use strict";

/**
 * THE MARKET'S DIRECTION AND WHICH NAMES GET OPTIONS (api/_lib/market-direction.js).
 *
 * The page and the build's live-quote step both call optionsView(); if they
 * ever picked different names, the page would show puts whose live books were
 * never fetched -- refused in session, nothing frozen, a red build. So the
 * selection itself is tested here, on known inputs:
 *   no downtrend  -> calls on BUY / ACCUMULATE, exactly as before 29 Sep
 *   downtrend     -> no calls; puts on every index with options, and on the
 *                    SELL / REDUCE stocks that are falling themselves
 * and the reader underneath: an uptrend reads UP, a fall reads DOWN, a close
 * older than the last session says so, too little history says "not read".
 */

const D = require("../api/_lib/market-direction");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

// Weekday rows up to `last`, the close moving `up` a day, then `down` a day for
// the final `fall` sessions.
function series(last, { n = 260, up = 0.001, down = -0.006, fall = 0 } = {}) {
  const days = [];
  let t = Date.parse(`${last}T00:00:00Z`);
  while (days.length < n) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay())) days.unshift(d.toISOString().slice(0, 10));
    t -= 86_400_000;
  }
  let close = 20000;
  return { rows: days.map((day, i) => {
    const open = close;
    close *= 1 + (i >= n - fall ? down : up);
    return [day, open, Math.max(open, close) * 1.002, Math.min(open, close) * 0.998, close];
  }) };
}
const at = (iso, hhmm) => Date.parse(`${iso}T${hhmm}:00+05:30`);

console.log("the market's direction:");
{
  const now = at("2026-09-29", "10:00");
  const up = D.marketDirection({ historyFor: (s) => (s === "^NSEI" ? series("2026-09-28") : null), now });
  check("a steady rise reads UP (BULL_TRENDING), not a downtrend", up.available && up.regime === "BULL_TRENDING" && up.downtrend === false, up.regime);
  const down = D.marketDirection({ historyFor: (s) => (s === "^NSEI" ? series("2026-09-28", { fall: 30 }) : null), now });
  check("a 30-session fall reads DOWN (BEAR_HOSTILE): the close under the 20-day, the 20-day under the 50-day",
    down.available && down.downtrend === true && down.close < down.ema20 && down.ema20 < down.sma50, JSON.stringify({ close: down.close, ema20: down.ema20, sma50: down.sma50 }));
  check("and says since when: a date inside the fall, not the first day of the history",
    down.since > "2026-08-01" && down.since <= down.asOf, down.since);
  check("read from COMPLETED closes: at 10:00 on the 29th the last close is the 28th", down.asOf === "2026-09-28" && down.stale === false, down.asOf);
  const partial = series("2026-09-29", { fall: 30 });
  const midday = D.marketDirection({ historyFor: (s) => (s === "^NSEI" ? partial : null), now });
  check("a bar for today, taken during the session, is not a close: it is ignored before 16:00", midday.asOf === "2026-09-28", midday.asOf);
  const old = D.marketDirection({ historyFor: (s) => (s === "^NSEI" ? series("2026-09-24", { fall: 30 }) : null), now });
  check("a history that ends before the last session is flagged stale, with the close it should have had",
    old.stale === true && old.asOf === "2026-09-24" && old.expectedAsOf === "2026-09-28", `${old.asOf} vs ${old.expectedAsOf}`);
  const none = D.marketDirection({ historyFor: () => null, now });
  check("no history: not read -- never a guessed direction", none.available === false && /not on hand/.test(none.reason));
  const thrown = D.marketDirection({ historyFor: () => { throw new Error("disk gone"); }, now });
  check("a failure is a reason, not a crash", thrown.available === false && thrown.reason === "disk gone");
  check("the test result travels with the verdict: FAIL, final year +0.286%, t 0.205, 18 trades",
    down.test.verdict === "FAIL" && down.test.shortsFinalPct === 0.286 && down.test.shortsFinalT === 0.205 && down.test.shortsFinalTrades === 18);
}

console.log("\na stock's own trend:");
{
  const now = at("2026-09-29", "10:00");
  const toBars = (rows) => rows.map((r) => ({ timestamp: Math.floor(Date.parse(`${r[0]}T09:15:00+05:30`) / 1000), open: r[1], high: r[2], low: r[3], close: r[4] }));
  check("a falling stock reads BEAR_HOSTILE", D.ownTrend(toBars(series("2026-09-28", { n: 62, fall: 25 }).rows), now) === "BEAR_HOSTILE");
  check("a rising stock does not", D.ownTrend(toBars(series("2026-09-28", { n: 62 }).rows), now) !== "BEAR_HOSTILE");
  check("under 50 completed sessions: no verdict (null), not a guess", D.ownTrend(toBars(series("2026-09-28", { n: 40, fall: 20 }).rows), now) === null);
  check("no bars: null", D.ownTrend(null, now) === null && D.ownTrend(undefined, now) === null);
  // A sharp rise TODAY must not rescue a stock whose completed closes fall.
  const rows = series("2026-09-28", { n: 62, fall: 25 }).rows;
  const today = [...rows, ["2026-09-29", rows[rows.length - 1][4], 99999, rows[rows.length - 1][4], 99999]];
  check("today's unfinished bar is left out, however far it has moved", D.ownTrend(toBars(today), now) === "BEAR_HOSTILE");
}

console.log("\nwhich names get options, and which side:");
{
  const universe = [
    { symbol: "AAA", action: "BUY" }, { symbol: "BBB", action: "ACCUMULATE" }, { symbol: "CCC", action: "STAND_ASIDE" },
    { symbol: "DDD", action: "SELL" }, { symbol: "EEE", action: "REDUCE" }, { symbol: "FFF", action: "SELL" },
    { symbol: "HHH", action: "STAND_ASIDE" }, { symbol: "III", action: "SELL" }
  ];
  // AAA falls with the market; BBB and HHH rise on their own; III is rated SELL but rising.
  const trend = { AAA: "BEAR_HOSTILE", BBB: "BULL_TRENDING", HHH: "BULL_TRENDING", III: "BULL_TRENDING",
    DDD: "BEAR_HOSTILE", EEE: "BEAR_HOSTILE", FFF: "NEUTRAL_CHOPPY" };
  const trendFor = (s) => trend[s] || null;
  const up = D.optionsView({ direction: { available: true, regime: "BULL_TRENDING" }, universe, trendFor });
  check("no downtrend: calls on BUY and ACCUMULATE (unchanged since 25 Sep), and puts on the SELL/REDUCE stocks falling themselves",
    JSON.stringify(up.bullish) === JSON.stringify({ AAA: true, BBB: true, DDD: false, EEE: false }) && up.downtrend === false
    && up.rule === "CALLS_ON_BUY_OR_ACCUMULATE_AND_PUTS_ON_FALLING_SELL_REDUCE", JSON.stringify(up.bullish));
  const mixed = D.optionsView({ direction: { available: true, regime: "NEUTRAL_CHOPPY" }, universe, trendFor });
  check("a mixed market is not a downtrend", JSON.stringify(mixed.bullish) === JSON.stringify(up.bullish));
  const unread = D.optionsView({ direction: { available: false }, universe, trendFor });
  check("direction not read: as in a normal market, never index puts on a guess",
    JSON.stringify(unread.bullish) === JSON.stringify(up.bullish) && unread.indices.length === 0);
  const down = D.optionsView({ direction: { available: true, regime: "BEAR_HOSTILE" }, universe, trendFor });
  const want = { NIFTY: false, BANKNIFTY: false, FINNIFTY: false, MIDCPNIFTY: false, NIFTYNXT50: false, BBB: true, DDD: false, EEE: false, HHH: true };
  check("downtrend: index puts, puts on the falling SELL/REDUCE stocks, and calls on the stocks RISING ON THEIR OWN",
    JSON.stringify(down.bullish) === JSON.stringify(want), JSON.stringify(down.bullish));
  check("downtrend: a BUY stock that falls with the market gets nothing", !("AAA" in down.bullish));
  check("downtrend: a stock rising on its own is shown whatever its rating, unless rated SELL/REDUCE",
    down.bullish.HHH === true && !("III" in down.bullish) && down.risingOnTheirOwn.join() === "BBB,HHH");
  check("a SELL stock that is not falling gets no put, and is named", down.ratedDownNotFalling.join() === "FFF,III" && !("FFF" in down.bullish));
  check("the view says what it chose: 5 indices, 4 stocks", down.indices.length === 5 && down.stocks.join() === "BBB,DDD,EEE,HHH");
  check("a stock with no trend verdict (too little history) gets nothing", Object.keys(D.optionsView({ direction: { available: true, regime: "BEAR_HOSTILE" },
    universe: [{ symbol: "GGG", action: "SELL" }, { symbol: "JJJ", action: "BUY" }], trendFor: () => null }).bullish).every((s) => s in D.INDEX_TICKER));
}

console.log("\nthe index tickers (checked against NSE's allIndices, 29 Sep 2026):");
check("FINNIFTY is NIFTY_FIN_SERVICE.NS, never ^CNXFIN (Yahoo's \"NIFTY FINSRV25 50\", a different index)",
  D.INDEX_TICKER.FINNIFTY === "NIFTY_FIN_SERVICE.NS" && !Object.values(D.INDEX_TICKER).includes("^CNXFIN"));
check("every NSE index with options has a ticker", ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"].every((s) => D.INDEX_TICKER[s]));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
