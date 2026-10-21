"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256) with AMENDMENT-A1 and AMENDMENT-A2: every coded
// member, scored under GM's rules.
//   node run.js --check            checks 5.1, 5.3, 5.4, 5.5 and 5.2 only (no board)
//   node run.js --phase1           the 20 Oct interim phase-1 run, as it was (writes nothing new to the full board)
//   node run.js                    the full run (A1): every member, one board (appends to RESULT.txt, writes leaderboard-full.json)
// Data (laptop research/ or a restored copy): K2_RESEARCH_DIR (default ../../research). Extra inputs (A1/A2):
//   K2_SLB_DIR (NSE slb_openpos CSVs), K2_KR_FORECASTS (Kronos real-date forecasts CSV), K2_CM_PREDS (combined-model preds CSV).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const lfHash = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (lfHash("PREREGISTRATION.txt") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const SHA_A = ["AMENDMENT-A1", "AMENDMENT-A2"].map((a) => { const s = fs.readFileSync(path.join(HERE, `${a}.sha256`), "utf8").split(/\s+/)[0];
  if (lfHash(`${a}.txt`) !== s) { console.error(`${a} CHANGED; result void.`); process.exit(2); } return s; });
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const UNITS = 20, EQ_NOTIONAL = 500000, RESET = 0.18, EXTRA_TRIALS = 100;
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
const isoWeek = (d) => { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear(); const w1 = new Date(Date.UTC(y, 0, 4)); return `${y}-${Math.round(((t - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7) + 1}`; };

// ---------- the GM scorer ----------
// trade: { member, sym, side (+1/-1), entryDay, exitDay, entryPx?, exitPx? }; ctx: { bySym, idx: Map(sym -> Map(d -> i)), expiryFor(sym, d) -> ISO or null }
// A1 3a: a member that fills at its own price (a limit, a target, a stop) is scored at that price; an expiry cut exits at the cut session's close.
function gm(trade, ctx, { monthEnd = false } = {}) {
  const st = ctx.bySym.get(trade.sym); const ix = ctx.idx.get(trade.sym); if (!st || !ix) return null;
  const i = ix.get(trade.entryDay); let j = ix.get(trade.exitDay); if (i === undefined || j === undefined || j < i) return null;
  const jOwn = j; const b = st.bars;
  // GM auto-sells: at the stock's monthly futures expiry (judged) or the calendar month's last session (sensitivity)
  let cut = null;
  if (monthEnd) { let k = i; while (k + 1 < b.length && b[k + 1].d.slice(0, 7) === b[i].d.slice(0, 7)) k += 1; cut = k; }
  else { const e = ctx.expiryFor(trade.sym, trade.entryDay); if (e) { let k = i; while (k + 1 < b.length && b[k + 1].d <= e) k += 1; cut = k; } }
  if (cut !== null && cut < j) j = cut;
  for (let k = i + 1; k <= j; k += 1) if (Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) return { void: true };
  const entry = trade.entryPx > 0 ? trade.entryPx : b[i].o, exit = j === jOwn && trade.exitPx > 0 ? trade.exitPx : b[j].c; let gap = 0;
  for (let k = i + 1; k <= j; k += 1) if (isoWeek(b[k].d) !== isoWeek(b[k - 1].d)) gap += b[k].o - b[k - 1].c;
  const s = trade.side, sideIn = s > 0 ? "BUY" : "SELL", sideOut = s > 0 ? "SELL" : "BUY";
  const cost = (q) => charge(sideIn, entry, q, b[i].d) + charge(sideOut, exit, q, b[j].d);
  const qEq = Math.ceil(EQ_NOTIONAL / entry);
  const u20 = s * UNITS * (exit - entry) - cost(UNITS), eq = s * qEq * (exit - entry) - cost(qEq);
  return { member: trade.member, sym: trade.sym, side: s, entryDay: b[i].d, exitDay: b[j].d, cutByExpiry: j < jOwn, entry, exit,
    u20, u20g0: u20 - s * UNITS * gap, eq, eqg0: eq - s * qEq * gap, pct: (s * (exit / entry - 1) - cost(qEq) / (entry * qEq)) * 100 };
}

// ---------- statistics (protocol v2 + amendment A1 of the combined model) ----------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
function monthly(ts) { const month = new Map(); for (const t of ts) { const m = t.entryDay.slice(0, 7); month.set(m, (month.get(m) || 0) + t.eq / EQ_NOTIONAL * 100); } return [...month.keys()].sort().map((m) => month.get(m)); }
function board(scored) {
  const by = new Map(); for (const r of scored) { if (!r || r.void) continue; if (!by.has(r.member)) by.set(r.member, []); by.get(r.member).push(r); }
  const rows = [...by].map(([member, ts]) => { const s = monthly(ts); const r = { member, trades: ts.length, months: s.length,
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

// ---------- checks 5.1 and 5.3: hand-built trades ----------
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
function check53(log) {
  const days = ["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05", "2026-02-06"]; // Mon .. Fri
  const bars = [{ d: days[0], o: 100, c: 101 }, { d: days[1], o: 101, c: 102 }, { d: days[2], o: 102, c: 103 }, { d: days[3], o: 103, c: 104 }, { d: days[4], o: 104, c: 105 }];
  const mk = (exp) => ({ bySym: new Map([["X", { bars }]]), idx: new Map([["X", new Map(days.map((d, i) => [d, i]))]]), expiryFor: () => exp });
  const a = gm({ member: "T", sym: "X", side: 1, entryDay: days[0], exitDay: days[3], entryPx: 99.2, exitPx: 101.7 }, mk("2026-02-27"));
  const ca = charge("BUY", 99.2, 20, days[0]) + charge("SELL", 101.7, 20, days[3]);
  const b = gm({ member: "T", sym: "X", side: 1, entryDay: days[0], exitDay: days[4], entryPx: 99.2, exitPx: 108 }, mk("2026-02-04"));
  const cb = charge("BUY", 99.2, 20, days[0]) + charge("SELL", 103, 20, days[2]);
  const ok = Math.abs(a.u20 - (20 * 2.5 - ca)) < 1e-6 && !a.cutByExpiry && b.cutByExpiry && b.exitDay === days[2] && Math.abs(b.u20 - (20 * 3.8 - cb)) < 1e-6;
  log(` 5.3 limit 99.2 -> target 101.7: U20 ${a.u20.toFixed(2)} (expected ${(50 - ca).toFixed(2)}); cut by a Wed expiry before its target: exit at that close 103, U20 ${b.u20.toFixed(2)} (expected ${(76 - cb).toFixed(2)}): ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}

// ---------- data and members ----------
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
  // NIFTY members (A1 3b): NSE's NIFTY 50 open/close as a proxy for NIFTY futures, cut at NIFTY's monthly futures expiry
  const niftyRows = JSON.parse(fs.readFileSync(path.join(RS, "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json"), "utf8")).rows;
  const nb = niftyRows.filter((r) => r.open > 0 && r.close > 0).map((r) => ({ d: r.date, o: r.open, h: r.high, l: r.low, c: r.close })).sort((a, b) => (a.d < b.d ? -1 : 1));
  bySym.set("NIFTY", { id: "NIFTY", sym: "NIFTY", bars: nb }); idx.set("NIFTY", new Map(nb.map((b, i) => [b.d, i])));
  const exps = JSON.parse(fs.readFileSync(path.join(RS, "situations-2026-09-29", "nifty-expiries-nse.json"), "utf8")); const futIdx = exps.FUTIDX.slice().sort();
  const expiryFor = (sym, d) => (sym === "NIFTY" ? futIdx.find((e) => e >= d) || null : expOn.get(`${sym}|${d}`) || null);
  return { RS, sessions, stocks, bySym, idx, oi, expiryFor, niftyRows, exps };
}
function extData(data) {   // the inputs the phase-2 studies need, as studies/audit-2026-10-04/rescore.js reads them
  const R = data.RS;
  const readMap = (dir) => { const m = new Map(); if (!fs.existsSync(dir)) return m; for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) m.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); return m; };
  const niftyOHLC = new Map(data.niftyRows.map((r) => [r.date, { open: r.open, high: r.high, low: r.low, close: r.close }]));
  const niftyOC = new Map(data.niftyRows.map((r) => [r.date, { open: r.open, close: r.close }]));
  const fii = new Map(); for (const d of data.sessions) { const p = path.join(R, "orderflow-2026-10-03", "nse-fo", "part", `${d}.csv`); if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/); const head = lines.find((l) => /^Client Type/i.test(l)); const row = lines.find((l) => /^FII,/i.test(l)); if (!head || !row) continue;
    const h = head.split(",").map((x) => x.trim()), v = row.split(","); const L = +v[h.indexOf("Future Index Long")], S = +v[h.indexOf("Future Index Short")]; if (Number.isFinite(L) && Number.isFinite(S)) fii.set(d, L - S); }
  const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  const events = [], results = new Map(); const bmDir = path.join(R, "results-vrp-2026-10-04", "nse-board-meetings");
  for (const f of fs.readdirSync(bmDir)) for (const [sym, date, purpose] of JSON.parse(fs.readFileSync(path.join(bmDir, f), "utf8"))) { if (!/result/i.test(purpose || "")) continue;
    const [dd, mm, yy] = String(date).split("-"); if (!MON[(mm || "").toUpperCase()]) continue; const iso = `${yy}-${MON[mm.toUpperCase()]}-${dd.padStart(2, "0")}`;
    events.push({ sym, date: iso }); if (!results.has(sym)) results.set(sym, []); results.get(sym).push(iso); }
  return { niftyOHLC, niftyOC, fii, events, results, oi: data.oi, exps: data.exps,
    fut: readMap(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut")), deliv: readMap(path.join(R, "families-2026-10-04", "nse-extra", "deliv")), opt: readMap(path.join(R, "families-2026-10-04", "nse-extra", "opt")),
    industryFile: path.join(R, "industry-2026-10-04", "industries.json"), slbDir: process.env.K2_SLB_DIR || path.join(R, "nse-atlas", "slb_openpos"),
    krFile: process.env.K2_KR_FORECASTS || path.join(R, "fm-data-dated", "forecasts-kronos.csv"), cmPreds: process.env.K2_CM_PREDS || null };
}
function loadStudy(dir) { // a study's own run(), as studies/audit-2026-10-04/rescore.js loads it
  const src = fs.readFileSync(path.join(ROOT, "studies", dir, "study.js"), "utf8"); const cut = src.indexOf('if (process.argv.includes("--synthetic"))');
  const m = { exports: {} }; new Function("require", "module", "__dirname", "process", `${src.slice(0, cut).replace(/^"use strict";/, "")}\nmodule.exports = { run, MEMBERS: typeof MEMBERS === "undefined" ? null : MEMBERS };`)(require, m, path.join(ROOT, "studies", dir), process);
  return m.exports; }
function members(data, log) {   // phase 1, exactly as registered and run on 20 Oct
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
// A1 5.5: a member whose trades are >= 95% the same (symbol, side, entry, exit) as an EARLIER member's is a duplicate
function duplicates(trades, log) {
  const sets = new Map(); for (const t of trades) { if (!sets.has(t.member)) sets.set(t.member, new Set()); sets.get(t.member).add(`${t.sym}|${t.side}|${t.entryDay}|${t.exitDay}`); }
  const names = [...sets.keys()]; const dup = new Map();
  for (let a = 1; a < names.length; a += 1) for (let b = 0; b < a; b += 1) { const A = sets.get(names[a]), B = sets.get(names[b]); let n = 0; for (const k of A) if (B.has(k)) n += 1;
    if (A.size && n / A.size >= 0.95) { dup.set(names[a], { of: names[b], pct: (100 * n) / A.size }); break; } }
  log(` 5.5 duplicates (>= 95% the same trades as an earlier member): ${dup.size ? [...dup].map(([k, v]) => `${k} = ${v.of} (${v.pct.toFixed(1)}%)`).join("; ") : "none"}`);
  return dup;
}
function nullCheck(trades, data, log) {   // check 5.2: every member's trades re-dated to random sessions (same counts, sides, holds) -> at most 5% PASS
  let s = 7 >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffled = trades.map((t) => { const b = data.bySym.get(t.sym)?.bars; if (!b) return null; const i0 = data.idx.get(t.sym).get(t.entryDay), j0 = data.idx.get(t.sym).get(t.exitDay); if (i0 === undefined || j0 === undefined) return null;
    const h = j0 - i0; const lo = b.findIndex((x) => x.d >= "2020-10-01"); if (lo < 0 || b.length - h - lo <= 1) return null; const i = lo + Math.floor(rnd() * (b.length - h - lo)); return { ...t, entryPx: undefined, exitPx: undefined, entryDay: b[i].d, exitDay: b[i + h].d }; }).filter(Boolean);
  const nb = board(shuffled.map((t) => gm(t, data))); const passes = nb.filter((r) => r.verdict === "PASS").length; const tested = nb.filter((r) => r.verdict !== "NOT TESTABLE").length;
  log(` 5.2 re-dated null: ${passes} PASS of ${tested} members (at most ${Math.floor(0.05 * tested)} allowed): ${passes <= Math.floor(0.05 * tested) ? "PASSED" : "FAILED"}`);
  return passes <= Math.floor(0.05 * tested);
}

if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const phase1 = process.argv.includes("--phase1");
  log(`GM GLOBAL TOURNAMENT, ${phase1 ? "phase 1 (interim)" : "FULL BOARD (amendments A1, A2)"}, registration sha256 ${SHA}, A1 ${SHA_A[0]}, A2 ${SHA_A[1]} (verified), run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!phase1 && !check53(log)) refuse("CHECK 5.3 FAILED");
  const data = load(); log(`DATA: ${data.sessions.length} sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}, ${data.stocks.length} stocks, futures OI for ${data.oi.size}, NIFTY ${data.bySym.get("NIFTY").bars.length} sessions`);
  let trades = process.argv.includes("--replay-only") ? [] : members(data, log); let status = [];
  if (!phase1) { const more = require("./members2").more(data, extData(data), log); trades = trades.concat(more.trades); status = more.status; }
  if (process.argv.includes("--replay-only")) { console.log("replay checks only"); process.exit(0); }
  const dup = phase1 ? new Map() : duplicates(trades, log);
  if (!nullCheck(trades, data, log)) refuse("CHECK 5.2 FAILED");
  if (process.argv.includes("--check")) { console.log("checks only"); process.exit(0); }
  const scored = trades.map((t) => gm(t, data)); const dropped = new Map();
  scored.forEach((r, k) => { if (!r || r.void) { const m = trades[k].member; dropped.set(m, (dropped.get(m) || 0) + 1); } });
  const lb = board(scored); const { FITTED } = require("./members2");
  log(`\nLEADERBOARD (2020-10 .. ${data.sessions.at(-1)}; each member to the end of its own data), ranked by t of the equal-rupee monthly series. GM 20u = GM's own score in rupees, before GM's charges but after NSE futures charges:`);
  for (const r of lb) log(`${fmt(r)}${FITTED(r.member) ? " [FITTED]" : ""}${dup.has(r.member) ? ` [DUPLICATE of ${dup.get(r.member).of}]` : ""}${dropped.get(r.member) ? ` [${dropped.get(r.member)} dropped: no bars, reset or unscorable]` : ""}`);
  log(`\nPASS: ${lb.filter((r) => r.verdict === "PASS").map((r) => r.member).join(", ") || "none"}. PROMISING: ${lb.filter((r) => r.verdict === "PROMISING").map((r) => r.member).join(", ") || "none"}.`);
  if (!phase1) {
    // A1 2: fitted members on 2024-09-19 onward (the studies' validation + final windows), reported, not judged
    const late = new Map(); for (const r of scored) { if (!r || r.void || !FITTED(r.member) || r.entryDay < "2024-09-19") continue; if (!late.has(r.member)) late.set(r.member, []); late.get(r.member).push(r); }
    log("\nSENSITIVITY, fitted members on 2024-09-19 onward (not judged): " + [...late].map(([m, ts]) => { const s = monthly(ts); return `${m} ${ts.length} tr, t ${s.length >= 12 ? nwT(s).toFixed(2) : "-"}`; }).join("; "));
    const conf = lb.filter((r) => r.t !== undefined && !dup.has(r.member)).slice(0, 5).map((r) => r.member);
    log(`\nCONFIRMATION SET (A1 6, the 5 non-duplicate members with the highest EQ t): ${conf.join("; ")}`);
    log(`NOT SCORABLE: ${status.filter((x) => !x.ok).map((x) => x.m).join(", ") || "none"}; also momentum, published strategies (no run()); macro pod later.`);
  }
  const me = board(trades.map((t) => gm(t, data, { monthEnd: true }))); log("\nSENSITIVITY (calendar month-end instead of expiry), top 10 by t: " + me.slice(0, 10).map((r) => `${r.member} t ${r.t?.toFixed(2)}`).join("; "));
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  fs.writeFileSync(path.join(HERE, phase1 ? "leaderboard.json" : "leaderboard-full.json"), JSON.stringify(lb.map(({ g3, g4, sr, p, ...r }) => ({ ...r, fitted: FITTED_(r.member), duplicateOf: dup.get(r.member)?.of || null })), null, 1));
}
function FITTED_(m) { try { return require("./members2").FITTED(m); } catch { return false; } }
module.exports = { gm, board };
