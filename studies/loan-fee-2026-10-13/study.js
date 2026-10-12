"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the loan-fee test, F1-F3 (+ S2 as registered).
//   node study.js --synthetic | node study.js --coverage | node study.js   (ONE real run)
// Data: K2_CM_DIR (nse-data/cm json), K2_SLB_DIR (research/nse-atlas/slbm_bc, *.dat), K2_SOPT_DIR (research/options-2026-10-04/nse-sopt).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { context } = require(path.join(ROOT, "api/_lib/forward-v3"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const M = { F1: "F1 high fee -> short 5d", F2: "F2 high fee -> short 20d", F3: "F3 long low fee / short high fee, 20d" };
// S2 as registered and run once (studies/nse-data-atlas-2026-10-11/RESULT.txt, 12 Oct 2026): used for Holm and DSR only
const S2 = { k: "S2 borrowing surge -> short 5d (atlas, not re-run)", months: 61, trades: 2085, meanPct: 0.256, t: 2.23, sharpe: 0.96, win: 55.3, verdict: "PROMISING" };
const NOTIONAL = 500000;
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const isoOf = (s) => { const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s).trim()); return m ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}` : null; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// one SLB bhavcopy file -> rows {sym, end, low, high, qty, value}
function parseBc(text) { const out = [];
  for (const line of String(text).split(/\r?\n/)) { const r = line.split(","); if (r.length < 17) continue;
    out.push({ sym: r[1].trim(), end: isoOf(r[3]), low: +r[8], high: +r[7], qty: +r[11], value: +r[12] }); }
  return out; }
// FORMAT GATE: value / quantity within [low - 0.01, high + 0.01] on >= 99% of rows with quantity > 0
function formatGate(rows) { const q = rows.filter((r) => r.qty > 0); if (!q.length) return { ok: true, n: 0, bad: 0 };
  const bad = q.filter((r) => { const v = r.value / r.qty; return !(v >= r.low - 0.01 && v <= r.high + 0.01); }).length; return { ok: bad <= 0.01 * q.length, n: q.length, bad }; }

// data: { sessions, stocks, fno: Map(d -> Set(sym)), slb: Map(d -> rows) }
function run(data) {
  const S = data.sessions, sIdx = new Map(S.map((d, i) => [d, i]));
  const ctx = context({ sessions: S, stocks: data.stocks });
  const closeOn = new Map(data.stocks.map((st) => [st.sym, new Map(st.bars.map((b) => [b.d, b.c]))]));
  // fee rate per stock on d
  const rated = (d) => { const rows = data.slb.get(d); const fno = data.fno.get(d); if (!rows || !fno) return null; const uni = ctx.uni(d.slice(0, 7)); const by = new Map();
    for (const r of rows) { if (!(r.qty > 0) || !r.end || days(d, r.end) < 7) continue; const P = closeOn.get(r.sym)?.get(d); if (!(P > 0)) continue;
      const rate = (r.value / r.qty) / P * 365 / days(d, r.end); const o = by.get(r.sym) || { w: 0, q: 0, P }; o.w += rate * r.qty; o.q += r.qty; by.set(r.sym, o); }
    const out = []; for (const [sym, o] of by) if (o.q * o.P >= 1e6 && fno.has(sym) && uni.has(sym)) out.push([sym, o.w / o.q]);
    return out.length >= 20 ? out.sort((a, b) => a[1] - b[1]) : null; };
  const bCache = new Map();
  const B = (e, h) => { const key = `${e}|${h}`; if (bCache.has(key)) return bCache.get(key); const xs = [];
    for (const sym of ctx.uni(e.slice(0, 7))) { const w = ctx.window(sym, e, h); if (!w || !w.complete) continue; const b = w.st.bars; xs.push(b[w.i + h - 1].c / b[w.i].o - 1); }
    const v = xs.length >= 20 ? mean(xs) : null; bCache.set(key, v); return v; };
  const trades = []; const busy = {};
  const leg = (sym, e, h, side) => { const w = ctx.window(sym, e, h); if (!w || !w.complete || !ctx.uni(e.slice(0, 7)).has(sym)) return null; const b = w.st.bars, x = b[w.i + h - 1]; return { net: futNet(side, b[w.i].o, x.c, e, x.d), exit: x.d }; };
  const oneSided = (k, sym, d, h) => { const i = sIdx.get(d); const e = S[i + 2]; if (!e) return; const key = `${k}|${sym}`; if (busy[key] && busy[key] >= e) return;
    const l = leg(sym, e, h, -1); if (!l) return; busy[key] = l.exit; const b0 = B(e, h); if (b0 === null) return; trades.push({ member: M[k], day: e, net: l.net + b0, sym }); };
  for (const d of S) { if (!sIdx.has(d)) continue; const r = rated(d); if (!r) continue; const k = Math.floor(r.length / 10); for (const [sym] of r.slice(-k)) { oneSided("F1", sym, d, 5); oneSided("F2", sym, d, 20); } }
  for (let i = 2; i < S.length; i += 1) { if (i % 20 !== 0) continue; const e = S[i], d = S[i - 2]; const r = rated(d); if (!r) continue; const k = Math.floor(r.length / 10);
    const L = r.slice(0, k).map(([s]) => leg(s, e, 20, 1)).filter(Boolean), Sh = r.slice(-k).map(([s]) => leg(s, e, 20, -1)).filter(Boolean);
    if (!L.length || !Sh.length) continue; trades.push({ member: M.F3, day: e, net: (mean(L.map((x) => x.net)) + mean(Sh.map((x) => x.net))) / 2 }); }
  return { trades };
}

// ---- PROTOCOL v2 scoring (as the atlas study)
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function monthly(ts) { const month = new Map(); for (const t of ts) { const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(t.net); } return [...month.keys()].sort().map((m) => mean(month.get(m)) * 100); }
function score(trades, withS2 = true) {
  const rows = Object.values(M).map((k) => { const ts = trades.filter((t) => t.member === k); const s = monthly(ts);
    if (s.length < 24) return { k, months: s.length, trades: ts.length, verdict: "NOT TESTABLE" };
    const r = nwT(s); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
    return { k, months: s.length, trades: ts.length, meanPct: r.mean, t: r.t, sharpe, win: (100 * ts.filter((t) => t.net > 0).length) / ts.length,
      verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" }; });
  if (withS2) rows.push({ ...S2 });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); for (const r of tested) r.p = 1 - Phi(r.t); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const vSR = N > 1 ? sd(tested.map((r) => r.sharpe)) ** 2 : 0; const g = 0.5772156649;
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
  const n = sessions.length, NS = 80;
  const fee = Array.from({ length: n }, () => Array.from({ length: NS }, () => Math.exp(gauss())));   // per-day fee level per stock
  const stocks = []; for (let k = 0; k < NS; k += 1) { let p = 500 + k; const bars = [];
    for (let i = 0; i < n; i += 1) { const hi = plant && [2, 3, 4, 5, 6].some((g) => i - g >= 0 && fee[i - g][k] > 3.6); const o = p * (1 + 0.003 * gauss()); const c = o * (1 + (hi ? -0.006 : 0) + 0.015 * gauss());
      bars.push({ d: sessions[i], o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 * (1 + k / 100) }); p = c; }
    stocks.push({ sym: `S${k}`, bars }); }
  const end = (i) => sessions[Math.min(n - 1, i + 25)];
  const slb = new Map(sessions.map((d, i) => [d, stocks.map((st, k) => { const P = st.bars[i].c; const f = fee[i][k] * 0.01 * P * days(d, end(i)) / 365; const q = 50000;
    return { sym: st.sym, end: end(i), low: f * 0.9, high: f * 1.1, qty: q, value: q * f }; })]));
  const fno = new Map(sessions.map((d) => [d, new Set(stocks.map((st) => st.sym))]));
  return { sessions, stocks, slb, fno };
}

if (process.argv.includes("--synthetic")) {
  let ok = true; const say = (name, pass, detail) => { console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}  (${detail})`); if (!pass) ok = false; };
  const v = (rows) => rows.map((r) => `${r.k.split(" ")[0]} ${r.verdict}${r.t !== undefined ? ` ${r.t.toFixed(1)}` : ""}`).join(", ");
  const a = score(run(synth(11, true)).trades, false); say("1. planted edge (high-fee stocks fall) found by F1 and F3", a[0].verdict === "PASS" && a[2].verdict === "PASS", v(a));
  let worst = 0; for (const seed of [21, 22, 23]) { const r = score(run(synth(seed, false)).trades, false); worst = Math.max(worst, r.filter((x) => x.verdict === "PASS").length); console.log(`      noise ${seed}: ${v(r)}`); }
  say("2. noise: at most one chance PASS", worst <= 1, `most PASSes: ${worst}`);
  const base = synth(31, false), cutI = 1000, cut = base.sessions[cutI], pert = synth(31, false);
  for (const d of pert.sessions.slice(cutI)) pert.slb.set(d, pert.slb.get(d).map((r) => ({ ...r, value: r.value * 50, low: r.low * 50, high: r.high * 50 })));
  for (const st of pert.stocks) for (const bar of st.bars) if (bar.d >= cut) { bar.o *= 1.5; bar.c *= 0.5; }
  const early = (r) => r.trades.filter((t) => pert.sessions.indexOf(t.day) <= cutI - 25).map((t) => `${t.member}|${t.day}|${t.sym || ""}|${t.net.toFixed(10)}`).sort().join("\n");
  const x = early(run(base)), y = early(run(pert)); say("3. no look-ahead: trades entered 25+ sessions before the cut are identical", x === y && x.length > 0, `${x.split("\n").length} trades, cut ${cut}`);
  const good = parseBc("X LTD ,XYZ ,XN,03-NOV-2026,N,0000003.70,0000004.00,0000004.00,0000004.00,0000004.00,    ,  428,  1712.00,0000004.00,0000003.50,12-OCT-2026,  1");
  const bad = parseBc("X LTD ,XYZ ,XN,03-NOV-2026,N,0000003.70,0000004.00,0000004.00,0000004.00,0000004.00,    ,  428,  9999.00,0000004.00,0000003.50,12-OCT-2026,  1");
  say("4. the format gate passes value = quantity x fee and rejects anything else", formatGate(good).ok && !formatGate(bad).ok && good[0].end === "2026-11-03", JSON.stringify(good[0]));
  console.log(ok ? "\nSYNTHETIC CHECKS: ALL PASS" : "\nSYNTHETIC CHECKS FAILED"); process.exit(ok ? 0 : 1);
}

// ---- loaders for the real run
function loadReal() {
  const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), SLB = path.resolve(process.env.K2_SLB_DIR || path.join(ROOT, "research", "nse-atlas", "slbm_bc"));
  const SOPT = path.resolve(process.env.K2_SOPT_DIR || path.join(ROOT, "research", "options-2026-10-04", "nse-sopt"));
  const files = fs.readdirSync(CM).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(CM, f), "utf8"))) { const [, sym, series, o, h, l, c, , qty, val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val, qty }); } }
  const fno = new Map(); for (const f of fs.readdirSync(SOPT).filter((x) => x.endsWith(".json.gz"))) fno.set(f.slice(0, 10), new Set(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SOPT, f)))).map((r) => r[0])));
  const slb = new Map(); const gate = { files: 0, failed: [] };
  for (const f of fs.readdirSync(SLB).filter((x) => x.endsWith(".dat")).sort()) { const rows = parseBc(fs.readFileSync(path.join(SLB, f), "utf8")); const g = formatGate(rows); gate.files += 1; if (!g.ok) gate.failed.push(`${f} (${g.bad} of ${g.n})`); slb.set(f.slice(0, 10), rows); }
  return { sessions, stocks: [...bySym.values()], fno, slb, gate };
}

const data = loadReal();
const yr = (keys) => { const c = {}; for (const d of keys) c[d.slice(0, 4)] = (c[d.slice(0, 4)] || 0) + 1; return JSON.stringify(c); };
console.log(`CM ${data.sessions.length} sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}; F&O (stock options) files ${yr(data.fno.keys())}; SLB files ${yr(data.slb.keys())}`);
console.log(`FORMAT GATE: ${data.gate.files} files, ${data.gate.failed.length} failed${data.gate.failed.length ? ": " + data.gate.failed.slice(0, 5).join(", ") : ""}`);
if (data.gate.failed.length) { console.log("NOT RUN: the SLB file layout is not as registered."); process.exit(3); }
if (process.argv.includes("--coverage")) process.exit(0);
const res = run(data); const rows = score(res.trades);
const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`LOAN-FEE TEST -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); protocol v2`);
line(`Prices: ${data.sessions.length} CM sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}; SLB files ${data.slb.size}; F&O files ${data.fno.size}. DSR benchmark: ${rows.SR0 === undefined ? "-" : rows.SR0.toFixed(2)}`);
line("member | months | trades | mean/trade | winners | t (NW) | annual Sharpe | Holm | DSR | VERDICT");
for (const r of rows) line(fmt(r));
line(`\nPASS (t >= 3): ${rows.filter((r) => r.verdict === "PASS").map((r) => r.k).join("; ") || "none"}. PROMISING: ${rows.filter((r) => r.verdict === "PROMISING").map((r) => r.k).join("; ") || "none"}.`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify(rows, null, 1));
