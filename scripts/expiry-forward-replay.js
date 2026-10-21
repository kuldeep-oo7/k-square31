"use strict";
// REPLAY CHECK for the expiry-selling forward test (studies/expiry-selling-forward-2026-10-21/PREREGISTRATION.txt): run
// the forward code over the study's own data and compare with its one real run (studies/expiry-selling-2026-10-20,
// branch claude/expiry-selling-2026-10-20, result.json). Proves the forward code is the studied rule.
//   K2_NOD_DIR=<data-nifty-options folder> K2_IDX_DIR=<NSE ind_close_all CSVs> node scripts/expiry-forward-replay.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { run, expiryDay } = require("../api/_lib/expiry-forward");

// the study's one real run (20-21 Oct 2026): expiries and mean % of NIFTY's open per expiry, after costs
const STUDY = { X1: [351, 0.08313123632271427], X2: [351, 0.09348687467502387], X3: [351, 0.053510144998352153], X4: [351, 0.04044411284215498], skipped: 51 };

const nod = path.resolve(process.env.K2_NOD_DIR || "nod"), idx = path.resolve(process.env.K2_IDX_DIR || "macro/ind_close_all");
const open = new Map(); for (const f of fs.readdirSync(idx).filter((x) => x.endsWith(".csv"))) { const t = fs.readFileSync(path.join(idx, f), "utf8").split(/\r?\n/); const h = t[0].split(","); const io = h.findIndex((x) => /Open Index Value/i.test(x));
  const r = t.find((l) => /^"?Nifty 50"?,/i.test(l)); if (r && io >= 0) { const v = +r.split(",")[io]; if (v > 0) open.set(f.slice(0, 10), v); } }
const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".json.gz")) files.push(p); } }; walk(nod);
const days = []; for (const p of files.sort()) { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p))); const d = expiryDay(j, open.get(j.date) ?? null); if (d) days.push(d); }
const { out, skipped } = run(days, true);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const lines = [`REPLAY of the expiry-selling study through the forward code, run ${new Date().toISOString()}`, `${days.length} expiry sessions ${days[0]?.date} .. ${days.at(-1)?.date}; skipped ${skipped} (study: ${STUDY.skipped})`];
let ok = skipped === STUDY.skipped;
for (const k of ["X1", "X2", "X3", "X4"]) { const n = out[k].length, m = n ? mean(out[k].map((t) => t.pct)) : NaN; const same = n === STUDY[k][0] && Math.abs(m - STUDY[k][1]) < 1e-12; if (!same) ok = false;
  lines.push(` ${k}: ${n} expiries, mean ${m.toFixed(6)}% (study ${STUDY[k][0]}, ${STUDY[k][1].toFixed(6)}%) ${same ? "same" : "DIFFERENT"}`); }
lines.push(ok ? "MATCH: the forward code is the studied rule." : "MISMATCH: the forward code differs from the study -- do not publish until explained.");
console.log(lines.join("\n"));
if (process.env.K2_REPLAY_OUT) fs.writeFileSync(process.env.K2_REPLAY_OUT, lines.join("\n") + "\n");
process.exit(ok ? 0 : 1);
