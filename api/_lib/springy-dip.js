"use strict";
// "SPRINGY DIP" -- the OWN rule E1, as a forward paper test
// (studies/springy-dip-forward-2026-10-04/PREREGISTRATION.txt). Pure functions over NSE CM
// bhavcopy bars; scripts/springy-dip-forward.js feeds them and writes docs/paper-rules/springy-dip.json.
const { calculateNseFuturesCharges } = require("./shadow-broker");

const RULE = { start: "2026-10-05", hold: 5, ac: -0.05, z: -2, acBars: 120, zBars: 20, universe: 200, valueWindow: 60, minBars: 250, reset: 0.18, notional: 500000 };

function lag1Autocorr(closes, end, n) {
  const r = []; for (let j = end - n + 1; j <= end; j += 1) r.push(closes[j] / closes[j - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length; let num = 0, den = 0;
  for (let k = 0; k < r.length; k += 1) { den += (r[k] - m) ** 2; if (k) num += (r[k] - m) * (r[k - 1] - m); }
  return den > 0 ? num / den : 0;
}
function zScore(closes, end, n) {
  const w = closes.slice(end - n + 1, end + 1); const m = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return sd > 0 ? (closes[end] - m) / sd : 0;
}
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

// stocks: [{ sym, bars: [{d,o,h,l,c,val}] }] sorted by date; sessions: sorted ISO dates that have a file.
function forward({ sessions, stocks, rule = RULE }) {
  const sIndex = new Map(sessions.map((d, i) => [d, i]));
  const lastCut = (bars, k) => { let c = 0; for (let i = 1; i < k; i += 1) if (Math.abs(bars[i].o / bars[i - 1].c - 1) >= rule.reset) c = i; return c; };
  const universeFor = new Map();
  const monthStart = (d) => sessions.find((s) => s.slice(0, 7) === d.slice(0, 7));
  const universe = (first) => {
    if (universeFor.has(first)) return universeFor.get(first);
    const ranked = [];
    for (const st of stocks) {
      let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1;
      const lc = lastCut(st.bars, k); if (k - lc < rule.minBars) continue;
      const v = st.bars.slice(Math.max(lc, k - rule.valueWindow), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b);
      if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    const set = new Set(ranked.slice(0, rule.universe).map((x) => x[0])); universeFor.set(first, set); return set;
  };
  const lastSession = sessions[sessions.length - 1];
  // the next session after the data: signals for it are read from bars up to lastSession
  const trades = [], pending = [];
  for (const st of stocks) {
    const b = st.bars; const c = b.map((x) => x.c);
    for (let i = 1; i <= b.length; i += 1) {
      const p = i - 1; const signalDay = b[p].d;
      const d = i < b.length ? b[i].d : null;                       // entry session (null: not yet traded)
      if (d && d < rule.start) continue;
      if (!d && signalDay !== lastSession) continue;                // a signal for the coming session only
      if (d && sIndex.get(b[p].d) !== sIndex.get(d) - 1) continue;
      const lc = lastCut(b, i); if (p - lc < rule.acBars + 1 || i - lc < rule.minBars) continue;
      const first = monthStart(d || signalDay); if (!first || !universe(first).has(st.sym)) continue;
      const ac = lag1Autocorr(c, p, rule.acBars), z = zScore(c, p, rule.zBars);
      if (!(ac < rule.ac && z <= rule.z)) continue;
      const base = { symbol: st.sym, signalDate: signalDay, ac: +ac.toFixed(3), z: +z.toFixed(2) };
      if (!d) { pending.push({ ...base, entryDate: "next session", status: "SIGNAL" }); continue; }
      const exitI = i + rule.hold - 1; const entry = b[i].o;
      const resetInside = b.slice(i, Math.min(exitI, b.length - 1) + 1).some((x, k) => Math.abs(x.o / b[i + k - 1].c - 1) >= rule.reset);
      if (exitI >= b.length) { trades.push({ ...base, entryDate: d, entry, status: "OPEN", sessionsHeld: b.length - i }); continue; }
      if (resetInside) { trades.push({ ...base, entryDate: d, entry, status: "VOID (corporate action)" }); continue; }
      const exit = b[exitI].c, exitDate = b[exitI].d, qty = Math.ceil(rule.notional / entry);
      const rolls = new Set(b.slice(i, exitI + 1).map((x) => x.d.slice(0, 7))).size - 1;
      const cost = (charge("BUY", entry, qty, d) + charge("SELL", exit, qty, exitDate) + rolls * (charge("BUY", exit, qty, exitDate) + charge("SELL", exit, qty, exitDate))) / (entry * qty);
      trades.push({ ...base, entryDate: d, entry, exitDate, exit, netPct: +((exit / entry - 1 - cost) * 100).toFixed(3), status: "DONE" });
    }
  }
  trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1));
  return { lastSession, pending, trades, summary: summarise(trades.filter((t) => t.status === "DONE"), rule) };
}

function isoWeek(iso) { const d = new Date(`${iso}T00:00:00Z`); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)).padStart(2, "0")}`; }
function tCrit(df) { // one-sided 5% Student-t critical value (table, then normal)
  const t = { 1: 6.314, 2: 2.92, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.86, 9: 1.833, 10: 1.812, 12: 1.782, 15: 1.753, 20: 1.725, 30: 1.697, 60: 1.671 };
  const keys = Object.keys(t).map(Number).sort((a, b) => a - b); let best = 1.645; for (const k of keys) if (df <= k) { best = t[k]; break; } return best; }
function summarise(done, rule) {
  const n = done.length; if (!n) return { finished: 0, verdict: "COLLECTING" };
  const mean = done.reduce((a, t) => a + t.netPct, 0) / n;
  const byWeek = new Map(); for (const t of done) { const w = isoWeek(t.entryDate); byWeek.set(w, (byWeek.get(w) || []).concat(t.netPct - mean)); }
  const G = byWeek.size; const s = [...byWeek.values()].reduce((a, xs) => a + xs.reduce((p, q) => p + q, 0) ** 2, 0);
  const se = G > 1 ? Math.sqrt((G / (G - 1)) * s) / n : null; const t = se ? mean / se : null;
  const months = (Date.parse(done.map((x) => x.entryDate).sort().pop()) - Date.parse(rule.start)) / (30.44 * 864e5);
  const ready = n >= 100 && months >= 3;
  const verdict = !ready ? "COLLECTING" : mean > 0 && t !== null && t >= tCrit(G - 1) ? "PASS" : "FAIL";
  return { finished: n, meanNetPct: +mean.toFixed(3), winPct: +((100 * done.filter((x) => x.netPct > 0).length) / n).toFixed(1), weeks: G, t: t === null ? null : +t.toFixed(2), verdict };
}

module.exports = { RULE, forward, lag1Autocorr, zScore, summarise, isoWeek };
