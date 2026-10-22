"use strict";
// THE ONE CONFIRMATION (PREREGISTRATION.txt section 4; AMENDMENT-A1 section 6): the 5 non-duplicate members with the highest
// EQ t on the full board, re-scored ONCE under GM's rules on NSE 2005-2020 (release data-oos), where their inputs reach back.
// Confirmation set (RESULT.txt, full board of 21 Oct 2026): SB short build-up; CM1 trees long-short; LU long-unwinding
// bounce; S2 borrowing surge; SD springy dip. A member passes the confirmation with mean > 0 and t >= 2 (section 4).
//   K2_OOS_NSE=<dir with cm/ and fut/> node confirm.js        (writes CONFIRMATION.txt, confirmation.json: summary rows only)
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const { gm, board } = require("./run");   // verifies the registration and both amendments on load
const { loadCm } = require(path.join(ROOT, "scripts/springy-dip-forward"));

const START = "2005-01-01";
const SET = ["SB short build-up", "CM1 trees long-short", "LU long-unwinding bounce", "S2 borrowing surge", "SD springy dip"];
const NOT_CONFIRMABLE = {
  "CM1 trees long-short": "its walk-forward predictions start Oct 2022 and its features (SLB, margin trading, insider filings, category turnover) do not exist in 2005-2020",
  "S2 borrowing surge": "NSE's SLB open-position files are not in data-oos (the atlas has them from Sep 2020 only)"
};

function load(dir) {
  const data = loadCm(path.join(dir, "cm")); const bySym = new Map(data.stocks.map((s) => [s.sym, s]));
  const idx = new Map(data.stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const oi = new Map(), expOn = new Map(); const futDir = path.join(dir, "fut");
  for (const f of fs.readdirSync(futDir).filter((x) => x.endsWith(".json"))) { const d = f.slice(0, 10);
    for (const r of JSON.parse(fs.readFileSync(path.join(futDir, f), "utf8"))) { if (r[1] !== "STK") continue;
      if (!oi.has(r[0])) oi.set(r[0], new Map()); const m = oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
      const k = `${r[0]}|${d}`; const e = expOn.get(k); if (r[2] >= d && (!e || r[2] < e)) expOn.set(k, r[2]); } }
  return { ...data, bySym, idx, oi, expiryFor: (sym, d) => expOn.get(`${sym}|${d}`) || null };
}

if (require.main === module) {
  const lines = []; const log = (s) => { lines.push(s); console.log(s); };
  const dir = path.resolve(process.env.K2_OOS_NSE || "nse-old");
  log(`GM TOURNAMENT -- THE ONE CONFIRMATION on NSE ${START} .. 2020-10 (registration section 4, A1 section 6), run ${new Date().toISOString()}`);
  const data = load(dir); log(`DATA: ${data.sessions.length} sessions ${data.sessions[0]} .. ${data.sessions.at(-1)}, ${data.stocks.length} stocks, futures OI for ${data.oi.size}`);
  const T = [];
  { const ofw = require(path.join(ROOT, "api/_lib/oi-flow-forward")); const r = ofw.forward({ sessions: data.sessions, stocks: data.stocks, oi: data.oi, rule: { ...ofw.RULE, start: START } });
    for (const k of ["SB", "LU"]) { const done = r[k].trades.filter((t) => t.status === "DONE");
      for (const t of done) T.push({ member: k === "SB" ? SET[0] : SET[2], sym: t.symbol, side: ofw.RULE.rules[k].side, entryDay: t.entryDate, exitDay: t.exitDate }); log(` ${k}: ${done.length} trades`); } }
  { const sdm = require(path.join(ROOT, "api/_lib/springy-dip")); const r = sdm.forward({ sessions: data.sessions, stocks: data.stocks, rule: { ...sdm.RULE, start: START } });
    const done = (r.trades || []).filter((t) => t.status === "DONE"); for (const t of done) T.push({ member: SET[4], sym: t.symbol, side: 1, entryDay: t.entryDate, exitDay: t.exitDate }); log(` SD: ${done.length} trades`); }
  const scored = T.map((t) => gm(t, data)); const lb = board(scored);
  log("\nGM SCORE ON 2005-2020 (same scorer: expiry cut from NSE's F&O files, 20 units and Rs 5 lakh a position, NSE futures charges):");
  const fmtR = (r) => `${r.member.padEnd(26)} ${String(r.trades).padStart(6)} tr | GM 20u ${r.u20 >= 0 ? "+" : "-"}Rs ${Math.abs(Math.round(r.u20)).toLocaleString("en-IN")} | ${r.pctMean >= 0 ? "+" : ""}${r.pctMean.toFixed(3)}%/tr | won ${r.win.toFixed(0)}% | monthly mean ${r.monthMean?.toFixed(3) ?? "-"}% | t ${r.t?.toFixed(2) ?? "-"}`;
  const rows = SET.map((m) => { const r = lb.find((x) => x.member === m); if (NOT_CONFIRMABLE[m]) return { member: m, verdict: "NOT CONFIRMABLE", why: NOT_CONFIRMABLE[m] };
    if (!r || r.t === undefined) return { member: m, verdict: "NOT CONFIRMABLE", why: "too few months" };
    const ok = r.monthMean > 0 && r.t >= 2; log(`${fmtR(r)} -> ${ok ? "CONFIRMED (mean > 0, t >= 2)" : "NOT CONFIRMED"}`);
    return { member: m, trades: r.trades, u20: Math.round(r.u20), pctMean: +r.pctMean.toFixed(4), monthMean: +r.monthMean.toFixed(4), t: +r.t.toFixed(2), win: +r.win.toFixed(1), verdict: ok ? "CONFIRMED" : "NOT CONFIRMED" }; });
  for (const r of rows.filter((x) => x.verdict === "NOT CONFIRMABLE")) log(`${r.member}: NOT CONFIRMABLE (${r.why})`);
  // periods (reported, not judged)
  log("\nBY PERIOD (monthly mean of EQ rupees / Rs 5 lakh, %; reported, not judged):");
  for (const m of SET.filter((x) => !NOT_CONFIRMABLE[x])) { const ts = scored.filter((r) => r && !r.void && r.member === m);
    log(` ${m}: ` + [["2005-01", "2009-12"], ["2010-01", "2014-12"], ["2015-01", "2020-12"]].map(([a, b]) => { const x = ts.filter((t) => t.entryDay.slice(0, 7) >= a && t.entryDay.slice(0, 7) <= b);
      const mon = new Map(); for (const t of x) mon.set(t.entryDay.slice(0, 7), (mon.get(t.entryDay.slice(0, 7)) || 0) + t.eq / 5000); const s = [...mon.values()];
      return `${a.slice(0, 4)}-${b.slice(2, 4)} ${x.length} tr, ${s.length ? (s.reduce((p, q) => p + q, 0) / s.length).toFixed(3) : "-"}%`; }).join(" | ")); }
  log("\nREADING: SB, LU and SD were already run on these years on 5 Oct 2026 (studies/oos-replication-2026-10-05), so this is a GM re-score of examined data, not unseen data (A1 6). No member PASSED the full board, so none becomes a GM paper candidate whatever this shows (registration section 4).");
  fs.writeFileSync(path.join(HERE, "CONFIRMATION.txt"), lines.join("\n") + "\n"); fs.writeFileSync(path.join(HERE, "confirmation.json"), JSON.stringify({ start: START, rows }, null, 1));
}
