"use strict";

// Builds the week's ranked ladder plan across the F&O-tradable universe.
//
// For every symbol: five years of daily bars, the weekly triple-barrier replay
// of the desk's own rule, a walk-forward boosted-tree forecast, and the
// fundamentals event/balance-sheet overlay. Names that clear every veto are
// ranked by expected net result for the week.
//
// Intended to run once a week before Monday's open (the anchor session), and
// cheap enough to re-run intraday for a subset with --symbols.
//
//   node scripts/weekly-plan.js --limit 40
//   node scripts/weekly-plan.js --symbols RELIANCE,AUBANK,TATAMOTORS
//   node scripts/weekly-plan.js --limit 500 --out plan.json
//
// With K2_GOOGLE_SHEETS_WEB_APP_URL and K2_GOOGLE_SHEETS_ARCHIVE_SECRET set, the
// plan and each symbol's history are persisted to the operational store.

const fs = require("node:fs");
const path = require("node:path");
const { weeklyCycle } = require("../api/_lib/weekly-cycle");
const { weeklyForecast } = require("../api/_lib/ml-model");
const { fundamentals } = require("../api/_lib/fundamentals");
const { recommendation, rankRecommendations } = require("../api/_lib/recommendation");
const { latestBhavcopy, frontFutures } = require("../api/_lib/bhavcopy");
const { carry } = require("../api/_lib/carry");
const { googleStoreConfigured, writeGoogleDocument, readGoogleDocument } = require("../api/_lib/google-store");
const { createSignalRecord, evaluateOutcome, summarizePerformance } = require("../api/_lib/trade-tracker");
const { analyzeOutcomeSignatures } = require("../api/_lib/adaptive-learning");
const { trendMetrics } = require("../api/_lib/trend");

// Names the desk has traded before, marked on every recommendation. Deliberately
// not a filter: a name being absent is not evidence it cannot be traded, and 28
// of them have since left the F&O segment anyway.
const JOURNAL = new Set((() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "journal-symbols.json"), "utf8")).symbols || []; }
  catch { return []; }
})());

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT = "Mozilla/5.0 K-Square/2.0";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// The tradable set is every NSE name with a futures contract. Taking the Nifty
// 500 list and keeping the intersection missed names that have futures but sit
// outside that index, so the F&O list itself is the universe and the index file
// is only a fallback for when the exchange archive cannot be reached.
function universe(front) {
  const explicit = argument("symbols");
  if (explicit) return explicit.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const limit = Number(argument("limit", "0"));
  if (front?.size) {
    const symbols = [...front.keys()].sort();
    return limit > 0 ? symbols.slice(0, limit) : symbols;
  }
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ai-universe-data.json"), "utf8"));
  const symbols = (data.stocks || []).map((stock) => String(stock.symbol || "").toUpperCase()).filter(Boolean);
  return limit > 0 ? symbols.slice(0, limit) : symbols;
}

async function dailyBars(symbol) {
  const url = `${CHART}/${encodeURIComponent(`${symbol}.NS`)}?range=5y&interval=1d&includePrePost=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`chart HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "no chart result");
  const quote = result.indicators?.quote?.[0] || {};
  return (result.timestamp || []).map((timestamp, index) => ({
    timestamp,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index]
  })).filter((bar) => [bar.high, bar.low, bar.close].every(Number.isFinite));
}

// Only about 214 NSE names have futures at all, so scanning the Nifty 500 spends
// most of its time measuring instruments this desk cannot trade — and returns
// recommendations it cannot act on.
async function tradableFutures() {
  try {
    const book = await latestBhavcopy();
    const front = frontFutures(book.rows);
    console.log(`F&O universe from the ${book.tradeDate} bhavcopy: ${front.size} names with a front-month contract`);
    return { front, asOf: Date.parse(`${book.tradeDate.slice(0, 4)}-${book.tradeDate.slice(4, 6)}-${book.tradeDate.slice(6, 8)}T10:00:00Z`) };
  } catch (error) {
    console.warn(`Could not read the bhavcopy (${String(error?.message || error).slice(0, 90)}); measuring every name without carry.`);
    return { front: new Map(), asOf: Date.now() };
  }
}

async function planFor(symbol, options) {
  const bars = await dailyBars(symbol);
  const cycle = weeklyCycle(bars);
  if (!cycle.ready) return { symbol, action: "stand-aside", reasons: [cycle.reason], symbolBars: bars.length };

  // The model and the fundamentals call are the expensive parts, so they only
  // run for names whose own rule already showed an edge.
  const side = cycle.verdict.side;
  const model = side ? weeklyForecast(bars, side) : null;
  const financials = side && !options.skipFundamentals ? await fundamentals(symbol) : null;
  const contract = options.futures?.get(symbol);
  // Carry is supplied for the long side; the recommendation flips it for a short.
  const basis = contract
    ? carry({ futures: contract.futures, spot: contract.spot, expiry: contract.expiry, side: "long", nowMs: options.asOf })
    : null;
  const metrics = trendMetrics(bars);
  const technicalScore = (metrics?.isUptrendStructure ? 35 : metrics?.isDowntrendStructure ? -35 : 0) +
                         (metrics?.isEfficientTrend ? (metrics?.isUptrendStructure ? 15 : -15) : 0);
  const technical = { score: technicalScore, ready: true, metrics };
  const plan = recommendation({ symbol, bars, cycle, model, fundamentals: financials, technical, carry: basis });
  return { ...plan, symbolBars: bars.length, inJournal: JOURNAL.has(symbol) };
}

async function run() {
  const skipFundamentals = process.argv.includes("--no-fundamentals");
  const { front, asOf } = await tradableFutures();
  const symbols = universe(front);
  console.log(`Measuring ${symbols.length} name${symbols.length === 1 ? "" : "s"}${front.size ? " — every NSE stock with a futures contract" : " from the stored index"}.
`);
  const plans = [];
  let failed = 0;

  for (const [index, symbol] of symbols.entries()) {
    try {
      const plan = await planFor(symbol, { skipFundamentals, futures: front, asOf });
      plans.push(plan);
      const label = plan.action === "stand-aside" ? "-" : `${plan.side} ${plan.expectedWeeklyPct}% conviction ${plan.convictionPct}`;
      console.log(`[${index + 1}/${symbols.length}] ${symbol}: ${plan.action} ${label}`);
    } catch (error) {
      failed += 1;
      console.warn(`[${index + 1}/${symbols.length}] ${symbol}: skipped (${String(error?.message || error).slice(0, 80)})`);
    }
  }

  const ranked = rankRecommendations(plans, { limit: Number(argument("top", "25")) });
  const report = {
    generatedAt: new Date().toISOString(),
    weekKey: ranked.generatedFor,
    universe: symbols.length,
    failed,
    ...ranked
  };

  console.log(`\nWeek ${report.weekKey || "(pending anchor)"}: ${report.actionable} of ${report.considered} names cleared every veto\n`);
  if (JOURNAL.size) {
    const familiar = report.best.filter((item) => item.inJournal).length;
    console.log(`${familiar} of the top ${report.best.length} are names from the trading journal.`);
  }
  report.best.forEach((item, position) => {
    const rungs = item.entries.map((entry) => `L${entry.level} @ ${entry.entry}→${entry.target}`).join("  ");
    console.log(`${String(position + 1).padStart(2)}. ${item.symbol.padEnd(12)} ${item.side.padEnd(5)} expected ${String(item.expectedWeeklyPct).padStart(6)}%  conviction ${String(item.convictionPct).padStart(5)}  size ×${item.sizeMultiplier}`);
    console.log(`    ${rungs}`);
  });

  // Persist & Audit Trade Signals in Ledger
  const ledgerPath = path.join(__dirname, "..", "data", "trade-signals.json");
  let ledger = [];
  try {
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) || [];
    }
  } catch {}

  const newRecords = (report.best || []).map((item) => createSignalRecord(item, { weekKey: report.weekKey }));
  for (const rec of newRecords) {
    const recId = rec.id || rec.signalId;
    if (!ledger.some((existing) => (existing.id || existing.signalId) === recId)) {
      ledger.push(rec);
    }
  }

  const performance = summarizePerformance(ledger);
  const learning = analyzeOutcomeSignatures(ledger.filter((s) => s.outcome === "WIN" || s.outcome === "LOSS"));

  report.performance = performance;
  report.learning = learning;

  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  } catch {}

  const out = argument("out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nWritten to ${out}`);
  }
  if (googleStoreConfigured()) {
    const pathname = "weekly-plan/v1/latest.json";
    const current = await readGoogleDocument(pathname, null).catch(() => ({ etag: null }));
    await writeGoogleDocument(pathname, report, current?.etag || null);
    console.log(`Stored the plan in the operational Google Sheets store at ${pathname}`);

    const ledgerDocPath = "trade-signals/v1/ledger.json";
    const currentLedger = await readGoogleDocument(ledgerDocPath, null).catch(() => ({ etag: null }));
    await writeGoogleDocument(ledgerDocPath, { ledger, performance, learning }, currentLedger?.etag || null);
  }
  return report;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Weekly plan failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { dailyBars, planFor, run };
