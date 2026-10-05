"use strict";
// Tests for api/_lib/forward-v2.js. With K2_CM_DIR set to the full archive it also replays last year and must
// reproduce research/ta-atlas-2026-10-03 M2 SHORT's final window (995 trades).
const fs = require("node:fs");
const { maCross, strangle } = require("../api/_lib/forward-v2");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const sessions = []; for (let t = Date.parse("2025-01-01"); sessions.length < 400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const n = sessions.length;
const mk = (sym, f) => ({ sym, bars: sessions.map((d, i) => { const c = f(i); return { d, o: c, h: c * 1.01, l: c * 0.99, c, val: 1e9 }; }) });
// a stock that drifts up for a year then drops through its 150-day average on the last day
const stocks = [mk("DROP", (i) => (i === n - 1 ? 100 : 100 + i * 0.05)), mk("FLAT", () => 100)];
for (let k = 0; k < 60; k += 1) stocks.push(mk(`X${k}`, (i) => 100 + k + Math.sin(i / 7)));
const r = maCross({ sessions, stocks, start: sessions[350] });
check("a close falling through its 150-day average is a short signal for the next session", r.A.pending.some((p) => p.symbol === "DROP"), JSON.stringify(r.A.pending.slice(0, 3)));
check("a flat stock gives none", !r.A.pending.some((p) => p.symbol === "FLAT"));
const opt = new Map([[sessions[360], { idx: { NIFTY: [[sessions[364], 20400, "CE", 30, 0, 1], [sessions[364], 19600, "PE", 25, 0, 1]] } }]]);
const close = new Map([[sessions[360], 20000], [sessions[364], 20000]]);
const s = strangle({ sessions, niftyClose: close, opt, start: sessions[350] });
const t = s.trades.find((x) => x.status === "DONE");
check("a strangle that expires between its strikes keeps the premium less charges", t && t.netPct > 0 && t.netPct < (55 / 20000) * 100, JSON.stringify(t));
if (process.env.K2_CM_DIR && fs.existsSync(process.env.K2_CM_DIR)) {
  const { loadCm } = require("./springy-dip-forward"); const rr = maCross({ ...loadCm(process.env.K2_CM_DIR), start: "2025-09-18" });
  const f = rr.A.trades.filter((x) => x.netPct !== undefined && x.entryDate <= "2026-09-15");
  check("replaying the final window gives the study's 995 MA 1-150 short trades", f.length === 995, `${f.length}`);
}
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
