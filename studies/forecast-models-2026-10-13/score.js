"use strict";
// Scores ./PREREGISTRATION.txt's six members under PROTOCOL v2. ONE real run, after every forecast file exists.
//   K2_CM_DIR=nse-data/cm node score.js <fm-data>          | node score.js --synthetic
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { load, plan, H } = require("./common");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const MEMBERS = ["M1 TimesFM-2.5", "M2 Chronos-2", "M3 Kronos-small", "M4 blend of M1-M3 (equal-weight ranks)", "M5 boosted trees (walk-forward)", "M6 5-day reversal (Lehmann 1990)"];
const NOTIONAL = 500000;
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const rankOf = (pairs) => { const s = pairs.slice().sort((a, b) => a[1] - b[1]); const r = new Map(); s.forEach(([k], i) => r.set(k, s.length > 1 ? i / (s.length - 1) : 0.5)); return r; };
const spearman = (a, b) => { const ra = rankOf(a.map((v, i) => [i, v])), rb = rankOf(b.map((v, i) => [i, v])); const x = a.map((_, i) => ra.get(i)), y = b.map((_, i) => rb.get(i));
  const mx = mean(x), my = mean(y); let s = 0, sx = 0, sy = 0; for (let i = 0; i < x.length; i += 1) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; } return s / Math.sqrt(sx * sy); };

// preds: { member -> Map("e|sym" -> predicted return) }. Returns per-member rebalance values and rank ICs.
function run(p, preds) {
  const out = Object.fromEntries(MEMBERS.map((k) => [k, { obs: [], ic: [] }]));
  for (const r of p.rebalances) { const names = r.names.filter((s) => s.w.complete); if (names.length < 20) continue;
    const pm = { ...preds };
    pm[MEMBERS[5]] = new Map(names.map((s) => { const c = s.bars.map((b) => b.c); return [`${r.e}|${s.sym}`, -(c[c.length - 1] / c[c.length - 6] - 1)]; }));
    const three = MEMBERS.slice(0, 3).map((k) => pm[k] || new Map());
    const have = names.filter((s) => three.every((m) => m.has(`${r.e}|${s.sym}`)));
    if (have.length >= 20) { const rk = three.map((m) => rankOf(have.map((s) => [s.sym, m.get(`${r.e}|${s.sym}`)])));
      pm[MEMBERS[3]] = new Map(have.map((s) => [`${r.e}|${s.sym}`, mean(rk.map((x) => x.get(s.sym)))])); }
    for (const k of MEMBERS) { const m = pm[k]; if (!m) continue; const xs = names.filter((s) => m.has(`${r.e}|${s.sym}`)).map((s) => [s, m.get(`${r.e}|${s.sym}`)]); if (xs.length < 20) continue;
      xs.sort((a, b) => a[1] - b[1]); const n = Math.floor(xs.length / 10);
      const leg = (s, side) => { const b = s.w.st.bars, i = s.w.i; return futNet(side, b[i].o, b[i + H - 1].c, r.e, b[i + H - 1].d); };
      const L = xs.slice(-n).map(([s]) => leg(s, 1)), Sh = xs.slice(0, n).map(([s]) => leg(s, -1));
      out[k].obs.push({ day: r.e, net: (mean(L) + mean(Sh)) / 2 });
      out[k].ic.push(spearman(xs.map((x) => x[1]), xs.map(([s]) => s.gross))); } }
  return out;
}

function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / (n - 1)) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function score(res) {
  const rows = MEMBERS.map((k) => { const o = res[k].obs; const month = new Map(); for (const t of o) { const m = t.day.slice(0, 7); month.set(m, (month.get(m) || []).concat(t.net)); }
    const s = [...month.keys()].sort().map((m) => mean(month.get(m)) * 100); const ic = res[k].ic.length ? mean(res[k].ic) : null;
    if (s.length < 24) return { k, months: s.length, trades: o.length, ic, verdict: "NOT TESTABLE" };
    const r = nwT(s); const sharpe = (r.mean / r.sd) * Math.sqrt(12);
    return { k, months: s.length, trades: o.length, meanPct: r.mean, t: r.t, sharpe, ic, win: (100 * o.filter((t) => t.net > 0).length) / o.length,
      verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); for (const r of tested) r.p = 1 - Phi(r.t); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const vSR = N > 1 ? sd(tested.map((r) => r.sharpe)) ** 2 : 0; const g = 0.5772156649;
    const inv = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const mid = (lo + hi) / 2; if (Phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
    const SR0 = N > 1 ? Math.sqrt(vSR) * ((1 - g) * inv(1 - 1 / N) + g * inv(1 - 1 / (N * Math.E))) : 0;
    for (const r of tested) r.dsr = Phi((r.sharpe - SR0) * Math.sqrt(r.months / 12)); rows.SR0 = SR0; }
  return rows;
}
const fmt = (r) => `${r.k} | ${r.months} | ${r.trades} | ${r.meanPct === undefined ? "-" : (r.meanPct >= 0 ? "+" : "") + r.meanPct.toFixed(3) + "%"} | ${r.win === undefined ? "-" : r.win.toFixed(1) + "%"} | ${r.t === undefined ? "-" : r.t.toFixed(2)} | ${r.sharpe === undefined ? "-" : r.sharpe.toFixed(2)} | ${r.ic === null || r.ic === undefined ? "-" : r.ic.toFixed(4)} | ${r.holm === undefined ? "-" : r.holm ? "yes" : "no"} | ${r.dsr === undefined ? "-" : r.dsr.toFixed(2)} | ${r.verdict}`;
const readPreds = (file) => { const m = new Map(); if (!fs.existsSync(file)) return null; for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1)) { const [e, sym, v] = l.split(","); if (sym && Number.isFinite(+v)) m.set(`${e}|${sym}`, +v); } return m; };

// ---- synthetic market: checks only
function synth(seed, plantFor) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2021-01-01"); sessions.length < 1300; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const drift = Array.from({ length: 150 }, () => Array.from({ length: sessions.length }, () => 0.004 * gauss()));
  const stocks = Array.from({ length: 150 }, (_, k) => { let p = 300 + k; return { sym: `S${k}`, bars: sessions.map((d, i) => { const o = p * (1 + 0.002 * gauss()); const c = o * (1 + drift[k][i] + 0.015 * gauss()); p = c; return { d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 + k * 1e6, qty: 1e5 }; }) }; });
  const data = { sessions, stocks }; const p = plan(data, { start: sessions[700] });
  const preds = {}; const sIdx = new Map(sessions.map((d, i) => [d, i]));
  // the planted model "knows" the next 5 sessions' drift; the others are noise
  for (const k of MEMBERS.slice(0, 3).concat(MEMBERS[4])) { const m = new Map(); for (const r of p.rebalances) for (const n of r.names) { const i = sIdx.get(r.e); const sk = +n.sym.slice(1);
      m.set(`${r.e}|${n.sym}`, k === plantFor ? drift[sk].slice(i, i + 5).reduce((a, x) => a + x, 0) : gauss()); } preds[k] = m; }
  return { p, preds };
}

if (process.argv.includes("--synthetic")) {
  let ok = true; const say = (name, pass, detail) => { console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}  (${detail})`); if (!pass) ok = false; };
  const v = (rows) => rows.map((r) => `${r.k.split(" ")[0]} ${r.verdict}${r.t !== undefined ? ` ${r.t.toFixed(1)}` : ""}`).join(", ");
  const a = synth(5, MEMBERS[1]); const ra = score(run(a.p, a.preds)); say("1. a planted forecaster (M2) is found, and the blend carries part of it", ra[1].verdict === "PASS" && ra[3].meanPct > 0, v(ra));
  const b = synth(6, null); const rb = score(run(b.p, b.preds)); say("2. noise: at most one chance PASS", rb.filter((x) => x.verdict === "PASS").length <= 1, v(rb));
  const c = synth(7, MEMBERS[1]); const before = run(c.p, c.preds)[MEMBERS[1]].obs.map((o) => o.net.toFixed(10)).join();
  for (const st of c.p.ctx.bySym.values()) for (const bar of st.bars) if (bar.d >= c.p.S.at(-30)) { bar.o *= 2; bar.c *= 0.3; }
  const after = run(c.p, c.preds)[MEMBERS[1]].obs.filter((o) => o.day < c.p.S.at(-40)).map((o) => o.net.toFixed(10)).join();
  say("3. no look-ahead: rebalances 10+ sessions before a price change are identical", before.startsWith(after) && after.length > 0, `${after.split(",").length} rebalances`);
  console.log(ok ? "\nSYNTHETIC CHECKS: ALL PASS" : "\nSYNTHETIC CHECKS FAILED"); process.exit(ok ? 0 : 1);
}

const dir = path.resolve(process.argv[2] || "fm-data");
const data = load(process.env.K2_CM_DIR || "nse-data/cm"); const p = plan(data);
const preds = { [MEMBERS[0]]: readPreds(path.join(dir, "forecasts-timesfm.csv")), [MEMBERS[1]]: readPreds(path.join(dir, "forecasts-chronos2.csv")),
  [MEMBERS[2]]: readPreds(path.join(dir, "forecasts-kronos.csv")), [MEMBERS[4]]: readPreds(path.join(dir, "forecasts-trees.csv")) };
const missing = Object.entries(preds).filter(([, m]) => !m).map(([k]) => k); if (missing.length) { console.log(`NOT RUN: forecasts missing for ${missing.join(", ")}`); process.exit(3); }
const rows = score(run(p, preds)); const out = []; const line = (x) => { console.log(x); out.push(x); };
line(`FOUNDATION MODELS ON NSE -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); protocol v2`);
line(`Rebalances ${p.rebalances.length} (${p.rebalances[0].e} .. ${p.rebalances.at(-1).e}); CM to ${data.sessions.at(-1)}. DSR benchmark: ${rows.SR0 === undefined ? "-" : rows.SR0.toFixed(2)}`);
line("member | months | rebalances | mean/rebalance | winners | t (NW) | annual Sharpe | mean rank IC | Holm | DSR | VERDICT");
for (const r of rows) line(fmt(r));
line(`\nPASS (t >= 3): ${rows.filter((r) => r.verdict === "PASS").map((r) => r.k).join("; ") || "none"}. PROMISING: ${rows.filter((r) => r.verdict === "PROMISING").map((r) => r.k).join("; ") || "none"}.`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify(rows, null, 1));
