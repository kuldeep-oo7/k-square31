"use strict";
// Writes docs/paper-rules/sb-strong.json: the forward paper test of strong short build-up signals
// (studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt; the night lab's member S7).
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut node scripts/sb-strong-forward.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULE, forward } = require("../api/_lib/sb-strong-forward");
const { loadCm } = require("./springy-dip-forward");
const { loadOi } = require("./oi-flow-forward");

const STUDY = path.join(__dirname, "..", "studies", "sb-strong-forward-2026-10-23");
const preregSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(STUDY, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex");

if (require.main === module) {
  const want = fs.readFileSync(path.join(STUDY, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
  if (preregSha() !== want) { console.error("studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt changed after it was fixed: nothing written."); process.exit(1); }
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), fut = path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "sb-strong.json"));
  const res = forward({ ...loadCm(cm), oi: loadOi(fut) });
  const doc = { preregistration: "studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt", preregSha256: want, start: RULE.start, dataThrough: res.lastSession, builtAt: new Date().toISOString(),
    rule: "Short build-up, strong signals only: the share fell at least 3% and its futures open interest rose at least 6% -> short at the next open, cover at that day's close",
    backtest: "PROMISING, not a pass (night lab 22 Oct 2026): 2005-2020 +0.118% a trade beyond the market, t 2.99; 2020-2026 +0.223%, t 2.73",
    pending: res.pending, trades: res.trades.slice().sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.symbol.localeCompare(b.symbol))).slice(0, 300), summary: res.summary };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`strong short build-up: data through ${res.lastSession}; ${res.pending.length} signal(s) for the next session; ${res.summary.finished} finished, ${res.summary.verdict}`);
}
module.exports = { preregSha };
