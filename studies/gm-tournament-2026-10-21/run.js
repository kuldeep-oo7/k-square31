"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): every coded member, scored under GM's rules.
//   node run.js --check            check 5.1 (hand-built trades) and 5.2 (re-dated null) only
//   node run.js                    the one real run, phase 1 (writes RESULT.txt, leaderboard.json)
// Data (laptop research/ or a restored copy): K2_RESEARCH_DIR (default ../../research).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const UNITS = 20, EQ_NOTIONAL = 500000, RESET = 0.18, EXTRA_TRIALS = 100;
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
const isoWeek = (d) => { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear(); const w1 = new Date(Date.UTC(y, 0, 4)); return `${y}-${Math.round(((t - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7) + 1}`; };

// ---------- the GM scorer ----------
// trade: { member, sym, side (+1/-1), entryDay, exitDay }; ctx: { bySym, idx: Map(sym -> Map(d -> i)), expiryFor(sym, d) -> ISO or null }
function gm(trade, ctx, { monthEnd = false } = {}) {
  const st = ctx.bySym.get(trade.sym); const ix = ctx.idx.get(trade.sym); if (!st || !ix) return null;
  const i = ix.get(trade.entryDay); let j = ix.get(trade.exitDay); if (i === undefined || j === undefined || j < i) return null;
  const b = st.bars;
  // GM auto-sells: at the stock's monthly futures expiry (judged) or the calendar month's last session (sensitivity)
  let cut = null;
  if (monthEnd) { let k = i; while (k + 1 < b.length && b[k + 1].d.slice(0, 7) === b[i].d.slice(0, 7)) k += 1; cut = k; }
  else { const e = ctx.expiryFor(trade.sym, trade.entryDay); if (e) { let k = i; while (k + 1 < b.length && b[k + 1].d <= e) k += 1; cut = k; } }
  if (cut !== null && cut < j) j = cut;
  for (let k = i + 1; k <= j; k += 1) if (Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) return { void: true };
  const entry = b[i].o, exit = b[j].c; let gap = 0;
  for (let k = i + 1; k <= j; k += 1) if (isoWeek(b[k].d) !== isoWeek(b[k - 1].d)) gap += b[k].o - b[k - 1].c;
  const s = trade.side, sideIn = s > 0 ? "BUY" : "SELL", sideOut = s > 0 ? "SELL" : "BUY";
  const cost = (q) => charge(sideIn, entry, q, b[i].d) + charge(sideOut, exit, q, b[j].d);
  const qEq = Math.ceil(EQ_NOTIONAL / entry);
  const u20 = s * UNITS * (exit - entry) - cost(UNITS), eq = s * qEq * (exit - entry) - cost(qEq);
  return { member: trade.member, sym: trade.sym, side: s, entryDay: b[i].d, exitDay: b[j].d, cutByExpiry: j < ix.get(trade.exitDay), entry, exit,
    u20, u20g0: u20 - s * UNITS * gap, eq, eqg0: eq - s * qEq * gap, pct: (s * (exit / entry - 1) - cost(qEq) / (entry * qEq)) * 100 };
}

// ---------- statistics (protocol v2 + amendment A1) ----------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
function board(scored) {
  const by = new Map(); for (const r of scored) { if (!r || r.void) continue; if (!by.has(r.member)) by.set(r.member, []); by.get(r.member).push(r); }
  const rows = [...by].map(([member, ts]) => { const month = new Map(); for (const t of ts) { const m = t.entryDay.slice(0, 7); month.set(m, (month.get(m) || 0) + t.eq / EQ_NOTIONAL * 100); }
    const s = [...month.keys()].sort().map((m) => month.get(m)); const r = { member, trades: ts.length, months: s.length,
      u20: ts.reduce((a, t) => a + t.u20, 0), u20g0: ts.reduce((a, t) => a + t.u20g0, 0), eq: ts.reduce((a, t) => a + t.eq, 0), eqg0: ts.reduce((a, t) => a + t.eqg0, 0),
      pctMean: mean(ts.map((t) => t.pct)), win: (100 * ts.filter((t) => t.u20 > 0).length) / ts.length, cut: (100 * ts.filter((t) => t.cutByExpiry).length) / ts.length };
    if (s.length < 24) return { ...r, verdict: "NOT TESTABLE" };
    const m = mean(s), sdev = sd(s), sr = m / sdev; return { ...r, monthMean: m, t: nwT(s), sr, g3: mean(s.map((v) => ((v - m) / sdev) ** 3)), g4: mean(s.map((v) => ((v - m) / sdev) ** 4)), p: 1 - Phi(nwT(s)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length, NT = N + EXTRA_TRIALS;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649; const SR0 = Math.sqrt(sd(tested.map((r) => r.sr)) ** 2) * ((1 - g) * invPhi(1 - 1 / NT) + g * invPhi(1 - 1 / (NT * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows.sort((a, b) => (b.t ?? -99) - (a.t ?? -99));
}
const inr = (v) => `${v < 0 ? "-" : "+"}Rs ${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const fmt = (r) => `${r.member.padEnd(34)} ${String(r.trades).padStart(6)} tr | GM 20u ${inr(r.u20).padStart(14)} (no-weekend-gap ${inr(r.u20g0)}) | EQ Rs5L ${inr(r.eq).padStart(16)} | ${r.pctMean >= 0 ? "+" : ""}${r.pctMean.toFixed(3)}%/tr | won ${r.win.toFixed(0)}% | cut ${r.cut.toFixed(0)}% | ${r.t === undefined ? "-" : `t ${r.t.toFixed(2)}, Holm ${r.holm ? "y" : "n"}, DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"}`} -> ${r.verdict}`;

// ---------- check 5.1: a hand-built trade ----------
function check51(log) {
  const days = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"]; // Fri, Mon, Tue (expiry), Wed
  const bars = [{ d: days[0], o: 100, c: 101 }, { d: days[1], o: 103, c: 104 }, { d: days[2], o: 104, c: 106 }, { d: days[3], o: 106, c: 110 }];
  const ctx = { bySym: new Map([["X", { bars }]]), idx: new Map([["X", new Map(days.map((d, i) => [d, i]))]]), expiryFor: () => "2026-01-06" };
  const r = gm({ member: "T", sym: "X", side: 1, entryDay: days[0], exitDay: days[3] }, ctx);
  const c20 = charge("BUY", 100, 20, days[0]) + charge("SELL", 106, 20, days[2]);
  const ok = r.exitDay === "2026-01-06" && r.cutByExpiry && Math.abs(r.u20 - (20 * 6 - c20)) < 1e-6 && Math.abs((r.u20 - r.u20g0) - 20 * 2) < 1e-6;
  log(` 5.1 hand-built long Fri open 100 -> cut at Tue expiry close 106, weekend gap 101->103: U20 ${r.u20.toFixed(2)} (expected ${(120 - c20).toFixed(2)}), gap removed ${(r.u20 - r.u20g0).toFixed(2)} (expected 40), cut ${r.cutByExpiry}: ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}

// ---------- data and members (phase 1) ----------
function load() {
  const RS = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const cmDir = path.join(RS, "rising-stocks-2026-10-02", "nse-data", "cm");
  const files = fs.readdirSync(cmDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); const sessions = files.map((f) => f.slice(0, 10));
  const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, pc, v, val] = r;
    if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { id: sym, sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, pc, v, val }); } }
  const stocks = [...bySym.values()]; const idx = new Map(stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const futDir = path.join(RS, "orderflow-2026-10-03", "nse-fo", "fut"); const oi = new Map(); const expOn = new Map();
  for (const f of fs.readdirSync(futDir).filter((x) => x.endsWith(".json"))) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(futDir, f), "utf8"))) { if (r[1] !== "STK") continue;
    if (!oi.has(r[0])) oi.set(r[0], new Map()); const m = oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
    const k = `${r[0]}|${d}`; const e = expOn.get(k); if (r[2] >= d && (!e || r[2] < e)) expOn.set(k, r[2]); } }
  const expiryFor = (sym, d) => expOn.get(`${sym}|${d}`) || null;
  return { RS, sessions, stocks, bySym, idx, oi, expiryFor };
}
function loadStudy(dir) { // a study's own run(), as studies/audit-2026-10-04/rescore.js loads it
  const src = fs.readFileSync(path.join(ROOT, "studies", dir, "study.js"), "utf8"); const cut = src.indexOf('if (process.argv.includes("--synthetic"))');
  const m = { exports: {} }; new Function("require", "module", "__dirname", "process", `${src.slice(0, cut).replace(/^"use strict";/, "")}\nmodule.exports = { run, MEMBERS: typeof MEMBERS === "undefined" ? null : MEMBERS };`)(require, m, path.join(ROOT, "studies", dir), process);
  return m.exports; }
function members(data, log) {
  const T = []; const after = (d) => d >= "2020-10-01";
  // T*: the 36 TA-atlas rules, hold 10, side from the member name
  { const s = loadStudy("ta-atlas-2026-10-03"); const res = s.run({ sessions: data.sessions, stocks: data.stocks });
    for (const t of res.trades) { const i = data.idx.get(t.sym)?.get(t.day); if (i === undefined) continue; const b = data.bySym.get(t.sym).bars; if (i + 9 >= b.length) continue;
      T.push({ member: `T ${t.member}`, sym: t.sym, side: /SHORT/.test(t.member) ? -1 : 1, entryDay: t.day, exitDay: b[i + 9].d }); }
    log(` ta-atlas: ${res.trades.length} trades`); }
  // SB, LU: their own forward code, from 2020-10-01
  { const ofw = require(path.join(ROOT, "api/_lib/oi-flow-forward")); const res = ofw.forward({ sessions: data.sessions, stocks: data.stocks, oi: data.oi, rule: { ...ofw.RULE, start: "2020-10-01" } });
    for (const k of ["SB", "LU"]) { const side = ofw.RULE.rules[k].side; const done = res[k].trades.filter((t) => t.status === "DONE");
      for (const t of done) T.push({ member: k === "SB" ? "SB short build-up" : "LU long-unwinding bounce", sym: t.symbol, side, entryDay: t.entryDate, exitDay: t.exitDate });
      log(` ${k}: ${done.length} trades`); } }
  // SD: springy dip, its own forward code from its first possible date
  { const sdm = require(path.join(ROOT, "api/_lib/springy-dip")); const res = sdm.forward({ sessions: data.sessions, stocks: data.stocks, rule: { ...sdm.RULE, start: "2020-10-01" } });
    const trades = (res.trades || res.springy?.trades || []).filter((t) => t.status === "DONE");
    for (const t of trades) T.push({ member: "SD springy dip", sym: t.symbol, side: 1, entryDay: t.entryDate, exitDay: t.exitDate });
    log(` springy dip: ${trades.length} trades`); }
  return T.filter((t) => after(t.entryDay));
}

if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  log(`GM GLOBAL TOURNAMENT, phase 1, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`);
  log("CHECKS:"); const ok51 = check51(log);
  if (!ok51) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECK 5.1 FAILED: real run refused.\n\n"); process.exit(1); }
  const data = load(); log(`DATA: ${data.sessions.length} sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}, ${data.stocks.length} stocks, futures OI for ${data.oi.size}`);
  const trades = members(data, log);
  // check 5.2: every member's trades re-dated to random sessions (same counts, sides, holds) -> at most 5% PASS
  { let s = 7 >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const shuffled = trades.map((t) => { const b = data.bySym.get(t.sym)?.bars; if (!b) return null; const i0 = data.idx.get(t.sym).get(t.entryDay), j0 = data.idx.get(t.sym).get(t.exitDay); if (i0 === undefined || j0 === undefined) return null;
      const h = j0 - i0; const lo = b.findIndex((x) => x.d >= "2020-10-01"); if (lo < 0 || b.length - h - lo <= 1) return null; const i = lo + Math.floor(rnd() * (b.length - h - lo)); return { ...t, entryDay: b[i].d, exitDay: b[i + h].d }; }).filter(Boolean);
    const nb = board(shuffled.map((t) => gm(t, data))); const passes = nb.filter((r) => r.verdict === "PASS").length; const tested = nb.filter((r) => r.verdict !== "NOT TESTABLE").length;
    log(` 5.2 re-dated null: ${passes} PASS of ${tested} members (at most ${Math.floor(0.05 * tested)} allowed): ${passes <= Math.floor(0.05 * tested) ? "PASSED" : "FAILED"}`);
    if (passes > Math.floor(0.05 * tested)) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECK 5.2 FAILED: real run refused.\n\n"); process.exit(1); } }
  if (process.argv.includes("--check")) { console.log("checks only"); process.exit(0); }
  const scored = trades.map((t) => gm(t, data)); const lb = board(scored);
  log(`\nLEADERBOARD (2020-10 .. ${data.sessions.at(-1)}), ranked by t of the equal-rupee monthly series. GM 20u = GM's own score in rupees, before GM's charges but after NSE futures charges:`);
  for (const r of lb) log(fmt(r));
  log(`\nPASS: ${lb.filter((r) => r.verdict === "PASS").map((r) => r.member).join(", ") || "none"}. PROMISING: ${lb.filter((r) => r.verdict === "PROMISING").map((r) => r.member).join(", ") || "none"}.`);
  const me = board(trades.map((t) => gm(t, data, { monthEnd: true }))); log("\nSENSITIVITY (calendar month-end instead of expiry), top 10 by t: " + me.slice(0, 10).map((r) => `${r.member} t ${r.t?.toFixed(2)}`).join("; "));
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); fs.writeFileSync(path.join(HERE, "leaderboard.json"), JSON.stringify(lb.map(({ g3, g4, sr, p, ...r }) => r), null, 1));
}
module.exports = { gm, board };
