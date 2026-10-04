"use strict";
// Tests for nse-market-context.js officialClose (audit F27): after the close, India VIX is NSE's official close.
const { officialClose } = require("../api/_lib/nse-market-context");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const csv = "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume\n"
  + "Nifty 50,29-09-2026,22800,22850,22650,22716.2,-63.5,-.28,1\nIndia VIX,29-09-2026,13.6375,14.77,13.2125,13.41,-0.23,-1.65,-\n";
(async () => {
  let asked = null;
  const ok = await officialClose("29-Sep-2026 15:30:00", { fetcher: async (url) => { asked = url; return { ok: true, text: async () => csv }; } });
  check("reads NSE's file for the session in allIndices' timestamp", /ind_close_all_29092026\.csv$/.test(asked), asked);
  check("India VIX is the official close (13.41), not the 15:30 value (13.32)", ok.vix.close === 13.41 && ok.vix.changePct === -1.65);
  check("Nifty 50 too", ok.nifty.close === 22716.2);
  check("no file yet (during a session) means no override", (await officialClose("05-Oct-2026 10:00:00", { fetcher: async () => ({ ok: false }) })) === null);
  check("an unreadable timestamp means no override", (await officialClose("garbage", { fetcher: async () => { throw new Error("not called"); } })) === null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
