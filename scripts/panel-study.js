"use strict";

/**
 * Pooled panel study of the weekly ladder.
 *
 * `weeklyCycle` answers "should this symbol be laddered". It cannot answer
 * "does laddering work", because that question is only visible across the whole
 * universe at once. This script answers the second one, and it is deliberately
 * built so that a negative answer is reportable:
 *
 *   - every geometry in the grid is measured on development, validation and an
 *     untouched final test, cut on shared calendar dates;
 *   - an equal-weighted buy-and-hold of the identical names over the identical
 *     windows runs alongside, so a rising market cannot be read as edge;
 *   - the hurdle every result is scored against is the expected maximum of the
 *     number of configurations actually tried, not of the one being looked at;
 *   - six standard cross-sectional conditioners are profiled for whether their
 *     ranking keeps its sign out of sample.
 *
 * Usage:
 *   node scripts/panel-study.js --fetch              populate the bar cache
 *   node scripts/panel-study.js                      run the study
 *   node scripts/panel-study.js --side short --json  short side, machine output
 */

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_CONFIG, tradingWeeks, replayContinuous, weeklyCycle } = require("../api/_lib/weekly-cycle");
const {
  assignSplit,
  benchmarkBySplit,
  calendarSplitBoundaries,
  clusterRobustMean,
  deflatedTStat,
  expectedMaxTStat,
  panelVerdict,
  quintileProfile
} = require("../api/_lib/panel");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const CACHE = path.resolve(flag("cache", path.join(__dirname, "..", ".cache", "panel-bars")));
const SIDE = flag("side", "long");
const STOPS = (flag("stops", "0.75,1,1.5,2,2.5,3")).split(",").map(Number);
const TARGETS = (flag("targets", "1.5,2,3,4")).split(",").map(Number);
const SPLITS = ["development", "validation", "finalTest"];
const FEATURES = ["mom12_1", "reversal5", "relStrength21", "pctOf52wHigh", "atrPct", "volumeRatio"];

const isoOf = (seconds) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const fixed = (value, digits = 4) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "--");

async function populateCache() {
  const { fetchChart } = require("../api/_lib/market-feed");
  const { universe } = require("../api/_lib/universe");
  fs.mkdirSync(CACHE, { recursive: true });
  const symbols = universe().filter((row) => row.marketCapCategory === "Large Cap").map((row) => row.symbol);
  let stored = 0;
  for (const symbol of symbols) {
    const file = path.join(CACHE, `${symbol}.json`);
    if (fs.existsSync(file)) { stored += 1; continue; }
    try {
      const result = await fetchChart(symbol, { range: "5y", interval: "1d", timeout: 20_000 });
      const stamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
      const bars = [];
      for (let index = 0; index < stamps.length; index += 1) {
        const open = quote.open?.[index];
        const high = quote.high?.[index];
        const low = quote.low?.[index];
        const close = quote.close?.[index];
        if (![open, high, low, close].every(Number.isFinite)) continue;
        // Yahoo back-adjusts splits inside OHLC but not dividends; adjclose/close
        // recovers the dividend factor so a research series is total-return.
        const factor = Number.isFinite(adjusted[index]) && close > 0 ? adjusted[index] / close : 1;
        bars.push([stamps[index], +(open * factor).toFixed(4), +(high * factor).toFixed(4), +(low * factor).toFixed(4), +(close * factor).toFixed(4), quote.volume?.[index] || 0]);
      }
      if (bars.length < 400) throw new Error(`only ${bars.length} usable bars`);
      fs.writeFileSync(file, JSON.stringify(bars));
      stored += 1;
      process.stderr.write(".");
    } catch (error) {
      process.stderr.write("x");
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  process.stderr.write(`\ncached ${stored} of ${symbols.length} symbols in ${CACHE}\n`);
}

function cachedSymbols() {
  if (!fs.existsSync(CACHE)) return [];
  return fs.readdirSync(CACHE).filter((name) => name.endsWith(".json")).sort();
}

function loadBars(file) {
  return JSON.parse(fs.readFileSync(path.join(CACHE, file)))
    .map((row) => ({ timestamp: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] }));
}

/** Backward-looking conditioners measured at the cohort anchor and never after it. */
function conditionersAt(bars, index) {
  if (index < 260 || index >= bars.length) return null;
  const close = bars[index].close;
  let trueRange = 0;
  for (let i = index - 14; i < index; i += 1) {
    trueRange += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }
  let yearHigh = 0;
  for (let i = index - 252; i < index; i += 1) yearHigh = Math.max(yearHigh, bars[i].high);
  const recentVolume = mean(bars.slice(index - 5, index).map((bar) => bar.volume));
  const baseVolume = mean(bars.slice(index - 60, index).map((bar) => bar.volume));
  return {
    mom12_1: (bars[index - 21].close / bars[index - 252].close - 1) * 100,
    reversal5: (close / bars[index - 5].close - 1) * 100,
    relStrength21: (close / bars[index - 21].close - 1) * 100,
    pctOf52wHigh: yearHigh > 0 ? close / yearHigh * 100 : null,
    atrPct: trueRange / 14 / close * 100,
    volumeRatio: baseVolume > 0 ? recentVolume / baseVolume : null
  };
}

function main() {
  const files = cachedSymbols();
  if (files.length < 10) {
    console.error(`Only ${files.length} symbols cached in ${CACHE}. Run: node scripts/panel-study.js --fetch`);
    process.exitCode = 1;
    return;
  }

  // --- shared calendar boundaries, plus the cross-sectional 21-session mean ---
  const allWeekKeys = new Set();
  const marketByDate = new Map();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE, file)));
    for (let index = 0; index < raw.length; index += 1) {
      allWeekKeys.add(isoOf(raw[index][0]));
      if (index < 21) continue;
      const change = (raw[index][4] / raw[index - 21][4] - 1) * 100;
      if (!Number.isFinite(change)) continue;
      const date = isoOf(raw[index][0]);
      const bucket = marketByDate.get(date) || { sum: 0, n: 0 };
      bucket.sum += change;
      bucket.n += 1;
      marketByDate.set(date, bucket);
    }
    raw.length = 0;
  }
  const bounds = { ...calendarSplitBoundaries([...allWeekKeys]), symbolCount: files.length };

  // --- one streaming pass: geometry grid, benchmark, conditioners, gate audit ---
  const grid = new Map();
  const benchmarkRows = [];
  const conditionerRows = [];
  const gateApprovals = [];
  let symbolsScored = 0;

  for (const file of files) {
    const bars = loadBars(file);
    const symbol = file.replace(/\.json$/, "");
    const weeks = tradingWeeks(bars);

    for (let index = 1; index < bars.length; index += 1) {
      const change = (bars[index].close / bars[index - 1].close - 1) * 100;
      if (Number.isFinite(change)) benchmarkRows.push({ session: isoOf(bars[index].timestamp), returnPct: change });
    }

    for (const stopLossPct of STOPS) {
      for (const targetPct of TARGETS) {
        const simulation = replayContinuous(weeks, SIDE, { ...DEFAULT_CONFIG, stopLossPct, targetPct });
        for (const cohort of simulation.cohorts) {
          if (!cohort.complete) continue;
          for (const trade of cohort.trades) {
            const split = assignSplit({ weekKey: cohort.weekKey, exitSession: trade.exitSession }, bounds);
            if (!split) continue;
            const key = `${stopLossPct}|${targetPct}|${split}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push({ value: Number(trade.netPct), cluster: cohort.weekKey });
          }
        }
      }
    }

    // Conditioners are profiled on the shipped geometry only: the question is
    // whether ranking rescues the rule that is actually live.
    const indexByDate = new Map(bars.map((bar, index) => [isoOf(bar.timestamp), index]));
    const shipped = replayContinuous(weeks, SIDE, DEFAULT_CONFIG);
    for (const cohort of shipped.cohorts) {
      if (!cohort.complete || !cohort.trades.length) continue;
      const anchor = indexByDate.get(cohort.weekKey);
      if (anchor === undefined) continue;
      const features = conditionersAt(bars, anchor);
      if (!features) continue;
      const market = marketByDate.get(cohort.weekKey);
      // Relative strength is only meaningful against the same day's cross-section.
      features.relStrength21 = market && market.n > 20 ? features.relStrength21 - market.sum / market.n : null;
      if (!FEATURES.every((key) => Number.isFinite(Number(features[key])))) continue;
      for (const trade of cohort.trades) {
        const split = assignSplit({ weekKey: cohort.weekKey, exitSession: trade.exitSession }, bounds);
        if (split) conditionerRows.push({ ...features, split, value: Number(trade.netPct), cluster: cohort.weekKey });
      }
    }

    // What the shipped per-symbol gate would actually have approved.
    try {
      const cycle = weeklyCycle(bars);
      symbolsScored += 1;
      for (const side of ["long", "short"]) {
        const result = cycle[side];
        if (result?.viableLevels?.length) {
          gateApprovals.push({
            symbol,
            side,
            viableLevels: result.viableLevels.join("/"),
            validationFills: result.outOfSample?.trades?.fills ?? 0,
            validationNetPct: Number(result.outOfSample?.trades?.averageNetPct),
            finalFills: result.finalTest?.trades?.fills ?? 0,
            finalNetPct: Number(result.finalTest?.trades?.averageNetPct)
          });
        }
      }
    } catch (error) { /* a symbol with too little history simply scores nothing */ }

    bars.length = 0;
  }

  const benchmark = benchmarkBySplit(benchmarkRows, bounds);
  const trials = STOPS.length * TARGETS.length;

  const cells = [];
  for (const stopLossPct of STOPS) {
    for (const targetPct of TARGETS) {
      const bySplit = {};
      for (const split of SPLITS) bySplit[split] = clusterRobustMean(grid.get(`${stopLossPct}|${targetPct}|${split}`) || []);
      cells.push({ stopLossPct, targetPct, ...bySplit, verdict: panelVerdict(bySplit, { trials, benchmark }) });
    }
  }
  const shippedCell = cells.find((cell) => cell.stopLossPct === DEFAULT_CONFIG.stopLossPct && cell.targetPct === DEFAULT_CONFIG.targetPct) || null;
  const bestOnDevelopment = cells.reduce((best, cell) =>
    (best === null || Number(cell.development?.meanPct) > Number(best.development?.meanPct) ? cell : best), null);
  const confirmed = cells.filter((cell) => cell.verdict.edgeConfirmed);

  const profiles = FEATURES.map((feature) => quintileProfile(conditionerRows, feature, { valueKey: "value", clusterKey: "cluster", splitKey: "split" }));

  const gateTrials = symbolsScored * 2;
  const approvedFinal = gateApprovals.filter((row) => Number.isFinite(row.finalNetPct) && row.finalFills > 0);
  const report = {
    universe: { symbols: files.length, symbolsScored, span: { from: bounds.firstWeek, to: bounds.lastWeek } },
    splits: { validationFrom: bounds.validationFrom, finalTestFrom: bounds.finalTestFrom, weeks: bounds.weeks },
    benchmark,
    side: SIDE,
    grid: { trials, selectionHurdleTStat: expectedMaxTStat(trials), cells },
    shippedCell,
    bestOnDevelopment,
    confirmedCells: confirmed.length,
    conditioners: profiles,
    gate: {
      trials: gateTrials,
      selectionHurdleTStat: expectedMaxTStat(gateTrials),
      approved: gateApprovals.length,
      approvalRatePct: gateTrials ? gateApprovals.length / gateTrials * 100 : null,
      expectedFalsePositivesAtFivePct: gateTrials * 0.05,
      approvals: gateApprovals,
      finalTestMeanNetPct: approvedFinal.length ? mean(approvedFinal.map((row) => row.finalNetPct)) : null
    }
  };

  if (has("json")) { console.log(JSON.stringify(report, null, 2)); return; }

  const line = (text = "") => console.log(text);
  line(`PANEL STUDY  side=${SIDE}  symbols=${files.length}  span ${bounds.firstWeek} .. ${bounds.lastWeek}`);
  line(`splits: development < ${bounds.validationFrom} <= validation < ${bounds.finalTestFrom} <= final test`);
  line();
  line("CONTROL -- equal-weighted buy-and-hold of the identical universe over the identical windows");
  line("split          sessions  meanDaily%  compounded% per name");
  for (const split of SPLITS) {
    const row = benchmark[split];
    line(`${split.padEnd(14)} ${String(row.sessions).padStart(8)}  ${fixed(row.meanDailyPct).padStart(10)}  ${fixed(row.compoundedPctPerName, 1).padStart(20)}`);
  }
  line();
  line(`GEOMETRY GRID -- ${trials} configurations, selection hurdle t >= ${expectedMaxTStat(trials)}`);
  line("stop  target |    dev net%    t |    val net%    t  deflated |  final net%    t | verdict");
  for (const cell of cells) {
    line(`${String(cell.stopLossPct).padEnd(5)} ${String(cell.targetPct).padEnd(6)} | `
      + `${fixed(cell.development.meanPct).padStart(10)} ${fixed(cell.development.tStat, 2).padStart(5)} | `
      + `${fixed(cell.validation.meanPct).padStart(10)} ${fixed(cell.validation.tStat, 2).padStart(5)} ${fixed(deflatedTStat(cell.validation.tStat, trials), 2).padStart(9)} | `
      + `${fixed(cell.finalTest.meanPct).padStart(10)} ${fixed(cell.finalTest.tStat, 2).padStart(5)} | ${cell.verdict.verdict}`);
  }
  line();
  line(`configurations whose edge survives validation: ${confirmed.length} of ${trials}`);
  if (shippedCell) {
    line(`shipped geometry ${DEFAULT_CONFIG.stopLossPct}% stop / ${DEFAULT_CONFIG.targetPct}% target -> `
      + `dev ${fixed(shippedCell.development.meanPct)}%, validation ${fixed(shippedCell.validation.meanPct)}% (t ${fixed(shippedCell.validation.tStat, 2)}), ${shippedCell.verdict.verdict}`);
  }
  if (bestOnDevelopment) {
    line(`best on development ${bestOnDevelopment.stopLossPct}% / ${bestOnDevelopment.targetPct}% -> `
      + `dev ${fixed(bestOnDevelopment.development.meanPct)}% (t ${fixed(bestOnDevelopment.development.tStat, 2)}), `
      + `validation ${fixed(bestOnDevelopment.validation.meanPct)}% (t ${fixed(bestOnDevelopment.validation.tStat, 2)})`);
  }
  line();
  line("CONDITIONER STABILITY -- quintile mean net% per fill, Q1 lowest. A conditioner is only real if its spread keeps its sign.");
  for (const profile of profiles) {
    line(`${profile.feature}  signStable=${profile.signStable}`);
    for (const split of SPLITS) {
      const row = profile[split];
      if (!row) { line(`  ${split.padEnd(13)} --`); continue; }
      line(`  ${split.padEnd(13)} ${row.bandMeans.map((value) => fixed(value, 3).padStart(8)).join("")}   spread ${fixed(row.spread, 3).padStart(8)}  n=${row.n}`);
    }
  }
  line();
  line(`SHIPPED GATE AUDIT -- ${report.gate.approved} of ${gateTrials} symbol-sides approved (${fixed(report.gate.approvalRatePct, 1)}%)`);
  line(`  pure chance at a 5% per-test rate would approve about ${fixed(report.gate.expectedFalsePositivesAtFivePct, 0)}`);
  line(`  correct hurdle for a ${gateTrials}-configuration search: t >= ${expectedMaxTStat(gateTrials)} (the per-symbol gate scores against 6 trials)`);
  if (report.gate.finalTestMeanNetPct !== null) {
    line(`  approved ladders on the untouched final test: ${fixed(report.gate.finalTestMeanNetPct)}% per fill across ${approvedFinal.length} symbol-sides`);
  }
  for (const row of gateApprovals) {
    line(`  ${row.symbol.padEnd(14)} ${row.side.padEnd(6)} L${row.viableLevels.padEnd(6)} `
      + `validation ${String(row.validationFills).padStart(4)} fills ${fixed(row.validationNetPct, 3).padStart(8)}%  `
      + `final ${String(row.finalFills).padStart(4)} fills ${fixed(row.finalNetPct, 3).padStart(8)}%`);
  }
}

if (has("fetch")) populateCache().then(main);
else main();
