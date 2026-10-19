"use strict";
// The focus-rule box (short build-up) on FUTURES: shows only the list made for the session it is read in.
const { sbFocusBox } = require("./publish-static-desk");
let failed = 0; const check = (name, ok, info = "") => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); if (!ok) failed += 1; };
const of = (through, pend) => ({ start: "2026-10-05", dataThrough: through, SB: { pending: pend, summary: { finished: 29, meanNetPct: -0.165, winPct: 41.4 } } });
const sig = (sym, d) => ({ symbol: sym, signalDate: d, pricePct: -3.3, oiPct: 6.2, status: "SIGNAL" });
// Wed 14 Oct after the close: the list for Thu 15 Oct comes from Wed's files
let h = sbFocusBox({ oiFlow: of("2026-10-14", [sig("VEDL", "2026-10-14")]), sessionOver: true, sessionDate: "2026-10-14", nextSession: "2026-10-15", tradingDay: true });
check("after the close, the next session's list is shown", h.includes("VEDL") && h.includes("15 Oct"));
check("the minus sign is a real minus", h.includes("&minus;3.3%"));
// the evening job has not run: the old list (made for Wed) must NOT be shown as Thursday's
h = sbFocusBox({ oiFlow: of("2026-10-13", [sig("RBLBANK", "2026-10-13")]), sessionOver: true, sessionDate: "2026-10-14", nextSession: "2026-10-15", tradingDay: true });
check("a list made for another session is never shown as today's", !h.includes("RBLBANK") && h.includes("not ready yet"));
// in session, signals made for today
h = sbFocusBox({ oiFlow: of("2026-10-13", [sig("RBLBANK", "2026-10-13")]), sessionOver: false, sessionDate: "2026-10-14", nextSession: "2026-10-14", tradingDay: true });
check("in session, today's list is shown", h.includes("RBLBANK") && h.includes("14 Oct"));
h = sbFocusBox({ oiFlow: of("2026-10-13", []), sessionOver: false, sessionDate: "2026-10-14", nextSession: "2026-10-14", tradingDay: true });
check("no signal says so plainly", h.includes("No short build-up signal"));
check("it says paper, GM only, not real money", h.includes("GM Global only, not real money"));
// Friday's files make Monday's list
h = sbFocusBox({ oiFlow: of("2026-10-16", [sig("PFC", "2026-10-16")]), sessionOver: false, sessionDate: "2026-10-17", nextSession: "2026-10-19", tradingDay: false });
check("on a weekend, Friday's list is for Monday", h.includes("PFC") && h.includes("19 Oct"));
// The last session's result on futures (information only). Thu 15 Oct 2026, NSE's F&O file, October futures.
const fl = { date: "2026-10-15", void: 0, rows: [
  { symbol: "ATHERENERG", expiry: "2026-10-27", open: 1458, close: 1460.9 }, { symbol: "DIVISLAB", expiry: "2026-10-27", open: 9100, close: 9050 },
  { symbol: "LICHSGFIN", expiry: "2026-10-27", open: 538, close: 536.7 }, { symbol: "LTF", expiry: "2026-10-27", open: 260, close: 263.25 }] };
const withFl = (x) => { const o = of("2026-10-15", [sig("ABB", "2026-10-15")]); o.SB.futuresLast = x; return o; };
const after = { sessionOver: true, sessionDate: "2026-10-15", nextSession: "2026-10-16", tradingDay: true, gmMinUnits: 20 };
h = sbFocusBox({ oiFlow: withFl(fl), ...after });
check("the last result is dated and names the contract", h.includes("Last result, Thu, 15 Oct 2026") && h.includes("October futures (expiry 27 Oct)"));
check("rupees at 20 units, with real minus signs", ["+₹1,000", "+₹26", "−₹65", "−₹58", "+₹903"].every((x) => h.includes(x)));
check("2 of 4 won, average of the unrounded results", h.includes("2 of 4 won") && h.includes("average −0.16%"));
check("it says information only, and the test is scored on shares", h.includes("information only") && h.includes("scored on share prices"));
check("the list for the next session is still shown", h.includes("ABB") && h.includes("16 Oct"));
h = sbFocusBox({ oiFlow: withFl({ ...fl, rows: [fl.rows[1], { symbol: "XYZ", missing: true }] }), ...after });
check("a missing futures price is never ₹0", h.includes("no futures price") && !h.includes("₹0") && h.includes("1 of 1 won"));
h = sbFocusBox({ oiFlow: withFl({ date: "2026-10-15", rows: [], void: 0 }), ...after });
check("a session without trades says so", h.includes("no short build-up trade that day"));
h = sbFocusBox({ oiFlow: withFl(undefined), ...after });
check("an older file without the field renders as before", !h.includes("Last result") && h.includes("ABB"));
// the paper job's side: the contract is the earliest expiry on or after the day, read from NSE's file
const fsx = require("node:fs"), osx = require("node:os"), px = require("node:path"); const { futuresLast } = require("./oi-flow-forward");
const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "k2-fl-"));
fsx.writeFileSync(px.join(dir, "2026-10-27.json"), JSON.stringify([
  ["AAA", "STK", "2026-11-24", 110, 0, 0, 108, 0, 0, 0, 0], ["AAA", "STK", "2026-10-27", 100, 0, 0, 99, 0, 0, 0, 0], ["AAA", "IDX", "2026-10-27", 1, 0, 0, 2, 0, 0, 0, 0],
  ["BBB", "STK", "2026-10-27", null, 0, 0, 50, 0, 0, 0, 0]]));
const tr = (s, st = "DONE") => ({ symbol: s, entryDate: "2026-10-27", status: st });
const got = futuresLast([tr("BBB"), tr("AAA"), tr("CCC", "VOID (corporate action)"), { symbol: "AAA", entryDate: "2026-10-26", status: "DONE" }], "2026-10-27", dir);
check("on expiry day the expiring contract is used, not the next one", got.rows[0].symbol === "AAA" && got.rows[0].expiry === "2026-10-27" && got.rows[0].open === 100 && got.rows[0].close === 99);
check("a null open is missing, not 0", got.rows[1].symbol === "BBB" && got.rows[1].missing === true);
check("only that day's trades; a void trade is counted, not priced", got.rows.length === 2 && got.void === 1);
check("no file for the day: every row is missing, nothing crashes", futuresLast([{ symbol: "AAA", entryDate: "2026-10-28", status: "DONE" }], "2026-10-28", dir).rows[0]?.missing === true);
fsx.rmSync(dir, { recursive: true, force: true });

// LIVE NOW (api/_lib/paper-live.js): information only, on the list's own session, with that session's quotes only.
{
  const { paperRequests, paperLive } = require("../api/_lib/paper-live");
  const { nextTradingDate, feedDate } = require("./paper-ledger");
  const ofl = of("2026-10-16", [sig("DIXON", "2026-10-16"), sig("OLD", "2026-10-15")]);
  const kr = { days: { "2026-10-16": { entry: "2026-10-19", exit: "2026-10-26", enough: true, madeAt: "2026-10-16T15:17:34Z", long: [{ symbol: "IDEA", expiry: "2026-10-27" }], short: [{ symbol: "TCS", expiry: "2026-10-27" }] } } };
  const req = paperRequests({ oiFlow: ofl, kronos: kr, target: "2026-10-19", nextTradingDate, sbExpiry: () => "2026-10-27" });
  check("requests: today's short build-up and Kronos names only", req.map((r) => `${r.book}:${r.symbol}:${r.side}`).join() === "SB:DIXON:-1,KRONOS:IDEA:1,KRONOS:TCS:-1");
  const q = { DIXON: { price: 12700, open: 12827, previousClose: 12755, exchangeFeedTime: "19-Oct-2026 10:05:01" },
    IDEA: { price: 9.5, open: 9.2, previousClose: 9.1, exchangeFeedTime: "19-Oct-2026 10:05:02" }, TCS: { price: 3000, open: 3000, previousClose: 3010, exchangeFeedTime: "16-Oct-2026 15:29:59" } };
  const live = paperLive({ requests: req, sessionDate: "2026-10-19", inSession: true, getQuote: (s) => q[s], feedDate, units: 20 });
  const dx = live.rows.find((r) => r.symbol === "DIXON");
  check("gap is open over the PREVIOUS close", Math.abs(dx.gapPct - (12827 / 12755 - 1) * 100) < 1e-9);
  check("a short's paper P&L: (open - last) x 20", Math.round(dx.pnl) === 2540);
  check("a quote from another session is left out", !live.rows.some((r) => r.symbol === "TCS") && live.rows.length === 2);
  check("outside the session: nothing", paperLive({ requests: req, sessionDate: "2026-10-19", inSession: false, getQuote: (s) => q[s], feedDate }) === null);
  check("no open yet (before 09:15): nothing", paperLive({ requests: req.slice(0, 1), sessionDate: "2026-10-19", inSession: true, getQuote: () => ({ ...q.DIXON, open: 0 }), feedDate }) === null);
  const inS = { oiFlow: ofl, sessionOver: false, sessionDate: "2026-10-19", nextSession: "2026-10-19", tradingDay: true, gmMinUnits: 20, paperLive: live };
  h = sbFocusBox(inS);
  check("the box shows the live line in session", h.includes("Live now, 10:05 IST") && h.includes("+₹2,540") && h.includes("not part of the tested rule"));
  h = sbFocusBox({ ...inS, sessionOver: true, nextSession: "2026-10-21" });
  check("after the close the live line is gone (the next list is for another day)", !h.includes("Live now"));
  h = sbFocusBox({ ...inS, paperLive: null });
  check("no quotes: no live line, the list is still shown", !h.includes("Live now") && h.includes("DIXON"));
}
// FII / DII line (information only): latest saved day and the total since the first; nothing when there is no file.
{
  const { flowsLine } = require("./publish-static-desk");
  const f = { since: "2026-10-09", sessions: 2, fiiTotal: -2000.5, diiTotal: 3000, days: [{ date: "2026-10-16", fii: -851.86, dii: -201 }, { date: "2026-10-19", fii: -1148.64, dii: 3201.19 }] };
  const line = flowsLine({ flows: f });
  check("flows line: the latest day, signed, in crore", line.includes("Mon 19 Oct") && line.includes("&minus;&#8377;1,149 cr") && line.includes("+&#8377;3,201 cr"));
  check("flows line: the total since the first saved day, marked as not a signal", line.includes("since 9 Oct (2 sessions)") && line.includes("information, not a signal"));
  check("flows line: nothing without a file", flowsLine({}) === "" && flowsLine({ flows: { days: [] } }) === "");
}
console.log(failed ? `${failed} failed` : "sb focus box tests passed"); process.exit(failed ? 1 : 0);
