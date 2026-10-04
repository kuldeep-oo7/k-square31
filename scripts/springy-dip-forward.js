"use strict";
// Writes docs/paper-rules/springy-dip.json: the forward paper test of the OWN "springy dip" rule
// (studies/springy-dip-forward-2026-10-04/PREREGISTRATION.txt), from NSE's own CM bhavcopy files.
//   K2_CM_DIR=nse-data/cm node scripts/springy-dip-forward.js
// Run by .github/workflows/springy-dip.yml every weekday morning, before the open.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULE, forward } = require("../api/_lib/springy-dip");

function loadCm(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const sessions = files.map((f) => f.slice(0, 10));
  const bySym = new Map();
  for (const f of files) {
    const d = f.slice(0, 10);
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      const [, sym, series, o, h, l, c, , , val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] });
      bySym.get(sym).bars.push({ d, o, h, l, c, val });
    }
  }
  return { sessions, stocks: [...bySym.values()] };
}

if (require.main === module) {
  const dir = path.resolve(process.env.K2_CM_DIR || "nse-data/cm");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "springy-dip.json"));
  const prereg = path.join(__dirname, "..", "studies", "springy-dip-forward-2026-10-04", "PREREGISTRATION.txt");
  const data = loadCm(dir);
  const res = forward(data);
  const doc = {
    rule: "OWN springy dip: lag-1 autocorrelation (120 bars) < -0.05 AND close at least 2 standard deviations under its 20-day average; buy at the open, sell at the close 5 sessions later",
    preregistration: "studies/springy-dip-forward-2026-10-04/PREREGISTRATION.txt",
    preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg)).digest("hex"),
    backtest: { verdict: "FAIL (too weak to rule out luck)", developmentPct: 0.551, validationPct: 0.663, finalPct: 0.209, finalT: 0.41, finalTrades: 639, study: "research/dip-ml-2026-10-04" },
    start: RULE.start, dataThrough: res.lastSession, builtAt: new Date().toISOString(),
    pending: res.pending, trades: res.trades.slice(0, 400), summary: res.summary
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`data through ${res.lastSession}: ${res.pending.length} signal(s) for the next session; ${res.summary.finished} finished, verdict ${res.summary.verdict}`);
}

module.exports = { loadCm };
