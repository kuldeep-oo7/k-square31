"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): does the order book's tilt (demand against
// supply) move NSE stock futures over 15-30 minutes, or to the close, by more than it costs to trade?
//   node study.js --synthetic                                         checks 8.1-8.4 only (no real data)
//   K2_OF_DIR=<orderflow-rec day files> node study.js --through 2026-10-23     the interim look (15 sessions)
//   K2_OF_DIR=<orderflow-rec day files> node study.js --first 60               the verdict run (around 31 Dec 2026)
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const NOTIONAL = 100000, CHARGES = 0.001042, MIN_BOOKS = 100, H1_MIN = 15, H1_MAX = 30, CLOSE_FROM = "15:00", N_TRIALS = 6;
const SIGNALS = { S1: "total buy vs sell quantity", S2: "five-level depth", S3: "top of the book" };
const MEMBERS = ["S1H1", "S2H1", "S3H1", "S1H2", "S2H2", "S3H2"];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tStat = (a) => (a.length > 1 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const minutes = (ist) => +ist.slice(11, 13) * 60 + +ist.slice(14, 16);

// ---------- books ----------
// row = [symbol, expiry, ltp, oi, volume, totBuy, totSell, avg, bids, asks, feedTime]; levels = [[price, qty, orders] x up to 5]
function valid(row) { const b = row?.[8]?.[0], a = row?.[9]?.[0]; return !!(b && a && b[0] > 0 && a[0] > 0 && b[1] > 0 && a[1] > 0 && a[0] > b[0]); }
const mid = (row) => (row[8][0][0] + row[9][0][0]) / 2;
const imb = (x, y) => (x + y > 0 ? (x - y) / (x + y) : NaN);
function signal(row, s) {
  if (s === "S1") return imb(Number(row[5]) || 0, Number(row[6]) || 0);
  if (s === "S2") return imb(row[8].reduce((a, l) => a + (l[1] > 0 ? l[1] : 0), 0), row[9].reduce((a, l) => a + (l[1] > 0 ? l[1] : 0), 0));
  return imb(row[8][0][1], row[9][0][1]);
}
// average fill for qty units walking the levels; null if the recorded levels cannot fill it
function walk(levels, qty) { let left = qty, cost = 0; for (const [p, q] of levels) { if (!(p > 0 && q > 0)) continue; const take = Math.min(left, q); cost += take * p; left -= take; if (left <= 1e-9) return cost / qty; } return null; }

// sessions: [{ date, snaps: [{ ist, rows: Map(symbol -> near-month row) }] }] -> one value a session per member, plus detail
function prepare(days) {
  const out = [];
  for (const d of days) {
    const near = new Map(); let expiryDay = false;
    const snaps = d.lines.slice().sort((a, b) => (a.ist < b.ist ? -1 : 1)).map((l) => {
      const best = new Map(); for (const r of l.futures || []) { if (!(r[1] >= d.date)) continue; const cur = best.get(r[0]); if (!cur || r[1] < cur[1]) best.set(r[0], r); }
      for (const r of best.values()) { if (r[1] === d.date) expiryDay = true; near.set(r[0], r[1]); }
      return { ist: l.ist, rows: best };
    });
    if (expiryDay) { out.push({ date: d.date, skipped: "a stock-futures expiry day" }); continue; }
    const used = snaps.filter((s) => [...s.rows.values()].filter(valid).length >= MIN_BOOKS);
    out.push({ date: d.date, snaps: used });
  }
  return out;
}

function trade(entry, exit, side) {
  if (!exit || !valid(exit)) return null;
  const m = mid(entry), qty = NOTIONAL / m;
  const inFill = side > 0 ? walk(entry[9], qty) : walk(entry[8], qty); if (inFill === null) return "entry";
  const outFill = side > 0 ? walk(exit[8], qty) : walk(exit[9], qty); if (outFill === null) return null;
  return { net: (side * (outFill - inFill)) / m - CHARGES, gross: (side * (mid(exit) - m)) / m };
}

// the members over prepared sessions; shuffle (seeded) permutes each snapshot's signals across symbols (the null)
function run(sessions, { shuffleSeed = null } = {}) {
  let s0 = (shuffleSeed ?? 1) >>> 0; const rnd = () => { s0 = (s0 + 0x6d2b79f5) >>> 0; let t = s0; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const res = Object.fromEntries(MEMBERS.map((k) => [k, { sessions: [], trades: 0, dropped: 0, wins: 0, gross: [], net: [], ic: [] }]));
  for (const ses of sessions) {
    if (!ses.snaps || ses.snaps.length < 2) continue;
    const last = ses.snaps.at(-1), closeOk = last.ist.slice(11) >= CLOSE_FROM;
    const day = Object.fromEntries(MEMBERS.map((k) => [k, { net: [], gross: [], ic: [] }]));
    ses.snaps.forEach((snap, k) => {
      const next = ses.snaps.slice(k + 1).find((x) => { const dm = minutes(x.ist) - minutes(snap.ist); return dm >= H1_MIN && dm <= H1_MAX; }) || null;
      for (const s of Object.keys(SIGNALS)) {
        const ranked = [...snap.rows.values()].filter(valid).map((r) => ({ r, v: signal(r, s) })).filter((x) => Number.isFinite(x.v));
        if (shuffleSeed !== null) { const vs = ranked.map((x) => x.v); for (let i = vs.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [vs[i], vs[j]] = [vs[j], vs[i]]; } ranked.forEach((x, i) => { x.v = vs[i]; }); }
        const n = Math.floor(ranked.length / 10); if (n < 1) continue;
        const desc = ranked.slice().sort((a, b) => b.v - a.v || (a.r[0] < b.r[0] ? -1 : 1)), asc = ranked.slice().sort((a, b) => a.v - b.v || (a.r[0] < b.r[0] ? -1 : 1));
        for (const [h, exitSnap] of [["H1", next], ["H2", closeOk && k < ses.snaps.length - 1 ? last : null]]) {
          if (!exitSnap) continue; const key = `${s}${h}`;
          for (const [list, side] of [[desc.slice(0, n), 1], [asc.slice(0, n), -1]]) for (const { r } of list) {
            const t = trade(r, exitSnap.rows.get(r[0]), side); if (t === "entry") continue; if (t === null) { res[key].dropped += 1; continue; }
            day[key].net.push(t.net); day[key].gross.push(t.gross); res[key].trades += 1; if (t.net > 0) res[key].wins += 1; }
          // rank IC: the signal against the gross forward move, every valid symbol with a valid exit
          const pairs = ranked.map((x) => { const e = exitSnap.rows.get(x.r[0]); return valid(e) ? [x.v, (mid(e) - mid(x.r)) / mid(x.r)] : null; }).filter(Boolean);
          if (pairs.length >= 20) day[key].ic.push(spearman(pairs));
        }
      }
    });
    for (const k of MEMBERS) if (day[k].net.length) { res[k].sessions.push({ date: ses.date, net: mean(day[k].net), gross: mean(day[k].gross) }); res[k].gross.push(...day[k].gross); res[k].net.push(...day[k].net); if (day[k].ic.length) res[k].ic.push(mean(day[k].ic)); }
  }
  return res;
}
function spearman(pairs) { const rank = (i) => { const o = pairs.map((p, j) => [p[i], j]).sort((a, b) => a[0] - b[0]); const r = new Array(pairs.length); let k = 0; while (k < o.length) { let e = k; while (e + 1 < o.length && o[e + 1][0] === o[k][0]) e += 1; for (let z = k; z <= e; z += 1) r[o[z][1]] = (k + e) / 2; k = e + 1; } return r; };
  const a = rank(0), b = rank(1), ma = mean(a), mb = mean(b); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i += 1) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0; }

function summarise(res) {
  return MEMBERS.map((k) => { const r = res[k], nv = r.sessions.map((x) => x.net), gv = r.sessions.map((x) => x.gross);
    return { key: k, sessions: nv.length, trades: r.trades, dropped: r.dropped, win: r.trades ? (100 * r.wins) / r.trades : NaN, net: nv.length ? mean(nv) : NaN, netT: tStat(nv), gross: gv.length ? mean(gv) : NaN, grossT: tStat(gv),
      cost: r.trades ? mean(r.gross) - mean(r.net) : NaN, ic: r.ic.length ? mean(r.ic) : NaN, icT: tStat(r.ic), series: nv }; });
}
const interimWord = (m) => (m.net > 0 && m.netT >= 2 ? "PROMISING" : m.gross > 0 && m.grossT >= 2 ? "TOO SMALL TO TRADE" : "FAIL");
function verdicts(rows) {   // the verdict run only (registration section 6)
  const N = rows.length; rows.forEach((r) => { r.p = 1 - Phi(r.netT); }); const order = rows.slice().sort((a, b) => a.p - b.p); let ok = true; order.forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
  const srs = rows.map((r) => mean(r.series) / sd(r.series)); const g = 0.5772156649; const SR0 = Math.sqrt(sd(srs) ** 2) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
  rows.forEach((r, i) => { const s = r.series, m = mean(s), v = sd(s), sr = srs[i], g3 = mean(s.map((x) => ((x - m) / v) ** 3)), g4 = mean(s.map((x) => ((x - m) / v) ** 4)); const den = 1 - g3 * sr + ((g4 - 1) / 4) * sr ** 2;
    r.dsr = den > 0 ? Phi(((sr - SR0) * Math.sqrt(s.length - 1)) / Math.sqrt(den)) : NaN; r.verdict = r.net > 0 && r.netT >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.net > 0 && r.netT >= 2 ? "PROMISING" : "FAIL"; });
  return rows;
}

// ---------- synthetic books (section 8) ----------
function synth(seed, { beta = 0, sigma = 0.003, swap = false, still = false } = {}) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const syms = Array.from({ length: 200 }, (_, i) => `S${String(i).padStart(3, "0")}`); const days = [];
  const price = new Map(syms.map((x) => [x, 100 + rnd() * 2900]));
  for (let d = 0; d < 15; d += 1) {
    const date = new Date(Date.parse("2026-11-02") + d * 864e5).toISOString().slice(0, 10); const lines = [];
    for (let k = 0; k < 19; k += 1) {
      const ist = `${date} ${String(9 + Math.floor((20 + 20 * k) / 60)).padStart(2, "0")}:${String((20 + 20 * k) % 60).padStart(2, "0")}`; const futures = [];
      for (const x of syms) {
        const m = price.get(x), half = m * 0.00025, tick = m * 0.0002;
        const bq = Array.from({ length: 5 }, () => Math.round(500 + 4500 * rnd())), aq = Array.from({ length: 5 }, () => Math.round(500 + 4500 * rnd()));
        let bids = bq.map((q, i) => [m - half - i * tick, q, 1]), asks = aq.map((q, i) => [m + half + i * tick, q, 1]);
        let tb = Math.round((bq.reduce((a, v) => a + v, 0)) * (20 + 40 * rnd())), ts = Math.round((aq.reduce((a, v) => a + v, 0)) * (20 + 40 * rnd()));
        const top = (bq[0] - aq[0]) / (bq[0] + aq[0]);
        if (swap) { bids = bids.map((l, i) => [l[0], aq[i], 1]); asks = asks.map((l, i) => [l[0], bq[i], 1]); [tb, ts] = [ts, tb]; }
        futures.push([x, "2026-12-29", m, 0, 0, tb, ts, m, bids, asks, ist]);
        if (!still) price.set(x, m * (1 + beta * top + sigma * gauss()));
      }
      lines.push({ ist, futures });
    }
    days.push({ date, lines });
  }
  return days;
}
function checks(log) {
  let ok = true; const fmt = (rows) => rows.map((m) => `${m.key} ${Number.isFinite(m.grossT) ? m.grossT.toFixed(2) : "-"}`).join(", ");
  const plant = summarise(run(prepare(synth(1, { beta: 0.0005 })))); const p3 = plant.find((m) => m.key === "S3H1");
  log(` 8.1 planted (next mid moves 0.05% x top-of-book imbalance): S3H1 gross t ${p3.grossT.toFixed(2)} (needs >= 3); all gross t: ${fmt(plant)}`); if (!(p3.grossT >= 3)) ok = false;
  let hits = 0; for (const seed of [1, 2, 3]) { const rows = summarise(run(prepare(synth(seed)))); hits += rows.filter((m) => Math.abs(m.grossT) >= 3).length; log(` 8.2 null seed ${seed}: gross t ${fmt(rows)}`); }
  log(`     null results with gross |t| >= 3: ${hits} of 18 (at most 1 allowed)`); if (hits > 1) ok = false;
  const sw = summarise(run(prepare(synth(1, { beta: 0.0005, swap: true })))).find((m) => m.key === "S3H1");
  log(` 8.3 bid and ask quantities swapped: S3H1 gross mean ${(100 * p3.gross).toFixed(4)}% -> ${(100 * sw.gross).toFixed(4)}% (sign must flip)`); if (!(Math.sign(sw.gross) === -Math.sign(p3.gross) && p3.gross !== 0)) ok = false;
  const still = summarise(run(prepare(synth(5, { still: true }))));
  log(` 8.4 prices never move: net means ${still.map((m) => `${m.key} ${(100 * m.net).toFixed(3)}%`).join(", ")} (all must be below 0; gross 0)`); if (!still.every((m) => m.net < 0 && Math.abs(m.gross) < 1e-12)) ok = false;
  log(` CHECKS: ${ok ? "PASSED" : "FAILED"}`); return ok;
}

// ---------- real data ----------
function loadReal({ through = null, first = null }) {
  const dir = path.resolve(process.env.K2_OF_DIR || "orderflow"); let files = fs.readdirSync(dir).filter((f) => /^of-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort();
  if (through) files = files.filter((f) => f.slice(3, 13) <= through); if (first) files = files.slice(0, first);
  return files.map((f) => { const buf = fs.readFileSync(path.join(dir, f)); const text = f.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return { date: f.slice(3, 13), lines: text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) }; });
}

if (require.main === module) {
  const lines = []; const log = (x) => { lines.push(x); console.log(x); }; const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  log(`ORDER BOOK ON NSE STOCK FUTURES, registration sha256 ${SHA} (verified), run ${new Date().toISOString()}`); log("CHECKS (synthetic, section 8):");
  if (!checks(log)) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\nCHECKS FAILED: real run refused.\n\n"); process.exit(1); }
  if (process.argv.includes("--synthetic")) { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n"); process.exit(0); }
  const first = arg("--first") ? Number(arg("--first")) : null, through = arg("--through"); const verdictRun = first === 60;
  if (!verdictRun && !through) { console.error("say --through <date> (interim) or --first 60 (the verdict)"); process.exit(2); }
  const days = loadReal({ through, first }); const sessions = prepare(days); const rows = summarise(run(sessions)); const nul = summarise(run(sessions, { shuffleSeed: 1 }));
  const usedSnaps = sessions.reduce((a, s) => a + (s.snaps ? s.snaps.length : 0), 0);
  log(`\n${verdictRun ? "THE VERDICT RUN" : "INTERIM LOOK (cannot say PASS)"}: ${days.length} recorded sessions ${days[0]?.date} .. ${days.at(-1)?.date}; ${sessions.filter((s) => s.skipped).length} skipped (expiry day); ${usedSnaps} snapshots used. Per trade of Rs 1 lakh; net = recorded fills + 0.104% charges.`);
  if (verdictRun) verdicts(rows);
  const pc = (v, k = 3) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "-"}${Math.abs(100 * v).toFixed(k)}%` : "-");
  for (const m of rows) log(`${m.key} ${SIGNALS[m.key.slice(0, 2)]}, ${m.key.endsWith("H1") ? "next 15-30 min" : "to the close"}: ${m.sessions} sessions, ${m.trades} trades (${m.dropped} dropped at exit), net ${pc(m.net)} a trade t ${Number.isFinite(m.netT) ? m.netT.toFixed(2) : "-"}, won ${Number.isFinite(m.win) ? m.win.toFixed(0) : "-"}% | gross ${pc(m.gross)} t ${Number.isFinite(m.grossT) ? m.grossT.toFixed(2) : "-"} | cost ${pc(m.cost)} a trade | rank IC ${Number.isFinite(m.ic) ? m.ic.toFixed(3) : "-"} (t ${Number.isFinite(m.icT) ? m.icT.toFixed(2) : "-"}) -> ${verdictRun ? `${m.verdict} (Holm ${m.holm ? "yes" : "no"}, DSR ${Number.isFinite(m.dsr) ? m.dsr.toFixed(2) : "-"})` : interimWord(m)}`);
  log("\nNULL (each snapshot's signals shuffled across symbols, seed 1; reported, not judged):");
  for (const m of nul) log(` ${m.key}: net ${pc(m.net)} t ${Number.isFinite(m.netT) ? m.netT.toFixed(2) : "-"} | gross ${pc(m.gross)} t ${Number.isFinite(m.grossT) ? m.grossT.toFixed(2) : "-"}`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  fs.writeFileSync(path.join(HERE, verdictRun ? "result-verdict.json" : "result-interim.json"), JSON.stringify({ rows: rows.map(({ series, ...r }) => r), null: nul.map(({ series, ...r }) => r) }, null, 1));
}
module.exports = { prepare, run, summarise, valid, walk, signal, synth };
