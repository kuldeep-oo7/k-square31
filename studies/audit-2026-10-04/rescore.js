"use strict";
// Implements EXACTLY ./PROTOCOL.txt: re-scores every member of six studies with their OWN run() code.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const R = path.resolve(__dirname, "..");
const SHA = fs.readFileSync(path.join(__dirname, "PROTOCOL.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "PROTOCOL.txt"))).digest("hex") !== SHA) { console.error("PROTOCOL CHANGED; void."); process.exit(2); }

// load a study's code up to its synthetic block and return its run() and MEMBERS (the study's own prereg check runs too)
function loadStudy(dir) {
  const file = path.join(R, dir, "study.js"); const src = fs.readFileSync(file, "utf8");
  const cut = src.indexOf('if (process.argv.includes("--synthetic"))');
  const body = src.slice(0, cut).replace(/^"use strict";/, "");
  const m = { exports: {} };
  new Function("require", "module", "__dirname", "process", `${body}\nmodule.exports = { run, MEMBERS: typeof MEMBERS === "undefined" ? null : MEMBERS };`)(require, m, path.join(R, dir), process);
  return m.exports;
}

// ---------- shared data ----------
const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm");
const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10));
const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, pc, v, val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { id: sym, sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, pc, v, val }); } }
const stocks = [...bySym.values()];
const niftyRows = JSON.parse(fs.readFileSync(path.join(R, "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json"), "utf8")).rows;
const niftyOHLC = new Map(niftyRows.map((r) => [r.date, { open: r.open, high: r.high, low: r.low, close: r.close }]));
const niftyOC = new Map(niftyRows.map((r) => [r.date, { open: r.open, close: r.close }]));
const readMap = (dir) => { const m = new Map(); if (!fs.existsSync(dir)) return m; for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) m.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); return m; };
const fut = readMap(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"));
const deliv = readMap(path.join(R, "families-2026-10-04", "nse-extra", "deliv")), opt = readMap(path.join(R, "families-2026-10-04", "nse-extra", "opt"));
const exps = JSON.parse(fs.readFileSync(path.join(R, "situations-2026-09-29", "nifty-expiries-nse.json"), "utf8"));
const oiMap = new Map(); for (const [d, rows] of fut) for (const r of rows) { if (r[1] !== "STK") continue; if (!oiMap.has(r[0])) oiMap.set(r[0], new Map()); const m = oiMap.get(r[0]); m.set(d, (m.get(d) || 0) + r[8]); }
const fii = new Map(); for (const d of sessions) { const p = path.join(R, "orderflow-2026-10-03", "nse-fo", "part", `${d}.csv`); if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/); const head = lines.find((l) => /^Client Type/i.test(l)); const row = lines.find((l) => /^FII,/i.test(l)); if (!head || !row) continue;
  const h = head.split(",").map((x) => x.trim()), v = row.split(","); const L = +v[h.indexOf("Future Index Long")], S = +v[h.indexOf("Future Index Short")]; if (Number.isFinite(L) && Number.isFinite(S)) fii.set(d, L - S); }
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const events = []; const bmDir = path.join(R, "results-vrp-2026-10-04", "nse-board-meetings");
for (const f of fs.readdirSync(bmDir)) for (const [sym, date, purpose] of JSON.parse(fs.readFileSync(path.join(bmDir, f), "utf8"))) { if (!/result/i.test(purpose || "")) continue;
  const [dd, mm, yy] = String(date).split("-"); if (!MON[(mm || "").toUpperCase()]) continue; events.push({ sym, date: `${yy}-${MON[mm.toUpperCase()]}-${dd.padStart(2, "0")}` }); }

// ---------- run every study with its own code ----------
const all = [];
const take = (study, res, meta) => { for (const t of res.trades) all.push({ study, ...t, ...meta(t.member) }); console.log(`${study}: ${res.trades.length} trades`); };
const holdOf = { "ta-atlas": () => 10, "dip-ml": (m) => (m.startsWith("D6") ? 1 : 5), orderflow: (m) => (/ 1d$/.test(m) ? 1 : 10), families: () => 5, results: () => 10 };
const sideOf = (m) => (/short|SHORT/.test(m) && !/straddle|strangle/.test(m) ? -1 : 1);
{ const s = loadStudy("rising-stocks-2026-10-02"); take("rising", s.run({ sessions, nifty: niftyOHLC, stocks }), () => ({ excessable: false, fitted: false })); }
{ const s = loadStudy("ta-atlas-2026-10-03"); take("ta-atlas", s.run({ sessions, stocks }), () => ({ excessable: true, hold: 10, fitted: false })); }
{ const s = loadStudy("dip-ml-2026-10-04"); take("dip-ml", s.run({ sessions, stocks }), (m) => ({ excessable: true, hold: holdOf["dip-ml"](m), fitted: /^E[34]/.test(m) })); }
{ const s = loadStudy("orderflow-2026-10-03"); take("orderflow", s.run({ sessions, stocks, oi: oiMap, fii, nifty: niftyOC }), (m) => ({ excessable: m.startsWith("B"), hold: holdOf.orderflow(m), fitted: true })); }
{ const s = loadStudy("families-2026-10-04"); take("families", s.run({ sessions, stocks, deliv, fut, opt, nifty: niftyOC, niftyFutExpiries: exps.FUTIDX.slice().sort(), niftyOptExpiries: exps.OPTIDX.slice().sort() }),
  (m) => ({ excessable: /^F[1256] /.test(m), hold: 5, fitted: /^F[34] /.test(m) })); }
{ const s = loadStudy("results-vrp-2026-10-04"); take("results", s.run({ sessions, stocks, events, nifty: niftyOC, opt, niftyOptExpiries: exps.OPTIDX.slice().sort() }), (m) => ({ excessable: m.startsWith("R"), hold: 10, fitted: m.startsWith("R") })); }

// ---------- the benchmark B(d, h): equal-weighted universe return, open(d) -> close(d+h-1) ----------
const sIndex = new Map(sessions.map((d, i) => [d, i]));
const RESET = 0.18;
const cutsOf = new Map(); for (const st of stocks) { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); cutsOf.set(st.sym, cut); }
const firstOf = new Map(); for (const d of sessions) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
const uni = new Map();
for (const [m, first] of firstOf) { const ranked = [];
  for (const st of stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < 250) continue;
    const v = st.bars.slice(Math.max(lc, k - 60), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
  ranked.sort((a, b) => b[1] - a[1]); uni.set(m, ranked.slice(0, 200).map((x) => x[0])); }
const barIdx = new Map(stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
const bCache = new Map();
const B = (d, h) => { const key = `${d}|${h}`; if (bCache.has(key)) return bCache.get(key); const xs = [];
  for (const sym of uni.get(d.slice(0, 7)) || []) { const st = bySym.get(sym), i = barIdx.get(sym).get(d); if (i === undefined || i + h - 1 >= st.bars.length) continue;
    let ok = true; for (let k = i; k <= i + h - 1; k += 1) { if (sIndex.get(st.bars[k].d) !== sIndex.get(d) + (k - i)) ok = false; if (k > i && Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) ok = false; } if (!ok) continue;
    xs.push(st.bars[i + h - 1].c / st.bars[i].o - 1); }
  const v = xs.length >= 50 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; bCache.set(key, v); return v; };

// ---------- score ----------
function nwT(x, lag = 3) { const n = x.length, m = x.reduce((a, b) => a + b, 0) / n; const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const byMember = new Map(); for (const t of all) { const k = `${t.study} | ${t.member}`; if (!byMember.has(k)) byMember.set(k, []); byMember.get(k).push(t); }
const rows = [];
for (const [k, ts] of byMember) {
  const meta = ts[0]; const use = ts.filter((t) => !(meta.fitted && t.window === "development"));
  const month = new Map(); let dropped = 0;
  for (const t of use) { let v = t.net; if (meta.excessable) { const b = B(t.day, meta.hold); if (b === null) { dropped += 1; continue; } v = t.net - sideOf(t.member) * b; }
    const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(v); }
  const series = [...month.keys()].sort().map((m) => month.get(m).reduce((a, b) => a + b, 0) / month.get(m).length * 100);
  if (series.length < 24) { rows.push({ k, kind: meta.excessable ? "excess" : "net", fitted: meta.fitted, months: series.length, trades: use.length, verdict: "NOT TESTABLE" }); continue; }
  const r = nwT(series); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
  rows.push({ k, kind: meta.excessable ? "excess" : "net", fitted: meta.fitted, months: series.length, trades: use.length - dropped, meanPct: r.mean, t: r.t, sharpe, p: 1 - Phi(r.t),
    verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" });
}
// Holm across all, and the Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014)
const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { const a = 0.05 / (N - i); r.holm = ok && r.p <= a; if (!r.holm) ok = false; });
const srs = tested.map((r) => r.sharpe); const mSR = srs.reduce((a, b) => a + b, 0) / N; const vSR = srs.reduce((a, b) => a + (b - mSR) ** 2, 0) / (N - 1);
const g = 0.5772156649; const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const mid = (lo + hi) / 2; if (Phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
const SR0 = Math.sqrt(vSR) * ((1 - g) * invPhi(1 - 1 / N) + g * invPhi(1 - 1 / (N * Math.E)));   // expected max annual Sharpe of N skill-less trials
for (const r of tested) { const years = r.months / 12; r.dsr = Phi((r.sharpe - SR0) * Math.sqrt(years)); }

const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`\nRE-SCORE under PROTOCOL v2 (sha256 ${SHA}, verified), run ${new Date().toISOString()}`);
line(`${rows.length} members; ${N} testable. Expected best annual Sharpe from ${N} skill-less trials (DSR benchmark): ${SR0.toFixed(2)}. Power: over 72 months, t = 3 needs an annual Sharpe of about 1.22.`);
line(`member | scored on | months | trades | mean/trade | t (NW) | annual Sharpe | Holm | DSR | VERDICT`);
for (const r of rows.sort((a, b) => (b.t ?? -99) - (a.t ?? -99))) line(`${r.k}${r.fitted ? " [FITTED: val+final only]" : ""} | ${r.kind} | ${r.months} | ${r.trades} | ${r.meanPct === undefined ? "-" : (r.meanPct >= 0 ? "+" : "") + r.meanPct.toFixed(3) + "%"} | ${r.t === undefined ? "-" : r.t.toFixed(2)} | ${r.sharpe === undefined ? "-" : r.sharpe.toFixed(2)} | ${r.holm ? "yes" : "no"} | ${r.dsr === undefined ? "-" : r.dsr.toFixed(2)} | ${r.verdict}`);
const pass = rows.filter((r) => r.verdict === "PASS"), prom = rows.filter((r) => r.verdict === "PROMISING");
line(`\nPASS (t >= 3): ${pass.length ? pass.map((r) => r.k).join("; ") : "none"}`);
line(`PROMISING (2 <= t < 3): ${prom.length ? prom.map((r) => r.k).join("; ") : "none"}`);
line(`Survive Holm across all ${N}: ${tested.filter((r) => r.holm).map((r) => r.k).join("; ") || "none"}; DSR >= 0.95: ${tested.filter((r) => r.dsr >= 0.95).map((r) => r.k).join("; ") || "none"}`);
fs.writeFileSync(path.join(__dirname, "RESULT.txt"), out.join("\n") + "\n");
