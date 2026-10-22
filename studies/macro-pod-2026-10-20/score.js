"use strict";
// Implements ./PREREGISTRATION.txt section 6 (with AMENDMENT-A1, A2) and the ONE real run.
//   K2_MACRO_DIR=<data-macro> K2_OOS_IDX=<data-oos nse-old/idx> node score.js     (checks 7.1-7.3 first; RESULT.txt, result.json)
const fs = require("node:fs");
const path = require("node:path");
const HERE = __dirname;
const B = require("./build");

const N_TRIALS = 10;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }

function sampleEnd(inp) {   // A1 section 3
  const S = inp.sessions; const lastN = inp.nsdl.at(-1).date; const afterN = S.find((s) => s > lastN) || S.at(-1);
  const lastP = [...inp.fii.keys()].sort().at(-1); return afterN < lastP ? afterN : lastP;
}
const monthly = (days, key = "r") => { const m = new Map(); for (const x of days) m.set(x.d.slice(0, 7), (m.get(x.d.slice(0, 7)) || 0) + x[key] * 100); return [...m.keys()].sort().map((k) => m.get(k)); };
function verdicts(bk, from, to) {
  const rows = B.MEMBERS.map((k) => { const days = bk[k].filter((x) => x.d >= from && x.d <= to); const s = monthly(days); const bh = monthly(days, "bh");
    if (s.length < 24) return { key: k, name: B.NAMES[k], months: s.length, verdict: "NOT TESTABLE" };
    const m = mean(s), sdev = sd(s), sr = m / sdev; let peak = 0, cum = 0, mdd = 0; for (const x of days) { cum += x.r; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
    const years = days.length / 247;
    return { key: k, name: B.NAMES[k], months: s.length, monthMean: m, t: nwT(s), sr, g3: mean(s.map((v) => ((v - m) / sdev) ** 3)), g4: mean(s.map((v) => ((v - m) / sdev) ** 4)),
      bhMonthMean: mean(bh), excessMonthMean: mean(s.map((v, i) => v - bh[i])), monthsUp: s.filter((v) => v > 0).length, worstMonth: Math.min(...s), maxDrawdownPct: mdd * 100,
      inMarketPct: (100 * days.filter((x) => x.pos !== 0).length) / days.length, tradesPerYear: days.filter((x) => x.change).length / years }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const n = tested.length;
  for (const r of tested) r.p = 1 - Phi(r.t);
  if (n) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (n - i); if (!r.holm) ok = false; });
    const g = 0.5772156649; const SR0 = n > 1 ? sd(tested.map((r) => r.sr)) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E))) : 0;
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const f = (v, d = 2) => (v === undefined || v === null || !Number.isFinite(v) ? "-" : (v >= 0 ? "+" : "") + v.toFixed(d));
const fmt = (r) => r.verdict === "NOT TESTABLE" ? `${r.name}: NOT TESTABLE (${r.months} months)`
  : `${r.name} | ${r.months} months | monthly mean ${f(r.monthMean, 3)}% (buy-and-hold ${f(r.bhMonthMean, 3)}%, excess ${f(r.excessMonthMean, 3)}%) | t ${f(r.t)} | Holm ${r.holm ? "yes" : "no"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} | up ${r.monthsUp}/${r.months} | worst month ${f(r.worstMonth)}% | max drawdown ${f(r.maxDrawdownPct, 1)}% | in market ${r.inMarketPct.toFixed(0)}% | ${r.tradesPerYear.toFixed(1)} changes a year -> ${r.verdict}`;

module.exports = { verdicts, sampleEnd, fmt, monthly };
if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  const sha = B.verify(); log(`MACRO POD, registration sha256 ${sha.PREREGISTRATION}, A1 ${sha["AMENDMENT-A1"]}, A2 ${sha["AMENDMENT-A2"]} (verified), run ${new Date().toISOString()}`);
  const inp = B.loadInputs(); const end = sampleEnd(inp);
  log(`DATA: NIFTY opens ${inp.sessions.length} sessions ${inp.sessions[0]} .. ${inp.sessions.at(-1)}; FII participant OI ${inp.fii.size} files; NSDL ${inp.nsdl.length} rows ${inp.nsdl[0]?.date} .. ${inp.nsdl.at(-1)?.date}; DTWEXBGS ${inp.usd.length} values ${inp.usd[0]?.date} .. ${inp.usd.at(-1)?.date}`);
  log(`VERDICT SAMPLE: ${B.SAMPLE_FROM} .. ${end} (A1 section 3)`);
  const C = require("./checks"); log("CHECKS (section 7):");
  const ok71 = C.check71(inp, log), ok72 = C.check72(inp, B.SAMPLE_FROM, end, log); C.check73(inp, log);
  if (!ok71 || !ok72) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECKS FAILED: real run refused.\n\n"); process.exit(1); }
  if (process.argv.includes("--checks")) { console.log("checks only"); process.exit(0); }
  const bk = B.books(inp); const v = verdicts(bk, B.SAMPLE_FROM, end);
  log("\nREAL RUN (monthly sums of daily book returns after futures charges, % of the Rs 10 lakh notional):"); for (const r of v) log(` ${fmt(r)}`);
  log(`PASS: ${v.filter((r) => r.verdict === "PASS").map((r) => r.key).join(", ") || "none"}. PROMISING: ${v.filter((r) => r.verdict === "PROMISING").map((r) => r.key).join(", ") || "none"}.`);
  log("\nBY PERIOD (monthly mean %, reported, not judged): " + B.MEMBERS.map((k) => `${k} ` + [["2012-04-02", "2016-12-31"], ["2017-01-01", "2021-12-31"], ["2022-01-01", end]].map(([a, b]) => { const s = monthly(bk[k].filter((x) => x.d >= a && x.d <= b)); return `${a.slice(0, 4)}-${b.slice(2, 4)} ${s.length ? f(mean(s), 3) : "-"}`; }).join(", ")).join(" | "));
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha, sample: [B.SAMPLE_FROM, end], verdicts: v.map(({ g3, g4, sr, p, ...r }) => r) }, null, 1));
}
