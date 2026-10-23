"use strict";
// The daily part of the trees paper test (studies/sb-trees-forward-2026-10-23/PREREGISTRATION.txt): every short build-up
// trade from 2026-10-23 with its 17 features (only what was known at 09:15) and its futures result; the frozen model's
// TAKE/SKIP comes from scripts/sb-trees-predict.py.
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut K2_IDX_DIR=nse-idx node scripts/sb-trees-forward.js --features WORK
//   python scripts/sb-trees-predict.py MODEL.pkl WORK
//   node scripts/sb-trees-forward.js --assemble WORK      -> docs/paper-rules/sb-trees.json
// WORK holds the features and the decisions on the runner only; the public file carries symbols, dates, TAKE/SKIP, NSE's
// futures prices and results -- no probabilities.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const L = require("../api/_lib/sb-trees-forward");

const STUDY = path.join(__dirname, "..", "studies", "sb-trees-forward-2026-10-23");
const shaOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(STUDY, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
function loadCmV(dir) {   // EQ bars with volume and traded value (as the futures lab's readCm)
  const P = { sessions: [], bySym: new Map() };
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
  return { sessions: P.sessions, stocks: [...P.bySym.values()] };
}

if (require.main === module) {
  const [mode, work] = [process.argv[2], path.resolve(process.argv[3] || "work")];
  const want = fs.readFileSync(path.join(STUDY, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
  if (shaOf("PREREGISTRATION.txt") !== want) { console.error("studies/sb-trees-forward-2026-10-23/PREREGISTRATION.txt changed after it was fixed: nothing written."); process.exit(1); }
  if (mode === "--features") {
    const P = { ...loadCmV(path.resolve(process.env.K2_CM_DIR || "nse-data/cm")), oi: new Map(), fnear: new Map(), futNear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
    L.readFut(path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut"), P); L.readIdx(path.resolve(process.env.K2_IDX_DIR || "nse-idx"), P);
    const r = L.rows(P); fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, "x.csv"), L.toCsv(r.rows));
    fs.writeFileSync(path.join(work, "rows.json"), JSON.stringify({ lastSession: r.lastSession, rows: r.rows.map(({ features, ...x }) => x) }));
    console.log(`sb-trees: data through ${r.lastSession}; ${r.rows.filter((x) => x.status === "DONE").length} short build-up trades to decide since ${L.RULE.start}`); process.exit(0); }
  if (mode === "--assemble") {
    const { lastSession, rows } = JSON.parse(fs.readFileSync(path.join(work, "rows.json"), "utf8")); const take = new Map();
    for (const l of fs.readFileSync(path.join(work, "take.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [id, t] = l.split(","); if (id) take.set(id, t === "1"); }
    const pct = (x) => +(x * 100).toFixed(3);
    const trades = rows.map((x) => (x.status !== "DONE" ? { symbol: x.symbol, entryDate: x.entryDate, status: x.status }
      : take.has(x.id) ? { symbol: x.symbol, entryDate: x.entryDate, decision: take.get(x.id) ? "TAKE" : "SKIP", entry: x.entry, exit: x.exit, netPct: pct(x.net), excessPct: pct(x.excess), rupees: x.rupees, status: "DONE" }
        : { symbol: x.symbol, entryDate: x.entryDate, status: "NO DECISION" }));
    const done = rows.filter((x) => x.status === "DONE" && take.has(x.id)).map((x) => ({ entryDate: x.entryDate, take: take.get(x.id), net: x.net, excess: x.excess, rupees: x.rupees }));
    const doc = { preregistration: "studies/sb-trees-forward-2026-10-23/PREREGISTRATION.txt", preregSha256: want, fit: "studies/sb-trees-forward-2026-10-23/FIT.txt", start: L.RULE.start, dataThrough: lastSession, builtAt: new Date().toISOString(),
      rule: "Short build-up, the trees model's picks: every short build-up signal gets TAKE or SKIP from a model frozen on 2006-2026 data, using only what is known at 09:15; priced on the near-month future",
      backtest: "PROMISING, not a pass (futures lab, 23 Oct 2026): the TAKE half beat the SKIP half by +0.191% a trade in 2008-2020 (t 6.31, DSR 0.94) and +0.111% in 2020-2026 (t 2.63)",
      trades: trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.symbol.localeCompare(b.symbol))).slice(0, 400), summary: L.summary(done) };
    const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "sb-trees.json")); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
    console.log(`sb-trees: data through ${lastSession}; ${doc.summary.counted} counted (${doc.summary.taken ?? 0} taken), ${doc.summary.verdict}`); process.exit(0); }
  console.error("usage: node scripts/sb-trees-forward.js --features WORK | --assemble WORK"); process.exit(1);
}
module.exports = { loadCmV, shaOf };
