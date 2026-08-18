"use strict";

// Is 2% the right number?
//
// The ladder steps 2% and takes 2%, per lot, because that is how the desk trades
// it. Those are two free parameters, and nothing so far has tested them — every
// hit rate and expectancy on the portal measures 2/2 and only 2/2.
//
// This searches a grid of step and target sizes per name, scoring each on the
// same weekly triple-barrier replay, and reports whether anything genuinely beats
// 2/2 out of sample.
//
// The danger is obvious and is the reason for the hurdle: testing 25 combinations
// on one stock will always produce a winner, and picking it is how a backtest
// gets fitted to its own history. A combination has to clear a t-statistic raised
// for the number tried, and beat 2/2 on the out-of-sample half, before it counts.
//
//   node scripts/rule-study.js CHOLAFIN SUPREMEIND AUBANK
//   node scripts/rule-study.js --top 12          the current buy list

const fs = require("node:fs");
const { dailyBars } = require("./weekly-plan");
const { weeklyCycle } = require("../api/_lib/weekly-cycle");

const STEPS = [1.5, 2, 2.5, 3, 4];
const TARGETS = [1.5, 2, 2.5, 3, 4];

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// The desk's own settings, which every candidate has to beat to be worth a change.
const BASE = { step: 2, target: 2 };

function score(cycle, side) {
  if (!cycle.ready) return null;
  const result = cycle[side];
  if (!result?.viableLevels?.length) return null;
  const out = result.outOfSample;
  return {
    side,
    weeklyPct: Number(out.averageWeeklyPct),
    inSampleWeeklyPct: Number(result.averageWeeklyPct),
    rungs: result.viableLevels.length,
    tStat: Number(result.trades.tStat),
    hitPct: Number(result.trades.hitRatePct),
    lowerPct: Number(result.trades.lowerPct),
    fills: Number(result.trades.fills),
    sharpe: Number(out.annualisedSharpe)
  };
}

async function study(symbol) {
  const bars = await dailyBars(symbol);
  const rows = [];
  for (const step of STEPS) {
    for (const target of TARGETS) {
      const cycle = weeklyCycle(bars, { stepPct: step, targetPct: target });
      for (const side of ["long", "short"]) {
        const measured = score(cycle, side);
        if (measured) rows.push({ step, target, ...measured });
      }
    }
  }
  if (!rows.length) return { symbol, verdict: "nothing measurable" };

  // One hurdle for the whole grid, not per cell.
  const hurdle = Math.sqrt(2 * Math.log(STEPS.length * TARGETS.length * 2));
  const base = rows.find((row) => row.step === BASE.step && row.target === BASE.target && row.weeklyPct === Math.max(
    ...rows.filter((r) => r.step === BASE.step && r.target === BASE.target).map((r) => r.weeklyPct)
  ));
  const credible = rows.filter((row) => row.tStat >= hurdle && row.fills >= 15);
  const best = credible.sort((left, right) => right.weeklyPct - left.weeklyPct)[0];

  return {
    symbol,
    hurdle: Math.round(hurdle * 100) / 100,
    tested: rows.length,
    credible: credible.length,
    base: base || null,
    best: best || null,
    // A candidate only counts if it clears the hurdle and beats the desk's own
    // settings out of sample by a margin worth the trouble of changing.
    verdict: !best ? "no combination cleared the hurdle"
      : !base ? `${best.step}/${best.target} clears the hurdle where 2/2 does not`
        : best.step === BASE.step && best.target === BASE.target ? "2/2 is the best of the grid"
          : best.weeklyPct > base.weeklyPct * 1.25 ? `${best.step}/${best.target} beats 2/2`
            : "2/2 is within noise of the best"
  };
}

async function run() {
  let symbols = process.argv.slice(2).filter((value) => /^[A-Z0-9&-]{2,30}$/.test(value));
  const top = Number(argument("top", "0"));
  if (top > 0) {
    const plan = JSON.parse(fs.readFileSync(argument("plan", "plan-full.json"), "utf8"));
    symbols = (plan.best || []).slice(0, top).map((item) => item.symbol);
  }
  if (!symbols.length) symbols = ["CHOLAFIN", "SUPREMEIND", "AUBANK"];

  console.log(`Grid: step ${STEPS.join("/")}% against target ${TARGETS.join("/")}%, both sides, per name.`);
  console.log(`A combination must clear the multiple-testing hurdle and beat 2/2 out of sample by 25% to count.\n`);

  const verdicts = [];
  for (const symbol of symbols) {
    try {
      const result = await study(symbol);
      verdicts.push(result);
      const base = result.base ? `${result.base.weeklyPct}%/wk (${result.base.side})` : "no edge at 2/2";
      const best = result.best ? `${result.best.step}/${result.best.target} ${result.best.side} ${result.best.weeklyPct}%/wk t=${result.best.tStat}` : "none";
      console.log(`${symbol.padEnd(12)} 2/2: ${base.padEnd(26)} best: ${best}`);
      console.log(`${"".padEnd(12)} ${result.credible}/${result.tested} combinations cleared t≥${result.hurdle} — ${result.verdict}`);
    } catch (error) {
      console.warn(`${symbol.padEnd(12)} skipped (${String(error?.message || error).slice(0, 60)})`);
    }
  }

  const kept = verdicts.filter((item) => /is the best|within noise/.test(item.verdict || "")).length;
  const beaten = verdicts.filter((item) => /beats 2\/2|clears the hurdle where/.test(item.verdict || "")).length;
  console.log(`\n2/2 held up on ${kept} name(s); something beat it on ${beaten}.`);
  const out = argument("out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), steps: STEPS, targets: TARGETS, verdicts }, null, 2));
    console.log(`Written to ${out}`);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Rule study failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { STEPS, TARGETS, study };
