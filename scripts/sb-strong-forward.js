"use strict";
// Writes docs/paper-rules/sb-strong.json: the forward paper test of strong short build-up signals
// (studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt + AMENDMENT-A1.txt: priced on futures; the night lab's S7).
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut node scripts/sb-strong-forward.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULE, forward } = require("../api/_lib/sb-strong-forward");
const { loadCm } = require("./springy-dip-forward");
const { loadOi } = require("./oi-flow-forward");

const STUDY = path.join(__dirname, "..", "studies", "sb-strong-forward-2026-10-23");
const FILES = ["PREREGISTRATION", "AMENDMENT-A1"];
const shaOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(STUDY, `${f}.txt`), "utf8").replace(/\r\n/g, "\n")).digest("hex");
const preregSha = () => shaOf("PREREGISTRATION");
// NSE's F&O files: each stock's earliest expiry on or after the day, at its official open and close (as futuresLast)
function loadFutPx(dir) { const out = new Map(); if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) { const d = f.slice(0, 10), near = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[1] !== "STK" || r[2] < d) continue; const o = Number(r[3]), c = Number(r[6]);   // Number(null) is 0: never a price
      if (!(o > 0 && c > 0)) continue; if (!near.has(r[0]) || r[2] < near.get(r[0]).e) near.set(r[0], { e: r[2], o, c }); }
    out.set(d, new Map([...near].map(([s, v]) => [s, { o: v.o, c: v.c }]))); }
  return out; }

if (require.main === module) {
  for (const f of FILES) { const want = fs.readFileSync(path.join(STUDY, `${f}.sha256`), "utf8").split(/\s+/)[0];
    if (shaOf(f) !== want) { console.error(`studies/sb-strong-forward-2026-10-23/${f}.txt changed after it was fixed: nothing written.`); process.exit(1); } }
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), fut = path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "sb-strong.json"));
  const res = forward({ ...loadCm(cm), oi: loadOi(fut), futPx: loadFutPx(fut) });
  const doc = { preregistration: "studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt", amendment: "studies/sb-strong-forward-2026-10-23/AMENDMENT-A1.txt",
    preregSha256: shaOf("PREREGISTRATION"), amendmentSha256: shaOf("AMENDMENT-A1"), start: RULE.start, dataThrough: res.lastSession, builtAt: new Date().toISOString(),
    rule: "Short build-up, strong signals only: the share fell at least 3% and its futures open interest rose at least 6% -> short the near-month future at the next open, cover at that day's close",
    backtest: "PROMISING, not a pass (night lab 22 Oct 2026, priced on shares): 2005-2020 +0.118% a trade beyond the market, t 2.99; 2020-2026 +0.223%, t 2.73. On futures the same trades earn about 0.1% less (descriptive look, 23 Oct)",
    pending: res.pending, trades: res.trades.slice().sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.symbol.localeCompare(b.symbol))).slice(0, 300), summary: res.summary };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`strong short build-up (futures): data through ${res.lastSession}; ${res.pending.length} signal(s) for the next session; ${res.summary.finished} finished, ${res.summary.verdict}`);
}
module.exports = { preregSha, shaOf, loadFutPx };
