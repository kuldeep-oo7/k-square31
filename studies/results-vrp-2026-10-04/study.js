"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).   node study.js --synthetic | node study.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const NOTIONAL = 500000, MIN_BARS = 250, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18, QTY = 75;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const MEMBERS = ["R1 results reaction top 20% -> long 10d", "R2 results reaction bottom 20% -> short 10d", "V1 short NIFTY straddle when IV > 1.2x realised",
  "V2 short NIFTY 2% strangle", "V3 LONG NIFTY straddle (buyer)"];
const futCost = (e, x, d, ed) => { const q = Math.ceil(NOTIONAL / e); const ch = (s, p, dd) => calculateNseFuturesCharges({ side: s, price: p, quantity: q, asOfDate: `${dd}T12:00:00Z` }).totalCharges;
  const cross = (+ed.slice(0, 4) - +d.slice(0, 4)) * 12 + (+ed.slice(5, 7) - +d.slice(5, 7)); return (ch("BUY", e, d) + ch("SELL", x, ed) + cross * (ch("BUY", x, ed) + ch("SELL", x, ed))) / (e * q); };
const optCost = (entry, exit) => { const r = roundTripCost({ entryPremium: entry, exitPremium: Math.max(exit, 0.05), quantity: QTY }); return r ? r.totalCost / QTY : null; };
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// data: { sessions, stocks:[{sym,bars}], events:[{sym, date}], nifty: Map(d->{open,close}), opt: Map(d->{idx:{NIFTY:[[exp,K,typ,close,settle,oi]]}}), niftyOptExpiries }
function run(data) {
  const trades = []; const add = (k, d, net) => { const w = windowOf(d); if (w && Number.isFinite(net)) trades.push({ member: MEMBERS[k], day: d, window: w, net }); };
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  const cutsOf = new Map(); for (const st of data.stocks) { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); cutsOf.set(st.sym, cut); }
  const months = new Map(); for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  const members = new Map();
  for (const [m, first] of months) { const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < MIN_BARS) continue;
      const v = st.bars.slice(Math.max(lc, k - VALUE_WINDOW), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0]))); }
  // results events
  const bySym = new Map(data.stocks.map((s) => [s.sym, s]));
  const ev = [];
  const seen = new Set();
  for (const e of data.events) { const key = `${e.sym}|${e.date}`; if (seen.has(key)) continue; seen.add(key);
    const st = bySym.get(e.sym); if (!st) continue; const b = st.bars; const i0 = b.findIndex((x) => x.d >= e.date); if (i0 < 1 || i0 + 11 >= b.length) continue;
    // consecutive sessions, no reset from the session before M0 to the exit
    let ok = true; for (let k = i0; k <= i0 + 11; k += 1) if (sIndex.get(b[k].d) !== sIndex.get(b[k - 1].d) + 1 || Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) ok = false; if (!ok) continue;
    const entry = b[i0 + 2]; if (!members.get(entry.d.slice(0, 7))?.has(e.sym)) continue;
    ev.push({ d: entry.d, reaction: b[i0 + 1].c / b[i0 - 1].c - 1, e: entry.o, x: b[i0 + 11].c, xd: b[i0 + 11].d }); }
  const dev = ev.filter((x) => windowOf(x.d) === "development").map((x) => x.reaction); const lo = pct(dev, 0.2), hi = pct(dev, 0.8);
  for (const x of ev) { const g = x.x / x.e - 1, c = futCost(x.e, x.x, x.d, x.xd); if (x.reaction >= hi) add(0, x.d, g - c); else if (x.reaction <= lo) add(1, x.d, -g - c); }
  // NIFTY options
  const nd = data.sessions.filter((d) => data.nifty.has(d));
  const rv = (d) => { const i = nd.indexOf(d); if (i < 21) return null; const r = []; for (let k = i - 19; k <= i; k += 1) r.push(Math.log(data.nifty.get(nd[k]).close / data.nifty.get(nd[k - 1]).close)); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length * 252); };
  let prevE = "0000";
  for (const E of data.niftyOptExpiries) {
    const d = nd.find((x) => x > prevE && days(x, E) >= 4 && days(x, E) <= 10 && data.opt.get(x)?.idx?.NIFTY?.length); prevE = E; if (!d || !data.nifty.has(E)) continue;
    const S = data.nifty.get(d).close, SE = data.nifty.get(E).close; const rows = data.opt.get(d).idx.NIFTY.filter((r) => r[0] === E && r[3] > 0);
    const legs = (K, typ) => rows.find((r) => r[1] === K && r[2] === typ)?.[3];
    const both = [...new Set(rows.map((r) => r[1]))].filter((K) => legs(K, "CE") && legs(K, "PE")); if (!both.length) continue;
    const near = (t) => both.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    const K = near(S), ce = legs(K, "CE"), pe = legs(K, "PE"), pay = Math.abs(SE - K);
    const c1 = optCost(ce, Math.max(SE - K, 0)), c2 = optCost(pe, Math.max(K - SE, 0)); if (c1 === null || c2 === null) continue;
    const shortNet = (ce + pe - pay - c1 - c2) / S, longNet = (pay - ce - pe - c1 - c2) / S;
    const iv = (ce + pe) / (0.8 * S * Math.sqrt(days(d, E) / 365)), r20 = rv(d);
    if (r20 && iv > 1.2 * r20) add(2, d, shortNet);
    add(4, d, longNet);
    const strikesCE = [...new Set(rows.filter((r) => r[2] === "CE").map((r) => r[1]))], strikesPE = [...new Set(rows.filter((r) => r[2] === "PE").map((r) => r[1]))];
    if (strikesCE.length && strikesPE.length) { const kc = strikesCE.reduce((a, b) => (Math.abs(b - S * 1.02) < Math.abs(a - S * 1.02) ? b : a)), kp = strikesPE.reduce((a, b) => (Math.abs(b - S * 0.98) < Math.abs(a - S * 0.98) ? b : a));
      const pc = legs(kc, "CE"), pp = legs(kp, "PE"); const payS = Math.max(SE - kc, 0) + Math.max(kp - SE, 0); const d1 = optCost(pc, Math.max(SE - kc, 0)), d2 = optCost(pp, Math.max(kp - SE, 0));
      if (d1 !== null && d2 !== null) add(3, d, (pc + pp - payS - d1 - d2) / S); }
  }
  return { trades, cutoffs: { lo, hi } };
}

function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { if (!Number.isFinite(t) || df < 1) return 1; const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return Math.min(1, Math.max(0, s * h)); }
function stats(rows) { if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null, worstPct: null }; const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat, winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length, worstPct: 100 * Math.min(...rows.map((x) => x.net)) }; }
function verdicts(trades) { const by = new Map(MEMBERS.map((n) => [n, { development: [], validation: [], final: [] }])); for (const t of trades) by.get(t.member)[t.window].push(t);
  const out = {}; for (const n of MEMBERS) { const g = by.get(n); out[n] = { development: stats(g.development), validation: stats(g.validation), final: stats(g.final) }; out[n].p = out[n].final.trades > 1 ? pUpper(out[n].final.t, out[n].final.months - 1) : 1; }
  const order = MEMBERS.slice().sort((a, b) => out[a].p - out[b].p); let ok = true;
  order.forEach((n, k) => { const o = out[n], a = 0.05 / (order.length - k); const holm = ok && o.p <= a; if (!holm) ok = false; o.holmAlpha = a;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE" : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL"; }); return out; }

function synthetic(seed, plant) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const thursdays = sessions.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 4);
  const stocks = [], events = [];
  for (let k = 0; k < 120; k += 1) { const sym = `S${k}`; let px = 500, drift = 0; const bars = [];
    sessions.forEach((d, i) => { const isEv = i % 63 === (k * 7) % 63 && i > 300; if (isEv) events.push({ sym, date: d });
      const jump = i >= 1 && (i - 1) % 63 === (k * 7) % 63 && i > 301 ? 0.06 * gauss() : 0; // the results reaction lands on M0+1
      const o = px * (1 + 0.002 * gauss()); const c = o * (1 + jump + drift + 0.015 * gauss()); bars.push({ d, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, val: 1e9 * (1 + rnd()) });
      drift = plant.drift && jump !== 0 ? Math.sign(jump) * 0.004 : drift * 0.93; px = c; });
    stocks.push({ sym, bars }); }
  const nifty = new Map(), opt = new Map(); let n = 15000; const vol = []; sessions.forEach((d, i) => { const calm = Math.floor(i / 40) % 2 === 0; const sd = calm ? 0.006 : 0.012; const o = n; n = o * (1 + sd * gauss()); nifty.set(d, { open: o, close: n }); vol.push(sd);
    const E = thursdays.find((t) => t > d) || d; const T = Math.max(days(d, E), 1) / 365; const realised = vol.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vol.length) * Math.sqrt(252);
    const iv = plant.vrp && calm ? realised * 1.8 : realised; const rows = [];
    // fair Black-Scholes prices (zero rate) at the implied volatility
    const N = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const dd = 0.3989423 * Math.exp(-x * x / 2); const p = dd * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
    for (let K = Math.round(n / 50) * 50 - 500; K <= Math.round(n / 50) * 50 + 500; K += 50) { const sv = iv * Math.sqrt(T); const d1 = (Math.log(n / K) + sv * sv / 2) / sv, d2 = d1 - sv;
      const call = n * N(d1) - K * N(d2), put = call - n + K; rows.push([E, K, "CE", Math.max(call, 0.05), 0, 1e5], [E, K, "PE", Math.max(put, 0.05), 0, 1e5]); }
    opt.set(d, { idx: { NIFTY: rows } }); });
  return { sessions, stocks, events, nifty, opt, niftyOptExpiries: thursdays };
}
const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (st) => (st.trades ? `${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}% t ${st.t.toFixed(2)} win ${st.winPct.toFixed(0)}% worst ${st.worstPct.toFixed(1)}% (${st.trades})` : "no trades");
if (process.argv.includes("--synthetic")) {
  const a = verdicts(run(synthetic(3, { drift: true })).trades)[MEMBERS[0]].final, b = verdicts(run(synthetic(3, { vrp: true })).trades)[MEMBERS[2]].final;
  line(`(1) planted drift R1: ${fmt(a)}; planted premium V1: ${fmt(b)}`);
  const ok1 = a.meanPct > 0 && a.t > 2 && b.meanPct > 0 && b.t > 2;
  let passes = 0; for (let k = 1; k <= 3; k += 1) { const vv = verdicts(run(synthetic(k * 389, {})).trades); for (const [nm, o] of Object.entries(vv)) if (o.verdict === "PASS") { passes += 1; line(`    noise PASS: ${nm} ${fmt(o.final)}`); } }
  line(`(2) 3 noise markets x 5 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(31, {}); const cut = base.sessions[1100]; const A = run(base).trades.filter((x) => x.day < base.sessions[1100 - 15]);
  for (const st of base.stocks) for (const b2 of st.bars) if (b2.d >= cut) { b2.o *= 1.1; b2.c *= 0.8; }
  for (const [d, v] of base.nifty) if (d >= cut) base.nifty.set(d, { open: v.open * 1.2, close: v.close * 0.7 });
  const B = run(base).trades.filter((x) => x.day < base.sessions[1100 - 15]);
  const key = (x) => `${x.member}|${x.day}|${x.net}`; const sa = A.map(key).sort(), sb = B.map(key).sort(); const same = sa.length === sb.length && sa.every((x, k) => x === sb[k]);
  line(`(3) changing every price after ${cut}: ${A.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}
const R = path.join(ROOT, "research"); const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"); const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , , val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const events = []; const bmDir = path.join(HERE, "nse-board-meetings");
for (const f of fs.readdirSync(bmDir)) for (const [sym, date, purpose] of JSON.parse(fs.readFileSync(path.join(bmDir, f), "utf8"))) { if (!/result/i.test(purpose || "")) continue;
  const [dd, mm, yy] = String(date).split("-"); if (!MON[(mm || "").toUpperCase()]) continue; events.push({ sym, date: `${yy}-${MON[mm.toUpperCase()]}-${dd.padStart(2, "0")}` }); }
const opt = new Map(); const od = path.join(R, "families-2026-10-04", "nse-extra", "opt"); for (const f of fs.readdirSync(od).filter((x) => x.endsWith(".json"))) opt.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(od, f), "utf8")));
const nifty = new Map(JSON.parse(fs.readFileSync(path.join(R, "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json"), "utf8")).rows.map((r) => [r.date, { open: r.open, close: r.close }]));
const exps = JSON.parse(fs.readFileSync(path.join(R, "situations-2026-09-29", "nifty-expiries-nse.json"), "utf8"));
const res = run({ sessions, stocks: [...bySym.values()], events, nifty, opt, niftyOptExpiries: exps.OPTIDX.slice().sort() }); const v = verdicts(res.trades);
line(`RESULTS + VOLATILITY PREMIUM -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); ${events.length} results filings; reaction cut-offs from development: ${(100 * res.cutoffs.lo).toFixed(2)}% / ${(100 * res.cutoffs.hi).toFixed(2)}%`);
for (const [n, o] of Object.entries(v)) line(`${n.padEnd(46)} | dev ${fmt(o.development)} | val ${fmt(o.validation)} | final ${fmt(o.final)} | p ${o.p.toExponential(1)} vs ${o.holmAlpha.toFixed(4)} | ${o.verdict}`);
const pass = Object.entries(v).filter(([, o]) => o.verdict === "PASS").map(([n]) => n); line(`\nPASS: ${pass.length ? pass.join(", ") : "none"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v, cutoffs: res.cutoffs }, null, 2));
