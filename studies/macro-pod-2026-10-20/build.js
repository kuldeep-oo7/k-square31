"use strict";
// Implements ./PREREGISTRATION.txt sections 2-4 with AMENDMENT-A1 and AMENDMENT-A2: inputs, the four members, their books.
// A module; the real run is score.js. Inputs (all private): K2_MACRO_DIR (ind_close_all/, part_oi/, nsdl_fpi/, fred/
// from release data-macro) and K2_OOS_IDX (nse-old/idx/ from release data-oos, NSE ind_close_all as JSON, 2012-2020).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 1e6, HOLD_MISSING = 3, STOP = 0.03, M1_BAND = 0.02, M1_LAG = 5, M2_N = 20, M3_N = 20, SAMPLE_FROM = "2012-04-02";
const MEMBERS = ["M1", "M2", "M3", "M4"];
const NAMES = { M1: "M1 FII futures position", M2: "M2 foreign cash flow (NSDL)", M3: "M3 dollar liquidity", M4: "M4 all line up, 3% stop" };

function verify() {
  const h = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const out = {};
  for (const f of ["PREREGISTRATION", "AMENDMENT-A1", "AMENDMENT-A2"]) { const want = fs.readFileSync(path.join(HERE, `${f}.sha256`), "utf8").split(/\s+/)[0];
    if (h(`${f}.txt`) !== want) throw new Error(`${f}.txt CHANGED; result void.`); out[f] = want; }
  return out;
}

// ---------- inputs ----------
const csvRows = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "").trim()));
function loadInputs({ macroDir = process.env.K2_MACRO_DIR || "macro", oosIdx = process.env.K2_OOS_IDX || null } = {}) {
  const open = new Map();
  if (oosIdx && fs.existsSync(oosIdx)) for (const f of fs.readdirSync(oosIdx).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const v = JSON.parse(fs.readFileSync(path.join(oosIdx, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[0] > 0) open.set(f.slice(0, 10), v[0]); }
  const icDir = path.join(macroDir, "ind_close_all");
  for (const f of fs.readdirSync(icDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) {
    const rows = csvRows(fs.readFileSync(path.join(icDir, f), "utf8")); const h = rows[0] || []; const io = h.findIndex((x) => /Open Index Value/i.test(x));
    // NIFTY 50's official names in NSE's file: "S&P CNX Nifty", then "CNX Nifty", then "Nifty 50" from Nov 2015 (as scripts/nse-old-history.js)
    const r = rows.find((x) => /^(nifty 50|cnx nifty|s&p cnx nifty)$/i.test(x[0] || "")); if (r && io >= 0 && +r[io] > 0) open.set(f.slice(0, 10), +r[io]); }
  const fii = new Map(); const pDir = path.join(macroDir, "part_oi");
  for (const f of fs.readdirSync(pDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) {
    const rows = csvRows(fs.readFileSync(path.join(pDir, f), "utf8")); const hi = rows.findIndex((x) => x.some((c) => /Future Index Long/i.test(c))); if (hi < 0) continue;
    const h = rows[hi]; const L = h.findIndex((c) => /Future Index Long/i.test(c)), S = h.findIndex((c) => /Future Index Short/i.test(c));
    const r = rows.slice(hi + 1).find((x) => /^FII$/i.test(x[0] || "")); if (!r) continue; const l = +r[L], s = +r[S];
    if (Number.isFinite(l) && Number.isFinite(s) && l + s > 0) fii.set(f.slice(0, 10), l / (l + s)); }
  const nsdl = []; const nDir = path.join(macroDir, "nsdl_fpi");
  for (const f of fs.readdirSync(nDir).filter((x) => /^\d{4}-\d{2}\.json$/.test(x)).sort())
    for (const r of JSON.parse(fs.readFileSync(path.join(nDir, f), "utf8"))) if (r.date && Number.isFinite(r.equityExchangeNet)) nsdl.push({ date: r.date, v: r.equityExchangeNet });
  nsdl.sort((a, b) => (a.date < b.date ? -1 : 1));
  const usd = []; for (const r of csvRows(fs.readFileSync(path.join(macroDir, "fred", "DTWEXBGS.csv"), "utf8")).slice(1)) { const v = +r[1]; if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(v) && r[1] !== ".") usd.push({ date: r[0], v }); }
  usd.sort((a, b) => (a.date < b.date ? -1 : 1));
  const sessions = [...open.keys()].sort();
  return { sessions, open, fii, nsdl, usd };
}

// A2: a DTWEXBGS value dated v is usable from the India session on or after the Wednesday after the Monday following v's week
function usdUsableFrom(v) { const t = new Date(`${v}T00:00:00Z`); const dow = t.getUTCDay(); const toMon = ((8 - dow) % 7) || 7; t.setUTCDate(t.getUTCDate() + toMon + 2); return t.toISOString().slice(0, 10); }

// ---------- members: raw signals at the close of each session (null = MISSING) ----------
function signals(inp) {
  const S = inp.sessions, n = S.length; const sig = { M1: new Array(n).fill(null), M2: new Array(n).fill(null), M3: new Array(n).fill(null) };
  for (let i = 0; i < n; i += 1) { const a = inp.fii.get(S[i]), b = i >= M1_LAG ? inp.fii.get(S[i - M1_LAG]) : undefined;
    if (a !== undefined && b !== undefined) { const x = a - b; sig.M1[i] = x > M1_BAND ? 1 : x < -M1_BAND ? -1 : 0; } }
  // M2 (A1): NSDL rows dated before session d are usable at d's close; F_d = sum of the last 20; fresh only if the newest is
  // dated on or after the previous session (else MISSING that day)
  { let k = 0; for (let i = 0; i < n; i += 1) { while (k < inp.nsdl.length && inp.nsdl[k].date < S[i]) k += 1;
      if (k < M2_N || i === 0) continue; if (inp.nsdl[k - 1].date < S[i - 1]) continue;
      let F = 0; for (let j = k - M2_N; j < k; j += 1) F += inp.nsdl[j].v; sig.M2[i] = F > 0 ? 1 : F < 0 ? -1 : 0; } }
  // M3 (A2): the latest value usable at d minus the value 20 observations earlier; fresh only if a new value became usable
  // within the last 10 calendar days (one weekly release plus a holiday)
  { const from = inp.usd.map((u) => usdUsableFrom(u.date)); let k = 0;
    for (let i = 0; i < n; i += 1) { while (k < inp.usd.length && from[k] <= S[i]) k += 1; if (k <= M3_N) continue;
      if ((Date.parse(S[i]) - Date.parse(from[k - 1])) / 864e5 > 10) continue;
      const D = inp.usd[k - 1].v - inp.usd[k - 1 - M3_N].v; sig.M3[i] = D < 0 ? 1 : D > 0 ? -1 : 0; } }
  return sig;
}
// a member holds its last position only for 3 sessions without data, then goes flat
function held(raw) { const out = new Array(raw.length).fill(0); let last = 0, miss = 0;
  for (let i = 0; i < raw.length; i += 1) { if (raw[i] === null) { miss += 1; out[i] = miss <= HOLD_MISSING ? last : 0; if (miss > HOLD_MISSING) last = 0; } else { miss = 0; last = raw[i]; out[i] = last; } }
  return out; }

// ---------- books (section 3): decision at close of session i -> position over open(i+1) -> open(i+2) ----------
const chargeFrac = (side, price, d) => { const q = Math.ceil(NOTIONAL / price); return calculateNseFuturesCharges({ side, price, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges / (price * q); };
function book(inp, dec, { stop = false, agree = null } = {}) {
  const S = inp.sessions, n = S.length; const days = []; let pos = 0, entry = null, stopped = false;
  for (let t = 1; t + 1 < n; t += 1) {   // the interval open(S[t]) -> open(S[t+1]), decided at the close of S[t-1]
    let want = dec[t - 1]; const o = inp.open.get(S[t]), o1 = inp.open.get(S[t + 1]);
    // M4's stop: flat after a 3% loss from the entry open (measured at a session open) until the members disagree, then agree again
    if (stop) { const ag = agree[t - 1]; if (stopped) { if (ag === 0) stopped = false; want = 0; }
      if (!stopped && want !== 0 && want === pos && entry && want * (o / entry - 1) <= -STOP) { want = 0; stopped = true; } }
    let cost = 0; const change = want - pos;
    if (change !== 0) { if (pos !== 0) cost += chargeFrac(pos > 0 ? "SELL" : "BUY", o, S[t]); if (want !== 0) cost += chargeFrac(want > 0 ? "BUY" : "SELL", o, S[t]); entry = want !== 0 ? o : null; }
    else if (pos !== 0 && S[t].slice(0, 7) !== S[t - 1].slice(0, 7)) cost += chargeFrac("SELL", o, S[t]) + chargeFrac("BUY", o, S[t]);   // one roll a month while holding
    pos = want; days.push({ d: S[t], pos, r: pos * (o1 / o - 1) - cost, bh: o1 / o - 1, change: change !== 0 });
  }
  return days;
}
function books(inp) {
  const sig = signals(inp); const h = { M1: held(sig.M1), M2: held(sig.M2), M3: held(sig.M3) };
  const agree = h.M1.map((v, i) => (v !== 0 && v === h.M2[i] && v === h.M3[i] ? v : 0));
  return { sig, held: h, agree, M1: book(inp, h.M1), M2: book(inp, h.M2), M3: book(inp, h.M3), M4: book(inp, agree, { stop: true, agree }) };
}
module.exports = { NAMES, MEMBERS, SAMPLE_FROM, verify, loadInputs, usdUsableFrom, signals, held, book, books };
