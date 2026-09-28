"use strict";

/**
 * A HARD WEEK, SIMULATED THROUGH THE REAL DESK AND READ OFF THE REAL PAGE.
 *
 * Asked for, verbatim: "run multiple simulations based on various type normal
 * day volatility then other one is some kind of the news or war or the
 * sentimental one and the other one should be expiry date and other one is one
 * day before expiry date ... not verify it against the backend ... check
 * actually on the website screen it is changing or not."
 *
 * So this does not test functions in isolation. It runs scripts/publish-static-
 * desk.js build() -- the same code the GitHub runner runs -- against a market it
 * controls, renders the same page() the public URL serves, and asserts on the
 * HTML: what a person would actually read. Only the inputs are simulated: the
 * clock, the exchange phase, the option books and the futures quotes. Every
 * formula, gate, freeze, ledger rule and word on the page is the real one.
 *
 * THE WEEK, sized from real events (sources verified 2026-09-23):
 *
 *   Thu 24 Sep  NORMAL          NIFTY +0.3%, implied vol unchanged, 1.5% spreads.
 *                               Pre-open, the freeze at 09:33, two marks, close.
 *   Fri 25 Sep  WAR / NEWS      gap down 5.9% at the open with implied vol x1.5
 *                               -- the size of 4 June 2024, when NIFTY fell 5.9%
 *                               and India VIX touched 31 -- and 5% spreads; at
 *                               13:30 it reaches -10% and the market-wide circuit
 *                               breaker halts all equity and F&O trading.
 *   Mon 28 Sep  EXPIRY EVE      relief rally +3%, implied vol x0.85; the September
 *                               contracts expire tomorrow.
 *   Tue 29 Sep  EXPIRY DAY      the September contracts expire at 15:30.
 *
 * ONE LIMIT OF THIS SIMULATION, stated so it is not mistaken for a result: it
 * moves the clock but not the daily price history on disk, so from Monday the
 * universe refuses most futures on stale bars (STALE_DATA_REFUSAL) -- a guard
 * working correctly. In production the history is refreshed on every build.
 *   Wed 30 Sep  HOLIDAY         the clock says open; the exchange is shut.
 *   and         F&O BAN         a stock on Thursday's list goes into the ban.
 *
 * Every write goes to a temporary folder. Nothing touches docs/ or the ledger.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desk = require("./publish-static-desk");
const brokers = require("../api/_lib/broker-feed");
const live = require("../api/_lib/live-quotes");
const { europeanOption, impliedVolatility } = require("../api/_lib/option-pricing");
const { loadReference } = require("../api/_lib/fno-reference");
const { fnoUniverseEngine } = require("../api/_lib/universe-210");
const nseCheck = require("../api/_lib/nse-crosscheck");

const health = require("./check-desk-health");
const realNow = Date.now;
const realPhase = live.marketPhase;
const REF = loadReference();
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RATE = 0.065;

let passed = 0;
let failed = 0;
const findings = [];
function check(label, ok, detail = "") {
  if (ok) { passed += 1; console.log("    ok    " + label + (detail ? "  (" + detail + ")" : "")); }
  else { failed += 1; findings.push(label + (detail ? " -- " + detail : "")); console.log("    FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

// ---- deterministic randomness (xoshiro128**) ---------------------------------
function rng(seed) {
  let a = seed >>> 0, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  const next = () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9; c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return r / 4294967296;
  };
  for (let i = 0; i < 20; i += 1) next();
  next.normal = () => { let u = 0; while (u === 0) u = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); };
  return next;
}

// ---- the simulated market ------------------------------------------------------
// Each symbol gets a beta and an idiosyncratic shock once, so its path is
// consistent from one build to the next.
const R = rng(2026);
const symbolTraits = new Map();
function traits(symbol) {
  if (!symbolTraits.has(symbol)) symbolTraits.set(symbol, { beta: 0.7 + 0.6 * R(), idio: R.normal() });
  return symbolTraits.get(symbol);
}
const refClose = Date.parse(`${REF.session}T15:30:00+05:30`);
// Last close for every watched share, F&O or not: the settlement file's spot
// where NSE lists derivatives, the price history's close for the share-only rest.
const SHARE_CLOSE = new Map((fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false }) || [])
  .map((r) => [r.symbol, Number(REF.symbols?.[r.symbol]?.underlyingPrice) || Number(r.spotPrice) || null]));

/** Settled implied volatility of one contract, solved once with Black-76. */
const baseVolCache = new Map();
function baseVol(symbol, expiry, strike, type) {
  const key = `${symbol}|${expiry}|${strike}|${type}`;
  if (baseVolCache.has(key)) return baseVolCache.get(key);
  const bucket = REF.symbols?.[symbol]?.expiries?.[expiry];
  const F = Number(bucket?.futuresPrice);
  const price = Number(bucket?.quotes?.[`${strike}|${type}`]?.price);
  const T = (Date.parse(`${expiry}T15:30:00+05:30`) - refClose) / (365 * 86400000);
  let iv = null;
  if (F > 0 && price > 0 && T > 0) {
    const solved = impliedVolatility({ model: "BLACK76", underlyingPrice: F, strike: Number(strike), timeToExpiryYears: T, riskFreeRate: RATE, optionType: type }, price);
    iv = solved?.iv > 0.03 && solved.iv < 2.5 ? solved.iv : null;
  }
  baseVolCache.set(key, iv);
  return iv;
}

/**
 * The state of the market at one build: every futures price and option price
 * the desk could ask for, plus the day's running highs and lows.
 */
function makeMarket(state, dayBook) {
  const forwardOf = (symbol, expiry) => {
    const bucket = REF.symbols?.[symbol]?.expiries?.[expiry];
    const settled = Number(bucket?.futuresPrice);
    if (!(settled > 0)) return null;
    const t = traits(symbol);
    const move = t.beta * state.indexMove + state.idioScale * t.idio;
    return settled * (1 + move);
  };
  const shareOf = (symbol) => {
    const close = SHARE_CLOSE.get(symbol);
    if (!(close > 0)) return null;
    const t = traits(symbol);
    return close * (1 + t.beta * state.indexMove + state.idioScale * t.idio);
  };
  const trueVol = (symbol, expiry, strike, type) => {
    const v = baseVol(symbol, expiry, strike, type);
    if (!v) return null;
    return v * state.ivMult * (type === "PE" && state.indexMove < 0 ? 1.1 : 1);  // skew steepens in a fall
  };
  const optionPrice = (symbol, expiry, strike, type) => {
    const F = forwardOf(symbol, expiry);
    const sigma = trueVol(symbol, expiry, strike, type);
    const T = (Date.parse(`${expiry}T15:30:00+05:30`) - state.clock) / (365 * 86400000);
    if (!(F > 0) || !(sigma > 0) || !(T > 0)) return null;
    const p = europeanOption({ model: "BLACK76", underlyingPrice: F, strike: Number(strike), timeToExpiryYears: T, riskFreeRate: RATE, volatility: sigma, optionType: type }).price;
    return p > 0.05 ? p : null;
  };
  const tick = (x) => Math.round(x / 0.05) * 0.05;
  const feedStamp = (ms) => {
    const d = new Date(ms + 330 * 60_000);
    return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTH[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
  };
  const withRange = (key, price) => {
    const rec = dayBook.get(key) || { open: price, high: price, low: price };
    // A little movement between builds, so the day's range is wider than the marks.
    rec.high = Math.max(rec.high, price * (1 + 0.004));
    rec.low = Math.min(rec.low, price * (1 - 0.004));
    dayBook.set(key, rec);
    return rec;
  };
  const feedAt = state.halted ? state.haltedAt : state.clock - 2000;
  return {
    forwardOf, shareOf, trueVol, optionPrice,
    book(symbol, expiry, strike, type) {
      if (state.halted || state.noBooks || state.restampFeed) return null;
      const p = optionPrice(symbol, expiry, strike, type);
      if (!(p > 0)) return null;
      const half = Math.max(0.05, tick(p * state.spreadPct / 2));
      return { bid: Math.max(0.05, tick(p - half)), ask: tick(p + half), exchangeFeedTime: feedStamp(feedAt) };
    },
    quotes(list) {
      const out = {};
      if (state.noBooks) return out;
      for (const c of list) {
        const key = brokers.contractKey(c);
        const price = c.kind === "EQ" ? shareOf(c.symbol)
          : c.kind === "FUT" ? forwardOf(c.symbol, c.expiry)
          : optionPrice(c.symbol, c.expiry, c.strike, c.optionType);
        if (!(price > 0)) continue;
        const rng2 = withRange(key, price);
        out[key] = { key, ltp: +price.toFixed(2), open: +rng2.open.toFixed(2), high: +rng2.high.toFixed(2), low: +rng2.low.toFixed(2),
          // restampFeed: Angel One re-stamps its feed the morning after a session
          // ("26-Sep-2026 06:55" on the weekend of 27 Sep) while the last TRADE
          // stays on the session that traded.
          previousClose: +rng2.open.toFixed(2),
          exchangeFeedTime: state.restampFeed ? feedStamp(Date.parse(`${state.restampFeed}T06:55:00+05:30`)) : feedStamp(feedAt),
          // Angel sends the last TRADE time too; a quote here is a trade at the feed time.
          exchangeTradeTime: state.restampFeed ? feedStamp(Date.parse(`${state.lastTradeDay}T15:29:00+05:30`)) : feedStamp(feedAt),
          tradingSymbol: key.replace(/\|/g, "") };
      }
      return out;
    }
  };
}

// ---- two years of history for the risk view ------------------------------------
// Every name a seeded walk on a common market move, so the rows fall together
// on the bad days as real ones do. Deterministic, and nothing from this
// machine's own cache: the page's risk figures come from these series alone.
const RISK_DAYS = (() => {
  const out = [];
  let t = Date.parse("2026-09-23T00:00:00Z");
  while (out.length < 320) {
    const day = new Date(t);
    if (![0, 6].includes(day.getUTCDay())) out.unshift(day.toISOString().slice(0, 10));
    t -= 86_400_000;
  }
  return out;
})();
const RISK_MARKET = (() => { const r = rng(4242); return RISK_DAYS.map(() => 0.009 * r.normal()); })();
const riskSeries = new Map();
function simHistory(symbol) {
  if (!riskSeries.has(symbol)) {
    const r = rng([...String(symbol)].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 17));
    const beta = 0.6 + 0.8 * r();
    const rows = [];
    let close = 100 + 900 * r();
    RISK_DAYS.forEach((day, i) => {
      const move = beta * RISK_MARKET[i] + 0.012 * r.normal();
      const open = close * (1 + move * (0.3 + 0.4 * r()));
      const next = close * (1 + move);
      rows.push([day, open, Math.max(open, next) * (1 + 0.004 * r()), Math.min(open, next) * (1 - 0.004 * r()), next]);
      close = next;
    });
    riskSeries.set(symbol, { rows });
  }
  return riskSeries.get(symbol);
}
const SIM_RISK = { riskHistoryFor: simHistory, riskActions: { ok: true, fetchedAt: "2026-09-23T12:00:00Z", rows: [] } };

// ---- driving the real build ----------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-scenarios-"));
const LEDGER_FILE = path.join(tmp, "levels.json");
const LEDGER_DIR = path.join(tmp, "ledger");
const PAGES = path.join(tmp, "pages");
fs.mkdirSync(PAGES, { recursive: true });

async function runBuild(name, state, dayBook, { banned = null, ledgerFile = LEDGER_FILE, ledgerDir = LEDGER_DIR, risk = SIM_RISK } = {}) {
  const market = makeMarket(state, dayBook);
  // The clock MOVES while a build runs, a millisecond per reading, as a real
  // one does. A clock that stood still hid the 2026-09-24 bug: the ledger was
  // opened, then the levels frozen a few seconds later, and 37 trades were
  // stamped filled before they were shown. With a frozen clock the two moments
  // were identical and nothing could be seen.
  let ticks = 0;
  Date.now = () => state.clock + (ticks += 1);
  live.marketPhase = (n) => realPhase(n ?? state.clock);
  live.liveQuote = (s, e, k, t) => market.book(s, e, k, t);
  brokers.contractQuotes = async (list) => {
    const quotes = market.quotes(list || []);
    return { ok: Object.keys(quotes).length > 0, quotes, requested: (list || []).length, resolved: (list || []).length, failures: [] };
  };
  // NSE's own site, simulated from the same market: the real comparison
  // (compareOne, summarise) on figures NSE would show. The network layer is
  // covered by scripts/test-nse-crosscheck.js. state.nseWrong makes NSE report
  // a different previous close for the first sampled contract -- a wrong
  // contract; state.nseDown makes NSE unreachable.
  nseCheck.crossCheck = async (reqs, opts) => {
    if (state.nseDown) return { checked: false, reason: "NSE not reached: simulated outage", sampled: reqs.length };
    const ours = await opts.ours(reqs);
    const rows = reqs.map((r, i) => {
      const q = market.quotes([r])[brokers.contractKey(r)] || null;
      const nse = q ? { last: q.ltp, prevClose: state.nseWrong && i === 0 ? q.previousClose + 5 : q.previousClose } : null;
      return nseCheck.compareOne(r, ours[i], nse, opts.session);
    });
    const at = new Date(state.clock).toISOString();
    return nseCheck.summarise(rows, { angelAt: at, nseAt: at, nseErrors: [] });
  };
  const savedBan = fnoUniverseEngine.banned;
  if (banned) fnoUniverseEngine.banned = new Set([...(savedBan || []), ...banned]);
  let data;
  try {
    data = await desk.build({ ledgerFile, ledgerDir, ...risk });
  } finally {
    fnoUniverseEngine.banned = savedBan;
  }
  const html = desk.page(data).replace("<body>",
    '<body><div style="background:#ff5252;color:#000;font:700 14px monospace;padding:10px;margin:-14px -14px 14px">'
    + "SIMULATION &mdash; " + name + " &mdash; NOT REAL PRICES</div>");
  const file = path.join(PAGES, name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".html");
  fs.writeFileSync(file, html);
  return { data, html, market, file };
}

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ");
const tabCount = (html, cls) => {
  const m = html.match(new RegExp(`<label for="v-[a-z]+" class="${cls}">[A-Z]+ <span>(\\d+)</span>`));
  return m ? Number(m[1]) : null;
};
const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);

(async () => {
  console.log("simulated week, through the real build and the real page");
  console.log("  settlement file the market starts from:", REF.session, "\n");
  let dayBook = new Map();
  let frozenBuysDay1 = null;

  // ======================== Thu 24 Sep: NORMAL =================================
  const normal = { indexMove: 0.003, idioScale: 0.006, ivMult: 1.0, spreadPct: 0.015 };
  console.log("Thu 24 Sep -- NORMAL DAY");
  {
    const pre = await runBuild("thu-0913-pre-open", { ...normal, clock: ist("2026-09-24", "09:13") }, dayBook);
    console.log("  09:13 pre-open");
    check("before the bell nothing is frozen, and the page says INDICATIVE", pre.data.levelsFrozen === false && /INDICATIVE, NOT FIXED/.test(pre.html));
    check("the track record records nothing before the bell", (pre.data.track?.tally?.added ?? 0) === 0);
    check("before the bell on a trading day the header names today's session, never \"no session today\"",
      /session 2026-09-24/.test(pre.html) && !/no session today/.test(pre.html), (pre.html.match(/Built [^<]{0,120}/) || [""])[0]);
    check("before the bell every option is priced against the SETTLEMENT forward, the same moment as its premium",
      pre.data.options.length > 0 && pre.data.options.every((c) => c.forwardSource === "SETTLEMENT"),
      `${pre.data.options.length} options`);

    const b = await runBuild("thu-0933-normal-freeze", { ...normal, clock: ist("2026-09-24", "09:33") }, dayBook);
    const d = b.data;
    console.log(`  09:33 the freeze  -> ${d.futures.length} futures, ${tabCount(b.html, "t-ce")} calls, ${tabCount(b.html, "t-pe")} puts`);
    check("at 09:33 with live books the levels FREEZE and the page says so", d.levelsFrozen === true && /FIXED FOR TODAY/.test(b.html));
    check("the page has all four tabs with rows in them",
      tabCount(b.html, "t-fut") > 0 && tabCount(b.html, "t-ce") + tabCount(b.html, "t-pe") > 0 && /class="t-trk"/.test(b.html));
    // Implied volatility on the page against the volatility the market was built with.
    const errs = d.options.map((c) => {
      const truth = b.market.trueVol(c.symbol, c.expiry, c.strike, c.right);
      return truth ? Math.abs(Number(c.iv) / 100 - truth) * 100 : null;
    }).filter((x) => x !== null);
    const worstIv = Math.max(...errs);
    check("every option's implied vol on the page is the market's own, to half a point", errs.length > 0 && worstIv < 0.5,
      `worst ${worstIv.toFixed(2)} vol pts over ${errs.length} options`);
    check("every option priced against the LIVE forward, none against yesterday's", d.options.every((c) => c.forwardSource === "LIVE"));
    // BAD-DAY RISK on both tabs (api/_lib/risk-view.js), from the simulated history.
    const futPane = b.html.split('class="pane pane-fut"')[1].split('class="pane pane-ce"')[0];
    const cePane = b.html.split('class="pane pane-ce"')[1].split('class="pane pane-pe"')[0];
    const rf = d.risk?.futures, rc = d.risk?.calls;
    check("the futures tab carries the bad-day risk in rupees: 1 day in 20, the worst day, the market opening 5% lower",
      /BAD-DAY RISK<\/b>, every row together &mdash; 1 day in 20: <b class="down amt">−₹[\d,]+<\/b> or worse/.test(futPane)
        && /worst day: <b class="down amt">−₹[\d,]+<\/b>/.test(futPane) && /market opens 5% lower: <b class="down amt">−₹[\d,]+<\/b>/.test(futPane),
      rf ? `1-in-20 ${rf.var}, worst ${rf.worst?.rupees}, gap ${rf.gap?.rupees}` : JSON.stringify(d.risk).slice(0, 160));
    check("so does the calls tab, one lot each", rc?.available === true && /BAD-DAY RISK<\/b>, every row together/.test(cePane) && /one lot each/.test(cePane),
      rc ? `${rc.rowsIncluded} of ${rc.rows} calls` : "none");
    check("the calls' risk says its figures are the pessimistic end, with India VIX's move on the worst day and no invented second figure",
      /For calls these figures are the pessimistic end/.test(cePane) && /India VIX moved [+−]?\d+%/.test(cePane) && !/read the two as a range/.test(cePane)
        && !/For calls these figures/.test(futPane), String(rc.worst.vixPct));
    check("percentages in the risk box carry a real minus sign, never a hyphen", !/NIFTY -\d/.test(b.html) && !/VIX moved -\d/.test(b.html));
    check("nowhere on the page is a number written with a hyphen for its minus",
      !/(?<![\w-])-\d[\d.,]*%/.test(text(b.html).replace(/\d{4}-\d{2}-\d{2}/g, "")), (text(b.html).match(/.{0,30}(?<![\w-])-\d[\d.,]*%.{0,10}/) || [""])[0]);
    check("every futures row and every call is in it (the simulated history covers every name)",
      rf?.rowsIncluded === d.futures.length && rc?.rowsIncluded === d.options.filter((x) => x.right === "CE").length,
      `${rf?.rowsIncluded}/${d.futures.length} futures, ${rc?.rowsIncluded} calls`);
    check("the stocks' shares of the bad days add up to the bad days' average loss", Math.abs(rf.contributionsSum - rf.es) <= 1 && Math.abs(rc.contributionsSum - rc.es) <= 1);
    check("the worst day is at least as bad as the 1-in-20 day, which is a loss", rf.worst.rupees <= -rf.var && rf.var > 0 && rc.var > 0);
    check("the freeze headline stays on screen; only its explanation folds",
      /<summary><b>BUY, SELL AND STOP ARE FIXED FOR TODAY<\/b>/.test(b.html) && /<details class="fold">/.test(b.html));
    // The anchor is the NSE futures CONTRACT (the user's platform quotes it
    // exactly, measured 2026-09-24); share-only names stay on the share.
    const f = d.futures.find((x) => x.fnoListed) || d.futures[0];
    const liveFut = b.market.forwardOf(f.symbol, f.expiry);
    check(`futures NOW is the live CONTRACT price (${f.symbol})`, Math.abs(f.spot - liveFut) < 0.02, `page ${f.spot} vs market ${liveFut.toFixed(2)}`);
    check(`${f.symbol}'s buy limit is 0.8% under that price, rounded DOWN to its tick (${f.tick})`,
      f.buy <= liveFut * 0.992 + 1e-6 && liveFut * 0.992 - f.buy < (f.tick || 0.05) + 1e-6, `${f.buy} vs ${(liveFut * 0.992).toFixed(2)}`);
    check("that NOW price is printed on the page", b.html.includes(Number(f.spot).toLocaleString("en-IN")));
    check("futures NOW is labelled live, with its time", /futures, live at \d\d:\d\d/.test(b.html));
    check(`and the share's own price is shown beside it for comparison (${f.symbol})`,
      f.referenceKind === "share" && Math.abs(f.referencePrice - b.market.shareOf(f.symbol)) < 0.02, `share ${f.referencePrice}`);
    check("every F&O row is anchored on its contract, every share-only row on the share",
      d.futures.every((x) => x.priceBasis === (x.fnoListed ? "CONTRACT" : "SHARE")),
      JSON.stringify(d.futures.reduce((a, x) => (a[`${x.fnoListed ? "F&O" : "share-only"}:${x.priceBasis}`] = (a[`${x.fnoListed ? "F&O" : "share-only"}:${x.priceBasis}`] || 0) + 1, a), {})));
    const shareOnly = d.futures.filter((x) => x.fnoListed === false);
    check("share-only names are watched and never given an invented futures symbol",
      shareOnly.every((x) => !x.tradingSymbol) && /no NSE futures contract/.test(b.html) || shareOnly.length === 0,
      `${shareOnly.length} share-only rows`);
    // ONE SIDE PER STOCK (user decision 2026-09-25): calls only, and only on
    // the names the desk rates BUY or ACCUMULATE; its measured short side loses.
    const buyNames = new Set(fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false })
      .filter((r) => r.action === "BUY" || r.action === "ACCUMULATE").map((r) => r.symbol));
    check("every option on the page is a CALL on a stock the desk rates BUY or ACCUMULATE",
      d.options.length > 0 && d.options.every((x) => x.right === "CE" && buyNames.has(x.symbol)),
      `${d.options.length} options, ${d.options.filter((x) => x.right === "PE").length} puts, ${d.options.filter((x) => !buyNames.has(x.symbol)).length} off-view`);
    check("and the PUTS tab says why it is empty, instead of just being blank", /No puts, by design/.test(b.html));
    // THE MONEY ON A ROW COMES FROM THAT ROW'S OWN LEVELS (25 Sep: ASTRAL showed
    // cost at the live price beside a frozen buy), and in the user's real sizes.
    check("every option's cost per lot is its own buy x lot, and the loss at its stop is shown",
      d.options.every((x) => Math.abs(x.costPerLot - Math.round(x.buy * x.lotSize * 100) / 100) < 0.01 && x.netLossAtStop < 0 && x.netProfit > 0),
      `${d.options.filter((x) => Math.abs(x.costPerLot - Math.round(x.buy * x.lotSize * 100) / 100) >= 0.01).length} rows off`);
    const odds = require("../api/_lib/trade-odds");
    const offTarget = d.options.filter((x) => {
      const t = odds.timeToTarget({ spot: x.forward, target: x.right === "CE" ? x.strike + x.sell : x.strike - x.sell, volatility: x.rv / 100, daysAvailable: x.daysLeft });
      return !t || Math.abs(t.probabilityOfTouchPct - x.touchPct) > 0.11;
    });
    check("every option's P(TOUCH) is the chance of reaching ITS OWN sell price", d.options.length > 0 && offTarget.length === 0, `${offTarget.length} rows off`);
    check("every option's DECAY is a real share of its own buy (0-100%)",
      d.options.every((x) => Number.isFinite(x.thetaBurnPct) && x.thetaBurnPct > 0 && x.thetaBurnPct < 100),
      d.options.filter((x) => !(x.thetaBurnPct > 0 && x.thetaBurnPct < 100)).map((x) => x.display + " " + x.thetaBurnPct).slice(0, 3).join("; "));
    check("every futures row shows GM's 20-unit minimum: capital, loss at stop, gain at target",
      d.futures.every((x) => x.minUnits === 20 && Math.abs(x.minCapital - Math.round(x.buy * 20 * 100) / 100) < 0.02
        && Math.abs(x.minLossAtStop - Math.round((x.buy - x.stop) * 20 * 100) / 100) < 0.02 && x.minGainAtTarget > 0)
        && /GM MIN \(20 UNITS\)/.test(b.html));
    // WHAT A ROW NEEDS TO PAY, and what taking all of them risks (Global Trading
    // Atlas 28-29: expectancy, not win rate; a stop is not a loss cap; rows in
    // one sector fall together).
    const be = (loss, win) => Math.round(1000 * loss / (win + loss)) / 10;
    const beOff = [
      ...d.futures.filter((x) => !(Math.abs(x.breakEvenPct - be(x.buy - x.stop, x.target1 - x.buy)) < 0.051)),
      ...d.options.filter((x) => !(Math.abs(x.breakEvenPct - be(Math.abs(x.netLossAtStop), x.netProfit)) < 0.051))
    ];
    check("every row says the win rate it needs to break even, worked from its own levels",
      d.futures.length > 0 && d.options.length > 0 && beOff.length === 0
        && (b.html.match(/needs [\d.]+% wins to break even/g) || []).length === d.futures.length + d.options.length,
      `${beOff.length} rows off`);
    // EXPECTANCY, NOT TOUCH ODDS: the odds that ignore the stop say so, and
    // each tab says what the rows are worth if prices have no trend.
    check("touch odds that ignore the stop say so, on every futures and option row",
      (b.html.match(/ignores the stop/g) || []).length >= d.options.length + d.futures.filter((x) => x.expected?.target).length);
    check("each tab says what its rows are worth with no trend: futures at break-even, calls about minus their charges",
      /target comes before its stop at most as often as its break-even/.test(b.html) && /a call is expected to lose about its charges/.test(b.html)
        && d.options.every((x) => x.noTrendNet < 0), `${d.options.filter((x) => !(x.noTrendNet < 0)).length} option rows without it`);
    check("each tab totals every row -- the capital, and the loss if every stop is hit -- and warns a gap can cost more",
      (b.html.match(/If you take every row here/g) || []).length === 2 && /more if prices gap through the stops/.test(b.html)
        && /Rows in one sector tend to fall together/.test(b.html));
    const onTick = (v, t) => t > 0 && Math.abs(Math.round(v / t) * t - v) < 1e-6;
    const offGrid = [...d.options.filter((x) => ![x.buy, x.sell, x.stop].every((v) => onTick(v, x.tick))).map((x) => x.display),
      ...d.futures.filter((x) => ![x.buy, x.target1, x.target2, x.stop].every((v) => onTick(v, x.tick))).map((x) => x.symbol)];
    check("every buy, target and stop is on its contract's exchange tick -- an order the broker accepts",
      d.options.length > 0 && d.futures.length > 0 && offGrid.length === 0, offGrid.slice(0, 4).join(", "));
    const fcd = d.feedCheck || {};
    check("the build checks a sample of its own rows against NSE -- 4 futures, 12 options -- and each is the same contract",
      fcd.checked === true && fcd.identityCompared === Math.min(4, d.futures.length) + Math.min(12, d.options.length)
        && fcd.wrongContract.length === 0 && /Checked against NSE's own site/.test(b.html) && !/DO NOT TRADE THESE ROWS/.test(b.html),
      JSON.stringify({ ...fcd, rows: undefined }));
    const o = d.options[0];
    check(`option names read like the broker's search (${o.display})`, /^[A-Z&-]+ [A-Z]{3} \d+(\.\d+)? (CE|PE)$/.test(o.display) || /\(weekly\)/.test(o.display));
    check("every stock option carries an exit-by date before its expiry",
      d.options.filter((c) => !["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(c.symbol)).every((c) => c.exitBy && c.exitBy < c.expiry));
    check("nothing on the page expires inside a week", d.options.every((c) => c.daysLeft >= 7));
    check("every frozen level became a paper trade", d.track.tally.added === d.options.length + d.futures.filter((x) => x.frozen).length,
      `${d.track.tally.added} recorded`);
    // NO CAP: every contract that cleared every gate is on the page (the page
    // once kept 40 of 162 beside a header saying 162 had cleared).
    check("every contract that cleared every gate is on the page -- none held back by a row limit",
      d.options.length === d.survived && d.survived > 40, `${d.options.length} shown of ${d.survived} cleared`);
    const strikesOf = new Map();
    d.options.forEach((c, i) => strikesOf.set(c.symbol, [...(strikesOf.get(c.symbol) || []), i]));
    check("each stock's strikes sit together, and every extra strike says it is the same bet",
      [...strikesOf.values()].every((ix) => ix[ix.length - 1] - ix[0] === ix.length - 1)
        && (b.html.match(/another strike of/g) || []).length === d.options.length - strikesOf.size,
      `${strikesOf.size} stocks, ${(b.html.match(/another strike of/g) || []).length} marks`);
    frozenBuysDay1 = new Map(d.futures.map((x) => [x.symbol, x.buy]));
  }
  {
    const later = { ...normal, indexMove: -0.004 };
    const b = await runBuild("thu-1313-afternoon", { ...later, clock: ist("2026-09-24", "13:13") }, dayBook);
    console.log("  13:13 the market dips 0.7% from the morning");
    const moved = b.data.futures.filter((x) => frozenBuysDay1.has(x.symbol) && x.buy !== frozenBuysDay1.get(x.symbol));
    check("not one buy limit moved after the freeze", moved.length === 0, moved.map((x) => x.symbol).join(", "));
    const nowChanged = b.data.futures.some((x) => x.spot !== x.anchor);
    check("but the NOW column did move with the market", nowChanged);
    // The fill estimate is for NOW: from the live price to the frozen buy, with
    // the session that is left -- not the 09:33 figure carried all day.
    const ledgerMath = require("./paper-ledger");
    const staleFill = b.data.futures.filter((x) => x.expected?.sigmaPct).filter((x) => {
      if (x.spot <= x.buy) return !x.expected.fill?.atLimit;
      const live = ledgerMath.firstPassage({ from: x.spot, to: x.buy, sigma: x.expected.sigmaPct / 100, tradingDays: ledgerMath.sessionTradingDaysLeft(ist("2026-09-24", "13:13")) });
      return !x.expected.fill || Math.abs(x.expected.fill.probabilityPct - live.probabilityPct) > 0.5;
    });
    check("the futures fill estimate is recomputed from the live price, not carried from the freeze", staleFill.length === 0,
      `${staleFill.length} stale`);
    check("fill states update on the page (at least one futures limit now reached)", /AT OR BELOW LIMIT|AT THE LIMIT/.test(b.html.split('class="pane pane-fut"')[1] || ""));
    const fills = b.data.track.open.filter((t) => t.kind === "FUT" && t.status === "OPEN").length;
    check("the dip filled some futures limits in the ledger", fills > 0, `${fills} filled`);
  }
  {
    const b = await runBuild("thu-1553-after-close", { ...normal, indexMove: -0.004, clock: ist("2026-09-24", "15:53") }, dayBook);
    const unfilled = b.data.track.recentClosed.filter((t) => t.status === "UNFILLED").length;
    console.log("  15:53 after the close");
    check("futures limits never reached are UNFILLED at 15:30, not carried as orders", unfilled >= 0 && b.data.track.open.every((t) => t.status !== "WAITING"),
      `${unfilled} unfilled`);
    check("the TRACK tab shows them", /UNFILLED/.test(b.html));
    // After the close the day's levels are history; every row is a preview for
    // the next session, and none of them says WAITING as if it were an order.
    const bd = b.data;
    check("after the close no row is shown as today's live order: all previews, for the next session",
      bd.sessionOver === true && bd.nextSession === "2026-09-25" && bd.futures.every((x) => !x.frozen) && bd.options.every((x) => !x.frozen)
        && /THE SESSION IS OVER/.test(b.html) && /PREVIEW, not an order/.test(b.html)
        && !/WAITING &mdash; needs|WAITING — needs/.test(b.html.split('class="pane pane-trk"')[0]),
      `sessionOver ${bd.sessionOver}, next ${bd.nextSession}, frozen ${bd.futures.filter((x) => x.frozen).length + bd.options.filter((x) => x.frozen).length}`);
  }

  // ======================== Fri 25 Sep: WAR / NEWS ==============================
  console.log("\nFri 25 Sep -- WAR / NEWS SHOCK: gap down 5.9%, implied vol x1.5, circuit breaker at 13:30");
  dayBook = new Map();
  const shock = { indexMove: -0.059, idioScale: 0.02, ivMult: 1.5, spreadPct: 0.05 };
  {
    const openBefore = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, "open.json"), "utf8")).trades.filter((t) => t.kind === "FUT" && t.status === "OPEN");
    const b = await runBuild("fri-0933-war-shock", { ...shock, clock: ist("2026-09-25", "09:33") }, dayBook);
    const d = b.data;
    console.log(`  09:33 -> ${d.futures.length} futures, ${tabCount(b.html, "t-ce")} calls, ${tabCount(b.html, "t-pe")} puts`);
    const gapStops = d.track.recentClosed.filter((t) => t.kind === "FUT" && t.status === "STOP" && openBefore.some((o) => o.id === t.id));
    check("yesterday's open futures are stopped by the gap", openBefore.length === 0 || gapStops.length > 0, `${gapStops.length} of ${openBefore.length}`);
    check("a gap through the stop exits at the OPEN, below the stop -- the real loss, not the planned one",
      gapStops.every((t) => t.exitPrice <= t.stop), gapStops.slice(0, 2).map((t) => `${t.contract} stop ${t.stop} exit ${t.exitPrice}`).join("; "));
    const errs = d.options.map((c) => {
      const truth = b.market.trueVol(c.symbol, c.expiry, c.strike, c.right);
      return truth ? Math.abs(Number(c.iv) / 100 - truth) * 100 : null;
    }).filter((x) => x !== null);
    check("implied vol on a shock day is still the market's own, to half a point", errs.length > 0 && Math.max(...errs) < 0.5,
      `worst ${Math.max(...errs).toFixed(2)} over ${errs.length}`);
    // What the OLD code would have printed: yesterday's forward, spot BSM.
    const sample = d.options.slice(0, 20).map((c) => {
      const bucket = REF.symbols[c.symbol].expiries[c.expiry];
      const old = impliedVolatility({ model: "BSM", dividendYield: 0, underlyingPrice: Number(bucket.futuresPrice), strike: c.strike,
        timeToExpiryYears: c.daysLeft / 365, riskFreeRate: RATE, optionType: c.right }, c.buy);
      const truth = b.market.trueVol(c.symbol, c.expiry, c.strike, c.right);
      return old?.iv > 0 && truth ? Math.abs(old.iv - truth) * 100 : null;
    }).filter((x) => x !== null);
    const oldWorst = sample.length ? Math.max(...sample) : null;
    console.log(`         the OLD code on this morning: implied vol off by up to ${oldWorst === null ? "n/a (most would not even solve)" : oldWorst.toFixed(1) + " vol points"}`);
    check("levels freeze again on the GAPPED prices, not yesterday's",
      d.levelsFrozen && d.futures.filter((x) => x.frozen).every((x) => Math.abs(x.anchor
        - (x.priceBasis === "CONTRACT" ? b.market.forwardOf(x.symbol, x.expiry) : b.market.shareOf(x.symbol))) < 0.05));
    const frozenFri = new Map(d.futures.map((x) => [x.symbol, x.buy]));

    // 13:30 the war escalates: NIFTY down 10% on the day, the market-wide
    // circuit breaker halts ALL equity and F&O trading (NSE, SEBI). Books vanish;
    // the last prints freeze at 13:30. A build lands at 13:45, inside the halt.
    const halted = await runBuild("fri-1345-circuit-breaker-halt", { ...shock, indexMove: -0.10, ivMult: 1.9,
      clock: ist("2026-09-25", "13:45"), halted: true, haltedAt: ist("2026-09-25", "13:30") }, dayBook);
    console.log(`  13:45 -> NIFTY -10%, market-wide circuit breaker since 13:30; ${halted.data.futures.length} futures on the page`);
    check("there ARE futures on the page to judge (not an empty pass)", halted.data.futures.length > 0, `${halted.data.futures.length} rows`);
    check("during the halt not one futures price is called live", halted.data.futures.length > 0 && halted.data.futures.every((x) => !/_LIVE$/.test(x.nowSource)));
    check("the page says NOT live, with the time of the last trade", /NOT live at 13:30/.test(halted.html));
    const held = halted.data.futures.filter((x) => frozenFri.has(x.symbol));
    check("levels frozen at 09:33 are held through the halt", held.length > 0 && held.every((x) => x.buy === frozenFri.get(x.symbol)), `${held.length} compared`);
    // The login is pinned OK here so the alarm has to come from the prices, not
    // from whatever broker-check file this machine happens to hold.
    const alarm = health.checkLivePath({ ...halted.data, brokerCheck: { ok: true } }, ist("2026-09-25", "13:45"));
    check("the production gate turns this run RED -- nothing is live in market hours, and somebody must hear it",
      alarm.inSession && alarm.problems.length > 0, alarm.problems[0] || "no alarm");
    const calm = health.checkLivePath({ ...d, brokerCheck: { ok: true } }, ist("2026-09-25", "09:53"));
    check("while the same gate stays green on the morning's live build", calm.problems.length === 0, calm.problems[0] || "green");
  }

  // ======================== Mon 28 Sep: EXPIRY EVE ==============================
  console.log("\nMon 28 Sep -- EXPIRY EVE (September contracts expire tomorrow), relief rally +3%");
  dayBook = new Map();
  {
    // Monday's levels freeze on the SHARE -- the basis before 2026-09-25 --
    // so that the switch to the contract can be tested mid-session below.
    process.env.K2_FUTURES_ANCHOR = "SHARE";
    let b;
    try {
      b = await runBuild("mon-0933-expiry-eve", { indexMove: -0.029, idioScale: 0.01, ivMult: 0.85, spreadPct: 0.02, clock: ist("2026-09-28", "09:33") }, dayBook);
    } finally {
      delete process.env.K2_FUTURES_ANCHOR;
    }
    const sepRows = [...b.data.options, ...b.data.futures].filter((x) => String(x.expiry) === "2026-09-29");
    console.log(`  09:33 -> ${b.data.futures.length} futures, ${b.data.options.length} options`);
    check("nothing expiring tomorrow is on the page", sepRows.length === 0, `${sepRows.length} found`);
    check("the futures shown are the NEXT month's", b.data.futures.length > 0 && b.data.futures.every((x) => String(x.expiry) > "2026-09-29"),
      `${b.data.futures.length} rows`);
    // The simulation moves the clock but not the history on disk, so how many
    // rows are stale here depends on the day the history was last fetched.
    // What must hold whatever that day is: the guard refuses EXACTLY the rows
    // whose bars are more than five days old at this clock -- no more, no fewer.
    // (This used to assert that most rows were refused, which was only true
    // while the build never refreshed history; it has since 2026-09-24.)
    const STATUS_BEFORE_STALE = ["SEBI_FO_BAN", "NO_OBSERVED_PRICE", "NO_MARKET_HISTORY"];
    const judged = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false })
      .filter((r) => !STATUS_BEFORE_STALE.includes(r.status || r.finalStatus));
    const staleRows = judged.filter((r) => (r.barsAgeDays || 0) > 5);
    const misjudged = judged.filter((r) => ((r.barsAgeDays || 0) > 5) !== ((r.status || r.finalStatus) === "STALE_DATA_REFUSAL"));
    check("the stale-history guard refuses exactly the rows older than five days, no more and no fewer",
      judged.length > 100 && misjudged.length === 0, `${staleRows.length} stale of ${judged.length} judged, ${misjudged.length} misjudged`);
    check("the page shows the October exit-by date, Wednesday 21 October", /exit (or roll )?by Wed 21 Oct/.test(b.html));

    // THE SWITCH, MID-SESSION. The desk now anchors on the contract, but the
    // levels frozen at 09:33 on the share are carried until the session ends.
    // A carried row must stay on the instrument it froze on -- NOW included --
    // or a futures price is set against a share-price limit.
    const sw = await runBuild("mon-1113-anchor-switched", { indexMove: -0.029, idioScale: 0.01, ivMult: 0.85, spreadPct: 0.02, clock: ist("2026-09-28", "11:13") }, dayBook);
    const carried = sw.data.futures.filter((x) => x.frozen && x.fnoListed);
    check("after the switch, rows frozen on the share keep the share basis, NOW included",
      carried.length > 0 && carried.every((x) => x.priceBasis === "SHARE" && /^SHARE_/.test(x.nowSource)
        && Math.abs(x.spot - sw.market.shareOf(x.symbol)) < 0.02 && x.referenceKind === "future"),
      `${carried.length} carried rows`);
    check("and their levels did not move", carried.every((x) => x.buy === (b.data.futures.find((y) => y.symbol === x.symbol) || {}).buy));
    check("the page says the share basis for those rows, not the new default",
      /anchored on the <b>share price<\/b>/.test(sw.html) && /levels on the share price/.test(sw.html));
  }

  // ======================== F&O BAN =============================================
  // On Monday, while the history on disk is still recent enough for the desk to
  // hold views: with options shown only where it has one, a day on which every
  // name is refused as stale has nothing on the page to ban.
  console.log("\nF&O BAN -- Monday afternoon, a stock on the page enters the ban");
  {
    const probe = await runBuild("ban-probe", { ...normal, clock: ist("2026-09-28", "13:33") }, new Map());
    const target = probe.data.options[0]?.symbol || probe.data.futures[0]?.symbol;
    check("the stock chosen for the ban really was on the page first", Boolean(target), target || "none");
    const b = await runBuild("ban-applied", { ...normal, clock: ist("2026-09-28", "13:40") }, new Map(), { banned: [target] });
    const leaked = [...b.data.options, ...b.data.futures].filter((x) => x.symbol === target);
    check(`${target} in the ban appears nowhere on the page`, leaked.length === 0 && !new RegExp(`>${target} `).test(b.html.split('class="pane pane-trk"')[0]),
      `${leaked.length} rows`);
    check("the ban is refused inside the screener, not hidden afterwards", (b.data.banList?.refusedContracts ?? 0) > 0,
      `${b.data.banList?.refusedContracts} contracts refused`);
  }

  // ======================== Tue 29 Sep: EXPIRY DAY ==============================
  console.log("\nTue 29 Sep -- EXPIRY DAY (September contracts expire at 15:30)");
  dayBook = new Map();
  {
    const b = await runBuild("tue-0933-expiry-day", { indexMove: -0.02, idioScale: 0.01, ivMult: 1.1, spreadPct: 0.02, clock: ist("2026-09-29", "09:33") }, dayBook);
    console.log(`  09:33 -> ${b.data.options.length} options, ${b.data.futures.length} futures`);
    check("there ARE options on the page to judge (not an empty pass)", b.data.options.length > 0);
    check("on expiry day, nothing expiring today is on the page", [...b.data.options, ...b.data.futures].every((x) => String(x.expiry) !== "2026-09-29"));
    check("every option shown is at least a week from its own expiry", b.data.options.every((c) => c.daysLeft >= 7));
  }

  // ======================== Wed 30 Sep: HOLIDAY =================================
  console.log("\nWed 30 Sep -- HOLIDAY: the clock says open, the exchange is shut");
  dayBook = new Map();
  {
    const b = await runBuild("wed-0933-holiday", { indexMove: 0, idioScale: 0, ivMult: 1, spreadPct: 0.02, clock: ist("2026-09-30", "09:33"), noBooks: true }, dayBook);
    check("nothing freezes on a holiday", b.data.levelsFrozen === false);
    check("and the page says why, instead of trusting the clock", /not one contract came back with a live exchange book/.test(b.html));
    check("no paper trades are recorded", (b.data.track?.tally?.added ?? 0) === 0);
  }

  // ======================== the whole week, on the TRACK tab ===================
  const last = await runBuild("week-end-track-record", { indexMove: 0, idioScale: 0, ivMult: 1, spreadPct: 0.02, clock: ist("2026-10-02", "15:53"), noBooks: true }, new Map());
  const s = last.data.track.summary.ALL;
  console.log(`\nTRACK TAB after the week: shown ${s.shown}, open ${s.open}, target ${s.target}, stop ${s.stop}, expired/exit ${s.expired}, unfilled ${s.unfilled}`);
  check("every trade the week produced is accounted for on the TRACK tab", s.shown === s.waiting + s.open + s.target + s.stop + s.expired + s.unfilled);
  check("under 30 finished trades a hit rate is labelled too few to judge", s.resolved >= 30 || /too few to judge/.test(last.html));
  check("a loss is written -₹ everywhere on the page, never ₹-", !/₹-\d/.test(last.html));
  check("and a falling percentage on TRACK carries a real minus sign, never a hyphen",
    !/(?<![\w-])-\d[\d.,]*%/.test(text(last.html).replace(/\d{4}-\d{2}-\d{2}/g, "")), (text(last.html).match(/.{0,30}(?<![\w-])-\d[\d.,]*%.{0,10}/) || [""])[0]);
  check("a kind with no target yet shows no time to target, not 0 h",
    ["FUT", "CE", "PE"].every((k) => last.data.track.summary[k].target > 0 || last.data.track.summary[k].medianHoursToTarget === null));
  check("TRACK compares the hit rate with the random-price break-even, not with touch odds",
    /IF RANDOM/.test(last.html) && (s.resolved === 0 || (s.randomHitRatePct > 0 && s.randomHitRatePct < 100)), `${s.randomHitRatePct}`);
  check("futures results are shown in the user's size: 20 units, in rupees",
    !last.data.track.futuresPer20 || (last.data.track.futuresPer20.units === 20 && /at 20 units, gross/.test(last.html)));
  check("the TRACK tab renders the finished trades", /Finished \(latest/.test(last.html) && (s.target + s.stop + s.unfilled + s.expired === 0 || /TARGET|STOP|UNFILLED/.test(last.html)));
  const db = health.checkDatabase({ ledgerDir: LEDGER_DIR, levelsFile: LEDGER_FILE });
  check("the whole week's database passes the production health gate: no fill before its show, no duplicate, levels in order",
    db.trades > 0 && db.problems.length === 0, db.problems.slice(0, 2).join("; ") || `${db.trades} trades checked`);

  // ======================== the check against NSE ==============================
  // On a record of their own, so nothing above is disturbed.
  console.log("\nThu 24 Sep -- the check against NSE: a wrong contract, then NSE unreachable");
  {
    const own = { ledgerFile: path.join(tmp, "nse-levels.json"), ledgerDir: path.join(tmp, "nse-ledger") };
    const wrong = await runBuild("thu-1013-nse-wrong-contract", { ...normal, clock: ist("2026-09-24", "10:13"), nseWrong: true }, new Map(), own);
    const fw = wrong.data.feedCheck || {};
    check("a row priced from a different contract than NSE's is named at the top of the page, in red",
      fw.checked === true && fw.wrongContract?.length === 1 && /DO NOT TRADE THESE ROWS/.test(wrong.html)
        && wrong.html.includes(fw.wrongContract[0].split(":")[0]), JSON.stringify(fw.wrongContract));
    const gate = health.checkLivePath({ ...wrong.data, brokerCheck: { ok: true } }, ist("2026-09-24", "10:13"));
    check("and the production gate turns that build RED", gate.problems.some((p) => /WHICH contract/.test(p)), gate.problems.join(" | ") || "green");
    const noBook = await runBuild("thu-1613-after-close-no-book", { ...normal, clock: ist("2026-09-24", "16:13"), noBooks: true }, new Map(),
      { ledgerFile: path.join(tmp, "nobook-levels.json"), ledgerDir: path.join(tmp, "nobook-ledger") });
    check("after the close with no order book, no row claims a known spread, and its costs say the spread is extra",
      noBook.data.options.length > 0 && noBook.data.options.every((x) => x.spreadKnown === false) && /plus the spread/.test(noBook.html),
      `${noBook.data.options.filter((x) => x.spreadKnown !== false).length} of ${noBook.data.options.length} claim a spread`);
    const down = await runBuild("thu-1033-nse-down", { ...normal, clock: ist("2026-09-24", "10:33"), nseDown: true }, new Map(), own);
    const quiet = health.checkLivePath({ ...down.data, brokerCheck: { ok: true } }, ist("2026-09-24", "10:33"));
    // A REAL NSE HOLIDAY WITH A RE-STAMPED FEED: Fri 2 Oct 2026 (Gandhi
    // Jayanti). The feed clock says 2 Oct; the last trade was 1 Oct. Reading
    // the feed clock as the last session made the holiday look like a trading
    // day with a dead feed -- a red build on a shut exchange.
    const hol = await runBuild("fri-1013-holiday-restamped-feed", { ...normal, clock: ist("2026-10-02", "10:13"),
      restampFeed: "2026-10-02", lastTradeDay: "2026-10-01" }, new Map(),
      { ledgerFile: path.join(tmp, "holiday-levels.json"), ledgerDir: path.join(tmp, "holiday-ledger") });
    const holGate = health.checkLivePath({ ...hol.data, brokerCheck: { ok: true } }, ist("2026-10-02", "10:13"));
    check("on a real NSE holiday with the feed re-stamped that morning, the last session is the day before, not the holiday",
      hol.data.quoteStatus?.lastExchangeDate === "2026-10-01", String(hol.data.quoteStatus?.lastExchangeDate));
    check("and the production gate stays green: a shut exchange is not a dead feed",
      holGate.exchangeShut === true && holGate.problems.length === 0, holGate.problems[0] || "green");
    check("the page names it as an NSE holiday, from NSE's own calendar, and nothing is frozen",
      hol.data.levelsFrozen === false && /NSE trading holiday/.test(hol.html));
    check("and on the holiday the header says there is no session today, naming the last one",
      /no session today \(last: Thu, 1 Oct\)/.test(hol.html), (hol.html.match(/Built [^<]{0,120}/) || [""])[0]);
    // WITHOUT NSE'S CORPORATE-ACTION FILINGS a demerger cannot be told from a
    // crash (ABFRL's 22 May 2025 demerger reads as a 66.6% fall), so the page
    // shows no risk figure at all -- and the reason -- rather than a wrong one.
    const noCa = await runBuild("thu-1053-no-corporate-actions", { ...normal, clock: ist("2026-09-24", "10:53") }, new Map(),
      { ledgerFile: path.join(tmp, "noca-levels.json"), ledgerDir: path.join(tmp, "noca-ledger"), risk: { riskHistoryFor: simHistory, riskActions: null } });
    check("without NSE's corporate-action filings the page shows no risk figure, and says why",
      /BAD-DAY RISK: not available on this build/.test(text(noCa.html)) && /corporate-action filings could not be read/.test(text(noCa.html))
        && !/1 day in 20:/.test(noCa.html), (text(noCa.html).match(/BAD-DAY RISK[^.]{0,160}/) || ["no risk line"])[0]);
    const noGate = health.checkLivePath({ ...noCa.data, brokerCheck: { ok: true } }, ist("2026-09-24", "10:53"));
    check("and a missing risk figure never turns the production gate red", noGate.problems.length === 0, noGate.problems[0] || "green");
    check("NSE unreachable: the page says NOT checked, and the gate stays green",
      down.data.feedCheck?.checked === false && /Not checked against NSE/.test(down.html) && quiet.problems.length === 0,
      quiet.problems[0] || down.data.feedCheck?.reason);
  }

  Date.now = realNow;
  live.marketPhase = realPhase;
  console.log("\nrendered pages (open any in a browser; each is stamped SIMULATION):");
  for (const f of fs.readdirSync(PAGES)) console.log("  " + path.join(PAGES, f));
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (findings.length) { console.log("FAILED CHECKS:"); for (const f of findings) console.log("  - " + f); }
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  Date.now = realNow;
  console.error("SIMULATION CRASHED:", error.stack);
  process.exit(2);
});
