"use strict";
// Tests for api/_lib/trees-forward.js (the trees forward paper watch). The live replay against the study runs on Actions.
const tf = require("../api/_lib/trees-forward");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const sessions = []; for (let t = Date.parse("2022-09-26"); sessions.length < 40; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const sch = tf.schedule(sessions); const first = sessions.indexOf("2022-10-03");
check("the schedule counts every 5th session from the first on or after 2022-10-03", sch.isRebalance(first) && !sch.isRebalance(first + 1) && sch.isRebalance(first + 5) && !sch.isRebalance(first - 5));
// lists: top tenth long, bottom tenth short, ties keep the file's order, symbols only
const preds = new Map(); for (let k = 0; k < 60; k += 1) preds.set(`S${String(k).padStart(2, "0")}`, k === 59 ? 0.05 : (k - 30) / 1000);
const L = tf.makeList({ d: sessions[first], entry: sessions[first + 2], exit: sessions[first + 6], preds, madeAt: "2026-10-27T15:00:00Z", futSyms: new Set(["S58"]), contractFor: () => "2026-11-24" });
check("60 names: 6 long, 6 short", L.long.length === 6 && L.short.length === 6 && L.enough);
check("the highest prediction is the first long, the lowest the first short", L.long[0].symbol === "S59" && L.short[0].symbol === "S00");
check("futures flags and the contract month are kept; no prediction is stored", L.long[1].symbol === "S58" && L.long[1].futures === true && L.long[0].futures === false && L.long[0].expiry === "2026-11-24" && !("preds" in L) && !("predPct" in L.long[0]));
const few = tf.makeList({ d: "x", entry: "y", exit: "z", preds: new Map([...preds].slice(0, 49)), madeAt: "", futSyms: new Set(), contractFor: () => null });
check("under 50 names: no list", !few.enough && !few.long.length);
check("a list counts only if made after the registration and before 09:15 on its entry day",
  tf.counted({ ...L, entry: "2026-10-28", madeAt: "2026-10-27T15:00:00Z" }) && !tf.counted({ ...L, entry: "2026-10-28", madeAt: "2026-10-28T04:00:00Z" }) && !tf.counted({ ...L, entry: "2026-10-23", madeAt: "2026-10-21T15:00:00Z" }));
// scoring on a tiny market: longs rise 1% a day, shorts fall 1% a day, over the 5 sessions from the entry
const ss = sessions.slice(0, 30); const mk = (sym, g) => ({ sym, bars: ss.map((d, i) => ({ d, o: 100 * (1 + g) ** i, c: 100 * (1 + g) ** i * (1 + g), val: 1e9 })) });
const stocks = [mk("UP", 0.01), mk("DN", -0.01)];
const list = { signalDate: ss[10], entry: ss[12], exit: ss[16], madeAt: "2026-10-27T15:00:00Z", enough: true, long: [{ symbol: "UP" }], short: [{ symbol: "DN" }] };
const lists = { a: { ...list, entry: ss[12] } }; const real = (x) => ({ ...x, madeAt: new Date(Date.parse(`${x.entry}T09:15:00+05:30`) - 864e5).toISOString() });
const sc = tf.score({ a: real(lists.a) }, { sessions: ss, stocks });
check("a list made before the registration is labelled so and not scored", sc.books.length === 1 && sc.books[0].status === "BEFORE REGISTRATION" && sc.summary.finished === 0);
const s2 = []; for (let t = Date.parse("2026-10-26"); s2.length < 30; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) s2.push(d.toISOString().slice(0, 10)); }
const mk2 = (sym, g) => ({ sym, bars: s2.map((d, i) => ({ d, o: 100 * (1 + g) ** i, c: 100 * (1 + g) ** i * (1 + g), val: 1e9 })) });
const sc2 = tf.score({ a: real({ ...list, entry: s2[2], exit: s2[6] }) }, { sessions: s2, stocks: [mk2("UP", 0.01), mk2("DN", -0.01)] });
check("a counted, finished book: long up and short down both win, after charges", sc2.summary.finished === 1 && sc2.summary.meanPct > 4 && sc2.summary.verdict === "COLLECTING", JSON.stringify(sc2.summary));
const v = tf.bookValue(require("../api/_lib/forward-v3").context({ sessions: ss, stocks }), list);
check("the book's value: (mean long + mean short) / 2, over 5 sessions open to close", v.status === "DONE" && v.value > 0.04 && v.value < 0.06, v.value);
const open = tf.bookValue(require("../api/_lib/forward-v3").context({ sessions: ss, stocks }), { ...list, entry: ss[27] });
check("a book whose 5 sessions are not over is OPEN", open.status === "OPEN");
// a stock that stops trading inside its window: that leg is dropped (as the study), the book still finishes
const gone = { sym: "GONE", bars: ss.slice(0, 14).map((d, i) => ({ d, o: 100, c: 100, val: 1e9 })) };
const v2 = tf.bookValue(require("../api/_lib/forward-v3").context({ sessions: ss, stocks: [...stocks, gone] }), { ...list, long: [{ symbol: "UP" }, { symbol: "GONE" }] });
check("a leg whose stock stopped trading inside its window is dropped, not held open", v2.status === "DONE" && v2.nLong === 1, JSON.stringify(v2));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("trees forward tests passed");
