"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic                         code checks, no real data
//   K2_OOS_DIR=<dir with nse-old/ and us/> node study.js    the one real run (both markets, then the verdicts)
// Each market runs in its own process (--market nse|us) so the US charge replacement never touches NSE.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const US_RATE = 0.0005, START = "2005-01-01";
const LAST = { nse: "2020-08-31", us: "2026-09-15" };
const PERIODS = { nse: [["2005-09", "2005-01", "2009-12"], ["2010-14", "2010-01", "2014-12"], ["2015-20", "2015-01", "2020-12"]],
  us: [["2005-09", "2005-01", "2009-12"], ["2010-14", "2010-01", "2014-12"], ["2015-19", "2015-01", "2019-12"], ["2020-26", "2020-01", "2026-12"]] };
const CRASH = [["2008 crash", "2008-01", "2009-03"], ["2020 COVID", "2020-02", "2020-04"]];

function patchUsCharges() { // must run before any rule module is required
  const sb = require(path.join(ROOT, "api/_lib/shadow-broker"));
  sb.calculateNseFuturesCharges = ({ price, quantity }) => { const t = (Number(price) || 0) * (Number(quantity) || 0); return { turnover: t, totalCharges: t * US_RATE }; };
  return sb;
}
const mods = () => ({ sd: require(path.join(ROOT, "api/_lib/springy-dip")), oi: require(path.join(ROOT, "api/_lib/oi-flow-forward")),
  v2: require(path.join(ROOT, "api/_lib/forward-v2")), v3: require(path.join(ROOT, "api/_lib/forward-v3")) });

// ---------- the rules -> scored trades {rule, d, v} ----------
function trades(m, data, which, last) {
  const out = []; const add = (rule, d, v) => { if (d && d >= START && d <= last && Number.isFinite(v)) out.push({ rule, d, v }); };
  const done = (xs) => xs.filter((t) => t.status === "DONE");
  if (which.includes("SD")) for (const t of done(m.sd.forward({ sessions: data.sessions, stocks: data.stocks, rule: { ...m.sd.RULE, start: START } }).trades)) add("SD", t.entryDate, t.netPct);
  if (which.includes("LU") || which.includes("SB")) { const r = m.oi.forward({ sessions: data.sessions, stocks: data.stocks, oi: data.oi, rule: { ...m.oi.RULE, start: START } });
    for (const k of ["LU", "SB"]) if (which.includes(k)) for (const t of done(r[k].trades)) add(k, t.entryDate, t.netPct); }
  if (which.includes("STRANGLE")) for (const t of done(m.v2.strangle({ sessions: data.sessions, niftyClose: data.niftyClose, opt: data.opt, start: START }).trades)) add("STRANGLE", t.entryDate, t.netPct);
  if (which.includes("MA150A") || which.includes("MA150B")) { const r = m.v2.maCross({ sessions: data.sessions, stocks: data.stocks, start: START });
    for (const k of ["A", "B"]) if (which.includes(`MA150${k}`)) for (const t of done(r[k].trades)) add(`MA150${k}`, t.entryDate, t.excessPct); }
  const ctx = (which.includes("CHEAPVOL") || which.includes("INDREV")) ? m.v3.context({ sessions: data.sessions, stocks: data.stocks }) : null;
  if (which.includes("CHEAPVOL")) for (const t of done(m.v3.cheapVol({ sessions: data.sessions, stocks: data.stocks, sopt: data.sopt, start: START, ctx }).trades)) add("CHEAPVOL", t.entryDate, t.netPct);
  if (which.includes("INDREV")) for (const r of done(m.v3.indRev({ sessions: data.sessions, stocks: data.stocks, industry: data.industry, start: START, ctx }).rebalances)) add("INDREV", r.date, r.netPct);
  return out;
}

// ---------- statistics ----------
function nwT(x, lag = 3) { const n = x.length, m = x.reduce((a, b) => a + b, 0) / n; const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function score(ts, market) {
  const month = new Map(); for (const t of ts) { const k = t.d.slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(t.v); }
  const keys = [...month.keys()].sort(); const series = keys.map((k) => meanOf(month.get(k)));
  const inRange = (a, b) => ts.filter((t) => t.d.slice(0, 7) >= a && t.d.slice(0, 7) <= b).map((t) => t.v);
  const o = { trades: ts.length, months: series.length, winPct: ts.length ? 100 * ts.filter((t) => t.v > 0).length / ts.length : null, worstMonth: series.length ? Math.min(...series) : null,
    periods: Object.fromEntries((PERIODS[market] || []).map(([n, a, b]) => { const x = inRange(a, b); return [n, { n: x.length, mean: meanOf(x) }]; })),
    crashes: Object.fromEntries(CRASH.map(([n, a, b]) => { const x = inRange(a, b); return [n, { n: x.length, mean: meanOf(x) }]; })) };
  if (series.length < 24) return { ...o, testable: false };
  const r = nwT(series); return { ...o, testable: true, mean: r.mean, t: r.t, p: 1 - Phi(r.t) };
}
function verdicts(results, alpha = 0.05, holm = true) { // results: [{key, ...score}]
  const tested = results.filter((r) => r.testable).sort((a, b) => a.p - b.p); let ok = true;
  tested.forEach((r, i) => { const a = holm ? alpha / (tested.length - i) : alpha; r.passHolm = ok && r.p <= a; if (holm && !r.passHolm) ok = false; });
  for (const r of results) r.verdict = !r.testable ? "NOT TESTABLE" : r.mean > 0 && r.passHolm ? (r.t >= 3 ? "STRONG" : "REPLICATED") : "FAILED";
  return results;
}

// ---------- synthetic markets ----------
function synthMarket(seed, { ar = 0, nStocks = 220, nDays = 1500 } = {}) {
  let a = seed; const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; // mulberry32 (an LCG put hidden serial correlation into the "random" walks)
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2005-01-03"); sessions.length < nDays; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const stocks = []; const industry = {};
  for (let k = 0; k < nStocks; k += 1) { let p = 100 + 50 * rnd(), r = 0; const vol = 0.012 + 0.01 * rnd(), size = 1e7 * (1 + 20 * rnd()); const bars = [];
    for (const d of sessions) { r = ar * r + vol * gauss(); const o = p * Math.exp(0.002 * gauss() - 0.000002); p = o * Math.exp(r - 0.5 * vol * vol / (1 - ar * ar)); bars.push({ d, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, val: size * (0.8 + 0.4 * rnd()) }); }
    stocks.push({ sym: `S${k}`, bars }); industry[`S${k}`] = `I${k % 12}`; }
  return { sessions, stocks, industry };
}
function checks(line) {
  const m = mods();
  const plant = score(trades(m, synthMarket(11, { ar: -0.15 }), ["SD"], "2099-12-31").filter((t) => t.rule === "SD"), "nse");
  line(`(1) planted mean reversion, SD: mean ${plant.mean?.toFixed(3)}% t ${plant.t?.toFixed(2)} (${plant.trades} trades)`); const ok1 = plant.mean > 0 && plant.t > 2;
  let passes = 0; for (let q = 1; q <= 12; q += 1) { const seed = q * 1009; const ts = trades(m, synthMarket(seed), ["SD", "MA150A", "MA150B"], "2099-12-31");
    const rs = verdicts(["SD", "MA150A", "MA150B"].map((k) => ({ key: k, ...score(ts.filter((t) => t.rule === k), "nse") })), 0.05, false);
    for (const r of rs) if (r.verdict !== "FAILED" && r.verdict !== "NOT TESTABLE") { passes += 1; line(`    noise pass: seed ${seed} ${r.key} mean ${r.mean.toFixed(3)} t ${r.t.toFixed(2)}`); } }
  line(`(2) 12 random-walk markets x SD, MA150A, MA150B: ${passes} of 36 REPLICATED at unadjusted 5% (want <= 4)`);
  const base = synthMarket(7, { ar: -0.1 }); const cut = base.sessions[1100], keep = base.sessions[1100 - 15];
  const A = trades(m, base, ["SD", "MA150A", "MA150B"], keep);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.3; b.c *= 0.6; b.h *= 1.3; b.l *= 0.6; }
  const B = trades(m, base, ["SD", "MA150A", "MA150B"], keep);
  const key = (x) => `${x.rule}|${x.d}|${x.v}`; const sa = A.map(key).sort(), sb = B.map(key).sort(); const same = sa.length > 50 && sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  line(`(3) changing every price from ${cut}: ${A.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  let ok4 = false; try { execFileSync(process.execPath, [__filename, "--patchcheck"], { stdio: "pipe" }); ok4 = true; } catch { ok4 = false; }
  line(`(4) US charge replacement = 0.05% of turnover: ${ok4 ? "yes" : "NO"}`);
  return ok1 && passes <= 4 && same && ok4;
}

// ---------- loading real data ----------
function loadNse(dir) {
  const { loadCm } = require(path.join(ROOT, "scripts/springy-dip-forward")); const { loadOi } = require(path.join(ROOT, "scripts/oi-flow-forward"));
  const { lazySopt, industryCheck } = require(path.join(ROOT, "scripts/forward-v3"));
  const data = loadCm(path.join(dir, "cm")); data.oi = loadOi(path.join(dir, "fut"));
  data.opt = new Map(); for (const f of fs.readdirSync(path.join(dir, "opt")).filter((x) => x.endsWith(".json"))) data.opt.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(dir, "opt", f), "utf8")));
  data.niftyClose = new Map(); let fb = 0;
  for (const d of data.sessions) { const f = path.join(dir, "idx", `${d}.json`);
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j["Nifty 50"] && j["Nifty 50"][3] > 0) { data.niftyClose.set(d, j["Nifty 50"][3]); continue; } }
    const ff = path.join(dir, "fut", `${d}.json`); if (!fs.existsSync(ff)) continue;
    const rows = JSON.parse(fs.readFileSync(ff, "utf8")).filter((r) => r[0] === "NIFTY" && r[1] === "IDX"); if (!rows.length) continue;
    const exp = rows.find((r) => r[2] === d); const near = rows.slice().sort((a, b) => (a[2] < b[2] ? -1 : 1))[0];
    const v = exp ? exp[7] : near[6]; if (v > 0) { data.niftyClose.set(d, v); fb += 1; } }
  data.niftyFallbacks = fb;
  data.sopt = lazySopt(path.join(dir, "sopt"));
  const ind = industryCheck(path.join(ROOT, "research", "industry-2026-10-04", "industries.json")); if (!ind.ok) throw new Error(`industry file: ${ind.reason}`); data.industry = ind.industry;
  return data;
}

if (process.env.K2_LIB) { module.exports = { trades, score, verdicts, synthMarket, mods }; return; }
if (process.argv.includes("--patchcheck")) { const sb = patchUsCharges(); const v = mods().sd; void v; process.exit(Math.abs(sb.calculateNseFuturesCharges({ side: "SELL", price: 200, quantity: 50 }).totalCharges - 5) < 1e-9 ? 0 : 1); }
if (process.argv.includes("--synthetic")) { const ok = checks(console.log); process.exit(ok ? 0 : 1); }

const market = arg("--market");
if (market) { // child: one market, writes trades + scores to a json
  const dir = path.resolve(process.env.K2_OOS_DIR || path.join(ROOT, "research", "oos")); let m, data, which, info = {};
  if (market === "us") { const sb = patchUsCharges(); const c = sb.calculateNseFuturesCharges({ side: "SELL", price: 200, quantity: 50 }).totalCharges; if (Math.abs(c - 200 * 50 * US_RATE) > 1e-9) throw new Error("US charge patch not applied");
    m = mods(); const { loadCm } = require(path.join(ROOT, "scripts/springy-dip-forward")); data = loadCm(path.join(dir, "us", "cm"));
    const ib = fs.readFileSync(path.join(dir, "us", "industries.json")); data.industry = JSON.parse(ib); info.industrySha256 = crypto.createHash("sha256").update(ib).digest("hex");
    which = ["SD", "MA150A", "MA150B", "INDREV"]; }
  else { m = mods(); data = loadNse(path.join(dir, "nse-old")); info.niftyFallbacks = data.niftyFallbacks; which = ["SD", "LU", "SB", "STRANGLE", "MA150A", "MA150B", "CHEAPVOL", "INDREV"]; }
  info.sessions = `${data.sessions[0]} .. ${data.sessions.at(-1)} (${data.sessions.length})`; info.stocks = data.stocks.length;
  const ts = trades(m, data, which, LAST[market]);
  const res = which.map((k) => ({ key: `${market.toUpperCase()} ${k}`, ...score(ts.filter((t) => t.rule === k), market) }));
  fs.writeFileSync(path.join(HERE, `scores-${market}.json`), JSON.stringify({ info, res }, null, 1));
  console.log(`${market}: ${ts.length} trades, ${JSON.stringify(info)}`); process.exit(0);
}

// parent: checks, both markets, verdicts
const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`OUT-OF-SAMPLE REPLICATION, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`);
line("CODE CHECKS (synthetic):"); if (!checks(line)) { line("CHECKS FAILED: real run refused."); process.exit(1); }
for (const mk of ["nse", "us"]) execFileSync(process.execPath, ["--max-old-space-size=12000", __filename, "--market", mk], { stdio: "inherit", env: process.env });
const parts = ["nse", "us"].map((mk) => JSON.parse(fs.readFileSync(path.join(HERE, `scores-${mk}.json`), "utf8")));
const all = verdicts(parts.flatMap((p) => p.res));
line(`\nNSE OLD data: ${JSON.stringify(parts[0].info)}`); line(`US data: ${JSON.stringify(parts[1].info)}`);
line(`\nrule | trades | months | mean/trade | t (NW) | win | worst month | Holm(12) | VERDICT`);
const f = (x, d = 3) => (x == null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
for (const r of all) {
  line(`${r.key} | ${r.trades} | ${r.months} | ${f(r.mean)}% | ${r.t == null ? "-" : r.t.toFixed(2)} | ${r.winPct == null ? "-" : r.winPct.toFixed(0)}% | ${f(r.worstMonth, 2)}% | ${r.passHolm ? "yes" : "no"} | ${r.verdict}`);
  line(`    periods: ${Object.entries(r.periods).map(([n, o]) => `${n} ${f(o.mean)}% (${o.n})`).join("; ")} | crashes: ${Object.entries(r.crashes).map(([n, o]) => `${n} ${f(o.mean)}% (${o.n})`).join("; ")}`);
}
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, parts: parts.map((p) => p.info), results: all }, null, 1));
