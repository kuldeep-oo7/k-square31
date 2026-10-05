"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic   code checks on invented data
//   node study.js               the one real run (needs nse-fo/ complete)
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
const NOTIONAL = 500000, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18, MIN_BARS = 66;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
const MEMBERS = ["B1 long build-up -> long 1d", "B2 long build-up -> long 10d", "B3 short build-up -> short 1d", "B4 short build-up -> short 10d",
  "B5 short covering -> long 1d", "B6 short covering -> long 10d", "B7 long unwinding -> short 1d", "B8 long unwinding -> short 10d",
  "C1 FII adding -> long NIFTY 1d", "C2 FII adding -> long NIFTY 5d", "C3 FII cutting -> short NIFTY 1d", "C4 FII cutting -> short NIFTY 5d"];
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function costOf(entry, exit, d, exitDay, crossings) {
  const qty = Math.ceil(NOTIONAL / entry);
  return (charge("BUY", entry, qty, d) + charge("SELL", exit, qty, exitDay) + crossings * (charge("BUY", exit, qty, exitDay) + charge("SELL", exit, qty, exitDay))) / (entry * qty);
}

// data: { sessions, stocks: [{sym, bars:[{d,o,h,l,c,val}]}], oi: Map(sym -> Map(d -> totalOI)), fii: Map(d -> net), nifty: Map(d -> {open,close}) }
function run(data, { costs = true } = {}) {
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  const months = new Map(); for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  const members = new Map();
  for (const [m, first] of months) {
    const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; if (k < MIN_BARS) continue;
      const v = st.bars.slice(k - VALUE_WINDOW, k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0])));
  }
  // stock candidate days
  const cand = [];
  for (const st of data.stocks) {
    const oi = data.oi.get(st.sym); if (!oi) continue;
    const b = st.bars; const reset = b.map((x, i) => i > 0 && Math.abs(x.o / b[i - 1].c - 1) >= RESET);
    for (let i = 2; i < b.length; i += 1) {
      const d = b[i].d; const win = windowOf(d);
      if (!win || !members.get(d.slice(0, 7))?.has(st.sym)) continue;
      if (sIndex.get(b[i - 1].d) !== sIndex.get(d) - 1 || sIndex.get(b[i - 2].d) !== sIndex.get(d) - 2) continue;
      if (reset[i - 1] || reset[i - 2]) continue;
      const o1 = oi.get(b[i - 1].d), o2 = oi.get(b[i - 2].d); if (!(o1 > 0 && o2 > 0)) continue;
      cand.push({ st, i, d, win, R: b[i - 1].c / b[i - 2].c - 1, OI: o1 / o2 - 1, reset });
    }
  }
  const dev = cand.filter((x) => x.win === "development");
  const rCut = pct(dev.map((x) => Math.abs(x.R)), 0.67), oiCut = pct(dev.map((x) => Math.abs(x.OI)), 0.67);
  const trades = [];
  for (const x of cand) {
    if (Math.abs(x.R) < rCut || Math.abs(x.OI) < oiCut || x.R === 0 || x.OI === 0) continue;
    const kind = x.R > 0 && x.OI > 0 ? 0 : x.R < 0 && x.OI > 0 ? 1 : x.R > 0 && x.OI < 0 ? 2 : 3;   // LB, SB, SC, LU
    const long = kind === 0 || kind === 2;
    for (const [hz, off] of [[1, 0], [10, 1]]) {
      const j = x.i + hz - 1; const b = x.st.bars; if (j >= b.length) continue;
      if (x.reset.slice(x.i, j + 1).some(Boolean)) continue;
      const entry = b[x.i].o, exit = b[j].c;
      const gross = long ? exit / entry - 1 : 1 - exit / entry;
      const cross = new Set(b.slice(x.i, j + 1).map((y) => y.d.slice(0, 7))).size - 1;
      trades.push({ member: MEMBERS[kind * 2 + off], day: x.d, window: x.win, net: gross - (costs ? costOf(entry, exit, x.d, b[j].d, cross) : 0) });
    }
  }
  // FII
  const fd = data.sessions.filter((d) => data.fii.has(d));
  const dF = new Map(); for (let k = 1; k < fd.length; k += 1) if (sIndex.get(fd[k]) === sIndex.get(fd[k - 1]) + 1) dF.set(fd[k], data.fii.get(fd[k]) - data.fii.get(fd[k - 1]));
  const devD = [...dF.entries()].filter(([d]) => windowOf(d) === "development").map(([, v]) => v);
  const lo = pct(devD, 1 / 3), hi = pct(devD, 2 / 3);
  for (let k = 1; k < data.sessions.length; k += 1) {
    const d = data.sessions[k], prev = data.sessions[k - 1], win = windowOf(d);
    if (!win || !dF.has(prev)) continue;
    const v = dF.get(prev); const side = v >= hi ? 1 : v <= lo ? -1 : 0; if (!side) continue;
    for (const [hz, off] of [[1, 0], [5, 1]]) {
      const ed = data.sessions[k + hz - 1]; if (!ed || !data.nifty.has(d) || !data.nifty.has(ed)) continue;
      const entry = data.nifty.get(d).open, exit = data.nifty.get(ed).close;
      const gross = side > 0 ? exit / entry - 1 : 1 - exit / entry;
      const cross = new Set(data.sessions.slice(k, k + hz).map((y) => y.slice(0, 7))).size - 1;
      trades.push({ member: MEMBERS[8 + (side > 0 ? 0 : 2) + off], day: d, window: win, net: gross - (costs ? costOf(entry, exit, d, ed, cross) : 0) });
    }
  }
  return { trades, rCut, oiCut, fiiCuts: [lo, hi] };
}

function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { if (!Number.isFinite(t) || df < 1) return 1;
  const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return Math.min(1, Math.max(0, s * h)); }
function stats(rows) { if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null };
  const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat, winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length }; }
function verdicts(trades) {
  const by = new Map(MEMBERS.map((n) => [n, { development: [], validation: [], final: [] }])); for (const t of trades) by.get(t.member)[t.window].push(t);
  const out = {}; for (const n of MEMBERS) { const g = by.get(n); out[n] = { development: stats(g.development), validation: stats(g.validation), final: stats(g.final) }; out[n].p = out[n].final.trades ? pUpper(out[n].final.t, out[n].final.months - 1) : 1; }
  const order = MEMBERS.slice().sort((a, b) => out[a].p - out[b].p); let ok = true;
  order.forEach((n, k) => { const o = out[n], a = 0.05 / (order.length - k); const holm = ok && o.p <= a; if (!holm) ok = false; o.holmAlpha = a;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE" : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL"; });
  return out;
}

function synthetic(seed, { plant = false } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const stocks = [], oi = new Map(), fii = new Map(), nifty = new Map();
  for (let k = 0; k < 50; k += 1) { let px = 500, o = 1e6; const bars = [], m = new Map(); let pend = 0;
    sessions.forEach((d) => { const op = px * (1 + 0.003 * gauss()); const c = op * (1 + (plant ? pend : 0) + 0.015 * gauss());
      bars.push({ d, o: op, h: Math.max(op, c) * 1.005, l: Math.min(op, c) * 0.995, c, val: 1e8 * (1 + rnd()) });
      const doi = 0.04 * gauss(); o *= 1 + doi; m.set(d, o);
      pend = (c / px - 1) * doi > 0.0004 ? 0.006 * Math.sign(c / px - 1) : 0;   // planted: big price move with big OI rise continues
      px = c; });
    stocks.push({ sym: `S${k}`, bars }); oi.set(`S${k}`, m); }
  let n = 15000, f = 0, pf = 0; sessions.forEach((d) => { const op = n; n *= 1 + (plant ? 0.004 * Math.sign(pf) : 0) + 0.009 * gauss(); nifty.set(d, { open: op, close: n }); pf = 1000 * gauss(); f += pf; fii.set(d, f); });
  return { sessions, stocks, oi, fii, nifty };
}

const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (st) => (st.trades ? `${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}% t ${st.t.toFixed(2)} win ${st.winPct.toFixed(0)}% (${st.trades})` : "no trades");

if (process.argv.includes("--synthetic")) {
  const pv = verdicts(run(synthetic(3, { plant: true }), { costs: false }).trades);
  line(`(1) planted: B1 ${fmt(pv[MEMBERS[0]].final)}; B3 ${fmt(pv[MEMBERS[2]].final)}; C1 ${fmt(pv[MEMBERS[8]].final)}`);
  const ok1 = pv[MEMBERS[0]].final.t > 2 && pv[MEMBERS[8]].final.t > 2;
  let passes = 0; for (let k = 1; k <= 6; k += 1) passes += Object.values(verdicts(run(synthetic(k * 977)).trades)).filter((x) => x.verdict === "PASS").length;
  line(`(2) 6 noise datasets x 12 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(29); const cut = base.sessions[1100];
  const a = run(base).trades.filter((x) => x.day < base.sessions[1100 - 11]);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.1; b.c *= 0.8; }
  for (const [, m] of base.oi) for (const [d, v] of m) if (d >= cut) m.set(d, v * 3);
  for (const [d, v] of base.fii) if (d >= cut) base.fii.set(d, v - 1e7);
  const b2 = run(base).trades.filter((x) => x.day < base.sessions[1100 - 11]);
  const same = a.length === b2.length && a.every((x, k) => x.member === b2[k].member && x.day === b2[k].day && x.net === b2[k].net);
  line(`(3) changing every value after ${cut}: ${a.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  line("    note: the development cut-offs are computed from development data only, which a change after the cut-off cannot reach.");
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}

// ---------- real data ----------
const cmDir = path.join(ROOT, "research", "rising-stocks-2026-10-02", "nse-data", "cm");
const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10));
const missing = sessions.filter((d) => !fs.existsSync(path.join(HERE, "nse-fo", "fut", `${d}.json`)));
line(`F&O files missing for ${missing.length} of ${sessions.length} sessions${missing.length ? ": " + missing.slice(0, 12).join(", ") : ""}`);
const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10);
  for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , , val] = r;
    if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
    if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
const oi = new Map();
for (const d of sessions) { const p = path.join(HERE, "nse-fo", "fut", `${d}.json`); if (!fs.existsSync(p)) continue;
  for (const r of JSON.parse(fs.readFileSync(p, "utf8"))) { if (r[1] !== "STK") continue; if (!oi.has(r[0])) oi.set(r[0], new Map()); const m = oi.get(r[0]); m.set(d, (m.get(d) || 0) + r[8]); } }
const fii = new Map();
for (const d of sessions) { const p = path.join(HERE, "nse-fo", "part", `${d}.csv`); if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/); const head = lines.find((l) => /^Client Type/i.test(l)); const row = lines.find((l) => /^FII,/i.test(l));
  if (!head || !row) continue; const h = head.split(",").map((x) => x.trim()), v = row.split(",");
  const L = +v[h.indexOf("Future Index Long")], S = +v[h.indexOf("Future Index Short")]; if (Number.isFinite(L) && Number.isFinite(S)) fii.set(d, L - S); }
const nifty = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, "research", "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json"), "utf8")).rows.map((r) => [r.date, { open: r.open, close: r.close }]));
line(`${bySym.size} EQ symbols, ${oi.size} with stock futures, FII rows on ${fii.size} sessions`);
const res = run({ sessions, stocks: [...bySym.values()], oi, fii, nifty });
const v = verdicts(res.trades);
line(`ORDER FLOW -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); cut-offs from development: |R| >= ${(100 * res.rCut).toFixed(2)}%, |OI| >= ${(100 * res.oiCut).toFixed(2)}%, FII dF <= ${res.fiiCuts[0]} or >= ${res.fiiCuts[1]}`);
for (const [n, o] of Object.entries(v)) line(`${n.padEnd(34)} | dev ${fmt(o.development)} | val ${fmt(o.validation)} | final ${fmt(o.final)} | p ${o.p.toExponential(1)} vs ${o.holmAlpha.toFixed(4)} | ${o.verdict}`);
const pass = Object.entries(v).filter(([, o]) => o.verdict === "PASS").map(([n]) => n);
line(`\nPASS: ${pass.length ? pass.join(", ") : "none"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v, cutoffs: { r: res.rCut, oi: res.oiCut, fii: res.fiiCuts } }, null, 2));
