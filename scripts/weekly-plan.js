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
const { features: modelFeatures, weeklyForecast } = require("../api/_lib/ml-model");
const { fundamentals } = require("../api/_lib/fundamentals");
const { recommendation, rankRecommendations } = require("../api/_lib/recommendation");
const { banStateForSession, fetchSecurityBanList, latestBhavcopy, frontStockFutures } = require("../api/_lib/bhavcopy");
const { carry } = require("../api/_lib/carry");
const { googleStoreConfigured, writeGoogleDocument, readGoogleDocument, appendTradeSignalsToGoogle } = require("../api/_lib/google-store");
const { createSignalRecords, evaluateOutcome, summarizePerformance } = require("../api/_lib/trade-tracker");
const { analyzeOutcomeSignatures } = require("../api/_lib/adaptive-learning");
const { trendMetrics } = require("../api/_lib/trend");
const { sectorFor } = require("../api/_lib/sectors");
const { evaluatePortfolioRisk, DEFAULT_PORTFOLIO_LIMITS } = require("../api/_lib/portfolio-risk");

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
// outside that index, so the F&O list itself is the only order-generating
// universe. The broad index is displayed separately as research-only.
function universe(front) {
  const explicit = argument("symbols");
  if (explicit && front?.size) {
    return explicit.split(",").map((value) => value.trim().toUpperCase()).filter((symbol) => front.has(symbol));
  }
  const limit = Number(argument("limit", "0"));
  if (front?.size) {
    const symbols = [...front.keys()].sort();
    return limit > 0 ? symbols.slice(0, limit) : symbols;
  }
  return [];
}

async function dailyBars(symbol) {
  const url = `${CHART}/${encodeURIComponent(`${symbol}.NS`)}?range=5y&interval=1d&includePrePost=false&events=div,splits`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`chart HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "no chart result");
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
  return (result.timestamp || []).map((timestamp, index) => {
    const rawClose = quote.close?.[index];
    const adjClose = adjclose?.[index];
    // A-1: Dividend adjustment ratio removes mechanical ex-dividend ladder dip fills
    const factor = (Number.isFinite(adjClose) && Number.isFinite(rawClose) && rawClose > 0)
      ? adjClose / rawClose
      : 1.0;
    const rawOpen = quote.open?.[index];
    const rawHigh = quote.high?.[index];
    const rawLow = quote.low?.[index];

    return {
      timestamp,
      open: Number.isFinite(rawOpen) ? Math.round(rawOpen * factor * 100) / 100 : null,
      high: Number.isFinite(rawHigh) ? Math.round(rawHigh * factor * 100) / 100 : null,
      low: Number.isFinite(rawLow) ? Math.round(rawLow * factor * 100) / 100 : null,
      close: Number.isFinite(adjClose) ? Math.round(adjClose * 100) / 100 : (Number.isFinite(rawClose) ? Math.round(rawClose * 100) / 100 : null),
      rawClose: Number.isFinite(rawClose) ? rawClose : null,
      dividendAdjFactor: Math.round(factor * 10000) / 10000,
      volume: quote.volume?.[index]
    };
  }).filter((bar) => [bar.high, bar.low, bar.close].every(Number.isFinite));
}

// Only about 214 NSE names have futures at all, so scanning the Nifty 500 spends
// most of its time measuring instruments this desk cannot trade — and returns
// recommendations it cannot act on.
async function tradableFutures() {
  try {
    const [book, banState] = await Promise.all([latestBhavcopy(), fetchSecurityBanList()]);
    const front = frontStockFutures(book.rows);
    const tradeDate = `${book.tradeDate.slice(0, 4)}-${book.tradeDate.slice(4, 6)}-${book.tradeDate.slice(6, 8)}`;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const banCurrent = banStateForSession(banState, today);
    for (const contract of front.values()) {
      contract.tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(contract.tradeDate || "")) ? contract.tradeDate : tradeDate;
      contract.banStatus = banCurrent ? (banState.symbols.has(contract.symbol) ? "BANNED" : "CLEAR") : "UNAVAILABLE";
      contract.banStatusAsOf = banState.fetchedAt;
    }
    console.log(`F&O universe from the ${book.tradeDate} bhavcopy: ${front.size} names with a front-month contract`);
    if (!banState.available) console.warn(`F&O ban file unavailable; every fresh order will fail closed (${banState.error || "unknown error"}).`);
    return { front, asOf: Date.parse(`${tradeDate}T10:00:00Z`), tradeDate, banState: { ...banState, available: banCurrent }, verified: true };
  } catch (error) {
    console.warn(`Could not verify the current F&O universe (${String(error?.message || error).slice(0, 120)}); no order-generating symbols will be measured.`);
    return { front: new Map(), asOf: Date.now(), tradeDate: null, banState: { available: false }, verified: false, error: String(error?.message || error) };
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
  // Sector must reach the order intent, or portfolio-risk.js cannot enforce its
  // concentration cap — its check is guarded by `if (proposedOrder.sector)`, so
  // an absent sector silently exempts the name from the limit entirely.
  const plan = recommendation({
    symbol, bars, cycle, model, fundamentals: financials, technical,
    carry: basis, contract, sector: sectorFor(symbol),
    requireContract: true,
    requireFundamentals: !options.skipFundamentals,
    decisionAt: new Date().toISOString()
  });
  const latestIndex = bars.length - 1;
  const featureRow = modelFeatures(bars, latestIndex);
  const featureAsOf = bars[latestIndex]?.timestamp ? Number(bars[latestIndex].timestamp) * 1000 : null;
  return {
    ...plan,
    symbolBars: bars.length,
    sector: sectorFor(symbol),
    inJournal: JOURNAL.has(symbol),
    signalFeatures: featureRow,
    featureAsOf
  };
}

async function run() {
  const skipFundamentals = process.argv.includes("--no-fundamentals");
  const { front, asOf, tradeDate, banState, verified, error: universeError } = await tradableFutures();
  const symbols = universe(front);
  console.log(`Measuring ${symbols.length} name${symbols.length === 1 ? "" : "s"}${front.size ? " — current NSE stock-futures contracts" : " — F&O data unavailable; no-trade report"}.
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

  // Portfolio-risk admission. Previously the plan listed every name that cleared
  // its own vetoes, while portfolio-risk.js -- the module that owns the
  // concentration, margin and leverage caps -- was consulted only inside
  // run-shadow-session.js. The plan could therefore recommend twenty names the
  // risk engine would never have allowed, and the reason a name was impossible
  // never reached the person reading the plan.
  //
  // WHY MACRO GATING IS NOT APPLIED HERE, deliberately: requireCompleteMacro is
  // a check on data freshness AT ORDER PLACEMENT. The weekly plan is built
  // before Monday's open and is a candidate list, not an order; the macro state
  // now is not the macro state at fill time. Gating research on a macro blip
  // would discard the whole week's work. Execution-time macro and kill-switch
  // gating lives in run-shadow-session.js, which enforces all three flags.
  const PLAN_LIMITS = {
    ...DEFAULT_PORTFOLIO_LIMITS,
    strictOrderValidation: true,
    requireSector: true,
    requireCompleteMacro: false
  };
  const admitted = [];
  for (const item of ranked.best || []) {
    const entryDecisions = [];
    for (const entry of Array.isArray(item.entries) ? item.entries : []) {
      const intent = entry?.orderIntent;
      const proposed = intent
        ? { ...intent, symbol: item.symbol, side: item.side, sector: item.sector, level: entry.level }
        : null;
      const decision = evaluatePortfolioRisk({
        proposedOrder: proposed,
        activePositions: admitted,
        accountEquity: PLAN_LIMITS.maxTotalCapital,
        limits: PLAN_LIMITS
      });
      entry.portfolioRisk = { admitted: decision.approved, reason: decision.reason };
      entryDecisions.push(entry.portfolioRisk);
      if (decision.approved) {
        admitted.push({
          clientOrderId: proposed.clientOrderId,
          symbol: item.symbol,
          side: item.side,
          sector: item.sector,
          marginBlocked: Number(proposed.estMarginRequired),
          contractNotional: Number(proposed.contractNotional)
        });
      }
    }
    const approvedCount = entryDecisions.filter((decision) => decision.admitted).length;
    item.portfolioRisk = {
      admitted: approvedCount > 0,
      approvedRungs: approvedCount,
      consideredRungs: entryDecisions.length,
      reason: approvedCount > 0
        ? `APPROVED_${approvedCount}_OF_${entryDecisions.length}_RUNGS`
        : entryDecisions[0]?.reason || "NO_ORDER_INTENT"
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    strategyVersion: "continuous-futures-v2",
    weekKey: ranked.generatedFor,
    universe: symbols.length,
    marketCoverage: (() => {
      const broad = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ai-universe-data.json"), "utf8"));
      const broadSymbols = (broad.stocks || []).map((stock) => String(stock.symbol || "").toUpperCase()).filter(Boolean);
      const derivatives = new Set(front.keys());
      return {
        orderGeneratingStockFutures: front.size,
        futuresSymbols: [...derivatives].sort(),
        broadEquitiesTracked: broadSymbols.length,
        researchOnlyEquities: broadSymbols.filter((symbol) => !derivatives.has(symbol)).length,
        derivativesAsOf: tradeDate,
        derivativesVerified: verified,
        banStatusVerified: banState?.available === true,
        universeError: universeError || null,
        broadUniverseSource: broad.source || null,
        broadUniverseGeneratedAt: broad.generatedAt || null
      };
    })(),
    failed,
    portfolioAdmitted: admitted.length,
    portfolioLimits: PLAN_LIMITS,
    ...ranked
  };

  console.log(`\nWeek ${report.weekKey || "(pending anchor)"}: ${report.actionable} of ${report.considered} names cleared every veto\n`);
  if (JOURNAL.size) {
    const familiar = report.best.filter((item) => item.inJournal).length;
    console.log(`${familiar} of the top ${report.best.length} are names from the trading journal.`);
  }
  console.log(`Portfolio risk admits ${report.portfolioAdmitted} of ${report.best.length} ranked names (max ${PLAN_LIMITS.maxOpenPositions} positions, max ${PLAN_LIMITS.maxSectorPositions} per sector).\n`);
  report.best.forEach((item, position) => {
    const rungs = item.entries.map((entry) => `L${entry.level} @ ${entry.entry}→${entry.target}`).join("  ");
    const gate = item.portfolioRisk?.admitted ? "TAKE  " : "BLOCKED";
    console.log(`${String(position + 1).padStart(2)}. ${gate} ${item.symbol.padEnd(12)} ${item.side.padEnd(5)} ${String(item.sector || "-").padEnd(28)} expected ${String(item.expectedWeeklyPct).padStart(6)}%  conviction ${String(item.convictionPct).padStart(5)}  size ×${item.sizeMultiplier}`);
    console.log(`    ${rungs}`);
    if (!item.portfolioRisk?.admitted) console.log(`    ^ ${item.portfolioRisk?.reason}`);
  });

  // Persist & Audit Trade Signals in Ledger
  const ledgerPath = path.join(__dirname, "..", "data", "trade-signals.json");
  let ledger = [];
  try {
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) || [];
    }
  } catch {}

  // Legacy outcomes were produced before post-signal filtering and fill joins
  // existed. Preserve them for audit, but never train or report on them.
  ledger = ledger.map((record) => {
    if ((record.outcome === "WIN" || record.outcome === "LOSS") && !record.fillOrderId) {
      return {
        ...record,
        quarantinedOutcome: record.outcome,
        quarantineReason: "LEGACY_OUTCOME_WITHOUT_CONFIRMED_FILL_OR_TEMPORAL_BOUNDARY",
        outcome: null,
        status: "QUARANTINED"
      };
    }
    return record;
  });

  // Resolve only confirmed fills and only with strictly newer market events.
  for (let i = 0; i < ledger.length; i += 1) {
    const record = ledger[i];
    if (record.status === "PENDING" || record.status === "ACTIVE") {
      try {
        const symbolBars = await dailyBars(record.symbol);
        ledger[i] = evaluateOutcome(record, symbolBars);
      } catch (err) {
        console.warn(`Could not evaluate outcome for ${record.symbol}: ${err.message}`);
      }
    }
  }

  // One record per rung/order. Feature names and calculations are the exact ML
  // serving pipeline, not renamed proxies or constants.
  const newRecords = (report.best || []).flatMap((item) => createSignalRecords(item, {
    ...(item.signalFeatures || {}),
    featureAsOf: item.featureAsOf || null,
    source: "ml-model.features/v1"
  }));

  for (const rec of newRecords) {
    if (!rec) continue;
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
    const tempLedgerPath = `${ledgerPath}.tmp`;
    fs.writeFileSync(tempLedgerPath, JSON.stringify(ledger, null, 2), "utf8");
    fs.renameSync(tempLedgerPath, ledgerPath);
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

    if (newRecords.length) {
      await appendTradeSignalsToGoogle(newRecords).catch((e) => console.warn(`Google Sheet ledger append warning: ${e.message}`));
      console.log(`Appended ${newRecords.length} trades permanently into K2_TRADE_LEDGER Google Sheet tab.`);
    }
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
