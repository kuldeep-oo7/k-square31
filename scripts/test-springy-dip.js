"use strict";
// Tests for api/_lib/springy-dip.js. With K2_CM_DIR set to a full NSE archive it also replays the
// backtest's final window and must reproduce research/dip-ml-2026-10-04 E1 (639 trades, +0.209%).
const fs = require("node:fs");
const { forward, lag1Autocorr, zScore, RULE } = require("../api/_lib/springy-dip");
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

check("autocorrelation of an alternating series is strongly negative", lag1Autocorr([100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100], 10, 9) < -0.8);
check("z of a close two deviations under its mean is about -2", Math.abs(zScore([10, 10, 10, 10, 12, 12, 12, 12, 8], 8, 9) + 2.1) < 0.5);

// a synthetic market where one stock zig-zags (mean-reverting) and then drops hard on the last day
const sessions = []; for (let t = Date.parse("2025-06-02"); sessions.length < 400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const mk = (sym, f) => ({ sym, bars: sessions.map((d, i) => { const c = f(i); return { d, o: c, h: c * 1.01, l: c * 0.99, c, val: 1e9 }; }) });
const zig = mk("ZIG", (i) => (i === sessions.length - 1 ? 92 : 100 + (i % 2 ? 2 : -2)));
const flat = mk("FLAT", (i) => 100 + i * 0.01);
const res = forward({ sessions, stocks: [zig, flat], rule: { ...RULE, start: sessions[300] } });
check("a mean-reverting stock that falls hard gives a signal for the next session", res.pending.some((p) => p.symbol === "ZIG"), JSON.stringify(res.pending));
check("a quiet trending stock gives none", !res.pending.some((p) => p.symbol === "FLAT"));
check("nothing finished yet means COLLECTING", res.summary.verdict === "COLLECTING");

if (process.env.K2_CM_DIR && fs.existsSync(process.env.K2_CM_DIR)) {
  const { loadCm } = require("./springy-dip-forward");
  const data = loadCm(process.env.K2_CM_DIR);
  const r = forward({ ...data, rule: { ...RULE, start: "2025-09-18" } });
  const final = r.trades.filter((t) => t.status === "DONE" && t.entryDate <= "2026-09-15");
  const mean = final.reduce((a, t) => a + t.netPct, 0) / final.length;
  check("replaying the final window reproduces the backtest (639 trades, +0.209%)", final.length === 639 && Math.abs(mean - 0.209) < 0.002, `${final.length} trades, ${mean.toFixed(3)}%`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
