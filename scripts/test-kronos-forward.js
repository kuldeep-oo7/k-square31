"use strict";
// Tests for the Kronos forward paper watch (api/_lib/kronos-forward.js) and its page boxes.
const { RULE, universe, inputsFor, makeDay, onTime, score } = require("../api/_lib/kronos-forward");
const { kronosBox, kronosTrackBox } = require("./publish-static-desk");
const { nextTradingDate } = require("./paper-ledger");
let failed = 0; const check = (name, ok, info = "") => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); if (!ok) failed += 1; };

// sessions: 330 NSE trading days ending Thu 15 Oct 2026, built backwards from the holiday calendar
const sessions = []; { let q = "2025-06-02"; while (q <= "2026-10-15") { sessions.push(q); q = nextTradingDate(q); } }
const bars = (from, to, val, price = 100) => sessions.filter((d) => d >= from && d <= to).map((d, i) => ({ d, o: price, h: price, l: price, c: price, val, qty: 1000 + i }));
const bySym = new Map();
for (let k = 0; k < 30; k += 1) bySym.set(`S${String(k).padStart(2, "0")}`, bars(sessions[0], "2026-10-15", 1e9 - k * 1e6));
bySym.set("DEAD", bars(sessions[0], "2026-03-31", 9e12));   // stopped trading in March, with the biggest old value
bySym.set("YOUNG", bars("2026-06-01", "2026-10-15", 8e12)); // too few bars
const data = { sessions, bySym };
const u = universe(data, "2026-10");
check("a stock that stopped trading is not ranked", !u.includes("DEAD"));
check("a stock with fewer than 250 bars is not ranked", !u.includes("YOUNG"));
check("live stocks are ranked by traded value", u[0] === "S00" && u.length === 30);
const fut = new Set([...bySym.keys()].filter((s) => s !== "S03"));
const rows = inputsFor(data, "2026-10-15", fut, nextTradingDate);
check("only stocks with NSE stock futures are used", rows.length === 29 && !rows.some((r) => r.sym === "S03"));
check("inputs are sorted by symbol, 512 bars at most, with real dates", rows[0].sym === "S00" && rows[0].c.length <= RULE.ctx && rows[0].t.at(-1) === "2026-10-15");
check("the 5 forecast dates are the next NSE sessions (20 Oct is Dussehra)", rows[0].ty.join(",") === "2026-10-16,2026-10-19,2026-10-21,2026-10-22,2026-10-23");

// a stored day: top and bottom tenth
const preds = Object.fromEntries([...Array(30)].map((_, k) => [`S${String(k).padStart(2, "0")}`, (k - 15) / 100]));
const day = makeDay({ d: "2026-10-16", entry: "2026-10-19", exit: "2026-10-26", preds, madeAt: "2026-10-16T14:50:00Z", contractFor: (s, x) => (x <= "2026-10-27" ? "2026-10-27" : "2026-11-24") });
check("3 longs (highest forecasts) and 3 shorts (lowest)", day.long.map((x) => x.symbol).join() === "S29,S28,S27" && day.short.map((x) => x.symbol).join() === "S00,S01,S02");
check("the contract outlasts the exit date", day.long[0].expiry === "2026-10-27");
check("fewer than 20 names: no book", makeDay({ d: "x", entry: "y", exit: "z", preds: { A: 0.1 }, madeAt: "", contractFor: () => null }).enough === false);
check("made before 09:15 IST on entry day counts", onTime({ entry: "2026-10-19", madeAt: "2026-10-19T03:44:00Z" }));
check("made after 09:15 IST on entry day is LATE", !onTime({ entry: "2026-10-19", madeAt: "2026-10-19T03:46:00Z" }));

// scoring: longs rise 2%, shorts fall 2% over the 5 sessions -> positive after charges
const S2 = []; { let q = RULE.start; while (S2.length < 20) { S2.push(q); q = nextTradingDate(q); } }
const path = (p0, step) => S2.map((d, i) => ({ d, o: p0 * (1 + step * i), h: 0, l: 0, c: p0 * (1 + step * (i + 0.8)), val: 1, qty: 1 }));
const b2 = new Map([["UP", path(100, 0.005)], ["DN", path(100, -0.005)], ["JUMP", path(100, 0).map((x, i) => (i === 10 ? { ...x, o: 150, c: 150 } : i > 10 ? { ...x, o: 150, c: 150 } : x))]]);
const d2 = { sessions: S2, bySym: b2 };
const mk = (entry, exit, madeAt, long = "UP", short = "DN") => ({ signalDate: entry, entry, exit, madeAt, enough: true, names: 20, long: [{ symbol: long }], short: [{ symbol: short }] });
const e1 = S2[2], e2 = S2[18];   // e1 finishes inside the data, e2 does not
const r = score({ a: mk(e1, S2[6], `${e1}T03:00:00Z`), b: mk(e2, null, `${e2}T03:00:00Z`), c: mk(S2[8], S2[12], `${S2[8]}T05:00:00Z`), early: mk("2026-10-16", "2026-10-23", "2026-10-15T15:00:00Z") }, d2);
const ba = r.books.find((x) => x.entry === e1);
check("a finished list is scored: longs up, shorts down -> positive after charges", ba && ba.status === "DONE" && ba.valuePct > 0 && ba.valuePct < 2.5, String(ba && ba.valuePct));
check("an unfinished list stays OPEN", r.books.find((x) => x.entry === e2)?.status === "OPEN");
check("a list made after 09:15 is LATE and not counted", r.books.find((x) => x.entry === S2[8])?.status === "LATE" && r.summary.finished === 1);
check("lists before the start date are not counted", !r.books.some((x) => x.entry === "2026-10-16"));
const rv = score({ a: mk(S2[7], S2[11], `${S2[7]}T03:00:00Z`, "JUMP", "DN") }, d2);
check("a long across an 18% jump is VOID", rv.books[0].legs?.find((x) => x.symbol === "JUMP")?.status === "VOID (corporate action)");
check("no verdict before 52 weeks", r.summary.verdict === "COLLECTING");

// the page
const store = { start: RULE.start, summary: { finished: 0, verdict: "COLLECTING" }, days: { "2026-10-16": day }, books: [], rule: "x", backtest: "y", preregistration: "p", dataThrough: "2026-10-16" };
let h = kronosBox({ kronos: store, sessionOver: true, sessionDate: "2026-10-16", nextSession: "2026-10-19", tradingDay: true, gmMinUnits: 20 });
check("Monday's list is shown after Friday's close", h.includes("S29") && h.includes("S00") && h.includes("Mon 19 Oct") && h.includes("Mon 26 Oct"));
check("it says FAILED and paper only, never a % forecast", h.includes("FAILED its test") && h.includes("paper only") && !h.includes("0.14%"));
check("the contract month is shown", h.includes("Oct fut"));
h = kronosBox({ kronos: store, sessionOver: false, sessionDate: "2026-10-20", nextSession: "2026-10-20", tradingDay: true });
check("a list for another session is never shown as today's; the held list is", !h.includes("S29</b>") && h.includes("No Kronos list") && h.includes("Still held") && h.includes("Mon 26 Oct"));
check("no store: nothing", kronosBox({}) === "" && kronosTrackBox(null) === "");
check("TRACK box shows the verdict state", kronosTrackBox(store).includes("COLLECTING"));
console.log(failed ? `${failed} failed` : "kronos forward tests passed"); process.exit(failed ? 1 : 0);
