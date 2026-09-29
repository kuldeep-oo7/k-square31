"use strict";

/**
 * THE MARKET'S DIRECTION, ONE VERDICT FOR THE WHOLE BUILD.
 *
 * api/_lib/market-regime.js classifyMarketRegime read NIFTY as BEAR_HOSTILE --
 * "long setups restricted", shorts allowed -- every session from Wed 2 Sep 2026
 * (recomputed on NSE's own NIFTY history on 29 Sep: close 22,716.2, 20-day
 * 23,377.78, 50-day 23,932.93 -- the same to the paisa as the build's),
 * while the page showed only buys: the reader had never been connected, the
 * ratings had no bearish verdict, and puts had been taken off on 25 Sep. The
 * user, 29 Sep: "the market is falling ... you should know it and give me the
 * put option".
 *
 * Read from NIFTY's COMPLETED daily closes -- known before the open, so it
 * cannot flip during a session -- and shared by prepare-static-build.js (which
 * option chains to fetch live) and publish-static-desk.js (what to show), both
 * through optionsView() below, so the two can never pick different names.
 *
 * Tested first (research/regime-2026-09-29, pre-registered, run once on five
 * years of NSE's own NIFTY data): shorts in these downtrends FAILED (final year
 * +0.29% a trade, t 0.21, 18 trades), longs outside them FAILED (-0.26%). It
 * is the direction the user asked for, not a proven edge, and the page says so.
 */

const { classifyMarketRegime } = require("./market-regime");
const { readHistory, completedRows, lastCompletedSession } = require("./risk-history");

// Every NSE index with options, and the Yahoo ticker its daily history lives
// under -- each checked against NSE's own allIndices on 29 Sep 2026 (NIFTY
// 22716.2, BANK 54259.95, FIN SERVICE 24648.5, MIDCAP SELECT 13674.15, NEXT 50
// 69460.2: identical). ^CNXFIN is NOT FINNIFTY: Yahoo names it "NIFTY FINSRV25
// 50" and it read 26570.5 against NSE's 24648.5.
const INDEX_TICKER = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", FINNIFTY: "NIFTY_FIN_SERVICE.NS", MIDCPNIFTY: "NIFTY_MID_SELECT.NS", NIFTYNXT50: "^NSMIDCP" };
const TEST = { file: "research/regime-2026-09-29", verdict: "FAIL", shortsFinalPct: 0.286, shortsFinalT: 0.205, shortsFinalTrades: 18, longsOutsideFinalPct: -0.2606 };

const IST_MS = 330 * 60_000;
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

function marketDirection({ historyFor = (s) => readHistory(s), now = Date.now() } = {}) {
  try {
    const h = historyFor("^NSEI");
    const rows = h ? completedRows(h.rows, now) : [];
    if (rows.length < 60) return { available: false, reason: "NIFTY's daily history is not on hand" };
    const bars = rows.map((r) => ({ date: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
    const verdict = classifyMarketRegime(bars);
    // Since when: walk back while the verdict stays the same.
    let since = bars[bars.length - 1].date;
    for (let i = bars.length - 2; i >= 60; i -= 1) {
      if (classifyMarketRegime(bars.slice(0, i + 1)).regime !== verdict.regime) break;
      since = bars[i].date;
    }
    const asOf = bars[bars.length - 1].date;
    // A verdict from an old close is still a verdict, but the page must say
    // how old: a failed history refresh would otherwise keep yesterday's
    // direction on the page as if it were today's.
    const expected = lastCompletedSession(now);
    return {
      available: true, regime: verdict.regime, downtrend: verdict.regime === "BEAR_HOSTILE",
      longAllowed: verdict.longAllowance !== false, shortAllowed: verdict.shortAllowance !== false,
      reason: verdict.reason, asOf, since, expectedAsOf: expected, stale: asOf < expected,
      close: verdict.lastClose ?? null, ema20: verdict.ema20 ?? null, sma50: verdict.sma50 ?? null, sma200: verdict.sma200 ?? null,
      test: TEST
    };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

/**
 * A STOCK'S OWN TREND, by the same reader on its own completed daily bars
 * (bar-cache.js rows: {timestamp, open, high, low, close}). null when there is
 * not enough history to say.
 */
function ownTrend(bars, now = Date.now()) {
  if (!Array.isArray(bars)) return null;
  const today = istDate(now);
  const settled = new Date(now + IST_MS).getUTCHours() >= 16;
  const done = bars.filter((b) => {
    const ts = Number(b?.timestamp);
    if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(Number(b.close))) return false;
    const day = istDate(ts > 1e11 ? ts : ts * 1000);
    return day < today || (day === today && settled);
  });
  if (done.length < 50) return null;
  return classifyMarketRegime(done).regime;
}

/**
 * WHICH NAMES GET OPTIONS ON THIS BUILD, AND WHICH SIDE: symbol -> true (calls)
 * or false (puts); a name that is not in the map gets nothing.
 *
 *   No downtrend: calls on the stocks the desk rates BUY or ACCUMULATE -- the
 *     rule since 25 Sep 2026, unchanged.
 *   NIFTY in a downtrend: no calls. Puts on every NSE index with options, and
 *     on the stocks the desk rates SELL or REDUCE that are ALSO in their own
 *     downtrend. The rating alone is not a direction: half of its weight is
 *     trend persistence and a volatility band, which say nothing about which
 *     way a stock is going, so a put needs the stock itself to be falling
 *     (price under its 20-day average, under its 50-day).
 *
 * `trendFor(symbol)` returns the stock's own regime (ownTrend), or null.
 */
function optionsView({ direction, universe = [], trendFor = () => null }) {
  const downtrend = Boolean(direction?.available && direction.regime === "BEAR_HOSTILE");
  const bullish = {};
  const skipped = [];
  if (downtrend) {
    for (const index of Object.keys(INDEX_TICKER)) bullish[index] = false;
    for (const row of universe) {
      if (row.action !== "SELL" && row.action !== "REDUCE") continue;
      const trend = trendFor(row.symbol);
      if (trend === "BEAR_HOSTILE") bullish[row.symbol] = false;
      else skipped.push(row.symbol);
    }
  } else {
    for (const row of universe) {
      if (row.action === "BUY" || row.action === "ACCUMULATE") bullish[row.symbol] = true;
    }
  }
  return {
    downtrend,
    rule: downtrend ? "PUTS_ON_INDICES_AND_FALLING_SELL_REDUCE_IN_A_DOWNTREND" : "CALLS_ON_BUY_OR_ACCUMULATE_ONLY",
    bullish,
    indices: downtrend ? Object.keys(INDEX_TICKER) : [],
    stocks: Object.keys(bullish).filter((s) => !(s in INDEX_TICKER)),
    // SELL or REDUCE, but not in a downtrend of their own: no put.
    ratedDownNotFalling: skipped
  };
}

module.exports = { marketDirection, optionsView, ownTrend, lastCompletedSession, INDEX_TICKER, TEST };
