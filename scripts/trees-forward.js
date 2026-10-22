"use strict";
// The trees forward paper watch (studies/trees-forward-2026-10-22/PREREGISTRATION.txt), run by .github/workflows/trees.yml.
//   node scripts/trees-forward.js due                         exit 0: a list is due (prints the feature date); 3: not due or
//                                                              already stored; 4: NSE's CM or F&O files incomplete
//   node scripts/trees-forward.js store <preds.csv> <panel.csv>  store the due list ONCE (symbols only) and score
//   node scripts/trees-forward.js score                        score the stored lists
//   node scripts/trees-forward.js replay <study-preds.csv> <live-preds.csv>   the registration's replay (exit 1 on a mismatch)
// Env: K2_CM_DIR (NSE CM bhavcopy JSON), K2_FUT_DIR (NSE F&O futures JSON), K2_STORE (default docs/paper-rules/trees.json).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { context } = require("../api/_lib/forward-v3");
const tf = require("../api/_lib/trees-forward");
const { loadCm } = require("./springy-dip-forward");   // { sessions, stocks: [{ sym, bars }] }, EQ only, as forward-v3's context needs
const { nextTradingDate } = require("./paper-ledger");

const PREREG = path.join(__dirname, "..", "studies", "trees-forward-2026-10-22", "PREREGISTRATION.txt");
const STORE = path.resolve(process.env.K2_STORE || path.join(__dirname, "..", "docs", "paper-rules", "trees.json"));
const FUT = path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut");
const FAMILIES = { price: /^P\d+$/, delivery: /^D\d$/, futures: /^F\d$/, options: /^O\d$/, shortSelling: /^X\d$/, slb: /^L\d$/, mwpl: /^W\d$/, marginTrading: /^M\d$/, insider: /^I\d$/, market: /^K\d+$/ };
const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { lists: {} }; } };
const futRows = (d) => { try { return JSON.parse(fs.readFileSync(path.join(FUT, `${d}.json`), "utf8")); } catch { return null; } };
const after = (d, n) => { let x = d; for (let k = 0; k < n; k += 1) x = nextTradingDate(x); return x; };
const csv = (f) => { const t = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean); const h = t[0].split(","); return { h, rows: t.slice(1).map((l) => l.split(",")) }; };

function due(data, store) {   // the list for the rebalance at the previous session, if tonight is its evening
  const S = data.sessions, L = S.length - 1, d = S[L - 1]; const sch = tf.schedule(S);
  if (!sch.isRebalance(L - 1)) return { due: false, why: `${d} is not a rebalance date` };
  if (store.lists[d]) return { due: false, why: `${d}: already stored, never recomputed` };
  if (!futRows(d) || !futRows(S[L])) return { due: false, missing: true, why: `NSE F&O file for ${futRows(d) ? S[L] : d} not on hand` };
  return { due: true, d, entry: nextTradingDate(S[L]) };
}
function nextList(data) {   // the next rebalance feature date and its entry, for the page
  const S = data.sessions, L = S.length - 1; const sch = tf.schedule(S); let i = L; while (!sch.isRebalance(i)) i += 1;
  const signal = i <= L ? S[i] : after(S[L], i - L); return { signalDate: signal, entry: after(signal, tf.RULE.lag) };
}
function write(store, data, ctx) {
  const { books, summary } = tf.score(store.lists, data, ctx);
  const doc = { preregistration: "studies/trees-forward-2026-10-22/PREREGISTRATION.txt",
    preregSha256: crypto.createHash("sha256").update(fs.readFileSync(PREREG, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    rule: "the combined model's gradient-boosted trees rank the top-200 stocks on 56 NSE features every 5 sessions -> buy the top tenth, sell the bottom tenth at the open two sessions later, close both 5 sessions later",
    backtest: "PROMISING, not proven: +0.117% a rebalance, t 2.78, Oct 2022 - Oct 2026 (a PASS needs t >= 3 and the deflated Sharpe)",
    dataThrough: data.sessions[data.sessions.length - 1], builtAt: new Date().toISOString(), next: nextList(data),
    latest: Object.keys(store.lists).sort().pop() || null, lists: store.lists, books: books.slice(-60), summary };
  fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(doc, null, 1));
  return doc;
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const data = loadCm(path.resolve(process.env.K2_CM_DIR || "nse-data/cm")); const store = readStore(); store.lists = store.lists || {};
  if (cmd === "due") {
    const r = due(data, store); console.log(r.due ? `due ${r.d} (entry ${r.entry})` : `not due: ${r.why}`); process.exit(r.due ? 0 : r.missing ? 4 : 3);
  } else if (cmd === "store") {
    const r = due(data, store); if (!r.due) { console.log(`not stored: ${r.why}`); process.exit(3); }
    const i = data.sessions.indexOf(r.d); const P = csv(a); const ci = P.h.indexOf("i"), cs = P.h.indexOf("sym"), cT = P.h.indexOf("T");
    const preds = new Map(); for (const x of P.rows) if (+x[ci] === i) preds.set(x[cs], +x[cT]);
    const coverage = {}; { const Q = csv(b); const qi = Q.h.indexOf("i"); const fam = Object.fromEntries(Object.entries(FAMILIES).map(([k, re]) => [k, Q.h.map((c, j) => (re.test(c) ? j : -1)).filter((j) => j >= 0)]));
      const rows = Q.rows.filter((x) => +x[qi] === i); coverage.names = rows.length;
      for (const [k, cols] of Object.entries(fam)) coverage[k] = rows.filter((x) => cols.some((j) => x[j] !== "" && Number.isFinite(+x[j]))).length; }
    const fut = futRows(r.d); const futSyms = new Set(fut.filter((x) => x[1] === "STK").map((x) => x[0])); const exit = after(r.entry, tf.RULE.h - 1);
    const contractFor = (sym, x) => fut.filter((y) => y[0] === sym && y[1] === "STK" && y[2] >= x).map((y) => y[2]).sort()[0] || null;
    store.lists[r.d] = tf.makeList({ d: r.d, entry: r.entry, exit, preds, madeAt: new Date().toISOString(), futSyms, contractFor, coverage });
    const doc = write(store, data); const l = store.lists[r.d];
    console.log(`${r.d}: stored ${l.long.length} long, ${l.short.length} short of ${l.names} names for ${l.entry} -> ${l.exit}; coverage ${JSON.stringify(coverage)}; finished ${doc.summary.finished}, ${doc.summary.verdict}`);
  } else if (cmd === "score") {
    const doc = write(store, data); console.log(`scored: finished ${doc.summary.finished}, ${doc.summary.verdict}; next list ${doc.next.signalDate} for ${doc.next.entry}`);
  } else if (cmd === "replay") {
    const S = data.sessions; const lines = [`REPLAY of the trees (studies/trees-forward-2026-10-22), run ${new Date().toISOString()}`];
    const idxOk = S[519] === "2022-10-03" && S[1509] === "2026-10-01"; lines.push(`session index: 519 = ${S[519]}, 1509 = ${S[1509]} ${idxOk ? "as the study" : "DIFFERENT"}`);
    const study = csv(a), live = csv(b); const key = (x, h) => `${x[h.indexOf("i")]}|${x[h.indexOf("sym")]}`;
    const sm = new Map(study.rows.map((x) => [key(x, study.h), x[study.h.indexOf("T")]])); const lm = new Map(live.rows.filter((x) => +x[live.h.indexOf("i")] <= 1509).map((x) => [key(x, live.h), x[live.h.indexOf("T")]]));
    let same = 0, diff = 0, onlyStudy = 0, onlyLive = 0; for (const [k, v] of sm) { if (!lm.has(k)) onlyStudy += 1; else if (lm.get(k) === v) same += 1; else diff += 1; } for (const k of lm.keys()) if (!sm.has(k)) onlyLive += 1;
    const predsOk = diff === 0 && onlyStudy === 0 && onlyLive === 0; lines.push(`predictions through 2026-10-01: ${same} identical, ${diff} different, ${onlyStudy} only in the study, ${onlyLive} only live -> ${predsOk ? "same" : "DIFFERENT"}`);
    const c1 = tf.replayC1(study.rows.map((x) => ({ i: +x[study.h.indexOf("i")], d: x[study.h.indexOf("d")], sym: x[study.h.indexOf("sym")], T: +x[study.h.indexOf("T")] })), data);
    const c1Ok = c1.rebalances === 198 && c1.meanPct.toFixed(3) === "0.117" && c1.winPct.toFixed(1) === "54.0" && c1.t.toFixed(2) === "2.78";
    lines.push(`C1 through this scoring: ${c1.rebalances} rebalances, +${c1.meanPct.toFixed(3)}% a rebalance, ${c1.winPct.toFixed(1)}% winners, t ${c1.t.toFixed(2)} (study 198, +0.117%, 54.0%, 2.78) -> ${c1Ok ? "same" : "DIFFERENT"}`);
    const ok = idxOk && predsOk && c1Ok; lines.push(ok ? "MATCH: the live pipeline is the studied model." : "MISMATCH: the watch is not shown until the cause is found.");
    console.log(lines.join("\n")); if (process.env.K2_REPLAY_OUT) fs.writeFileSync(process.env.K2_REPLAY_OUT, lines.join("\n") + "\n"); process.exit(ok ? 0 : 1);
  } else { console.error("usage: due | store <preds.csv> <panel.csv> | score | replay <study-preds.csv> <live-preds.csv>"); process.exit(2); }
}
module.exports = { due, nextList, write };
