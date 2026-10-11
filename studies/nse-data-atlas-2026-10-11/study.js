"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the NSE data atlas, 14 members.
//   node study.js --synthetic | node study.js --coverage | node study.js   (ONE real run)
// Data: K2_CM_DIR (NSE CM bhavcopy json, nse-data/cm) and K2_ATLAS_DIR (research/nse-atlas, scripts/nse-atlas-download.js
// + scripts/nse-pit-download.js). cat_turnover .xls needs the "xlsx" package (npm i --no-save xlsx@0.18.5) or K2_XLSX.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { context } = require(path.join(ROOT, "api/_lib/forward-v3"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
// hashed with line endings normalised to LF, so a Windows checkout (CRLF) does not void the run
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const NIFTY_M = { N1: "N1 FII index futures flow", N2: "N2 Pro index futures flow", N3: "N3 Client index futures flow (contrarian)", N4: "N4 FII index options flow",
  N5: "N5 FPI cash flow", N6: "N6 Mutual-fund cash flow", N7: "N7 Retail cash flow (contrarian)", N8: "N8 NIFTY P/E extremes (20d)" };
const STOCK_M = { S1: "S1 heavy short selling -> short 5d", S2: "S2 borrowing surge -> short 5d", S3: "S3 crossing 80% of MWPL -> short 5d",
  S4: "S4 promoter market purchase -> long 10d", S5: "S5 promoter pledge created -> short 10d", S6: "S6 director/KMP market sale -> short 10d" };
const MEMBERS = [...Object.values(NIFTY_M), ...Object.values(STOCK_M)];
const NOTIONAL = 500000;
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

// data: { sessions, stocks:[{sym,bars:[{d,o,h,l,c,val,qty}]}], nifty: Map(d->{o,c,pe}), part: Map(d->{FII:{fil,fis,cl,cs,pl,ps},PRO,CLIENT}),
//         cat: Map(d->{FPI:{buy,sell},MF,RETAIL}), short: Map(tradeDate->Map(sym->qty)), slb: Map(d->Map(sym->qty)), mwpl: Map(d->Map(sym->u)),
//         pit: [{sym, d, cat, mode, type, value}] }
function run(data) {
  const S = data.sessions, sIdx = new Map(S.map((d, i) => [d, i]));
  const ctx = context({ sessions: S, stocks: data.stocks });
  const trades = [];
  // ---- NIFTY
  const nd = S.filter((d) => data.nifty.has(d)); const nI = new Map(nd.map((d, i) => [d, i]));
  const niftyTrade = (k, d, side, h, busy) => { const i = nI.get(d); if (i === undefined) return; const e = nd[i + 2], x = nd[i + 2 + h - 1]; if (!e || !x) return;
    if (busy[k] && busy[k] >= e) return; busy[k] = x;
    const a = data.nifty.get(e), b = data.nifty.get(x); if (!(a.o > 0) || !(b.c > 0)) return; trades.push({ member: NIFTY_M[k], day: e, net: futNet(side, a.o, b.c, e, x), exit: x }); };
  const zSeries = (k, days, f, side, h = 5) => { const hist = []; const busy = {};
    for (const d of days) { const x = f(d); if (!Number.isFinite(x)) continue;
      const past = hist.slice(-250); if (past.length >= 120) { const s = sd(past); if (s > 0) { const z = (x - mean(past)) / s; if (z >= 1) niftyTrade(k, d, side, h, busy); else if (z <= -1) niftyTrade(k, d, -side, h, busy); } }
      hist.push(x); } };
  const pd = [...data.part.keys()].filter((d) => nI.has(d)).sort();
  zSeries("N1", pd, (d) => { const r = data.part.get(d).FII; return r ? r.fil - r.fis : NaN; }, 1);
  zSeries("N2", pd, (d) => { const r = data.part.get(d).PRO; return r ? r.fil - r.fis : NaN; }, 1);
  zSeries("N3", pd, (d) => { const r = data.part.get(d).CLIENT; return r ? r.fil - r.fis : NaN; }, -1);
  zSeries("N4", pd, (d) => { const r = data.part.get(d).FII; return r ? (r.cl - r.cs) - (r.pl - r.ps) : NaN; }, 1);
  const cd = [...data.cat.keys()].filter((d) => nI.has(d)).sort();
  zSeries("N5", cd, (d) => { const r = data.cat.get(d).FPI; return r ? r.buy - r.sell : NaN; }, 1);
  zSeries("N6", cd, (d) => { const r = data.cat.get(d).MF; return r ? r.buy - r.sell : NaN; }, 1);
  zSeries("N7", cd, (d) => { const r = data.cat.get(d).RETAIL; return r ? r.buy - r.sell : NaN; }, -1);
  { const hist = []; const busy = {}; for (const d of nd) { const pe = data.nifty.get(d).pe; if (!(pe > 0)) continue; const past = hist.slice(-750);
      if (past.length >= 500) { const pct = past.filter((v) => v < pe).length / past.length; if (pct >= 0.9) niftyTrade("N8", d, -1, 20, busy); else if (pct <= 0.1) niftyTrade("N8", d, 1, 20, busy); }
      hist.push(pe); } }
  // ---- STOCKS (excess over B)
  const bCache = new Map();
  const B = (e, h) => { const key = `${e}|${h}`; if (bCache.has(key)) return bCache.get(key); const xs = [];
    for (const sym of ctx.uni(e.slice(0, 7))) { const w = ctx.window(sym, e, h); if (!w || !w.complete) continue; const b = w.st.bars; xs.push(b[w.i + h - 1].c / b[w.i].o - 1); }
    const v = xs.length >= 20 ? mean(xs) : null; bCache.set(key, v); return v; };
  const busyS = {};
  const stockTrade = (k, sym, d, side, h, entryOffset = 2) => { const i = sIdx.get(d); if (i === undefined) return; const e = S[i + entryOffset]; if (!e) return;
    if (!ctx.uni(e.slice(0, 7)).has(sym)) return; const key = `${k}|${sym}`; if (busyS[key] && busyS[key] >= e) return;
    const w = ctx.window(sym, e, h); if (!w || !w.complete) return; const b = w.st.bars, x = b[w.i + h - 1]; busyS[key] = x.d;
    const b0 = B(e, h); if (b0 === null) return; trades.push({ member: STOCK_M[k], day: e, net: futNet(side, b[w.i].o, x.c, e, x.d) - side * b0, exit: x.d, sym }); };
  const qtyOn = new Map(data.stocks.map((st) => [st.sym, new Map(st.bars.map((b) => [b.d, b.qty]))]));
  for (const d of [...data.short.keys()].sort()) { if (!sIdx.has(d)) continue; const uni = ctx.uni(d.slice(0, 7)); const xs = [];
    for (const [sym, q] of data.short.get(d)) { if (!uni.has(sym)) continue; const v = qtyOn.get(sym)?.get(d); if (q > 0 && v > 0) xs.push([sym, q / v]); }
    xs.sort((a, b) => b[1] - a[1]); for (const [sym] of xs.slice(0, Math.floor(xs.length * 0.1))) stockTrade("S1", sym, d, -1, 5); }
  { const hist = new Map(); for (const d of [...data.slb.keys()].sort()) { const m = data.slb.get(d);
      for (const [sym, q] of m) { const h = hist.get(sym) || []; const past = h.slice(-20); if (past.length >= 10 && sIdx.has(d)) { const avg = mean(past); if (avg > 0 && q / avg >= 2 && q >= 100000) stockTrade("S2", sym, d, -1, 5); } h.push(q); hist.set(sym, h); } } }
  { let prev = null; for (const d of [...data.mwpl.keys()].sort()) { const m = data.mwpl.get(d);
      if (prev && sIdx.has(d)) for (const [sym, u] of m) { const p = prev.get(sym); if (u >= 0.8 && p !== undefined && p < 0.8) stockTrade("S3", sym, d, -1, 5); } prev = m; } }
  const pitDay = (d) => { let i = S.findIndex((x) => x > d); return i < 0 ? null : S[i]; };   // first session strictly after the broadcast date
  const seen = new Set();
  for (const r of data.pit.slice().sort((a, b) => (a.d < b.d ? -1 : 1))) {
    let k = null, side = 0, h = 10;
    if (/promoter/i.test(r.cat) && /^market purchase$/i.test(r.mode) && /buy/i.test(r.type) && r.value >= 1e7) { k = "S4"; side = 1; }
    else if (/promoter/i.test(r.cat) && /^pledge creation$/i.test(r.mode)) { k = "S5"; side = -1; }
    else if ((/^director$/i.test(r.cat) || /key managerial/i.test(r.cat)) && /^market sale$/i.test(r.mode) && r.value >= 1e7) { k = "S6"; side = -1; }
    if (!k) continue; const key = `${k}|${r.sym}|${r.d}`; if (seen.has(key)) continue; seen.add(key);
    const e = pitDay(r.d); if (!e) continue; stockTrade(k, r.sym, e, side, h, 0); }
  return { trades };
}

// ---- PROTOCOL v2 scoring (as studies/gex-2026-10-04/study.js)
function nwT(x, lag = 3) { const n = x.length, m = x.reduce((a, b) => a + b, 0) / n; const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function monthly(ts) { const month = new Map(); for (const t of ts) { const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(t.net); }
  return [...month.keys()].sort().map((m) => mean(month.get(m)) * 100); }
function score(trades) {
  const rows = MEMBERS.map((k) => { const ts = trades.filter((t) => t.member === k); const s = monthly(ts);
    if (s.length < 24) return { k, months: s.length, trades: ts.length, verdict: "NOT TESTABLE" };
    const r = nwT(s); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
    return { k, months: s.length, trades: ts.length, meanPct: r.mean, t: r.t, sharpe, p: 1 - Phi(r.t), win: (100 * ts.filter((t) => t.net > 0).length) / ts.length,
      verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const srs = tested.map((r) => r.sharpe); const vSR = N > 1 ? sd(srs) ** 2 : 0; const g = 0.5772156649;
    const inv = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const mid = (lo + hi) / 2; if (Phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
    const SR0 = N > 1 ? Math.sqrt(vSR) * ((1 - g) * inv(1 - 1 / N) + g * inv(1 - 1 / (N * Math.E))) : 0;
    for (const r of tested) r.dsr = Phi((r.sharpe - SR0) * Math.sqrt(r.months / 12)); rows.SR0 = SR0; }
  return rows;
}
const fmt = (r) => `${r.k} | ${r.months} | ${r.trades} | ${r.meanPct === undefined ? "-" : (r.meanPct >= 0 ? "+" : "") + r.meanPct.toFixed(3) + "%"} | ${r.win === undefined ? "-" : r.win.toFixed(1) + "%"} | ${r.t === undefined ? "-" : r.t.toFixed(2)} | ${r.sharpe === undefined ? "-" : r.sharpe.toFixed(2)} | ${r.holm === undefined ? "-" : r.holm ? "yes" : "no"} | ${r.dsr === undefined ? "-" : r.dsr.toFixed(2)} | ${r.verdict}`;

// ---- synthetic market (checks only)
function synth(seed, plant) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const n = sessions.length, NS = 60;
  const fii = sessions.map(() => gauss()); const shortHeavy = Array.from({ length: n }, () => new Set(Array.from({ length: NS }, (_, k) => k).filter(() => rnd() < 0.1)));
  const nifty = new Map(); let lvl = 15000;
  for (let i = 0; i < n; i += 1) { const up = plant === "N1" && [2, 3, 4, 5, 6].some((g) => i - g >= 0 && fii[i - g] >= 1.3), dn = plant === "N1" && [2, 3, 4, 5, 6].some((g) => i - g >= 0 && fii[i - g] <= -1.3); const o = lvl * (1 + 0.002 * gauss()); const c = o * (1 + (up ? 0.004 : 0) - (dn ? 0.004 : 0) + 0.008 * gauss()); nifty.set(sessions[i], { o, c, pe: 20 + 3 * Math.sin(i / 90) + gauss() * 0.2 }); lvl = c; }
  const stocks = []; for (let k = 0; k < NS; k += 1) { let p = 500 + k; const bars = [];
    for (let i = 0; i < n; i += 1) { const hit = plant === "S1" && [2, 3, 4, 5, 6].some((g) => i - g >= 0 && shortHeavy[i - g].has(k)); const o = p * (1 + 0.003 * gauss()); const c = o * (1 + (hit ? -0.004 : 0) + 0.015 * gauss());
      bars.push({ d: sessions[i], o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 * (1 + k / 100), qty: 1e6 }); p = c; }
    stocks.push({ sym: `S${k}`, bars }); }
  const part = new Map(sessions.map((d, i) => [d, { FII: { fil: 50000 + 10000 * fii[i], fis: 50000, cl: 1e6 * (1 + 0.1 * gauss()), cs: 1e6, pl: 1e6, ps: 1e6 }, PRO: { fil: 5e4 + 5e3 * gauss(), fis: 5e4, cl: 1, cs: 1, pl: 1, ps: 1 }, CLIENT: { fil: 5e4 + 5e3 * gauss(), fis: 5e4, cl: 1, cs: 1, pl: 1, ps: 1 } }]));
  const cat = new Map(sessions.slice(600).map((d) => [d, { FPI: { buy: 1e4 + 1e3 * gauss(), sell: 1e4 }, MF: { buy: 8e3 + 800 * gauss(), sell: 8e3 }, RETAIL: { buy: 5e4 + 4e3 * gauss(), sell: 5e4 } }]));
  const short = new Map(sessions.map((d, i) => [d, new Map(Array.from({ length: NS }, (_, k) => [`S${k}`, shortHeavy[i].has(k) ? 300000 : 1000 + Math.round(1000 * rnd())]))]));
  const slb = new Map(sessions.map((d) => [d, new Map(Array.from({ length: NS }, (_, k) => [`S${k}`, 2e5 * (1 + 0.3 * rnd())]))]));
  const mwpl = new Map(sessions.map((d) => [d, new Map(Array.from({ length: NS }, (_, k) => [`S${k}`, 0.5 + 0.35 * rnd()]))]));
  const pit = []; for (let i = 300; i < n; i += 7) pit.push({ sym: `S${i % NS}`, d: sessions[i], cat: "Promoters", mode: rnd() < 0.5 ? "Market Purchase" : "Pledge Creation", type: "Buy", value: 2e7 });
  return { sessions, stocks, nifty, part, cat, short, slb, mwpl, pit };
}

if (process.argv.includes("--synthetic")) {
  let ok = true; const say = (name, pass, detail) => { console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}  (${detail})`); if (!pass) ok = false; };
  const v = (rows) => rows.map((r) => `${r.k.split(" ")[0]} ${r.verdict}${r.t !== undefined ? ` ${r.t.toFixed(1)}` : ""}`).join(", ");
  const a = score(run(synth(11, "N1")).trades); say("1. planted N1 edge is found", a[0].verdict === "PASS", v(a));
  const b = score(run(synth(12, "S1")).trades); say("2. planted S1 edge is found, in excess of the market", b[8].verdict === "PASS", v(b));
  let worst = 0; for (const seed of [21, 22, 23]) { const r = score(run(synth(seed, null)).trades); worst = Math.max(worst, r.filter((x) => x.verdict === "PASS").length); console.log(`      noise ${seed}: ${v(r)}`); }
  say("3. noise: at most one chance PASS", worst <= 1, `most PASSes: ${worst}`);
  const base = synth(31, null), cutI = 1000, cut = base.sessions[cutI], pert = synth(31, null);
  for (const d of pert.sessions.slice(cutI)) { pert.nifty.set(d, { o: 1, c: 2, pe: 99 }); pert.part.set(d, { FII: { fil: 9e9, fis: 0, cl: 0, cs: 9e9, pl: 0, ps: 0 } }); pert.short.set(d, new Map([["S1", 9e9]])); }
  for (const st of pert.stocks) for (const bar of st.bars) if (bar.d >= cut) { bar.o *= 1.5; bar.c *= 0.5; }
  const early = (r) => r.trades.filter((t) => pert.sessions.indexOf(t.day) <= cutI - 25).map((t) => `${t.member}|${t.day}|${t.sym || ""}|${t.net.toFixed(10)}`).sort().join("\n");
  const x = early(run(base)), y = early(run(pert)); say("4. no look-ahead: trades entered 25+ sessions before the cut are identical", x === y && x.length > 0, `${x.split("\n").length} trades, cut ${cut}`);
  console.log(ok ? "\nSYNTHETIC CHECKS: ALL PASS" : "\nSYNTHETIC CHECKS FAILED"); process.exit(ok ? 0 : 1);
}

// ---- loaders for the real run
function unzipFirst(buf) { let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16); const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const data = buf.subarray(start, start + size); return method === 0 ? data : zlib.inflateRawSync(data); }
const csvRows = (t) => String(t).split(/\r?\n/).filter(Boolean).map((l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, "\"").trim()));
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const isoOf = (s) => { let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(s); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
  m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
function loadReal() {
  const CM = path.resolve(process.env.K2_CM_DIR || path.join(ROOT, "research", "rising-stocks-2026-10-02", "nse-data", "cm"));
  const AT = path.resolve(process.env.K2_ATLAS_DIR || path.join(ROOT, "research", "nse-atlas"));
  const files = fs.readdirSync(CM).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(CM, f), "utf8"))) { const [, sym, series, o, h, l, c, , qty, val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val, qty }); } }
  const each = (name, ext, fn) => { const dir = path.join(AT, name); if (!fs.existsSync(dir)) return 0; let n = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(`.${ext}`))) { try { fn(f.slice(0, 10), fs.readFileSync(path.join(dir, f))); n += 1; } catch (e) { /* unreadable file: skipped, counted below */ } } return n; };
  const nifty = new Map(); each("ind_close_all", "csv", (d, b) => { const rows = csvRows(b.toString("utf8")); const h = rows[0]; const r = rows.find((x) => x[0] === "Nifty 50"); if (!r) return;
    const c = (n) => +r[h.indexOf(n)]; nifty.set(d, { o: c("Open Index Value"), c: c("Closing Index Value"), pe: c("P/E") }); });
  const part = new Map(); each("part_vol", "csv", (d, b) => { const rows = csvRows(b.toString("utf8")); const hi = rows.findIndex((x) => x[0] === "Client Type"); if (hi < 0) return; const h = rows[hi]; const c = (r, n) => +r[h.findIndex((x) => x.replace(/\s+/g, " ").trim() === n)];
    const o = {}; for (const r of rows.slice(hi + 1)) { const k = r[0].toUpperCase(); if (!["FII", "PRO", "CLIENT", "DII"].includes(k)) continue;
      o[k] = { fil: c(r, "Future Index Long"), fis: c(r, "Future Index Short"), cl: c(r, "Option Index Call Long"), cs: c(r, "Option Index Call Short"), pl: c(r, "Option Index Put Long"), ps: c(r, "Option Index Put Short") }; }
    part.set(d, o); });
  let X = null; try { X = require(process.env.K2_XLSX || "xlsx"); } catch { X = null; }
  const cat = new Map(); if (X) each("cm_cat_turnover", "xls", (d, b) => { const wb = X.read(b, { type: "buffer" }); const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const o = {}; for (const r of rows) { const name = String(r[1] || "").trim().toUpperCase(); const buy = +r[2], sell = +r[3]; if (!Number.isFinite(buy) || !Number.isFinite(sell)) continue;
      if (name === "FPI") o.FPI = { buy, sell }; else if (name === "MUTUAL FUNDS") o.MF = { buy, sell }; else if (name === "RETAIL") o.RETAIL = { buy, sell }; }
    if (Object.keys(o).length) cat.set(d, o); });
  const short = new Map(); each("shortselling", "csv", (_, b) => { const rows = csvRows(b.toString("utf8")).slice(1); for (const r of rows) { const td = isoOf(r[2]); if (!td) continue; if (!short.has(td)) short.set(td, new Map()); const m = short.get(td); m.set(r[1], (m.get(r[1]) || 0) + (+r[3] || 0)); } });
  const slb = new Map(); each("slb_openpos", "csv", (d, b) => { const m = new Map(); for (const r of csvRows(b.toString("utf8")).slice(1)) if (r[1]) m.set(r[1], (m.get(r[1]) || 0) + (+r[3] || 0)); slb.set(d, m); });
  const mwpl = new Map(); each("combineoi", "zip", (d, b) => { const rows = csvRows(unzipFirst(b).toString("utf8")); const h = rows[0].map((x) => x.trim()); const iS = h.indexOf("NSE Symbol"), iM = h.indexOf("MWPL"), iF = h.indexOf("Future Equivalent Open Interest");
    const m = new Map(); for (const r of rows.slice(1)) { const M = +r[iM], F = +r[iF]; if (r[iS] && M > 0 && F >= 0) m.set(r[iS], F / M); } mwpl.set(d, m); });
  const pit = []; const pdir = path.join(AT, "pit"); if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir).filter((x) => x.endsWith(".json"))) for (const r of JSON.parse(fs.readFileSync(path.join(pdir, f), "utf8"))) {
    const d = isoOf(String(r.date || "")); if (!d || !r.symbol) continue; pit.push({ sym: r.symbol, d, cat: String(r.personCategory || ""), mode: String(r.acqMode || ""), type: String(r.tdpTransactionType || ""), value: +r.secVal || 0 }); }
  return { sessions, stocks: [...bySym.values()], nifty, part, cat, short, slb, mwpl, pit, xlsx: !!X };
}

const data = loadReal();
if (process.argv.includes("--coverage")) {   // inputs only: counts by year, computes no member
  const yr = (m) => { const c = {}; for (const d of m) c[d.slice(0, 4)] = (c[d.slice(0, 4)] || 0) + 1; return JSON.stringify(c); };
  console.log(`CM sessions ${data.sessions.length} (${data.sessions[0]} .. ${data.sessions.at(-1)}); xlsx reader: ${data.xlsx}`);
  console.log(`NIFTY+P/E ${yr(data.nifty.keys())}\nparticipant volume ${yr(data.part.keys())}\ncash categories (with FPI) ${yr([...data.cat].filter(([, v]) => v.FPI).map(([d]) => d))}`);
  console.log(`short selling ${yr(data.short.keys())}\nSLB ${yr(data.slb.keys())}\nMWPL ${yr(data.mwpl.keys())}\ninsider filings ${data.pit.length} ${yr(data.pit.map((r) => r.d))}`);
  process.exit(0);
}
const res = run(data); const rows = score(res.trades);
const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`NSE DATA ATLAS -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); protocol v2`);
line(`Prices: ${data.sessions.length} CM sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}. DSR benchmark: ${rows.SR0 === undefined ? "-" : rows.SR0.toFixed(2)}`);
line("member | months | trades | mean/trade | winners | t (NW) | annual Sharpe | Holm | DSR | VERDICT");
for (const r of rows) line(fmt(r));
line(`\nPASS (t >= 3): ${rows.filter((r) => r.verdict === "PASS").map((r) => r.k).join("; ") || "none"}. PROMISING: ${rows.filter((r) => r.verdict === "PROMISING").map((r) => r.k).join("; ") || "none"}.`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify(rows, null, 1));
