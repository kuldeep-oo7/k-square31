"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic | node study.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const HOLD = 5, NOTIONAL = 500000, MIN_BARS = 250, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18, LAMBDA = 10;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
const MEMBERS = ["D1 5-day losers -> long", "D2 5-day winners -> short", "D3 3 lower closes over SMA200 -> long", "D4 IBS<=0.2 over SMA200 -> long",
  "D5 RSI14<35 with SMA50>SMA200 -> long", "D6 gap-down 2% fade (intraday)", "E1 OWN OU dip z<=-2 -> long", "E2 OWN OU spike z>=+2 -> short",
  "E3 OWN ridge ML top 10% -> long", "E4 OWN ridge ML bottom 10% -> short"];
const FEATS = ["r5", "r20", "r60", "rsi", "d50", "atr", "vol", "ibs", "ac"];

const sma = (x, n) => { const o = new Array(x.length).fill(null); let s = 0; for (let i = 0; i < x.length; i += 1) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const rma = (x, n) => { const o = new Array(x.length).fill(null); let r = null; for (let i = 0; i < x.length; i += 1) { if (x[i] === null) continue; if (r === null) { if (i >= n && x.slice(i - n + 1, i + 1).every((v) => v !== null)) { let s = 0; for (let j = i - n + 1; j <= i; j += 1) s += x[j]; r = s / n; } } else r = (r * (n - 1) + x[i]) / n; o[i] = r; } return o; };
function rsi(c, n) { const up = c.map((v, i) => (i ? Math.max(v - c[i - 1], 0) : null)), dn = c.map((v, i) => (i ? Math.max(c[i - 1] - v, 0) : null)); const u = rma(up, n), d = rma(dn, n);
  return c.map((_, i) => (u[i] === null || d[i] === null ? null : d[i] === 0 ? 100 : 100 - 100 / (1 + u[i] / d[i]))); }
function sd(x, n) { const o = new Array(x.length).fill(null); for (let i = n - 1; i < x.length; i += 1) { let m = 0; for (let j = i - n + 1; j <= i; j += 1) m += x[j]; m /= n; let v = 0; for (let j = i - n + 1; j <= i; j += 1) v += (x[j] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; }
function ac1(c, i, n) { const r = []; for (let j = i - n + 1; j <= i; j += 1) r.push(c[j] / c[j - 1] - 1); const m = r.reduce((a, b) => a + b, 0) / r.length; let num = 0, den = 0;
  for (let k = 0; k < r.length; k += 1) { den += (r[k] - m) ** 2; if (k) num += (r[k] - m) * (r[k - 1] - m); } return den > 0 ? num / den : 0; }

function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) { let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k]; } }
  return M.map((r, i) => r[n] / r[i]); }
const zByDay = (recs, key) => { const by = new Map(); for (const r of recs) { if (!by.has(r.d)) by.set(r.d, []); by.get(r.d).push(r); }
  for (const g of by.values()) { const xs = g.map((r) => r[key]); const m = xs.reduce((a, b) => a + b, 0) / xs.length; const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    for (const r of g) r[`z_${key}`] = (r[key] - m) / s; } };

function run(data, { costs = true } = {}) {
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  const months = new Map(); for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  const cutsOf = new Map(); for (const st of data.stocks) { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); cutsOf.set(st.sym, cut); }
  const members = new Map();
  for (const [m, first] of months) { const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < MIN_BARS) continue;
      const v = st.bars.slice(Math.max(lc, k - VALUE_WINDOW), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0]))); }
  const recs = [];
  const costOf = (entry, exit, d, ed, cross) => { if (!costs) return 0; const q = Math.ceil(NOTIONAL / entry); return (charge("BUY", entry, q, d) + charge("SELL", exit, q, ed) + cross * (charge("BUY", exit, q, ed) + charge("SELL", exit, q, ed))) / (entry * q); };
  for (const st of data.stocks) {
    const cuts = cutsOf.get(st.sym).concat([st.bars.length]);
    for (let s = 0; s < cuts.length - 1; s += 1) {
      const seg = st.bars.slice(cuts[s], cuts[s + 1]); if (seg.length < MIN_BARS + HOLD) continue;
      const c = seg.map((b) => b.c), h = seg.map((b) => b.h), l = seg.map((b) => b.l), v = seg.map((b) => b.v || 0);
      const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200), sd20 = sd(c, 20), r14 = rsi(c, 14), v20 = sma(v, 20);
      const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i])); const atr = rma(tr, 14);
      let prevD5 = false;
      for (let i = MIN_BARS; i < seg.length; i += 1) {
        const p = i - 1; const d = seg[i].d;
        const d5 = r14[p] !== null && r14[p] < 35 && s50[p] > s200[p]; const d5event = d5 && !prevD5; prevD5 = d5;
        if (i + HOLD - 1 >= seg.length) continue;
        const win = windowOf(d); if (!members.get(d.slice(0, 7))?.has(st.sym)) continue;
        if (sIndex.get(seg[p].d) !== sIndex.get(d) - 1) continue;
        const rg = h[p] - l[p]; const ibs = rg > 0 ? (c[p] - l[p]) / rg : 0.5;
        const ac = ac1(c, p, 120); const z = sd20[p] > 0 ? (c[p] - s20[p]) / sd20[p] : 0;
        const exitI = i + HOLD - 1; const cross = new Set(seg.slice(i, exitI + 1).map((b) => b.d.slice(0, 7))).size - 1;
        const cst = costOf(seg[i].o, c[exitI], d, seg[exitI].d, cross);
        const g5 = c[exitI] / seg[i].o - 1;
        recs.push({ sym: st.sym, d, win, endDay: seg[exitI].d, long: g5 - cst, short: -g5 - cst, y: g5,
          intraday: seg[i].o <= c[p] * 0.98 ? c[i] / seg[i].o - 1 - costOf(seg[i].o, c[i], d, d, 0) : null,
          r5: c[p] / c[p - 5] - 1, r20: c[p] / c[p - 20] - 1, r60: c[p] / c[p - 60] - 1, rsi: r14[p] ?? 50, d50: c[p] / s50[p] - 1, atr: (atr[p] ?? 0) / c[p],
          vol: v20[p] > 0 ? v[p] / v20[p] : 1, ibs, ac, z,
          sigD3: c[p] > s200[p] && c[p] < c[p - 1] && c[p - 1] < c[p - 2] && c[p - 2] < c[p - 3] && !(c[p - 3] < c[p - 4]),
          sigD4: ibs <= 0.2 && c[p] > s200[p], sigD5: d5event, sigE1: ac < -0.05 && z <= -2, sigE2: ac < -0.05 && z >= 2 });
      }
    }
  }
  const trades = []; const add = (r, k, net) => { if (r.win) trades.push({ member: MEMBERS[k], day: r.d, window: r.win, net }); };
  const byDay = new Map(); for (const r of recs) { if (!byDay.has(r.d)) byDay.set(r.d, []); byDay.get(r.d).push(r); }
  for (const [, g] of byDay) { const s = g.slice().sort((a, b) => a.r5 - b.r5); const k = Math.max(1, Math.floor(s.length * 0.1));
    for (const r of s.slice(0, k)) add(r, 0, r.long); for (const r of s.slice(-k)) add(r, 1, r.short); }
  for (const r of recs) { if (r.sigD3) add(r, 2, r.long); if (r.sigD4) add(r, 3, r.long); if (r.sigD5) add(r, 4, r.long); if (r.intraday !== null) add(r, 5, r.intraday);
    if (r.sigE1) add(r, 6, r.long); if (r.sigE2) add(r, 7, r.short); }
  // walk-forward ridge
  for (const f of FEATS) zByDay(recs, f); zByDay(recs, "y");
  const quarters = []; for (const d of data.sessions) { const q = d.slice(0, 4) + "Q" + Math.floor((+d.slice(5, 7) - 1) / 3); if (!quarters.length || quarters.at(-1)[0] !== q) quarters.push([q, d]); }
  const sortedRecs = recs.slice().sort((a, b) => (a.endDay < b.endDay ? -1 : 1));
  for (let qi = 0; qi < quarters.length; qi += 1) {
    const start = quarters[qi][1], end = quarters[qi + 1]?.[1] || "9999";
    const train = []; for (const r of sortedRecs) { if (r.endDay >= start) break; train.push(r); }
    if (new Set(train.map((r) => r.d)).size < 250) continue;
    const X = train.map((r) => FEATS.map((f) => r[`z_${f}`])), y = train.map((r) => r.z_y);
    const A = FEATS.map((_, a) => FEATS.map((__, b) => X.reduce((s, x) => s + x[a] * x[b], 0) + (a === b ? LAMBDA : 0)));
    const bv = FEATS.map((_, a) => X.reduce((s, x, k) => s + x[a] * y[k], 0)); const beta = solve(A, bv);
    for (const [d, g] of byDay) { if (d < start || d >= end) continue;
      const scored = g.map((r) => [r, FEATS.reduce((s, f, k) => s + beta[k] * r[`z_${f}`], 0)]).sort((a, b) => a[1] - b[1]); const k = Math.max(1, Math.floor(scored.length * 0.1));
      for (const [r] of scored.slice(-k)) add(r, 8, r.long); for (const [r] of scored.slice(0, k)) add(r, 9, r.short); }
  }
  return { trades };
}

function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { if (!Number.isFinite(t) || df < 1) return 1; const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return Math.min(1, Math.max(0, s * h)); }
function stats(rows) { if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null }; const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat, winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length }; }
function verdicts(trades) { const by = new Map(MEMBERS.map((n) => [n, { development: [], validation: [], final: [] }])); for (const t of trades) by.get(t.member)[t.window].push(t);
  const out = {}; for (const n of MEMBERS) { const g = by.get(n); out[n] = { development: stats(g.development), validation: stats(g.validation), final: stats(g.final) }; out[n].p = out[n].final.trades ? pUpper(out[n].final.t, out[n].final.months - 1) : 1; }
  const order = MEMBERS.slice().sort((a, b) => out[a].p - out[b].p); let ok = true;
  order.forEach((n, k) => { const o = out[n], a = 0.05 / (order.length - k); const holm = ok && o.p <= a; if (!holm) ok = false; o.holmAlpha = a;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE" : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL"; }); return out; }

function synthetic(seed, { plant = false } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const stocks = []; for (let k = 0; k < 60; k += 1) { let px = 300; const bars = [], e = [];
    sessions.forEach((d) => { const shock = 0.015 * gauss(); const rev = plant ? -0.12 * e.slice(-5).reduce((a, b) => a + b, 0) : 0; e.push(shock);
      const o = px * (1 + 0.002 * gauss()); const c = o * (1 + shock + rev); bars.push({ d, o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c, v: 1e5 * (1 + rnd()), val: 1e8 * (1 + rnd()) }); px = c; });
    stocks.push({ sym: `S${k}`, bars }); }
  return { sessions, stocks };
}
const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (st) => (st.trades ? `${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}% t ${st.t.toFixed(2)} win ${st.winPct.toFixed(0)}% (${st.trades})` : "no trades");

if (process.argv.includes("--synthetic")) {
  const pv = verdicts(run(synthetic(9, { plant: true }), { costs: false }).trades);
  line(`(1) planted reversal: D1 final ${fmt(pv[MEMBERS[0]].final)}; E3 ML final ${fmt(pv[MEMBERS[8]].final)}`);
  const ok1 = pv[MEMBERS[0]].final.meanPct > 0 && pv[MEMBERS[0]].final.t > 2;
  let passes = 0; for (let k = 1; k <= 4; k += 1) passes += Object.values(verdicts(run(synthetic(k * 313)).trades)).filter((x) => x.verdict === "PASS").length;
  line(`(2) 4 random walks x 10 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(41); const cut = base.sessions[1100]; const a = run(base).trades.filter((x) => x.day < base.sessions[1100 - HOLD - 1]);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.1; b.h *= 1.3; b.l *= 0.9; b.c *= 0.8; b.v *= 5; }
  const b2 = run(base).trades.filter((x) => x.day < base.sessions[1100 - HOLD - 1]);
  const key = (x) => `${x.member}|${x.day}|${x.net}`; const A = a.map(key).sort(), B = b2.map(key).sort();
  const same = A.length === B.length && A.every((x, k) => x === B[k]);
  line(`(3) changing every price after ${cut}: ${a.length} earlier trades ${same ? "IDENTICAL (the ML never saw the future)" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}
const cmDir = path.join(ROOT, "research", "rising-stocks-2026-10-02", "nse-data", "cm");
const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , v, val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, v, val }); } }
const res = run({ sessions, stocks: [...bySym.values()] }); const v = verdicts(res.trades);
line(`DIP + OWN -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); ${res.trades.length} trades`);
for (const [n, o] of Object.entries(v)) line(`${n.padEnd(38)} | dev ${fmt(o.development)} | val ${fmt(o.validation)} | final ${fmt(o.final)} | p ${o.p.toExponential(1)} vs ${o.holmAlpha.toFixed(4)} | ${o.verdict}`);
const pass = Object.entries(v).filter(([, o]) => o.verdict === "PASS").map(([n]) => n); line(`\nPASS: ${pass.length ? pass.join(", ") : "none"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v }, null, 2));
