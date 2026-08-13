"use strict";

// Compares the two ways to leave a ladder position, on real history:
//
//   A  book every Friday          - flat over the weekend, losses realised weekly
//   B  hold until the 2% target   - the exit is discretionary, positions can run
//
// Neither is assumed to be correct. The point is to show what each one costs and
// pays on a given name, because the choice changes which rungs are worth taking.
//
//   node scripts/exit-policy-study.js RELIANCE ASAHIINDIA
//   node scripts/exit-policy-study.js --rung 2 SBIN

const { dailyBars } = require("./weekly-plan");
const { tradingWeeks, replayWeek, DEFAULT_CONFIG } = require("../api/_lib/weekly-cycle");

const COST = DEFAULT_CONFIG.costPct;

function sessionOf(bar) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Number(bar.timestamp) * 1000));
}

const average = (list) => (list.length ? list.reduce((sum, item) => sum + item.netPct, 0) / list.length : 0);
const median = (values) => (values.length ? [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] : null);

// Policy B: same fills, no vertical barrier. A leg that never reaches its target
// is still open at the end of the history and is marked to the last close.
function holdToTarget(bars, fills) {
  const sessionIndex = new Map(bars.map((bar, index) => [sessionOf(bar), index]));
  return fills.map((fill) => {
    const start = sessionIndex.get(fill.filledSession);
    for (let index = start + 1; index < bars.length; index += 1) {
      if (Number(bars[index].high) >= fill.target) {
        return { ...fill, sessionsHeld: index - start, resolved: true, netPct: DEFAULT_CONFIG.targetPct - COST };
      }
    }
    const last = Number(bars.at(-1).close);
    return { ...fill, sessionsHeld: bars.length - 1 - start, resolved: false, netPct: (last / fill.entry - 1) * 100 - COST };
  });
}

function percent(part, whole) {
  return whole ? `${(part / whole * 100).toFixed(1)}%` : "n/a";
}

async function study(symbol, rung) {
  const bars = await dailyBars(symbol);
  const weeks = tradingWeeks(bars);
  const fills = weeks.map((week) => replayWeek(week, "long", DEFAULT_CONFIG)).filter(Boolean)
    .flatMap((week) => week.trades.filter((trade) => trade.level === rung));
  if (!fills.length) {
    console.log(`\n${symbol}: rung ${rung} never filled in ${weeks.length} weeks`);
    return null;
  }

  const hits = fills.filter((trade) => trade.outcome === "target");
  const booked = fills.filter((trade) => trade.outcome === "friday");
  const held = holdToTarget(bars, fills);
  const resolved = held.filter((trade) => trade.resolved);
  const unresolved = held.filter((trade) => !trade.resolved);
  const slow = resolved.filter((trade) => trade.sessionsHeld > 5);

  console.log(`\n=== ${symbol} — rung ${rung} rests ${rung * DEFAULT_CONFIG.stepPct}% below the Monday open ===`);
  console.log(`filled ${fills.length} times across ${weeks.length} weeks\n`);
  console.log("POLICY A — book every Friday");
  console.log(`  reached +${DEFAULT_CONFIG.targetPct}% before Friday : ${String(hits.length).padStart(3)} (${percent(hits.length, fills.length)})  avg ${average(hits).toFixed(2)}%`);
  console.log(`  still open, sold at close  : ${String(booked.length).padStart(3)} (${percent(booked.length, fills.length)})  avg ${average(booked).toFixed(2)}%`);
  console.log(`  worst single week          : ${Math.min(...fills.map((trade) => trade.netPct)).toFixed(2)}%`);
  console.log(`  net per fill               : ${average(fills).toFixed(3)}%`);
  console.log("\nPOLICY B — hold until the target, selling is discretionary");
  console.log(`  eventually reached target  : ${String(resolved.length).padStart(3)} (${percent(resolved.length, held.length)})`);
  console.log(`  median sessions to target  : ${median(resolved.map((trade) => trade.sessionsHeld))}`);
  console.log(`  needed more than one week  : ${String(slow.length).padStart(3)} (${percent(slow.length, resolved.length)} of the winners)`);
  console.log(`  slowest winner             : ${resolved.length ? Math.max(...resolved.map((trade) => trade.sessionsHeld)) : "n/a"} sessions`);
  console.log(`  never got there            : ${String(unresolved.length).padStart(3)}  avg ${average(unresolved).toFixed(2)}% unrealised`);
  console.log(`  net per fill               : ${average(held).toFixed(3)}%`);
  const better = average(held) > average(fills) ? "holding" : "the Friday book-out";
  console.log(`\n  → on this name ${better} produced more per fill, by ${Math.abs(average(held) - average(fills)).toFixed(3)} points`);
  return { symbol, policyA: average(fills), policyB: average(held), fills: fills.length };
}

async function run() {
  const rungFlag = process.argv.indexOf("--rung");
  const rung = rungFlag > -1 ? Number(process.argv[rungFlag + 1]) : 1;
  const symbols = process.argv.slice(2).filter((value) => /^[A-Z0-9&-]{2,30}$/.test(value));
  const list = symbols.length ? symbols : ["RELIANCE", "ASAHIINDIA"];
  const results = [];
  for (const symbol of list) {
    const result = await study(symbol, rung).catch((error) => {
      console.warn(`${symbol}: skipped (${String(error?.message || error).slice(0, 80)})`);
      return null;
    });
    if (result) results.push(result);
  }
  if (results.length > 1) {
    console.log("\n=== summary, net % per fill ===");
    results.forEach((item) => console.log(`  ${item.symbol.padEnd(12)} Friday ${item.policyA.toFixed(3).padStart(7)}   hold ${item.policyB.toFixed(3).padStart(7)}   (${item.fills} fills)`));
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Exit policy study failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { holdToTarget, study };
