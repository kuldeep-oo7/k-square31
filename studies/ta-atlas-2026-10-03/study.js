"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic   code checks on invented data
//   node study.js               the one real run
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));
const { identifyCandlestickPatterns } = require(path.join(ROOT, "api/_lib/candlestick-engine"));
const { scanChartPatterns } = require(path.join(ROOT, "api/_lib/chart-patterns"));

const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const HOLD = 10, NOTIONAL = 500000, MIN_BARS = 250, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18, DESK_BARS = 66;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
const MEMBERS = ["M1 MA 1-50", "M2 MA 1-150", "M3 MA 5-150", "M4 MA 1-200", "M5 MA 2-200", "M6 TRB 50", "M7 TRB 150", "M8 TRB 200",
  "M9 Turtle 20", "M10 Turtle 55", "M11 TV RSI 14 30/70", "M12 TV MACD hist", "M13 TV Supertrend 10/3", "M14 TV Bollinger 20/2",
  "M15 Connors RSI2", "M16 NR7", "M17 desk candles", "M18 desk chart patterns"];

// ---------- causal indicators (value at k uses bars <= k only) ----------
const sma = (x, n) => { const o = new Array(x.length).fill(null); let s = 0; for (let i = 0; i < x.length; i += 1) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const ema = (x, n) => { const o = new Array(x.length).fill(null); const a = 2 / (n + 1); let e = null; for (let i = 0; i < x.length; i += 1) { if (i === n - 1) { let s = 0; for (let j = 0; j < n; j += 1) s += x[j]; e = s / n; } else if (i >= n) e = a * x[i] + (1 - a) * e; o[i] = e; } return o; };
const rma = (x, n) => { const o = new Array(x.length).fill(null); let r = null; for (let i = 0; i < x.length; i += 1) { if (x[i] === null) continue; if (r === null) { if (i >= n - 1 && x.slice(i - n + 1, i + 1).every((v) => v !== null)) { let s = 0; for (let j = i - n + 1; j <= i; j += 1) s += x[j]; r = s / n; } } else r = (r * (n - 1) + x[i]) / n; o[i] = r; } return o; };
function rsi(c, n) { const up = c.map((v, i) => (i ? Math.max(v - c[i - 1], 0) : null)), dn = c.map((v, i) => (i ? Math.max(c[i - 1] - v, 0) : null));
  const u = rma(up, n), d = rma(dn, n); return c.map((_, i) => (u[i] === null || d[i] === null ? null : d[i] === 0 ? 100 : u[i] === 0 ? 0 : 100 - 100 / (1 + u[i] / d[i]))); }
function stdev(x, n) { const o = new Array(x.length).fill(null); for (let i = n - 1; i < x.length; i += 1) { let m = 0; for (let j = i - n + 1; j <= i; j += 1) m += x[j]; m /= n; let v = 0; for (let j = i - n + 1; j <= i; j += 1) v += (x[j] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; }
function supertrendDir(h, l, c, n, f) { // TradingView convention: -1 up, +1 down
  const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]));
  const atr = rma(tr, n); const dir = new Array(c.length).fill(null);
  let pl = null, pu = null, ps = null, pdir = 1;
  for (let i = 0; i < c.length; i += 1) {
    if (atr[i] === null) continue;
    const hl2 = (h[i] + l[i]) / 2; let lo = hl2 - f * atr[i], up = hl2 + f * atr[i];
    if (pl !== null) { lo = lo > pl || c[i - 1] < pl ? lo : pl; up = up < pu || c[i - 1] > pu ? up : pu; }
    let d; if (ps === null) d = 1; else if (ps === pu) d = c[i] > up ? -1 : 1; else d = c[i] < lo ? 1 : -1;
    const st = d === -1 ? lo : up; dir[i] = d; pl = lo; pu = up; ps = st; pdir = d;
  }
  return dir;
}

// signals for one clean segment of bars: returns array sig[k] = { M1: +1/-1, ... } for the bar k (read at its close)
function signals(seg) {
  const c = seg.map((b) => b.c), h = seg.map((b) => b.h), l = seg.map((b) => b.l), n = seg.length;
  const s50 = sma(c, 50), s150 = sma(c, 150), s200 = sma(c, 200), s5 = sma(c, 5), s2 = sma(c, 2);
  const r14 = rsi(c, 14), r2 = rsi(c, 2);
  const e12 = ema(c, 12), e26 = ema(c, 26); const macd = c.map((_, i) => (e12[i] === null || e26[i] === null ? null : e12[i] - e26[i]));
  const firstMacd = macd.findIndex((v) => v !== null); const sigLine = new Array(n).fill(null);
  if (firstMacd >= 0) { const e9 = ema(macd.slice(firstMacd), 9); for (let i = 0; i < e9.length; i += 1) sigLine[firstMacd + i] = e9[i]; }
  const hist = macd.map((v, i) => (v === null || sigLine[i] === null ? null : v - sigLine[i]));
  const bmid = sma(c, 20), bsd = stdev(c, 20); const lower = bmid.map((m, i) => (m === null ? null : m - 2 * bsd[i])), upper = bmid.map((m, i) => (m === null ? null : m + 2 * bsd[i]));
  const st = supertrendDir(h, l, c, 10, 3);
  const cross = (a, b, i) => (a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null ? (a[i] > b[i] && a[i - 1] <= b[i - 1] ? 1 : a[i] < b[i] && a[i - 1] >= b[i - 1] ? -1 : 0) : 0);
  const maxPrev = (arr, i, k) => { let m = -Infinity; for (let j = i - k; j < i; j += 1) m = Math.max(m, arr[j]); return m; };
  const minPrev = (arr, i, k) => { let m = Infinity; for (let j = i - k; j < i; j += 1) m = Math.min(m, arr[j]); return m; };
  const out = new Array(n).fill(null);
  let prevCandle = null, prevChart = null, prevConn = 0;
  const trbState = { 50: 0, 150: 0, 200: 0 }, turtleState = { 20: 0, 55: 0 };
  for (let i = 1; i < n; i += 1) {
    const s = {};
    s["M1 MA 1-50"] = cross(c, s50, i); s["M2 MA 1-150"] = cross(c, s150, i); s["M3 MA 5-150"] = cross(s5, s150, i);
    s["M4 MA 1-200"] = cross(c, s200, i); s["M5 MA 2-200"] = cross(s2, s200, i);
    for (const [k, name] of [[50, "M6 TRB 50"], [150, "M7 TRB 150"], [200, "M8 TRB 200"]]) {
      const now = i >= k ? (c[i] > maxPrev(c, i, k) ? 1 : c[i] < minPrev(c, i, k) ? -1 : 0) : 0;
      s[name] = now !== 0 && now !== trbState[k] ? now : 0; trbState[k] = now;
    }
    for (const [k, name] of [[20, "M9 Turtle 20"], [55, "M10 Turtle 55"]]) {
      const now = i >= k ? (c[i] > maxPrev(h, i, k) ? 1 : c[i] < minPrev(l, i, k) ? -1 : 0) : 0;
      s[name] = now !== 0 && now !== turtleState[k] ? now : 0; turtleState[k] = now;
    }
    const thirty = r14.map(() => 30), seventy = r14.map(() => 70);
    s["M11 TV RSI 14 30/70"] = r14[i] !== null && r14[i - 1] !== null ? (r14[i] > 30 && r14[i - 1] <= 30 ? 1 : r14[i] < 70 && r14[i - 1] >= 70 ? -1 : 0) : 0;
    s["M12 TV MACD hist"] = hist[i] !== null && hist[i - 1] !== null ? (hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0) : 0;
    s["M13 TV Supertrend 10/3"] = st[i] !== null && st[i - 1] !== null && st[i] !== st[i - 1] ? (st[i] === -1 ? 1 : -1) : 0;
    s["M14 TV Bollinger 20/2"] = lower[i] !== null && lower[i - 1] !== null ? (c[i] < lower[i] && c[i - 1] >= lower[i - 1] ? 1 : c[i] > upper[i] && c[i - 1] <= upper[i - 1] ? -1 : 0) : 0;
    const conn = s200[i] !== null && r2[i] !== null ? (r2[i] < 10 && c[i] > s200[i] ? 1 : r2[i] > 90 && c[i] < s200[i] ? -1 : 0) : 0;
    s["M15 Connors RSI2"] = conn !== 0 && conn !== prevConn ? conn : 0; prevConn = conn;
    let nr = 0;
    if (i >= 6) { const rg = h[i] - l[i]; let narrow = true; for (let j = i - 6; j < i; j += 1) if (h[j] - l[j] <= rg) narrow = false;
      if (narrow && rg > 0) nr = c[i] >= l[i] + rg / 2 ? 1 : -1; }
    s["M16 NR7"] = nr;
    out[i] = s;
    void thirty; void seventy;
    // the desk detectors on the last 66 bars up to i
    if (i >= DESK_BARS - 1) {
      const bars = seg.slice(i - DESK_BARS + 1, i + 1).map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0, timestamp: Date.parse(b.d) / 1000 }));
      const cb = identifyCandlestickPatterns(bars).bias;
      const cd = cb === "BULLISH" ? 1 : cb === "BEARISH" ? -1 : 0;
      s["M17 desk candles"] = cd !== 0 && prevCandle !== null && cd !== prevCandle ? cd : 0; prevCandle = cd;
      const pp = scanChartPatterns(bars).primaryPattern;
      const ch = pp && pp.confirmed === true ? (pp.bias === "BULLISH" ? 1 : pp.bias === "BEARISH" ? -1 : 0) : 0;
      s["M18 desk chart patterns"] = ch !== 0 && prevChart !== null && ch !== prevChart ? ch : 0; prevChart = ch;
    } else { s["M17 desk candles"] = 0; s["M18 desk chart patterns"] = 0; }
  }
  return out;
}

function run(data, { costs = true, desk = true } = {}) {
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  const months = new Map(); for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  // clean segments (between resets)
  const segs = new Map();
  for (const st of data.stocks) {
    const b = st.bars; const cut = [0];
    for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i);
    segs.set(st.id, cut);
  }
  const members = new Map();
  for (const [m, first] of months) {
    const ranked = [];
    for (const st of data.stocks) {
      let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1;
      const lastCut = segs.get(st.id).filter((x) => x < k).pop() ?? 0;
      if (k - lastCut < MIN_BARS) continue;
      const vals = st.bars.slice(Math.max(lastCut, k - VALUE_WINDOW), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b);
      if (vals.length) ranked.push([st.id, vals[Math.floor(vals.length / 2)]]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0])));
  }
  const everIn = new Set([...members.values()].flatMap((s) => [...s]));
  const trades = [];
  for (const st of data.stocks) {
    if (!everIn.has(st.id)) continue;
    const cuts = segs.get(st.id).concat([st.bars.length]);
    for (let s = 0; s < cuts.length - 1; s += 1) {
      const seg = st.bars.slice(cuts[s], cuts[s + 1]);
      if (seg.length < MIN_BARS + HOLD) continue;
      const sig = desk ? signals(seg) : signals(seg);
      for (let i = MIN_BARS; i + HOLD - 1 < seg.length; i += 1) {   // entry bar i, signal read on i-1
        const d = seg[i].d, win = windowOf(d);
        if (!win || !members.get(d.slice(0, 7))?.has(st.id) || !sig[i - 1]) continue;
        if (sIndex.get(seg[i - 1].d) !== sIndex.get(d) - 1) continue;
        const entry = seg[i].o, exit = seg[i + HOLD - 1].c, exitDay = seg[i + HOLD - 1].d;
        const qty = Math.ceil(NOTIONAL / entry);
        let rt = 0;
        if (costs) {
          const rolls = new Set(seg.slice(i, i + HOLD).map((b) => b.d.slice(0, 7))).size - 1;
          rt = (charge("BUY", entry, qty, d) + charge("SELL", exit, qty, exitDay) + rolls * (charge("BUY", exit, qty, exitDay) + charge("SELL", exit, qty, exitDay))) / (entry * qty);
        }
        for (const [name, v] of Object.entries(sig[i - 1])) {
          if (!v) continue;
          const gross = v > 0 ? exit / entry - 1 : 1 - exit / entry;
          trades.push({ member: `${name} ${v > 0 ? "LONG" : "SHORT"}`, sym: st.sym, day: d, window: win, net: gross - rt });
        }
      }
    }
  }
  return { trades };
}

// ---------- statistics ----------
function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { if (!Number.isFinite(t) || df < 1) return 1;
  const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return Math.min(1, Math.max(0, s * h)); }
function stats(rows) {
  if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null };
  const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat, winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length };
}
function verdicts(trades) {
  const names = MEMBERS.flatMap((m) => [`${m} LONG`, `${m} SHORT`]);
  const by = new Map(names.map((n) => [n, { development: [], validation: [], final: [] }]));
  for (const t of trades) by.get(t.member)?.[t.window].push(t);
  const out = {};
  for (const n of names) { const g = by.get(n); out[n] = { development: stats(g.development), validation: stats(g.validation), final: stats(g.final) };
    out[n].p = out[n].final.trades ? pUpper(out[n].final.t, out[n].final.months - 1) : 1; }
  const order = names.slice().sort((a, b) => out[a].p - out[b].p); let ok = true;
  order.forEach((n, k) => { const o = out[n], alpha = 0.05 / (order.length - k); const holm = ok && o.p <= alpha; if (!holm) ok = false; o.holmAlpha = alpha;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE" : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL"; });
  return out;
}

function synthetic(seed, { plant = false } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const stocks = [];
  for (let k = 0; k < 40; k += 1) { let px = 100 + 900 * rnd(); const bars = []; let mom = 0;
    sessions.forEach((d) => { if (plant) mom = 0.98 * mom + 0.001 * gauss(); const o = px * (1 + 0.004 * gauss()); const c = o * (1 + (plant ? mom * 3 : 0) + 0.015 * gauss());
      bars.push({ d, o, h: Math.max(o, c) * (1 + Math.abs(0.008 * gauss())), l: Math.min(o, c) * (1 - Math.abs(0.008 * gauss())), c, val: 1e8 * (1 + rnd()) }); px = c; });
    stocks.push({ id: `S${k}`, sym: `S${k}`, bars }); }
  return { sessions, stocks };
}

const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (st) => (st.trades ? `${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}% t ${st.t.toFixed(2)} win ${st.winPct.toFixed(0)}% (${st.trades})` : "no trades");

if (process.argv.includes("--synthetic")) {
  const pv = verdicts(run(synthetic(5, { plant: true }), { costs: false }).trades);
  const f = pv["M1 MA 1-50 LONG"].final, f2 = pv["M9 Turtle 20 LONG"].final;
  line(`(1) planted trend: MA 1-50 LONG final ${fmt(f)}; Turtle 20 LONG final ${fmt(f2)}`);
  const found = MEMBERS.slice(0, 10).filter((m) => pv[`${m} LONG`].final.meanPct > 0 && pv[`${m} LONG`].final.t > 2);
  line(`    trend rules finding it (long, mean > 0, t > 2): ${found.length} of 10 -- ${found.join(", ")}`);
  const ok1 = found.length > 0;
  let passes = 0; for (let k = 1; k <= 4; k += 1) { const v = verdicts(run(synthetic(k * 131)).trades); passes += Object.values(v).filter((x) => x.verdict === "PASS").length; }
  line(`(2) 4 random walks x 36 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(17); const cut = base.sessions[1100];
  const a = run(base).trades.filter((x) => x.day < base.sessions[1100 - HOLD - 1]);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.1; b.h *= 1.3; b.l *= 0.9; b.c *= 0.8; }
  const b2 = run(base).trades.filter((x) => x.day < base.sessions[1100 - HOLD - 1]);
  const same = a.length === b2.length && a.every((x, k) => x.member === b2[k].member && x.day === b2[k].day && x.net === b2[k].net);
  line(`(3) changing every price after ${cut}: ${a.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}

const cmDir = path.join(ROOT, "research", "rising-stocks-2026-10-02", "nse-data", "cm");
const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10));
const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10);
  for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , v, val] = r;
    if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
    if (!bySym.has(sym)) bySym.set(sym, { id: sym, sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, v, val }); } }
const t0 = Date.now();
const res = run({ sessions, stocks: [...bySym.values()] });
const v = verdicts(res.trades);
line(`TECHNICAL ANALYSIS ATLAS -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); ${res.trades.length} trades, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
line(`member | development | validation | final | p vs Holm | VERDICT`);
for (const [n, o] of Object.entries(v)) line(`${n.padEnd(32)} | ${fmt(o.development)} | ${fmt(o.validation)} | ${fmt(o.final)} | p ${o.p.toExponential(1)} vs ${o.holmAlpha.toFixed(4)} | ${o.verdict}`);
const pass = Object.entries(v).filter(([, o]) => o.verdict === "PASS").map(([n]) => n);
line(`\nPASS: ${pass.length ? pass.join(", ") : "none"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v }, null, 2));
