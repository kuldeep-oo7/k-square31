"use strict";
// Tests for api/_lib/forward-v4.js (S2 borrowing surge forward paper test).
const { borrowingSurge, parseSlb } = require("../api/_lib/forward-v4");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const sessions = []; for (let t = Date.parse("2025-06-02"); sessions.length < 330; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const n = sessions.length;
// 40 flat stocks; S0 falls 1% a day from session n-40 on
const stocks = []; for (let k = 0; k < 40; k += 1) stocks.push({ sym: `S${k}`, bars: sessions.map((d, i) => { const c = k === 0 && i >= n - 40 ? 100 * 0.99 ** (i - n + 41) : 100; const o = k === 0 && i >= n - 40 ? c / 0.99 : 100; return { d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 - k }; }) });
// SLB: 200,000 shares out for most; S0 jumps to 500,000 on session n-40 (a surge). S2 has 30,000 out and jumps 3x
// to 90,000 on n-40: a surge, but under 1 lakh shares, so no signal.
const slb = new Map(sessions.map((d, i) => [d, new Map(stocks.map((s, k) => [s.sym, k === 0 && i >= n - 40 && i < n - 39 ? 500000 : k === 2 ? (i === n - 40 ? 90000 : 30000) : 200000]))]));
slb.get(sessions[n - 40]).set("S3", 150000);   // S3 below 2x: no signal
const start = sessions[n - 60];
const r = borrowingSurge({ sessions, stocks, slb, start, futSyms: new Set(["S0"]) });
const t0 = r.trades.find((t) => t.symbol === "S0");
check("a 2.5x jump in shares on loan is shorted", Boolean(t0), JSON.stringify(r.trades.slice(0, 2)));
check("entry is the open of the 2nd session after the file", t0 && t0.entryDate === sessions[n - 38], t0 && t0.entryDate);
check("held 5 sessions, cover at the 5th close", t0 && t0.exitDate === sessions[n - 34]);
check("a falling stock is a winning short, scored over the market (which includes it, as in the study)", t0 && t0.netPct > 0 && Math.abs(t0.netPct - (t0.rawPct + t0.marketPct)) < 0.002, t0 && `${t0.rawPct} + ${t0.marketPct} = ${t0.netPct}`);
check("below 2x is no signal", !r.trades.some((t) => t.symbol === "S3"));
check("under 1 lakh shares is no signal", !r.trades.some((t) => t.symbol === "S2"));
check("labels which names have NSE futures", t0 && t0.hasFutures === true);
// a surge in the last file waits for its entry session, once per name
const slb2 = new Map(slb); slb2.set(sessions[n - 1], new Map([...slb.get(sessions[n - 1])].map(([s, q]) => [s, s === "S5" ? 600000 : q])));
const r2 = borrowingSurge({ sessions, stocks, slb: slb2, start });
check("a surge in the latest file is listed as waiting for its entry", r2.pending.some((p) => p.symbol === "S5" && p.signalDate === sessions[n - 1]), JSON.stringify(r2.pending));
// trades entered before the start are not counted
const r3 = borrowingSurge({ sessions, stocks, slb, start: sessions[n - 30] });
check("trades entered before the registered start are not counted", !r3.trades.some((t) => t.entryDate < sessions[n - 30]));
check("NSE's file is summed over lending series", parseSlb("Sr no,Security,Series,Outstanding Quantity\n1,ABC,X1,2\n2,ABC,X4,35\n3,XYZ,X1,7\n").get("ABC") === 37);
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
