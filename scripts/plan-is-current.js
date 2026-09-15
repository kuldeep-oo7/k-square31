"use strict";

// Exits 0 when a published plan still belongs to the current trading week.
//
// The universe measurement is the slow half of the portal build and only changes
// when the week's anchor changes, so a half-hourly refresh carries the plan
// forward and re-measures once the week rolls over.
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
    && Number.isFinite(generated) && generated <= nowMs && nowMs - generated <= 7 * 86400000
    && plan?.marketCoverage?.derivativesVerified === true;
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.log(`No usable plan to reuse (${String(error?.message || error).slice(0, 80)}). Re-measuring.`);
    process.exitCode = 1;
  }
}

module.exports = { istToday, planIsCurrent };
