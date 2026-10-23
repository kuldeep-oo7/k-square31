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

// INFORMATION ONLY (owner, 15 Oct 2026: they trade these on GM as futures, not shares). The last session's short build-up
// trades priced on futures: the earliest expiry on or after that day, as listed in NSE's F&O file (never computed), at
// NSE's official futures open and close. The registered test is unchanged and still scored on share prices.
// futDir/<day>.json rows: [symbol, "STK"|"IDX", expiryISO, open, high, low, close, settle, oi, chgOi, contracts]
function futuresLast(trades, day, futDir) {
  const that = trades.filter((t) => t.entryDate === day);
  let fut = []; try { fut = JSON.parse(fs.readFileSync(path.join(futDir, `${day}.json`), "utf8")); } catch { fut = []; }
  const rows = that.filter((t) => t.status === "DONE").map((t) => {
    const c = fut.filter((r) => r[0] === t.symbol && r[1] === "STK" && r[2] >= day).sort((a, b) => (a[2] < b[2] ? -1 : 1))[0];
    const open = c ? Number(c[3]) : NaN, close = c ? Number(c[6]) : NaN;   // Number(null) is 0: a missing price must not become 0
    return c && open > 0 && close > 0 ? { symbol: t.symbol, expiry: c[2], open, close } : { symbol: t.symbol, missing: true };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { date: day, rows, void: that.length - rows.length };
}

// INFORMATION ONLY (owner, 23 Oct 2026: "make the FUTURES box show futures-priced results"). The paper record since the
// start, every finished short build-up trade re-priced on its near-month future (the earliest expiry on or after the day in
// NSE's F&O file, official open -> official close) after futures charges; rupees at GM's minimum units, before GM's charges.
// The registered test is unchanged and still scored on share prices (futures lab, 23 Oct 2026: shares flatter a short by ~0.1%).
const { calculateNseFuturesCharges } = require("../api/_lib/shadow-broker");
function futuresRecord(trades, futDir, units = 20) {
  const done = trades.filter((t) => t.status === "DONE"), byDay = new Map(); let missing = 0; const nets = []; let rupees = 0;
  for (const t of done) { if (!byDay.has(t.entryDate)) { let rows = []; try { rows = JSON.parse(fs.readFileSync(path.join(futDir, `${t.entryDate}.json`), "utf8")); } catch { rows = []; } byDay.set(t.entryDate, rows); }
    const c = byDay.get(t.entryDate).filter((r) => r[0] === t.symbol && r[1] === "STK" && r[2] >= t.entryDate).sort((a, b) => (a[2] < b[2] ? -1 : 1))[0];
    const o = c ? Number(c[3]) : NaN, x = c ? Number(c[6]) : NaN;   // Number(null) is 0: a missing price must not become 0
    if (!(o > 0 && x > 0)) { missing += 1; continue; }
    const q = Math.ceil(500000 / o), ch = (side, p) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${t.entryDate}T12:00:00Z` }).totalCharges;
    nets.push(-(x / o - 1) - (ch("SELL", o) + ch("BUY", x)) / (o * q)); rupees += -units * (x - o); }
  const n = nets.length; return { finished: n, missing, meanNetPct: n ? +((100 * nets.reduce((a, v) => a + v, 0)) / n).toFixed(3) : null,
    winPct: n ? +((100 * nets.filter((v) => v > 0).length) / n).toFixed(1) : null, rupees: Math.round(rupees), units };
}

if (require.main === module) {
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), fut = path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "oi-flow.json"));
  const prereg = path.join(__dirname, "..", "studies", "oi-flow-forward-2026-10-04", "PREREGISTRATION.txt");
  const res = forward({ ...loadCm(cm), oi: loadOi(fut) });
  const doc = { preregistration: "studies/oi-flow-forward-2026-10-04/PREREGISTRATION.txt", preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg)).digest("hex"),
    start: RULE.start, dataThrough: res.lastSession, fnoThrough: (fs.existsSync(fut) ? fs.readdirSync(fut).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop() || "" : "").slice(0, 10) || null, builtAt: new Date().toISOString(),
    LU: { rule: "Long-unwinding bounce: the share fell at least 1.56% and its futures open interest fell at least 3.04% -> buy at the next open, sell at the close 10 sessions later",
      backtest: "FAILED as a short (−1.97% / −0.85% / −1.04% a trade); the bounce is that loss read the other way, untested", pending: res.LU.pending, trades: res.LU.trades.slice(0, 300), summary: res.LU.summary },
    SB: { rule: "Short build-up: the share fell at least 1.56% and its futures open interest rose at least 3.04% -> short at the next open, cover at that day's close",
      backtest: "FAILED (+0.296% / +0.020% / +0.131% a trade; final t 1.86, not enough after 12 tests)", pending: res.SB.pending, trades: res.SB.trades.slice(0, 300), summary: res.SB.summary,
      futuresLast: futuresLast(res.SB.trades, res.lastSession, fut), futuresRecord: futuresRecord(res.SB.trades, fut) } };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`data through ${res.lastSession}: LU ${res.LU.pending.length} signal(s), SB ${res.SB.pending.length}; finished LU ${res.LU.summary.finished}, SB ${res.SB.summary.finished}`);
}
module.exports = { loadOi, futuresLast, futuresRecord };
