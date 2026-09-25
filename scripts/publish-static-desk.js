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
const { openSession, driftPct, istStamp, numeric } = require("./session-freeze");

const OUT_DIR = path.resolve(__dirname, "..", "docs");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function money(value) {
  return Number.isFinite(Number(value)) ? "₹" + Number(value).toLocaleString("en-IN") : "—";
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

async function build({ limit = 40, futuresLimit = 25, ledgerFile, ledgerDir, forceFreeze = null } = {}) {
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
    if (Number.isFinite(Number(row.compositeScore))) scores[row.symbol] = Number(row.compositeScore);
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
      lastExchangeDate: Object.values(quotes).map((q) => ledgerLib.feedDate(q?.exchangeFeedTime)).filter(Boolean).sort().pop() || null };
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
  const session = openSession({ canFreeze, file: ledgerFile });

  const options = (screen.contracts || []).map((c) => {
    const names = contractNames(c.symbol, c.expiry, c.strike, c.optionType, reference);
    const zerodha = names.zerodha;
    const nowPrice = round(c.premium);
    const levels = session.level("options", zerodha, () => {
      if (!Number.isFinite(Number(c.premium)) || Number(c.premium) <= 0) return null;
      return {
        buy: round(c.premium),
        sell: round(c.targetPremium),
        stop: round(Number(c.premium) / 2),
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
      buy: levels.buy, sell: levels.sell, stop: levels.stop,
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
        const spread = Number.isFinite(Number(c.spreadPct)) ? Number(c.spreadPct) : null;
        const atTarget = lot ? roundTripCost({ entryPremium: levels.buy, exitPremium: levels.sell, lotSize: lot, entrySpreadPct: spread }) : null;
        const atStop = lot ? roundTripCost({ entryPremium: levels.buy, exitPremium: levels.stop, lotSize: lot, entrySpreadPct: spread }) : null;
        return {
          lotSize: lot, costPerLot: lot ? round(levels.buy * lot) : null,
          netProfit: atTarget?.netProfit ?? null, netLossAtStop: atStop?.netProfit ?? null,
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
        const thetaPerDay = Number.isFinite(Number(c.thetaBurnPct)) && Number(c.premium) > 0 && screenerWait > 0
          ? (Number(c.thetaBurnPct) / 100) * Number(c.premium) / screenerWait : null;
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
        atText: q?.exchangeFeedTime ? String(q.exchangeFeedTime).slice(12, 17) : null,
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
      const buy = round(nowPrice * ENTRY_DISCOUNT);
      const target1 = round(buy * TARGET_1);
      return {
        buy, target1, target2: round(buy * TARGET_2), stop: round(buy * STOP),
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
      buy: levels.buy, target1: levels.target1, target2: levels.target2, stop: levels.stop,
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
      exchangeLot: r.lotSize, score: r.compositeScore,
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
        open: ledger.open,
        recentClosed: closed.slice().sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 60),
        totalClosed: closed.length,
        tally: ledger.tally,
        saved: ledgerSaved
      };
    } catch (error) {
      ledgerError = error.message;
    }
  }

  const saved = session.save();

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
    // Naming the reason matters: "the market is closed" and "nobody logged in
    // to the broker" produce the same empty screen and need different fixes.
    freezeBlockedBecause: session.canFreeze ? null
      : phase.open !== true
        ? `The market is ${String(phase.phase).toLowerCase()}.`
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
    watchStatus,
    futuresAnchor: ANCHOR,
    forwardStatus,
    optionsOnLiveForward: options.filter((c) => c.forwardSource === "LIVE").length,
    optionsDirection: { rule: "CALLS_ON_BUY_OR_ACCUMULATE_ONLY", names: Object.keys(bullish).length },
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
  const optionRows = (list) => list.map((c) => {
    const state = fillState(c.buy, c.now);
    return `
      <tr>
        <td><b class="name">${esc(c.display || (c.symbol + " " + c.strike + " " + c.right))}</b>
          <div class="sub">Zerodha <code>${esc(c.zerodha)}</code>${c.angel ? ` &middot; Angel <code>${esc(c.angel)}</code>` : ""}</div>
          <div class="sub">expires ${esc(c.expiryText || c.expiry)} &middot; ${esc(round(c.daysLeft, 1))}d left${c.exitByText ? ` &middot; <b class="warn">exit by ${esc(c.exitByText)}</b>` : ""}</div>${resultsLine(c)}</td>
        <td class="num"><b>${money(c.buy)}</b><div class="sub">&times;${esc(c.lotSize)} = ${money(c.costPerLot)}</div></td>
        <td class="num up"><b>${money(c.sell)}</b><div class="sub">net +${money(c.netProfit)} a lot</div></td>
        <td class="num down">${money(c.stop)}${c.netLossAtStop !== null && c.netLossAtStop !== undefined ? `<div class="sub down">net &minus;${money(Math.abs(c.netLossAtStop))} a lot</div>` : ""}</td>
        <td class="num">${money(c.now)}<div class="sub ${state.tone}">${esc(state.word)}</div></td>
        <td class="num">${esc(c.iv)}% / ${esc(c.rv)}%<div class="sub">VRP ${esc(c.vrp)}</div></td>
        <td class="num">${esc(c.touchPct)}%<div class="sub">~${esc(c.daysToTarget)}d</div></td>
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
    FUTURES_LAST_TRADED: "futures, last trade &mdash; NOT live",
    SHARE_LIVE: "share, live",
    SHARE_LAST_TRADED: "share, last trade &mdash; NOT live",
    SHARE_CLOSE_FROM_HISTORY: "share, last close &mdash; NOT live"
  };
  const futRows = d.futures.map((r) => {
    const state = fillState(r.buy, r.spot);
    const exp = r.expected;
    const fillMinutes = exp?.fill ? Math.round(exp.fill.medianTradingDays * 375) : null;
    const expLine = [
      exp?.fill ? (exp.fill.atLimit ? "at the limit now" : `fill ${esc(exp.fill.probabilityPct)}% by the close (~${esc(fillMinutes)} min)`) : null,
      exp?.target ? `target ${esc(exp.target.probabilityPct)}% in ~${esc(round(exp.target.medianTradingDays, 1))} sessions` : null
    ].filter(Boolean).join(" &middot; ");
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
        <td class="num"><b>${money(r.buy)}</b>${expLine ? `<div class="sub">expected: ${expLine}</div>` : ""}</td>
        <td class="num up">${money(r.target1)}<div class="sub">${money(r.target2)}</div></td>
        <td class="num down">${money(r.stop)}</td>
        <td class="num">${money(r.spot)}<div class="sub ${state.tone}">${esc(state.word)}</div><div class="sub ${/_LIVE$/.test(r.nowSource) ? "" : "down"}">${SOURCE_LABEL[r.nowSource] || ""}${r.nowAtText ? ` at ${esc(r.nowAtText)}` : ""}</div>${r.referencePrice
          ? `<div class="sub">${r.referenceKind === "future" ? "NSE future" : "share"} ${money(r.referencePrice)}</div>`
          : (r.fnoListed === false ? `<div class="sub">no NSE futures contract</div>` : "")}</td>
        <td class="num">${money(r.minCapital)}<div class="sub">${esc(r.minUnits)} units</div><div class="sub down">stop &minus;${money(r.minLossAtStop)}</div><div class="sub up">target +${money(r.minGainAtTarget)}</div></td>
        <td class="num">${esc(r.rewardToRisk)}<div class="sub">+${money(r.rewardPerUnit)} / &minus;${money(r.riskPerUnit)}</div></td>
      </tr>`;
  }).join("");

  // ---- the track record tab -------------------------------------------------
  const t = d.track;
  const when = (iso) => (iso ? esc(istStamp(Date.parse(iso)).replace(" IST", "")) : "&mdash;");
  const hrs = (h) => (h === null || h === undefined ? "&mdash;" : Number(h) < 24 ? `${esc(h)} h` : `${esc(round(h / 24, 1))} d`);
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
  const summaryRow = (label, s) => s ? `
      <tr><td><b>${label}</b></td>
        <td class="num">${esc(s.shown)}</td><td class="num">${esc(s.waiting)}</td><td class="num">${esc(s.open)}</td>
        <td class="num up">${esc(s.target)}</td><td class="num down">${esc(s.stop)}</td><td class="num">${esc(s.expired)}</td>
        <td class="num">${esc(s.unfilled)}</td>
        <td class="num"><b>${s.hitRatePct === null ? "&mdash;" : esc(s.hitRatePct) + "%"}</b><div class="sub">of ${esc(s.resolved)} finished</div></td>
        <td class="num">${s.expectedHitRatePct === null ? "&mdash;" : esc(s.expectedHitRatePct) + "%"}</td>
        <td class="num">${hrs(s.medianHoursToFill)}</td><td class="num">${hrs(s.medianHoursToTarget)}</td>
        <td class="num ${Number(s.avgReturnPct) >= 0 ? "up" : "down"}">${s.avgReturnPct === null ? "&mdash;" : esc(s.avgReturnPct) + "%"}</td>
        <td class="num ${Number(s.totalNetPerLot) >= 0 ? "up" : "down"}">${s.totalNetPerLot === null ? "&mdash;" : money(s.totalNetPerLot)}</td>
      </tr>` : "";
  const openRows = (t?.open || []).slice().sort((a, b) => String(b.shownAt).localeCompare(String(a.shownAt))).map((x) => `
      <tr>
        <td><b>${esc(x.contract)}</b><div class="sub">${esc(KIND[x.kind] || x.kind)}</div></td>
        <td class="num">${when(x.shownAt)}</td>
        <td class="num"><b>${money(x.buy)}</b></td><td class="num up">${money(x.target)}</td><td class="num down">${money(x.stop)}</td>
        <td class="num">${OUTCOME[x.status] || esc(x.status)}${x.filledAt ? `<div class="sub">filled after ${hrs(x.hoursToFill)}</div>` : ""}</td>
        <td class="num">${money(x.last)}<div class="sub">${x.filledAt ? `best ${money(x.best)} &middot; worst ${money(x.worst)}` : ""}</div></td>
        <td class="num">${expectedText(x)}</td>
      </tr>`).join("");
  const closedRows = (t?.recentClosed || []).map((x) => `
      <tr>
        <td><b>${esc(x.contract)}</b><div class="sub">${esc(KIND[x.kind] || x.kind)} &middot; shown ${when(x.shownAt)}</div></td>
        <td class="num">${OUTCOME[x.status] || esc(x.status)}<div class="sub">${when(x.closedAt)}</div></td>
        <td class="num">${hrs(x.hoursToFill)}</td>
        <td class="num">${hrs(x.hoursFillToExit)}</td>
        <td class="num">${expectedText(x)}</td>
        <td class="num ${Number(x.pnl?.perUnit) >= 0 ? "up" : "down"}">${x.pnl ? `${money(x.pnl.perUnit)} <div class="sub">${esc(x.pnl.pct)}% ${esc(x.pnl.basis)}${x.pnl.netPerLot !== undefined && x.pnl.netPerLot !== null ? ` &middot; net ${money(x.pnl.netPerLot)}/lot` : ""}</div>` : "&mdash;"}</td>
      </tr>`).join("");
  const trackCount = (t?.open?.length || 0) + (t?.totalClosed || 0);
  const trackPane = !t
    ? `<div class="note" style="border-left-color:var(--red)"><b>THE TRACK RECORD COULD NOT BE UPDATED ON THIS BUILD.</b> ${esc(d.ledgerError || "No ledger.")}</div>`
    : `
    <div class="wrap"><table>
      <thead><tr>
        <th></th><th class="num">SHOWN</th><th class="num">WAITING</th><th class="num">OPEN</th>
        <th class="num">TARGET ✓</th><th class="num">STOP ✗</th><th class="num">EXPIRED</th><th class="num">UNFILLED</th>
        <th class="num">HIT RATE</th><th class="num">EXPECTED</th>
        <th class="num">TIME TO FILL</th><th class="num">FILL &rarr; TARGET</th>
        <th class="num">AVG RETURN</th><th class="num">NET / LOT</th>
      </tr></thead><tbody>
        ${summaryRow("FUTURES", t.summary.FUT)}${summaryRow("CALLS", t.summary.CE)}${summaryRow("PUTS", t.summary.PE)}${summaryRow("ALL", t.summary.ALL)}
      </tbody>
    </table></div>
    <div class="sub" style="margin:6px 0 18px">Hit rate counts only trades that filled and then finished. EXPECTED is what the desk
      predicted for those same trades when it showed them &mdash; when the two disagree, the prediction is wrong, and this is where it shows.
      Futures returns are GROSS per unit; options are NET of every charge per lot.</div>

    ${(d.untrackedFutures || []).length ? `<div class="note" style="border-left-color:var(--red)">
      <b>${esc(d.untrackedFutures.length)} FUTURES ON TODAY&rsquo;S LIST ARE NOT BEING TRACKED YET:</b>
      ${esc(d.untrackedFutures.join(", "))}. No live quote for their contract came back, so their levels are not frozen
      and they are shown on a fallback price. Each is added the first time its contract is priced live.</div>` : ""}

    <h2>Running now (${esc(t.open.length)})</h2>
    <div class="wrap"><table>
      <thead><tr><th>CONTRACT</th><th class="num">SHOWN</th><th class="num">BUY</th><th class="num">TARGET</th><th class="num">STOP</th>
        <th class="num">STATUS</th><th class="num">LAST</th><th class="num">EXPECTED TARGET</th></tr></thead>
      <tbody>${openRows || '<tr><td colspan="8">Nothing running. The first trades are recorded when the day&rsquo;s levels freeze, on the first build that sees a live exchange book.</td></tr>'}</tbody>
    </table></div>

    <h2>Finished (latest ${esc(t.recentClosed.length)} of ${esc(t.totalClosed)})</h2>
    <div class="wrap"><table>
      <thead><tr><th>CONTRACT</th><th class="num">OUTCOME</th><th class="num">TIME TO FILL</th><th class="num">FILL &rarr; EXIT</th>
        <th class="num">EXPECTED</th><th class="num">RESULT</th></tr></thead>
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

  const liveNote = d.pricedLive > 0
    ? `<b class="up">${d.pricedLive}</b> priced from a live broker book, <b>${d.pricedFromSettlement}</b> from the ${esc(d.settlementFile)} settlement file.`
    : `All prices are from the <b>${esc(d.settlementFile)}</b> settlement file. The market was ${esc(d.marketPhase).toLowerCase()} when this was built, so nothing here is executable right now.`;

  const freezeNote = d.levelsFrozen
    ? `<b>BUY, SELL AND STOP ARE FIXED FOR TODAY.</b> They were set at
       <b>${esc(d.levelsOpenedAtIst || "the first build after the open")}</b> and they do not move again,
       however far the market runs. ${esc(d.freezeTally.carried)} carried from earlier in the session,
       ${esc(d.freezeTally.frozenThisBuild)} set on this build. The <b>NOW</b> column is the only
       number that changes &mdash; it tells you whether the market has come to your limit yet.`
    : `<b>THESE LEVELS ARE INDICATIVE, NOT FIXED.</b> ${esc(d.freezeBlockedBecause)}
       There is no traded price to anchor them to, so nothing has been written down.
       They are set once &mdash; and then held all day &mdash; on the first build that
       sees a live exchange book.`;

  return `<!doctype html>
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
  th { text-align:left; font-size:9px; letter-spacing:.06em; color:var(--muted);
       padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap }
  td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align:top }
  .num { text-align:right; white-space:nowrap }
  .sub { font-size:10px; color:var(--muted); margin-top:2px }
  code { font-size:10px; color:var(--text); word-break:break-all }
  .up { color:var(--green) } .down { color:var(--red) }
  .name { font-size:15px; letter-spacing:.02em }
  .warn { color:var(--amber) }
  tr:last-child td { border-bottom:none }
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
  #v-fut:checked ~ .tabs .t-fut { color:var(--bg); background:var(--amber); border-color:var(--amber) }
  #v-ce:checked ~ .tabs .t-ce { color:var(--bg); background:var(--green); border-color:var(--green) }
  #v-pe:checked ~ .tabs .t-pe { color:var(--bg); background:var(--red); border-color:var(--red) }
</style></head><body>

<h1>K&sup2; Desk</h1>
<div class="stamp">Built ${esc(d.builtAtIst)} &middot; session ${esc(d.sessionDate)} &middot; market ${esc(d.marketPhase)} &middot;
  ${esc(Number(d.examined).toLocaleString("en-IN"))} contracts examined, ${esc(Number(d.survived).toLocaleString("en-IN"))} cleared every gate${d.marketContext?.ok
    ? ` &middot; India VIX <b>${esc(d.marketContext.indiaVix)}</b> (${esc(d.marketContext.indiaVixChangePct)}%) &middot; Nifty ${esc(Number(d.marketContext.nifty).toLocaleString("en-IN"))} (${esc(d.marketContext.niftyChangePct)}%), NSE ${esc(String(d.marketContext.at || "").slice(12, 17))}`
    : " &middot; India VIX not read this build"}</div>

<div class="note ${d.levelsFrozen ? "frozen" : ""}">${freezeNote}</div>

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
    <h2>Futures &mdash; buy per unit, not per lot</h2>
    ${d.watchStatus ? `<div class="sub" style="margin:-4px 0 10px">Watching your ${esc(d.watchStatus.stocks)} stocks
      (${esc(d.watchStatus.source)}): ${esc(d.watchStatus.withFutures)} have an NSE futures contract,
      ${esc(d.watchStatus.shareOnly)} are share-only (removed from F&amp;O)${d.watchStatus.notListed.length
        ? `, and ${esc(d.watchStatus.notListed.length)} have no price yet under that symbol &mdash; merged, renamed or
           misspelt, or history not fetched yet: ${esc(d.watchStatus.notListed.join(", "))}` : ""}.
      ${(() => {
        const bases = new Set((d.futures || []).filter((r) => r.fnoListed).map((r) => r.priceBasis));
        const main = d.futuresAnchor === "CONTRACT" ? "NSE futures contract" : "share price";
        return bases.size > 1
          ? `Levels are anchored on the <b>${main}</b>; rows frozen earlier this session on the other price keep it until the session ends, and each row says which.`
          : `Levels are anchored on the <b>${bases.has("SHARE") ? "share price" : bases.has("CONTRACT") ? "NSE futures contract" : main}</b>.`;
      })()}
      Share-only names stay on the share. The other price is shown under NOW to compare with your platform.</div>` : ""}
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
    ${d.optionsDirection ? `<div class="sub" style="margin:-4px 0 10px">Only on the ${esc(d.optionsDirection.names)} stocks the desk rates BUY or ACCUMULATE &mdash; one side per stock, the side its analysis points to.</div>` : ""}
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
  <b>WHERE THESE PRICES COME FROM.</b> ${liveNote}${forwardNote}${brokerNote}${banNote}
  This page is a <b>snapshot</b>, rebuilt on a schedule &mdash; it is not a live feed.
  <b>Check the price on your broker before placing anything.</b>
  Net figures are after brokerage, STT at 0.15%, exchange, stamp and GST; the
  spread is extra and is only known where a live book was seen.
</div>

<div class="note" style="margin-top:20px;border-left-color:var(--red)">
  <b>WHAT THIS DOES NOT ESTABLISH.</b> That any of it makes money. The paper ledger
  has ${esc(d.track?.summary?.ALL?.resolved ?? 0)} resolved trade(s) so far &mdash; far too few for a measured hit
  rate &mdash; and the one test fixed in advance, on data never used to build the
  rule, did not find an edge. The ranking is built on things that were measured,
  which is not the same as an edge that was proven. Size accordingly.
</div>

</body></html>`;
}

async function main() {
  const data = await build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "data.json"), JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), page(data));
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
