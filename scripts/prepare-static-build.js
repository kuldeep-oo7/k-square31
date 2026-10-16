"use strict";

/**
 * FETCH WHAT A BRAND-NEW MACHINE DOES NOT HAVE.
 *
 * A GitHub Actions runner is destroyed after every job, so nothing is cached:
 * no exchange contract file, no price history, no broker session. The static
 * build needs all three, and each one degrades differently when it is missing.
 *
 * NOTHING HERE IS FATAL. If the contract file cannot be fetched the page is
 * built from whatever is committed and says so; if the broker will not
 * authenticate the prices come from the settlement file and the page says that
 * too. A snapshot that admits what it is beats a blank page, and beats a
 * confident page built on nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile() {
  const file = path.resolve(__dirname, "..", ".private", "production.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]] && match[2]) process.env[match[1]] = match[2];
  }
}

async function step(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`  ok   ${label}  (${((Date.now() - started) / 1000).toFixed(1)}s)  ${result || ""}`);
    return true;
  } catch (error) {
    // Say what failed and carry on. The build downstream knows how to be honest
    // about missing inputs; stopping here would just produce nothing at all.
    console.log(`  SKIP ${label}  -- ${error.message}`);
    return false;
  }
}

(async () => {
  loadEnvFile();
  console.log("preparing a cold runner:");

  await step("exchange contract file", async () => {
    const { refreshReference } = require("../api/_lib/fno-reference");
    const reference = await refreshReference(new Date(), { maxLookbackDays: 7 });
    return `${reference.symbolCount} symbols, session ${reference.session}`;
  });

  // TODAY'S F&O BAN LIST, FROM NSE, EVERY BUILD.
  //
  // During a ban (open interest above 95% of the market-wide limit) NSE allows
  // only positions that REDUCE exposure -- a fresh buy is refused and penalised.
  // The desk read its ban list from data/market-coverage.json, which nothing on
  // the build server ever refreshed: measured on 2026-09-23 it was six days old
  // and missed LICHSGFIN, banned for the 24 September session. A banned stock on
  // the buy list is an order that cannot be placed.
  await step("F&O ban list for today", async () => {
    const { fetchSecurityBanList, banStateForSession } = require("../api/_lib/bhavcopy");
    const { sessionDateFor } = require("./session-freeze");
    const ban = await fetchSecurityBanList();
    if (!ban.available) throw new Error("NSE ban list unavailable: " + (ban.error || "unknown"));
    const session = sessionDateFor();
    const record = {
      tradeDate: ban.tradeDate || null,
      symbols: [...(ban.symbols || [])].sort(),
      verifiedForSession: banStateForSession(ban, session) === true ? session : null,
      source: ban.source, fetchedAt: ban.fetchedAt
    };
    const file = path.resolve(__dirname, "..", ".private", "cache", "fo-ban.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 1));
    return record.symbols.length + " banned for " + (record.tradeDate || "?") + ": " + (record.symbols.join(", ") || "none");
  });

  // WHICH SYMBOLS NSE LISTS, AND WHAT RENAMED ONES BECAME (api/_lib/nse-symbols.js).
  // Before anything loads the watch list: the universe reads this when it is
  // first required, and a renamed company must be watched under its new name.
  await step("NSE listed symbols and symbol changes", async () => {
    const { refreshNseSymbols } = require("../api/_lib/nse-symbols");
    const r = await refreshNseSymbols();
    if (!r.ok) throw new Error(`not read: ${r.reason}`);
    return `${r.listed.length} listed (file of ${r.listedModified || "?"}), ${Object.keys(r.changes).length} symbol changes on record`;
  });

  // RESULTS DATES, from NSE's own board-meeting filings (api/_lib/nse-results.js).
  // A failure is recorded as a failure, so the desk says "unknown" rather than
  // treating an unread calendar as a quiet one.
  await step("results dates from NSE", async () => {
    const { refreshResultsCalendar } = require("../api/_lib/nse-results");
    const record = await refreshResultsCalendar();
    if (!record.ok) throw new Error(`NSE calendar not read: ${record.reason}`);
    return `${Object.keys(record.symbols).length} results meetings filed for the next ${record.days} days (${record.rows} filings read)`;
  });

  // INDIA VIX AND NIFTY from NSE, every build (the engine had a hard-coded 12.5).
  await step("India VIX and Nifty from NSE", async () => {
    const { refreshMarketContext } = require("../api/_lib/nse-market-context");
    const r = await refreshMarketContext();
    if (!r.ok) throw new Error(`not read: ${r.reason}`);
    return `India VIX ${r.indiaVix} (${r.indiaVixChangePct}%), Nifty ${r.nifty} (${r.niftyChangePct}%) at ${r.nseTimestamp}`;
  });

  // BALANCE SHEETS (Yahoo quoteSummary), once a day. The ranking's balance-sheet
  // rule read a cache the serverless build never filled, so it could not fire.
  await step("balance sheets (Yahoo, daily)", async () => {
    const { fnoUniverseEngine } = require("../api/_lib/universe-210");
    const { fundamentals, getCachedFundamentals } = require("../api/_lib/fundamentals");
    const DAY = 20 * 3_600_000, started = Date.now();
    const due = (fnoUniverseEngine.symbols || []).filter((sym) => !getCachedFundamentals(sym, DAY));
    let ok = 0, failed = 0, notReached = 0;
    for (let i = 0; i < due.length; i += 4) {
      if (Date.now() - started > 120_000) { notReached = due.length - i; break; }
      const got = await Promise.all(due.slice(i, i + 4).map((sym) => fundamentals(sym, { force: true }).catch(() => null)));
      for (const g of got) { if (g && g.fetchedAt && !g.error) ok += 1; else failed += 1; }
      await new Promise((r) => setTimeout(r, 250));
    }
    const fresh = (fnoUniverseEngine.symbols || []).filter((sym) => getCachedFundamentals(sym, DAY)).length;
    return `${due.length} due: ${ok} fetched, ${failed} failed${notReached ? `, ${notReached} not reached` : ""}; ${fresh} of ${(fnoUniverseEngine.symbols || []).length} current`;
  });

  await step("broker instrument master", async () => {
    const brokers = require("../api/_lib/broker-feed");
    // REUSED WITHIN 3 HOURS ON THE SAME IST DAY (16 Oct 2026). It was fetched on EVERY build (5-46 s each), although
    // the master changes once a day; that alone kept builds over a billed minute. Never reused from an earlier day.
    const have = brokers.loadInstruments("angelone"), istDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const age = have?.fetchedAt ? Date.now() - Date.parse(have.fetchedAt) : Infinity;
    if (have && !have.schemaStale && have.optionCount > 0 && age < 3 * 3_600_000 && istDay(have.fetchedAt) === istDay(Date.now())) {
      return `reused (fetched ${Math.round(age / 60_000)} min ago, ${have.optionCount} option contracts)`;
    }
    const result = await brokers.refreshInstruments("angelone");
    return result?.optionCount ? `${result.optionCount} option contracts` : "cached";
  });

  // EVERY NAME WHOSE HISTORY IS BEHIND THE LATEST SESSION, not only the names
  // with none. Fetching only the missing ones left the whole watch list on the
  // bars of the first run for as long as the cache lived (see bar-cache.js).
  await step("price history for the technical read", async () => {
    const { fnoUniverseEngine } = require("../api/_lib/universe-210");
    const { refreshStaleBars } = require("../api/_lib/bar-cache");
    // And every index with options, under its Yahoo ticker: an index put's
    // realised volatility and odds come from these (contract-screener.js).
    const { INDEX_TICKER } = require("../api/_lib/market-direction");
    const r = await refreshStaleBars([...(fnoUniverseEngine.symbols || []), ...Object.values(INDEX_TICKER)]);
    const ends = Object.entries(r.endsOn).sort(([a], [b]) => b.localeCompare(a)).map(([d, n]) => `${n} end ${d}`).join(", ");
    return `${r.due} behind the latest session: ${r.refreshed} refreshed, ${r.failed} kept as they were`
      + (r.notReached ? `, ${r.notReached} not reached in time` : "") + ` (${r.seconds}s). History now: ${ends}`;
  });

  // DEMERGERS, BONUSES AND SPLITS from NSE's own filings (nse-corporate-actions.js),
  // once a day: the risk view must not read a demerger as a crash (ABFRL
  // "fell" 66.6% on its demerger ex-date, 22 May 2025, in the price history).
  await step("NSE corporate actions (demergers, bonuses, splits)", async () => {
    const ca = require("../api/_lib/nse-corporate-actions");
    const have = ca.loadCorporateActions();
    if (have && Date.now() - Date.parse(have.fetchedAt) < 20 * 3_600_000) return `current: ${have.rows.length} price actions, read ${have.fetchedAt}`;
    const r = await ca.refreshCorporateActions();
    if (!r.ok) throw new Error(r.reason + (have ? ` (keeping the file read ${have.fetchedAt})` : " (no earlier file: the risk view will say it is unavailable)"));
    return `${r.rows.length} price actions in ${r.filings} filings over ${r.days} days`;
  });

  // TWO YEARS OF PRICES FOR THE RISK VIEW (risk-history.js), in its own copy so
  // the technical read's three months -- and every score -- stay as they are.
  // Fetched when a copy predates the latest close: the first build after 15:30
  // pays for it and the cache carries it to the next day.
  await step("two years of prices for the risk view", async () => {
    const { fnoUniverseEngine } = require("../api/_lib/universe-210");
    const { refreshRiskHistory } = require("../api/_lib/risk-history");
    const { INDEX_TICKER } = require("../api/_lib/market-direction");
    const r = await refreshRiskHistory([...(fnoUniverseEngine.symbols || []), ...Object.values(INDEX_TICKER)], { budgetMs: 120_000 });
    return `${r.due} due: ${r.fetched} fetched, ${r.failed} failed${r.notReached ? `, ${r.notReached} not reached in time` : ""}; `
      + `${r.have} of ${r.wanted} on hand (${r.seconds}s)${r.failures.length ? ` -- ${r.failures.join("; ")}` : ""}`;
  });

  // NSE'S OWN INDEX HISTORY WHERE YAHOO HAS NONE (audit F23). Yahoo returns one row for FINNIFTY and
  // MIDCPNIFTY; the workflow downloads NSE's archive (release data-nse-idx) to nse-idx/nse-idx.json and
  // this fills the two caches for any index Yahoo covers too thinly. Runs AFTER both Yahoo refreshes, so
  // a fresh one-row Yahoo copy is replaced again on every build.
  await step("NSE index history where Yahoo has none", async () => {
    const { loadArchive, fillThinIndices } = require("../api/_lib/nse-index-history");
    const archive = loadArchive(process.env.K2_NSE_IDX_ARCHIVE || "nse-idx/nse-idx.json");
    if (!archive) return "no NSE index archive on this runner -- FINNIFTY and MIDCPNIFTY keep Yahoo's (thin) copy";
    const done = fillThinIndices({ archive });
    return Object.entries(done).map(([t, v]) => `${t}: ${v}`).join("; ");
  });

  // THE LOGIN, ON EVERY BUILD, WHETHER OR NOT THE MARKET IS OPEN.
  //
  // Live quotes are only fetched in session, so without this the first time
  // anything logged in to Angel One from a GitHub server would have been 09:33
  // on a trading morning -- the worst possible moment to learn that it does not
  // work. The rules allow it (Angel One, from 1 April 2026: "For APIs other than
  // Orders & GTT, using a static IP is not mandatory"), but a rule is not a
  // measurement. One login and one four-leg quote settles it.
  //
  // The answer is written where the page can show it, because an empty options
  // table looks identical whether the login failed or the exchange is shut for
  // a holiday, and the two need completely different fixes.
  await step("broker login and one live quote", async () => {
    const checkFile = path.resolve(__dirname, "..", ".private", "cache", "broker-check.json");
    const record = (result) => {
      fs.mkdirSync(path.dirname(checkFile), { recursive: true });
      fs.writeFileSync(checkFile, JSON.stringify({ checkedAt: new Date().toISOString(), ...result }));
    };
    const auth = require("../api/_lib/broker-auth");
    if (!auth.credentialFile()) {
      record({ ok: false, stage: "CREDENTIALS", reason: "NO_BROKER_CREDENTIALS" });
      throw new Error("no broker credentials on this runner");
    }
    const session = await auth.angelEnsureSession();
    if (!session.ok) {
      const why = session.message || session.detail || null;
      record({ ok: false, stage: "LOGIN", reason: session.reason, message: why });
      throw new Error("login refused: " + session.reason + (why ? " -- " + why : ""));
    }
    const { tradableExpiry } = require("../api/_lib/fno-reference");
    const front = tradableExpiry("NIFTY", { minDays: 0 });
    const brokers = require("../api/_lib/broker-feed");
    const chain = front ? await brokers.angelOptionChain("NIFTY", front.expiry, { strikesEitherSide: 1 }) : null;
    if (!chain?.ok) {
      const why = chain?.reason || "NO_NIFTY_EXPIRY_IN_REFERENCE";
      record({ ok: false, stage: "QUOTE", reason: why, message: chain?.message || null });
      throw new Error("logged in, but the quote was refused: " + why);
    }
    const leg = chain.chain.find((l) => Number(l.lastPrice) > 0) || chain.chain[0] || null;
    record({
      ok: true, stage: "QUOTE", expiry: front.expiry, legs: chain.strikeCount,
      sample: leg ? { strike: leg.strike, type: leg.optionType, lastPrice: leg.lastPrice } : null
    });
    return "logged in from this runner and priced " + chain.strikeCount + " NIFTY " + front.expiry + " legs"
      + (leg ? " (" + leg.strike + leg.optionType + " last " + leg.lastPrice + ")" : "");
  });

  // THE MARKET'S DIRECTION, AND THE NAMES WHOSE BOOKS THE PAGE WILL NEED. The
  // same function the page uses (market-direction.js optionsView), on the same
  // inputs: in a downtrend the page shows puts on the indices and the falling
  // SELL/REDUCE stocks, and a put with no live book is refused in session.
  let chainSymbols = null;
  await step("market direction and the option names", async () => {
    const { fnoUniverseEngine } = require("../api/_lib/universe-210");
    const { marketDirection, optionsView, ownTrend } = require("../api/_lib/market-direction");
    const { getCachedBars } = require("../api/_lib/bar-cache");
    // The engine read every bar file into memory when it was first required --
    // before the history step above refreshed them -- and prefers that copy.
    // Rated on it, this could fetch books for yesterday's names. Drop it, so
    // the ratings here are the page's: read from the files, as build() reads them.
    fnoUniverseEngine.barsCache.clear();
    const direction = marketDirection();
    const view = optionsView({ direction, universe: fnoUniverseEngine.getUniverse() || [],
      trendFor: (symbol) => ownTrend(getCachedBars(symbol)?.bars) });
    chainSymbols = Object.keys(view.bullish);
    const verdict = direction.available
      ? `${direction.regime} since ${direction.since} (NIFTY ${direction.close}, EMA20 ${direction.ema20}, SMA50 ${direction.sma50}; close of ${direction.asOf}${direction.stale ? `, OLDER than ${direction.expectedAsOf}` : ""})`
      : `unknown (${direction.reason})`;
    return `${verdict}; ${view.rule}: ${view.indices.length} indices, ${view.stocks.length} stocks`
      + (view.ratedDownNotFalling.length ? `; rated SELL/REDUCE but not falling, no put: ${view.ratedDownNotFalling.length}` : "");
  });

  await step("live option quotes", async () => {
    const live = require("../api/_lib/live-quotes");
    const phase = live.marketPhase();
    if (!phase.open) return `market ${phase.phase}, settlement prices are the only prices there are`;
    const { RealtimeMarketEngine } = require("../api/_lib/realtime-market-engine");
    const engine = new RealtimeMarketEngine();
    // Exactly the names the page will show (above); if the direction step
    // failed, every BUY/ACCUMULATE name as before (see refreshLiveQuotes).
    const result = await engine.refreshLiveQuotes(chainSymbols ? { symbols: chainSymbols } : { everyActionable: true });
    try { engine.stop(); } catch (error) { /* nothing started */ }
    return result?.refreshed ? `${result.refreshed} of ${result.requested} chains` : "none";
  });

  // ORDER FLOW, RECORDED (api/_lib/orderflow-recorder.js): this build's order books, one line, in
  // orderflow/<IST date>.jsonl -- the workflow appends it to the private release "orderflow-rec".
  await step("record the order books (order flow history)", async () => {
    const live = require("../api/_lib/live-quotes");
    if (!live.marketPhase().open) return "market closed: nothing to record";
    const r = require("../api/_lib/orderflow-recorder").record({ store: live.load ? live.load() : null });
    return r.written ? `${r.futures} futures and ${r.options} option books recorded` : r.reason;
  });

  console.log("prepared.");
  process.exit(0);
})().catch((error) => {
  console.error("preparation failed outright:", error.message);
  // Still zero: the build after this is designed to cope and to label itself.
  process.exit(0);
});
