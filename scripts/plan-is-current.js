"use strict";

// A weekly anchor is not a freshness certificate. Refresh research at least hourly;
// independently, a continuous quote observer can alert between research rebuilds.
//
//   node scripts/plan-is-current.js plan.json && echo "reuse it"

const fs = require("node:fs");
const { weekKeyOf } = require("../api/_lib/weekly-cycle");

function istToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(nowMs));
}

function run() {
  const source = process.argv[2] || "plan.json";
  const plan = JSON.parse(fs.readFileSync(source, "utf8"));
  const current = weekKeyOf(istToday());
  if (!planIsCurrent(plan)) {
    console.log(`Plan is for week ${plan.weekKey}; this week is ${current}. Re-measuring.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Plan already covers week ${current}. Reusing it.`);
}

function planIsCurrent(plan, nowMs = Date.now()) {
  const current = weekKeyOf(istToday(nowMs));
  const generated = Date.parse(plan?.generatedAt);
  return plan?.weekKey === current && plan?.strategyVersion === "continuous-futures-v2"
    && Number.isFinite(generated) && generated <= nowMs && nowMs - generated <= 60 * 60000
    && istToday(generated) === istToday(nowMs)
    && plan?.marketCoverage?.derivativesVerified === true
    && (plan.best || []).every(item => item.weekKey === current && (item.entries || []).every(entry => {
      const intent = entry.orderIntent;
      return intent?.weekKey === current && Number.isFinite(Date.parse(intent.decisionAt)) && Date.parse(intent.decisionAt) <= generated
        && !["target2Price", "target3MacroPrice", "stagedExecutionPlan", "runnerTargetPrice"].some(key => Object.hasOwn(entry, key) || Object.hasOwn(intent, key));
    }));
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.log(`No usable plan to reuse (${String(error?.message || error).slice(0, 80)}). Re-measuring.`);
    process.exitCode = 1;
  }
}

module.exports = { istToday, planIsCurrent };
