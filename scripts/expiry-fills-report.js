"use strict";
// THE EXPIRY-DAY FILL AUDIT (studies/expiry-selling-forward-2026-10-21, amendment A1): for each X2 and X4 leg of one expiry,
// the first best bid the desk recorded after 09:15 IST against the leg's official open (an achievable sale), and for a
// stopped leg the first best ask once the recorded high reached 2x (an achievable buy-back). Reported beside the registered
// result; it never changes it. Prints summary lines only (this repository is public; the books stay private).
//   node scripts/expiry-fills-report.js <YYYY-MM-DD> <orderflow day file .jsonl[.gz]> <nse-nod dir> <nse-idx dir>
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const ef = require("../api/_lib/expiry-forward");

function legsOf(day) {
  const o = day.open, rows = day.rows;
  return { X2: [ef.nearest(rows, "CE", o), ef.nearest(rows, "PE", o)], X4: [ef.nearest(rows, "CE", o * 1.01), ef.nearest(rows, "PE", o * 0.99)] };
}

// lines: the order-flow lines of that day; row = [key, ltp, oi, volume, totBuy, totSell, avg, bids, asks, feedTime, open, high, low]
function fills({ date, day, lines }) {
  const after = lines.filter((l) => l.ist >= `${date} 09:15`).sort((a, b) => (a.t < b.t ? -1 : 1));
  const out = {};
  for (const [member, legs] of Object.entries(legsOf(day))) {
    out[member] = legs.map((r) => {
      if (!r) return null;
      const [, K, typ, open, high] = r, key = `NIFTY|${date}|${K}|${typ}`, stop = 2 * open, stopped = high >= stop;   // X2 and X4 both stop at 2x
      const seen = after.map((l) => ({ ist: l.ist, row: (l.options || []).find((x) => x[0] === key) })).filter((x) => x.row);
      const first = seen.find((x) => x.row[7]?.[0]?.[0] > 0) || null;
      const hit = stopped ? seen.find((x) => (x.row[11] ?? x.row[1]) >= stop && x.row[8]?.[0]?.[0] > 0) || null : null;
      return { strike: K, type: typ, open, stopped, recorded: seen.length,
        sale: first ? { at: first.ist.slice(11), bid: first.row[7][0][0], ask: first.row[8]?.[0]?.[0] ?? null, vsOpen: +(first.row[7][0][0] - open).toFixed(2) } : null,
        buyBack: hit ? { at: hit.ist.slice(11), ask: hit.row[8][0][0], vsStop: +(hit.row[8][0][0] - stop).toFixed(2) } : null };
    });
  }
  return out;
}

function readLines(file) {
  const buf = fs.readFileSync(file); const text = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

if (require.main === module) {
  const [date, ofFile, nodDir, idxDir] = process.argv.slice(2);
  const nod = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(nodDir, `${date}.json.gz`))));
  const open = JSON.parse(fs.readFileSync(path.join(idxDir, `${date}.json`), "utf8"))["Nifty 50"]?.[0];
  const day = ef.expiryDay(nod, open);
  if (!day || !(day.open > 0)) { console.log(`${date}: not a NIFTY expiry in NSE's file, or no NIFTY open`); process.exit(0); }
  const res = fills({ date, day, lines: readLines(ofFile) });
  console.log(`EXPIRY FILL AUDIT ${date} (NIFTY open ${day.open}; the desk's first in-session build is a few minutes after 09:15)`);
  for (const [m, legs] of Object.entries(res)) for (const l of legs) {
    if (!l) { console.log(`${m}: a leg is missing in NSE's file`); continue; }
    console.log(`${m} ${l.strike} ${l.type}: official open ${l.open}; ${l.sale ? `first recorded bid ${l.sale.bid} at ${l.sale.at} (${l.sale.vsOpen >= 0 ? "+" : ""}${l.sale.vsOpen} vs the open)` : `never recorded (${l.recorded} builds)`}`
      + (l.stopped ? `; stopped at ${+(2 * l.open).toFixed(2)}: ${l.buyBack ? `first recorded ask ${l.buyBack.ask} at ${l.buyBack.at} (${l.buyBack.vsStop >= 0 ? "+" : ""}${l.buyBack.vsStop} vs the stop)` : "no recorded build saw it"}` : ""));
  }
}
module.exports = { legsOf, fills };
