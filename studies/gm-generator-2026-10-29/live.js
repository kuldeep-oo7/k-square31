"use strict";
// The GM strategy generator, LIVE as WATCH ONLY (owner, 30 Oct 2026: "it should be live before I reach the office and
// show me the stocks"). NOT PROVEN: the registered run (Actions 40916027827) gave 0 PASS -- 2008-2020 long t 4.74, short
// t 3.25 (PROMISING), 2020-2026 long t -0.33, short t 0.90 (not confirmed). This applies the current year's rules (picked
// each January from the past only; result.json) to the latest complete week, with run.js's blocks and ranking unchanged,
// and writes the 5 long and 5 short picks for the next GM week.
//   node live.js OUT.json      K2_CM_DIR = NSE bhavcopy archive (nse-data/cm); K2_FUT_DIR = NSE F&O futures files (nse-fo/fut)
const fs = require("node:fs");
const path = require("node:path");
const G = require("./run.js");
const WL = require(path.join(__dirname, "..", "gm-weekly-lab-2026-10-29", "run.js"));

const NIFTY = "^NIFTY", BOOK = 5, FROM = "2023-06-01";
const jsonDays = (dir) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x >= FROM).sort();
function load(cmDir, futDir) {   // run.js's loaders (same rows, same filters), from FROM onward
  const P = { sessions: [], bySym: new Map(), fnear: new Map(), fc: new Map(), oi: new Map() };
  for (const f of jsonDays(cmDir)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
  const have = new Set(P.sessions);
  for (const f of jsonDays(futDir)) { const d = f.slice(0, 10); if (!have.has(d)) continue; const near = new Map(), fcs = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(futDir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0)); }
      const sym = r[1] === "STK" ? r[0] : r[1] === "IDX" && r[0] === "NIFTY" ? NIFTY : null; if (!sym || !(r[2] >= d)) continue;
      const o = Number(r[3]), c = Number(r[6]);
      if (c > 0) { if (!fcs.has(sym)) fcs.set(sym, []); fcs.get(sym).push([r[2], c]); }
      if (o > 0 && c > 0 && (!near.has(sym) || r[2] < near.get(sym).e)) near.set(sym, { e: r[2], o, c }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } } }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

if (require.main === module) {
  const out = process.argv[2]; if (!out) { console.error("usage: node live.js OUT.json"); process.exit(1); }
  const P = load(path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut"));
  const lastDate = P.sessions.at(-1); P.from = addDays(lastDate, -200); P.to = lastDate;
  const C = WL.context(P), ST = WL.studied(P, C), F = new Map();
  for (const [sym, t] of ST) { const f = G.featuresOf(P, C, sym, t.bars), mOf = new Map(); f.X.wk.forEach((w, m) => mOf.set(w, m)); F.set(sym, { ...f, mOf }); }
  const ns = G.niftySig(P, C), last = C.S.length - 1, wl = C.wkOf[last];
  const sig = new Date(`${lastDate}T00:00:00Z`).getUTCDay() === 5 ? wl : wl - 1, trade = sig + 1;   // the latest COMPLETE week signals the next one
  const known = trade < C.W.length; if (!known) C.W.push({ key: addDays(C.W[sig].key, 7), first: last, last });   // not yet in the data: the latest month's universe
  const recs = G.weekRecords(C, F, ns, trade), monday = C.W[trade].key, year = +monday.slice(0, 4);
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, "result.json"), "utf8")), sel = (R.rules || []).find((x) => x.Y === year);
  const byName = new Map(G.CONDS.map((_, c) => [G.cname(c), c])), mask = (c) => G.CONDS[c].reduce((m, i) => (m | (1 << i)) >>> 0, 0);
  const rules = (side) => (sel ? sel[side] : []).map((x) => ({ rule: x.rule, t: x.t, c: byName.get(x.rule) })).filter((x) => x.c !== undefined);
  const L = rules("long"), S = rules("short"), long = [], short = [];
  const plain = (c) => G.CONDS[c].map((i) => G.BLOCKS[i].split(" ").slice(1).join(" ")).join(" + ");
  for (const r of recs) { const fl = L.filter((x) => (r.bits & mask(x.c)) >>> 0 === mask(x.c)), fs_ = S.filter((x) => (r.bits & mask(x.c)) >>> 0 === mask(x.c));
    const sl = fl.reduce((a, x) => a + x.t, 0), sh = fs_.reduce((a, x) => a + x.t, 0); if (sl > 0 && sh > 0) continue;
    if (sl > 0) long.push({ symbol: r.sym, score: +sl.toFixed(2), why: fl.map((x) => plain(x.c)) });
    if (sh > 0) short.push({ symbol: r.sym, score: +sh.toFixed(2), why: fs_.map((x) => plain(x.c)) }); }
  const top = (xs) => xs.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1)).slice(0, BOOK);
  const doc = {
    study: "studies/gm-generator-2026-10-29 (branch claude/gm-generator-2026-10-29)",
    registration: fs.readFileSync(path.join(__dirname, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0],
    verdict: "0 PASS. 2008-2020: long t 4.74, short t 3.25 (PROMISING). 2020-2026: long t -0.33, short t 0.90 (not confirmed).",
    rule: "each January the machine ranks 930 chart rules on the past only and keeps the best 5 long and 5 short; each week the stocks they pick most strongly: buy 5, sell 5 at Monday's open, booked at Friday's close (GM's week), cut at expiry",
    rulesYear: sel ? year : null, rules: { long: L.map(({ rule, t }) => ({ rule, t })), short: S.map(({ rule, t }) => ({ rule, t })) },
    dataThrough: lastDate, signalWeek: { from: C.S[C.W[sig].first], to: C.S[C.W[sig].last] }, tradeWeek: { monday, inData: known },
    universe: recs.length, long: top(long), short: top(short), builtAt: new Date().toISOString() };
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
  console.log(`gm-generator live: data through ${lastDate}; signal week ${doc.signalWeek.from}..${doc.signalWeek.to}; week of ${monday}; rules ${doc.rulesYear}; ${recs.length} stocks ranked; long ${doc.long.length}, short ${doc.short.length}`);
}
