"use strict";
// Tests for api/_lib/expiry-forward.js (expiry-day NIFTY option selling, forward paper test) and its TRACK box.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const ef = require("../api/_lib/expiry-forward");
const { roundTripCost } = require("../api/_lib/trade-costs");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const cost = (entry, exit) => roundTripCost({ entryPremium: Math.max(exit, 0.05), exitPremium: entry, quantity: 75 }).totalCost / 75 + 1;
const near = (a, b) => Math.abs(a - b) < 1e-9;

// one leg
const a = ef.leg(["2026-10-27", 23000, "CE", 100, 150], 23050, false, true);
check("a call held to settlement pays its premium minus intrinsic and costs", near(a.pnl, 100 - 50 - cost(100, 50)), a.pnl);
const b = ef.leg(["2026-10-27", 23000, "CE", 100, 200], 23050, true, true);
check("with a stop, a high at 2x buys the leg back at 2x", b.stopped && near(b.pnl, 100 - 200 - cost(100, 200)), b.pnl);
const c = ef.leg(["2026-10-27", 23000, "PE", 100, 199.95], 22900, true, true);
check("a high just under 2x is not stopped: settled at intrinsic", !c.stopped && near(c.pnl, 100 - 100 - cost(100, 100)), c.pnl);
check("a leg with no open is missing", ef.leg(["2026-10-27", 23000, "PE", 0, 10], 22900, false, true) === null);
// strikes nearest the target; a tie goes to the farther-from-the-money strike
const rows = [[0, 22950, "CE"], [0, 23050, "CE"], [0, 22950, "PE"], [0, 23050, "PE"]];
check("a tie between two calls takes the higher strike", ef.nearest(rows, "CE", 23000)[1] === 23050);
check("a tie between two puts takes the lower strike", ef.nearest(rows, "PE", 23000)[1] === 22950);
// a whole expiry
const R = (K, typ, open, high) => ["2026-10-27", K, typ, open, high, 0, 0, 22980, 0, 0];
const day = { date: "2026-10-27", open: 23010, settle: 22980, rows: [R(23000, "CE", 120, 130), R(23000, "PE", 110, 240), R(23250, "CE", 40, 45), R(22800, "PE", 35, 80), ["2026-11-03", 23000, "CE", 300, 310, 0, 0, 0, 0, 0]] };
const { out, skipped } = ef.run([day], true);
const x2 = out.X2[0], x1 = out.X1[0];
check("X1 sells the ATM call and put and holds", x1 && x1.call === 23000 && x1.put === 23000 && x1.stops === 0 && near(x1.points, (120 - 0 - cost(120, 0)) + (110 - 20 - cost(110, 20))), x1 && x1.points);
check("X2 stops the put that doubled", x2 && x2.stops === 1 && near(x2.points, (120 - 0 - cost(120, 0)) + (110 - 220 - cost(110, 220))), x2 && x2.points);
check("X3 takes the 1% strangle strikes", out.X3[0] && out.X3[0].call === 23250 && out.X3[0].put === 22800);
check("returns are in % of NIFTY's open", near(x1.pct, (x1.points / 23010) * 100));
check("only the expiring rows count; nothing skipped", skipped === 0 && out.X1.length === 1);
check("no NIFTY open: the expiry is skipped and counted", ef.run([{ ...day, open: null }], true).skipped === 1);
// the forward verdict
const mk = (vals) => vals.map((v, i) => ({ date: `2027-${String(1 + (i % 12)).padStart(2, "0")}-01`, pct: v, points: v * 230 }));
check("under 52 expiries: COLLECTING", ef.summary(mk(Array(51).fill(0.1))).verdict === "COLLECTING");
const good = mk(Array.from({ length: 52 }, (_, i) => (i % 3 === 0 ? -0.2 : 0.25)));
check("52 expiries, mean above 0 and t >= 1.68: CONFIRMED", ef.summary(good).verdict === "CONFIRMED", JSON.stringify(ef.summary(good)));
const flat = mk(Array.from({ length: 52 }, (_, i) => (i % 2 ? -0.3 : 0.3)));
check("52 expiries, no edge: NOT CONFIRMED", ef.summary(flat).verdict === "NOT CONFIRMED");
// the paper job's script, on two days' files (one before the start, one expiry after it)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-ef-")); const nod = path.join(tmp, "nod"), idx = path.join(tmp, "idx"); fs.mkdirSync(nod); fs.mkdirSync(idx);
fs.writeFileSync(path.join(nod, "2026-10-20.json.gz"), zlib.gzipSync(JSON.stringify({ date: "2026-10-20", lot: 65, rows: [["2026-10-20", 23000, "CE", 100, 100, 0, 0, 22900, 0, 0], ["2026-10-20", 23000, "PE", 100, 100, 0, 0, 22900, 0, 0]] })));
fs.writeFileSync(path.join(nod, "2026-10-27.json.gz"), zlib.gzipSync(JSON.stringify({ date: "2026-10-27", lot: 65, rows: day.rows })));
fs.writeFileSync(path.join(idx, "2026-10-20.json"), JSON.stringify({ "Nifty 50": [22950, 0, 0, 22900] })); fs.writeFileSync(path.join(idx, "2026-10-27.json"), JSON.stringify({ "Nifty 50": [23010, 0, 0, 22980] }));
const built = require("./expiry-forward").build({ nodDir: nod, idxDir: idx });
check("an expiry before 27 Oct 2026 is never counted", built.expirySessions === 1 && built.members.X2.expiries.length === 1 && built.members.X2.expiries[0].date === "2026-10-27");
check("NSE's own lot size is kept for rupees a lot", built.lot === 65);
// the TRACK box
const { expirySellingBox } = require("./publish-static-desk");
const html = expirySellingBox(built);
check("the box shows the verdict line and rupees a lot at NSE's lot", /COLLECTING/.test(html) && /points an expiry/.test(html) && /a lot\)/.test(html));
const empty = expirySellingBox({ ...built, nextExpiry: "2026-10-27", members: Object.fromEntries(Object.keys(built.members).map((k) => [k, { ...built.members[k], summary: { expiries: 0, verdict: "COLLECTING" }, expiries: [] }])) });
check("before the first expiry it names the date, nothing more", /first expiry Tue,? 27 Oct/.test(empty) && !/<table/.test(empty));
check("it is labelled paper only, and the reasons sit in the notes", /paper only/.test(html) && /class="sub lec"/.test(html));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("expiry forward tests passed");
