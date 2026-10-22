"use strict";
// Implements ./PREREGISTRATION.txt section 7: 7.1 no look-ahead, 7.2 null (random-walk NIFTY), 7.3 coverage (counts only).
//   node checks.js        (the same data as score.js; prints the checks, computes no real verdict)
const B = require("./build");

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// 7.1: change every input dated after a cutoff; every position decided at or before it must be identical, and the control
// (positions after it) must change
function check71(inp, log) {
  const S = inp.sessions; const ic = Math.floor(S.length * 0.7), c = S[ic]; const r = rng(71);
  const alt = { sessions: S, open: new Map([...inp.open].map(([d, v]) => [d, d > c ? v * (0.9 + 0.2 * r()) : v])),
    fii: new Map([...inp.fii].map(([d, v]) => [d, d > c ? 0.2 + 0.6 * r() : v])),
    nsdl: inp.nsdl.map((x) => (x.date > c ? { ...x, v: (r() - 0.5) * 1e4 } : x)), usd: inp.usd.map((x) => (x.date > c ? { ...x, v: x.v * (0.95 + 0.1 * r()) } : x)) };
  const a = B.books(inp), b = B.books(alt); let same = true, changed = false;
  for (const k of ["M1", "M2", "M3"]) for (let i = 0; i < S.length; i += 1) { if (i <= ic && a.held[k][i] !== b.held[k][i]) same = false; if (i > ic && a.held[k][i] !== b.held[k][i]) changed = true; }
  for (const k of B.MEMBERS) for (let i = 0; i < a[k].length; i += 1) { if (a[k][i].d <= c && a[k][i].pos !== b[k][i].pos) same = false; }
  const ok = same && changed;
  log(` 7.1 no look-ahead, cutoff ${c}: decisions and positions at or before it identical ${same ? "yes" : "NO"}; control after it changed ${changed ? "yes" : "NO"}: ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}
// 7.2: NIFTY replaced by 3 seeded random walks with the same daily volatility (open to open); at most 1 PASS of the 12
function check72(inp, from, to, log) {
  const { verdicts } = require("./score"); const S = inp.sessions; const lr = []; for (let i = 1; i < S.length; i += 1) lr.push(Math.log(inp.open.get(S[i]) / inp.open.get(S[i - 1])));
  const m = lr.reduce((x, y) => x + y, 0) / lr.length; const sig = Math.sqrt(lr.reduce((x, y) => x + (y - m) ** 2, 0) / (lr.length - 1));
  let passes = 0; const out = [];
  for (const seed of [1, 2, 3]) { const r = rng(720 + seed); let o = inp.open.get(S[0]); const open = new Map([[S[0], o]]);
    for (let i = 1; i < S.length; i += 1) { o *= Math.exp(sig * gauss(r)); open.set(S[i], o); }
    const v = verdicts(B.books({ ...inp, open }), from, to); passes += v.filter((x) => x.verdict === "PASS").length; out.push(`seed ${seed}: ${v.map((x) => `${x.key} t ${Number.isFinite(x.t) ? x.t.toFixed(2) : "-"} ${x.verdict}`).join(", ")}`); }
  const ok = passes <= 1;
  log(` 7.2 null (random-walk NIFTY, daily vol ${(sig * 100).toFixed(2)}%): ${passes} PASS of 12 (at most 1): ${ok ? "PASSED" : "FAILED"}\n   ${out.join("\n   ")}`);
  return ok;
}
// 7.3: coverage, counts only: per member and year, the share of sessions with a usable signal
function check73(inp, log) {
  const sig = B.signals(inp); const S = inp.sessions; const years = [...new Set(S.map((d) => d.slice(0, 4)))].filter((y) => y >= "2012");
  log(" 7.3 coverage (share of sessions with a usable signal, counts only): " + years.map((y) => { const ix = S.map((d, i) => [d, i]).filter(([d]) => d.startsWith(y)).map(([, i]) => i);
    const sh = (k) => Math.round((100 * ix.filter((i) => sig[k][i] !== null).length) / ix.length); const all = Math.round((100 * ix.filter((i) => sig.M1[i] !== null && sig.M2[i] !== null && sig.M3[i] !== null).length) / ix.length);
    return `${y} M1 ${sh("M1")}% M2 ${sh("M2")}% M3 ${sh("M3")}% all ${all}%`; }).join("; "));
}
module.exports = { check71, check72, check73 };
if (require.main === module) {
  B.verify(); const inp = B.loadInputs(); const { sampleEnd } = require("./score"); const end = sampleEnd(inp); const log = (s) => console.log(s);
  check71(inp, log); check72(inp, B.SAMPLE_FROM, end, log); check73(inp, log);
}
