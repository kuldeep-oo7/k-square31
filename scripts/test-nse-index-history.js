"use strict";
// Tests for api/_lib/nse-index-history.js (audit F23).
const { fillThinIndices, mergeDaily, clean } = require("../api/_lib/nse-index-history");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const days = []; for (let t = Date.parse("2024-07-01"); days.length < 600; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const archive = { "Nifty Financial Services": days.map((d, i) => [d, 24000 + i, 24100 + i, 23900 + i, 24050 + i]), "Nifty 50": days.map((d, i) => [d, 22000, 22100, 21900, 22050]) };
const store = { rh: { "^NSEI": { rows: days.map((d) => [d, 1, 1, 1, 1]) }, "NIFTY_FIN_SERVICE.NS": { rows: [["2026-10-01", 1, 1, 1, 1]] } }, bc: { "^NSEI": { bars: new Array(66).fill({}) }, "NIFTY_FIN_SERVICE.NS": { bars: [{}] } }, saved: [] };
const riskHistory = { readHistory: (t) => store.rh[t] || null, saveHistory: (t, rows, o) => store.saved.push(["rh", t, rows.length, o.provider]) };
const barCache = { getCachedBars: (t) => store.bc[t] || null, saveCachedBars: (t, bars, o) => { store.saved.push(["bc", t, bars.length, o.provider, bars.at(-1)]); return true; } };
const done = fillThinIndices({ archive, tickers: ["^NSEI", "NIFTY_FIN_SERVICE.NS", "NIFTY_MID_SELECT.NS"], barCache, riskHistory });
check("FINNIFTY's one-row Yahoo copy is replaced by 2 years of NSE sessions", store.saved.some((x) => x[0] === "rh" && x[1] === "NIFTY_FIN_SERVICE.NS" && x[2] === 520 && x[3] === "NSE ind_close_all"), JSON.stringify(done));
check("and its 3-month bars too, labelled as NSE's", store.saved.some((x) => x[0] === "bc" && x[1] === "NIFTY_FIN_SERVICE.NS" && x[2] === 66 && x[4].source === "NSE ind_close_all"));
check("NIFTY, which Yahoo covers fully, is left untouched", !store.saved.some((x) => x[1] === "^NSEI"));
check("an index missing from the archive is reported, not invented", /not in NSE archive/.test(done["NIFTY_MID_SELECT.NS"]));
check("a '-' open from NSE's file falls back to the close", JSON.stringify(clean([["2024-10-01", NaN, NaN, NaN, 16109.05]])) === JSON.stringify([["2024-10-01", 16109.05, 16109.05, 16109.05, 16109.05]]));
const m = mergeDaily({ "Nifty 50": [["2026-09-30", 1, 2, 0.5, 1.5]] }, { "2026-10-01": { "Nifty 50": [22543.7, 22610.6, 22217.3, 22421.95], "Nifty MidSmall Financial Services": [1, 1, 1, 1] } });
check("daily files merge in date order, and only the five option indices are kept", m["Nifty 50"].length === 2 && m["Nifty 50"][1][4] === 22421.95 && !m["Nifty MidSmall Financial Services"]);
// a full-length copy that stopped on an older day (Yahoo's refresh fails for FINNIFTY every build) is refilled
{ const stale = { rh: { "NIFTY_FIN_SERVICE.NS": { rows: days.slice(0, 560).map((d) => [d, 1, 1, 1, 1]) } }, bc: { "NIFTY_FIN_SERVICE.NS": { bars: days.slice(500, 560).map((d) => ({ timestamp: Date.parse(`${d}T03:45:00Z`) / 1000 })) } }, saved: [] };
  const r2 = fillThinIndices({ archive, tickers: ["NIFTY_FIN_SERVICE.NS"], riskHistory: { readHistory: (t) => stale.rh[t], saveHistory: (t, rows, o) => stale.saved.push(["rh", t, rows.at(-1)[0]]) }, barCache: { getCachedBars: (t) => stale.bc[t], saveCachedBars: (t, bars) => { stale.saved.push(["bc", t, bars.length]); return true; } } });
  check("a long but STALE copy is refilled from NSE up to its last session", stale.saved.some((x) => x[0] === "rh" && x[2] === days.at(-1)) && stale.saved.some((x) => x[0] === "bc"), JSON.stringify(r2)); }
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
