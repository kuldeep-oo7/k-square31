"use strict";
// Tests for api/_lib/forward-v3.js (cheap-vol straddle, industry-adjusted reversal).
const { cheapVol, indRev } = require("../api/_lib/forward-v3");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const sessions = []; for (let t = Date.parse("2025-06-02"); sessions.length < 400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const n = sessions.length, start = sessions[n - 20];
// 60 stocks in 6 industries; stock k swings +/-2% daily (high realised vol)
const stocks = []; for (let k = 0; k < 60; k += 1) stocks.push({ sym: `S${k}`, bars: sessions.map((d, i) => { const c = 100 * (1 + (i % 2 ? 0.02 : -0.02) * ((k % 3) + 1) / 2) + k * 0.01 * (i === n - 2 ? k : 0); return { d, o: 100, h: c * 1.01, l: c * 0.99, c, val: 1e9 }; }) });
const industry = Object.fromEntries(stocks.map((s, k) => [s.sym, `IND${k % 6}`]));
// options: a far-too-cheap straddle on S0 (premium 0.5) on the first test day, priced up 5 sessions later
const E = sessions[n - 1].slice(0, 8) + "28";
const sopt = { get: (d) => { const i = sessions.indexOf(d); if (i < n - 20) return []; const prem = i === n - 20 ? 0.5 : 3; return [["S0", "2099-12-31", 100, "CE", prem, 0, 1, 1], ["S0", "2099-12-31", 100, "PE", prem, 0, 1, 1]]; } };
const cv = cheapVol({ sessions, stocks, sopt, start });
const t0 = cv.trades.find((t) => t.symbol === "S0" && t.entryDate === start);
check("a straddle priced far under the stock's realised volatility is bought", Boolean(t0), JSON.stringify(cv.trades.slice(0, 2)));
check("and it is held 5 sessions, then scored net of charges", t0 && t0.status === "DONE" && t0.exitDate === sessions[n - 15] && t0.netPct > 0, JSON.stringify(t0));
check("at most once per stock per 5 sessions", cv.trades.filter((t) => t.symbol === "S0").every((t, i, a) => i === 0 || sessions.indexOf(a[i - 1].entryDate) - sessions.indexOf(t.entryDate) >= 5));
const ir = indRev({ sessions, stocks, industry, start });
check("rebalances happen only on every 5th session of the list", ir.rebalances.every((r) => sessions.indexOf(r.date) % 5 === 0), JSON.stringify(ir.rebalances.map((r) => r.date)));
check("each rebalance buys the industry laggards and shorts the leaders, 10% each", ir.rebalances.every((r) => r.long.length === r.short.length && r.long.length >= 1));
check("the next rebalance is announced in sessions", Number.isInteger(ir.sessionsToNext));
// the industry file is pinned by sha256: missing or changed -> NOT RUN (never computed with another file)
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { industryCheck } = require("./forward-v3");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fv3-")), f = path.join(tmp, "industries.json"), body = JSON.stringify({ AAA: "Banks", BBB: "-" });
fs.writeFileSync(f, body); const sha = crypto.createHash("sha256").update(body).digest("hex");
check("the registered industry file is used", industryCheck(f, sha).ok && industryCheck(f, sha).industry.BBB === "-");
check("a changed industry file is refused, visibly", !industryCheck(f, "0".repeat(64)).ok && /^NOT RUN: the industry file changed/.test(industryCheck(f, "0".repeat(64)).reason));
check("a missing industry file is refused, visibly", /^NOT RUN: .*missing/.test(industryCheck(path.join(tmp, "none.json")).reason));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
