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
      if (state.halted || state.noBooks) return null;
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
          previousClose: null, exchangeFeedTime: feedStamp(feedAt), tradingSymbol: key.replace(/\|/g, "") };
      }
      return out;
    }
  };
}

// ---- driving the real build ----------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-scenarios-"));
const LEDGER_FILE = path.join(tmp, "levels.json");
const LEDGER_DIR = path.join(tmp, "ledger");
const PAGES = path.join(tmp, "pages");
fs.mkdirSync(PAGES, { recursive: true });

async function runBuild(name, state, dayBook, { banned = null } = {}) {
  const market = makeMarket(state, dayBook);
  Date.now = () => state.clock;
  live.marketPhase = (n) => realPhase(n ?? state.clock);
  live.liveQuote = (s, e, k, t) => market.book(s, e, k, t);
  brokers.contractQuotes = async (list) => {
    const quotes = market.quotes(list || []);
    return { ok: Object.keys(quotes).length > 0, quotes, requested: (list || []).length, resolved: (list || []).length, failures: [] };
  };
  const savedBan = fnoUniverseEngine.banned;
  if (banned) fnoUniverseEngine.banned = new Set([...(savedBan || []), ...banned]);
  let data;
  try {
    data = await desk.build({ ledgerFile: LEDGER_FILE, ledgerDir: LEDGER_DIR });
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
    const f = d.futures.find((x) => x.fnoListed) || d.futures[0];
    const liveShare = b.market.shareOf(f.symbol);
    check(`futures NOW is the live SHARE price (${f.symbol})`, Math.abs(f.spot - liveShare) < 0.02, `page ${f.spot} vs market ${liveShare.toFixed(2)}`);
    check(`${f.symbol}'s buy limit is 0.8% under that price`, Math.abs(f.buy - Math.round(liveShare * 0.992 * 100) / 100) < 0.02, `${f.buy}`);
    check("that NOW price is printed on the page", b.html.includes(Number(f.spot).toLocaleString("en-IN")));
    check("futures NOW is labelled live, with its time", /share, live at \d\d:\d\d/.test(b.html));
    const liveFut = b.market.forwardOf(f.symbol, f.expiry);
    check(`and the NSE future's own price is shown beside it for comparison (${f.symbol})`,
      f.referenceKind === "future" && Math.abs(f.referencePrice - liveFut) < 0.02, `future ${f.referencePrice}`);
    const shareOnly = d.futures.filter((x) => x.fnoListed === false);
    check("share-only names are watched and never given an invented futures symbol",
      shareOnly.every((x) => !x.tradingSymbol) && /no NSE futures contract/.test(b.html) || shareOnly.length === 0,
      `${shareOnly.length} share-only rows`);
    const o = d.options[0];
    check(`option names read like the broker's search (${o.display})`, /^[A-Z&-]+ [A-Z]{3} \d+(\.\d+)? (CE|PE)$/.test(o.display) || /\(weekly\)/.test(o.display));
    check("every stock option carries an exit-by date before its expiry",
      d.options.filter((c) => !["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(c.symbol)).every((c) => c.exitBy && c.exitBy < c.expiry));
    check("nothing on the page expires inside a week", d.options.every((c) => c.daysLeft >= 7));
    check("every frozen level became a paper trade", d.track.tally.added === d.options.length + d.futures.filter((x) => x.frozen).length,
      `${d.track.tally.added} recorded`);
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
      d.levelsFrozen && d.futures.filter((x) => x.frozen).every((x) => Math.abs(x.anchor - b.market.shareOf(x.symbol)) < 0.05));
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
  }

  // ======================== Mon 28 Sep: EXPIRY EVE ==============================
  console.log("\nMon 28 Sep -- EXPIRY EVE (September contracts expire tomorrow), relief rally +3%");
  dayBook = new Map();
  {
    const b = await runBuild("mon-0933-expiry-eve", { indexMove: -0.029, idioScale: 0.01, ivMult: 0.85, spreadPct: 0.02, clock: ist("2026-09-28", "09:33") }, dayBook);
    const sepRows = [...b.data.options, ...b.data.futures].filter((x) => String(x.expiry) === "2026-09-29");
    console.log(`  09:33 -> ${b.data.futures.length} futures, ${b.data.options.length} options`);
    check("nothing expiring tomorrow is on the page", sepRows.length === 0, `${sepRows.length} found`);
    check("the futures shown are the NEXT month's", b.data.futures.length > 0 && b.data.futures.every((x) => String(x.expiry) > "2026-09-29"),
      `${b.data.futures.length} rows`);
    // The daily price history on disk ends on the settlement date; this
    // simulation moves the clock but not the history, and the universe rightly
    // refuses to issue futures on bars several sessions old.
    const refusals = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false })
      .filter((r) => (r.status || r.finalStatus) === "STALE_DATA_REFUSAL").length;
    check("few futures on Monday is the STALE-DATA guard working, not a fault", refusals > 150, `${refusals} refused on stale history`);
    check("the page shows the October exit-by date, Wednesday 21 October", /exit (or roll )?by Wed 21 Oct/.test(b.html));
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

  // ======================== F&O BAN =============================================
  console.log("\nF&O BAN -- a stock on Thursday's list enters the ban");
  {
    const probe = await runBuild("ban-probe", { ...normal, clock: ist("2026-10-01", "09:33") }, new Map());
    const target = probe.data.options[0]?.symbol || probe.data.futures[0]?.symbol;
    check("the stock chosen for the ban really was on the page first", Boolean(target), target || "none");
    const b = await runBuild("ban-applied", { ...normal, clock: ist("2026-10-01", "09:40") }, new Map(), { banned: [target] });
    const leaked = [...b.data.options, ...b.data.futures].filter((x) => x.symbol === target);
    check(`${target} in the ban appears nowhere on the page`, leaked.length === 0 && !new RegExp(`>${target} `).test(b.html.split('class="pane pane-trk"')[0]),
      `${leaked.length} rows`);
    check("the ban is refused inside the screener, not hidden afterwards", (b.data.banList?.refusedContracts ?? 0) > 0,
      `${b.data.banList?.refusedContracts} contracts refused`);
  }

  // ======================== the whole week, on the TRACK tab ===================
  const last = await runBuild("week-end-track-record", { indexMove: 0, idioScale: 0, ivMult: 1, spreadPct: 0.02, clock: ist("2026-10-02", "15:53"), noBooks: true }, new Map());
  const s = last.data.track.summary.ALL;
  console.log(`\nTRACK TAB after the week: shown ${s.shown}, open ${s.open}, target ${s.target}, stop ${s.stop}, expired/exit ${s.expired}, unfilled ${s.unfilled}`);
  check("every trade the week produced is accounted for on the TRACK tab", s.shown === s.waiting + s.open + s.target + s.stop + s.expired + s.unfilled);
  check("the TRACK tab renders the finished trades", /Finished \(latest/.test(last.html) && (s.target + s.stop + s.unfilled + s.expired === 0 || /TARGET|STOP|UNFILLED/.test(last.html)));

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
