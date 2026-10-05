"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic   (code checks; no real data)
//   node study.js               (the one real run; refused if the registration changed or the checks fail)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const MEMBERS = ["IC1 fixed 2%/4% iron condor", "IC2 market-range condor (short +-M, long +-2M)", "IC3 IC2 + volatility-clustering brake"];
const QTY = 75, SLIP = 0.25, SR0 = 2.05;
const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : "after");
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const legCost = (prem, intrinsic, costs) => { if (!costs) return 0; const r = roundTripCost({ entryPremium: prem, exitPremium: Math.max(intrinsic, 0.05), quantity: QTY }); return r ? r.totalCost / QTY + SLIP : null; };

// data: { nifty: Map(d -> close), sessions: [d...] sorted, opt: Map(d -> [[exp, K, typ, close, settle, oi]]), expiries: [E...] sorted, costs: bool }
function run(data) {
  const trades = []; const extra = [];
  const nd = data.sessions.filter((d) => data.nifty.has(d));
  const idx = new Map(nd.map((d, i) => [d, i]));
  const rv = (d, n) => { const i = idx.get(d); if (i === undefined || i < n) return null; const r = []; for (let k = i - n + 1; k <= i; k += 1) r.push(Math.log(data.nifty.get(nd[k]) / data.nifty.get(nd[k - 1]))); const m = r.reduce((a, b) => a + b, 0) / n; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) * 252); };
  let prevE = "0000";
  for (const E of data.expiries) {
    const d = nd.find((x) => x > prevE && days(x, E) >= 4 && days(x, E) <= 10 && data.opt.get(x)?.length); prevE = E;
    if (!d || !data.nifty.has(E) || E <= d) continue;
    const S = data.nifty.get(d), SE = data.nifty.get(E);
    const rows = data.opt.get(d).filter((r) => r[0] === E && r[3] > 0);
    const price = new Map(rows.map((r) => [`${r[1]}${r[2]}`, r[3]]));
    const ks = (typ) => [...new Set(rows.filter((r) => r[2] === typ).map((r) => r[1]))];
    const kCE = ks("CE"), kPE = ks("PE"); if (!kCE.length || !kPE.length) continue;
    const nearest = (list, x) => list.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
    const atmBoth = kCE.filter((k) => price.has(`${k}PE`)); if (!atmBoth.length) continue;
    const ka = nearest(atmBoth, S), M = price.get(`${ka}CE`) + price.get(`${ka}PE`);
    const condor = (sc, sp, lc, lp) => {
      const KsC = nearest(kCE, sc), KsP = nearest(kPE, sp), KlC = nearest(kCE, lc), KlP = nearest(kPE, lp);
      if (!(KlC > KsC) || !(KlP < KsP)) return null;
      const p = [price.get(`${KsC}CE`), price.get(`${KsP}PE`), price.get(`${KlC}CE`), price.get(`${KlP}PE`)];
      const iv = [Math.max(SE - KsC, 0), Math.max(KsP - SE, 0), Math.max(SE - KlC, 0), Math.max(KlP - SE, 0)];
      const c = p.map((x, j) => legCost(x, iv[j], data.costs)); if (c.some((x) => x === null)) return null;
      const credit = p[0] + p[1] - p[2] - p[3], loss = iv[0] + iv[1] - iv[2] - iv[3], cost = c.reduce((a, b) => a + b, 0);
      const pnl = credit - loss - cost, maxRisk = Math.max(KlC - KsC, KsP - KlP) - credit;
      return { net: pnl / S, onRisk: maxRisk > 0 ? pnl / maxRisk : null, credit, strikes: [KlP, KsP, KsC, KlC] };
    };
    const add = (m, r) => { if (r) trades.push({ member: MEMBERS[m], day: d, expiry: E, ...r }); };
    add(0, condor(S * 1.02, S * 0.98, S * 1.04, S * 0.96));
    const ic2 = condor(S + M, S - M, S + 2 * M, S - 2 * M); add(1, ic2);
    const r5 = rv(d, 5), r60 = rv(d, 60); if (r5 !== null && r60 !== null && !(r5 > 1.5 * r60)) add(2, ic2);
    // comparison only: naked 2% strangle with the same costs
    const KsC = nearest(kCE, S * 1.02), KsP = nearest(kPE, S * 0.98); const a = price.get(`${KsC}CE`), b = price.get(`${KsP}PE`);
    const c1 = legCost(a, Math.max(SE - KsC, 0), data.costs), c2 = legCost(b, Math.max(KsP - SE, 0), data.costs);
    if (c1 !== null && c2 !== null) extra.push({ member: "V2 naked 2% strangle (comparison)", day: d, net: (a + b - Math.max(SE - KsC, 0) - Math.max(KsP - SE, 0) - c1 - c2) / S });
  }
  return { trades, extra };
}

// ---------- score (protocol v2) ----------
function nwT(x, lag = 3) { const n = x.length, m = x.reduce((a, b) => a + b, 0) / n; const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); }
  return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function score(ts) {
  const month = new Map(); for (const t of ts) { const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(t.net * 100); }
  const keys = [...month.keys()].sort(); const series = keys.map((m) => month.get(m).reduce((a, b) => a + b, 0) / month.get(m).length);
  const base = { trades: ts.length, months: series.length, winPct: ts.length ? 100 * ts.filter((t) => t.net > 0).length / ts.length : null,
    worstWeekPct: ts.length ? Math.min(...ts.map((t) => t.net * 100)) : null, worstMonthPct: series.length ? Math.min(...series) : null,
    meanOnRiskPct: ts.some((t) => t.onRisk != null) ? 100 * ts.filter((t) => t.onRisk != null).reduce((a, t) => a + t.onRisk, 0) / ts.filter((t) => t.onRisk != null).length : null };
  if (series.length < 24) return { ...base, verdict: "NOT TESTABLE" };
  const r = nwT(series); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
  return { ...base, meanPct: r.mean, t: r.t, sharpe, p: 1 - Phi(r.t), dsr: Phi((sharpe - SR0) * Math.sqrt(series.length / 12)),
    verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" };
}
function verdicts(trades) {
  const out = {}; for (const m of MEMBERS) out[m] = score(trades.filter((t) => t.member === m));
  const tested = MEMBERS.filter((m) => out[m].verdict !== "NOT TESTABLE").sort((a, b) => out[a].p - out[b].p); let ok = true;
  tested.forEach((m, i) => { const a = 0.05 / (tested.length - i); out[m].holm = ok && out[m].p <= a; if (!out[m].holm) ok = false; });
  return out;
}

// ---------- synthetic market (Black-Scholes prices on a 50-point grid) ----------
function synthetic(seed, { ivMult = 1, costs = false } = {}) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const N = (x) => Phi(x);
  const bs = (S, K, T, v, typ) => { const d1 = (Math.log(S / K) + 0.5 * v * v * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T); return typ === "CE" ? S * N(d1) - K * N(d2) : K * N(-d2) - S * N(-d1); };
  const sessions = []; for (let t = Date.parse("2020-01-01"); sessions.length < 1600; t += 86400000) { const dd = new Date(t); if (dd.getUTCDay() > 0 && dd.getUTCDay() < 6) sessions.push(dd.toISOString().slice(0, 10)); }
  const expiries = sessions.filter((d) => new Date(d).getUTCDay() === 4);
  const nifty = new Map(), opt = new Map(); let n = 15000;
  sessions.forEach((d, i) => { const vol = Math.floor(i / 60) % 2 === 0 ? 0.12 : 0.22; n *= Math.exp(vol / Math.sqrt(252) * gauss() - 0.5 * vol * vol / 252); nifty.set(d, n);
    const rows = []; for (const E of expiries.filter((e) => e > d).slice(0, 2)) { const T = days(d, E) / 365; const v = vol * ivMult;
      for (let K = Math.round(n * 0.85 / 50) * 50; K <= n * 1.15; K += 50) for (const typ of ["CE", "PE"]) { const p = Math.round(bs(n, K, T, v, typ) * 20) / 20; rows.push([E, K, typ, p, p, 1]); } }
    opt.set(d, rows); });
  return { nifty, sessions, opt, expiries, costs };
}

const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (o) => (o.trades ? `${o.meanPct === undefined ? "" : `${o.meanPct >= 0 ? "+" : ""}${o.meanPct.toFixed(3)}%/wk t ${o.t.toFixed(2)} Sharpe ${o.sharpe.toFixed(2)} `}win ${o.winPct.toFixed(0)}% worst week ${o.worstWeekPct.toFixed(2)}% worst month ${o.worstMonthPct.toFixed(2)}% (${o.trades} trades, ${o.months} months)` : "no trades");

function checks() {
  const a = verdicts(run(synthetic(7, { ivMult: 1.3 })).trades)[MEMBERS[0]];
  line(`(1) planted premium, IC1: ${fmt(a)}`); const ok1 = a.meanPct > 0 && a.t > 2;
  let passes = 0; for (let k = 1; k <= 3; k += 1) { const v = verdicts(run(synthetic(k * 7919, { ivMult: 1 })).trades); for (const [nm, o] of Object.entries(v)) if (o.verdict === "PASS") { passes += 1; line(`    noise PASS: ${nm} ${fmt(o)}`); } }
  line(`(2) 3 fair-priced markets x 3 members, zero costs: ${passes} PASS (want <= 1)`);
  const base = synthetic(31, {}); const cut = base.sessions[1100];
  const A = run(base).trades.filter((x) => x.expiry < cut);
  for (const d of base.sessions) if (d >= cut) { base.nifty.set(d, base.nifty.get(d) * 0.7); base.opt.set(d, base.opt.get(d).map((r) => [r[0], r[1], r[2], r[3] * 3 + 1, r[4], r[5]])); }
  const B = run(base).trades.filter((x) => x.expiry < cut);
  const key = (x) => `${x.member}|${x.day}|${x.net}`; const sa = A.map(key).sort(), sb = B.map(key).sort(); const same = sa.length === sb.length && sa.every((x, k) => x === sb[k]);
  line(`(3) changing every price from ${cut}: ${A.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  return ok1 && passes <= 1 && same && A.length > 100;
}

if (process.argv.includes("--synthetic")) process.exit(checks() ? 0 : 1);

// ---------- the one real run ----------
line(`CONDOR STUDY, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`);
line("CODE CHECKS (synthetic):"); if (!checks()) { line("CHECKS FAILED: real run refused."); process.exit(1); }
const R = path.join(ROOT, "research");
const niftyFile = process.env.K2_NIFTY || path.join(R, "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json");
const nifty = new Map(JSON.parse(fs.readFileSync(niftyFile, "utf8")).rows.map((r) => [r.date, r.close]));
const od = path.join(R, "families-2026-10-04", "nse-extra", "opt"); const opt = new Map();
for (const f of fs.readdirSync(od).filter((x) => x.endsWith(".json"))) opt.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(od, f), "utf8")).idx?.NIFTY || []);
const expiries = JSON.parse(fs.readFileSync(path.join(R, "situations-2026-09-29", "nifty-expiries-nse.json"), "utf8")).OPTIDX.slice().sort();
const sessions = [...new Set([...nifty.keys()])].sort();
const res = run({ nifty, sessions, opt, expiries, costs: true }); const v = verdicts(res.trades);
line(`\nREAL DATA: NIFTY ${sessions[0]} .. ${sessions.at(-1)}; ${res.trades.length} condor trades. Return = % of NIFTY a week, after charges + 1 point slippage a condor.`);
for (const m of MEMBERS) { const o = v[m];
  line(`${m}: ${fmt(o)} | on max risk ${o.meanOnRiskPct == null ? "-" : o.meanOnRiskPct.toFixed(2) + "%"}/trade | Holm ${o.holm ? "yes" : "no"} | DSR ${o.dsr == null ? "-" : o.dsr.toFixed(2)} | ${o.verdict}`);
  for (const w of ["development", "validation", "final"]) { const tw = res.trades.filter((t) => t.member === m && windowOf(t.day) === w); const mm = tw.length ? 100 * tw.reduce((a, t) => a + t.net, 0) / tw.length : null; line(`    ${w}: ${tw.length} trades, mean ${mm == null ? "-" : mm.toFixed(3) + "%"}`); } }
const cmp = score(res.extra); line(`\nComparison (not a member): V2 naked 2% strangle, same costs: ${fmt(cmp)}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v, comparison: cmp }, null, 1));
