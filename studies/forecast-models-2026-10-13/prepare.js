"use strict";
// Data preparation for ./PREREGISTRATION.txt (no model output, no returns are computed here except the trees' training targets,
// which are only ever used for training on dates before each rebalance).
//   K2_CM_DIR=nse-data/cm node prepare.js <out-dir>
// Writes <out>/inputs.jsonl (one line per rebalance x stock: the last <= 512 bars up to d) and <out>/features.csv (trees).
const fs = require("node:fs");
const path = require("node:path");
const { load, plan, FEATURES, features } = require("./common");

const out = path.resolve(process.argv[2] || "fm-data"); fs.mkdirSync(out, { recursive: true });
const data = load(process.env.K2_CM_DIR || "nse-data/cm");
const p = plan(data);
const { nextTradingDate } = require(path.join(__dirname, "..", "..", "scripts", "paper-ledger"));
const inp = fs.createWriteStream(path.join(out, process.env.K2_WITH_DATES ? "inputs-dated.jsonl" : "inputs.jsonl"));
let n = 0;
for (const r of p.rebalances) for (const s of r.names) { const b = s.bars;   // bars up to d, since the last reset, at most 512
  const row = { d: r.d, e: r.e, sym: s.sym, o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.qty) };
  // K2_WITH_DATES (PREREGISTRATION-KRONOS-REAL-DATES.txt): each bar's own NSE date, and the next 5 NSE trading days after d
  if (process.env.K2_WITH_DATES) { row.t = b.map((x) => x.d); row.ty = []; let q = r.d; for (let k = 0; k < 5; k += 1) { q = nextTradingDate(q); row.ty.push(q); } }
  inp.write(JSON.stringify(row) + "\n"); n += 1; }
inp.end();
const f = [["i", "e", "sym", ...FEATURES, "target"].join(",")];
for (const r of p.history) for (const s of r.names) { const x = features(s.bars); if (!x) continue; f.push([r.i, r.e, s.sym, ...x.map((v) => v.toFixed(6)), s.target === null ? "" : s.target.toFixed(6)].join(",")); }
fs.writeFileSync(path.join(out, "features.csv"), f.join("\n") + "\n");
console.log(`rebalances ${p.rebalances.length} (${p.rebalances[0]?.e} .. ${p.rebalances.at(-1)?.e}); model inputs ${n}; tree rows ${f.length - 1} (history from ${p.history[0]?.e})`);
