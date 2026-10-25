"use strict";
// POST-HOC AUDIT of the real run (21 Oct 2026), labelled as such: it cannot change a verdict, only expose a false one.
// A. Are the options' OPEN prints consistent with NIFTY's open? Put-call parity at the ATM strike on expiry day:
//    C - P should equal S - K (rates and dividends are negligible over hours). Large one-sided residuals in C + P would
//    mean the "open" premiums are stale or stray prints and the edge is an artefact.
// B. The same ATM straddle sold at the PREVIOUS session's CLOSE (the expiry eve, a more reliable price), held to the
//    final settlement, same costs. Not a registered member; reported to see whether the result depends on open prints.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const ROOT = path.resolve(__dirname, "..", "..");
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const nod = path.resolve(process.env.K2_NOD_DIR), idx = path.resolve(process.env.K2_IDX_DIR);
const open = new Map(), close = new Map(); for (const f of fs.readdirSync(idx).filter((x) => x.endsWith(".csv"))) { const t = fs.readFileSync(path.join(idx, f), "utf8").split(/\r?\n/); const h = t[0].split(",");
  const io = h.findIndex((x) => /Open Index Value/i.test(x)); const r = t.find((l) => /^"?Nifty 50"?,/i.test(l)); if (r && io >= 0 && +r.split(",")[io] > 0) open.set(f.slice(0, 10), +r.split(",")[io]); const ic = h.findIndex((x) => /Closing Index Value/i.test(x)); if (r && ic >= 0 && +r.split(",")[ic] > 0) close.set(f.slice(0, 10), +r.split(",")[ic]); }
const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".json.gz")) files.push(p); } }; walk(nod); files.sort();
const day = files.map((p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)))); const byDate = new Map(day.map((j) => [j.date, j]));
const dates = day.map((j) => j.date); const cost = (sell, buy) => { const r = roundTripCost({ entryPremium: Math.max(buy, 0.05), exitPremium: sell, quantity: 75 }); return r ? r.totalCost / 75 + 1 : null; };
const resid = [], straddleOpen = [], eve = []; let skipOpen = 0, skipEve = 0;
for (let k = 0; k < day.length; k += 1) {
  const j = day[k]; const exp = j.rows.filter((r) => r[0] === j.date); if (!exp.length) continue; const S = open.get(j.date);
  const st = exp.map((r) => r[7]).filter((v) => v > 0).sort((a, b) => a - b); const settle = st[Math.floor(st.length / 2)];
  if (S > 0) { const Ks = [...new Set(exp.map((r) => r[1]))].sort((a, b) => Math.abs(a - S) - Math.abs(b - S)); const K = Ks[0];
    const c = exp.find((r) => r[1] === K && r[2] === "CE"), p = exp.find((r) => r[1] === K && r[2] === "PE");
    if (c && p && c[3] > 0 && p[3] > 0) { resid.push((c[3] - p[3]) - (S - K)); straddleOpen.push((c[3] + p[3]) / S * 100); } else skipOpen += 1; }
  // B: the previous session's close for the same expiry, ATM to that session's NIFTY close (from the CE/PE parity mid)
  const prev = k > 0 ? day[k - 1] : null; if (!prev) { skipEve += 1; continue; }
  const pe = prev.rows.filter((r) => r[0] === j.date && r[6] > 0); if (!pe.length) { skipEve += 1; continue; }
  const Se = close.get(prev.date); if (!(Se > 0)) { skipEve += 1; continue; } const strikes = [...new Set(pe.map((r) => r[1]))].sort((a, b) => Math.abs(a - Se) - Math.abs(b - Se)); let best = null;
  for (const K of strikes) { const c = pe.find((r) => r[1] === K && r[2] === "CE"), p = pe.find((r) => r[1] === K && r[2] === "PE"); if (c && p) { best = { K, c: c[6], p: p[6] }; break; } }
  if (!best || !(settle > 0)) { skipEve += 1; continue; }
  const ivC = Math.max(0, settle - best.K), ivP = Math.max(0, best.K - settle); const cc = cost(best.c, ivC), cp = cost(best.p, ivP); if (cc === null || cp === null) { skipEve += 1; continue; }
  eve.push({ date: j.date, pts: best.c - ivC - cc + best.p - ivP - cp, ref: best.K });
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; }; const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`A. parity at the open, ${resid.length} expiries (${skipOpen} without both ATM legs): residual (C-P)-(S-K) median ${q(resid, 0.5).toFixed(2)} pts, mean ${mean(resid).toFixed(2)}, 10th..90th pct ${q(resid, 0.1).toFixed(1)} .. ${q(resid, 0.9).toFixed(1)}; ATM straddle at the open median ${q(straddleOpen, 0.5).toFixed(3)}% of NIFTY`);
const m = new Map(); for (const t of eve) m.set(t.date.slice(0, 7), (m.get(t.date.slice(0, 7)) || 0) + t.pts / t.ref * 100); const s = [...m.values()];
const sd = Math.sqrt(s.reduce((a, v) => a + (v - mean(s)) ** 2, 0) / (s.length - 1));
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }; console.log(`   B median ${med(eve.map((t) => t.pts)).toFixed(1)} points; 5 worst: ${eve.slice().sort((a, b) => a.pts - b.pts).slice(0, 5).map((t) => `${t.date} ${t.pts.toFixed(0)}`).join(", ")}`);
console.log(`B. ATM straddle sold at the expiry-eve CLOSE, held to settlement: ${eve.length} expiries (${skipEve} skipped), mean ${mean(eve.map((t) => t.pts)).toFixed(1)} points, won ${Math.round(100 * eve.filter((t) => t.pts > 0).length / eve.length)}%, worst ${Math.min(...eve.map((t) => t.pts)).toFixed(0)} points; monthly mean ${mean(s).toFixed(3)}%, simple t ${(mean(s) / (sd / Math.sqrt(s.length))).toFixed(2)} (not NW; post-hoc, not a registered member)`);
console.log(`   2019 check: expiries with a NIFTY open in 2019: ${[...open.keys()].filter((d) => d.startsWith("2019") && byDate.has(d) && byDate.get(d).rows.some((r) => r[0] === d)).length}`);
