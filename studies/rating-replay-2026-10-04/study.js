"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt, judged under protocol v2.   node study.js --synthetic | node study.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { analyzeCandidate } = require(path.join(ROOT, "api/_lib/unified-quant-scanner"));
const { toTick } = require(path.join(ROOT, "api/_lib/session-levels"));
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; void."); process.exit(2); }
const RESET = 0.18, WIN = 66, HOLD = 20, NOTIONAL = 500000;
const MEMBERS = ["G1 BUY/ACCUMULATE, desk geometry long (THE LIVE RULE)", "G2 BUY/ACCUMULATE, fixed 20-session long", "G3 SELL/REDUCE, desk geometry short",
  "G4 SELL/REDUCE, fixed 20-session short", "G5 BUY only, fixed 20-session long"];
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const netOf = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
function desk(bars, i, long) {   // the desk's futures geometry; returns { e, x, xi } or null
  const b0 = bars[i];
  if (long) { const e = toTick(b0.o * 0.992, 0.05, "down"); if (!(b0.l < e)) return null; const T = toTick(e * 1.025, 0.05, "nearest"), S = toTick(e * 0.985, 0.05, "nearest");
    if (b0.l <= S) return { e, x: S, xi: i };
    for (let k = 1; k < HOLD; k += 1) { const j = i + k; if (j >= bars.length) return null; const b = bars[j];
      if (b.o <= S || b.o >= T) return { e, x: b.o, xi: j }; if (b.l <= S) return { e, x: S, xi: j }; if (b.h >= T) return { e, x: T, xi: j }; if (k === HOLD - 1) return { e, x: b.c, xi: j }; } }
  else { const e = toTick(b0.o * 1.008, 0.05, "up"); if (!(b0.h > e)) return null; const T = toTick(e * 0.975, 0.05, "nearest"), S = toTick(e * 1.015, 0.05, "nearest");
    if (b0.h >= S) return { e, x: S, xi: i };
    for (let k = 1; k < HOLD; k += 1) { const j = i + k; if (j >= bars.length) return null; const b = bars[j];
      if (b.o >= S || b.o <= T) return { e, x: b.o, xi: j }; if (b.h >= S) return { e, x: S, xi: j }; if (b.l <= T) return { e, x: T, xi: j }; if (k === HOLD - 1) return { e, x: b.c, xi: j }; } }
  return null;
}
const friday = (d) => { const x = new Date(`${d}T00:00:00Z`); const add = (5 - x.getUTCDay() + 7) % 7; return new Date(x.getTime() + add * 864e5).toISOString().slice(0, 10); };

// data: { sessions, stocks:[{sym,bars:[{d,o,h,l,c,v,val}]}], results: Map(sym -> sorted dates) }; oracle: optional (sym, d) -> "BUY"|"SELL"|null (synthetic check only)
function run(data, { oracle = null } = {}) {
  const S = data.sessions, sIndex = new Map(S.map((d, i) => [d, i]));
  const bySym = new Map(data.stocks.map((s) => [s.sym, s])); const idx = new Map(data.stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const isReset = (b, k) => k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET;
  const cutsOf = new Map(data.stocks.map((st) => { const cut = [0]; for (let i = 1; i < st.bars.length; i += 1) if (isReset(st.bars, i)) cut.push(i); return [st.sym, cut]; }));
  const firstOf = new Map(); for (const d of S) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
  const uni = new Map(); for (const [m, first] of firstOf) { const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < 250) continue;
      const v = st.bars.slice(Math.max(lc, k - 60), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); uni.set(m, ranked.slice(0, 200).map((x) => x[0])); }
  const window = (sym, d, h) => { const st = bySym.get(sym), i = idx.get(sym)?.get(d); if (!st || i === undefined || i + h - 1 >= st.bars.length) return null;
    for (let k = i; k <= i + h - 1; k += 1) { if (sIndex.get(st.bars[k].d) !== sIndex.get(d) + (k - i)) return null; if (k > i && isReset(st.bars, k)) return null; } return { st, i }; };
  const bCache = new Map(); const B = (d) => { if (bCache.has(d)) return bCache.get(d); const xs = [];
    for (const sym of uni.get(d.slice(0, 7)) || []) { const w = window(sym, d, HOLD); if (w) xs.push(w.st.bars[w.i + HOLD - 1].c / w.st.bars[w.i].o - 1); }
    const v = xs.length >= 30 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; bCache.set(d, v); return v; };
  const out = new Map(MEMBERS.map((m) => [m, []])); const add = (k, d, v) => { if (Number.isFinite(v)) out.get(MEMBERS[k]).push({ day: d, v }); };
  const counts = { rated: 0, BUY: 0, ACCUMULATE: 0, SELL: 0, REDUCE: 0, veto: 0 };
  const ratings = [];   // for the look-ahead check
  for (let i = 1; i < S.length; i += 1) { const d = S[i]; const list = uni.get(d.slice(0, 7)); if (!list) continue; const day = [];
    for (const sym of list) { const st = bySym.get(sym), j = idx.get(sym).get(d); if (j === undefined || j < WIN + 1) continue;
      if (sIndex.get(st.bars[j - 1].d) !== i - 1) continue;
      let clean = true; for (let k = j - WIN + 1; k < j; k += 1) if (isReset(st.bars, k)) clean = false; if (!clean) continue;
      const hb = st.bars.slice(j - WIN, j).map((b) => ({ timestamp: Date.parse(`${b.d}T03:45:00Z`) / 1000, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }));
      const spot = hb[hb.length - 1].close;
      let rawZ, rawComp;
      if (oracle) { rawZ = 0; rawComp = 0; } else { const a = analyzeCandidate({ symbol: sym, tradingSymbol: sym, currentLtp: spot, entryPrice: spot, lotSize: 1, historicalBars: hb }); rawZ = Number(a.rawZ) || 0; rawComp = a.rawCompScore !== undefined ? a.rawCompScore : a.compositeScore; }
      const adv = st.bars.slice(j - 20, j).reduce((s, b) => s + (b.val || 0), 0) / 20;
      day.push({ sym, j, rawZ, rawComp, adv }); }
    if (!day.length) continue; counts.rated += day.length; const n = day.length;
    day.slice().sort((a, b) => a.rawZ - b.rawZ).forEach((x, k) => { x.neural = Math.max(5, Math.min(98, Math.round(((k + 0.5) / n) * 100))); });
    day.slice().sort((a, b) => a.rawComp - b.rawComp).forEach((x, k) => { x.comp = Math.max(5, Math.min(99, Math.round(((k + 0.5) / n) * 100))); });
    const fri = friday(d);
    for (const x of day) {
      let act = oracle ? oracle(x.sym, d) : (x.comp >= 90 && x.neural >= 75 ? "BUY" : x.comp >= 75 && x.neural >= 60 ? "ACCUMULATE" : x.comp <= 10 && x.neural <= 25 ? "SELL" : x.comp <= 25 && x.neural <= 40 ? "REDUCE" : null);
      if (act && (data.results.get(x.sym) || []).some((r) => r >= d && r <= fri)) { counts.veto += 1; act = null; }
      if (act && x.adv < 50_000_000) act = null;
      ratings.push(`${x.sym}|${d}|${x.comp}|${x.neural}|${act}`);
      if (!act) continue; counts[act] = (counts[act] || 0) + 1;
      const st = bySym.get(x.sym), bars = st.bars; const long = act === "BUY" || act === "ACCUMULATE";
      const g = desk(bars, x.j, long);
      if (g && !bars.slice(x.j, g.xi + 1).some((b, k) => isReset(bars, x.j + k))) add(long ? 0 : 2, d, netOf(long ? 1 : -1, g.e, g.x, d, bars[g.xi].d));
      const w = window(x.sym, d, HOLD), b20 = B(d);
      if (w && b20 !== null) { const e = bars[x.j].o, xx = bars[x.j + HOLD - 1].c, xd = bars[x.j + HOLD - 1].d;
        if (long) { const net = netOf(1, e, xx, d, xd); add(1, d, net - b20); if (act === "BUY") add(4, d, net - b20); } else add(3, d, netOf(-1, e, xx, d, xd) + b20); } }
  }
  return { out, counts, ratings };
}

const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const dd = 0.3989423 * Math.exp(-x * x / 2); const p = dd * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function score(out) { const rows = [];
  for (const [m, obs] of out) { const month = new Map(); for (const o of obs) { const k = o.day.slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(o.v); }
    const s = [...month.keys()].sort().map((k) => (month.get(k).reduce((a, b) => a + b, 0) / month.get(k).length) * 100);
    if (s.length < 24) { rows.push({ m, months: s.length, n: obs.length, verdict: "NOT TESTABLE" }); continue; }
    const n = s.length, mu = s.reduce((a, b) => a + b, 0) / n, e = s.map((v) => v - mu); let v = e.reduce((a, x) => a + x * x, 0) / n; for (let L = 1; L <= 3; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; v += 2 * (1 - L / 4) * (g / n); }
    const t = mu / Math.sqrt(v / n), sd = Math.sqrt(e.reduce((a, x) => a + x * x, 0) / (n - 1));
    rows.push({ m, months: n, n: obs.length, mean: mu, t, sharpe: (mu / sd) * Math.sqrt(12), win: (100 * obs.filter((o) => o.v > 0).length) / obs.length, p: 1 - Phi(t), verdict: mu > 0 && t >= 3 ? "PASS" : mu > 0 && t >= 2 ? "PROMISING" : "FAIL" }); }
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (tested.length - i); if (!r.holm) ok = false; });
  return rows; }
const fmt = (r) => (r.verdict === "NOT TESTABLE" ? `NOT TESTABLE (${r.months} months)` : `${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(3)}% a trade, t ${r.t.toFixed(2)}, Sharpe ${r.sharpe.toFixed(2)}, ${r.win.toFixed(1)}% winners (${r.n} trades, ${r.months} months) Holm ${r.holm ? "yes" : "no"} -> ${r.verdict}`);
const lines = []; const line = (x) => { console.log(x); lines.push(x); };

function synthetic(seed) { let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 900; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const stocks = []; for (let k = 0; k < 40; k += 1) { let px = 300 + 10 * k; const bars = []; sessions.forEach((d) => { const o = px * (1 + 0.003 * gauss()); const c = o * (1 + 0.016 * gauss());
    bars.push({ d, o, h: Math.max(o, c) * (1 + Math.abs(0.006 * gauss())), l: Math.min(o, c) * (1 - Math.abs(0.006 * gauss())), c, v: 1e5 * (1 + rnd()), val: 1e9 * (1 + rnd()) }); px = c; }); stocks.push({ sym: `S${k}`, bars }); }
  return { sessions, stocks, results: new Map() }; }

if (process.argv.includes("--synthetic")) {
  // (1) the trade and scoring machinery finds a planted edge: an ORACLE marks BUY where the next 20 sessions rise.
  //     (A planted edge "in a stock the rating favours" cannot be built without circularity -- the rating reads the
  //     same bars -- so the oracle checks the machinery and (3) checks the rating itself for look-ahead. Stated.)
  const syn = synthetic(7); const bi = new Map(syn.stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const oracle = (sym, d) => { const st = syn.stocks.find((x) => x.sym === sym), i = bi.get(sym).get(d); if (i + 19 >= st.bars.length) return null; const r = st.bars[i + 19].c / st.bars[i].o - 1; return r > 0.04 ? "BUY" : r < -0.04 ? "SELL" : null; };
  const a = score(run(syn, { oracle }).out); line(`(1) oracle-planted edge: G2 ${fmt(a.find((r) => r.m.startsWith("G2")))}`); const ok1 = a.find((r) => r.m.startsWith("G2")).t >= 3;
  let passes = 0; for (let k = 1; k <= 2; k += 1) for (const r of score(run(synthetic(k * 101)).out)) if (r.verdict === "PASS") { passes += 1; line(`    noise PASS: ${r.m} ${fmt(r)}`); }
  line(`(2) 2 random-walk markets x 5 members, the REAL rating: ${passes} PASS (want <= 1)`);
  const base = synthetic(11); const cut = base.sessions[700]; const A = run(base).ratings.filter((x) => x.split("|")[1] < cut);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.2; b.c *= 0.7; b.h *= 1.3; b.l *= 0.6; b.v *= 9; }
  const Bv = run(base).ratings.filter((x) => x.split("|")[1] < cut); const same = A.length === Bv.length && A.every((x, i) => x === Bv[i]);
  line(`(3) changing every price after ${cut}: ${A.length} earlier ratings ${same ? "IDENTICAL (no look-ahead)" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}
const R = path.join(ROOT, "research"); const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"); const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , v, val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, v, val }); } }
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" }; const results = new Map();
const bmDir = path.join(R, "results-vrp-2026-10-04", "nse-board-meetings");
for (const f of fs.readdirSync(bmDir)) for (const [sym, date, purpose] of JSON.parse(fs.readFileSync(path.join(bmDir, f), "utf8"))) { if (!/result/i.test(purpose || "")) continue; const [dd, mm, yy] = String(date).split("-"); if (!MON[(mm || "").toUpperCase()]) continue;
  if (!results.has(sym)) results.set(sym, []); results.get(sym).push(`${yy}-${MON[mm.toUpperCase()]}-${dd.padStart(2, "0")}`); }
const t0 = Date.now(); const res = run({ sessions, stocks: [...bySym.values()], results });
line(`THE DESK'S OWN RATING, REPLAYED -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified), protocol v2; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
line(`stock-days rated ${res.counts.rated}; BUY ${res.counts.BUY}, ACCUMULATE ${res.counts.ACCUMULATE}, SELL ${res.counts.SELL}, REDUCE ${res.counts.REDUCE}; results vetoes ${res.counts.veto}`);
for (const r of score(res.out)) line(`${r.m.padEnd(52)} | ${fmt(r)}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n");
