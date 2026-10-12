"use strict";

/**
 * WHAT TAKING EVERY ROW COULD COST ON A BAD DAY.
 *
 * The question a risk desk (BlackRock's Aladdin is the famous one) asks before
 * anything else: not "what can each position lose" but "what do they lose
 * TOGETHER, on the same bad day". Rows on one page are not independent bets --
 * a market fall takes most of them at once -- and the "if every stop is hit"
 * total cannot say how often that happens, or what a gap does to the stops.
 *
 * HOW. Historical simulation, with no fitted model in the loop: today's rows
 * are replayed through every trading day of the last two years of real prices
 * (api/_lib/risk-history.js). Each day moves each row by what its own stock did
 * that day -- the open, the low, the high and the close, relative to the close
 * before -- and each row exits the way the paper ledger scores a trade:
 *   opens at or through the stop    -> out at the open (a gap: no stop fills higher)
 *   opens at or through the target  -> out at the open
 *   low reaches the stop            -> out at the stop (the stop first, if both)
 *   high reaches the target         -> out at the target
 *   otherwise                       -> marked at the close
 * An option is repriced with Black-76 at its own implied volatility, held where
 * it is, one day nearer expiry; a put's worst price is at the day's HIGH.
 * Futures are GM Global's 20 units; calls and puts one lot.
 *
 * WHAT IS LEFT OUT, AND SAID. A stock with under a year of history. Every
 * stock-day that NSE's own filings mark as a demerger, bonus, split or rights
 * ex-date, and any day whose gap is exactly one of that stock's bonus or split
 * ratios (a provider adjustment on the wrong day) -- see nse-corporate-actions.js.
 *
 * WHAT THIS IS NOT: a forecast. It is what these rows would have done on days
 * that already happened. Before charges.
 */

const { europeanOption } = require("./option-pricing");
const { completedRows, MARKET, VIX } = require("./risk-history");

const RISK_FREE = 0.065;   // as the screener prices (contract-screener.js)
const TAIL = 0.05;         // "1 day in 20"
const MIN_SESSIONS = 250;  // about a year of trading days
const GAP_SHOCK = -0.05;   // the market opening 5% lower
const DAY = 1 / 365;

/**
 * THE DAYS ON WHICH A STOCK'S HISTORY IS NOT A PRICE MOVE: its corporate-action
 * ex-dates, and any gap equal to one of its bonus or split ratios.
 */
function contaminatedDays(rows, actions) {
  const out = new Set();
  const ratios = new Map();
  for (const a of actions || []) {
    const i = rows.findIndex((r) => r[0] >= a.exDate);
    if (i >= 0) out.add(rows[i][0]);
    if (Number(a.ratio) > 0) ratios.set(a.exDate, (ratios.get(a.exDate) || 1) * Number(a.ratio));
  }
  const all = [...ratios.values()].filter((r) => Math.abs(Math.log(r)) > 0.04);
  if (all.length) {
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i][1] / rows[i - 1][4];
      if (!(Math.abs(Math.log(gap)) > 0.04)) continue;
      if (all.some((r) => Math.abs(gap / r - 1) < 0.015 || Math.abs(gap * r - 1) < 0.015)) out.add(rows[i][0]);
    }
  }
  return out;
}

/**
 * Each stock's moves by date, [gap, low, high, close] as fractions of the close
 * before, on a calendar shared by every stock -- a move is only kept when the
 * stock also has the calendar's previous session, so a missing bar can never
 * turn two days into one.
 */
function historyIndex({ symbols, historyFor, actionsFor, now = Date.now() }) {
  const rowsBy = new Map();
  for (const symbol of new Set([MARKET, VIX, ...symbols])) {
    const h = historyFor(symbol);
    const rows = h ? completedRows(h.rows, now) : [];
    if (rows.length > 1) rowsBy.set(symbol, rows);
  }
  const count = new Map();
  for (const rows of rowsBy.values()) for (const r of rows) count.set(r[0], (count.get(r[0]) || 0) + 1);
  const quorum = Math.max(1, Math.ceil(rowsBy.size / 2));
  const calendar = [...count.entries()].filter(([, n]) => n >= quorum).map(([d]) => d).sort();
  const previous = new Map(calendar.map((d, i) => [d, i > 0 ? calendar[i - 1] : null]));
  const moves = new Map();
  const contaminated = new Map();
  for (const [symbol, rows] of rowsBy) {
    const bad = symbol === MARKET || symbol === VIX ? new Set() : contaminatedDays(rows, actionsFor(symbol));
    contaminated.set(symbol, bad);
    const byDate = new Map(rows.map((r) => [r[0], r]));
    const m = new Map();
    for (const r of rows) {
      const p = byDate.get(previous.get(r[0]));
      if (!p || bad.has(r[0])) continue;
      const c0 = p[4];
      m.set(r[0], [r[1] / c0 - 1, r[3] / c0 - 1, r[2] / c0 - 1, r[4] / c0 - 1]);
    }
    moves.set(symbol, m);
  }
  return { calendar, moves, contaminated, from: calendar[1] || null, to: calendar[calendar.length - 1] || null };
}

/** OLS slope of a stock's close-to-close moves on the market's, on the days both have. */
function betaOf(stock, market) {
  if (!stock || !market) return null;
  const xs = [], ys = [];
  for (const [d, mv] of stock) {
    const mk = market.get(d);
    if (mk) { xs.push(mk[3]); ys.push(mv[3]); }
  }
  if (xs.length < 100) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : null;
}

/** The exit a day's range gives a row, in the ledger's order (see the header). */
function exitPrice(p, po, pl, ph, pc) {
  if (p.stop !== null && po <= p.stop) return { price: po, how: "GAP_STOP" };
  if (p.target !== null && po >= p.target) return { price: po, how: "GAP_TARGET" };
  if (p.stop !== null && pl <= p.stop) return { price: p.stop, how: "STOP" };
  if (p.target !== null && ph >= p.target) return { price: p.target, how: "TARGET" };
  return { price: pc, how: "CLOSE" };
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A futures row at `units`: price moves one for one with its stock. */
function futuresPosition(r, units) {
  const entry = num(r.buy);
  if (!(entry > 0) || !(units > 0)) return null;
  return { symbol: r.symbol, qty: units, entry, stop: num(r.stop), target: num(r.target1), priceAt: (m) => entry * m };
}

/**
 * A SHORT futures row (12 Oct 2026), as a mirror price q = 2*entry - price: q falls when the stock rises,
 * so the short's P&L is qty * (q - entry) = qty * (entry - price). Its stop (above the entry) becomes a
 * mirror stop below it; `inverse` makes simulate() read the day's high as the mirror's low, as for a put.
 */
function shortFuturesPosition(r, units) {
  const entry = num(r.buy);
  if (!(entry > 0) || !(units > 0)) return null;
  const mirror = (v) => (v === null ? null : 2 * entry - v);
  return { symbol: r.symbol, qty: units, entry, stop: mirror(num(r.stop)), target: mirror(num(r.target1)), inverse: true, priceAt: (m) => entry * (2 - m) };
}

/**
 * An option at one lot -- a call, or a put (c.right "PE") -- repriced with
 * Black-76 at its implied volatility, one day nearer expiry, scaled so that
 * today's model value is exactly the buy price. A put gains as the index FALLS,
 * so its worst price in a day is at the day's HIGH: `inverse` tells simulate()
 * to read the range the other way round.
 */
function callPosition(c) {
  const entry = num(c.buy), F0 = num(c.forward), K = num(c.strike), days = num(c.daysLeft), iv = num(c.iv), lot = num(c.lotSize);
  if (!(entry > 0) || !(F0 > 0) || !(K > 0) || !(days > 0) || !(iv > 0) || !(lot > 0)) return null;
  const type = c.right === "PE" ? "PE" : "CE";
  const T0 = days / 365, T1 = Math.max(0, T0 - DAY), sigma = iv / 100;
  const value = (F, T) => europeanOption({ model: "BLACK76", optionType: type, underlyingPrice: F, strike: K,
    timeToExpiryYears: T, riskFreeRate: RISK_FREE, dividendYield: 0, volatility: sigma }).price;
  const v0 = value(F0, T0);
  // A contract the model values at (nearly) nothing cannot be scaled to its
  // price: 1% of the premium or less would magnify rounding into rupees.
  if (!(v0 > entry * 0.01)) return null;
  const scale = entry / v0;
  return { symbol: c.symbol, qty: lot, entry, stop: num(c.stop), target: num(c.sell), inverse: type === "PE",
    priceAt: (m, v = 1) => scale * europeanOption({ model: "BLACK76", optionType: type, underlyingPrice: F0 * m, strike: K,
      timeToExpiryYears: T1, riskFreeRate: RISK_FREE, dividendYield: 0, volatility: sigma * v }).price };
}

/**
 * Replay every position through every day of the index. Returns rupee figures
 * for the whole set, whole rupees, or { available: false, reason }.
 */
function simulate(positions, index, { tail = TAIL, minSessions = MIN_SESSIONS, gapShock = GAP_SHOCK } = {}) {
  const excluded = [];
  const kept = [];
  for (const p of positions) {
    const n = index.moves.get(p.symbol)?.size || 0;
    if (n >= minSessions) kept.push(p);
    else excluded.push({ symbol: p.symbol, sessions: n });
  }
  if (!kept.length) return { available: false, reason: "no row has a year of price history", excluded };
  const stocks = [...new Set(kept.map((p) => p.symbol))];
  const days = [];
  for (const d of index.calendar) {
    const byStock = new Map();
    let total = 0, exits = { stops: 0, gaps: 0 };
    for (const p of kept) {
      const mv = index.moves.get(p.symbol).get(d);
      if (!mv) continue;
      const [g, l, h, c] = mv;
      // A put's low is at the index's high, and its high at the index's low.
      const out = p.inverse
        ? exitPrice(p, p.priceAt(1 + g), p.priceAt(1 + h), p.priceAt(1 + l), p.priceAt(1 + c))
        : exitPrice(p, p.priceAt(1 + g), p.priceAt(1 + l), p.priceAt(1 + h), p.priceAt(1 + c));
      const pnl = p.qty * (out.price - p.entry);
      total += pnl;
      byStock.set(p.symbol, (byStock.get(p.symbol) || 0) + pnl);
      if (out.how === "STOP") exits.stops += 1;
      if (out.how === "GAP_STOP") exits.gaps += 1;
    }
    if (byStock.size) days.push({ date: d, total, byStock, exits });
  }
  if (days.length < minSessions) return { available: false, reason: `only ${days.length} days of shared history`, excluded };

  const sorted = days.slice().sort((a, b) => a.total - b.total);
  const k = Math.ceil(tail * sorted.length);
  const worstK = sorted.slice(0, k);
  const es = -worstK.reduce((a, x) => a + x.total, 0) / k;
  const contrib = stocks.map((s) => ({ symbol: s, rupees: -worstK.reduce((a, x) => a + (x.byStock.get(s) || 0), 0) / k }))
    .sort((a, b) => b.rupees - a.rupees);
  const breadth = worstK.reduce((a, x) => a + [...x.byStock.values()].filter((v) => v < 0).length / x.byStock.size, 0) / k;
  const worst = sorted[0];
  const marketMoves = index.moves.get(MARKET);
  // HOW MUCH THE MARKET'S IMPLIED VOLATILITY MOVED ON THE WORST DAY. A call is
  // repriced with its volatility held where it is, and on a crash day that
  // volatility jumps (India VIX +65.69% on 7 Apr 2025, NSE), which cushions a
  // call -- so the calls' figures are the pessimistic end. By how much is not
  // measurable here: moving every call's volatility as India VIX moved cut
  // that day's loss from 24.2 lakh to 2.3 lakh (27 Sep 2026), a range too wide
  // to print, because a stock's option volatility does not move with the
  // index's. The page states the direction and India VIX's move, no figure.
  const vixMove = index.moves.get(VIX)?.get(worst.date);
  const vixPct = vixMove ? Math.round(1000 * vixMove[3]) / 10 : null;

  // THE GAP: every stock opens lower (for puts, higher) by its own measured
  // sensitivity to NIFTY times the shock, and stays there. A stop cannot fill
  // better than the open.
  let gap = null;
  if (marketMoves && marketMoves.size >= minSessions) {
    const betas = new Map(stocks.map((s) => [s, betaOf(index.moves.get(s), marketMoves)]));
    const known = [...betas.values()].filter((b) => b !== null).sort((a, b) => a - b);
    if (known.length === stocks.length) {
      let total = 0;
      for (const p of kept) {
        const m = Math.max(0.01, 1 + betas.get(p.symbol) * gapShock);
        total += p.qty * (p.priceAt(m) - p.entry);
      }
      gap = { shockPct: gapShock * 100, rupees: Math.round(total), medianBeta: Math.round(100 * known[Math.floor(known.length / 2)]) / 100 };
    }
  }

  return {
    available: true,
    rows: positions.length, rowsIncluded: kept.length, stocks: stocks.length, excluded,
    days: days.length, from: days[0].date, to: days[days.length - 1].date,
    tailDays: k,
    var: Math.round(-worstK[k - 1].total),
    es: Math.round(es),
    worst: {
      date: worst.date, rupees: Math.round(worst.total),
      stocksDown: [...worst.byStock.values()].filter((v) => v < 0).length, stocksWithData: worst.byStock.size,
      stopsHit: worst.exits.stops + worst.exits.gaps, throughGap: worst.exits.gaps,
      marketPct: marketMoves?.get(worst.date) ? Math.round(10000 * marketMoves.get(worst.date)[3]) / 100 : null,
      vixPct
    },
    fellTogetherPct: Math.round(1000 * breadth) / 10,
    top: contrib.slice(0, 5).map((x) => ({ symbol: x.symbol, rupees: Math.round(x.rupees), sharePct: es > 0 ? Math.round(1000 * x.rupees / es) / 10 : null })),
    contributionsSum: Math.round(contrib.reduce((a, x) => a + x.rupees, 0)),
    // What the same rows lose if every stop fills at its own price, before
    // charges -- the figure a gap day is measured against.
    stopTotal: Math.round(kept.reduce((a, p) => a + (p.stop !== null ? p.qty * (p.entry - p.stop) : 0), 0)),
    gap
  };
}

/**
 * The risk view for the page: futures at `units` each, calls at one lot each.
 * Never throws; a failure is a reason, and the page says it.
 */
function riskView({ futures = [], futuresShort = [], calls = [], puts = [], units = 20, historyFor, actions, now = Date.now() }) {
  try {
    if (!actions || !Array.isArray(actions.rows)) {
      return { available: false, reason: "NSE's corporate-action filings could not be read, so a demerger could not be told from a crash" };
    }
    const bySymbol = new Map();
    for (const a of actions.rows) {
      if (!bySymbol.has(a.symbol)) bySymbol.set(a.symbol, []);
      bySymbol.get(a.symbol).push(a);
    }
    const symbols = [...new Set([...futures, ...futuresShort, ...calls, ...puts].map((r) => r.symbol))];
    const index = historyIndex({ symbols, historyFor, actionsFor: (s) => bySymbol.get(s) || [], now });
    if (!index.calendar.length) return { available: false, reason: "no price history on this build" };
    const side = (rows, make, opts = {}) => {
      if (!rows.length) return null;
      const positions = [], unpriced = [];
      for (const r of rows) {
        const p = make(r);
        if (p) positions.push(p); else unpriced.push(r.symbol);
      }
      const out = positions.length ? simulate(positions, index, opts) : { available: false, reason: "no row could be priced" };
      return { ...out, unpriced };
    };
    return {
      available: true,
      actionsAsOf: actions.fetchedAt || null,
      futures: side(futures, (r) => futuresPosition(r, units)),
      // A short loses when the market RISES: its gap is the market opening 5% higher, as for puts.
      futuresShort: side(futuresShort, (r) => shortFuturesPosition(r, units), { gapShock: -GAP_SHOCK }),
      calls: side(calls, callPosition),
      // A put loses when the market RISES: its gap is the market opening 5% higher.
      puts: side(puts, callPosition, { gapShock: -GAP_SHOCK }),
      units
    };
  } catch (error) {
    return { available: false, reason: `risk view failed: ${error.message}` };
  }
}

module.exports = { riskView, simulate, historyIndex, contaminatedDays, exitPrice, betaOf, futuresPosition, shortFuturesPosition, callPosition, TAIL, MIN_SESSIONS, GAP_SHOCK };
