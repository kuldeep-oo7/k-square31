"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): NIFTY gamma exposure, six members.
//   node study.js --synthetic        (the four checks; must pass before the real run)
//   node study.js                    (ONE real run; data from research/, restored by scripts/restore-research-data.sh)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const MEMBERS = ["M1-G1 momentum when short gamma (US convention)", "M2-G1 reversal when long gamma (US convention)", "V-G1 buy straddle when short gamma (US convention)",
  "M1-G2 momentum when short gamma (NSE split)", "M2-G2 reversal when long gamma (NSE split)", "V-G2 buy straddle when short gamma (NSE split)"];
const NOTIONAL = 500000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const phi = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

// ---- gamma exposure of day d: { callX, putX } = sum of gamma x OI x F^2 x 1% over strikes, expiries E > d
function exposure(optDay, F, d) {
  const rows = optDay?.idx?.NIFTY || []; let callX = 0, putX = 0, used = 0;
  for (const E of [...new Set(rows.map((r) => r[0]))].filter((e) => e > d).sort()) {
    const T = days(d, E) / 365; if (!(T > 0)) continue;
    const rs = rows.filter((r) => r[0] === E);
    const live = (K, t) => rs.find((r) => r[1] === K && r[2] === t && r[3] > 0);
    const strikes = [...new Set(rs.map((r) => r[1]))].filter((K) => live(K, "CE") && live(K, "PE"));
    if (!strikes.length) continue;
    const K0 = strikes.reduce((a, b) => (Math.abs(b - F) < Math.abs(a - F) ? b : a));
    const sig = (live(K0, "CE")[3] + live(K0, "PE")[3]) / (0.8 * F * Math.sqrt(T)); if (!(sig > 0)) continue;
    const sT = sig * Math.sqrt(T);
    for (const r of rs) { const K = r[1], oi = r[5]; if (!(oi > 0) || !(K > 0)) continue;
      const g = phi((Math.log(F / K) + sig * sig * T / 2) / sT) / (F * sT); const x = g * oi * F * F * 0.01;
      if (r[2] === "CE") callX += x; else if (r[2] === "PE") putX += x; }
    used += 1;
  }
  return used ? { callX, putX } : null;
}

// NSE's participant-wise OI file -> { CLIENT: {cl, pl, cs, ps}, TOTAL: {...}, ... } (index options, contracts)
function parsePart(text) {
  const lines = String(text).split(/\r?\n/); const hi = lines.findIndex((l) => /Client Type/.test(l)); if (hi < 0) return null;
  const head = lines[hi].split(",").map((h) => h.replace(/["\t]/g, "").trim()); const c = (n) => head.indexOf(n);
  const out = {}; for (const l of lines.slice(hi + 1)) { const f = l.split(",").map((x) => x.replace(/["\t]/g, "").trim()); if (!f[0]) continue;
    out[f[0].toUpperCase()] = { cl: +f[c("Option Index Call Long")], pl: +f[c("Option Index Put Long")], cs: +f[c("Option Index Call Short")], ps: +f[c("Option Index Put Short")] }; }
  return out.CLIENT && out.TOTAL && out.TOTAL.cl > 0 && out.TOTAL.pl > 0 ? out : null;
}

const futNet = (side, o, c, d) => { const q = Math.ceil(NOTIONAL / o); const ch = (s, p) => calculateNseFuturesCharges({ side: s, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
  const cost = side > 0 ? ch("BUY", o) + ch("SELL", c) : ch("SELL", o) + ch("BUY", c); return side * (c / o - 1) - cost / (o * q); };

// data: { sessions: [iso], opt(d) -> {idx:{NIFTY:[[E,K,CE|PE,close,settle,OI]]}}, fut(d) -> [[sym,kind,E,o,h,l,c,settle,oi,..]], part(d) -> parsePart object }
function run(data) {
  const S = data.sessions, trades = [], diag = { gexDays: 0, shortG1: 0, shortG2: 0, every: { mom: [], straddle: [] } };
  const niftyFut = (d) => (data.fut(d) || []).filter((r) => r[0] === "NIFTY" && r[1] === "IDX");
  const nearestAfter = (d, after) => niftyFut(d).filter((r) => r[2] > after).sort((a, b) => (a[2] < b[2] ? -1 : 1))[0];
  const contract = (d, E) => niftyFut(d).find((r) => r[2] === E);
  const add = (k, entryDay, signalDay, net) => { if (Number.isFinite(net)) trades.push({ member: MEMBERS[k], day: entryDay, signal: signalDay, net }); };
  const straddle = (d1, d2) => {
    const f1 = nearestAfter(d1, d1); const r1 = data.opt(d1)?.idx?.NIFTY || [], r2 = data.opt(d2)?.idx?.NIFTY || []; if (!f1 || !(f1[6] > 0)) return null;
    const E = [...new Set(r1.map((r) => r[0]))].filter((e) => e > d2).sort()[0]; if (!E) return null;
    const at = (rows, K, t) => rows.find((r) => r[0] === E && r[1] === K && r[2] === t);
    const strikes = [...new Set(r1.filter((r) => r[0] === E).map((r) => r[1]))].filter((K) => at(r1, K, "CE")?.[3] > 0 && at(r1, K, "PE")?.[3] > 0); if (!strikes.length) return null;
    const K = strikes.reduce((a, b) => (Math.abs(b - f1[6]) < Math.abs(a - f1[6]) ? b : a));
    const ce = at(r1, K, "CE")[3], pe = at(r1, K, "PE")[3];
    const exitOf = (t) => { const r = at(r2, K, t); return r ? (r[3] > 0 ? r[3] : r[4] > 0 ? r[4] : null) : null; };
    const cx = exitOf("CE"), px = exitOf("PE"); if (!(cx > 0) || !(px > 0)) return null;
    const qc = Math.max(1, Math.round(100000 / ce)), qp = Math.max(1, Math.round(100000 / pe));
    const c1 = roundTripCost({ entryPremium: ce, exitPremium: cx, quantity: qc }), c2 = roundTripCost({ entryPremium: pe, exitPremium: px, quantity: qp }); if (!c1 || !c2) return null;
    return (cx + px - ce - pe - (c1.totalCost / qc + c2.totalCost / qp)) / (ce + pe);
  };
  for (let i = 1; i + 2 < S.length; i += 1) {
    const d0 = S[i - 1], d = S[i], d1 = S[i + 1], d2 = S[i + 2];
    const fd = nearestAfter(d, d); if (!fd || !(fd[6] > 0)) continue;
    const ex = exposure(data.opt(d), fd[6], d), p = data.part(d); if (!ex || !p) continue;
    const fc = -(p.CLIENT.cl - p.CLIENT.cs) / p.TOTAL.cl, fp = -(p.CLIENT.pl - p.CLIENT.ps) / p.TOTAL.pl;
    const G = [ex.callX - ex.putX, fc * ex.callX + fp * ex.putX];
    diag.gexDays += 1; if (G[0] < 0) diag.shortG1 += 1; if (G[1] < 0) diag.shortG2 += 1; if (Math.sign(G[0]) === Math.sign(G[1])) diag.agree = (diag.agree || 0) + 1;
    // futures: the nearest contract after d+1, the same one on d-1, d and d+1
    const c = nearestAfter(d1, d1);
    if (c && c[3] > 0 && c[6] > 0) { const a = contract(d0, c[2]), b = contract(d, c[2]);
      if (a && b && a[6] > 0 && b[6] > 0 && b[6] !== a[6]) { const mom = Math.sign(b[6] / a[6] - 1);
        diag.every.mom.push({ day: d1, net: futNet(mom, c[3], c[6], d1) });
        G.forEach((g, j) => { if (g < 0) add(j * 3, d1, d, futNet(mom, c[3], c[6], d1)); if (g > 0) add(j * 3 + 1, d1, d, futNet(-mom, c[3], c[6], d1)); }); } }
    const st = straddle(d1, d2);
    if (st !== null) { diag.every.straddle.push({ day: d1, net: st }); G.forEach((g, j) => { if (g < 0) add(j * 3 + 2, d1, d, st); }); }
  }
  return { trades, diag };
}

// ---- PROTOCOL v2 scoring (as studies/audit-2026-10-04/rescore.js)
function nwT(x, lag = 3) { const n = x.length, m = x.reduce((a, b) => a + b, 0) / n; const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function monthly(ts) { const month = new Map(); for (const t of ts) { const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(t.net); }
  return [...month.keys()].sort().map((m) => (month.get(m).reduce((a, b) => a + b, 0) / month.get(m).length) * 100); }
function score(trades) {
  const rows = MEMBERS.map((k) => { const ts = trades.filter((t) => t.member === k); const series = monthly(ts);
    if (series.length < 24) return { k, months: series.length, trades: ts.length, verdict: "NOT TESTABLE" };
    const r = nwT(series); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
    return { k, months: series.length, trades: ts.length, meanPct: r.mean, t: r.t, sharpe, p: 1 - Phi(r.t), win: (100 * ts.filter((t) => t.net > 0).length) / ts.length,
      verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { const a = 0.05 / (N - i); r.holm = ok && r.p <= a; if (!r.holm) ok = false; });
    const srs = tested.map((r) => r.sharpe); const mSR = srs.reduce((a, b) => a + b, 0) / N; const vSR = N > 1 ? srs.reduce((a, b) => a + (b - mSR) ** 2, 0) / (N - 1) : 0;
    const g = 0.5772156649; const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const mid = (lo + hi) / 2; if (Phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
    const SR0 = Math.sqrt(vSR) * ((1 - g) * invPhi(1 - 1 / N) + g * invPhi(1 - 1 / (N * Math.E)));
    for (const r of tested) r.dsr = Phi((r.sharpe - SR0) * Math.sqrt(r.months / 12)); rows.SR0 = SR0; }
  return rows;
}
const fmt = (r) => `${r.k} | ${r.months} | ${r.trades} | ${r.meanPct === undefined ? "-" : (r.meanPct >= 0 ? "+" : "") + r.meanPct.toFixed(3) + "%"} | ${r.win === undefined ? "-" : r.win.toFixed(1) + "%"} | ${r.t === undefined ? "-" : r.t.toFixed(2)} | ${r.sharpe === undefined ? "-" : r.sharpe.toFixed(2)} | ${r.holm === undefined ? "-" : r.holm ? "yes" : "no"} | ${r.dsr === undefined ? "-" : r.dsr.toFixed(2)} | ${r.verdict}`;

// ---- synthetic market (checks only)
function synth(seed, plant) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const thursdays = sessions.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 4);
  const monthEnds = [...new Set(sessions.map((d) => d.slice(0, 7)))].map((m) => thursdays.filter((d) => d.startsWith(m)).pop()).filter(Boolean);
  const putHeavy = sessions.map(() => rnd() < 0.5); const px = []; let F = 15000, prevMove = 1;
  for (let i = 0; i < sessions.length; i += 1) {
    const mom = plant === "mom" && i >= 1 && putHeavy[i - 1] ? 0.004 * Math.sign(prevMove) : 0;
    const sd = plant === "vol" && i >= 2 && putHeavy[i - 2] ? 0.03 : 0.007;
    const o = F * (1 + 0.003 * gauss() * (sd / 0.007)); const c = o * (1 + mom + sd * gauss()); prevMove = c / F - 1; px.push({ o, c }); F = c; }
  const BS = (Fv, K, T, sig, t) => { const sT = sig * Math.sqrt(T), d1 = (Math.log(Fv / K) + sig * sig * T / 2) / sT, d2 = d1 - sT; const N = (x) => Phi(x); return t === "CE" ? Fv * N(d1) - K * N(d2) : K * N(-d2) - Fv * N(-d1); };
  const opt = new Map(), fut = new Map(), part = new Map();
  sessions.forEach((d, i) => { const Fc = px[i].c;
    fut.set(d, monthEnds.filter((e) => e >= d).slice(0, 2).map((E) => ["NIFTY", "IDX", E, px[i].o, 0, 0, Fc, Fc, 1e7, 0, 1e5]));
    const rows = []; for (const E of thursdays.filter((e) => e >= d).slice(0, 2)) { const T = Math.max(days(d, E), 0.5) / 365; const atm = Math.round(Fc / 50) * 50;
      for (let k = -20; k <= 20; k += 1) { const K = atm + 50 * k; for (const t of ["CE", "PE"]) { const heavy = (t === "PE") === putHeavy[i] ? 3 : 1; const pr = Math.max(0.05, BS(Fc, K, T, 0.14, t));
        rows.push([E, K, t, +pr.toFixed(2), +pr.toFixed(2), Math.round(heavy * 1e5 * Math.exp(-(((K - Fc) / (0.03 * Fc)) ** 2)) * (0.5 + rnd()))]); } } }
    opt.set(d, { idx: { NIFTY: rows } });
    const cl = 3e6 * (0.5 + rnd()), cs = 3e6 * (0.5 + rnd()), pl = 3e6 * (0.5 + rnd()), ps = 3e6 * (0.5 + rnd());
    part.set(d, { CLIENT: { cl, cs, pl, ps }, TOTAL: { cl: 6e6, cs: 6e6, pl: 6e6, ps: 6e6 } }); });
  return { sessions, opt: (d) => opt.get(d), fut: (d) => fut.get(d), part: (d) => part.get(d), _maps: { opt, fut, part } };
}

if (process.argv.includes("--synthetic")) {
  let ok = true; const say = (name, pass, detail) => { console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}  (${detail})`); if (!pass) ok = false; };
  const verdicts = (rows) => rows.map((r) => `${r.k.split(" ")[0]} ${r.verdict}${r.t !== undefined ? ` t ${r.t.toFixed(1)}` : ""}`).join(", ");
  const m = score(run(synth(11, "mom")).trades); say("1. planted momentum after G1 short-gamma days is found (M1-G1 PASS)", m[0].verdict === "PASS", verdicts(m));
  const v = score(run(synth(12, "vol")).trades); say("2. planted bigger moves after G1 short-gamma days are found (V-G1 PASS)", v[2].verdict === "PASS", verdicts(v));
  let worst = 0; for (const seed of [21, 22, 23]) { const n = score(run(synth(seed, null)).trades); const passes = n.filter((r) => r.verdict === "PASS").length; worst = Math.max(worst, passes); console.log(`      noise seed ${seed}: ${verdicts(n)}`); }
  say("3. noise: at most one chance PASS", worst <= 1, `most PASSes in one noise market: ${worst}`);
  const base = synth(31, null), cutI = 900, cut = base.sessions[cutI];
  const pert = synth(31, null); for (const d of pert.sessions.slice(cutI)) { pert._maps.fut.set(d, pert._maps.fut.get(d).map((r) => [...r.slice(0, 3), r[3] * 1.2, 0, 0, r[6] * 0.7, r[7] * 0.7, ...r.slice(8)]));
    pert._maps.opt.set(d, { idx: { NIFTY: pert._maps.opt.get(d).idx.NIFTY.map((r) => [r[0], r[1], r[2], r[3] * 3, r[4] * 3, r[5] * 5]) } }); pert._maps.part.set(d, { CLIENT: { cl: 1, cs: 9e6, pl: 9e6, ps: 1 }, TOTAL: { cl: 9e6, cs: 9e6, pl: 9e6, ps: 9e6 } }); }
  const early = (r) => r.trades.filter((t) => base.sessions.indexOf(t.signal) <= cutI - 3).map((t) => `${t.member}|${t.day}|${t.net.toFixed(10)}`).join("\n");
  const a = early(run(base)), b = early(run(pert)); say("4. no look-ahead: trades signalled 3+ sessions before the cut are identical after changing everything from the cut", a === b && a.length > 0, `${a.split("\n").length} trades compared, cut ${cut}`);
  console.log(ok ? "\nSYNTHETIC CHECKS: ALL PASS" : "\nSYNTHETIC CHECKS FAILED"); process.exit(ok ? 0 : 1);
}

// ---- the ONE real run
const R = process.env.K2_RESEARCH || path.join(ROOT, "research");
const OPT = process.env.K2_OPT_DIR || path.join(R, "families-2026-10-04", "nse-extra", "opt");
const FUT = process.env.K2_FUT_DIR || path.join(R, "orderflow-2026-10-03", "nse-fo", "fut");
const PART = process.env.K2_PART_DIR || path.join(R, "orderflow-2026-10-03", "nse-fo", "part");
const have = (dir, ext) => new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, 10)) : []);
const hO = have(OPT, ".json"), hF = have(FUT, ".json"), hP = have(PART, ".csv");
const sessions = [...hO].filter((d) => hF.has(d) && hP.has(d)).sort();
if (sessions.length < 500) { console.error(`too little data: ${sessions.length} sessions with all three files (restore with scripts/restore-research-data.sh)`); process.exit(3); }
const cache = (fn) => { const m = new Map(); return (d) => { if (m.has(d)) return m.get(d); if (m.size > 8) m.delete(m.keys().next().value); const v = fn(d); m.set(d, v); return v; }; };
const data = { sessions, opt: cache((d) => JSON.parse(fs.readFileSync(path.join(OPT, `${d}.json`), "utf8"))), fut: cache((d) => JSON.parse(fs.readFileSync(path.join(FUT, `${d}.json`), "utf8"))),
  part: cache((d) => parsePart(fs.readFileSync(path.join(PART, `${d}.csv`), "utf8"))) };
if (process.argv.includes("--coverage")) {   // inputs only, by year: computes no gamma exposure
  const by = {}; for (const d of sessions) { const y = d.slice(0, 4); const b = (by[y] ||= { sessions: 0, part: 0, opt: 0, fut: 0 }); b.sessions += 1;
    if (data.part(d)) b.part += 1; if ((data.opt(d)?.idx?.NIFTY || []).some((r) => r[0] > d)) b.opt += 1; if ((data.fut(d) || []).some((r) => r[0] === "NIFTY" && r[1] === "IDX" && r[2] > d)) b.fut += 1; }
  for (const [y, b] of Object.entries(by)) console.log(`${y}: ${b.sessions} sessions | participant file parsed ${b.part} | NIFTY options after the date ${b.opt} | NIFTY futures after the date ${b.fut}`);
  process.exit(0);
}
const res = run(data); const rows = score(res.trades);
const every = (xs) => { const s = monthly(xs); const r = nwT(s); return `${xs.length} trades, ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(3)}% a month-average trade, t ${r.t.toFixed(2)}`; };
const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`NIFTY GAMMA EXPOSURE -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); protocol v2`);
line(`Data: ${sessions.length} sessions with NSE options, futures and participant files, ${sessions[0]} .. ${sessions[sessions.length - 1]}; gamma exposure computed on ${res.diag.gexDays} days.`);
line(`Short gamma (GEX < 0): US convention on ${res.diag.shortG1} days (${((100 * res.diag.shortG1) / res.diag.gexDays).toFixed(1)}%), NSE split on ${res.diag.shortG2} days (${((100 * res.diag.shortG2) / res.diag.gexDays).toFixed(1)}%).`);
line(`The two conventions agree in sign on ${res.diag.agree || 0} of ${res.diag.gexDays} days (${((100 * (res.diag.agree || 0)) / res.diag.gexDays).toFixed(1)}%).`);
line(`DSR benchmark (expected best annual Sharpe of ${rows.filter((r) => r.verdict !== "NOT TESTABLE").length} skill-less trials): ${rows.SR0 === undefined ? "-" : rows.SR0.toFixed(2)}`);
line(`member | months | trades | mean/trade | winners | t (NW) | annual Sharpe | Holm | DSR | VERDICT`);
for (const r of rows) line(fmt(r));
line(`\nDiagnostics, every day regardless of GEX (no verdict): momentum ${every(res.diag.every.mom)}; straddle bought ${every(res.diag.every.straddle)}.`);
const pass = rows.filter((r) => r.verdict === "PASS"), prom = rows.filter((r) => r.verdict === "PROMISING");
line(`PASS (t >= 3): ${pass.map((r) => r.k).join("; ") || "none"}. PROMISING: ${prom.map((r) => r.k).join("; ") || "none"}.`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ rows, diag: { gexDays: res.diag.gexDays, shortG1: res.diag.shortG1, shortG2: res.diag.shortG2 } }, null, 1));
