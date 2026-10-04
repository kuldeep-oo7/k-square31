"use strict";
// Implements EXACTLY research/published-strategies-2026-09-27/PREREGISTRATION.txt
// (sha256 6f9c28df8b6a6464bdae08fc557319ee19e0f307d866fa98c343ebba9e8d3e3c).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const PANEL = path.resolve(HERE, "..", "..", ".cache", "panel-bars");
const PREREG_SHA = "6f9c28df8b6a6464bdae08fc557319ee19e0f307d866fa98c343ebba9e8d3e3c";
const COST = 0.002, TOP = 10;
const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", DATA_END = "2026-09-15";

const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex");
if (sha !== PREREG_SHA) { console.error(`PRE-REGISTRATION CHANGED (${sha}); result void.`); process.exit(2); }

const istDay = (ts) => new Date((ts > 1e11 ? ts : ts * 1000) + 330 * 60_000).toISOString().slice(0, 10);
const closes = {}, daily = {}, monthLastDay = {};
for (const file of fs.readdirSync(PANEL).filter((f) => f.endsWith(".json"))) {
  const sym = file.replace(/\.json$/, "");
  const bars = JSON.parse(fs.readFileSync(path.join(PANEL, file), "utf8"));
  const m = {}, d = [];
  for (const b of bars) {
    const day = istDay(b[0]); const close = Number(b[4]);
    if (!(close > 0) || day > DATA_END) continue;
    d.push({ day, close });
    const key = day.slice(0, 7);
    if (!m[key] || day >= m[key].day) m[key] = { day, close };
    if (!monthLastDay[key] || day > monthLastDay[key]) monthLastDay[key] = day;
  }
  d.sort((a, b) => a.day.localeCompare(b.day));
  closes[sym] = m; daily[sym] = d;
}
const complete = Object.keys(monthLastDay).sort().filter((k) => k !== DATA_END.slice(0, 7));
const at = (k, n) => complete[complete.indexOf(k) + n];
const windowOf = (h) => (monthLastDay[h] < DEV_END ? "development" : monthLastDay[h] < FINAL_FROM ? "validation" : "final");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Volatility over the 3 calendar months ending at F (F-2, F-1, F).
function vol3m(sym, F) {
  const keep = new Set([at(F, -2), at(F, -1), F]);
  const c = daily[sym].filter((x) => keep.has(x.day.slice(0, 7))).map((x) => x.close);
  if (c.length < 60) return null;
  const r = []; for (let i = 1; i < c.length; i += 1) r.push(Math.log(c[i] / c[i - 1]));
  const mu = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - mu) ** 2, 0) / (r.length - 1));
}

const t1 = [], t2 = [], benchRows = [];
for (let i = 0; i < complete.length - 1; i += 1) {
  const F = complete[i], H = complete[i + 1];
  const all = Object.entries(closes).filter(([, m]) => m[F] && m[H]).map(([sym, m]) => ({ sym, ret: m[H].close / m[F].close - 1 }));
  if (all.length < 3 * TOP) continue;
  const bench = mean(all.map((x) => x.ret));
  benchRows.push({ F, H, bench });
  if (i >= 12) {
    const Fm12 = at(F, -12), Fm1 = at(F, -1);
    const elig = all.filter((x) => closes[x.sym][Fm12] && closes[x.sym][Fm1]);
    const b1 = mean(elig.map((x) => x.ret));
    const up = elig.filter((x) => closes[x.sym][Fm1].close / closes[x.sym][Fm12].close - 1 > 0);
    if (up.length >= TOP) t1.push({ H, window: windowOf(H), x: mean(up.map((x) => x.ret)) - b1 - COST, n: up.length });
  }
  if (i >= 2) {
    const elig = all.map((x) => ({ ...x, v: vol3m(x.sym, F) })).filter((x) => x.v !== null);
    if (elig.length >= 3 * TOP) {
      const b2 = mean(elig.map((x) => x.ret));
      elig.sort((a, b) => a.v - b.v);
      t2.push({ H, window: windowOf(H), x: mean(elig.slice(0, TOP).map((x) => x.ret)) - b2 - COST });
    }
  }
}
// T3: equal-weight index, ON when above its 10-month mean at F.
const t3 = []; let level = 1; const levels = []; let prevOn = null;
for (let i = 0; i < benchRows.length; i += 1) {
  levels.push(level); // index level at month-end F
  if (levels.length >= 10) {
    const on = level > mean(levels.slice(-10));
    const strat = (on ? benchRows[i].bench : 0) - (prevOn !== null && on !== prevOn ? COST : 0);
    t3.push({ H: benchRows[i].H, window: windowOf(benchRows[i].H), x: strat - benchRows[i].bench, on });
    prevOn = on;
  }
  level *= 1 + benchRows[i].bench;
}

// Student-t: one-sided critical value by numeric integration of the density.
function tCdf(t, df) {
  const lg = (z) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let x = z, y = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015; for (const k of c) ser += k / ++y; return -tmp + Math.log(2.5066282746310005 * ser / x); };
  const k = Math.exp(lg((df + 1) / 2) - lg(df / 2)) / Math.sqrt(df * Math.PI);
  const f = (u) => k * Math.pow(1 + (u * u) / df, -(df + 1) / 2);
  const N = 20000, a = 0, h = (t - a) / N; let s = f(a) + f(t);
  for (let j = 1; j < N; j += 1) s += f(a + j * h) * (j % 2 ? 4 : 2);
  return 0.5 + (s * h) / 3;
}
function tCrit(p, df) { let lo = 0, hi = 20; for (let j = 0; j < 80; j += 1) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
const stats = (xs) => { const m = mean(xs), sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); return { n: xs.length, mean: m, t: m / (sd / Math.sqrt(xs.length)) }; };

const out = [`THREE PUBLISHED STRATEGIES ON THE K2 PANEL -- result of the pre-registered test (prereg sha256 ${PREREG_SHA.slice(0, 16)}...)`,
  `Run ${new Date().toISOString()}. ${Object.keys(closes).length} stocks. Monthly excess returns, net of 0.20% cost.`, ""];
for (const [name, rows] of [["T1 time-series momentum", t1], ["T2 low volatility", t2], ["T3 market trend filter", t3]]) {
  const w = {}; for (const win of ["development", "validation", "final"]) { const xs = rows.filter((r) => r.window === win).map((r) => r.x); w[win] = xs.length > 1 ? stats(xs) : null; }
  const crit = w.final ? tCrit(1 - 0.05 / 3, w.final.n - 1) : null;
  const pass = w.final && w.validation && w.final.mean > 0 && w.final.t >= crit && w.validation.mean > 0;
  out.push(name);
  for (const win of ["development", "validation", "final"]) if (w[win]) out.push(`  ${win.padEnd(12)} ${String(w[win].n).padStart(3)} months  ${(100 * w[win].mean).toFixed(2).padStart(6)}%/month  t ${w[win].t.toFixed(2)}`);
  out.push(`  critical t (one-sided, alpha 0.05/3, df ${w.final ? w.final.n - 1 : "?"}): ${crit ? crit.toFixed(3) : "?"}   =>  ${pass ? "PASS (paper tracking only)" : "FAIL"}`, "");
}
out.push("A PASS means paper tracking on TRACK only; ~12 months per window: a FAIL is weak evidence, not proof.");
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
console.log(out.join("\n"));
