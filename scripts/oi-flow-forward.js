"use strict";
// Writes docs/paper-rules/oi-flow.json: the forward paper tests of the long-unwinding bounce (LU) and
// short build-up (SB) rules (studies/oi-flow-forward-2026-10-04/PREREGISTRATION.txt).
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut node scripts/oi-flow-forward.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULE, forward } = require("../api/_lib/oi-flow-forward");
const { loadCm } = require("./springy-dip-forward");

function loadOi(dir) { const oi = new Map(); if (!fs.existsSync(dir)) return oi;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) { const d = f.slice(0, 10);
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[1] !== "STK") continue; if (!oi.has(r[0])) oi.set(r[0], new Map()); const m = oi.get(r[0]); m.set(d, (m.get(d) || 0) + r[8]); } }
  return oi; }

if (require.main === module) {
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), fut = path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "oi-flow.json"));
  const prereg = path.join(__dirname, "..", "studies", "oi-flow-forward-2026-10-04", "PREREGISTRATION.txt");
  const res = forward({ ...loadCm(cm), oi: loadOi(fut) });
  const doc = { preregistration: "studies/oi-flow-forward-2026-10-04/PREREGISTRATION.txt", preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg)).digest("hex"),
    start: RULE.start, dataThrough: res.lastSession, builtAt: new Date().toISOString(),
    LU: { rule: "Long-unwinding bounce: the share fell at least 1.56% and its futures open interest fell at least 3.04% -> buy at the next open, sell at the close 10 sessions later",
      backtest: "FAILED as a short (−1.97% / −0.85% / −1.04% a trade); the bounce is that loss read the other way, untested", pending: res.LU.pending, trades: res.LU.trades.slice(0, 300), summary: res.LU.summary },
    SB: { rule: "Short build-up: the share fell at least 1.56% and its futures open interest rose at least 3.04% -> short at the next open, cover at that day's close",
      backtest: "FAILED (+0.296% / +0.020% / +0.131% a trade; final t 1.86, not enough after 12 tests)", pending: res.SB.pending, trades: res.SB.trades.slice(0, 300), summary: res.SB.summary } };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`data through ${res.lastSession}: LU ${res.LU.pending.length} signal(s), SB ${res.SB.pending.length}; finished LU ${res.LU.summary.finished}, SB ${res.SB.summary.finished}`);
}
module.exports = { loadOi };
