"use strict";
// The daily part of the AI day-trader paper test (studies/daytrader-forward-2026-10-26/PREREGISTRATION.txt): every universe
// stock future from 2026-10-26 with its 18 features (only what was known at 09:15); the frozen model's probabilities come
// from scripts/daytrader-predict.py; then the daily books.
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut K2_IDX_DIR=nse-idx node scripts/daytrader-forward.js --features WORK
//   python scripts/daytrader-predict.py MODEL.pkl WORK
//   node scripts/daytrader-forward.js --assemble WORK      -> docs/paper-rules/daytrader.json
// WORK (features, probabilities) stays on the runner; the public file carries dates, book results and the top 3 a side.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const L = require("../api/_lib/daytrader-forward");

const STUDY = path.join(__dirname, "..", "studies", "daytrader-forward-2026-10-26");
const shaOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(STUDY, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");

if (require.main === module) {
  const [mode, work] = [process.argv[2], path.resolve(process.argv[3] || "work")];
  const want = fs.readFileSync(path.join(STUDY, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
  if (shaOf("PREREGISTRATION.txt") !== want) { console.error("studies/daytrader-forward-2026-10-26/PREREGISTRATION.txt changed after it was fixed: nothing written."); process.exit(1); }
  if (mode === "--features") {
    const P = { ...L.readCm(path.resolve(process.env.K2_CM_DIR || "nse-data/cm")), oi: new Map(), fnear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
    L.readFut(path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut"), P); L.readIdx(path.resolve(process.env.K2_IDX_DIR || "nse-idx"), P);
    const r = L.rows(P); fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, "x.csv"), L.toCsv(r.rows));
    fs.writeFileSync(path.join(work, "rows.json"), JSON.stringify({ lastSession: r.lastSession, rows: r.rows.map(({ features, ...x }) => x) }));
    console.log(`daytrader: data through ${r.lastSession}; ${r.rows.length} stock-days on ${new Set(r.rows.map((x) => x.date)).size} sessions since ${L.RULE.start}`); process.exit(0); }
  if (mode === "--assemble") {
    const { lastSession, rows } = JSON.parse(fs.readFileSync(path.join(work, "rows.json"), "utf8")); const prob = new Map();
    for (const l of fs.readFileSync(path.join(work, "p.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [id, p] = l.split(","); if (id) prob.set(id, +p); }
    const days = L.books(rows, prob); const doc = { preregistration: "studies/daytrader-forward-2026-10-26/PREREGISTRATION.txt", preregSha256: want, fit: "studies/daytrader-forward-2026-10-26/FIT.txt",
      start: L.RULE.start, dataThrough: lastSession, builtAt: new Date().toISOString(),
      rule: "AI day-trader: a trees model ranks every universe stock future from what is known at 09:15; long the top tenth, short the bottom tenth, open to close, on futures",
      backtest: "PASSED 2008-2020 (+0.25% a day, t 13.96) and CONFIRMED 2020-2026 (+0.10%, t 6.09), but decayed to +0.01% a day (t 0.63) from 8 Dec 2025 (audit 23 Oct 2026); spreads not modelled",
      days: days.slice().reverse().slice(0, 120), summary: L.summary(days) };
    const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "daytrader.json")); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
    console.log(`daytrader: data through ${lastSession}; ${doc.summary.sessions} sessions scored, ${doc.summary.verdict}`); process.exit(0); }
  console.error("usage: node scripts/daytrader-forward.js --features WORK | --assemble WORK"); process.exit(1);
}
module.exports = { shaOf };
