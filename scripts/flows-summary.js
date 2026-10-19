"use strict";
// FII / DII CASH FLOWS FOR THE PAGE (owner, 19 Oct 2026: FII selling dragged the index). NSE's own provisional figures,
// one file per session saved by scripts/nse-fii-dii.js (NSE keeps only the latest day, so the history is ours, from the
// first day we saved). Information only, not a signal: no tested rule reads it.
//   node scripts/flows-summary.js <nse-flows dir> <out.json>
const fs = require("node:fs");
const path = require("node:path");

function summarise(dir) {
  const days = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return { date: j.date || f.slice(0, 10), fii: j.FII?.net ?? null, dii: j.DII?.net ?? null }; } catch { return null; }
  }).filter((x) => x && Number.isFinite(x.fii) && Number.isFinite(x.dii));
  const sum = (k) => Math.round(days.reduce((a, x) => a + x[k], 0) * 100) / 100;
  return { source: "NSE fiidiiTradeReact (provisional, cash market), saved daily from the first day below", unit: "Rs crore",
    since: days[0]?.date || null, sessions: days.length, fiiTotal: sum("fii"), diiTotal: sum("dii"), days: days.slice(-30) };
}

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  const s = summarise(dir); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(s, null, 1));
  console.log(`flows: ${s.sessions} sessions from ${s.since}; FII ${s.fiiTotal}, DII ${s.diiTotal} (Rs crore)`);
}
module.exports = { summarise };
