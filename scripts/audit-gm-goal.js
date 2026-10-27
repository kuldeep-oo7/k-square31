"use strict";

// Read the existing evidence; do not turn per-trade means into a weekly 3% claim.
const fs = require("node:fs");
const path = require("node:path");
function audit(dir = path.resolve(__dirname, "..", "docs", "paper-rules")) {
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8")); } catch { return null; } };
  const tournament = read("gm-tournament"), oi = read("oi-flow"), trees = read("sb-trees"), ai = read("daytrader");
  return { goal: { platform: "GM friends competition", instrument: "FUTURES", targetPct: 3,
    denominator: "ACTUAL_ENTRY_PRICE", window: "7 calendar days, entry day included; capped at contract expiry" },
    status: "NO_VALIDATED_3_PERCENT_WEEKLY_RULE",
    reason: "Existing studies did not validate a 3% exit from the actual futures fill within a week. A profitable mean, a target touch, and a completed 3% trade are different measurements.",
    evidence: [
      { name: "GM tournament", source: "docs/paper-rules/gm-tournament.json", available: !!tournament,
        tested: tournament?.members ?? null, passed: tournament?.pass ?? null, sample: tournament?.sample ?? null },
      { name: "Short build-up, actual futures diagnostic", source: "docs/paper-rules/oi-flow.json", available: !!oi,
        through: oi?.dataThrough ?? null, trades: oi?.SB?.futuresRecord?.finished ?? null,
        grossRupeesAt20Units: oi?.SB?.futuresRecord?.units === 20 ? oi.SB.futuresRecord.rupees : null,
        meanNetPriceReturnPct: oi?.SB?.futuresRecord?.meanNetPct ?? null,
        limitation: "Same-day exits, not weekly 3% targets. Rupees are before GM costs; the mean return uses the study's NSE cost model." },
      { name: "Trees picking short build-up", source: "docs/paper-rules/sb-trees.json", available: !!trees,
        through: trees?.dataThrough ?? null, verdict: trees?.summary?.verdict ?? null,
        limitation: "TAKE versus SKIP test, not a weekly 3% target test." },
      { name: "AI day-trader", source: "docs/paper-rules/daytrader.json", available: !!ai,
        through: ai?.dataThrough ?? null, verdict: ai?.summary?.verdict ?? null,
        limitation: "Same-day long/short book, not individual weekly 3% targets." }
    ] };
}
if (require.main === module) console.log(JSON.stringify(audit(), null, 2));
module.exports = { audit };
