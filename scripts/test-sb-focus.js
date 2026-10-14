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
console.log(failed ? `${failed} failed` : "sb focus box tests passed"); process.exit(failed ? 1 : 0);
