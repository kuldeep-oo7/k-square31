"use strict";
// Tests for scripts/nse-all-reports.js: NSE's All Reports list -> files to fetch.
const { filesFromList, isoOf } = require("./nse-all-reports");
let passed = 0, failed = 0;
const check = (n, ok) => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const list = { PreviousDay: [{ displayName: "F&amp;O-Participant wise Open Interest (csv)", fileActlName: "fao_participant_oi_08102026.csv", filePath: "https://nsearchives.nseindia.com/content/nsccl/", tradingDate: "08-Oct-2026" }],
  CurrentDay: [{ displayName: "F&O-Begin day SPAN <sup>&reg;</sup> file", fileActlName: "nsccl.20261009.i1.zip", filePath: "https://nsearchives.nseindia.com/archives/nsccl/span", tradingDate: "09-Oct-2026" },
    { displayName: "evil", fileActlName: "x.csv", filePath: "https://example.com/", tradingDate: "09-Oct-2026" },
    { displayName: "dup", fileActlName: "nsccl.20261009.i1.zip", filePath: "https://nsearchives.nseindia.com/archives/nsccl/span/", tradingDate: "09-Oct-2026" }] };
const f = filesFromList("FO", list);
check("NSE's dates become ISO folders", isoOf("08-Oct-2026") === "2026-10-08" && f.some((x) => x.date === "2026-10-08"));
check("a path without a trailing slash still makes the right URL", f.some((x) => x.url === "https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.20261009.i1.zip"));
check("a file not on NSE's own hosts is never fetched", !f.some((x) => /example\.com/.test(x.url)));
check("the same file listed twice is fetched once", f.filter((x) => x.name === "nsccl.20261009.i1.zip").length === 1);
check("display names lose NSE's HTML", f.every((x) => !/[<>]|&reg;/.test(x.display)));
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
