"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): selling NIFTY options on expiry day.
//   node study.js --synthetic                  checks 7.1 and 7.2 only (no real data)
//   K2_NOD_DIR=<nifty option days> K2_IDX_DIR=<ind_close_all csv dir> node study.js     the one real run (writes RESULT.txt)
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const QTY = 75, SLIP = 1, N_TRIALS = 10;
const MEMBERS = { X1: "ATM straddle, held", X2: "ATM straddle, 2x stop per leg", X3: "1% strangle, held", X4: "1% strangle, 2x stop per leg" };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }

// One short leg: sold at its open; bought back at 2x if the day's high reached it (stop members), else settled at
// intrinsic. Costs: the desk's option model with the SELL at the entry premium (STT on the sale), plus slippage.
function leg(row, S, stop, costs) {
  const [, K, typ, open, high] = row; if (!(open > 0)) return null;
  const intrinsic = typ === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  const stopped = stop && high >= 2 * open; const exit = stopped ? 2 * open : intrinsic;
  let cost = 0; if (costs) { const r = roundTripCost({ entryPremium: Math.max(exit, 0.05), exitPremium: open, quantity: QTY }); if (!r) return null; cost = r.totalCost / QTY + SLIP; }
  return { pnl: open - exit - cost, stopped };
}
const nearest = (rows, typ, target) => { const c = rows.filter((r) => r[2] === typ); if (!c.length) return null;
  return c.reduce((best, r) => { const d = Math.abs(r[1] - target), b = Math.abs(best[1] - target); return d < b || (d === b && Math.abs(r[1] - target) === b && (typ === "CE" ? r[1] > best[1] : r[1] < best[1])) ? r : best; }); };

// days: [{date, open (NIFTY), settle (NIFTY final settlement), rows: [[exp, K, typ, open, high, low, close, settle, oi, n]]}]
function run(days, costs = true) {
  const out = { X1: [], X2: [], X3: [], X4: [] }; let skipped = 0;
  for (const d of days) {
    const rows = d.rows.filter((r) => r[0] === d.date); if (!rows.length) continue;
    if (!(d.open > 0) || !(d.settle > 0)) { skipped += 1; continue; }
    const atmC = nearest(rows, "CE", d.open), atmP = nearest(rows, "PE", d.open), oC = nearest(rows, "CE", d.open * 1.01), oP = nearest(rows, "PE", d.open * 0.99);
    for (const [k, c, p, stop] of [["X1", atmC, atmP, false], ["X2", atmC, atmP, true], ["X3", oC, oP, false], ["X4", oC, oP, true]]) {
      if (!c || !p) { skipped += 1; continue; }
      const a = leg(c, d.settle, stop, costs), b = leg(p, d.settle, stop, costs); if (!a || !b) { skipped += 1; continue; }
      out[k].push({ date: d.date, pct: ((a.pnl + b.pnl) / d.open) * 100, points: a.pnl + b.pnl, stops: (a.stopped ? 1 : 0) + (b.stopped ? 1 : 0) });
    }
  }
  return { out, skipped };
}

function verdicts(out) {
  const rows = Object.keys(MEMBERS).map((k) => { const ts = out[k]; const month = new Map(); for (const t of ts) { const m = t.date.slice(0, 7); month.set(m, (month.get(m) || 0) + t.pct); }
    const s = [...month.keys()].sort().map((m) => month.get(m)); if (s.length < 24) return { key: k, months: s.length, expiries: ts.length, verdict: "NOT TESTABLE" };
    const t = nwT(s), m = mean(s), sdev = sd(s), sr = m / sdev; const g3 = mean(s.map((v) => ((v - m) / sdev) ** 3)), g4 = mean(s.map((v) => ((v - m) / sdev) ** 4));
    return { key: k, months: s.length, expiries: ts.length, meanPct: mean(ts.map((x) => x.pct)), monthMean: m, t, sr, g3, g4, p: 1 - Phi(t),
      win: (100 * ts.filter((x) => x.pct > 0).length) / ts.length, worst: Math.min(...ts.map((x) => x.pct)), worstMonth: Math.min(...s), meanPoints: mean(ts.map((x) => x.points)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649; const vSR = N > 1 ? sd(tested.map((r) => r.sr)) ** 2 : 0; const SR0 = Math.sqrt(vSR) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const fmt = (r) => r.verdict === "NOT TESTABLE" ? `${r.key} ${MEMBERS[r.key]}: NOT TESTABLE (${r.months} months)` :
  `${r.key} ${MEMBERS[r.key]}: ${r.expiries} expiries, ${r.meanPct >= 0 ? "+" : ""}${r.meanPct.toFixed(3)}% of NIFTY an expiry (${r.meanPoints >= 0 ? "+" : ""}${r.meanPoints.toFixed(1)} points), won ${r.win.toFixed(0)}%, worst expiry ${r.worst.toFixed(2)}%, worst month ${r.worstMonth.toFixed(2)}%, t ${r.t.toFixed(2)}, Holm ${r.holm ? "yes" : "no"}, DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}`;

// ---------- synthetic checks (7.1, 7.2) ----------
function synth(seed, markup) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const bs = (S, K, T, v, typ) => { if (T <= 0) return typ === "CE" ? Math.max(0, S - K) : Math.max(0, K - S); const d1 = (Math.log(S / K) + 0.5 * v * v * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
    return typ === "CE" ? S * Phi(d1) - K * Phi(d2) : K * Phi(-d2) - S * Phi(-d1); };
  const days = []; let S0 = 15000; const vol = 0.15, steps = Number(process.env.K2_SYN_STEPS || 600), T0 = 1 / 252;
  for (let i = 0; i < 380; i += 1) { const date = new Date(Date.parse("2019-02-07") + i * 7 * 864e5).toISOString().slice(0, 10);
    const path = [S0]; for (let k = 1; k <= steps; k += 1) path.push(path[k - 1] * Math.exp(vol * Math.sqrt(T0 / steps) * gauss() - 0.5 * vol * vol * T0 / steps));
    const settle = path[steps]; const rows = [];
    for (let K = Math.round(S0 / 50) * 50 - 500; K <= Math.round(S0 / 50) * 50 + 500; K += 50) for (const typ of ["CE", "PE"]) {
      const val = path.map((x, k) => bs(x, K, T0 * (1 - k / steps), vol, typ)); const open = val[0] * markup; rows.push([date, K, typ, Math.max(open, 0.05), Math.max(...val) * markup, 0, val[steps], settle, 0, 0]); }
    days.push({ date, open: S0, settle, rows, decoy: [[date, 0, "CE", 1, 1, 1, 1, 1, 0, 0]] }); S0 = settle; }
  return days;
}
function checks(log) {
  let ok = true;
  const plant = verdicts(run(synth(1, 1.2), true).out); log(` 7.1 planted (priced 20% over fair, with costs): ${plant.map((r) => `${r.key} ${r.verdict} t ${r.t === undefined ? "-" : r.t.toFixed(2)} DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"}`).join(", ")}`);
  if (!(plant.find((r) => r.key === "X1").t >= 3)) ok = false;   // amendment A1: the pipeline must find the planted edge (t >= 3)
  let passes = 0; for (const seed of [1, 2, 3]) { const v = verdicts(run(synth(seed, 1.0), false).out); passes += v.filter((r) => r.verdict === "PASS").length; log(`     null seed ${seed} (fair, no costs): ${v.map((r) => `${r.key} ${r.verdict} t ${r.t === undefined ? "-" : r.t.toFixed(2)}`).join(", ")}`); }
  log(`     null PASS results: ${passes} of 12 (at most 1 allowed)`); if (passes > 1) ok = false;
  // 7.2: changing everything that is not the expiry session's own rows (here: other dates' rows) changes nothing
  const base = synth(4, 1.0); const a = run(base, true).out.X1.map((x) => x.pct.toFixed(9)).join();
  const alt = base.map((d) => ({ ...d, rows: [...d.rows, [d.date === "x" ? d.date : "2099-01-01", 15000, "CE", 999, 999, 0, 0, 0, 0, 0]] }));
  const b = run(alt, true).out.X1.map((x) => x.pct.toFixed(9)).join(); log(` 7.2 rows of other expiries change nothing: ${a === b}`); if (a !== b) ok = false;
  log(` CHECKS: ${ok ? "PASSED" : "FAILED"}`); return ok;
}

// ---------- real data ----------
function loadReal() {
  const nod = path.resolve(process.env.K2_NOD_DIR || "nod"), idx = path.resolve(process.env.K2_IDX_DIR || "macro/ind_close_all");
  const open = new Map(); for (const f of fs.readdirSync(idx).filter((x) => x.endsWith(".csv"))) { const t = fs.readFileSync(path.join(idx, f), "utf8").split(/\r?\n/); const h = t[0].split(","); const io = h.findIndex((x) => /Open Index Value/i.test(x));
    const r = t.find((l) => /^"?Nifty 50"?,/i.test(l)); if (r && io >= 0) { const v = +r.split(",")[io]; if (v > 0) open.set(f.slice(0, 10), v); } }
  const days = []; const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".json.gz")) files.push(p); } }; walk(nod);
  for (const p of files.sort()) { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p))); const exp = j.rows.filter((r) => r[0] === j.date); if (!exp.length) continue;
    const st = exp.map((r) => r[7]).filter((v) => v > 0).sort((x, y) => x - y); const settle = st.length ? st[Math.floor(st.length / 2)] : null;
    days.push({ date: j.date, open: open.get(j.date) ?? null, settle, rows: exp }); }
  return days;
}

if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  log(`EXPIRY-DAY OPTION SELLING, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`); log("CHECKS (synthetic, section 7):");
  if (!checks(log)) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECKS FAILED: real run refused.\n\n"); process.exit(1); }
  if (process.argv.includes("--synthetic")) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); process.exit(0); }
  const days = loadReal(); const { out, skipped } = run(days, true); const v = verdicts(out);
  log(`\nREAL DATA: ${days.length} expiry sessions (${days[0]?.date} .. ${days.at(-1)?.date}); skipped ${skipped} member-expiries (missing leg, open or settlement). Return = % of NIFTY's open, after charges + 1 point a leg.`);
  for (const r of v) log(fmt(r));
  log(`PASS: ${v.filter((r) => r.verdict === "PASS").map((r) => r.key).join(", ") || "none"}. PROMISING: ${v.filter((r) => r.verdict === "PROMISING").map((r) => r.key).join(", ") || "none"}.`);
  log("\nSUB-PERIODS (reported, not judged):");
  for (const [a, b, name] of [["2019-01-01", "2024-11-19", "to 19 Nov 2024 (before SEBI's measures)"], ["2024-11-20", "2025-09-01", "20 Nov 2024 - 1 Sep 2025 (SEBI measures, Thursday expiry)"], ["2025-09-02", "2099-01-01", "from 2 Sep 2025 (Tuesday expiry)"]]) {
    log(` ${name}: ` + Object.keys(MEMBERS).map((k) => { const x = out[k].filter((t) => t.date >= a && t.date <= b); return x.length ? `${k} ${x.length} exp ${mean(x.map((t) => t.pct)) >= 0 ? "+" : ""}${mean(x.map((t) => t.pct)).toFixed(3)}% won ${Math.round(100 * x.filter((t) => t.pct > 0).length / x.length)}%` : `${k} none`; }).join(" | ")); }
  log("\nBY YEAR (X2, the common retail version):"); const years = [...new Set(out.X2.map((t) => t.date.slice(0, 4)))].sort();
  for (const y of years) { const x = out.X2.filter((t) => t.date.startsWith(y)); log(`  ${y}: ${x.length} expiries, mean ${mean(x.map((t) => t.pct)).toFixed(3)}%, sum ${x.reduce((s, t) => s + t.points, 0).toFixed(0)} points (x75 = Rs ${(x.reduce((s, t) => s + t.points, 0) * 75).toFixed(0)} a lot)`); }
  log("\nFOR A Rs 6 LAKH ACCOUNT (information only; one lot of 75, margin not modelled): average rupees a month per member = " +
    Object.keys(MEMBERS).map((k) => { const m = new Map(); for (const t of out[k]) m.set(t.date.slice(0, 7), (m.get(t.date.slice(0, 7)) || 0) + t.points * 75); const s = [...m.values()]; return `${k} Rs ${Math.round(mean(s))}`; }).join(", "));
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ verdicts: v, skipped }, null, 1));
}
module.exports = { run, verdicts, synth };
