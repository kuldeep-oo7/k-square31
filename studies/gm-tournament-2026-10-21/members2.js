"use strict";
// Amendments A1 and A2: the rest of phase 1 and phase 2, every member from its OWN code.
// Where a study's code does not report the symbol, the exit session or its own prices, a text patch adds those fields to
// its trade record at load time (A1 3c): each patch must match exactly once, and the committed files are not edited.
// Replay check (A1 5.4): the patched run must equal the unpatched run (count and sum of net per member), and the
// unpatched run must equal the study's published result (trade counts); otherwise the study is NOT SCORABLE.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE_FROM = "2020-10-01", OWN_DATA_END = "2026-10-01";   // the studies of 2-4 Oct 2026 ran on data through 1 Oct

function patchSource(src, patches, label) {
  for (const [from, to] of patches) { const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`${label}: a patch matched ${n} times (${from.slice(0, 60)}...)`); src = src.replace(from, () => to); }
  return src;
}
// a file's code up to `cut`, with patches, run with its own require and __dirname; returns what `exportExpr` names
function loadFile(file, { patches = [], cut = 'if (process.argv.includes("--synthetic"))', exportExpr }) {
  const src = patchSource(fs.readFileSync(file, "utf8"), patches, path.relative(ROOT, file)); const at = src.indexOf(cut);
  if (at < 0) throw new Error(`${path.relative(ROOT, file)}: no cut point`);
  const m = { exports: {} };
  new Function("require", "module", "__dirname", "process", `${src.slice(0, at).replace(/^"use strict";/, "")}\nmodule.exports = ${exportExpr};`)(createRequire(file), m, path.dirname(file), process);
  return m.exports;
}
const studyFile = (dir) => path.join(ROOT, "studies", dir, "study.js");
const RUN = "{ run, MEMBERS: typeof MEMBERS === 'undefined' ? null : MEMBERS }";

// data truncated to the studies' own end (so their published counts can be reproduced)
function own(data) {
  const sessions = data.sessions.filter((d) => d <= OWN_DATA_END);
  const stocks = data.stocks.map((s) => ({ ...s, bars: s.bars.filter((b) => b.d <= OWN_DATA_END) })).filter((s) => s.bars.length);
  return { sessions, stocks };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const byMember = (trades, val) => { const m = new Map(); for (const t of trades) { const k = t.member; if (!m.has(k)) m.set(k, { n: 0, s: 0 }); const r = m.get(k); r.n += 1; r.s += val(t); } return m; };
function sameRun(a, b, val) { const A = byMember(a, val), B = byMember(b, val); if (A.size !== B.size) return false;
  for (const [k, r] of A) { const q = B.get(k); if (!q || q.n !== r.n || Math.abs(q.s - r.s) > 1e-9 * Math.max(1, Math.abs(r.s))) return false; } return true; }
function publishedCounts(dir) {   // per member: the trades in its published result
  const rj = path.join(ROOT, "studies", dir, "result.json");
  if (fs.existsSync(rj)) { const v = JSON.parse(fs.readFileSync(rj, "utf8")).verdicts; const out = new Map();
    for (const [k, w] of Object.entries(v)) out.set(k, ["development", "validation", "final"].reduce((a, x) => a + (w[x]?.trades || 0), 0)); return out; }
  const txt = fs.readFileSync(path.join(ROOT, "studies", dir, "RESULT.txt"), "utf8"); const out = new Map();
  for (const l of txt.split(/\r?\n/)) { const m = /^(G\d [^|]+?)\s*\|.*\((\d+) trades,/.exec(l); if (m) out.set(m[1].trim(), +m[2]); }
  return out;
}

// A1 5.4 for one patched study: returns { trades (patched), ok, line }
function replayed(dir, label, runIt, patches, val = (t) => t.net) {
  const plain = runIt(loadFile(studyFile(dir), { exportExpr: RUN })), withFields = runIt(loadFile(studyFile(dir), { patches, exportExpr: RUN }));
  const same = sameRun(plain, withFields, val);
  const pub = publishedCounts(dir); const now = byMember(plain, () => 0); const diffs = [];
  for (const [k, n] of pub) { const got = now.get(k)?.n || 0; if (got !== n) diffs.push(`${k.split(" ")[0]} ${got} vs ${n}`); }
  const ok = same && !diffs.length;
  return { trades: withFields, ok, line: ` 5.4 ${label}: patch adds fields only ${same ? "yes" : "NO"}; published trade counts ${diffs.length ? `DIFFER (${diffs.join(", ")})` : "equal"} -> ${ok ? "SCORABLE" : "NOT SCORABLE"}` };
}

// a study's trade (with the added fields) -> GM trades; options members carry no symbol and are out (registration 2)
function toGm(prefix, t, sideOf) {
  const member = prefix ? `${prefix} ${t.member}` : t.member;
  if (t.legs) return t.legs.map((g) => ({ member, sym: g.sym, side: g.side, entryDay: t.day, exitDay: g.exitDay, entryPx: g.entryPx, exitPx: g.exitPx }));
  if (!t.sym || !t.exitDay) return [];
  return [{ member, sym: t.sym, side: t.side ?? sideOf(t.member), entryDay: t.day, exitDay: t.exitDay, entryPx: t.entryPx, exitPx: t.exitPx }];
}
const SIDE = { D1: 1, D2: -1, D3: 1, D4: 1, D5: 1, D6: 1, E1: 1, E2: -1, E3: 1, E4: -1 };

const ADD4 = ["const add = (k, d, net) => { const w = windowOf(d); if (w && Number.isFinite(net)) trades.push({ member: MEMBERS[k], day: d, window: w, net }); };",
  "const add = (k, d, net, meta) => { const w = windowOf(d); if (w && Number.isFinite(net)) trades.push({ member: MEMBERS[k], day: d, window: w, net, ...meta }); };"];
const PATCHES = {
  rising: [["trades.push({ member, sym: st.sym, day: d, window: win, net: gross - cost / (t.entry * qty), gross });",
    "trades.push({ member, sym: st.sym, day: d, window: win, net: gross - cost / (t.entry * qty), gross, side: long ? 1 : -1, entryPx: t.entry, exitPx: t.exit, exitDay });"]],
  dipml: [["const trades = []; const add = (r, k, net) => { if (r.win) trades.push({ member: MEMBERS[k], day: r.d, window: r.win, net }); };",
    "const trades = []; const add = (r, k, net) => { if (r.win) trades.push({ member: MEMBERS[k], day: r.d, window: r.win, net, sym: r.sym, exitDay: k === 5 ? r.d : r.endDay }); };"]],
  orderflow: [["trades.push({ member: MEMBERS[kind * 2 + off], day: x.d, window: x.win, net:", "trades.push({ sym: x.st.sym, side: long ? 1 : -1, exitDay: b[j].d, member: MEMBERS[kind * 2 + off], day: x.d, window: x.win, net:"],
    ["trades.push({ member: MEMBERS[8 + (side > 0 ? 0 : 2) + off], day: d, window: win, net:", "trades.push({ sym: \"NIFTY\", side, exitDay: ed, member: MEMBERS[8 + (side > 0 ? 0 : 2) + off], day: d, window: win, net:"]],
  families: [ADD4,
    ["if (up) add(0, d, g - cost); else if (dn) add(1, d, -g - cost); } }",
      "if (up) add(0, d, g - cost, { sym: st.sym, side: 1, exitDay: b[i + 4].d }); else if (dn) add(1, d, -g - cost, { sym: st.sym, side: -1, exitDay: b[i + 4].d }); } }"],
    ["add(k, entryD, side * (x / e - 1) - futCost(e, x, entryD, exitD, crossings(entryD, exitD))); };",
      "add(k, entryD, side * (x / e - 1) - futCost(e, x, entryD, exitD, crossings(entryD, exitD)), { sym: \"NIFTY\", side, exitDay: exitD }); };"],
    ["add(mi, d, side * (z[6] / e[3] - 1) - futCost(e[3], z[6], d, x)); } }", "add(mi, d, side * (z[6] / e[3] - 1) - futCost(e[3], z[6], d, x), { sym: c.sym, side, exitDay: x }); } }"],
    ["crossings(open.e, xd)) + futCost(open.eb, xb, open.e, xd, crossings(open.e, xd))) / 2);",
      "crossings(open.e, xd)) + futCost(open.eb, xb, open.e, xd, crossings(open.e, xd))) / 2, { legs: [{ sym: sa, side: -open.sign, exitDay: xd, exitPx: xa }, { sym: sb, side: open.sign, exitDay: xd, exitPx: xb }] });"]],
  results: [ADD4, ["ev.push({ d: entry.d, reaction:", "ev.push({ sym: e.sym, d: entry.d, reaction:"],
    ["if (x.reaction >= hi) add(0, x.d, g - c); else if (x.reaction <= lo) add(1, x.d, -g - c); }",
      "if (x.reaction >= hi) add(0, x.d, g - c, { sym: x.sym, side: 1, exitDay: x.xd }); else if (x.reaction <= lo) add(1, x.d, -g - c, { sym: x.sym, side: -1, exitDay: x.xd }); }"]],
  rating: [["const add = (k, d, v) => { if (Number.isFinite(v)) out.get(MEMBERS[k]).push({ day: d, v }); };",
    "const add = (k, d, v, meta) => { if (Number.isFinite(v)) out.get(MEMBERS[k]).push({ day: d, v, ...meta }); };"],
    ["add(long ? 0 : 2, d, netOf(long ? 1 : -1, g.e, g.x, d, bars[g.xi].d));",
      "add(long ? 0 : 2, d, netOf(long ? 1 : -1, g.e, g.x, d, bars[g.xi].d), { sym: x.sym, side: long ? 1 : -1, entryPx: g.e, exitPx: g.x, exitDay: bars[g.xi].d });"],
    ["if (long) { const net = netOf(1, e, xx, d, xd); add(1, d, net - b20); if (act === \"BUY\") add(4, d, net - b20); } else add(3, d, netOf(-1, e, xx, d, xd) + b20); } }",
      "if (long) { const net = netOf(1, e, xx, d, xd); add(1, d, net - b20, { sym: x.sym, side: 1, exitDay: xd }); if (act === \"BUY\") add(4, d, net - b20, { sym: x.sym, side: 1, exitDay: xd }); } else add(3, d, netOf(-1, e, xx, d, xd) + b20, { sym: x.sym, side: -1, exitDay: xd }); } }"]]
};

function more(data, ext, log) {
  const T = [], status = [];   // status: { member prefix, scorable, why }
  const take = (prefix, trades, sideOf = () => 1) => { let n = 0, out = 0; for (const t of trades) { const g = toGm(prefix, t, sideOf); if (!g.length) out += 1; for (const x of g) if (x.entryDay >= SAMPLE_FROM) { T.push(x); n += 1; } }
    log(`   ${prefix}: ${n} GM trades${out ? ` (${out} records without a futures symbol: options, out)` : ""}`); };
  const od = own(data);
  // ---- phase 1, the rest ----
  { const r = replayed("rising-stocks-2026-10-02", "RS rising stocks", (s) => s.run({ sessions: od.sessions, nifty: ext.niftyOHLC, stocks: od.stocks }).trades, PATCHES.rising);
    log(r.line); status.push({ m: "RS", ok: r.ok }); if (r.ok) take("RS", r.trades.map((t) => ({ ...t, member: t.member }))); }
  { const { borrowingSurge, parseSlb } = require(path.join(ROOT, "api/_lib/forward-v4")); const slb = new Map();
    if (ext.slbDir && fs.existsSync(ext.slbDir)) for (const f of fs.readdirSync(ext.slbDir).filter((x) => x.endsWith(".csv")).sort()) slb.set(f.slice(0, 10), parseSlb(fs.readFileSync(path.join(ext.slbDir, f), "utf8")));
    if (!slb.size) { log(" S2 borrowing surge: NOT SCORABLE (no SLB files)"); status.push({ m: "S2", ok: false }); }
    else { const r = borrowingSurge({ sessions: data.sessions, stocks: data.stocks, slb, start: SAMPLE_FROM }); const done = r.trades.filter((t) => t.status === "DONE");
      log(` S2: ${slb.size} SLB files ${[...slb.keys()][0]} .. ${[...slb.keys()].at(-1)}`); status.push({ m: "S2", ok: true });
      take("S2", done.map((t) => ({ member: "borrowing surge", sym: t.symbol, side: -1, day: t.entryDate, exitDay: t.exitDate }))); } }
  { const { indRev } = require(path.join(ROOT, "api/_lib/forward-v3")); const { industryCheck } = require(path.join(ROOT, "scripts/forward-v3"));
    const ind = industryCheck(ext.industryFile);
    if (!ind.ok) { log(` IR: NOT SCORABLE (industry file: ${ind.reason})`); status.push({ m: "IR", ok: false }); }
    else { const r = indRev({ sessions: data.sessions, stocks: data.stocks, industry: ind.industry, start: SAMPLE_FROM }); const si = new Map(data.sessions.map((d, i) => [d, i])); const legs = [];
      for (const b of r.rebalances.filter((x) => x.status === "DONE")) { const x = data.sessions[si.get(b.date) + 4];
        for (const s of b.long) legs.push({ member: "industry reversal", sym: s, side: 1, day: b.date, exitDay: x }); for (const s of b.short) legs.push({ member: "industry reversal", sym: s, side: -1, day: b.date, exitDay: x }); }
      status.push({ m: "IR", ok: true }); take("IR", legs); } }
  if (ext.krFile && fs.existsSync(ext.krFile)) {   // A2: Kronos from the forecast-models study's own code
    const fm = path.join(ROOT, "studies", "forecast-models-2026-10-13"); const common = createRequire(path.join(fm, "common.js"))("./common.js");
    const sc = loadFile(path.join(fm, "score.js"), { exportExpr: "{ run, score, readPreds, MEMBERS }", patches: [["function run(p, preds) {", "function run(p, preds, legsOut = null) {"],
      ["const L = xs.slice(-n).map(([s]) => leg(s, 1)), Sh = xs.slice(0, n).map(([s]) => leg(s, -1));",
        "const L = xs.slice(-n).map(([s]) => leg(s, 1)), Sh = xs.slice(0, n).map(([s]) => leg(s, -1)); if (legsOut && k === MEMBERS[2]) { for (const [s] of xs.slice(-n)) legsOut.push({ sym: s.sym, side: 1, day: r.e, exitDay: s.w.st.bars[s.w.i + H - 1].d }); for (const [s] of xs.slice(0, n)) legsOut.push({ sym: s.sym, side: -1, day: r.e, exitDay: s.w.st.bars[s.w.i + H - 1].d }); }"]] });
    const p = common.plan({ sessions: data.sessions, stocks: data.stocks }); const legs = []; const res = sc.run(p, { [sc.MEMBERS[2]]: sc.readPreds(ext.krFile) }, legs);
    const row = sc.score(res).find((x) => x.k === sc.MEMBERS[2]); const ok = row && row.trades === 57 && row.win.toFixed(1) === "50.9" && row.t.toFixed(2) === "1.35";
    log(` 5.4 KR Kronos (A2): ${row ? `${row.trades} rebalances, ${row.win.toFixed(1)}% winners, t ${row.t.toFixed(2)}` : "no M3 row"} vs published 57, 50.9%, 1.35 -> ${ok ? "SCORABLE" : "NOT SCORABLE"}`);
    status.push({ m: "KR", ok }); if (ok) take("KR", legs.map((g) => ({ ...g, member: "Kronos top/bottom tenth" }))); }
  else { log(" KR: NOT SCORABLE (forecasts file not given)"); status.push({ m: "KR", ok: false }); }
  if (ext.cmPreds && fs.existsSync(ext.cmPreds)) {   // A2: the combined model's own books() on its prediction rows
    const cmd = path.join(ROOT, "studies", "combined-model-2026-10-13");
    const cms = loadFile(path.join(cmd, "score.js"), { cut: "module.exports = { books, score, fmt, readCsv };", exportExpr: "{ books, score, readCsv }", patches: [["function books(panel, preds) {", "function books(panel, preds, legsOut = null) {"],
      ["const L = s.slice(0, k).map((x) => net(x, 1)).filter((v) => v !== null), Sh = s.slice(-k).map((x) => net(x, -1)).filter((v) => v !== null);",
        "const L = s.slice(0, k).map((x) => net(x, 1)).filter((v) => v !== null), Sh = s.slice(-k).map((x) => net(x, -1)).filter((v) => v !== null); if (legsOut && key === \"C1\" && L.length && Sh.length) { for (const x of s.slice(0, k)) if (net(x, 1) !== null) legsOut.push({ member: \"CM1 trees long-short\", sym: x.p.sym, side: 1, day: x.row.e, exitDay: x.row.x }); for (const x of s.slice(-k)) if (net(x, -1) !== null) legsOut.push({ member: \"CM1 trees long-short\", sym: x.p.sym, side: -1, day: x.row.e, exitDay: x.row.x }); }"],
      ["if (L3.length) out.C3.push({ day: e, net: mean(L3) - B }); }", "if (L3.length) { out.C3.push({ day: e, net: mean(L3) - B }); if (legsOut) for (const x of s.slice(0, k)) if (net(x, 1) !== null) legsOut.push({ member: \"CM3 trees long-only\", sym: x.p.sym, side: 1, day: x.row.e, exitDay: x.row.x }); } }"]] });
    // its own data (A1 2): the combined model's registration ends the CM bhavcopy at 2026-10-09 (its amendment A2, K2_CM_END)
    const CM_END = "2026-10-09"; const cd = { sessions: data.sessions.filter((d) => d <= CM_END), stocks: data.stocks.map((s) => ({ ...s, bars: s.bars.filter((b) => b.d <= CM_END) })).filter((s) => s.bars.length) };
    const preds = cms.readCsv(ext.cmPreds); const { context } = require(path.join(ROOT, "api/_lib/forward-v3")); const ctx = context(cd);
    const si = new Map(cd.sessions.map((d, i) => [d, i])); const panel = [];
    for (const r of preds) { const k = si.get(r.d); const e = k === undefined ? null : cd.sessions[k + 2] || null; let x = "", oe = NaN, cx = NaN, ret = NaN;
      if (e) { const w = ctx.window(r.sym, e, 5); if (w && w.complete) { const bb = w.st.bars; oe = bb[w.i].o; cx = bb[w.i + 4].c; x = bb[w.i + 4].d; ret = cx / oe - 1; } }
      panel.push({ i: r.i, d: r.d, e: e || "", x, sym: r.sym, oe, cx, ret }); }
    const legs = []; const { out } = cms.books(panel, preds, legs); const rows = cms.score(out); const c1 = rows.find((x) => x.key === "C1"), c3 = rows.find((x) => x.key === "C3");
    const f = (r) => `${r.rebalances} rebalances, ${r.meanPct >= 0 ? "+" : ""}${r.meanPct.toFixed(3)}%, ${r.win.toFixed(1)}% winners, t ${r.t.toFixed(2)}`;
    const ok = c1 && c3 && c1.rebalances === 198 && c3.rebalances === 198 && c1.meanPct.toFixed(3) === "0.117" && c3.meanPct.toFixed(3) === "0.161" && c1.win.toFixed(1) === "54.0" && c3.win.toFixed(1) === "55.6" && c1.t.toFixed(2) === "2.78" && c3.t.toFixed(2) === "3.39";
    log(` 5.4 CM combined model (A2): C1 ${c1 ? f(c1) : "-"}; C3 ${c3 ? f(c3) : "-"} vs published C1 198, +0.117%, 54.0%, 2.78 / C3 198, +0.161%, 55.6%, 3.39 -> ${ok ? "SCORABLE" : "NOT SCORABLE"}`);
    status.push({ m: "CM", ok }); if (ok) take("", legs); }
  else { log(" CM: NOT SCORABLE (predictions file not given)"); status.push({ m: "CM", ok: false }); }
  // ---- phase 2 ----
  { const r = replayed("dip-ml-2026-10-04", "dip-ml", (s) => s.run({ sessions: od.sessions, stocks: od.stocks }).trades, PATCHES.dipml);
    log(r.line); status.push({ m: "dip-ml", ok: r.ok }); if (r.ok) take("dip-ml", r.trades, (m) => SIDE[m.split(" ")[0]] ?? 1); }
  { const run = (s) => s.run({ sessions: od.sessions, stocks: od.stocks, oi: ext.oi, fii: ext.fii, nifty: ext.niftyOC }).trades;
    const r = replayed("orderflow-2026-10-03", "orderflow", run, PATCHES.orderflow); log(r.line); status.push({ m: "orderflow", ok: r.ok }); if (r.ok) take("orderflow", r.trades); }
  { const run = (s) => s.run({ sessions: od.sessions, stocks: od.stocks, deliv: ext.deliv, fut: ext.fut, opt: ext.opt, nifty: ext.niftyOC, niftyFutExpiries: ext.exps.FUTIDX.slice().sort(), niftyOptExpiries: ext.exps.OPTIDX.slice().sort() }).trades;
    const r = replayed("families-2026-10-04", "families", run, PATCHES.families); log(r.line); status.push({ m: "families", ok: r.ok }); if (r.ok) take("families", r.trades); }
  { const run = (s) => s.run({ sessions: od.sessions, stocks: od.stocks, events: ext.events, nifty: ext.niftyOC, opt: ext.opt, niftyOptExpiries: ext.exps.OPTIDX.slice().sort() }).trades;
    const r = replayed("results-vrp-2026-10-04", "results", run, PATCHES.results); log(r.line); status.push({ m: "results", ok: r.ok }); if (r.ok) take("results", r.trades); }
  { const run = (s) => { const o = s.run({ sessions: od.sessions, stocks: od.stocks, results: ext.results }).out; const t = []; for (const [member, xs] of o) for (const x of xs) t.push({ ...x, member }); return t; };
    const r = replayed("rating-replay-2026-10-04", "rating replay", run, PATCHES.rating, (t) => t.v); log(r.line); status.push({ m: "rating", ok: r.ok }); if (r.ok) take("rating", r.trades); }
  log(" momentum (2026-09-25), published strategies (2026-09-27): NOT SCORABLE (no run() returning trades; A1 4). Macro pod: later, own registration.");
  return { trades: T, status };
}

const FITTED = (member) => /^(SB |LU |orderflow |CM\d |families F[34] |results R[12] |dip-ml E[34] )/.test(member);
module.exports = { more, FITTED, PATCHES, loadFile, own, OWN_DATA_END };
