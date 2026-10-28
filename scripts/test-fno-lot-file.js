"use strict";
const assert = require("node:assert/strict");
const { parseLotFile, applyLotFile, buildReference } = require("../api/_lib/fno-reference");

// NSE's fo_mktlots.csv layout (padded cells, CRLF, blank later months), with the values of 28 Oct 2026.
const file = [
  "UNDERLYING                          ,SYMBOL    ,NOV-26     ,DEC-26     ,JAN-27     ,MAR-27     ",
  "NIFTY 50                            ,NIFTY     ,65         ,65         ,65         ,65         ",
  "BHEL                                ,BHEL      ,2625       ,2625       ,1250       ,           ",
  "LAURUS LABS LIMITED                 ,LAURUSLABS,425        ,425        ,425        ,           ",
  "Symbol,                             ,          ,           ,           ,           "
].join("\r\n");
const lots = parseLotFile(file);
assert.deepEqual(lots.BHEL, { "NOV-26": 2625, "DEC-26": 2625, "JAN-27": 1250 }, "lots are per contract month; blank cells are skipped");
assert.equal(lots.LAURUSLABS["NOV-26"], 425);
assert.equal(Object.keys(lots).length, 3, "a header-like row is not a symbol");

// A reference built from 27 Oct's bhavcopy still has LAURUSLABS at 850; on 28 Oct NSE's file says 425.
const row = (symbol, expiry, lot) => ({ FinInstrmTp: "STF", TckrSymb: symbol, XpryDt: expiry, NewBrdLotQty: String(lot), SttlmPric: "100", UndrlygPric: "100" });
const ref = buildReference([row("LAURUSLABS", "2026-11-23", 850), row("LAURUSLABS", "2026-12-29", 850),
  row("BHEL", "2026-11-23", 2625), row("BHEL", "2027-01-25", 1250)], "2026-10-27");
assert.equal(applyLotFile(ref, lots), 2);
assert.equal(ref.symbols.LAURUSLABS.expiries["2026-11-23"].lotSize, 425);
assert.equal(ref.symbols.LAURUSLABS.expiries["2026-12-29"].lotSize, 425);
assert.equal(ref.symbols.LAURUSLABS.lotSize, 425);
assert.equal(ref.symbols.BHEL.expiries["2026-11-23"].lotSize, 2625, "a month's own lot is kept");
assert.equal(ref.symbols.BHEL.expiries["2027-01-25"].lotSize, 1250);
assert.equal(ref.symbols.BHEL.lotSize, 2625, "the symbol's fallback lot is the nearest month's");
assert.equal(applyLotFile(ref, {}), 0, "an empty lot file changes nothing");
console.log("F&O lot file: NSE's per-month lots replace an earlier session's lots.");
