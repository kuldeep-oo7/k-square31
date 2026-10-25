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

// THE EXPIRY-DAY PAPER TRADE, LIVE (api/_lib/expiry-live.js, amendment A1)
const { expiryRequest, expiryLive } = require("../api/_lib/expiry-live");
const { expiryLiveLine } = require("./publish-static-desk");
const feedDate = require("./paper-ledger").feedDate;
check("fetch on an expiry session only, centred on NIFTY's open", JSON.stringify(expiryRequest({ today: "2026-10-27", expiries: ["2026-10-27", "2026-11-03"], niftyOpen: 22612.4 })) === JSON.stringify({ symbol: "NIFTY", expiry: "2026-10-27", referencePrice: 22612.4 })
  && expiryRequest({ today: "2026-10-26", expiries: ["2026-10-27"], niftyOpen: 22612.4 }) === null && expiryRequest({ today: "2026-10-27", expiries: ["2026-10-27"], niftyOpen: null }) === null);
const qt = (strike, optionType, open, high, lastPrice, extra = {}) => ({ symbol: "NIFTY", expiry: "2026-10-27", strike, optionType, open, high, lastPrice, exchangeFeedTime: "27-Oct-2026 10:13:05", ...extra });
const quotes = { a: qt(22600, "CE", 118.5, 140, 64.3), b: qt(22600, "PE", 95.2, 120, 120.1), c: qt(22650, "CE", 90, 100, 40), d: qt(22650, "PE", 120, 150, 140),
  e: qt(22600, "CE", 1, 1, 1, { expiry: "2026-11-03" }), f: qt(22550, "PE", 70, 80, 90, { exchangeFeedTime: "23-Oct-2026 15:29:59" }) };
const el = expiryLive({ today: "2026-10-27", niftyOpen: 22612.4, quotes, lot: 65, feedDate });
check("X2 legs are the strikes nearest NIFTY's open, sold at their opens", el && el.legs[0].strike === 22600 && el.legs[0].type === "CE" && el.legs[1].strike === 22600 && el.legs[1].type === "PE" && el.credit === 213.7, JSON.stringify(el?.legs));
check("held legs are marked at the last price: +29.3 points, +Rs 1,905 a lot", el.points === 29.3 && el.rupees === 1905 && el.at === "27-Oct-2026 10:13:05", `${el.points} ${el.rupees}`);
const tie = expiryLive({ today: "2026-10-27", niftyOpen: 22625, quotes, lot: 65, feedDate });
check("a tie takes the higher call and the lower put, as the study", tie.legs[0].strike === 22650 && tie.legs[1].strike === 22600, JSON.stringify(tie.legs.map((l) => l.strike)));
const st = expiryLive({ today: "2026-10-27", niftyOpen: 22612.4, quotes: { ...quotes, b: qt(22600, "PE", 95.2, 190.4, 150) }, lot: 65, feedDate });
check("a high at 2x stops the leg at 2x, whatever the last price", st.legs[1].stopped && st.legs[1].points === -95.2 && st.points === +(54.2 - 95.2).toFixed(2), JSON.stringify(st.legs[1]));
const nt = expiryLive({ today: "2026-10-27", niftyOpen: 22612.4, quotes: { ...quotes, a: qt(22600, "CE", 0, 0, 0) }, lot: 65, feedDate });
check("a leg with no open yet keeps its strike and has no result", nt.legs[0].strike === 22600 && nt.legs[0].open === null && nt.points === null && nt.credit === null);
check("nothing from another day or with no NIFTY open", expiryLive({ today: "2026-10-28", niftyOpen: 22612.4, quotes, lot: 65, feedDate }) === null && expiryLive({ today: "2026-10-27", niftyOpen: null, quotes, lot: 65, feedDate }) === null);
const line = expiryLiveLine(el);
check("the line: result first, each leg's own result, stop and last, NIFTY's open, before charges", /^<div[^>]*><b class="up">\+29\.3 points \(\+₹1,905 a lot\)<\/b> today on paper, 10:13: 22600 CE <b class="up">\+54\.2<\/b>: sold 118\.50, stop 237\.00, last 64\.30; 22600 PE <b class="down">&minus;24\.9<\/b>: sold 95\.20, stop 190\.40, last 120\.10\. NIFTY opened 22,612\.4\. Before charges\.<\/div>$/.test(line), line);
const sl = expiryLiveLine(st);
check("a stopped leg says so, a loss carries a real minus", /<b class="down">&minus;41\.0 points \(&minus;₹2,665 a lot\)<\/b>/.test(sl) && /22600 PE <b class="down">&minus;95\.2<\/b>: sold 95\.20, <b class="down">stopped at 190\.40<\/b>/.test(sl), sl);
check("a leg with no open says so, with no result", /22600 CE: not traded yet; 22600 PE <b class="down">&minus;24\.9<\/b>: sold/.test(expiryLiveLine(nt)), expiryLiveLine(nt));
const withClose = expirySellingBox(built, null, 22600);
check("the worst expiry is priced at NIFTY's last close and NSE's lot: -721 points, -Rs 47,000 a lot of 65", /about <span class="amt">&minus;721 points<\/span>, <span class="amt">&minus;₹47,000<\/span> a lot of 65 at NIFTY 22,600/.test(withClose), withClose.match(/Worst expiry[^<]*/)?.[0]);
check("no NIFTY level, no made-up rupees", /of NIFTY\. Selling needs margin/.test(html) && !/at NIFTY 22,800/.test(html));
check("the call side and the put side, with the verdict and the warning, reasons in the notes", /Call side <b>\+15\.0<\/b>, put side <b>\+2\.6<\/b> points an expiry in the test: no proven difference \(t &minus;1\.48\)\. One side alone is a bet on NIFTY/.test(html) && /class="sub lec">Call against put/.test(html));
check("each expiry's row shows its call and put results", /CE [+&][^<]*\/ PE /.test(html), html.match(/<tr><td><b>[^]*?<\/tr>/)?.[0]);
check("no live trade, no line; the box carries it when there is one", expiryLiveLine(null) === "" && expirySellingBox(built, el).includes("today on paper") && !expirySellingBox(built).includes("today on paper"));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("expiry forward tests passed");

// THE FILL AUDIT (scripts/expiry-fills-report.js, amendment A1)
{
  const { fills } = require("./expiry-fills-report");
  const rows = [["2026-10-27", 22600, "CE", 118.5, 140, 50, 60, 22650, 0, 0], ["2026-10-27", 22600, "PE", 95.2, 200, 40, 0.05, 22650, 0, 0],
    ["2026-10-27", 22850, "CE", 30, 40, 5, 0.05, 22650, 0, 0], ["2026-10-27", 22400, "PE", 25, 30, 2, 0.05, 22650, 0, 0]];
  const day = ef.expiryDay({ date: "2026-10-27", rows }, 22612.4);
  const bk = (b, a) => [[[b, 650, 3]], [[a, 650, 2]]];
  const ln = (ist, t, opts) => ({ ist, t, options: opts });
  const lines = [ln("2026-10-27 09:12", "2026-10-27T03:42:00Z", [["NIFTY|2026-10-27|22600|CE", 120, 0, 0, 0, 0, 0, ...bk(119, 121), "x"]]),
    ln("2026-10-27 09:17", "2026-10-27T03:47:00Z", [["NIFTY|2026-10-27|22600|CE", 116, 0, 0, 0, 0, 0, ...bk(115.5, 116.5), "x", 118.5, 119, 114],
      ["NIFTY|2026-10-27|22600|PE", 96, 0, 0, 0, 0, 0, ...bk(95, 96.5), "x", 95.2, 97, 94]]),
    ln("2026-10-27 11:33", "2026-10-27T06:03:00Z", [["NIFTY|2026-10-27|22600|PE", 185, 0, 0, 0, 0, 0, ...bk(184, 186), "x", 95.2, 191, 94]]),
    ln("2026-10-27 11:53", "2026-10-27T06:23:00Z", [["NIFTY|2026-10-27|22600|PE", 199, 0, 0, 0, 0, 0, ...bk(198, 201), "x", 95.2, 200, 94]])];
  const f = fills({ date: "2026-10-27", day, lines });
  check("fill audit: the first recorded bid after 09:15 is the achievable sale", f.X2[0].sale.bid === 115.5 && f.X2[0].sale.at === "09:17" && f.X2[0].sale.vsOpen === -3, JSON.stringify(f.X2[0]));
  check("fill audit: a stopped leg's buy-back is the first ask once the recorded high reached 2x", f.X2[1].stopped && f.X2[1].buyBack.ask === 186 && f.X2[1].buyBack.at === "11:33" && f.X2[1].buyBack.vsStop === -4.4, JSON.stringify(f.X2[1]));
  check("fill audit: a leg the desk never recorded says so", f.X4[0].strike === 22850 && f.X4[0].sale === null && f.X4[0].recorded === 0);
  console.log(`fill audit checks done: ${passed} passed, ${failed} failed so far`);
  if (failed) process.exit(1);
}
