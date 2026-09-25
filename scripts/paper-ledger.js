"use strict";

/**
 * THE TRACK RECORD.
 *
 * Asked for, verbatim: "from the moment you have showed everything ...
 * hypothetical buy everything then you need to store how long does it take to
 * achieve the buy target to sell price hit ... you have told you will give me
 * expected time to hit the buy and sell price also it is achieved or not did we
 * make the profit or not so it will help you to audit you and the whole system
 * and help you to improve it over the time and I also can see the track whenever
 * I want."
 *
 * So: every level the desk FREEZES is a hypothetical order, placed at the moment
 * it was shown. From then on each build marks it against the market and records,
 * with timestamps, whether the buy limit filled and when, whether the target or
 * the stop came first and when, how that compares with what was predicted, and
 * what it made or lost. Nothing is ever edited after the fact; a trade only moves
 * forward through WAITING -> OPEN -> one of TARGET / STOP / EXPIRED / TIMED_OUT,
 * or WAITING -> UNFILLED.
 *
 * WHERE IT LIVES. The desk used to keep this in SQLite on a laptop, and the
 * machine that builds the desk now is destroyed after every run. So the record
 * lives in git, like the session ledger: docs/ledger/open.json for trades still
 * running, docs/ledger/closed-YYYY-MM.json for finished ones, committed on every
 * build. The commit history is the audit trail. A copy also goes to the Google
 * Sheet.
 *
 * EVERY AMBIGUITY IS RESOLVED AGAINST THE RECORD. A scheduled build sees the
 * market every twenty minutes, so the order of events inside a window is not
 * known. The rules below always pick the reading that makes the record WORSE:
 *
 *   - target and stop both touched in one window: it is a STOP;
 *   - the fill and a target in the same window: the target is not counted yet;
 *     the fill and a stop in the same window: the stop IS counted;
 *   - a gap down through the stop exits at the open, not at the stop;
 *   - a fill is always at the limit, never at a better price;
 *   - a fill or a target counts only when the price trades THROUGH the level; a
 *     print exactly at it is not proof of a fill (Global Trading Atlas, 32). A
 *     stop, the harsh side, still counts on a touch;
 *   - a price low from BEFORE the level was shown can never fill it -- the day's
 *     range is only counted from the moment the trade was recorded.
 *
 * A record built on generous assumptions can only mislead the one person it
 * exists to inform.
 */

const fs = require("node:fs");
const path = require("node:path");

const LEDGER_DIR = path.resolve(__dirname, "..", "docs", "ledger");
const IST_OFFSET_MS = 330 * 60_000;
const TRADING_DAYS = 252;
const SESSION_TRADING_HOURS = 6.25;          // 09:15 to 15:30
const FUTURES_MAX_SESSIONS = 20;             // the K2 continuous 20-session hold
const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
                 JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

function round(value, dp = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function istDate(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }
function sessionCloseMs(dateIso) { return Date.parse(`${dateIso}T15:30:00+05:30`); }
function hoursBetween(fromIso, toIso) { return round((Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000); }
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Angel's exchange clock, "23-Sep-2026 15:40:06" in IST, to the session it belongs to. */
function feedDate(text) {
  const m = String(text || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, "0")}` : null;
}

/** Angel's exchange clock as an instant: "23-Sep-2026 15:40:06" is IST. */
function feedMs(text) {
  const m = String(text || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  return Date.parse(`${m[3]}-${month}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}+05:30`);
}

// One implementation of the normal CDF in the codebase, not two that can drift.
const { normalCdf } = require("../api/_lib/trade-odds");
const { isNseHoliday } = require("../api/_lib/nse-holidays");

/**
 * How likely a price is to TOUCH a level within a window, and the median time
 * it takes when it does. Either direction.
 *
 * api/_lib/trade-odds.js timeToTarget() assumes the level is ABOVE the price.
 * A buy limit sits BELOW it, and for a martingale price the log-drift of
 * -sigma^2/2 points TOWARDS a lower barrier, so the drift term flips sign. Using
 * the upper-barrier form for a buy limit would understate the chance of a fill.
 *
 * Time is in TRADING days: realised volatility here is annualised over 252.
 */
function firstPassage({ from, to, sigma, tradingDays }) {
  const T = Number(tradingDays) / TRADING_DAYS;
  if (!(from > 0) || !(to > 0) || !(sigma > 0) || !(T > 0)) return null;
  const b = Math.abs(Math.log(to / from));
  if (b === 0) return { probabilityPct: 100, medianTradingDays: 0 };
  const mu = to > from ? -0.5 * sigma * sigma : 0.5 * sigma * sigma;
  const touchBy = (t) => {
    const rt = sigma * Math.sqrt(t);
    const p = normalCdf((-b + mu * t) / rt) + Math.exp((2 * mu * b) / (sigma * sigma)) * normalCdf((-b - mu * t) / rt);
    return Math.min(1, Math.max(0, p));
  };
  const touch = touchBy(T);
  let low = 1e-9, high = T;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (touchBy(mid) < touch / 2) low = mid; else high = mid;
  }
  return { probabilityPct: round(touch * 100, 1), medianTradingDays: round(high * TRADING_DAYS, 3) };
}

/** Trading days left in a session at a given moment, 0 after the close. */
function sessionTradingDaysLeft(now) {
  const left = (sessionCloseMs(istDate(now)) - now) / 3_600_000;
  return Math.max(0, Math.min(SESSION_TRADING_HOURS, left)) / SESSION_TRADING_HOURS;
}

/**
 * STOCK DERIVATIVES ARE PHYSICALLY SETTLED; INDEX ONES ARE NOT.
 *
 * An in-the-money stock option or a stock future still open at expiry becomes a
 * delivery of shares -- for a bought put, an obligation to DELIVER shares you
 * may not own -- and exchanges charge delivery margins from four trading days
 * before expiry, rising every day after (Zerodha, "policy on physical
 * settlement", verified 2026-09-23). Index contracts settle in cash and carry
 * none of it.
 *
 * So a stock trade is taken off at the close of the fourth weekday before
 * expiry: the last day it can be held without the delivery obligation starting.
 * Holidays are not in this count, which can only make the date EARLIER in
 * trading days, never later.
 */
const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"]);
function isIndexUnderlying(symbol) { return INDEX_UNDERLYINGS.has(String(symbol || "").toUpperCase()); }
/** A weekday that NSE's own calendar does not list as a holiday. */
function isTradingDate(iso) {
  const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6 && isNseHoliday(iso) !== true;
}

/** The first trading date strictly after `iso`. */
function nextTradingDate(iso) {
  let d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  do { d = new Date(d.getTime() + 86_400_000); } while (!isTradingDate(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}

// Counted in TRADING days: "if a trading holiday falls during the expiry week,
// the margin collection schedule will move up by one trading day" (Zerodha,
// policy on physical settlement, read 2026-09-25). Counting weekdays put the
// December 2026 exit on 23 Dec when 25 Dec is an NSE holiday and the delivery
// margin already starts on the 22nd.
function exitByDate(expiryIso, tradingDaysBefore = 4) {
  const iso = String(expiryIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  let d = new Date(`${iso}T00:00:00Z`);
  let counted = 0;
  while (counted < tradingDaysBefore) {
    d = new Date(d.getTime() - 86_400_000);
    if (isTradingDate(d.toISOString().slice(0, 10))) counted += 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Build a trade from a frozen level. Returns null when the level is not a
 * complete order -- a trade with no stop or no target cannot be scored.
 */
function tradeFromLevel({ kind, symbol, contract, expiry, strike = null, optionType = null, lotSize = null,
  buy, target, target2 = null, stop, sessionDate, shownAt, anchorSource, expected, priceBasis = null }) {
  if (!(buy > 0) || !(target > 0) || !(stop > 0) || !sessionDate || !shownAt) return null;
  return {
    id: `${sessionDate}|${kind}|${contract}`,
    kind, symbol, contract, expiry: expiry || null, strike, optionType, lotSize,
    sessionDate, shownAt,
    buy: round(buy), target: round(target), target2: target2 === null ? null : round(target2), stop: round(stop),
    anchorSource: anchorSource || null,
    // Which instrument the level was anchored to, and so which one marks it:
    // SHARE or CONTRACT for futures; null for options.
    priceBasis: priceBasis || null,
    expected: expected || null,
    status: "WAITING",
    filledAt: null, hoursToFill: null,
    closedAt: null, exitPrice: null, exitReason: null, hoursFillToExit: null,
    sessionsHeld: 0, best: null, worst: null,
    last: null, lastAt: null, marks: 0,
    obs: null,
    pnl: null
  };
}

function settlePnl(trade) {
  if (trade.exitPrice === null || trade.filledAt === null) return null;
  const perUnit = round(trade.exitPrice - trade.buy);
  const result = { perUnit, pct: round((perUnit / trade.buy) * 100), basis: "GROSS" };
  if (trade.kind !== "FUT" && trade.lotSize > 0) {
    result.perLot = round(perUnit * trade.lotSize);
    try {
      const { roundTripCost } = require("../api/_lib/trade-costs");
      const cost = trade.exitPrice > 0
        ? roundTripCost({ entryPremium: trade.buy, exitPremium: trade.exitPrice, lotSize: trade.lotSize })
        : null;
      // An option that expired worthless has no sell leg and no sell-side STT:
      // what was lost is the premium and the buy-side charges.
      result.netPerLot = cost ? round(cost.netProfit) : round(-trade.buy * trade.lotSize - 20);
      result.basis = "NET";
    } catch (error) {
      result.netPerLot = null;
    }
  }
  return result;
}

function close(trade, reason, price, atIso) {
  trade.status = reason;
  trade.exitReason = reason;
  trade.closedAt = atIso;
  trade.exitPrice = price === null || price === undefined ? null : round(price);
  if (trade.filledAt) trade.hoursFillToExit = hoursBetween(trade.filledAt, atIso);
  trade.pnl = settlePnl(trade);
}

/**
 * Mark one trade against one quote.
 *
 * `quote` is { ltp, high, low, open, exchangeFeedTime } from contractQuotes().
 * The window this mark covers is everything since the previous mark: new day
 * highs and lows since then, or where the price went between the two marks.
 */
function observe(trade, quote, now) {
  if (trade.status !== "WAITING" && trade.status !== "OPEN") return trade;
  const price = Number(quote?.ltp);
  if (!(price > 0)) return trade;
  // Never before the moment it was shown. The build opened the ledger a few
  // seconds before it froze the levels, so a trade shown and filled in the same
  // build was stamped filled 2.6-6.4 seconds BEFORE it existed -- 37 records on
  // 2026-09-24, found by the integrity check. Whatever clock a caller passes,
  // the audit trail cannot run backwards.
  const at = new Date(Math.max(Number(now), Date.parse(trade.shownAt) || 0)).toISOString();
  const date = feedDate(quote.exchangeFeedTime) || istDate(now);
  const dayHigh = Number(quote.high) > 0 ? Number(quote.high) : price;
  const dayLow = Number(quote.low) > 0 ? Number(quote.low) : price;
  const o = trade.obs;

  // A day order dies with its day. A quote from a later session must never
  // fill yesterday's limit.
  if (trade.status === "WAITING" && date > trade.sessionDate) {
    close(trade, "UNFILLED", null, new Date(sessionCloseMs(trade.sessionDate)).toISOString());
    return trade;
  }

  // A PRICE IS ONLY NEWS IF IT TRADED IN THIS SESSION.
  //
  // The feed's clock says when the quote was SENT, not when the contract last
  // TRADED. Measured on 2026-09-25: at 09:13, before options trade at all, the
  // quotes for 63 open option trades carried the PREVIOUS day's full open,
  // high and low under a today-dated feed stamp. The ledger read that as a new
  // session, replayed yesterday's range -- including lows from before the
  // trades were even shown -- and stopped BAJFINANCE 1000 PE at 10.15, a price
  // it never traded at that day (NSE: open 31.10, low 29.75). During the
  // session the same contracts send open/high/low of 0 and a last trade from
  // an earlier day, or the never-traded stamp 01-Jan-1970, until they trade.
  // So when the quote says when it last traded, a last trade before this
  // session means there is nothing new to mark. (The 1970 stamp sorts before
  // every real date, so it is skipped too.)
  if (quote.exchangeTradeTime !== undefined) {
    const tradedOn = feedDate(quote.exchangeTradeTime);
    if (!tradedOn || tradedOn < date) return trade;
  }

  let hi, lo, gapOpen = null;
  if (!o) {
    // First sight: nothing before this moment can count.
    hi = price; lo = price;
  } else if (o.date === date) {
    hi = dayHigh > o.high ? dayHigh : Math.max(o.last, price);
    lo = dayLow < o.low ? dayLow : Math.min(o.last, price);
  } else {
    // A new session since the last mark: the whole of today's range so far,
    // and wherever the price was left at the previous mark.
    hi = Math.max(dayHigh, o.last);
    lo = Math.min(dayLow, o.last);
    gapOpen = Number(quote.open) > 0 ? Number(quote.open) : null;
    if (trade.status === "OPEN") trade.sessionsHeld += 1;
  }
  trade.obs = {
    date,
    high: o && o.date === date ? Math.max(o.high, dayHigh) : dayHigh,
    low: o && o.date === date ? Math.min(o.low, dayLow) : dayLow,
    last: price
  };
  trade.last = round(price);
  trade.lastAt = at;
  trade.marks += 1;

  if (trade.status === "WAITING") {
    // THROUGH the limit, not merely touching it: "a simulated touch at a limit
    // price does not establish that an order had queue priority or sufficient
    // available volume" (Global Trading Atlas, 32). A touch counted as a fill
    // flattered the record every time the low printed exactly at the limit.
    if (lo < trade.buy) {
      trade.status = "OPEN";
      trade.filledAt = at;
      trade.hoursToFill = hoursBetween(trade.shownAt, at);
      trade.best = trade.buy;
      trade.worst = Math.min(trade.buy, lo);
      // Inside the fill window the order of events is unknown. A stop here is
      // counted, because it can only make the record worse; a target is not,
      // because it could only flatter it.
      if (lo <= trade.stop) close(trade, "STOP", gapOpen !== null && gapOpen < trade.stop ? gapOpen : trade.stop, at);
    }
    return trade;
  }

  // OPEN
  trade.best = Math.max(trade.best ?? trade.buy, hi);
  trade.worst = Math.min(trade.worst ?? trade.buy, lo);
  // The stop counts on a touch (the harsh reading); the target, like the buy,
  // only when the price trades THROUGH it -- a sell limit resting at the target
  // is not filled by one print at that price.
  const stopHit = lo <= trade.stop;
  const targetHit = hi > trade.target;
  if (stopHit) {
    // Both in one window is a stop. A gap through the stop exits at the open.
    close(trade, "STOP", gapOpen !== null && gapOpen < trade.stop ? gapOpen : trade.stop, at);
  } else if (targetHit) {
    close(trade, "TARGET", trade.target, at);
  }
  return trade;
}

/** Time-based endings, checked every build whether or not a quote came back. */
function settle(trade, now) {
  const at = new Date(now).toISOString();
  if (trade.status === "WAITING" && now >= sessionCloseMs(trade.sessionDate)) {
    close(trade, "UNFILLED", null, new Date(sessionCloseMs(trade.sessionDate)).toISOString());
  } else if (trade.status === "OPEN" && trade.expiry && !isIndexUnderlying(trade.symbol)
    && now >= sessionCloseMs(exitByDate(trade.expiry))) {
    close(trade, "TIME_EXIT", trade.last ?? trade.buy, new Date(sessionCloseMs(exitByDate(trade.expiry))).toISOString());
  } else if (trade.status === "OPEN" && trade.expiry && now >= sessionCloseMs(trade.expiry)) {
    close(trade, "EXPIRED", trade.last ?? 0, new Date(sessionCloseMs(trade.expiry)).toISOString());
  } else if (trade.status === "OPEN" && trade.kind === "FUT" && trade.sessionsHeld >= FUTURES_MAX_SESSIONS) {
    close(trade, "TIMED_OUT", trade.last ?? trade.buy, at);
  }
  return trade;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function closedFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^closed-\d{4}-\d{2}\.json$/.test(f)).sort(); }
  catch { return []; }
}

function openLedger({ dir = LEDGER_DIR, now = Date.now() } = {}) {
  const openFile = path.join(dir, "open.json");
  const open = readJson(openFile, { trades: [] }).trades || [];
  const monthKey = istDate(now).slice(0, 7);
  const closedThisMonth = readJson(path.join(dir, `closed-${monthKey}.json`), { trades: [] }).trades || [];
  const known = new Set([...open.map((t) => t.id), ...closedThisMonth.map((t) => t.id)]);
  const closedNow = [];
  const tally = { added: 0, marked: 0, closed: 0 };

  function add(trade, baselineQuote = null) {
    if (!trade || known.has(trade.id)) return false;
    known.add(trade.id);
    if (baselineQuote && Number(baselineQuote.ltp) > 0) {
      // The day's range up to NOW is the baseline: a low from before the level
      // was shown can never fill it.
      trade.obs = {
        date: feedDate(baselineQuote.exchangeFeedTime) || istDate(now),
        high: Number(baselineQuote.high) > 0 ? Number(baselineQuote.high) : Number(baselineQuote.ltp),
        low: Number(baselineQuote.low) > 0 ? Number(baselineQuote.low) : Number(baselineQuote.ltp),
        last: Number(baselineQuote.ltp)
      };
      trade.last = round(baselineQuote.ltp);
      trade.lastAt = new Date(now).toISOString();
    }
    open.push(trade);
    tally.added += 1;
    return true;
  }

  /** `quoteFor(trade)` returns a quote or null. Marks every running trade. */
  function markAll(quoteFor, markNow = now) {
    for (const trade of open) {
      const quote = quoteFor(trade);
      if (quote) { observe(trade, quote, markNow); tally.marked += 1; }
      settle(trade, markNow);
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].status !== "WAITING" && open[i].status !== "OPEN") {
        closedNow.push(open[i]);
        open.splice(i, 1);
        tally.closed += 1;
      }
    }
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(openFile, JSON.stringify({ updatedAt: new Date(now).toISOString(), trades: open }, null, 1));
    const byMonth = new Map();
    for (const trade of closedNow) {
      const key = String(trade.closedAt || new Date(now).toISOString()).slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(trade);
    }
    for (const [key, trades] of byMonth) {
      const file = path.join(dir, `closed-${key}.json`);
      const existing = readJson(file, { trades: [] }).trades || [];
      const ids = new Set(existing.map((t) => t.id));
      for (const trade of trades) if (!ids.has(trade.id)) existing.push(trade);
      fs.writeFileSync(file, JSON.stringify({ trades: existing }, null, 1));
    }
    return { open: open.length, closedNow: closedNow.length, months: [...byMonth.keys()] };
  }

  function allClosed() {
    const trades = [];
    for (const f of closedFiles(dir)) trades.push(...(readJson(path.join(dir, f), { trades: [] }).trades || []));
    const ids = new Set(trades.map((t) => t.id));
    for (const t of closedNow) if (!ids.has(t.id)) trades.push(t);
    return trades;
  }

  return { open, add, markAll, save, allClosed, tally, dir };
}

/**
 * The numbers the page shows, per kind and overall.
 *
 * Hit rate counts only trades that FILLED and then ended: an unfilled order is
 * not a loss and not a win, and counting it either way would be invented. The
 * expected-versus-actual rows are the calibration: if the desk says 60% and 30%
 * happen, the desk is wrong, and this is where that shows.
 */
function summarize(open, closed) {
  const kinds = ["ALL", "FUT", "CE", "PE"];
  const out = {};
  for (const kind of kinds) {
    const pick = (t) => kind === "ALL" || t.kind === kind;
    const o = open.filter(pick);
    const c = closed.filter(pick);
    const filledClosed = c.filter((t) => t.filledAt);
    const wins = c.filter((t) => t.status === "TARGET");
    const resolved = filledClosed.length;
    const expectedTarget = filledClosed.map((t) => Number(t.expected?.target?.probabilityPct)).filter(Number.isFinite);
    const pnl = filledClosed.map((t) => t.pnl?.pct).filter(Number.isFinite);
    const net = filledClosed.map((t) => t.pnl?.netPerLot).filter(Number.isFinite);
    out[kind] = {
      shown: o.length + c.length,
      waiting: o.filter((t) => t.status === "WAITING").length,
      open: o.filter((t) => t.status === "OPEN").length,
      target: wins.length,
      stop: c.filter((t) => t.status === "STOP").length,
      expired: c.filter((t) => t.status === "EXPIRED" || t.status === "TIMED_OUT" || t.status === "TIME_EXIT").length,
      unfilled: c.filter((t) => t.status === "UNFILLED").length,
      hitRatePct: resolved ? round((wins.length / resolved) * 100, 1) : null,
      resolved,
      // SEPARATE BETS, not trades: seven strikes of one stock shown on one day
      // win or lose together, so they are one result, not seven. The page
      // judges a hit rate on this count.
      resolvedBets: new Set(filledClosed.map((t) => `${t.sessionDate}|${t.symbol}|${t.kind}`)).size,
      expectedHitRatePct: expectedTarget.length ? round(expectedTarget.reduce((a, b) => a + b, 0) / expectedTarget.length, 1) : null,
      medianHoursToFill: round(median([...o, ...c].map((t) => t.hoursToFill).filter((h) => h !== null)), 1),
      medianHoursToTarget: round(median(wins.map((t) => t.hoursFillToExit)), 1),
      avgReturnPct: pnl.length ? round(pnl.reduce((a, b) => a + b, 0) / pnl.length, 2) : null,
      totalNetPerLot: net.length ? round(net.reduce((a, b) => a + b, 0)) : null
    };
  }
  return out;
}

module.exports = {
  LEDGER_DIR, FUTURES_MAX_SESSIONS,
  feedDate, feedMs, firstPassage, sessionTradingDaysLeft, exitByDate, isIndexUnderlying, isTradingDate, nextTradingDate, sessionCloseMs,
  tradeFromLevel, observe, settle, openLedger, summarize
};
