"use strict";
// Tests for scripts/nse-fii-dii.js (NSE's daily FII/DII cash figures; NSE keeps only the latest day).
const { parse } = require("./nse-fii-dii");
let passed = 0, failed = 0;
const check = (n, ok) => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}`); };
const good = [{ buyValue: "15626.53", category: "DII", date: "09-Oct-2026", netValue: "4743.26", sellValue: "10883.27" },
  { buyValue: "10373.99", category: "FII/FPI", date: "09-Oct-2026", netValue: "-3568.9", sellValue: "13942.89" }];   // NSE, 9 Oct 2026
const p = parse(good);
check("NSE's 9 Oct reply parses to its date and both nets", p && p.date === "2026-10-09" && p.FII.net === -3568.9 && p.DII.net === 4743.26);
check("a reply whose buy - sell is not its net is refused", parse([{ ...good[0], netValue: "1" }, good[1]]) === null);
check("two dates in one reply are refused", parse([good[0], { ...good[1], date: "08-Oct-2026" }]) === null);
check("an empty reply is refused", parse([]) === null);
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
