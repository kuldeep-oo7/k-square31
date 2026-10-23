"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the VRP lab, one batch, one run.
//   node run.js --checks   checks 6.1-6.3 only (6.3 needs the discovery data); nothing is scored
//   node run.js            the real run (RESULT.txt, result.json: summary rows only)
// Data (private, never committed): K2_NOD_DIR = release data-nifty-options extracted (nod/YYYY/YYYY-MM-DD.json.gz:
// { date, underlying, lot, rows: [[expiry, strike, CE|PE, open, high, low, close, settle, oi, contracts]] });
// K2_MACRO_IC = data-macro ind_close_all/ (NIFTY's official open).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));

const QTY = 75, SLIP = 1, N_TRIALS = 393;
const DISC = ["2019-02-11", "2022-12-31"], CONF = ["2023-01-01", "2026-10-01"];
const MEMBERS = ["D1 day -1", "D2 day -2", "D3 day -3", "D4 day -4"];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- the trade (the expiry study's leg and strike rules, with the day's close as the exit) ----------
function leg(row, costs = true) {   // sold at its open; bought back at 2x if the day's high reached it, else at the close (settle if no close)
  const [, , , open, high, , close, settle] = row; if (!(open > 0)) return null; const stopped = high >= 2 * open, last = close > 0 ? close : settle;
  if (!stopped && !(last > 0)) return null; const exit = stopped ? 2 * open : last;
  let cost = 0; if (costs) { const r = roundTripCost({ entryPremium: Math.max(exit, 0.05), exitPremium: open, quantity: QTY }); if (!r) return null; cost = r.totalCost / QTY + SLIP; }
  return { pnl: open - exit - cost, stopped };
}
const nearest = (rows, typ, target) => { const c = rows.filter((r) => r[2] === typ && r[3] > 0); if (!c.length) return null;
  return c.reduce((best, r) => { const d = Math.abs(r[1] - target), b = Math.abs(best[1] - target); return d < b || (d === b && (typ === "CE" ? r[1] > best[1] : r[1] < best[1])) ? r : best; }); };
function straddle(day, E, niftyOpen) { const rows = day.rows.filter((r) => r[0] === E); const c = nearest(rows, "CE", niftyOpen), p = nearest(rows, "PE", niftyOpen); if (!c || !p) return null;
  const a = leg(c), b = leg(p); if (!a || !b) return null; const pts = a.pnl + b.pnl; return { pts, pct: (pts / niftyOpen) * 100, stops: (a.stopped ? 1 : 0) + (b.stopped ? 1 : 0) }; }

// ---------- data ----------
function loadNod(dir) { const out = new Map(); if (!dir || !fs.existsSync(dir)) return out;
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^\d{4}-\d{2}-\d{2}\.json(\.gz)?$/.test(f.name)) {
    const buf = fs.readFileSync(p); const j = JSON.parse(f.name.endsWith(".gz") ? zlib.gunzipSync(buf) : buf); if (j && Array.isArray(j.rows)) out.set(f.name.slice(0, 10), j); } } };
  walk(dir); return out; }
function loadOpen(dir) { const m = new Map(); if (!dir || !fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) { const t = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/"/g, "").trim()));
    const io = (t[0] || []).findIndex((x) => /Open Index Value/i.test(x)); const r = t.find((x) => /^(nifty 50|cnx nifty|s&p cnx nifty)$/i.test(x[0] || "")); if (io >= 0 && r && +r[io] > 0) m.set(f.slice(0, 10), +r[io]); }
  return m; }
// every session that is 1..4 sessions before the nearest expiry after it: { i, date, k, E }
function slots(days) { const S = [...days.keys()].sort(), idx = new Map(S.map((d, i) => [d, i])), out = [];
  S.forEach((d, i) => { const later = [...new Set(days.get(d).rows.map((r) => r[0]))].filter((e) => e > d).sort(); const E = later[0]; if (!E || !idx.has(E)) return; const k = idx.get(E) - i; if (k >= 1 && k <= 4) out.push({ i, date: d, k, E }); });
  return { S, slots: out }; }
function trades(days, opens, from, to) { const { slots: sl } = slots(days), T = new Map(MEMBERS.map((m) => [m, []]));
  for (const s of sl) { if (s.date < from || s.date > to) continue; const o = opens.get(s.date); if (!(o > 0)) continue; T.get(MEMBERS[s.k - 1]).push({ date: s.date, E: s.E, o }); }
  return T; }

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(days, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(), v = [];
    for (const t of T.get(name) || []) { const x = straddle(days.get(t.date), t.E, t.o); if (!x) continue; v.push({ ...x, date: t.date }); const k = t.date.slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(x.pct); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); const base = { name, trades: v.length, pts: v.length ? mean(v.map((x) => x.pts)) : null, win: v.length ? (100 * v.filter((x) => x.pts > 0).length) / v.length : null,
      worstPts: v.length ? Math.min(...v.map((x) => x.pts)) : null, worstPct: v.length ? Math.min(...v.map((x) => x.pct)) : null, stops: v.reduce((a, x) => a + x.stops, 0) };
    if (s.length < 24) return { ...base, months: s.length, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { ...base, months: s.length, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd, g3: mean(s.map((x) => ((x - m) / sd) ** 3)), g4: mean(s.map((x) => ((x - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(10)} NOT TESTABLE (${r.months} months, ${r.trades} trades)`
  : `${r.name.padEnd(10)} ${String(r.trades).padStart(4)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.pts, 1)} points a trade (${sgn(r.monthMean)}% of NIFTY, monthly) | won ${r.win.toFixed(0)}% | worst ${sgn(r.worstPts, 0)} pts (${sgn(r.worstPct, 2)}%) | stops ${r.stops} | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ""));

// ---------- checks ----------
function check61(log) { const a = leg(["E", 100, "CE", 100, 200, 90, 150, 150], true), b = leg(["E", 100, "CE", 100, 150, 90, 120, 120], true);
  const ca = roundTripCost({ entryPremium: 200, exitPremium: 100, quantity: QTY }).totalCost / QTY + SLIP, cb = roundTripCost({ entryPremium: 120, exitPremium: 100, quantity: QTY }).totalCost / QTY + SLIP;
  const ok = a.stopped && Math.abs(a.pnl - (100 - 200 - ca)) < 1e-9 && !b.stopped && Math.abs(b.pnl - (100 - 120 - cb)) < 1e-9;
  log(` 6.1 by hand: high 200 -> bought back at 2x (${a.pnl.toFixed(2)} points); high 150 -> at the close 120 (${b.pnl.toFixed(2)} points): ${ok ? "PASSED" : "FAILED"}`); return ok; }
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const Ncdf = (x) => Phi(x);
function bs(typ, S, K, T, s) { if (T <= 0) return Math.max(0, typ === "CE" ? S - K : K - S); const v = s * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * v * v) / v, d2 = d1 - v; return typ === "CE" ? S * Ncdf(d1) - K * Ncdf(d2) : K * Ncdf(-d2) - S * Ncdf(-d1); }
function synth(seed) {   // NIFTY with 15% realized volatility; weekly Thursday expiries; options priced at an implied volatility 30% above it
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const days = new Map(), opens = new Map(); let S = 15000; const vol = 0.15, iv = vol * 1.3;
  const dates = []; for (let t = Date.parse("2019-02-11"); t < Date.parse("2022-12-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const d of dates) { const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); const toThu = (4 - dow + 7) % 7; const E = new Date(Date.parse(d) + toThu * 864e5).toISOString().slice(0, 10);
    const open = S * (1 + 0.003 * g()), steps = 12, path = [open]; for (let k = 0; k < steps; k += 1) path.push(path.at(-1) * Math.exp((vol / Math.sqrt(252 * steps)) * g()));
    let left = 0; for (let t = Date.parse(d) + 864e5; t <= Date.parse(E); t += 864e5) if (new Date(t).getUTCDay() % 6) left += 1;   // sessions after today up to the expiry
    const tOpen = (left + 1) / 252, tAt = (k) => Math.max(0, tOpen - (k / steps) / 252); const rows = [];   // time in trading years, as the path's variance
    for (let K = Math.round(open / 50) * 50 - 300; K <= Math.round(open / 50) * 50 + 300; K += 50) for (const typ of ["CE", "PE"]) {
      const px = path.map((s, k) => bs(typ, s, K, tAt(k), iv)); rows.push([E, K, typ, +px[0].toFixed(2), +Math.max(...px).toFixed(2), +Math.min(...px).toFixed(2), +px.at(-1).toFixed(2), +px.at(-1).toFixed(2), 1000, 100]); }
    days.set(d, { date: d, rows }); opens.set(d, open); S = path.at(-1); }
  return { days, opens };
}
function check62(log) { const { days, opens } = synth(62), r = score(days, trades(days, opens, DISC[0], DISC[1])).find((x) => x.name === MEMBERS[0]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 6.2 planted (implied volatility 30% above realized): D1 ${r.trades} trades, ${r.pts !== null ? sgn(r.pts, 1) : "-"} points a trade, t ${r.t !== undefined ? r.t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check63(days, opens, T, log) { const r = rng(63), { slots: sl } = slots(days), pool = sl.filter((s) => s.date >= DISC[0] && s.date <= DISC[1] && opens.get(s.date) > 0); const R = new Map();
  for (const [m, ts] of T) R.set(m, ts.map(() => { const s = pool[Math.floor(r() * pool.length)]; return { date: s.date, E: s.E, o: opens.get(s.date) }; }));
  const rows = score(days, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 6.3 re-dated null (random sessions before an expiry, discovery): ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`VRP LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  const days = loadNod(process.env.K2_NOD_DIR), opens = loadOpen(process.env.K2_MACRO_IC); if (!days.size || !opens.size) { console.error("MISSING INPUT: nothing computed."); process.exit(3); }
  const S = [...days.keys()].sort(); log(`DATA: option files on ${days.size} sessions ${S[0]} .. ${S.at(-1)}; NIFTY opens on ${opens.size} days`);
  const TD = trades(days, opens, DISC[0], DISC[1]); log(" discovery trades: " + MEMBERS.map((m) => `${m.split(" ")[0]} ${TD.get(m).length}`).join(", "));
  if (!check63(days, opens, TD, log)) refuse("CHECK 6.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const TF = trades(days, opens, CONF[0], CONF[1]); const rd = score(days, TD), rf = score(days, TF);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (ATM straddle sold at the open, 2x stop a leg, else bought back at the close; % of NIFTY; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first (information only).`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, leg, straddle, slots, trades, score, synth, check61, check62 };
