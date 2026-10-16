"use strict";
// Checks 7.2 and 7.3 of ./PREREGISTRATION.txt, as amendment A2 fixes them. Synthetic markets only; no real data is read.
//   K2_PY=<python> node checks.js lookahead <workdir>     7.3: nothing dated after a cutoff changes anything before it
//   K2_PY=<python> node checks.js null <workdir>          7.2: no-edge markets, seeds 1-3, at most 1 PASS of 9
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build, synth, writePanel, STOCK_F, MARKET_F } = require("./features");
const { books, score, readCsv } = require("./score");
const PY = process.env.K2_PY || "python";
const model = (panel, preds) => { if (fs.existsSync(preds)) fs.unlinkSync(preds); execFileSync(PY, [path.join(__dirname, "model.py"), panel, preds], { stdio: ["ignore", "ignore", "inherit"] }); };
const CUT = 1000;

// every input dated after the cutoff is changed, by a factor that varies by date (so returns change too)
function perturb(data) {
  const cut = data.sessions[CUT]; const fac = (d, s = "") => 1 + 0.03 * Math.sin(Date.parse(d) / 864e5 + 7.3 * [...s].reduce((a, ch) => a + ch.charCodeAt(0), 0));   // differs by date AND stock, so ranks move; small, so no move reaches the 18% reset
  for (const st of data.stocks) for (const b of st.bars) if (b.d > cut) { const f = fac(b.d, st.sym); b.o *= f; b.c *= f * f; b.h = Math.max(b.o, b.c) * 1.01; b.l = Math.min(b.o, b.c) * 0.99; b.qty *= f; b.val = b.qty * b.c; }
  const scale = (v, f) => (typeof v === "number" ? v * f : Array.isArray(v) ? v.map((x) => x * f) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : scale(x, f)])) : v);
  for (const key of ["fut", "deliv", "opt", "short", "slb", "fee", "mwpl", "mtf"]) for (const [d, m] of data[key]) if (d > cut) for (const [s, v] of m) m.set(s, scale(v, fac(d, s) * 1.3));
  for (const key of ["nifty", "vix", "part", "cat"]) for (const [d, v] of data[key]) if (d > cut) data[key].set(d, scale(v, fac(d) * 1.2));
  return data;
}

function blocksOf(panelRows) {   // model.py's schedule: every 5th session from START, blocks of 4
  const byI = new Map(); for (const r of panelRows) byI.set(+r.i, r.d); const is = [...byI.keys()].sort((a, b) => a - b);
  const first = is.find((i) => byI.get(i) >= "2022-10-03"); const reb = is.filter((i) => i >= first && (i - first) % 5 === 0);
  const out = []; for (let k = 0; k < reb.length; k += 4) out.push(reb.slice(k, k + 4)); return out;
}

function lookahead(dir) {
  const A = synth(1, true), B = perturb(synth(1, true)); const cut = A.sessions[CUT];
  const ra = build(A).rows, rb = build(B).rows; const key = (r) => `${r.d}|${r.sym}`;
  const ma = new Map(ra.filter((r) => r.d <= cut).map((r) => [key(r), r])), mb = new Map(rb.filter((r) => r.d <= cut).map((r) => [key(r), r]));
  let rowsSame = ma.size === mb.size && [...ma.keys()].every((k) => mb.has(k)), featDiff = 0, featN = 0;
  for (const [k, r] of ma) { const s = mb.get(k); if (!s) continue; for (const q of [...STOCK_F, ...MARKET_F]) { featN += 1; const x = r.f[q], y = s.f[q]; if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) featDiff += 1; } }
  const lb = new Map(rb.filter((r) => r.d > cut).map((r) => [key(r), r]));
  const laterDiff = ra.filter((r) => r.d > cut).some((r) => { const s = lb.get(key(r)); return s && STOCK_F.some((q) => s.f[q] !== r.f[q] && !(Number.isNaN(s.f[q]) && Number.isNaN(r.f[q]))); });
  const pa = path.join(dir, "chk-la-A.csv"), pb = path.join(dir, "chk-la-B.csv"); writePanel(pa, ra); writePanel(pb, rb);
  model(pa, pa.replace(".csv", "-preds.csv")); model(pb, pb.replace(".csv", "-preds.csv"));
  const PA = readCsv(pa.replace(".csv", "-preds.csv")), PB = readCsv(pb.replace(".csv", "-preds.csv"));
  const blocks = blocksOf(readCsv(pa)); const safe = new Set(); let unsafe = 0;
  for (const b of blocks) { if (b.every((i) => i <= CUT) && b[0] + 1 <= CUT) b.forEach((i) => safe.add(i)); else unsafe += 1; }
  const ka = new Map(PA.map((r) => [`${r.i}|${r.sym}`, r])); let predN = 0, predDiff = 0, predLater = 0;
  for (const r of PB) { const a = ka.get(`${r.i}|${r.sym}`); if (!a) { if (safe.has(+r.i)) predDiff += 1; continue; }
    if (safe.has(+r.i)) { predN += 1; if (a.T !== r.T || a.R !== r.R) predDiff += 1; } else if (a.T !== r.T) predLater += 1; }
  const ok = rowsSame && featDiff === 0 && predDiff === 0 && featN > 0 && predN > 0;
  const lines = [`CHECK 7.3 (no look-ahead), synthetic seed 1 with the plant, cutoff session ${CUT} (${cut}):`,
    ` rows dated <= cutoff: ${ma.size} vs ${mb.size}, same keys: ${rowsSame}; features compared ${featN}, different ${featDiff}`,
    ` predictions of blocks fully before the cutoff: ${predN} compared, ${predDiff} different (${safe.size} rebalances; ${unsafe} later blocks)`,
    ` control (the change must matter after the cutoff): later features differ ${laterDiff}, later predictions differ ${predLater}`,
    ` CHECK 7.3: ${ok && laterDiff && predLater > 0 ? "PASSED" : "FAILED"}`];
  return { ok: ok && laterDiff && predLater > 0, lines };
}

function nullCheck(dir) {
  const lines = ["CHECK 7.2 (no-edge synthetic markets, A1 rule; at most 1 PASS among the 9 member results):"]; let passes = 0;
  for (const seed of [1, 2, 3]) {
    const p = path.join(dir, `chk-null-${seed}.csv`); writePanel(p, build(synth(seed, false)).rows); const pr = p.replace(".csv", "-preds.csv"); model(p, pr);
    const { out } = books(readCsv(p), readCsv(pr)); const rows = score(out); passes += rows.filter((r) => r.verdict === "PASS").length;
    lines.push(` seed ${seed}: ` + rows.map((r) => `${r.key} ${r.meanPct === undefined ? "-" : r.meanPct.toFixed(3) + "%"} t ${r.t === undefined ? "-" : r.t.toFixed(2)} DSR ${r.dsr === undefined ? "-" : r.dsr.toFixed(2)} ${r.verdict}`).join(" | "));
  }
  lines.push(` PASS results: ${passes} of 9. CHECK 7.2: ${passes <= 1 ? "PASSED" : "FAILED"}`);
  return { ok: passes <= 1, lines };
}

if (require.main === module) {
  const [what, dir] = process.argv.slice(2); fs.mkdirSync(dir, { recursive: true });
  const r = what === "lookahead" ? lookahead(dir) : what === "null" ? nullCheck(dir) : null;
  if (!r) { console.error("usage: node checks.js lookahead|null <workdir>"); process.exit(1); }
  console.log(r.lines.join("\n")); fs.appendFileSync(path.join(dir, "checks.txt"), r.lines.join("\n") + "\n"); process.exit(r.ok ? 0 : 1);
}
