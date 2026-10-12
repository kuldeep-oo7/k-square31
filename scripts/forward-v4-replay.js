"use strict";
// REPLAY CHECK for the S2 forward test (studies/forward-v4-2026-10-12/PREREGISTRATION.txt): run the forward
// code over the atlas study's window and compare with its one real run (2,085 trades, +0.256% mean of
// monthly means). Proves the forward code is the studied rule, not a re-translation.
//   K2_CM_DIR=.../nse-data/cm K2_SLB_DIR=research/nse-atlas/slb_openpos node scripts/forward-v4-replay.js
const fs = require("node:fs");
const path = require("node:path");
const { borrowingSurge, parseSlb } = require("../api/_lib/forward-v4");
const { loadCm } = require("./springy-dip-forward");

const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), slbDir = path.resolve(process.env.K2_SLB_DIR || "research/nse-atlas/slb_openpos");
const data = loadCm(cm); const last = data.sessions[data.sessions.length - 1];
const slb = new Map(); for (const f of fs.readdirSync(slbDir).filter((x) => x.endsWith(".csv")).sort()) { const d = f.slice(0, 10); if (d <= last) slb.set(d, parseSlb(fs.readFileSync(path.join(slbDir, f), "utf8"))); }
const r = borrowingSurge({ ...data, slb, start: "2000-01-01" });
const done = r.trades.filter((t) => t.status === "DONE");
const month = new Map(); for (const t of done) { const m = t.entryDate.slice(0, 7); month.set(m, (month.get(m) || []).concat(t.netExact)); }
const mm = [...month.values()].map((a) => a.reduce((x, y) => x + y, 0) / a.length);
const meanM = mm.reduce((x, y) => x + y, 0) / mm.length; const win = (100 * done.filter((t) => t.netPct > 0).length) / done.length;
const ok = done.length === 2085 && meanM.toFixed(3) === "0.256" && win.toFixed(1) === "55.3";
const text = [`REPLAY of S2 through the forward code, run ${new Date().toISOString()}`,
  `CM ${data.sessions.length} sessions ${data.sessions[0]} .. ${last}; SLB files ${slb.size}`,
  `forward code: ${done.length} finished trades, ${mm.length} months, mean of monthly means ${meanM >= 0 ? "+" : ""}${meanM.toFixed(3)}%, winners ${win.toFixed(1)}%`,
  `atlas study (one run, 12 Oct 2026): 2085 trades, 61 months, +0.256%, winners 55.3%`,
  ok ? "MATCH: the forward code is the studied rule." : "MISMATCH: the forward code differs from the study -- do not publish until explained."].join("\n");
console.log(text);
if (process.env.K2_REPLAY_OUT) fs.writeFileSync(process.env.K2_REPLAY_OUT, text + "\n");
process.exit(ok ? 0 : 1);
