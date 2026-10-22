"use strict";
// Tests for the GM tournament summary on TRACK (scripts/gm-tournament-json.js and gmTournamentBox).
const { build } = require("./gm-tournament-json");
const { gmTournamentBox } = require("./publish-static-desk");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const lb = [
  { member: "SB short build-up", trades: 8599, u20: 1513937, pctMean: 0.218, t: 3.94, dsr: 0.57, verdict: "PROMISING", fitted: true, duplicateOf: null },
  { member: "orderflow B3 short build-up -> short 1d", trades: 8505, u20: 1494711, pctMean: 0.218, t: 3.91, dsr: 0.57, verdict: "PROMISING", fitted: true, duplicateOf: "SB short build-up" },
  { member: "SD springy dip", trades: 3449, u20: -354269, pctMean: 0.307, t: 1.67, dsr: 0.01, verdict: "FAIL", fitted: false, duplicateOf: null },
  { member: "X", trades: 10, u20: 0, pctMean: 0, verdict: "NOT TESTABLE" }];
const conf = { rows: [{ member: "SB short build-up", verdict: "CONFIRMED", t: 4.1, trades: 30000, u20: 100 }, { member: "CM1 trees long-short", verdict: "NOT CONFIRMABLE" }] };
const g = build(lb, conf);
check("counts only tested members, and the passes", g.members === 3 && g.pass === 0 && g.promising === 2);
check("plain names for the owner; a duplicate names its original", g.top[0].label === "Short build-up (your focus rule)" && g.top[1].duplicateOf === "Short build-up (your focus rule)");
const html = gmTournamentBox(g);
check("the verdict line: 0 PASS of 3, the best by t, rupees on 20 units", /0 PASS of 3\./.test(html) && /Short build-up \(your focus rule\)<\/b>, t 3.94/.test(html) && /\+&#8377;15.1 lakh/.test(html));
check("the re-check line names each verdict", /2005&ndash;2020 re-check: Short build-up \(your focus rule\) <b class="up">CONFIRMED<\/b> \(t 4.1\)/.test(html) && /NOT CONFIRMABLE/.test(html));
check("a losing total shows a minus sign, kept on one line", /&minus;&#8377;3.5 lakh/.test(html));
check("the table waits behind a tap; the method sits in the notes", /<details class="fold">/.test(html) && /class="sub lec"/.test(html));
check("before the re-check: says it is running", /re-check: running/.test(gmTournamentBox(build(lb, null))));
check("no file: nothing", gmTournamentBox(null) === "");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("gm tournament box tests passed");
