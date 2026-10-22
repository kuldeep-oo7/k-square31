"use strict";
// The GM tournament's summary for TRACK (information only): the full board's top rows and the one 2005-2020 re-check,
// from the study's own outputs (branch claude/gm-tournament-2026-10-21: leaderboard-full.json, confirmation.json).
//   node scripts/gm-tournament-json.js <leaderboard-full.json> [confirmation.json] > docs/paper-rules/gm-tournament.json
const fs = require("node:fs");
const LABEL = { "SB short build-up": "Short build-up (your focus rule)", "CM1 trees long-short": "AI trees model, long-short", "CM3 trees long-only": "AI trees model, long-only",
  "LU long-unwinding bounce": "Long-unwinding bounce", "S2 borrowing surge": "Borrowing surge", "SD springy dip": "Springy dip", "KR Kronos top/bottom tenth": "Kronos AI forecast",
  "IR industry reversal": "Industry reversal", "orderflow B3 short build-up -> short 1d": "Short build-up, the study's copy",
  "dip-ml D5 RSI14<35 with SMA50>SMA200 -> long": "RSI dip in an uptrend", "dip-ml E1 OWN OU dip z<=-2 -> long": "OU dip (springy dip's twin)",
  "dip-ml D6 gap-down 2% fade (intraday)": "Gap-down 2% fade, same day" };
function build(lb, conf) {
  const tested = lb.filter((r) => r.verdict !== "NOT TESTABLE");
  const top = tested.slice(0, 10).map((r) => ({ member: r.member, label: LABEL[r.member] || r.member, trades: r.trades, u20: Math.round(r.u20), pctMean: +r.pctMean.toFixed(3), t: +r.t.toFixed(2),
    dsr: Number.isFinite(r.dsr) ? +r.dsr.toFixed(2) : null, verdict: r.verdict, fitted: Boolean(r.fitted), duplicateOf: r.duplicateOf ? LABEL[r.duplicateOf] || r.duplicateOf : null }));
  const confirmation = conf ? conf.rows.map((c) => ({ member: c.member, label: LABEL[c.member] || c.member, verdict: c.verdict, t: c.t ?? null, trades: c.trades ?? null, u20: c.u20 ?? null })) : null;
  return { study: "studies/gm-tournament-2026-10-21 (branch claude/gm-tournament-2026-10-21)", sample: "2020-10 .. 2026-10", members: tested.length,
    pass: tested.filter((r) => r.verdict === "PASS").length, promising: tested.filter((r) => r.verdict === "PROMISING").length, top, confirmation };
}
if (require.main === module) {
  const [lbFile, confFile] = process.argv.slice(2);
  const lb = JSON.parse(fs.readFileSync(lbFile, "utf8")); const conf = confFile && fs.existsSync(confFile) ? JSON.parse(fs.readFileSync(confFile, "utf8")) : null;
  process.stdout.write(JSON.stringify(build(lb, conf), null, 1) + "\n");
}
module.exports = { build, LABEL };
