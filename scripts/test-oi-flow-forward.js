"use strict";
// Tests for api/_lib/oi-flow-forward.js. With K2_CM_DIR and K2_FUT_DIR set to the full NSE archives it also
// replays the final window and must reproduce research/orderflow-2026-10-03 B3 (1,325 trades, +0.131%).
const fs = require("node:fs");
const { forward, RULE } = require("../api/_lib/oi-flow-forward");
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sessions = []; for (let t = Date.parse("2026-06-01"); sessions.length < 100; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const n = sessions.length;
const mk = (sym, lastMove) => ({ sym, bars: sessions.map((d, i) => { const c = i === n - 1 ? 100 * (1 + lastMove) : 100; return { d, o: 100, h: c * 1.01, l: c * 0.99, c, val: 1e9 }; }) });
const stocks = [mk("UNWIND", -0.03), mk("BUILD", -0.03), mk("QUIET", -0.005)];
const oi = new Map([["UNWIND", new Map(sessions.map((d, i) => [d, i === n - 1 ? 900 : 1000]))], ["BUILD", new Map(sessions.map((d, i) => [d, i === n - 1 ? 1100 : 1000]))], ["QUIET", new Map(sessions.map((d, i) => [d, i === n - 1 ? 900 : 1000]))]]);
const r = forward({ sessions, stocks, oi, rule: { ...RULE, start: sessions[80] } });
check("price -3% with open interest -10% is a long-unwinding bounce signal", r.LU.pending.some((p) => p.symbol === "UNWIND"), JSON.stringify(r.LU.pending));
check("price -3% with open interest +10% is a short build-up signal", r.SB.pending.some((p) => p.symbol === "BUILD"));
check("a -0.5% day is not a moving day", !r.LU.pending.some((p) => p.symbol === "QUIET") && !r.SB.pending.some((p) => p.symbol === "QUIET"));
if (process.env.K2_CM_DIR && process.env.K2_FUT_DIR && fs.existsSync(process.env.K2_FUT_DIR)) {
  const { loadCm } = require("./springy-dip-forward"); const { loadOi } = require("./oi-flow-forward");
  const rr = forward({ ...loadCm(process.env.K2_CM_DIR), oi: loadOi(process.env.K2_FUT_DIR), rule: { ...RULE, start: "2025-09-18" } });
  const f = rr.SB.trades.filter((t) => t.status === "DONE" && t.entryDate <= "2026-09-15"); const m = f.reduce((a, t) => a + t.netPct, 0) / f.length;
  check("replaying the final window reproduces the study (1,325 trades, +0.131%)", f.length === 1325 && Math.abs(m - 0.131) < 0.002, `${f.length}, ${m.toFixed(3)}%`);
}
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
