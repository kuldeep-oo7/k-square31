"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the VIX lab, one batch, one run.
//   node run.js --checks   checks 5.1-5.3 only (5.3 needs the discovery data); nothing is scored
//   node run.js            the real run (RESULT.txt, result.json: summary rows only)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (fut/); K2_RESEARCH_DIR = a research/ tree
// (orderflow-2026-10-03/nse-fo/fut); K2_MACRO_IC = data-macro ind_close_all/ (India VIX and NIFTY 50 closes).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 500000, UNITS = 20, N_TRIALS = 385;
const DISC = ["2014-05-14", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"];
const MEMBERS = ["V1 fear spike", "V2 fear high", "V3 calm", "V4 variance premium"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: NIFTY futures per contract (the index lab's), India VIX and NIFTY 50 closes ----------
function loadFut(dirs) { const byDay = new Map();
  for (const [dir, lo, hi] of dirs) { if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) { const d = f.slice(0, 10); if (d < lo || d > hi) continue; const m = new Map();
      for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[1] !== "IDX" || r[0] !== "NIFTY" || r[2] < d) continue; const o = Number(r[3]), c = Number(r[6]); if (c > 0) m.set(r[2], { o: o > 0 ? o : null, c }); }
      if (m.size) byDay.set(d, m); } }
  return byDay; }
function loadIdx(dir) { const vix = new Map(), nifty = new Map(); if (!dir || !fs.existsSync(dir)) return { vix, nifty };
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) { const t = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/"/g, "").trim()));
    const ic = (t[0] || []).findIndex((x) => /Closing Index Value/i.test(x)); if (ic < 0) continue; const d = f.slice(0, 10);
    for (const r of t) { const name = (r[0] || "").toLowerCase(); if (name === "india vix" && +r[ic] > 0) vix.set(d, +r[ic]); if (/^(nifty 50|cnx nifty|s&p cnx nifty)$/.test(name) && +r[ic] > 0) nifty.set(d, +r[ic]); } }
  return { vix, nifty }; }
function market(S, byDay) {
  const near = (d) => { const m = byDay.get(d); if (!m) return null; const e = [...m.keys()].filter((x) => m.get(x).o > 0).sort()[0]; return e ? { e, o: m.get(e).o, c: m.get(e).c } : null; };
  const px = (d, e, k) => { const m = byDay.get(d); const v = m && m.get(e); return v ? v[k] : null; };
  return { S, byDay, near, px };
}
function hold(D, i0, i1, side) {   // the index lab's: open of session i0 to the close of session i1, rolling at an expiry
  const S = D.S; if (i0 < 1 || i1 >= S.length || i1 < i0) return null; const n = D.near(S[i0]); if (!n) return null; let e = n.e, px = n.o; const entry = px, q = Math.ceil(NOTIONAL / entry);
  let cost = charge(side > 0 ? "BUY" : "SELL", entry, q, S[i0]), value = 1;
  for (let k = i0; k <= i1; k += 1) { const c = D.px(S[k], e, "c"); if (!(c > 0)) return null;
    if (k === i1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]); break; }
    if (S[k] >= e) { const e2 = [...D.byDay.get(S[k]).keys()].filter((x) => x > e).sort()[0]; const c2 = e2 ? D.px(S[k], e2, "c") : null; if (!(c2 > 0)) return null;
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]) + charge(side > 0 ? "BUY" : "SELL", c2, q, S[k]); e = e2; px = c2; } }
  return { net: side * (value - 1) - cost / (entry * q), rup: side * (value - 1) * entry * UNITS };
}

// ---------- signals ----------
const rv20 = (closes) => { if (closes.length < 21) return null; const r = []; for (let k = 1; k < closes.length; k += 1) r.push(Math.log(closes[k] / closes[k - 1])); const m = mean(r); return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100; };
function trades(D, idx, from, to) {
  const S = D.S, T = new Map(MEMBERS.map((m) => [m, []])), v = S.map((d) => idx.vix.get(d) ?? null), n = S.map((d) => idx.nifty.get(d) ?? null), vp = S.map(() => null);
  for (let j = 20; j < S.length; j += 1) { const c = n.slice(j - 20, j + 1); if (v[j] !== null && c.every((x) => x > 0)) { const r = rv20(c); if (r !== null) vp[j] = v[j] - r; } }
  const prev = (arr, j) => { const h = []; for (let k = j - 250; k <= j - 1; k += 1) if (k >= 0 && arr[k] !== null) h.push(arr[k]); return h; };
  for (let j = 1; j + 1 < S.length; j += 1) { const i = j + 1; if (S[i] < from || S[i] > to || v[j] === null) continue;
    if (v[j - 1] !== null && v[j] / v[j - 1] - 1 >= 0.2) T.get(MEMBERS[0]).push({ i, len: 4, side: 1 });
    const h = prev(v, j); if (h.length >= 200) { if (v[j] >= Math.max(...h)) T.get(MEMBERS[1]).push({ i, len: 9, side: 1 }); if (v[j] <= Math.min(...h)) T.get(MEMBERS[2]).push({ i, len: 9, side: -1 }); }
    const hp = prev(vp, j); if (vp[j] !== null && hp.length >= 200) { const s = hp.slice().sort((a, b) => a - b); if (vp[j] >= s[Math.floor(0.8 * (s.length - 1))]) T.get(MEMBERS[3]).push({ i, len: 4, side: 1 }); } }
  return T;
}

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(D, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(); let n = 0, won = 0, sum = 0, rup = 0;
    for (const t of T.get(name) || []) { const v = hold(D, t.i, t.i + t.len, t.side); if (!v) continue; n += 1; sum += v.net; rup += v.rup; if (v.net > 0) won += 1; const k = D.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v.net * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, trades: n, months: s.length, verdict: "NOT TESTABLE", perTrade: n ? (100 * sum) / n : null, win: n ? (100 * won) / n : null };
    const m = mean(s), sd = sdv(s); return { name, trades: n, months: s.length, win: (100 * won) / n, perTrade: (100 * sum) / n, rupees: Math.round(rup), monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd,
      g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(21)} NOT TESTABLE (${r.months} months, ${r.trades} trades${r.perTrade !== null ? `, ${sgn(r.perTrade)}% a trade, won ${r.win.toFixed(0)}%` : ""})`
  : `${r.name.padEnd(21)} ${String(r.trades).padStart(4)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.perTrade)}% a trade | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ` | GM 20 units Rs ${r.rupees.toLocaleString("en-IN")}`));

// ---------- checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synth(seed, plant) {   // NIFTY futures and an India VIX path (2006-2020, VIX jumps on 5% of days); with plant, NIFTY gains 1% over the 5 sessions after a VIX jump >= 20%
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const S = []; for (let t = Date.parse("2006-01-02"); t < Date.parse("2020-10-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const exp = new Map(); S.forEach((d, i) => { if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) exp.set(d.slice(0, 7), d); });
  const byDay = new Map(), vix = new Map(), nifty = new Map(); let lvl = 8000, vx = 15, boost = 0;
  for (const d of S) { const o = lvl * (1 + 0.001 * g()), c = o * (1 + (boost > 0 ? 0.002 : 0) + 0.006 * g()); boost = Math.max(0, boost - 1);
    const e1 = exp.get(d.slice(0, 7)), nm = new Date(`${d.slice(0, 7)}-15T00:00:00Z`); nm.setUTCMonth(nm.getUTCMonth() + 1);
    byDay.set(d, new Map([[e1, { o, c }], [exp.get(nm.toISOString().slice(0, 7)) || `${nm.toISOString().slice(0, 7)}-28`, { o: o * 1.003, c: c * 1.003 }]])); lvl = c; nifty.set(d, c);
    const jump = r() < 0.05; vx = Math.max(9, jump ? vx * 1.25 : vx * Math.exp(0.05 * g() - 0.02 * Math.log(vx / 15))); vix.set(d, vx); if (jump && plant) boost = 5; }
  return { D: market(S, byDay), idx: { vix, nifty } };
}
function check51(log) {
  const S = ["2026-01-05", "2026-01-06", "2026-01-07"], D = market(S, new Map()), T = trades({ ...D, S: [...S, "2026-01-08"] }, { vix: new Map([[S[0], 15], [S[1], 15], [S[2], 18.1]]), nifty: new Map() }, "0000", "9999");
  const spike = T.get(MEMBERS[0]).map((t) => t.i); const closes = [100]; for (let k = 0; k < 20; k += 1) closes.push(closes.at(-1) * (k % 2 ? 1.01 : 0.99));
  const lr = []; for (let k = 1; k < closes.length; k += 1) lr.push(Math.log(closes[k] / closes[k - 1])); const want = sdv(lr) * Math.sqrt(252) * 100;
  const ok = spike.length === 1 && spike[0] === 3 && Math.abs(rv20(closes) - want) < 1e-9;
  log(` 5.1 signals by hand: VIX 15, 15, 18.1 -> one fear spike, trading from the next session; realized volatility ${rv20(closes).toFixed(2)}: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function check52(log) { const { D, idx } = synth(52, true), r = score(D, trades(D, idx, "2006-01-02", "2020-10-31")).find((x) => x.name === MEMBERS[0]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 5.2 planted (+1% over the 5 sessions after a VIX jump): V1 ${r.trades} trades, t ${r.t !== undefined ? r.t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check53(D, T, log) { const r = rng(53), lo = 30, hi = D.S.length - 15; const R = new Map(); for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, i: lo + Math.floor(r() * (hi - lo)) })));
  const rows = score(D, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 5.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`VIX LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!check52(log)) refuse("CHECK 5.2 FAILED");
  const oos = path.join(path.resolve(process.env.K2_OOS_NSE || "nse-old"), "fut"), res = path.join(path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research")), "orderflow-2026-10-03", "nse-fo", "fut"), ic = process.env.K2_MACRO_IC;
  for (const d of [oos, res, ic]) if (!d || !fs.existsSync(d) || !fs.readdirSync(d).length) { console.error(`MISSING INPUT ${d}: nothing computed.`); process.exit(3); }
  const idx = loadIdx(ic); const mk = (dirs) => { const by = loadFut(dirs); return market([...by.keys()].sort(), by); };
  const D = mk([[oos, "2013-01-01", DISC[1]]]), TD = trades(D, idx, DISC[0], DISC[1]);
  log(`DISCOVERY DATA: ${D.S.length} sessions ${D.S[0]} .. ${D.S.at(-1)}, VIX on ${idx.vix.size} days from ${[...idx.vix.keys()].sort()[0]}; trades: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${TD.get(m).length}`).join(", "));
  if (!check53(D, TD, log)) refuse("CHECK 5.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const F = mk([[oos, "2019-06-01", "2020-08-31"], [res, "2020-09-01", CONF[1]]]), TF = trades(F, idx, CONF[0], CONF[1]);
  log(`CONFIRMATION DATA: ${F.S.length} sessions ${F.S[0]} .. ${F.S.at(-1)}; trades: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${TF.get(m).length}`).join(", "));
  const rd = score(D, TD), rf = score(F, TF);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (NIFTY near-month future; monthly mean of net %; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, trades, score, synth, rv20, check51, check52 };
