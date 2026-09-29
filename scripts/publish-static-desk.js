"use strict";

/**
 * THE DESK WITHOUT A SERVER.
 *
 * Everything that has gone wrong with hosting this comes from one assumption:
 * that a trading desk needs a machine running all day. It does not. The work is
 * a few seconds of computation on a settlement file and a live option chain, and
 * the output is a list of prices. A list of prices is a FILE.
 *
 * So this produces the file, on a schedule, on a machine that is destroyed
 * afterwards. There is no uptime to lose, no 512 MB ceiling, no fifteen-minute
 * sleep, no monthly hour cap and no laptop that has to stay open in a dark
 * house.
 *
 * WHAT IT WRITES:
 *   docs/levels.json  the session ledger: the buy limit, target and stop for
 *                     every contract, FROZEN the first time that contract
 *                     qualified today and never recomputed after. See
 *                     scripts/session-freeze.js for why this is the load-
 *                     bearing file and not an implementation detail.
 *   docs/data.json    the whole snapshot as data, for the Google Sheet and for
 *                     anything else that wants to read it.
 *   docs/index.html   one self-contained page, readable on a phone.
 *
 * WHAT IT DOES NOT DO: pretend the numbers are live when they are not. Every
 * page says when it was built and where each price came from, because a
 * scheduled job is by definition a snapshot, and a snapshot presented as a live
 * quote is the defect this project spent a week removing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { openSession, driftPct, istStamp, numeric, sessionDateFor } = require("./session-freeze");
const { toTick } = require("../api/_lib/session-levels");

const OUT_DIR = path.resolve(__dirname, "..", "docs");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function money(value) {
  // A missing amount is a dash, never "₹0" (Number(null) is 0), and a loss is
  // written "−₹3,725.8" as everywhere else on the page, not "₹-3,725.8".
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return (n < 0 ? "−₹" : "₹") + Math.abs(n).toLocaleString("en-IN");
}
/**
 * EVERY BODY CELL CARRIES ITS COLUMN'S NAME (data-label), taken from the
 * table's own header, so the phone layout can print it above the value. Done
 * once over the finished page, so no table can be missed.
 */
function labelCells(html) {
  return html.replace(/<table([^>]*)>([\s\S]*?)<\/table>/g, (whole, attrs, inner) => {
    const head = (inner.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "";
    const labels = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/"/g, "&quot;").trim());
    if (!labels.length) return whole;
    const body = inner.replace(/<tr([^>]*)>([\s\S]*?)<\/tr>/g, (tr, trAttrs, cells) => {
      if (/<th[\s>]/.test(cells)) return tr;
      let i = 0;
      return `<tr${trAttrs}>` + cells.replace(/<td(?![^>]*colspan)([^>]*)>/g, (td, tdAttrs) => `<td data-label="${labels[i++] || ""}"${tdAttrs}>`) + "</tr>";
    });
    return `<table${attrs}>${body}</table>`;
  });
}

// AN ORDER PRICE, WITH ITS PAISE: "385.50", as the broker shows it, not "385.5";
// "4.00", not "4". Amounts of money keep money().
function px(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return (n < 0 ? "−₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// A PERCENTAGE WITH A REAL MINUS SIGN, as the rupee amounts have: "−1.5%",
// not "-1.5%" (twelve hyphens on the live page, 28 Sep); "+" when it rose.
function signedPct(value) {
  const n = numeric(value);
  if (n === null) return "—";
  return `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n)}%`;
}
// "The market was weekend" read as broken English on the page (27 Sep).
const PHASE_WORDS = { OPEN: "open", PRE_OPEN: "in its pre-open", CLOSED: "closed", WEEKEND: "closed for the weekend", POST_CLOSE: "closed", HOLIDAY: "closed for a holiday" };
function phaseWords(phase) {
  return PHASE_WORDS[String(phase || "").toUpperCase()] || String(phase || "in an unknown state").toLowerCase().replace(/_/g, " ");
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function round(value, dp = 2) {
  const n = numeric(value);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * THE CONTRACT, NAMED THE WAY THE BROKER LISTS IT.
 *
 * Searching "TATA POWER 380 PE" in the broker app returns three contracts --
 * SEP, OCT and NOV -- and the page's headline said only "TATAPOWER 380 PE",
 * with the month buried in a small code underneath. So the headline is now the
 * broker's own search text ("TATAPOWER OCT 380 PE"), with both brokers'
 * symbols, the weekday it expires, and -- for a stock contract -- the day to
 * be out by, because stock derivatives are physically settled.
 *
 * The Zerodha symbol comes from fno-reference's expiryTradingSuffix, which
 * knows monthly from weekly by the exchange's own calendar. The page used to
 * build every option symbol in MONTHLY form, which names the wrong contract
 * for any weekly index option.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function contractNames(symbol, expiry, strike, right, reference) {
  const { expiryTradingSuffix, angelTradingSymbol } = require("../api/_lib/fno-reference");
  const { exitByDate, isIndexUnderlying } = require("./paper-ledger");
  const iso = String(expiry || "").slice(0, 10);
  // A watched name with no NSE futures contract has no expiry at all: it is the
  // share, and is named as the share. Formatting a missing date is what crashed
  // the first build with the 288 watch list.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return {
      display: `${symbol} (share)`, zerodha: symbol, angel: `${symbol}-EQ`,
      expiryText: null, exitBy: null, exitByText: null
    };
  }
  const suffix = expiryTradingSuffix(iso, reference?.symbols?.[symbol]?.expiryList || []) || "";
  const monthly = /^\d{2}[A-Z]{3}$/.test(suffix);
  const d = new Date(`${iso}T00:00:00Z`);
  const mon = MONTHS[d.getUTCMonth()];
  const isFut = !right;
  const strikeText = isFut ? "" : String(Number(strike));
  const when = monthly ? mon : `${d.getUTCDate()} ${mon} (weekly)`;
  const pretty = (x) => {
    const y = new Date(`${x}T00:00:00Z`);
    const m = MONTHS[y.getUTCMonth()];
    return `${WEEKDAYS[y.getUTCDay()]} ${y.getUTCDate()} ${m.charAt(0)}${m.slice(1).toLowerCase()}`;
  };
  const exitBy = isIndexUnderlying(symbol) ? null : exitByDate(iso);
  return {
    display: isFut ? `${symbol} ${when} FUT` : `${symbol} ${when} ${strikeText} ${right}`,
    zerodha: isFut ? `${symbol}${suffix}FUT` : `${symbol}${suffix}${strikeText}${right}`,
    angel: isFut ? angelTradingSymbol(symbol, iso) : angelTradingSymbol(symbol, iso, strike, right),
    expiryText: pretty(iso),
    exitBy,
    exitByText: exitBy ? pretty(exitBy) : null
  };
}

/**
 * Where the live price sits relative to the limit that was frozen this morning.
 *
 * This is the column that was missing. A frozen limit is only half an answer:
 * the other half is whether the market has come to it, and saying so in one
 * word is the difference between a list of prices and an instruction.
 */
/**
 * A level that is not frozen is not an order, so it is never "waiting" for a
 * fill: it is a preview, placed this far under the price it was worked from.
 */
function previewState(limit, now) {
  const l = numeric(limit);
  const p = numeric(now);
  if (l === null || p === null || l <= 0) return { word: "NO PRICE", tone: "" };
  const under = ((p - l) / p) * 100;
  return { word: under > 0 ? `PREVIEW, not an order — ${under.toFixed(1)}% under the last price` : "PREVIEW, not an order", tone: "" };
}

function fillState(limit, now) {
  const l = numeric(limit);
  const p = numeric(now);
  // numeric(), not Number(): a contract with no quote must not be reported as
  // sitting far below your limit, which is what Number(null) === 0 produces.
  if (l === null || p === null || l <= 0) return { word: "NO PRICE", tone: "" };
  const gap = ((p - l) / l) * 100;
  // A BUY limit fills only when the price comes DOWN to it. The first version
  // called anything within 1% "AT THE LIMIT" -- and every futures row sits 0.8%
  // above its limit at the moment it is set, by design, because the limit is
  // placed under the price to catch a dip. So every futures row read as
  // fillable when not one of them was. Within a tick or two is "at the limit";
  // anything more is waiting, and says how far the price has to fall.
  if (gap <= 0) return { word: "AT OR BELOW LIMIT", tone: "up" };
  if (gap <= 0.1) return { word: "AT THE LIMIT", tone: "up" };
  const dip = ((p - l) / p) * 100;
  return { word: `WAITING — needs a ${dip.toFixed(1)}% dip`, tone: dip > 5 ? "down" : "" };
}

// NO CAP ON ROWS. Every contract that clears every gate is shown. Until
// 2026-09-25 the page kept the top 40 options and 25 futures and hid the rest
// -- 122 of 162 calls that had cleared every gate, beside a header saying 162
// had. The user: "if it is passing all of this then it is a good one ... why
// we have to force it to cut down". A limit can still be passed for tests.
async function build({ limit = Infinity, futuresLimit = Infinity, ledgerFile, ledgerDir, forceFreeze = null, riskHistoryFor = null, riskActions = undefined } = {}) {
  const { fnoUniverseEngine } = require("../api/_lib/universe-210");
  const { screenContracts } = require("../api/_lib/contract-screener");
  const { roundTripCost } = require("../api/_lib/trade-costs");
  const { timeToTarget } = require("../api/_lib/trade-odds");
  const GM_MIN_UNITS = Number(process.env.K2_GM_MIN_UNITS) > 0 ? Number(process.env.K2_GM_MIN_UNITS) : 20;
  const { loadReference } = require("../api/_lib/fno-reference");
  const live = require("../api/_lib/live-quotes");

  // India VIX from NSE, read by prepare-static-build.js (null if unread).
  const marketContext = require("../api/_lib/nse-market-context").loadMarketContext();
  const macro = { severity: "NORMAL", shieldActive: false,
    indiaVix: marketContext ? { price: marketContext.indiaVix, source: "NSE allIndices", at: marketContext.nseTimestamp } : null };
  const reference = loadReference();
  const phase = live.marketPhase();

  const universe = fnoUniverseEngine.getUniverse(macro) || [];
  const scores = {};
  for (const row of universe) {
    if (numeric(row.compositeScore) !== null) scores[row.symbol] = numeric(row.compositeScore);
  }

  // ONE SIDE PER STOCK, AND ONLY THE SIDE THE DESK HAS A VIEW ON. The user,
  // 2026-09-25: "buying a bull or buying a bear does not matter -- I want to
  // earn money". The options list used to rank calls and puts on the same names
  // by cheapness alone (9 of 18 stocks carried both that morning; 7 were the
  // same strike), so the two sides cancelled -- on 24 Sep calls lost 13.8% while
  // puts made 14.4%. The desk's view is long-only: BUY or ACCUMULATE. It has no
  // bearish verdict, and its own measured short side lost money in all 24
  // geometries in all three splits (PANEL_STUDY_ROUND3.txt: "a measured,
  // reliably NEGATIVE expectancy" -- betting on falls in a market with positive
  // drift). So: calls on the names it rates a buy, no puts, nothing on the rest.
  const sectorOf = new Map(universe.map((r) => [r.symbol, r.sector || null]));
  const bullish = {};
  for (const row of universe) {
    if (row.action === "BUY" || row.action === "ACCUMULATE") bullish[row.symbol] = true;
  }

  /**
   * THE FORWARD HAS TO BE AS LIVE AS THE PREMIUM.
   *
   * The screener solves implied volatility, delta and the odds of reaching the
   * target from the option's price AND the forward it is priced against. The
   * price was live; the forward was the settlement file's, i.e. yesterday's. On
   * a quiet day that error is small. On 4 June 2024 NIFTY fell 5.9% -- priced
   * against yesterday's forward, every put's jump would have been booked as a
   * volatility spike, and every delta and probability on the page with it.
   *
   * So every futures contract the screener could use is priced live first. An
   * expiry with no future of its own (an index weekly) is moved by the same
   * ratio its monthly future moved since the settlement.
   */
  const brokersForForward = require("../api/_lib/broker-feed");
  // SAME MOMENT ON BOTH SIDES. The live forward is only right against a live
  // premium, and premiums are live only while the session is open (the
  // screener refuses settled prices in session). After the close the premium is
  // the settlement file's, so the forward must be too: solving a settlement
  // premium against a 15:40 futures print moved TATAPOWER OCT 380 PE from 15.6%
  // to 16.9% implied vol on 2026-09-23 -- the same defect as before, smaller.
  // And only the expiries the screener can use (7 to 60 days), which is what
  // keeps this inside Angel's one-request-a-second /quote limit.
  const forwardRequests = [];
  if (phase.open === true) {
    for (const [symbol, entry] of Object.entries(reference?.symbols || {})) {
      for (const expiry of Object.keys(entry.expiries || {})) {
        const days = (Date.parse(`${expiry}T15:30:00+05:30`) - Date.now()) / 86400000;
        if (days >= 7 && days <= 60) forwardRequests.push({ kind: "FUT", symbol, expiry });
      }
    }
  }
  let forwardQuotes = {};
  let forwardStatus = null;
  try {
    const r = await brokersForForward.contractQuotes(forwardRequests);
    forwardQuotes = r.quotes || {};
    forwardStatus = { requested: r.requested, resolved: r.resolved, priced: Object.keys(forwardQuotes).length, reason: r.reason || null };
  } catch (error) {
    forwardStatus = { requested: forwardRequests.length, priced: 0, reason: error.message };
  }
  const forwardFor = (symbol, expiry, settled) => {
    const own = forwardQuotes[`${symbol}|${expiry}`];
    if (own && own.ltp > 0) return own.ltp;
    // No future for this expiry: move the settled forward by what the nearest
    // live future of the same name did since its own settlement.
    const entry = reference?.symbols?.[symbol];
    for (const [exp, bucket] of Object.entries(entry?.expiries || {}).sort()) {
      const q = forwardQuotes[`${symbol}|${exp}`];
      const settledThere = Number(bucket.futuresPrice);
      if (q && q.ltp > 0 && settledThere > 0 && settled > 0) return settled * (q.ltp / settledThere);
    }
    return null;
  };
  const bannedSet = fnoUniverseEngine.banned instanceof Set ? fnoUniverseEngine.banned : new Set();

  // RESULTS DATES from NSE's filings (api/_lib/nse-results.js). null = the
  // calendar could not be read today, and every row then says "unknown".
  const { loadResultsCalendar, resultsStatus } = require("../api/_lib/nse-results");
  const resultsCal = loadResultsCalendar();
  const resultsFor = (symbol) => resultsStatus(resultsCal, symbol);
  const ledgerDates = require("./paper-ledger");
  const exitByFor = (symbol, expiry) => (ledgerDates.isIndexUnderlying(symbol) ? expiry : ledgerDates.exitByDate(expiry));
  const screen = screenContracts({
    reference, underlyingScores: scores, limit, bullish, requireView: true, resultsFor, exitByFor,
    liveQuoteFor: (s, e, k, t) => { try { return live.liveQuote(s, e, k, t); } catch (err) { return null; } },
    marketOpen: phase.open === true,
    banned: bannedSet,
    forwardFor
  });

  /**
   * ONE QUOTE CALL FOR EVERYTHING THAT NEEDS A PRICE.
   *
   * Three things need live prices, and they are fetched together: the futures
   * that are about to be anchored, the options that are about to be frozen
   * (their day range is the paper ledger's starting line), and every trade the
   * ledger is still tracking -- including ones that have since dropped off
   * today's shortlist, which nothing else on this page would ever price again.
   */
  const { tradableExpiry } = require("../api/_lib/fno-reference");
  const brokers = require("../api/_lib/broker-feed");
  const ledgerLib = require("./paper-ledger");
  /**
   * FUTURES: YOUR 288.
   *
   * "This 288 you need to watch." The engine now watches the 285 stocks of
   * NSE_FO_Symbols_Auto_Update.xlsm (data/watchlist.json) and every one of them
   * can reach the futures tab. 207 still have an NSE futures contract; 78 were
   * removed from F&O and exist only as shares; a few are symbols NSE no longer
   * lists at all -- mergers, renames, a typo -- and are named on the page.
   */
  const watchFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "data", "watchlist.json"), "utf8")); }
    catch { return null; }
  })();
  const priced = (r) => r.priceSource === "NSE_YAHOO_BARS" && r.hasObservedPrice !== false;
  const watchStatus = watchFile ? {
    source: watchFile.source,
    stocks: universe.length,
    withFutures: universe.filter((r) => r.fnoListed).length,
    shareOnly: universe.filter((r) => !r.fnoListed && priced(r)).length,
    notListed: universe.filter((r) => !r.fnoListed && !priced(r)).map((r) => r.symbol).sort(),
    rows: fnoUniverseEngine.watchRows ?? null,
    renamed: fnoUniverseEngine.watchRenames || [],
    unlistedOnNse: fnoUniverseEngine.watchUnlisted ?? null,
    symbolsAsOf: fnoUniverseEngine.watchSymbolsAsOf || null,
    indices: (watchFile.indices || []).map((x) => x.symbol)
  } : null;
  const futuresPicked = universe
    .filter((r) => (r.action === "BUY" || r.action === "ACCUMULATE") && r.perUnit)
    .sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0))
    .slice(0, futuresLimit)
    .map((r) => ({ row: r, expiry: tradableExpiry(r.symbol, { minDays: 7, reference })?.expiry || null }));

  let ledger = null;
  let ledgerError = null;
  try { ledger = ledgerLib.openLedger(ledgerDir ? { dir: ledgerDir } : {}); }
  catch (error) { ledgerError = error.message; }

  // A futures trade is marked on the instrument its level was anchored to: the
  // share (priceBasis SHARE) or the NSE contract.
  const asRequest = (t) => (t.kind === "FUT" && t.priceBasis === "SHARE"
    ? { kind: "EQ", symbol: t.symbol }
    : { kind: t.kind === "FUT" ? "FUT" : "OPT", symbol: t.symbol, expiry: t.expiry, strike: t.strike, optionType: t.optionType });
  let quotes = {};
  let quoteStatus = null;
  try {
    const result = await brokers.contractQuotes([
      // Futures already priced for the forwards are not asked for twice.
      ...futuresPicked.map((f) => ({ kind: "EQ", symbol: f.row.symbol })),
      ...futuresPicked.filter((f) => f.row.fnoListed && f.expiry && !forwardQuotes[`${f.row.symbol}|${f.expiry}`])
        .map((f) => ({ kind: "FUT", symbol: f.row.symbol, expiry: f.expiry })),
      ...(screen.contracts || []).map((c) => ({ kind: "OPT", symbol: c.symbol, expiry: c.expiry, strike: c.strike, optionType: c.optionType })),
      ...(ledger ? ledger.open.map(asRequest) : [])
    ]);
    quotes = { ...forwardQuotes, ...(result.quotes || {}) };
    quoteStatus = { ok: result.ok, reason: result.reason || null, requested: result.requested,
      resolved: result.resolved, priced: Object.keys(quotes).length, failures: result.failures || [],
      // The newest exchange print among every quote this build received. On an
      // NSE holiday it is a previous session's date -- which is how the health
      // gate tells a shut exchange from a broken feed without a holiday table.
      // The newest TRADE, not the feed's clock. Angel One re-stamps its feed
      // the morning after a session (measured 2026-09-27: every quote stamped
      // "26-Sep-2026 06:55", a Saturday, last trade 25-Sep 15:39), so the feed
      // clock named a Saturday as the last session -- and on a weekday holiday
      // would name the holiday itself, turning the health gate red for a shut
      // exchange. The 1970 never-traded stamp sorts first and is never the max.
      lastExchangeDate: Object.values(quotes).map((q) => ledgerLib.feedDate(q?.exchangeTradeTime || q?.exchangeFeedTime))
        .filter((day) => day && day > "1971").sort().pop() || null };
  } catch (error) {
    quotes = { ...forwardQuotes };
    quoteStatus = { ok: false, reason: error.message };
  }
  const quoteFor = (x) => quotes[brokers.contractKey(x)] || null;

  /**
   * A LEVEL IS ONLY FROZEN AGAINST A PRICE THAT TRADED.
   *
   * The clock is not enough evidence. marketPhase() knows weekends and the
   * session hours and nothing else -- it has no NSE holiday calendar -- so on a
   * trading holiday a 09:33 run sees a weekday inside the window, reports OPEN,
   * and would freeze the whole day against yesterday's settlement file. Which
   * is exactly what the do-not-freeze-before-the-bell rule exists to prevent,
   * arriving through a door that rule does not cover.
   *
   * So the gate is evidence, not inference: freeze only once the exchange has
   * actually priced something live. That single condition covers the holiday,
   * the broker login being absent, and the feed being down -- all of which look
   * identical from the clock and identical to each other.
   */
  const sawLiveBook = Number(screen.pricedLive) > 0;
  const canFreeze = forceFreeze === null ? (phase.open === true && sawLiveBook) : forceFreeze === true;
  const sessionDateNow = sessionDateFor(Date.now());
  const sessionOver = Date.now() >= ledgerLib.sessionCloseMs(sessionDateNow);
  const nextSession = sessionOver || !ledgerLib.isTradingDate(sessionDateNow) ? ledgerLib.nextTradingDate(sessionDateNow) : sessionDateNow;
  const session = openSession({ canFreeze, sessionOver, file: ledgerFile });

  // Each stock's strikes together, stocks in the order of their best contract:
  // several strikes of one stock are ONE bet, and the page should read so.
  const stockRank = new Map();
  for (const c of screen.contracts || []) if (!stockRank.has(c.symbol)) stockRank.set(c.symbol, stockRank.size);
  const byStock = (screen.contracts || []).map((c, i) => ({ c, i }))
    .sort((a, b) => stockRank.get(a.c.symbol) - stockRank.get(b.c.symbol) || a.i - b.i).map((x) => x.c);

  const options = byStock.map((c) => {
    const names = contractNames(c.symbol, c.expiry, c.strike, c.optionType, reference);
    const zerodha = names.zerodha;
    const nowPrice = round(c.premium);
    const levels = session.level("options", zerodha, () => {
      if (!Number.isFinite(Number(c.premium)) || Number(c.premium) <= 0) return null;
      // On the contract's own tick, or Zerodha refuses the order. Unknown tick:
      // 0.05, which is also a valid price where the tick is 0.01.
      const tick = brokers.tickSizeFor({ kind: "OPT", symbol: c.symbol, expiry: c.expiry, strike: c.strike, optionType: c.optionType }) || 0.05;
      const buy = toTick(c.premium, tick, "down");
      return {
        buy,
        sell: toTick(Number(c.targetPremium) * (buy / Number(c.premium)), tick, "nearest"),
        stop: toTick(buy / 2, tick, "nearest"),
        tick,
        lotSize: c.lotSize,
        expiry: c.expiry,
        strike: c.strike,
        right: c.optionType,
        symbol: c.symbol,
        priceSourceAtFreeze: c.priceSource
      };
    });
    if (!levels) return null;
    return {
      symbol: c.symbol, strike: c.strike, right: c.optionType, expiry: c.expiry, zerodha,
      display: names.display, angel: names.angel, expiryText: names.expiryText,
      exitBy: names.exitBy, exitByText: names.exitByText,
      buy: levels.buy, sell: levels.sell, stop: levels.stop, tick: levels.tick ?? null,
      now: nowPrice, drift: driftPct(levels.buy, nowPrice),
      frozen: levels.frozen, frozenAtIst: levels.frozenAtIst, frozenAt: levels.frozenAt || null,
      priceSourceAtFreeze: levels.priceSourceAtFreeze || null,
      // THE MONEY ON A ROW COMES FROM THAT ROW'S OWN LEVELS. These used to be
      // the screener's figures at the CURRENT premium while buy, sell and stop
      // were the FROZEN ones -- ASTRAL OCT 1400 CE read "41.53 x 425 = 16,745"
      // on 25 Sep, which is 425 x the live 39.40; at 41.53 it costs 17,650. Two
      // prices on one row, which the user has called out before.
      ...(() => {
        const lot = Number(levels.lotSize || c.lotSize) || null;
        // numeric(), not Number(): with no live book the screener's spread is
        // null, and Number(null) is 0 -- which made every after-hours row a
        // "known" 0% spread (154 of 154 on 25 Sep, 18:24) and understated its
        // costs (SUNPHARMA 1860 CE: -77 a lot, charges only).
        const spread = numeric(c.spreadPct);
        const atTarget = lot ? roundTripCost({ entryPremium: levels.buy, exitPremium: levels.sell, lotSize: lot, entrySpreadPct: spread }) : null;
        const atStop = lot ? roundTripCost({ entryPremium: levels.buy, exitPremium: levels.stop, lotSize: lot, entrySpreadPct: spread }) : null;
        return {
          lotSize: lot, costPerLot: lot ? round(levels.buy * lot) : null,
          netProfit: atTarget?.netProfit ?? null, netLossAtStop: atStop?.netProfit ?? null,
          breakEvenPct: atTarget?.netProfit > 0 && atStop?.netProfit < 0
            ? round(100 * Math.abs(atStop.netProfit) / (atTarget.netProfit + Math.abs(atStop.netProfit)), 1) : null,
          // WITH NO TREND, roughly: a fairly priced premium is close to a fair
          // game, so the target (+50%) and the stop (-50%) come first about
          // equally often and what is left is the charges. Rough: it ignores
          // discounting and moves in implied volatility.
          noTrendNet: atTarget && atStop ? -round((atTarget.totalCost + atStop.totalCost) / 2) : null,
          // Without a live book the bid-ask spread is unknown and not in any
          // net figure here (after the close it was -77 a lot on SUNPHARMA 1860
          // CE, charges only). Say so rather than let it read as the whole cost.
          spreadKnown: atTarget ? atTarget.spreadKnown === true : null,
          sector: sectorOf.get(c.symbol) || null,
          costPct: atTarget?.costAsPctOfGross ?? null
        };
      })(),
      iv: c.impliedVol, rv: c.realisedVol, vrp: c.varianceRiskPremium,
      // P(TOUCH) FOR THE SELL PRICE ON THIS ROW. The screener's figure is for 1.5x
      // the CURRENT premium; once a level is frozen and the premium moves, that
      // is a different target -- on 25 Sep 31 of 38 carried rows showed the odds
      // of reaching a price nobody was shown. Recomputed every build: the live
      // forward reaching strike +/- the frozen sell, on measured volatility.
      ...(() => {
        const level = c.optionType === "CE" ? c.strike + levels.sell : c.strike - levels.sell;
        const vol = Number(c.realisedVol) / 100;
        const t = Number(c.forward) > 0 && vol > 0 && level > 0
          ? timeToTarget({ spot: Number(c.forward), target: level, volatility: vol, daysAvailable: Number(c.daysToExpiry) })
          : null;
        // DECAY for the same trade: theta per day (recovered from the screener's
        // own figure) times the days to THIS sell, as a share of THIS buy.
        const screenerWait = Number(c.medianDaysToTarget) > 0 ? Number(c.medianDaysToTarget) : Number(c.daysToExpiry);
        const thetaPerDay = numeric(c.thetaBurnPct) !== null && Number(c.premium) > 0 && screenerWait > 0
          ? (numeric(c.thetaBurnPct) / 100) * Number(c.premium) / screenerWait : null;
        const wait = t && t.medianDaysIfItHappens > 0 ? t.medianDaysIfItHappens : Number(c.daysToExpiry);
        return {
          touchPct: t ? round(t.probabilityOfTouchPct, 1) : null,
          daysToTarget: t ? round(t.medianDaysIfItHappens, 1) : null,
          thetaBurnPct: thetaPerDay !== null && levels.buy > 0 && wait > 0 ? round((100 * thetaPerDay * wait) / levels.buy, 2) : null
        };
      })(), daysLeft: c.daysToExpiry,
      term: c.termShape, skew: c.skewPoints,
      priceSource: c.priceSource, priceIsLive: c.priceIsLive, score: c.screenScore,
      forward: c.forward ?? null, forwardSource: c.forwardSource || null,
      resultsStatus: c.resultsStatus || null, resultsDate: c.resultsDate || null
    };
  }).filter(Boolean);

  /**
   * WHICH PRICE A FUTURES LEVEL IS ANCHORED TO.
   *
   * CONTRACT (the default since 2026-09-25): the NSE futures contract. The
   * platform the user trades futures on (GM Global) quotes EXACTLY the NSE
   * futures price -- measured against NSE's own 24-Sep files, 6 names of 6 to
   * the paisa, change column included: LT 3,859.80 = NSE September future
   * 3,859.80 (share 3,858.40); BOSCHLTD 47,960 = future 47,960 (share 47,750);
   * LTF 279.90 = future 279.90 (share 282.00). The share is off the platform by
   * the basis, which ran from -1.1% to +1.0% for October that day -- the size
   * of the whole entry discount.
   *
   * SHARE (K2_FUTURES_ANCHOR=SHARE): the live NSE share price, the basis before
   * that measurement, and still the only price for the watched names NSE
   * removed from F&O, which have no contract and stay on the share either way.
   *
   * Either way the other price is printed on the row, so the two can be
   * compared against the broker's own screen. A level is frozen only on a quote
   * that is live and fresh (exchange stamp under ten minutes old): during a
   * circuit-breaker halt the last print freezes while the clock runs.
   */
  const ANCHOR = String(process.env.K2_FUTURES_ANCHOR || "CONTRACT").toUpperCase() === "SHARE" ? "SHARE" : "CONTRACT";
  const { ENTRY_DISCOUNT, TARGET_1, TARGET_2, STOP } = require("../api/_lib/session-levels");
  const isFresh = (q) => {
    if (!q) return false;
    const at = ledgerLib.feedMs(q.exchangeFeedTime);
    return phase.open === true && ledgerLib.feedDate(q.exchangeFeedTime) === session.sessionDate
      && at !== null && Date.now() - at <= 10 * 60_000;
  };
  const futures = futuresPicked.map(({ row: r, expiry }) => {
    const sq = quoteFor({ kind: "EQ", symbol: r.symbol });
    const fq = r.fnoListed && expiry ? quoteFor({ kind: "FUT", symbol: r.symbol, expiry }) : null;
    // What a quote says on the row: its price, where it came from, when, and
    // the OTHER instrument's price beside it for comparison.
    const view = (q) => {
      const live = isFresh(q);
      return {
        live,
        price: round(q ? q.ltp : r.spotPrice),
        source: q ? (q === fq ? "FUTURES" : "SHARE") + "_" + (live ? "LIVE" : "LAST_TRADED") : "SHARE_CLOSE_FROM_HISTORY",
        // When it last TRADED ("NOT live at 06:55" on a Sunday was the feed's
        // re-stamp, not a trade), with its day when that is not today.
        atText: (() => {
          const stamp = q?.exchangeTradeTime || q?.exchangeFeedTime;
          const day = stamp ? ledgerLib.feedDate(stamp) : null;
          if (!day || day < "1971") return null;
          const hhmm = String(stamp).slice(12, 17);
          if (day === session.sessionDate) return hhmm;
          return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) + " " + hhmm;
        })(),
        referencePrice: q === fq ? (sq ? round(sq.ltp) : null) : (fq ? round(fq.ltp) : null),
        referenceKind: q === fq ? "share" : (fq ? "future" : null)
      };
    };
    const anchorQuote = ANCHOR === "CONTRACT" && fq ? fq : sq;
    const anchorView = view(anchorQuote);
    const liveNow = anchorView.live;
    const nowPrice = anchorView.price;
    const nowSource = anchorView.source;
    const sigma = Number(r.odds?.realizedVolPct) > 0 ? Number(r.odds.realizedVolPct) / 100 : null;
    const levels = session.level("futures", r.symbol, () => {
      if (!(nowPrice > 0)) return null;
      // On the anchor instrument's own tick (0.01 to 5.00 for stock futures).
      const tick = (anchorQuote === fq
        ? brokers.tickSizeFor({ kind: "FUT", symbol: r.symbol, expiry })
        : brokers.tickSizeFor({ kind: "EQ", symbol: r.symbol })) || 0.05;
      const buy = toTick(nowPrice * ENTRY_DISCOUNT, tick, "down");
      const target1 = toTick(buy * TARGET_1, tick, "nearest");
      return {
        buy, target1, target2: toTick(buy * TARGET_2, tick, "nearest"), stop: toTick(buy * STOP, tick, "nearest"), tick,
        anchor: nowPrice, anchorSource: nowSource, priceBasis: anchorQuote === fq ? "CONTRACT" : "SHARE",
        tradingSymbol: r.tradingSymbol, angelSymbol: fq?.tradingSymbol || r.angelSymbol || null,
        expiry, lotSize: r.lotSize, symbol: r.symbol,
        expected: sigma ? {
          fill: ledgerLib.firstPassage({ from: nowPrice, to: buy, sigma, tradingDays: ledgerLib.sessionTradingDaysLeft(Date.now()) }),
          target: ledgerLib.firstPassage({ from: buy, to: target1, sigma, tradingDays: ledgerLib.FUTURES_MAX_SESSIONS }),
          sigmaPct: round(sigma * 100, 1),
          basis: "first passage of measured volatility, zero drift; fill within the session, target within 20 sessions"
        } : null
      };
    }, { mayFreeze: forceFreeze === true ? Boolean(anchorQuote) : liveNow });
    if (!levels) return null;
    // A ROW IS SHOWN ON THE INSTRUMENT ITS LEVELS WERE FROZEN ON. A level frozen
    // on the share is carried for the rest of its session even after the
    // anchor moves to the contract (and the reverse); pricing its NOW off the
    // other instrument would set a futures price against a share-price limit
    // -- the "two prices for one row" the user objected to on 2026-09-22.
    const shownQuote = levels.priceBasis === "SHARE" ? sq : levels.priceBasis === "CONTRACT" ? fq : anchorQuote;
    const shown = shownQuote === anchorQuote ? anchorView : view(shownQuote);
    const risk = round(levels.buy - levels.stop);
    const reward = round(levels.target1 - levels.buy);
    const fnames = contractNames(r.symbol, levels.expiry || expiry, null, null, reference);
    return {
      display: fnames.display, expiryText: fnames.expiryText, exitBy: fnames.exitBy, exitByText: fnames.exitByText,
      symbol: r.symbol, tradingSymbol: levels.tradingSymbol || r.tradingSymbol,
      angelSymbol: levels.angelSymbol || null, expiry: levels.expiry || expiry,
      spot: shown.price, nowSource: shown.source, nowAtText: shown.atText, fnoListed: r.fnoListed === true,
      priceBasis: levels.priceBasis || (anchorQuote === fq ? "CONTRACT" : "SHARE"),
      referencePrice: shown.referencePrice, referenceKind: shown.referenceKind,
      buy: levels.buy, target1: levels.target1, target2: levels.target2, stop: levels.stop, tick: levels.tick ?? null,
      anchor: levels.anchor, anchorSource: levels.anchorSource || null, drift: driftPct(levels.buy, shown.price),
      frozen: levels.frozen, frozenAtIst: levels.frozenAtIst, frozenAt: levels.frozenAt || null,
      // THE FILL ESTIMATE IS FOR NOW, not for the moment of the freeze. It was
      // stored at 09:34 and shown all day: at 11:54 on 25 Sep LT read "fill
      // 45.8% today" when, from the live price with the session left, it was
      // 78%. The target odds run from the frozen buy and stay as frozen.
      expected: levels.expected ? {
        ...levels.expected,
        fill: (() => {
          const sigma = Number(levels.expected.sigmaPct) / 100;
          if (!(sigma > 0) || !(shown.price > 0) || phase.open !== true) return null;
          if (shown.price <= levels.buy) return { probabilityPct: 100, medianTradingDays: 0, atLimit: true };
          return ledgerLib.firstPassage({ from: shown.price, to: levels.buy, sigma, tradingDays: ledgerLib.sessionTradingDaysLeft(Date.now()) });
        })()
      } : null,
      perUnitCapital: levels.buy,
      // GM Global's smallest futures order is 20 units (the user, 2026-09-25:
      // "I need to purchase minimum 20"). Before GM's own charges, which are
      // not known here.
      minUnits: GM_MIN_UNITS,
      minCapital: round(levels.buy * GM_MIN_UNITS),
      minLossAtStop: round((levels.buy - levels.stop) * GM_MIN_UNITS),
      minGainAtTarget: round((levels.target1 - levels.buy) * GM_MIN_UNITS),
      riskPerUnit: risk, rewardPerUnit: reward,
      rewardToRisk: risk > 0 ? round(reward / risk) : null,
      exchangeLot: r.lotSize, score: r.compositeScore, sector: r.sector || null,
      // THE WIN RATE THIS TRADE NEEDS TO BREAK EVEN: loss / (win + loss), from
      // its own levels, before GM's charges. "Expectancy, not a required win
      // rate" (Global Trading Atlas, 28): a rate of wins means nothing without it.
      breakEvenPct: (levels.target1 - levels.stop) > 0 ? round(100 * (levels.buy - levels.stop) / (levels.target1 - levels.stop), 1) : null,
      ...(() => {
        const res = resultsFor(r.symbol);
        const exitBy = fnames.exitBy || null;
        return { resultsStatus: res.status, resultsDate: res.date || null,
          resultsBeforeExit: res.status === "ANNOUNCED" && exitBy ? res.date <= exitBy : null };
      })()
    };
  }).filter(Boolean);

  /**
   * THE TRACK RECORD. Every frozen level is a hypothetical order from the
   * moment it was shown; every running one is marked against the market on
   * every build. See scripts/paper-ledger.js for the rules, all of which
   * resolve an ambiguity against the record rather than for it.
   */
  let track = null;
  if (ledger) {
    try {
      for (const c of options) {
        if (!c.frozen) continue;
        ledger.add(ledgerLib.tradeFromLevel({
          kind: c.right, symbol: c.symbol, contract: c.zerodha, expiry: c.expiry,
          strike: c.strike, optionType: c.right, lotSize: c.lotSize,
          buy: c.buy, target: c.sell, stop: c.stop,
          sessionDate: session.sessionDate, shownAt: c.frozenAt,
          anchorSource: c.priceSourceAtFreeze || c.priceSource,
          expected: {
            fill: { note: "limit at the live mid when shown" },
            target: { probabilityPct: c.touchPct ?? null, medianDays: c.daysToTarget ?? null, daysBasis: "CALENDAR" }
          }
        }), quoteFor({ kind: "OPT", symbol: c.symbol, expiry: c.expiry, strike: c.strike, optionType: c.right }));
      }
      for (const f of futures) {
        if (!f.frozen) continue;
        ledger.add(ledgerLib.tradeFromLevel({
          kind: "FUT", symbol: f.symbol, contract: f.tradingSymbol || (f.symbol + " (share)"),
          expiry: f.fnoListed ? f.expiry : null, lotSize: f.exchangeLot, priceBasis: f.priceBasis,
          buy: f.buy, target: f.target1, target2: f.target2, stop: f.stop,
          sessionDate: session.sessionDate, shownAt: f.frozenAt, anchorSource: f.anchorSource,
          expected: f.expected
        }), quoteFor(f.priceBasis === "SHARE" ? { kind: "EQ", symbol: f.symbol } : { kind: "FUT", symbol: f.symbol, expiry: f.expiry }));
      }
      // Marked at the moment of marking -- after the levels were frozen -- not
      // at the moment the ledger was opened, which was before.
      ledger.markAll((t) => quoteFor(asRequest(t)), Date.now());
      const ledgerSaved = ledger.save();
      const closed = ledger.allClosed();
      track = {
        summary: ledgerLib.summarize(ledger.open, closed),
        // Futures in the size the user actually trades on GM: 20 units, gross
        // (GM's own charges are not known here).
        futuresPer20: (() => {
          const fut = closed.filter((x) => x.kind === "FUT" && x.pnl && numeric(x.pnl.perUnit) !== null);
          return fut.length ? { trades: fut.length, rupees: round(fut.reduce((a, x) => a + Number(x.pnl.perUnit) * GM_MIN_UNITS, 0)), units: GM_MIN_UNITS } : null;
        })(),
        open: ledger.open,
        recentClosed: closed.slice().sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 60),
        // The days the puts on the record were shown. None have been shown
        // since 25 Sep (calls only), and TRACK must say so: "no put option ...
        // but still in the records tab there are put profits" (the user, 28 Sep).
        putDays: (() => {
          const days = [...ledger.open, ...closed].filter((x) => x.kind === "PE").map((x) => x.sessionDate).filter(Boolean).sort();
          return days.length ? { first: days[0], last: days[days.length - 1] } : null;
        })(),
        totalClosed: closed.length,
        tally: ledger.tally,
        saved: ledgerSaved
      };
    } catch (error) {
      ledgerError = error.message;
    }
  }

  const saved = session.save();

  // WHAT EVERY ROW TOGETHER COULD COST ON A BAD DAY (api/_lib/risk-view.js):
  // today's rows replayed through two years of real prices, stops and targets
  // in the market. Read from the cache prepare-static-build.js fills -- never
  // the network -- and never fatal: a failure is a reason the page prints.
  const risk = (() => {
    try {
      const { riskView } = require("../api/_lib/risk-view");
      const { readHistory } = require("../api/_lib/risk-history");
      const { loadCorporateActions } = require("../api/_lib/nse-corporate-actions");
      return riskView({
        futures, calls: options.filter((c) => c.right === "CE"), units: GM_MIN_UNITS,
        historyFor: riskHistoryFor || ((symbol) => readHistory(symbol)),
        actions: riskActions === undefined ? loadCorporateActions() : riskActions
      });
    } catch (error) {
      return { available: false, reason: error.message };
    }
  })();

  // OUR PRICES AGAINST NSE'S OWN, ON EVERY BUILD (api/_lib/nse-crosscheck.js;
  // Global Trading Atlas, 30: reconcile a sample against an independent
  // source). A rotating sample of this page's rows is quoted again from Angel
  // One and read from nseindia.com seconds later. The health gate fails the
  // build in session if any of them is a DIFFERENT contract on NSE.
  let feedCheck = { checked: false, reason: "no broker quotes on this build" };
  // NOT BEFORE THE OPEN. Until 09:15 NSE's quote pages still show the previous
  // session: at 09:13 on Mon 28 Sep NSE gave WIPRO OCT FUT a "previous close"
  // of 162.87 -- Thursday's -- where Angel One had Friday's 162.35 (NSE's own
  // bhavcopy: close 162.35), and the page told the user two contracts were
  // DIFFERENT contracts. Comparing two different days proves nothing.
  // And not before 09:25: the first build after the open (09:16, the one that
  // freezes the day's levels) must not be turned red by NSE rolling over late.
  // NSE_NOT_ROLLED_TO_TODAY in nse-crosscheck.js covers a late page after that.
  const istMinutesNow = (() => { const t = new Date(Date.now() + 330 * 60_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); })();
  if (quoteStatus?.ok && (phase.phase === "PRE_OPEN" || (phase.open === true && istMinutesNow < 9 * 60 + 25))) {
    feedCheck = { checked: false, reason: phase.phase === "PRE_OPEN"
      ? "before the open, NSE's quote pages still show the previous session"
      : "before 09:25, NSE's quote pages can still show the previous session" };
  } else if (quoteStatus?.ok) {
    try {
      const nseCheck = require("../api/_lib/nse-crosscheck");
      feedCheck = await nseCheck.crossCheck(nseCheck.sampleRows({ futures, options, nowMs: Date.now() }), {
        session: quoteStatus.lastExchangeDate || null,
        // The last settlement file's own figures for each contract, to tell a
        // page NSE has not yet rolled over from a different contract.
        fileFor: (req) => {
          const bucket = reference?.symbols?.[req.symbol]?.expiries?.[String(req.expiry || "").slice(0, 10)];
          if (req.kind === "FUT") return bucket?.futuresFile || null;
          if (req.kind === "OPT") return bucket?.quotes?.[`${req.strike}|${req.optionType}`] || null;
          return null;
        },
        ours: async (reqs) => {
          const r = await brokers.contractQuotes(reqs);
          return reqs.map((x) => r?.quotes?.[brokers.contractKey(x)] || null);
        }
      });
    } catch (error) {
      feedCheck = { checked: false, reason: error.message };
    }
  }

  // What scripts/prepare-static-build.js found when it tried to log in. Carried
  // onto the page because "no options" has two causes that look identical from
  // the outside -- the login failed, or the exchange simply is not trading --
  // and only one of them is something you can fix.
  let brokerCheck = null;
  try {
    brokerCheck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", ".private", "cache", "broker-check.json"), "utf8"));
  } catch { brokerCheck = null; }

  return {
    builtAt: new Date().toISOString(),
    builtAtIst: istStamp(),
    sessionDate: session.sessionDate,
    levelsFrozen: session.canFreeze,
    // After 15:30 the day's levels are history and every row is a preview for
    // the next trading session (session-freeze.js).
    sessionOver,
    nextSession,
    // Whether today is an NSE trading day at all (weekends and NSE's own
    // holiday calendar), so the page never calls a trading morning before the
    // bell a day with no session.
    tradingDay: ledgerLib.isTradingDate(sessionDateNow),
    // Naming the reason matters: "the market is closed" and "nobody logged in
    // to the broker" produce the same empty screen and need different fixes.
    freezeBlockedBecause: session.canFreeze ? null
      : phase.open !== true
        ? `The market is ${phaseWords(phase.phase)}.`
        : require("../api/_lib/nse-holidays").isNseHoliday(session.sessionDate) === true
          ? "Today is an NSE trading holiday (NSE's own calendar), and no contract came back with a live exchange book."
          : "The market says it is open, but not one contract came back with a live exchange book "
            + "-- an NSE holiday, or no broker session. The clock alone is not evidence.",
    levelsOpenedAtIst: session.ledger.openedAtIst,
    freezeTally: session.tally,
    ledgerWritten: saved,
    marketPhase: phase.phase,
    settlementFile: reference?.session || null,
    pricedLive: screen.pricedLive ?? 0,
    pricedFromSettlement: screen.pricedFromSettlement ?? 0,
    examined: screen.examined ?? 0,
    survived: screen.survived ?? 0,
    brokerCheck,
    quoteStatus,
    feedCheck,
    watchStatus,
    futuresAnchor: ANCHOR,
    forwardStatus,
    optionsOnLiveForward: options.filter((c) => c.forwardSource === "LIVE").length,
    optionsDirection: { rule: "CALLS_ON_BUY_OR_ACCUMULATE_ONLY", names: Object.keys(bullish).length },
    gmMinUnits: GM_MIN_UNITS,
    marketContext: marketContext
      ? { ok: true, indiaVix: marketContext.indiaVix, indiaVixChangePct: marketContext.indiaVixChangePct,
          nifty: marketContext.nifty, niftyChangePct: marketContext.niftyChangePct, at: marketContext.nseTimestamp }
      : { ok: false },
    resultsCalendar: resultsCal
      ? { ok: true, fetchedAt: resultsCal.fetchedAt, days: resultsCal.days, meetings: Object.keys(resultsCal.symbols || {}).length,
          refusedOptionContracts: screen.refused?.resultsBeforeExit ?? 0 }
      : { ok: false },
    banList: { tradeDate: fnoUniverseEngine.banTradeDate || null, symbols: [...bannedSet].sort(),
      refusedContracts: screen.refused?.banned ?? null },
    track,
    risk,
    ledgerError,
    // Futures on today's list that the session froze without: their contract
    // quote did not come back live, so they are shown on a fallback price and
    // are NOT in the track record yet. Said out loud, or the record just looks
    // shorter than the list for no stated reason.
    untrackedFutures: session.canFreeze ? futures.filter((f) => !f.frozen).map((f) => f.symbol) : [],
    options,
    futures
  };
}

function page(d) {
  // Calls, puts and futures are three different trades, and they were asked
  // for as three separate things: "you have mixed up the call and put and the
  // futures ... keep it separate". One long page with the futures under forty
  // option rows meant the futures were effectively not on it.
  const calls = d.options.filter((c) => c.right === "CE");
  // IF YOU TAKE EVERY ROW: the money, the loss if every stop hits, and where the
  // rows cluster -- rows in one sector tend to fall together ("correlated
  // drawdowns", Global Trading Atlas, 29). A stop is not a cap on loss: a price
  // can gap through it (29), so the stop total is a floor on the damage.
  const allRowsBox = (rows, capital, loss, unit, extra = "") => {
    if (!rows.length) return "";
    const sectors = {};
    for (const r of rows) sectors[r.sector || "Unknown"] = (sectors[r.sector || "Unknown"] || 0) + 1;
    const top = Object.entries(sectors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(", ");
    const stocks = new Set(rows.map((r) => r.symbol)).size;
    return `<details class="fold sub lead"><summary>If you take every row here (${esc(unit)}): <b class="amt">${money(round(capital, 0))}</b> in total;
      if every stop is hit, <b class="down amt">&minus;${money(round(loss, 0))}</b> &mdash; more if prices gap through the stops.<span class="more"></span></summary>
      <div>${stocks < rows.length ? `These ${esc(rows.length)} rows are on <b>${esc(stocks)} stocks</b>: several strikes of one stock are one bet, not several. ` : ""}Most rows are in: ${top}. Rows in one sector tend to fall together.${extra ? ` ${extra}` : ""}</div></details>`;
  };
  // BAD-DAY RISK (api/_lib/risk-view.js): what every row TOGETHER would have
  // lost on days that already happened. The line you tap carries the three
  // figures; the rest says how they were worked out and what was left out.
  const dayText = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const riskBox = (side, kind) => {
    const r = d.risk;
    if (!r) return "";
    const off = (why) => `<div class="sub lead"><b>BAD-DAY RISK:</b> not available on this build &mdash; ${esc(why)}.</div>`;
    if (!r.available) return off(r.reason || "reason unknown");
    if (!side) return "";
    if (!side.available) return off(side.reason || "reason unknown");
    const w = side.worst;
    const what = kind === "futures" ? `${esc(r.units)} units each` : "one lot each";
    const stops = !w.stopsHit ? "no stop was hit"
      : `${esc(w.stopsHit)} stop${w.stopsHit === 1 ? " was" : "s were"} hit${w.throughGap ? `, ${esc(w.throughGap)} of them by a gap at the open` : ""}`;
    const left = [...(side.excluded || []).map((x) => `${esc(x.symbol)} (${esc(x.sessions)} sessions of history)`),
      ...(side.unpriced || []).map((s) => `${esc(s)} (could not be priced)`)];
    return `<details class="fold risk"><summary><b>BAD-DAY RISK</b>, every row together &mdash; 1 day in 20: <b class="down amt">${money(-side.var)}</b> or worse
      &middot; worst day: <b class="down amt">${money(w.rupees)}</b>${side.gap ? ` &middot; market opens 5% lower: <b class="down amt">${money(side.gap.rupees)}</b>` : ""}<span class="more"></span></summary>
      <div>Today&rsquo;s ${esc(side.rowsIncluded)} rows (${what}) replayed through each of the last ${esc(side.days)} trading days,
        ${esc(dayText(side.from))} to ${esc(dayText(side.to))}, on real prices, with every stop and target in the market.
        Not a forecast: these are days that already happened. Before charges.</div>
      <div><b>1 day in 20:</b> on the worst ${esc(side.tailDays)} of those ${esc(side.days)} days, all the rows together lost at least
        ${money(side.var)} &mdash; ${money(side.es)} on average.</div>
      <div><b>Worst day, ${esc(dayText(w.date))}</b>${w.marketPct !== null && w.marketPct !== undefined ? ` (NIFTY ${signedPct(w.marketPct)})` : ""}: ${esc(w.stocksDown)} of
        ${esc(w.stocksWithData)} stocks fell and ${stops} &mdash; a loss of ${money(w.rupees)}, against ${money(-side.stopTotal)} if every stop
        had filled at its own price (before charges).</div>
      ${side.gap ? `<div><b>Market opens 5% lower:</b> ${money(side.gap.rupees)}. Each stock opens lower by its own measured sensitivity to NIFTY
        (median ${esc(side.gap.medianBeta)}), and a stop fills at the open, not at its own price.</div>` : ""}
      <div><b>Together:</b> on those ${esc(side.tailDays)} worst days, ${esc(side.fellTogetherPct)}% of the stocks fell at once. These rows are closer
        to one bet on the market than to ${esc(side.stocks)} separate ones.</div>
      ${(side.top || []).length ? `<div><b>Most of the bad-day loss:</b> ${side.top.map((x) => `${esc(x.symbol)} ${x.sharePct === null || x.sharePct === undefined ? money(-x.rupees) : esc(x.sharePct) + "%"}`).join(", ")}${kind === "futures"
        ? ` &mdash; at ${esc(r.units)} units each, the highest-priced stocks carry the most rupees` : ""}.</div>` : ""}
      ${left.length ? `<div><b>Left out:</b> ${left.join(", ")}.</div>` : ""}
      <div>Demergers, bonuses and splits are read from NSE&rsquo;s own filings${r.actionsAsOf ? ` (${esc(dayText(String(r.actionsAsOf).slice(0, 10)))})` : ""},
        so none of them counts as a crash.</div>
      ${kind === "calls" ? `<div><b>For calls these figures are the pessimistic end.</b> Each call is repriced with Black-76 at its own implied volatility,
        held where it is &mdash; and in a crash that volatility jumps, which cushions a call${side.worst.vixPct !== null && side.worst.vixPct !== undefined
          ? ` (India VIX moved ${signedPct(Math.round(side.worst.vixPct))} on ${esc(dayText(side.worst.date))})` : ""}. By how much depends on each stock&rsquo;s own
        option volatility, which this page has no history for.</div>` : ""}
    </details>`;
  };
  const sumOf = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const puts = d.options.filter((c) => c.right === "PE");
  // The results date, in one of three honest states (api/_lib/nse-results.js).
  const resultsLine = (r) => {
    const when = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    if (r.resultsStatus === "ANNOUNCED") {
      return r.resultsBeforeExit
        ? `<div class="sub"><b class="warn">results ${esc(when(r.resultsDate))} &mdash; before the exit date: expect a gap</b></div>`
        : `<div class="sub">results ${esc(when(r.resultsDate))}</div>`;
    }
    if (r.resultsStatus === "NOT_ANNOUNCED") return `<div class="sub">results date not announced yet</div>`;
    if (r.resultsStatus === "UNKNOWN") return `<div class="sub down">results calendar unavailable today</div>`;
    return "";
  };
  const optionRows = (list) => list.map((c, i) => {
    const state = c.frozen ? fillState(c.buy, c.now) : previewState(c.buy, c.now);
    const sameStock = i > 0 && list[i - 1].symbol === c.symbol;
    return `
      <tr>
        <td><b class="name">${esc(c.display || (c.symbol + " " + c.strike + " " + c.right))}</b>${sameStock
          ? `<div class="sub warn">another strike of ${esc(c.symbol)} &mdash; the same bet as the row above</div>` : ""}
          <div class="sub">Zerodha <code>${esc(c.zerodha)}</code>${c.angel ? ` &middot; Angel <code>${esc(c.angel)}</code>` : ""}</div>
          <div class="sub">expires ${esc(c.expiryText || c.expiry)} &middot; ${esc(round(c.daysLeft, 1))}d left${c.exitByText ? ` &middot; <b class="warn">exit by ${esc(c.exitByText)}</b>` : ""}</div>${resultsLine(c)}</td>
        <td class="num"><b>${px(c.buy)}</b><div class="sub">&times;${esc(c.lotSize)} = ${money(c.costPerLot)}</div></td>
        <td class="num up"><b>${px(c.sell)}</b><div class="sub">net +${money(c.netProfit)} a lot</div></td>
        <td class="num down">${px(c.stop)}${c.netLossAtStop !== null && c.netLossAtStop !== undefined ? `<div class="sub down">net &minus;${money(Math.abs(c.netLossAtStop))} a lot</div>` : ""}</td>
        <td class="num">${px(c.now)}<div class="sub ${state.tone}">${esc(state.word)}</div></td>
        <td class="num">${esc(c.iv)}% / ${esc(c.rv)}%<div class="sub">VRP ${esc(c.vrp)}</div></td>
        <td class="num">${esc(c.touchPct)}%<div class="sub">touch, ~${esc(c.daysToTarget)}d &mdash; ignores the stop</div>${c.breakEvenPct !== null && c.breakEvenPct !== undefined ? `<div class="sub">needs ${esc(c.breakEvenPct)}% wins to break even</div>` : ""}${c.noTrendNet !== null && c.noTrendNet !== undefined ? `<div class="sub down">no trend: about &minus;${money(Math.abs(c.noTrendNet))} a lot${c.spreadKnown === false ? ", plus the spread" : ""}</div>` : ""}</td>
        <td class="num ${Number(c.thetaBurnPct) > 12 ? "down" : ""}">${esc(c.thetaBurnPct)}%</td>
        <td class="num">${esc(c.score)}</td>
      </tr>`;
  }).join("");

  const optionTable = (list, empty) => `
<div class="wrap"><table>
  <thead><tr>
    <th>CONTRACT</th><th class="num">BUY LIMIT</th><th class="num">SELL &middot; NET</th><th class="num">STOP</th>
    <th class="num">NOW</th>
    <th class="num">IV / REALISED</th><th class="num">P(TOUCH)</th><th class="num">DECAY</th><th class="num">SCORE</th>
  </tr></thead><tbody>${optionRows(list) || `<tr><td colspan="9">${empty}</td></tr>`}</tbody>
</table></div>`;

  // Where NOW came from, in words, on every row -- because the cash price and
  // the futures price differ by the carry, and a row priced on the wrong one
  // looked exactly like a row priced on the right one.
  const SOURCE_LABEL = {
    FUTURES_LIVE: "futures, live",
    // Not "last trade": NSE has no trading in derivatives after 15:30, so the
    // 15:39 stamp after the close is the day's last price update, not a trade.
    FUTURES_LAST_TRADED: "futures, last price &mdash; NOT live",
    SHARE_LIVE: "share, live",
    SHARE_LAST_TRADED: "share, last trade &mdash; NOT live",
    SHARE_CLOSE_FROM_HISTORY: "share, last close &mdash; NOT live"
  };
  const futRows = d.futures.map((r) => {
    const state = r.frozen ? fillState(r.buy, r.spot) : previewState(r.buy, r.spot);
    const exp = r.expected;
    const fillMinutes = exp?.fill ? Math.round(exp.fill.medianTradingDays * 375) : null;
    const expLine = [
      exp?.fill ? (exp.fill.atLimit ? "at the limit now" : `fill ${esc(exp.fill.probabilityPct)}% by the close (~${esc(fillMinutes)} min)`) : null,
      exp?.target ? `touch odds ${esc(exp.target.probabilityPct)}% (~${esc(round(exp.target.medianTradingDays, 1))} sessions)` : null,
      exp?.target ? "&mdash; ignores the stop" : null
    ].filter(Boolean).map((line) => `<div class="sub">${line}</div>`).join("");
    return `
      <tr>
        <td>${r.priceBasis === "CONTRACT"
          ? `<b class="name">${esc(r.display || r.symbol)}</b>
             <div class="sub">Zerodha <code>${esc(r.tradingSymbol)}</code>${r.angelSymbol ? ` &middot; Angel <code>${esc(r.angelSymbol)}</code>` : ""}</div>`
          : `<b class="name">${esc(r.symbol)}</b>
             <div class="sub">levels on the share price</div>
             ${r.tradingSymbol
               ? `<div class="sub">NSE future: Zerodha <code>${esc(r.tradingSymbol)}</code>${r.angelSymbol ? ` &middot; Angel <code>${esc(r.angelSymbol)}</code>` : ""}</div>`
               : `<div class="sub">no NSE futures contract &mdash; share only</div>`}`}
          ${r.expiryText ? `<div class="sub">future expires ${esc(r.expiryText)}${r.exitByText ? ` &middot; <b class="warn">exit or roll by ${esc(r.exitByText)}</b>` : ""}</div>` : ""}${resultsLine(r)}</td>
        <td class="num"><b>${px(r.buy)}</b>${expLine}</td>
        <td class="num up">${px(r.target1)}<div class="sub">${px(r.target2)}</div></td>
        <td class="num down">${px(r.stop)}</td>
        <td class="num">${px(r.spot)}<div class="sub ${state.tone}">${esc(state.word)}</div><div class="sub ${/_LIVE$/.test(r.nowSource) ? "" : "down"}">${SOURCE_LABEL[r.nowSource] || ""}${r.nowAtText ? ` at ${esc(r.nowAtText)}` : ""}</div>${r.referencePrice
          ? `<div class="sub">${r.referenceKind === "future" ? "NSE future" : "share"} ${px(r.referencePrice)}</div>`
          : (r.fnoListed === false ? `<div class="sub">no NSE futures contract</div>` : "")}</td>
        <td class="num">${money(r.minCapital)}<div class="sub">${esc(r.minUnits)} units</div><div class="sub down">stop &minus;${money(r.minLossAtStop)}</div><div class="sub up">target +${money(r.minGainAtTarget)}</div></td>
        <td class="num">${esc(r.rewardToRisk)}<div class="sub">+${money(r.rewardPerUnit)} / &minus;${money(r.riskPerUnit)}</div>${r.breakEvenPct !== null && r.breakEvenPct !== undefined ? `<div class="sub">needs ${esc(r.breakEvenPct)}% wins to break even</div>` : ""}</td>
      </tr>`;
  }).join("");

  // ---- the track record tab -------------------------------------------------
  const t = d.track;
  const when = (iso) => (iso ? esc(istStamp(Date.parse(iso)).replace(" IST", "")) : "&mdash;");
  // A median of a few minutes rounds to 0 hours; "0 h" read as nothing at all.
  const hrs = (h) => (h === null || h === undefined ? "&mdash;" : Number(h) < 0.05 ? "within minutes"
    : Number(h) < 24 ? `${esc(h)} h` : `${esc(round(h / 24, 1))} d`);
  const KIND = { FUT: "FUTURE", CE: "CALL", PE: "PUT" };
  const OUTCOME = {
    TARGET: '<b class="up">TARGET ✓</b>', STOP: '<b class="down">STOP ✗</b>',
    EXPIRED: "EXPIRED", TIMED_OUT: "TIMED OUT", UNFILLED: '<span class="sub">UNFILLED</span>',
    WAITING: "waiting for fill", OPEN: '<b>OPEN</b>'
  };
  const expectedText = (x) => {
    const e = x.expected;
    if (!e?.target) return "&mdash;";
    const days = e.target.medianTradingDays !== undefined
      ? `${esc(round(e.target.medianTradingDays, 1))} sessions`
      : e.target.medianDays !== null && e.target.medianDays !== undefined ? `${esc(e.target.medianDays)} days` : "?";
    return `${esc(e.target.probabilityPct ?? "?")}% &middot; ~${days}`;
  };
  const shortDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const putNote = t?.putDays && !d.options.some((c) => c.right === "PE")
    ? `<div class="sub warn">shown ${esc(shortDay(t.putDays.first))}${t.putDays.last !== t.putDays.first ? `&ndash;${esc(shortDay(t.putDays.last))}` : ""},
        before puts came off the page &mdash; none since; tracked to their end</div>` : "";
  const summaryRow = (label, s) => s ? `
      <tr><td><b>${label}</b>${label === "PUTS" ? putNote : ""}</td>
        <td class="num">${esc(s.shown)}</td><td class="num">${esc(s.waiting)}</td><td class="num">${esc(s.open)}</td>
        <td class="num up">${esc(s.target)}</td><td class="num down">${esc(s.stop)}</td><td class="num">${esc(s.expired)}</td>
        <td class="num">${esc(s.unfilled)}</td>
        <td class="num"><b>${s.hitRatePct === null ? "&mdash;" : esc(s.hitRatePct) + "%"}</b><div class="sub">of ${esc(s.resolved)} finished${Number(s.resolvedBets) < Number(s.resolved) ? ` (${esc(s.resolvedBets)} separate bet${Number(s.resolvedBets) === 1 ? "" : "s"})` : ""}${Number(s.resolvedBets ?? s.resolved) < 30 ? " &mdash; too few to judge" : ""}</div>${s.hitRate95
          ? `<div class="sub">95% range ${esc(s.hitRate95.lowPct)}&ndash;${esc(s.hitRate95.highPct)}%${Number(s.resolvedBets) >= 30 && s.randomHitRatePct !== null && s.randomHitRatePct !== undefined
            ? (s.hitRate95.lowPct > s.randomHitRatePct ? ` &mdash; <b class="up">above break-even</b>`
              : s.hitRate95.highPct < s.randomHitRatePct ? ` &mdash; <b class="down">below break-even</b>` : " &mdash; not yet distinguishable from break-even")
            : ""}</div>` : ""}</td>
        <td class="num">${s.randomHitRatePct === null || s.randomHitRatePct === undefined ? "&mdash;" : esc(s.randomHitRatePct) + "%"}${s.expectedHitRatePct !== null && s.expectedHitRatePct !== undefined ? `<div class="sub">touch odds said ${esc(s.expectedHitRatePct)}%</div>` : ""}</td>
        <td class="num">${hrs(s.medianHoursToFill)}</td><td class="num">${hrs(s.medianHoursToTarget)}</td>
        <td class="num ${Number(s.avgReturnPct) >= 0 ? "up" : "down"}">${label === "ALL"
          ? `&mdash;<div class="sub">not comparable</div>`
          : s.avgReturnPct === null ? "&mdash;" : signedPct(s.avgReturnPct)}</td>
        ${(() => {
          // ALL is everything: options net per lot PLUS futures at 20 units,
          // gross. It showed the options alone (-10,065.53 on 27 Sep, when the
          // futures' -3,725.8 made it -13,791.33).
          const fut = t?.futuresPer20 ? Number(t.futuresPer20.rupees) : null;
          const opt = s.totalNetPerLot === null || s.totalNetPerLot === undefined ? null : Number(s.totalNetPerLot);
          const value = label === "FUTURES" ? fut : label === "ALL" ? (fut === null && opt === null ? null : (fut || 0) + (opt || 0)) : opt;
          const sub = label === "FUTURES" ? (t?.futuresPer20 ? `at ${esc(t.futuresPer20.units)} units, gross` : "")
            : label === "ALL" ? "options + futures (20 units)" : "";
          return `<td class="num ${Number(value) >= 0 ? "up" : "down"}">${value === null ? "&mdash;" : money(round(value))}${sub ? `<div class="sub">${sub}</div>` : ""}</td>`;
        })()}
      </tr>` : "";
  const openRows = (t?.open || []).slice().sort((a, b) => String(b.shownAt).localeCompare(String(a.shownAt))).map((x) => `
      <tr>
        <td><b>${esc(x.contract)}</b><div class="sub">${esc(KIND[x.kind] || x.kind)}</div></td>
        <td class="num">${when(x.shownAt)}</td>
        <td class="num"><b>${px(x.buy)}</b></td><td class="num up">${px(x.target)}</td><td class="num down">${px(x.stop)}</td>
        <td class="num">${OUTCOME[x.status] || esc(x.status)}${x.filledAt ? `<div class="sub">${Number(x.hoursToFill) < 0.05 ? "filled within minutes" : `filled after ${hrs(x.hoursToFill)}`}</div>` : ""}</td>
        <td class="num">${px(x.last)}<div class="sub">${x.filledAt ? `best ${px(x.best)} &middot; worst ${px(x.worst)}` : ""}</div></td>
        <td class="num">${expectedText(x)}</td>
      </tr>`).join("");
  const closedRows = (t?.recentClosed || []).map((x) => `
      <tr>
        <td><b>${esc(x.contract)}</b><div class="sub">${esc(KIND[x.kind] || x.kind)} &middot; shown ${when(x.shownAt)}</div></td>
        <td class="num">${OUTCOME[x.status] || esc(x.status)}<div class="sub">${when(x.closedAt)}</div></td>
        <td class="num">${hrs(x.hoursToFill)}</td>
        <td class="num">${hrs(x.hoursFillToExit)}</td>
        <td class="num">${expectedText(x)}</td>
        <td class="num ${numeric(x.pnl?.perUnit) === null ? "" : numeric(x.pnl.perUnit) >= 0 ? "up" : "down"}">${x.pnl ? `${money(x.pnl.perUnit)} <div class="sub">${signedPct(x.pnl.pct)} ${esc(x.pnl.basis)}${x.pnl.netPerLot !== undefined && x.pnl.netPerLot !== null ? ` &middot; net ${money(x.pnl.netPerLot)}/lot` : ""}${x.kind === "FUT" && numeric(x.pnl.perUnit) !== null ? ` &middot; ${money(round(Number(x.pnl.perUnit) * (d.gmMinUnits || 20)))} at ${esc(d.gmMinUnits || 20)} units` : ""}</div>` : "&mdash;"}</td>
      </tr>`).join("");
  const trackCount = (t?.open?.length || 0) + (t?.totalClosed || 0);
  const trackPane = !t
    ? `<div class="note" style="border-left-color:var(--red)"><b>THE TRACK RECORD COULD NOT BE UPDATED ON THIS BUILD.</b> ${esc(d.ledgerError || "No ledger.")}</div>`
    : `
    <div class="wrap"><table class="summary">
      <thead><tr>
        <th></th><th class="num">SHOWN</th><th class="num">WAITING</th><th class="num">OPEN</th>
        <th class="num">TARGET ✓</th><th class="num">STOP ✗</th><th class="num">EXPIRED</th><th class="num">UNFILLED</th>
        <th class="num">HIT RATE</th><th class="num">IF RANDOM</th>
        <th class="num">TIME TO FILL</th><th class="num">FILL &rarr; TARGET</th>
        <th class="num">AVG RETURN</th><th class="num">NET / LOT &middot; FUTURES AT 20 UNITS</th>
      </tr></thead><tbody>
        ${summaryRow("FUTURES", t.summary.FUT)}${summaryRow("CALLS", t.summary.CE)}${summaryRow("PUTS", t.summary.PE)}${summaryRow("ALL", t.summary.ALL)}
      </tbody>
    </table></div>
    <div class="sub" style="margin:6px 0 18px">Hit rate counts only trades that filled and then finished. IF RANDOM is how often
      the target would come before the stop if prices moved at random &mdash; each trade's break-even, before charges. Only a hit rate
      above it, over enough separate bets, is evidence of an edge. The touch odds the desk showed ignore the stop, so they always run higher.
      Futures returns are GROSS per unit; options are NET of every charge per lot. ALL has no average return
      (futures move about 1.5%, options about 50%), and its money is options net a lot plus futures at 20 units, gross.</div>

    ${(d.untrackedFutures || []).length ? `<div class="note" style="border-left-color:var(--red)">
      <b>${esc(d.untrackedFutures.length)} FUTURES ON TODAY&rsquo;S LIST ARE NOT BEING TRACKED YET:</b>
      ${esc(d.untrackedFutures.join(", "))}. No live quote for their contract came back, so their levels are not frozen
      and they are shown on a fallback price. Each is added the first time its contract is priced live.</div>` : ""}

    <h2>Running now (${esc(t.open.length)})</h2>
    <div class="wrap"><table>
      <thead><tr><th>CONTRACT</th><th class="num">SHOWN</th><th class="num">BUY</th><th class="num">TARGET</th><th class="num">STOP</th>
        <th class="num">STATUS</th><th class="num">LAST</th><th class="num">TOUCH ODDS (IGNORE STOP)</th></tr></thead>
      <tbody>${openRows || '<tr><td colspan="8">Nothing running. The first trades are recorded when the day&rsquo;s levels freeze, on the first build that sees a live exchange book.</td></tr>'}</tbody>
    </table></div>

    <h2>Finished (latest ${esc(t.recentClosed.length)} of ${esc(t.totalClosed)})</h2>
    <div class="wrap"><table>
      <thead><tr><th>CONTRACT</th><th class="num">OUTCOME</th><th class="num">TIME TO FILL</th><th class="num">FILL &rarr; EXIT</th>
        <th class="num">TOUCH ODDS</th><th class="num">RESULT</th></tr></thead>
      <tbody>${closedRows || '<tr><td colspan="6">Nothing has finished yet.</td></tr>'}</tbody>
    </table></div>

    <div class="note" style="margin-top:14px">
      <b>HOW THIS IS SCORED.</b> Every price this page freezes is bought on paper at the moment it is shown. Each build then
      checks the market, using the day&rsquo;s high and low so a move between two builds is not missed. Every ambiguity counts
      <i>against</i> the record: a target and a stop in the same window is a stop; a target in the same window as the fill is not
      counted; a gap through the stop exits at the open; a fill is always at the limit, never better; a price from before the
      level was shown can never fill it. Unfilled day orders die at 15:30. Futures are held at most 20 sessions; options until expiry.
      <b>Stored</b> in the private repository under <code>docs/ledger/</code>, committed on every build, and copied to the Google Sheet.
    </div>`;

  const bc = d.brokerCheck;
  const brokerNote = !bc
    ? ""
    : bc.ok
      ? ` <b class="up">Broker login OK</b> from the build server at ${esc(istStamp(Date.parse(bc.checkedAt)))}
         &mdash; a NIFTY quote came back.`
      : ` <b class="down">Broker login FAILED</b> at ${esc(istStamp(Date.parse(bc.checkedAt)))}
         (stage ${esc(bc.stage)}: ${esc(bc.reason)}${bc.message ? " &mdash; " + esc(bc.message) : ""}).
         Until this is fixed the options table stays empty during market hours, because a
         settled price is never quoted as a live one.`;

  // The two facts behind every option row that a reader cannot otherwise see:
  // which stocks were left out because NSE forbids fresh positions in them, and
  // whether the options were priced against today's futures or yesterday's.
  const ban = d.banList;
  // A ban list dated before the session being traded is yesterday's news: NSE
  // publishes the next session's list each evening, so an older date means the
  // fetch failed and a stock may have entered the ban since.
  const banStale = ban && ban.tradeDate && d.sessionDate && ban.tradeDate < d.sessionDate;
  const banNote = banStale
    ? ` <b class="down">F&amp;O ban list is from ${esc(ban.tradeDate)}, not today &mdash; it may be missing a stock
         that entered the ban since. Check NSE before trading.</b> Excluded on that list: ${esc((ban.symbols || []).join(", ") || "none")}.`
    : ban
    ? (ban.symbols?.length
      ? ` <b>F&amp;O ban${ban.tradeDate ? " for " + esc(ban.tradeDate) : ""}:</b> ${esc(ban.symbols.join(", "))} &mdash;
         left out entirely, because NSE allows only exits in a banned stock.`
      : ` <b>F&amp;O ban${ban.tradeDate ? " for " + esc(ban.tradeDate) : ""}:</b> none.`)
    : ` <b class="down">F&amp;O ban list not checked on this build &mdash; confirm on NSE before trading.</b>`;
  const forwardNote = !d.options.length ? ""
    : d.optionsOnLiveForward > 0
      ? ` ${esc(d.optionsOnLiveForward)} of ${esc(d.options.length)} options priced against the live futures price.`
      : " Premiums and the futures prices they are measured against both come from that same settlement file, so they describe the same moment.";

  // What the check against NSE found (api/_lib/nse-crosscheck.js).
  const fc = d.feedCheck;
  const fcAt = fc?.nseAt ? istStamp(Date.parse(fc.nseAt)) : "";
  const feedNote = !fc ? ""
    : fc.checked
      ? (fc.wrongContract?.length
        ? ` <b class="down">Checked against NSE at ${esc(fcAt)}: ${esc(fc.wrongContract.length)} of ${esc(fc.identityCompared)} sampled contracts are a DIFFERENT contract on NSE.</b>`
        : ` <b class="up">Checked against NSE's own site</b> at ${esc(fcAt)}: ${esc(fc.sameContract)} of ${esc(fc.identityCompared)} sampled
           contracts are the same contract on both (the same previous close)${fc.worstGapPct === 0 ? ", last prices identical"
             : fc.worstGapPct !== null && fc.worstGapPct !== undefined ? `, last prices within ${esc(fc.worstGapPct)}%` : ""}.`)
        + (fc.priceOff?.length ? ` <b class="warn">Price differs from NSE's:</b> ${esc(fc.priceOff.join("; "))}.` : "")
      : ` Not checked against NSE on this build (${esc(fc.reason || "reason unknown")}).`;
  const feedAlarm = fc?.checked && fc.wrongContract?.length
    ? `<div class="note" style="border-left-color:var(--red)"><b class="down">DO NOT TRADE THESE ROWS.</b>
        Angel One and NSE disagree on which contract they are: ${esc(fc.wrongContract.join("; "))}.
        A different previous close means a different contract, so the prices shown for them are not this contract's prices.</div>`
    : "";

  const liveNote = d.pricedLive > 0
    ? `<b class="up">${d.pricedLive}</b> priced from a live broker book, <b>${d.pricedFromSettlement}</b> from the ${esc(d.settlementFile)} settlement file.`
    : `All prices are from the <b>${esc(d.settlementFile)}</b> settlement file. The market was ${esc(phaseWords(d.marketPhase))} when this was built, so nothing here is executable right now.`;

  const nextText = d.nextSession ? new Date(`${d.nextSession}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "the next session";
  // The options are priced from a settlement file OLDER than the last session
  // that traded: between the close and the evening NSE publishes the day's file
  // (18:40-19:08 IST, measured), the calls tab shows the previous session's
  // prices while the futures tab already shows today's last trades.
  const lastTraded = d.quoteStatus?.lastExchangeDate || null;
  const optionsOnOldFile = d.pricedLive === 0 && d.settlementFile && lastTraded && d.settlementFile < lastTraded;
  const oldFileNote = optionsOnOldFile
    ? `<div class="sub warn" style="margin:-4px 0 10px">These calls are priced from NSE&rsquo;s <b>${esc(d.settlementFile)}</b> settlement file,
        a session older than today&rsquo;s last trades (${esc(lastTraded)}). NSE publishes the ${esc(lastTraded)} file after about 19:00 IST,
        and the next build after that uses it. The futures tab already uses today&rsquo;s last trades.</div>`
    : "";
  // NO SESSION TODAY only when today is not a trading day (a weekend or an NSE
  // holiday), or the session is over and nothing traded. Before the bell the
  // last trade is always the day before, and the header said "no session today"
  // on Monday 28 Sep at 07:49 -- a trading day that had not opened yet.
  const noSessionToday = Boolean(lastTraded && d.sessionDate && lastTraded < d.sessionDate
    && (d.tradingDay === false || d.sessionOver === true));
  const lastSessionText = lastTraded ? new Date(`${lastTraded}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "";
  // The headline stays on screen; the explanation folds behind a tap on the
  // phone (details.fold), so the rows come first.
  const [freezeHead, freezeRest] = d.sessionOver
    ? [`<b>${noSessionToday ? "NO SESSION TODAY" : "THE SESSION IS OVER"}. THESE ROWS ARE PREVIEWS, NOT ORDERS</b> &mdash; worked from the last prices, for <b>${esc(nextText)}</b>.`,
       `${noSessionToday
         ? `The last session was <b>${esc(lastSessionText)}</b>; its buy limits were day orders and ended at 15:30`
         : "Today's buy limits were day orders and ended at 15:30"} &mdash; what became of each is on <b>TRACK</b>.${optionsOnOldFile
         ? ` The calls are priced from the ${esc(d.settlementFile)} settlement file until NSE publishes today&rsquo;s.` : ""}
       The real levels are fixed on that session's first build that sees a live exchange book, and can differ from these.`]
    : d.levelsFrozen
    ? [`<b>BUY, SELL AND STOP ARE FIXED FOR TODAY</b> &mdash; set at <b>${esc(d.levelsOpenedAtIst || "the first build after the open")}</b>, and they do not move again.`,
       `They hold however far the market runs: ${esc(d.freezeTally.carried)} carried from earlier in the session,
       ${esc(d.freezeTally.frozenThisBuild)} set on this build. The <b>NOW</b> column is the only
       number that changes &mdash; it tells you whether the market has come to your limit yet.`]
    : d.marketPhase === "PRE_OPEN"
    // "There is no change in the futures from Friday -- is it even working?"
    // and "you told me to buy at this but it was way lower" (the user, 28 Sep,
    // looking at 09:10-09:31): before the open every price is the last
    // session's, and today's real levels come from live prices after 09:15.
    ? [`<b>BEFORE THE OPEN: EVERY PRICE BELOW IS ${lastSessionText ? `FROM ${esc(lastSessionText.toUpperCase())}` : "FROM THE LAST SESSION"} &mdash; THESE LEVELS ARE INDICATIVE, NOT FIXED.</b> Today&rsquo;s real levels are set on live prices after 09:15.`,
       `Nothing has traded yet today (a few shares and futures print in the 09:00&ndash;09:08 pre-open auction, and a row
       says so when it has). The levels are fixed on the first build that sees live prices &mdash; normally 09:33 &mdash; and they
       move by however far the market opens from the last close. <b>Do not place orders from this page before then.</b>`]
    : [`<b>THESE LEVELS ARE INDICATIVE, NOT FIXED.</b> ${esc(d.freezeBlockedBecause)}`,
       `There is no traded price to anchor them to, so nothing has been written down.
       They are set once &mdash; and then held all day &mdash; on the first build that
       sees a live exchange book.`];

  // WHEN THE NIFTY AND VIX FIGURES ARE FROM. Before the open they are the last
  // session's close, and "Nifty 23,140.5 (+0.34%), NSE 15:30" read on Monday
  // at 09:10 as this morning's -- beside a GIFT Nifty at -0.38% (the user,
  // 28 Sep). A figure from another day names its day.
  const ctxWhen = (() => {
    const m = String(d.marketContext?.at || "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2})/);
    if (!m) return `NSE ${esc(String(d.marketContext?.at || "").slice(12, 17))}`;
    const iso = `${m[3]}-${String(MONTHS.indexOf(m[2].toUpperCase()) + 1).padStart(2, "0")}-${m[1]}`;
    return iso === d.sessionDate ? `NSE ${esc(m[4])}`
      : `<b class="warn">NSE close of ${esc(new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }))} &mdash; not today</b>`;
  })();
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K&sup2; Desk</title>
<style>
  :root { color-scheme: dark; --bg:#0c0d14; --panel:#14161f; --line:#262a40; --muted:#8e93a6;
          --text:#e6e8f0; --green:#00e676; --red:#ff5252; --amber:#ffb300; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:14px }
  h1 { font-size:18px; margin:0 0 4px } h2 { font-size:15px; margin:26px 0 8px }
  .stamp { color:var(--muted); font-size:12px; margin-bottom:14px }
  .note { border:1px solid var(--line); border-left:3px solid var(--amber); border-radius:8px;
          padding:10px 12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--muted) }
  .note.frozen { border-left-color:var(--green) }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--panel) }
  table { border-collapse:collapse; width:100%; min-width:760px }
  /* The TRACK summary's notes wrap: on a 1536-px screen (1920 at 125%) its
     long notes pushed the money column off the right edge (27 Sep). */
  table.summary .sub { white-space:normal; max-width:230px; margin-left:auto }
  th { text-align:left; font-size:9px; letter-spacing:.06em; color:var(--muted);
       padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap }
  td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align:top }
  .num { text-align:right; white-space:nowrap }
  .sub { font-size:10px; color:var(--muted); margin-top:2px }
  code { font-size:10px; color:var(--text); white-space:nowrap }
  .up { color:var(--green) } .down { color:var(--red) }
  .name { font-size:15px; letter-spacing:.02em }
  .warn { color:var(--amber) }
  tr:last-child td { border-bottom:none }
  /* FOLDED NOTES. On the phone the explanations wait behind a tap so the rows
     come first (the user, 27 Sep: 25 lines of text sat above the first futures
     row); the figures stay in the line you tap. On a wider screen every fold
     is shown open (::details-content, in the media query below). No script. */
  details.fold > summary { cursor:pointer; list-style:none }
  details.fold > summary::-webkit-details-marker { display:none }
  details.fold > summary .more::after { content:" ▸ more"; color:var(--amber); white-space:nowrap }
  details.fold[open] > summary .more::after { content:" ▾ less" }
  details.fold > div { margin-top:6px }
  .lead { margin:-4px 0 10px }
  .amt { white-space:nowrap } /* "−" and "₹1,46,419" split across two lines on the phone (27 Sep) */
  details.fold.risk { border:1px solid var(--line); border-left:3px solid var(--red); border-radius:8px;
                      padding:8px 12px; margin:0 0 12px; font-size:11px; line-height:1.55; color:var(--muted) }
  @media (min-width: 721px) {
    details.fold::details-content { content-visibility:visible; display:block }
    details.fold > summary { cursor:default }
    details.fold > summary .more { display:none }
  }
  /* Three tabs, no JavaScript: a radio button per tab, and CSS shows the pane
     whose button is checked. Works on any phone, with scripts off, forever. */
  .desk > input { position:absolute; opacity:0; pointer-events:none }
  .tabs { position:sticky; top:0; z-index:5; display:flex; gap:8px; padding:10px 0; background:var(--bg) }
  .tabs label { flex:1; text-align:center; padding:12px 6px; border:1px solid var(--line); border-radius:10px;
                cursor:pointer; font-weight:700; letter-spacing:.05em; color:var(--muted); background:var(--panel) }
  .tabs label span { display:inline-block; margin-left:6px; padding:0 8px; border-radius:99px;
                     background:var(--line); color:var(--text); font-weight:400 }
  .pane { display:none }
  .pane h2 { margin-top:8px }
  #v-fut:checked ~ .pane-fut, #v-ce:checked ~ .pane-ce, #v-pe:checked ~ .pane-pe,
  #v-trk:checked ~ .pane-trk { display:block }
  #v-trk:checked ~ .tabs .t-trk { color:var(--bg); background:#40c4ff; border-color:#40c4ff }
  /* Four tabs on a 360px phone: tighter, never wrapping into two rows. */
  @media (max-width: 480px) {
    .tabs { gap:4px }
    .tabs label { font-size:11px; padding:10px 2px; letter-spacing:0 }
    .tabs label span { margin-left:3px; padding:0 5px }
  }
  /* THE PHONE IS THE MAIN SCREEN (the user's Samsung Galaxy M32: a page about
     412 px wide). Tables 1,100+ px wide showed only SYMBOL and BUY LIMIT, with
     STOP, NOW, GM MIN and R:R off to the right (27 Sep). Below 720 px every
     row is a card: the contract on top, then each value under its own label,
     two to a line. Nothing scrolls sideways. */
  @media (max-width: 720px) {
    body { padding:10px }
    .wrap { overflow-x:visible; border:0; background:transparent; border-radius:0 }
    table { min-width:0 }
    thead { display:none }
    .wrap tbody tr { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; margin:0 0 10px; padding:12px;
                     border:1px solid var(--line); border-radius:10px; background:var(--panel) }
    .wrap tbody td, .wrap tbody td.num { display:block; padding:0; border:0; text-align:left; white-space:normal }
    .wrap tbody td:first-child, .wrap tbody td[colspan] { grid-column:1 / -1 }
    .wrap td[data-label]:not([data-label=""])::before { content:attr(data-label); display:block; font-size:9px;
      letter-spacing:.06em; color:var(--muted); margin-bottom:2px }
    .wrap tbody td[data-label]:first-child::before { display:none } /* outranks the label rule above */
    table.summary .sub { max-width:none; margin-left:0 }
  }
  #v-fut:checked ~ .tabs .t-fut { color:var(--bg); background:var(--amber); border-color:var(--amber) }
  #v-ce:checked ~ .tabs .t-ce { color:var(--bg); background:var(--green); border-color:var(--green) }
  #v-pe:checked ~ .tabs .t-pe { color:var(--bg); background:var(--red); border-color:var(--red) }
</style></head><body>

<h1>K&sup2; Desk</h1>
<div class="stamp">Built ${esc(d.builtAtIst)}<span id="age"></span> &middot; ${noSessionToday ? `no session today (last: ${esc(lastSessionText)})` : `session ${esc(d.sessionDate)}`} &middot; market ${esc(d.marketPhase)} &middot;
  ${esc(Number(d.examined).toLocaleString("en-IN"))} contracts examined, ${esc(Number(d.survived).toLocaleString("en-IN"))} cleared every gate${d.marketContext?.ok
    ? ` &middot; India VIX <b>${esc(d.marketContext.indiaVix)}</b> (${signedPct(d.marketContext.indiaVixChangePct)}) &middot; Nifty ${esc(Number(d.marketContext.nifty).toLocaleString("en-IN"))} (${signedPct(d.marketContext.niftyChangePct)}), ${ctxWhen}`
    : " &middot; India VIX not read this build"}</div>

<div class="note ${d.levelsFrozen ? "frozen" : ""}"><details class="fold"><summary>${freezeHead}<span class="more"></span></summary><div>${freezeRest}</div></details></div>
${feedAlarm}

<main class="desk">
  <input type="radio" name="view" id="v-fut" checked>
  <input type="radio" name="view" id="v-ce">
  <input type="radio" name="view" id="v-pe">
  <input type="radio" name="view" id="v-trk">

  <nav class="tabs">
    <label for="v-fut" class="t-fut">FUTURES <span>${d.futures.length}</span></label>
    <label for="v-ce" class="t-ce">CALLS <span>${calls.length}</span></label>
    <label for="v-pe" class="t-pe">PUTS <span>${puts.length}</span></label>
    <label for="v-trk" class="t-trk">TRACK <span>${trackCount}</span></label>
  </nav>

  <section class="pane pane-fut">
    <h2>Futures &mdash; ${esc(d.gmMinUnits || 20)} units each (GM Global's minimum)</h2>
    ${allRowsBox(d.futures, sumOf(d.futures, (r) => r.minCapital), sumOf(d.futures, (r) => r.minLossAtStop), `${d.gmMinUnits || 20} units each, before GM's charges`,
      `<b>With no trend, a row's target comes before its stop at most as often as its break-even (about 37.5%)</b> &mdash; a price with no trend is a fair game &mdash;
       so before GM's charges these rows make money only if the BUY signal works. That signal failed its pre-registered final test
       (1,205 trades, t = 0.75; panel study, 24 Sep 2026).`)}
    ${riskBox(d.risk?.futures, "futures")}
    ${d.watchStatus ? `<details class="fold sub lead"><summary>Watching your ${esc(d.watchStatus.stocks)} stocks &mdash; which are priced how<span class="more"></span></summary><div>Watching your ${esc(d.watchStatus.stocks)} stocks
      (${esc(d.watchStatus.source)}): ${esc(d.watchStatus.withFutures)} have an NSE futures contract,
      ${esc(d.watchStatus.shareOnly)} are share-only (removed from F&amp;O)${d.watchStatus.notListed.length
        ? `, and ${esc(d.watchStatus.notListed.length)} ${d.watchStatus.notListed.length === 1 ? "has" : "have"} no price${d.watchStatus.unlistedOnNse
          ? (d.watchStatus.unlistedOnNse.length === d.watchStatus.notListed.length
            ? " &mdash; no longer listed on NSE (merged or delisted)"
            : ` &mdash; ${esc(d.watchStatus.unlistedOnNse.length)} no longer listed on NSE (merged or delisted), the rest not fetched yet`)
          : " yet under that symbol &mdash; merged, renamed or misspelt, or history not fetched yet"}: ${esc(d.watchStatus.notListed.join(", "))}` : ""}.${(d.watchStatus.renamed || []).length
        ? ` Followed to the symbol NSE trades them as today: ${d.watchStatus.renamed.map((x) => `${esc(x.from)} &rarr; ${esc(x.to)}`).join(", ")}
           (NSE's own symbol-change file, or your workbook's Yahoo ticker where NSE lists it; duplicates counted once).` : ""}
      ${(() => {
        const bases = new Set((d.futures || []).filter((r) => r.fnoListed).map((r) => r.priceBasis));
        const main = d.futuresAnchor === "CONTRACT" ? "NSE futures contract" : "share price";
        return bases.size > 1
          ? `Levels are anchored on the <b>${main}</b>; rows frozen earlier this session on the other price keep it until the session ends, and each row says which.`
          : `Levels are anchored on the <b>${bases.has("SHARE") ? "share price" : bases.has("CONTRACT") ? "NSE futures contract" : main}</b>.`;
      })()}
      Share-only names stay on the share. The other price is shown under NOW to compare with your platform.</div></details>` : ""}
    <div class="wrap"><table>
      <thead><tr>
        <th>SYMBOL</th><th class="num">BUY LIMIT</th><th class="num">TARGET 1 &middot; 2</th>
        <th class="num">STOP</th><th class="num">NOW</th><th class="num">GM MIN (20 UNITS)</th><th class="num">R : R</th>
      </tr></thead><tbody>${futRows || '<tr><td colspan="7">No futures cleared the hurdle on this build.</td></tr>'}</tbody>
    </table></div>
    <div class="sub" style="margin-top:8px">${d.resultsCalendar?.ok
      ? `Results dates are NSE's own board-meeting filings, read ${esc(String(d.resultsCalendar.fetchedAt).slice(0, 10))}:
         ${esc(d.resultsCalendar.meetings)} results meetings filed for the next ${esc(d.resultsCalendar.days)} days. Companies must file at least
         two working days before the meeting (SEBI LODR Regulation 29), so &ldquo;not announced&rdquo; does not mean &ldquo;no results&rdquo;.
         Options whose results fall on or before their exit date are not listed (${esc(d.resultsCalendar.refusedOptionContracts)} contracts refused).`
      : `<b class="down">NSE's results calendar could not be read for this build</b> &mdash; results dates are unknown, and no option was filtered for them.`}</div>
  </section>

  <section class="pane pane-ce">
    <h2>Calls &mdash; you BUY the call, it pays if the stock RISES</h2>
    ${allRowsBox(calls, sumOf(calls, (c) => c.costPerLot), sumOf(calls, (c) => Math.abs(c.netLossAtStop)), "one lot each",
      calls.length ? `<b>With no trend and fairly priced options, a call is expected to lose about its charges</b>:
       about &minus;${money(Math.abs(sumOf(calls, (c) => c.noTrendNet)))} across all ${esc(calls.length)} rows, one lot each${calls.some((c) => c.spreadKnown === false)
         ? `, <b>plus the bid-ask spread</b>, which is not known without a live book (${esc(calls.filter((c) => c.spreadKnown === false).length)} of these rows)` : ""}.
       ${esc(calls.filter((c) => Number(c.vrp) > 1).length)} of ${esc(calls.length)} are priced above the stock&rsquo;s own recent movement (implied above realised), which makes it worse.
       They make money only if the BUY signal works, and it failed its pre-registered final test (1,205 trades, t = 0.75; panel study, 24 Sep 2026).` : "")}
    ${riskBox(d.risk?.calls, "calls")}
    ${d.optionsDirection ? `<div class="sub" style="margin:-4px 0 10px">Only on the ${esc(d.optionsDirection.names)} stocks the desk rates BUY or ACCUMULATE &mdash; one side per stock, the side its analysis points to.</div>` : ""}
    ${oldFileNote}
    ${optionTable(calls, "No calls cleared every gate on this build.")}
  </section>

  <section class="pane pane-pe">
    <h2>Puts &mdash; you BUY the put, it pays if the stock FALLS</h2>
    ${optionTable(puts, d.optionsDirection
      ? "No puts, by design. The desk has no bearish view, and when its own history was tested, betting on falls lost money in all 24 set-ups across all three test periods (PANEL_STUDY_ROUND3). Puts come back only if a bearish signal proves itself."
      : "No puts cleared every gate on this build.")}
  </section>

  <section class="pane pane-trk">
    <h2>Track record &mdash; every price shown, bought on paper the moment it appeared</h2>
    ${trackPane}
  </section>
</main>

<div class="note" style="margin-top:20px">
  <b>WHERE THESE PRICES COME FROM.</b> ${liveNote}${forwardNote}${feedNote}${brokerNote}${banNote}
  This page is a <b>snapshot</b>, rebuilt on a schedule &mdash; it is not a live feed.
  <b>Check the price on your broker before placing anything.</b>
  Net figures are after brokerage, STT at 0.15%, exchange, stamp and GST; the
  spread is extra and is only known where a live book was seen.
</div>

<div class="note" style="margin-top:20px;border-left-color:var(--red)">
  <b>WHAT THIS DOES NOT ESTABLISH.</b> That any of it makes money. The paper ledger
  has ${esc(d.track?.summary?.ALL?.resolved ?? 0)} resolved trade(s) so far &mdash; far too few for a measured hit
  rate &mdash; and every test fixed in advance so far, on data never used to build the rule, found no edge:
  the desk's own ranking (final year t = 0.75), 12-1 momentum, time-series momentum, low volatility and a
  10-month market trend filter (all five FAIL). The ranking is built on things that were measured,
  which is not the same as an edge that was proven. Size accordingly.
</div>

<script>
/* HOW OLD THIS PAGE IS, AND THE NEXT ONE AS SOON AS IT EXISTS. The page is a
   snapshot rebuilt every 20 minutes in market hours, not a live feed; at 09:31
   on 28 Sep the user's phone still showed the 09:13 build, with Friday's
   futures. So the page says its own age, asks every minute whether a newer
   build is out, and loads it past the phone's 10-minute cache (GitHub Pages
   sends max-age=600), keeping the open tab. Without scripts it works as before. */
(function () {
  var builtMs = Date.parse(${JSON.stringify(d.builtAt)});
  var age = document.getElementById("age");
  function tick() {
    if (!age || !(builtMs > 0)) return;
    var m = Math.max(0, Math.round((Date.now() - builtMs) / 60000));
    age.textContent = " (" + (m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago") + ")";
    age.className = m > 25 ? "warn" : "";
  }
  tick();
  setInterval(tick, 30000);
  var tabs = { "#futures": "v-fut", "#calls": "v-ce", "#puts": "v-pe", "#track": "v-trk" };
  var chosen = document.getElementById(tabs[location.hash] || "");
  if (chosen) chosen.checked = true;
  Object.keys(tabs).forEach(function (h) {
    var input = document.getElementById(tabs[h]);
    if (input) input.addEventListener("change", function () { if (input.checked) history.replaceState(null, "", h); });
  });
  function check() {
    if (document.hidden || !window.fetch) return;
    fetch("version.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        var next = v && Date.parse(v.builtAt);
        if (next > builtMs) location.replace(location.pathname + "?v=" + next + location.hash);
      })
      .catch(function () {});
  }
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { tick(); check(); } });
})();
</script>
</body></html>`;
  return labelCells(html);
}

async function main() {
  const data = await build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "data.json"), JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), page(data));
  // What the open page asks every minute: is there a newer build than me?
  fs.writeFileSync(path.join(OUT_DIR, "version.json"), JSON.stringify({ builtAt: data.builtAt, builtAtIst: data.builtAtIst }));
  // GitHub Pages will not serve a directory containing an underscore path
  // without this, and the failure is a silent 404 rather than an error.
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");
  console.log(`built ${data.options.length} option rows and ${data.futures.length} futures rows`);
  console.log(`  ${data.pricedLive} live, ${data.pricedFromSettlement} from the ${data.settlementFile} settlement file`);
  console.log(`  levels: ${data.freezeTally.carried} carried, ${data.freezeTally.frozenThisBuild} frozen now, ` +
              `${data.freezeTally.indicative} indicative — ${data.ledgerWritten.written ? "ledger written" : data.ledgerWritten.reason}`);
  console.log(`  -> docs/index.html, docs/data.json, docs/levels.json`);
  return data;
}

module.exports = { build, page, fillState, main };

// Exported above so a test can drive build() twice and prove the levels did not
// move. Run directly, it is still just a build.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error("static build failed:", error.message);
    process.exit(1);
  });
}
