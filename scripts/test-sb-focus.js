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
console.log(failed ? `${failed} failed` : "sb focus box tests passed"); process.exit(failed ? 1 : 0);
