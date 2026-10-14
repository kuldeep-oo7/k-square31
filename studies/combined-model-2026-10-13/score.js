"use strict";
// Section 6 of ./PREREGISTRATION.txt: the books C1-C3 from model.py's predictions, futures charges, protocol v2.
//   node score.js <panel.csv> <preds.csv> <label> [--write]     (--write: RESULT.txt + result.json, the one real run)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const NOTIONAL = 500000;
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const fin = Number.isFinite;
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return { mean: m, t: m / Math.sqrt(s / n), sd: sd(x) }; }
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const spearman = (a, b) => { const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const x = rk(a), y = rk(b); const mx = mean(x), my = mean(y); let c = 0, vx = 0, vy = 0; for (let i = 0; i < x.length; i += 1) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; } return c / Math.sqrt(vx * vy); };
const readCsv = (f) => { const t = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean); const h = t[0].split(","); return t.slice(1).map((l) => { const v = l.split(","); const o = {}; h.forEach((k, i) => { o[k] = v[i]; }); return o; }); };

const MEMBERS = { C1: "C1 trees long-short (deciles)", C2: "C2 ridge long-short (deciles)", C3: "C3 trees long-only top decile (excess)" };
function books(panel, preds) {
  const P = new Map(); for (const r of panel) P.set(`${r.i}|${r.sym}`, r);
  const byI = new Map(); for (const r of preds) { if (!byI.has(r.i)) byI.set(r.i, []); byI.get(r.i).push(r); }
  const out = { C1: [], C2: [], C3: [] }, ic = { T: [], R: [] }; let prevLong = null; const turn = [];
  for (const i of [...byI.keys()].sort((a, b) => a - b)) {
    const list = byI.get(i).map((p) => ({ p, row: P.get(`${i}|${p.sym}`) })).filter((x) => x.row); const n = list.length; if (n < 50) continue;
    const k = Math.floor(n / 10); const e = list[0].row.e;
    const done = list.filter((x) => fin(+x.row.ret) && x.row.x); const B = done.length >= 20 ? mean(done.map((x) => +x.row.ret)) : null;
    const net = (x, side) => (fin(+x.row.ret) && x.row.x ? futNet(side, +x.row.oe, +x.row.cx, x.row.e, x.row.x) : null);
    for (const [key, col] of [["C1", "T"], ["C2", "R"]]) {
      const s = list.slice().sort((a, b) => +b.p[col] - +a.p[col]); const L = s.slice(0, k).map((x) => net(x, 1)).filter((v) => v !== null), Sh = s.slice(-k).map((x) => net(x, -1)).filter((v) => v !== null);
      if (L.length && Sh.length) out[key].push({ day: e, net: (mean(L) + mean(Sh)) / 2 });
      if (key === "C1" && B !== null) { const L3 = s.slice(0, k).map((x) => net(x, 1)).filter((v) => v !== null); if (L3.length) out.C3.push({ day: e, net: mean(L3) - B }); }
      const yy = done.filter((x) => fin(+x.row.y)); if (yy.length >= 20) ic[col].push(spearman(yy.map((x) => +x.p[col]), yy.map((x) => +x.row.y)));
      if (key === "C1") { const set = new Set(s.slice(0, k).map((x) => x.p.sym)); if (prevLong) turn.push(1 - [...set].filter((q) => prevLong.has(q)).length / set.size); prevLong = set; }
    }
  }
  return { out, ic, turn };
}
function score(out) {
  const rows = Object.keys(MEMBERS).map((key) => { const ts = out[key]; const month = new Map(); for (const t of ts) { const m = t.day.slice(0, 7); if (!month.has(m)) month.set(m, []); month.get(m).push(t.net); }
    const s = [...month.keys()].sort().map((m) => mean(month.get(m)) * 100);
    if (s.length < 24) return { key, k: MEMBERS[key], months: s.length, rebalances: ts.length, verdict: "NOT TESTABLE" };
    const r = nwT(s); const sharpe = (r.mean / r.sd) * Math.sqrt(12); const sr = r.mean / r.sd;
    const g3 = mean(s.map((v) => ((v - r.mean) / r.sd) ** 3)), g4 = mean(s.map((v) => ((v - r.mean) / r.sd) ** 4));
    return { key, k: MEMBERS[key], months: s.length, rebalances: ts.length, sr, g3, g4, meanPct: mean(ts.map((t) => t.net)) * 100, monthMeanPct: r.mean, t: r.t, sharpe, p: 1 - Phi(r.t),
      win: (100 * ts.filter((t) => t.net > 0).length) / ts.length, monthsUp: s.filter((v) => v > 0).length, verdict: r.mean > 0 && r.t >= 3 ? "PASS" : r.mean > 0 && r.t >= 2 ? "PROMISING" : "FAIL" }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { const order = tested.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    // Deflated Sharpe, Bailey & Lopez de Prado (2014), monthly series (amendment A1)
    const g = 0.5772156649; const inv = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const mid = (lo + hi) / 2; if (Phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };
    const vSR = N > 1 ? sd(tested.map((r) => r.sr)) ** 2 : 0; const SR0 = N > 1 ? Math.sqrt(vSR) * ((1 - g) * inv(1 - 1 / N) + g * inv(1 - 1 / (N * Math.E))) : 0;
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMeanPct > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMeanPct > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; }
    rows.SR0 = SR0; }
  return rows;
}
const f2 = (v, d = 2) => (v === undefined ? "-" : (v >= 0 ? "+" : "") + v.toFixed(d));
const fmt = (r) => `${r.k} | ${r.months} | ${r.rebalances} | ${r.meanPct === undefined ? "-" : f2(r.meanPct, 3) + "%"} | ${r.win === undefined ? "-" : r.win.toFixed(1) + "%"} | ${r.monthsUp ?? "-"} | ${r.t === undefined ? "-" : r.t.toFixed(2)} | ${r.sharpe === undefined ? "-" : r.sharpe.toFixed(2)} | ${r.holm === undefined ? "-" : r.holm ? "yes" : "no"} | ${r.dsr === undefined || !Number.isFinite(r.dsr) ? "-" : r.dsr.toFixed(2)} | ${r.verdict}`;

module.exports = { books, score, fmt, readCsv };
if (require.main === module) {
  const [panelF, predF, label] = process.argv.slice(2);
  const panel = readCsv(panelF), preds = readCsv(predF); const { out, ic, turn } = books(panel, preds); const rows = score(out);
  const lines = [`COMBINED MODEL -- ${label || ""} -- ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); protocol v2`,
    `Rebalances with predictions: ${new Set(preds.map((r) => r.i)).size} (${preds[0]?.d} .. ${preds.at(-1)?.d}). DSR benchmark (monthly Sharpe): ${rows.SR0 === undefined ? "-" : rows.SR0.toFixed(3)}`,
    "member | months | rebalances | mean/rebalance | winners | months up | t (NW) | annual Sharpe | Holm | DSR | VERDICT", ...rows.map(fmt),
    `mean rank IC: trees ${ic.T.length ? mean(ic.T).toFixed(4) : "-"} (${ic.T.filter((v) => v > 0).length}/${ic.T.length} positive), ridge ${ic.R.length ? mean(ic.R).toFixed(4) : "-"}; long-book turnover ${turn.length ? (100 * mean(turn)).toFixed(0) : "-"}% a rebalance`,
    `PASS (t >= 3): ${rows.filter((r) => r.verdict === "PASS").map((r) => r.key).join(", ") || "none"}. PROMISING: ${rows.filter((r) => r.verdict === "PROMISING").map((r) => r.key).join(", ") || "none"}.`];
  console.log(lines.join("\n"));
  if (process.argv.includes("--write")) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ rows, ic: { T: ic.T.length ? mean(ic.T) : null, R: ic.R.length ? mean(ic.R) : null } }, null, 1)); }
}
