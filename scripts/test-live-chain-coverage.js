"use strict";

/**
 * EVERY BUY NAME GETS A LIVE CHAIN ON EVERY BUILD.
 *
 * In session a call is refused without a live book, so a stock whose chain is
 * not fetched can never have a call on the page. The rotation in
 * refreshLiveQuotes was built for a server that kept its cursors all day; the
 * static build makes a new engine every run, so it fetched the SAME first 25 of
 * 64 actionable names every time (2026-09-25: 95 option paper trades on exactly
 * 25 stocks). The build now asks for every actionable name. The network is
 * replaced by a recorder; the universe is the real one.
 */

const live = require("../api/_lib/live-quotes");
let asked = [];
live.refreshQuotes = async (requests) => { asked = requests; return { ok: true, refreshed: requests.length, requested: requests.length, provider: "stub" }; };
live.refreshFutures = async () => ({ ok: true, count: 0 });
live.diagnose = () => ({ ok: true });
const { RealtimeMarketEngine } = require("../api/_lib/realtime-market-engine");
const { fnoUniverseEngine } = require("../api/_lib/universe-210");
const { loadReference } = require("../api/_lib/fno-reference");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

(async () => {
  console.log("live chain coverage:");
  const origLog = console.log;
  const quiet = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = origLog; } };
  const ref = loadReference();
  // The clock of the settlement file on hand, as the scenario simulation does:
  // on a machine whose history was fetched days ago, today's clock refuses
  // every name as stale (STALE_DATA_REFUSAL), nothing is actionable, and the
  // first check could only fail -- or, written the other way, pass on nothing.
  const refNoon = Date.parse(`${ref.session}T12:00:00+05:30`);
  Date.now = () => refNoon;
  const actionable = (fnoUniverseEngine.getUniverse(null) || []).filter((r) => r.action === "BUY" || r.action === "ACCUMULATE");
  const withOptions = new Set(actionable.filter((r) => ref?.symbols?.[r.symbol]).map((r) => r.symbol));

  const build = new RealtimeMarketEngine();
  await quiet(() => build.refreshLiveQuotes({ everyActionable: true }))();
  const fetched = new Set(asked.map((r) => r.symbol));
  check(`a build fetches a live chain for EVERY actionable name with NSE options (${withOptions.size})`,
    withOptions.size > 0 && [...withOptions].every((s) => fetched.has(s)), `${[...withOptions].filter((s) => fetched.has(s)).length} of ${withOptions.size}`);
  check("and for nothing else -- calls are only shown on actionable names", [...fetched].every((s) => withOptions.has(s)));
  check("every request is on the expiry the card is written on (at least 7 days out)",
    asked.every((r) => r.expiry && (Date.parse(r.expiry) - Date.now()) / 86_400_000 >= 6));

  // EXACTLY THE NAMES THE PAGE WILL SHOW (market-direction.js optionsView). In
  // a downtrend those are the indices and the falling SELL/REDUCE stocks: with
  // "every actionable name" instead, every put was refused in session for want
  // of a live book, nothing froze and the health gate went red.
  const brokers = require("../api/_lib/broker-feed");
  const realFutures = brokers.futuresQuotes;
  let askedFutures = [];
  brokers.futuresQuotes = async (reqs) => {
    askedFutures = reqs;
    const quotes = {};
    for (const r of reqs) quotes[`${r.symbol}|${r.expiry}`] = { symbol: r.symbol, expiry: r.expiry, price: r.symbol === "NIFTY" ? 22716.2 : 54259.95 };
    return { ok: true, quotes };
  };
  const stock = (fnoUniverseEngine.getUniverse(null) || []).find((r) => ref?.symbols?.[r.symbol] && r.spotPrice > 0);
  const wanted = ["NIFTY", "BANKNIFTY", stock.symbol];
  const down = new RealtimeMarketEngine();
  await quiet(() => down.refreshLiveQuotes({ symbols: wanted }))();
  brokers.futuresQuotes = realFutures;
  const bySym = new Map(asked.map((r) => [r.symbol, r]));
  check("given the page's names, a build fetches exactly those chains -- the indices included",
    asked.length === wanted.length && wanted.every((s) => bySym.has(s)), asked.map((r) => r.symbol).join(", "));
  check("an index's chain is centred on its LIVE front future, not on yesterday's close",
    bySym.get("NIFTY")?.referencePrice === 22716.2 && bySym.get("BANKNIFTY")?.referencePrice === 54259.95,
    `${bySym.get("NIFTY")?.referencePrice} / ${bySym.get("BANKNIFTY")?.referencePrice}`);
  check("the front FUTURE is asked for (a month with a future), not NIFTY's first weekly",
    askedFutures.length === 2 && askedFutures.every((r) => Number(ref.symbols[r.symbol].expiries[r.expiry]?.futuresPrice) > 0),
    JSON.stringify(askedFutures));
  check("a stock keeps its own price as the centre, as before", bySym.get(stock.symbol)?.referencePrice === stock.spotPrice);
  check("every chain is on the expiry the rows are written on (at least 7 days out)",
    asked.every((r) => r.expiry && (Date.parse(r.expiry) - Date.now()) / 86_400_000 >= 6));

  const server = new RealtimeMarketEngine();
  await quiet(() => server.refreshLiveQuotes({ limit: 45 }))();
  const first = new Set(asked.map((r) => r.symbol));
  await quiet(() => server.refreshLiveQuotes({ limit: 45 }))();
  const second = new Set(asked.map((r) => r.symbol));
  check("the long-running server still rotates: its second cycle is not its first",
    [...second].some((s) => !first.has(s)));
  try { build.stop(); server.stop(); } catch { /* nothing started */ }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack); process.exit(1); });
