"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the call side against the put side of the desk's one
// PASS, expiry-day NIFTY option selling (studies/expiry-selling-2026-10-20). A description of a tested rule; it makes no rule.
//   node study.js --synthetic                                                checks 6.1-6.3 only (no real data)
//   K2_NOD_DIR=<nifty option days> K2_IDX_DIR=<ind_close_all csv dir> node study.js     the one real run (writes RESULT.txt)
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const study = require(path.join(ROOT, "studies/expiry-selling-2026-10-20/study.js"));        // the registered study: run, synth
const { leg, nearest, expiryDay } = require(path.join(ROOT, "api/_lib/expiry-forward"));    // its rules, unchanged (replay MATCH)

// the study's one real run (result.json, 20-21 Oct 2026)
const STUDY = { sessions: 402, skipped: 51, expiries: 351, x2MeanPct: 0.09348687467502387, x2MeanPoints: 17.590993352326674, x2T: 4.425789129055527, last: "2026-10-19" };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// copied verbatim from studies/expiry-selling-2026-10-20/study.js (not exported there); check 6.4 proves it gives the study's t
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }

// Every leg of every expiry, by the study's rules. Set n: 1 ATM held, 2 ATM 2x stop (X2), 3 1% OTM held, 4 1% OTM 2x stop (X4).
// A set counts for an expiry only when both its legs exist, as in the study.
function legs(days, costs = true) {
  const out = [];
  for (const d of days) {
    const rows = d.rows.filter((r) => r[0] === d.date); if (!rows.length) continue;
    if (!(d.open > 0) || !(d.settle > 0)) continue;
    const atmC = nearest(rows, "CE", d.open), atmP = nearest(rows, "PE", d.open), oC = nearest(rows, "CE", d.open * 1.01), oP = nearest(rows, "PE", d.open * 0.99);
    const rec = { date: d.date, open: d.open, settle: d.settle };
    for (const [n, c, p, stop] of [[1, atmC, atmP, false], [2, atmC, atmP, true], [3, oC, oP, false], [4, oC, oP, true]]) {
      if (!c || !p) continue;
      const a = leg(c, d.settle, stop, costs), b = leg(p, d.settle, stop, costs); if (!a || !b) continue;
      rec[`C${n}`] = { pts: a.pnl, pct: (a.pnl / d.open) * 100, stopped: a.stopped, prem: c[3] };
      rec[`P${n}`] = { pts: b.pnl, pct: (b.pnl / d.open) * 100, stopped: b.stopped, prem: p[3] };
    }
    out.push(rec);
  }
  return out;
}

// Monthly sums of a per-expiry figure (the study's unit), then Newey-West t, lag 3
function monthly(recs, f) { const m = new Map(); for (const r of recs) { const v = f(r); if (v === null) continue; m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) || 0) + v); }
  return [...m.keys()].sort().map((k) => m.get(k)); }
const diff = (n) => (r) => (r[`P${n}`] && r[`C${n}`] ? r[`P${n}`].pct - r[`C${n}`].pct : null);
function verdict(t) { return Math.abs(t) >= 3 ? "DIFFERENT" : Math.abs(t) >= 2 ? "LEANING" : "NO DIFFERENCE FOUND"; }
function dTest(recs, n) { const s = monthly(recs, diff(n)); const t = nwT(s); const x = recs.map(diff(n)).filter((v) => v !== null);
  return { n: x.length, months: s.length, meanPct: mean(x), t, verdict: verdict(t), higher: mean(x) > 0 ? "put" : "call" }; }

// planted copies, calls unchanged: richOpen sells each put (1 + m) x fair at the open and leaves the rest of its day fair (the
// high is at least the open); plantPuts adds `add` points to each put's open and high (check 6.3)
const richOpen = (days, m) => days.map((d) => ({ ...d, rows: d.rows.map((r) => (r[2] === "PE" ? [r[0], r[1], r[2], r[3] * (1 + m), Math.max(r[4], r[3] * (1 + m)), ...r.slice(5)] : r)) }));
const plantPuts = (days, m, add = 0) => days.map((d) => ({ ...d, rows: d.rows.map((r) => (r[2] === "PE" ? [r[0], r[1], r[2], r[3] * (1 + m) + add, r[4] * (1 + m) + add, ...r.slice(5)] : r)) }));

function checks(log) {
  let ok = true;
  // 6.1 fair prices, no costs: no false DIFFERENT
  for (const seed of [1, 2, 3]) { const recs = legs(study.synth(seed, 1.0), false); const a = dTest(recs, 2), b = dTest(recs, 4);
    log(` 6.1 fair, seed ${seed}: D2 t ${a.t.toFixed(2)} (${a.verdict}), D4 t ${b.t.toFixed(2)} (${b.verdict})`); if (Math.abs(a.t) >= 3 || Math.abs(b.t) >= 3) ok = false; }
  // 6.2 puts sold rich at the open, calls fair, with costs: at 50%, put side higher on all three seeds, DIFFERENT on two; 20% = power
  for (const m of [0.5, 0.2]) { const r = [1, 2, 3].map((seed) => dTest(legs(richOpen(study.synth(seed, 1.0), m), true), 2));
    log(` 6.2 puts sold ${Math.round(m * 100)}% over fair at the open (seeds 1-3, with costs): D2 t ${r.map((a) => a.t.toFixed(2)).join(", ")}; DIFFERENT on ${r.filter((a) => a.verdict === "DIFFERENT").length} of 3${m === 0.2 ? " (power, not judged)" : ""}`);
    if (m === 0.5 && !(r.every((a) => a.meanPct > 0) && r.filter((a) => a.verdict === "DIFFERENT").length >= 2)) ok = false; }
  // 6.3 labels and arithmetic: 10 points added to every put's open moves each held put by exactly +10 and no call
  const base = study.synth(4, 1.0); const x = legs(base, false), y = legs(plantPuts(base, 0, 10), false);
  const exact = x.length === y.length && x.every((r, i) => r.P1 && Math.abs(y[i].P1.pts - r.P1.pts - 10) < 1e-9 && Math.abs(y[i].C1.pts - r.C1.pts) < 1e-12);
  log(` 6.3 a put 10 points dearer earns exactly +10 held, the call unchanged: ${exact}`); if (!exact) ok = false;
  log(` CHECKS: ${ok ? "PASSED" : "FAILED"}`); return ok;
}

// ---------- real data: the study's loader (as scripts/expiry-forward-replay.js) ----------
function loadReal() {
  const nod = path.resolve(process.env.K2_NOD_DIR || "nod"), idx = path.resolve(process.env.K2_IDX_DIR || "macro/ind_close_all");
  const open = new Map(); for (const f of fs.readdirSync(idx).filter((x) => x.endsWith(".csv"))) { const t = fs.readFileSync(path.join(idx, f), "utf8").split(/\r?\n/); const h = t[0].split(","); const io = h.findIndex((x) => /Open Index Value/i.test(x));
    const r = t.find((l) => /^"?Nifty 50"?,/i.test(l)); if (r && io >= 0) { const v = +r.split(",")[io]; if (v > 0) open.set(f.slice(0, 10), v); } }
  const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".json.gz")) files.push(p); } }; walk(nod);
  const days = []; for (const p of files.sort()) { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p))); if (j.date > STUDY.last) continue; const d = expiryDay(j, open.get(j.date) ?? null); if (d) days.push(d); }
  return days;
}

const sgn = (v, k = 2) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(k)}`;
function describe(recs, key) {
  const x = recs.filter((r) => r[key]).map((r) => r[key]); const s = monthly(recs, (r) => (r[key] ? r[key].pct : null));
  const worst = recs.filter((r) => r[key]).reduce((w, r) => (r[key].pts < w[key].pts ? r : w));
  return { key, n: x.length, meanPts: mean(x.map((v) => v.pts)), meanPct: mean(x.map((v) => v.pct)), won: (100 * x.filter((v) => v.pts > 0).length) / x.length, t: nwT(s),
    stops: (100 * x.filter((v) => v.stopped).length) / x.length, prem: mean(x.map((v) => v.prem)), worstPts: worst[key].pts, worstPct: worst[key].pct, worstDate: worst.date, worstMonth: Math.min(...s) };
}

if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  log(`EXPIRY-DAY SELLING, CALL SIDE AGAINST PUT SIDE, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`); log("CHECKS (synthetic, section 6):");
  if (!checks(log)) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECKS FAILED: real run refused.\n\n"); process.exit(1); }
  if (process.argv.includes("--synthetic")) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); process.exit(0); }

  const days = loadReal(); const ref = study.run(days, true); const recs = legs(days, true);
  // 6.4 the study, reproduced: same sessions, skips and expiries; C2 + P2 = X2 on every expiry; the same mean and t
  const x2 = ref.out.X2, byDate = new Map(recs.map((r) => [r.date, r]));
  const sameLegs = x2.every((t) => { const r = byDate.get(t.date); return r && r.C2 && r.P2 && Math.abs(r.C2.pts + r.P2.pts - t.points) < 1e-9; }) && recs.filter((r) => r.C2).length === x2.length;
  const x2t = nwT(monthly(recs, (r) => (r.C2 ? r.C2.pct + r.P2.pct : null)));
  const repro = days.length === STUDY.sessions && ref.skipped === STUDY.skipped && x2.length === STUDY.expiries && sameLegs
    && Math.abs(mean(x2.map((t) => t.pct)) - STUDY.x2MeanPct) < 1e-12 && Math.abs(mean(x2.map((t) => t.points)) - STUDY.x2MeanPoints) < 1e-9 && Math.abs(x2t - STUDY.x2T) < 1e-9;
  log(` 6.4 the study reproduced: ${days.length} sessions (study ${STUDY.sessions}), skipped ${ref.skipped} (${STUDY.skipped}), X2 ${x2.length} expiries (${STUDY.expiries}), C2 + P2 = X2 on every expiry: ${sameLegs}, X2 mean ${mean(x2.map((t) => t.points)).toFixed(4)} points (${STUDY.x2MeanPoints.toFixed(4)}), t ${x2t.toFixed(4)} (${STUDY.x2T.toFixed(4)}) -> ${repro ? "MATCH" : "MISMATCH"}`);
  if (!repro) { log("VOID: the split does not reproduce the study; no figure is reported."); fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); process.exit(1); }

  const r2 = dTest(recs, 2), r4 = dTest(recs, 4);
  log(`\nREAL DATA: ${recs.filter((r) => r.C2).length} expiries ${recs[0].date} .. ${recs.at(-1).date}. Points and % of NIFTY's open, after charges + 1 point a leg.`);
  log(`MAIN, D2 = put leg - call leg of X2 (ATM, 2x stop): ${r2.n} expiries, mean ${sgn(r2.meanPct, 3)}% of NIFTY an expiry, t ${r2.t.toFixed(2)} (two-sided) -> ${r2.verdict}${r2.verdict === "NO DIFFERENCE FOUND" ? "" : ` (${r2.higher} side higher)`}`);
  log(`SECONDARY, D4 = put leg - call leg of X4 (1% out, 2x stop): ${r4.n} expiries, mean ${sgn(r4.meanPct, 3)}%, t ${r4.t.toFixed(2)} -> ${r4.verdict}${r4.verdict === "NO DIFFERENCE FOUND" ? "" : ` (${r4.higher} side higher)`}`);
  log("\nEACH LEG ALONE (information only: no verdict, no rule; selling one side adds an untested NIFTY direction bet):");
  for (const k of ["C2", "P2", "C4", "P4", "C1", "P1", "C3", "P3"]) { const d = describe(recs, k);
    log(` ${k}: ${d.n} expiries, ${sgn(d.meanPts, 1)} points an expiry (${sgn(d.meanPct, 3)}%), won ${d.won.toFixed(0)}%, t ${d.t.toFixed(2)}, premium at the open ${d.prem.toFixed(1)}, stopped ${d.stops.toFixed(0)}%, worst ${sgn(d.worstPts, 0)} points (${sgn(d.worstPct, 2)}%, ${d.worstDate}), worst month ${sgn(d.worstMonth, 2)}%`); }
  log("\nBY NIFTY'S DIRECTION, open to settlement (reported, not judged):");
  for (const [name, f] of [["NIFTY up", (r) => r.settle > r.open], ["NIFTY down", (r) => r.settle < r.open]]) { const x = recs.filter((r) => r.C2 && f(r));
    log(` ${name}: ${x.length} expiries; C2 ${sgn(mean(x.map((r) => r.C2.pts)), 1)}, P2 ${sgn(mean(x.map((r) => r.P2.pts)), 1)}, X2 ${sgn(mean(x.map((r) => r.C2.pts + r.P2.pts)), 1)} points an expiry`); }
  log("\nD2 BY THE STUDY'S PERIODS (reported, not judged):");
  for (const [a, b, name] of [["2019-01-01", "2024-11-19", "to 19 Nov 2024"], ["2024-11-20", "2025-09-01", "20 Nov 2024 - 1 Sep 2025"], ["2025-09-02", "2099-01-01", "from 2 Sep 2025"]]) {
    const x = recs.filter((r) => r.C2 && r.date >= a && r.date <= b); log(` ${name}: ${x.length} expiries, C2 ${sgn(mean(x.map((r) => r.C2.pts)), 1)}, P2 ${sgn(mean(x.map((r) => r.P2.pts)), 1)} points, D2 ${sgn(mean(x.map(diff(2))), 3)}%`); }
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ D2: r2, D4: r4, legs: ["C2", "P2", "C4", "P4", "C1", "P1", "C3", "P3"].map((k) => describe(recs, k)) }, null, 1));
}
module.exports = { legs, dTest, monthly, nwT };
