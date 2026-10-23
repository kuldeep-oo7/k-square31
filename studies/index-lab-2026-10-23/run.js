"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the index lab, one batch, one run.
//   node run.js --checks   checks 5.1-5.3 only (5.3 needs the discovery data); nothing is scored
//   node run.js            the real run (RESULT.txt, result.json: summary rows only)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (fut/); K2_RESEARCH_DIR = a research/ tree
// (orderflow-2026-10-03/nse-fo/fut). NIFTY index futures rows only: [symbol, "IDX", expiry, open, high, low, close, settle, ...].
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 500000, UNITS = 20, N_TRIALS = 365;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"];
const MEMBERS = ["N1 overnight", "N2 intraday", "N3 turn of the month", "N4 expiry run-up", "N5 gap fade", "N6 big-drop bounce"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- NIFTY futures: per day, each contract's official open and close ----------
function load(dirs, from, to) {
  const byDay = new Map();
  for (const [dir, lo, hi] of dirs) { if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) { const d = f.slice(0, 10); if (d < lo || d > hi || d < from || d > to) continue; const m = new Map();
      for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[1] !== "IDX" || r[0] !== "NIFTY" || r[2] < d) continue; const o = Number(r[3]), c = Number(r[6]); if (c > 0) m.set(r[2], { o: o > 0 ? o : null, c }); }   // Number(null) is 0: never a price
      if (m.size) byDay.set(d, m); } }
  return market([...byDay.keys()].sort(), byDay);
}
function market(S, byDay) {
  const near = (d) => { const m = byDay.get(d); if (!m) return null; const e = [...m.keys()].filter((x) => m.get(x).o > 0).sort()[0]; return e ? { e, o: m.get(e).o, c: m.get(e).c } : null; };
  const px = (d, e, k) => { const m = byDay.get(d); const v = m && m.get(e); return v ? v[k] : null; };
  return { S, byDay, near, px, sIdx: new Map(S.map((d, i) => [d, i])) };
}
// a hold from the open (or close) of session i0 to the close of session i1, rolling at an expiry; null if a price is missing
function hold(D, i0, i1, side, startAt) {
  const S = D.S; if (i0 < 0 || i1 >= S.length || i1 < i0 || (startAt === "close" && i1 <= i0)) return null;
  let e, px; if (startAt === "open") { const n = D.near(S[i0]); if (!n) return null; e = n.e; px = n.o; }
  else { const n = D.near(S[i0 + 1]); if (!n) return null; e = n.e; px = D.px(S[i0], e, "c"); }
  if (!(px > 0)) return null; const entry = px, q = Math.ceil(NOTIONAL / entry); let cost = charge(side > 0 ? "BUY" : "SELL", entry, q, S[i0]), value = 1;
  for (let k = startAt === "open" ? i0 : i0 + 1; k <= i1; k += 1) { const c = D.px(S[k], e, "c"); if (!(c > 0)) return null;
    if (k === i1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]); break; }
    if (S[k] >= e) { const e2 = [...D.byDay.get(S[k]).keys()].filter((x) => x > e).sort()[0]; const c2 = e2 ? D.px(S[k], e2, "c") : null; if (!(c2 > 0)) return null;
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]) + charge(side > 0 ? "BUY" : "SELL", c2, q, S[k]); e = e2; px = c2; } }
  return { net: side * (value - 1) - cost / (entry * q), rup: side * (value - 1) * entry * UNITS };
}
function overnight(D, i) {   // the near-month contract of session i: its close on i-1 -> its open on i
  if (i < 1) return null; const n = D.near(D.S[i]); if (!n) return null; const c0 = D.px(D.S[i - 1], n.e, "c"); if (!(c0 > 0)) return null;
  const q = Math.ceil(NOTIONAL / c0); return { net: n.o / c0 - 1 - (charge("BUY", c0, q, D.S[i - 1]) + charge("SELL", n.o, q, D.S[i])) / (c0 * q), rup: (n.o - c0) * UNITS };
}
function prevMove(D, i, at) {   // the near-month contract of i: its open (at = "o") or close (at = "c") on i against its close on i-1
  if (i < 1) return null; const n = D.near(D.S[i]); if (!n) return null; const c0 = D.px(D.S[i - 1], n.e, "c"); return c0 > 0 ? n[at] / c0 - 1 : null;
}

// ---------- members: each trade is { date (entry), kind, i, ... } and is valued by value() ----------
function value(D, t) { if (t.kind === "on") return overnight(D, t.i); return hold(D, t.i, t.i + t.len, t.side, t.startAt); }
function trades(D, from, to) {
  const S = D.S, T = new Map(MEMBERS.map((m) => [m, []])), inS = (i) => i >= 0 && i < S.length && S[i] >= from && S[i] <= to, add = (m, t) => { if (inS(t.i)) T.get(m).push(t); };
  for (let i = 1; i < S.length; i += 1) { add(MEMBERS[0], { kind: "on", i }); add(MEMBERS[1], { kind: "hold", i, len: 0, side: 1, startAt: "open" }); }
  const lastOf = new Map(), firstOf = new Map(); S.forEach((d, i) => { lastOf.set(d.slice(0, 7), i); if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()].sort();
  for (let k = 0; k + 1 < months.length; k += 1) { const a = lastOf.get(months[k]) - 1, b = firstOf.get(months[k + 1]) + 2; if (a >= firstOf.get(months[k]) && b <= lastOf.get(months[k + 1])) add(MEMBERS[2], { kind: "hold", i: a, len: b - a, side: 1, startAt: "close" }); }
  const expiries = new Set(); for (const [, m] of D.byDay) for (const e of m.keys()) expiries.add(e);
  for (const e of [...expiries].sort()) { const iE = D.sIdx.get(e); if (iE === undefined || iE < 4) continue; add(MEMBERS[3], { kind: "hold", i: iE - 4, len: 4, side: 1, startAt: "close" }); }
  for (let i = 1; i < S.length; i += 1) { const g = prevMove(D, i, "o"); if (g !== null && Math.abs(g) >= 0.005) add(MEMBERS[4], { kind: "hold", i, len: 0, side: g > 0 ? -1 : 1, startAt: "open" });
    const m = prevMove(D, i, "c"); if (m !== null && m <= -0.02) add(MEMBERS[5], { kind: "hold", i: i + 1, len: 4, side: 1, startAt: "open" }); }
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
    for (const t of T.get(name) || []) { const v = value(D, t); if (!v) continue; n += 1; sum += v.net; rup += v.rup; if (v.net > 0) won += 1; const k = D.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v.net * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, trades: n, months: s.length, verdict: "NOT TESTABLE" };
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
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(22)} NOT TESTABLE (${r.months} months, ${r.trades} trades)`
  : `${r.name.padEnd(22)} ${String(r.trades).padStart(5)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.perTrade)}% a trade | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ` | GM 20 units Rs ${r.rupees.toLocaleString("en-IN")}`));

// ---------- checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function check51(log) {
  const S = ["2026-01-23", "2026-01-26", "2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30"], byDay = new Map();
  S.forEach((d, k) => byDay.set(d, new Map([...(d <= "2026-01-27" ? [["2026-01-27", { o: 99 + k, c: 100 + k }]] : []), ["2026-02-24", { o: 100 + k, c: 101 + k }]])));
  const D = market(S, byDay), q = Math.ceil(500000 / 100);
  const on = overnight(D, 1), wantOn = 100 / 100 - 1 - (charge("BUY", 100, q, S[0]) + charge("SELL", 100, q, S[1])) / (100 * q);   // contract 27 Jan: close 100 on 23 Jan -> open 100 on 26 Jan
  const h = hold(D, 0, 4, 1, "open"), q2 = Math.ceil(500000 / 99), v = (102 / 99) * (105 / 103);   // open 99 (23 Jan) -> 27 Jan close 102, roll into Feb at 103 -> 29 Jan close 105
  const wantH = v - 1 - (charge("BUY", 99, q2, S[0]) + charge("SELL", 102, q2, S[2]) + charge("BUY", 103, q2, S[2]) + charge("SELL", 105, q2, S[4])) / (99 * q2);
  const ok = Math.abs(on.net - wantOn) < 1e-12 && Math.abs(h.net - wantH) < 1e-12;
  log(` 5.1 pricing by hand: overnight ${(on.net * 100).toFixed(3)}%; a 5-session hold across the 27 Jan expiry chains two contracts with one roll ${(h.net * 100).toFixed(3)}%: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function synth(seed) {   // NIFTY futures with +0.10% planted in every overnight move; monthly contracts, the next month 0.3% above
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const S = []; for (let t = Date.parse("2008-01-01"); t < Date.parse("2020-10-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const exp = new Map(); S.forEach((d, i) => { if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) exp.set(d.slice(0, 7), d); });
  const byDay = new Map(); let lvl = 5000;
  S.forEach((d) => { const o = lvl * (1 + 0.001 + 0.006 * g()), c = o * (1 + 0.01 * g()); const e1 = exp.get(d.slice(0, 7)); const nm = new Date(`${d.slice(0, 7)}-15T00:00:00Z`); nm.setUTCMonth(nm.getUTCMonth() + 1);
    const e2 = exp.get(nm.toISOString().slice(0, 7)) || `${nm.toISOString().slice(0, 7)}-28`; byDay.set(d, new Map([[e1, { o, c }], [e2, { o: o * 1.003, c: c * 1.003 }]])); lvl = c; });
  return market(S, byDay);
}
function check52(log) { const D = synth(52), r = score(D, trades(D, "2008-01-01", "2020-10-31")).find((x) => x.name === MEMBERS[0]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 5.2 planted overnight drift (+0.10% a night): N1 t ${r.t.toFixed(2)}, ${sgn(r.perTrade)}% a trade: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check53(D, T, log) { const r = rng(53), lo = 30, hi = D.S.length - 30; const R = new Map(); for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, i: lo + Math.floor(r() * (hi - lo)) })));
  const rows = score(D, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 5.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`INDEX LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!check52(log)) refuse("CHECK 5.2 FAILED");
  const oos = path.join(path.resolve(process.env.K2_OOS_NSE || "nse-old"), "fut"), res = path.join(path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research")), "orderflow-2026-10-03", "nse-fo", "fut");
  for (const d of [oos, res]) if (!fs.existsSync(d) || !fs.readdirSync(d).length) { console.error(`MISSING INPUT ${d}: nothing computed.`); process.exit(3); }
  const D = load([[oos, "0000", "9999"]], DISC[0], DISC[1]), TD = trades(D, DISC[0], DISC[1]);
  log(`DISCOVERY DATA: ${D.S.length} sessions ${D.S[0]} .. ${D.S.at(-1)}; trades: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${TD.get(m).length}`).join(", "));
  if (!check53(D, TD, log)) refuse("CHECK 5.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const F = load([[res, "2020-09-01", "9999"]], "2020-09-01", CONF[1]), TF = trades(F, CONF[0], CONF[1]);
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
module.exports = { MEMBERS, load, market, hold, overnight, trades, score, synth, check51, check52 };
