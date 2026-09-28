"use strict";

/**
 * THE CHECK AGAINST NSE MUST CATCH A WRONG CONTRACT AND NOTHING ELSE.
 *
 * api/_lib/nse-crosscheck.js compares a sample of the page's rows, Angel One
 * against nseindia.com. The fixtures are NSE's and Angel One's own figures,
 * read on 2026-09-25 after the close. The two failures that matter: a wrong
 * contract passing (SBIN's September future priced as its October one), and a
 * false alarm turning a healthy build red (NSE unreachable, a contract not yet
 * traded, a share's two honest closing prices).
 */

const fc = require("../api/_lib/nse-crosscheck");
const { checkLivePath } = require("./check-desk-health");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

// ---- NSE's replies, in NSE's own shapes (2026-09-25, 16:00 IST) ----
const NSE = {
  "BEL|EQ": { equityResponse: [{ orderBook: { lastPrice: 393.55 }, metaData: { previousClose: 392, basePrice: 392, closePrice: 393.55 } }] },
  "IPCALAB|EQ": { equityResponse: [{ orderBook: { lastPrice: 1958.8 }, metaData: { previousClose: 1997.1, basePrice: 1997.1, closePrice: 1970.8 } }] },
  SBIN: { data: [
    { instrumentType: "FUTSTK", expiryDate: "29-Sep-2026", lastPrice: 982.8, prevClose: 981.3 },
    { instrumentType: "FUTSTK", expiryDate: "27-Oct-2026", lastPrice: 987.8, prevClose: 986.3 }] },
  "HAVELLS|2026-10-27": { records: { data: [{ strikePrice: 1060, CE: { lastPrice: 48, change: 3.65 } }] } }
};
const angel = (ltp, previousClose, trade = "25-Sep-2026 15:39:28") => ({ ltp, previousClose, exchangeTradeTime: trade });
const REQ = {
  bel: { kind: "EQ", symbol: "BEL" },
  ipca: { kind: "EQ", symbol: "IPCALAB" },
  sbinOct: { kind: "FUT", symbol: "SBIN", expiry: "2026-10-27" },
  havells: { kind: "OPT", symbol: "HAVELLS", expiry: "2026-10-27", strike: 1060, optionType: "CE" }
};
const SESSION = "2026-09-25";

console.log("check against NSE:");

check("the exchange clock is read as a date; the never-traded 1970 stamp stays 1970",
  fc.feedDay("25-Sep-2026 15:39:28") === "2026-09-25" && fc.feedDay("01-Jan-1970 05:30:00") === "1970-01-01" && fc.feedDay("") === null);

const opt = fc.nseFigures(REQ.havells, NSE["HAVELLS|2026-10-27"]);
check("an option's previous close is NSE's last price less its change (48.00 - 3.65 = 44.35)", opt && opt.prevClose === 44.35, JSON.stringify(opt));
const noChange = fc.nseFigures(REQ.havells, { records: { data: [{ strikePrice: 1060, CE: { lastPrice: 48 } }] } });
check("an option leg without its change has no known previous close -- never its last price, which would read as a wrong contract",
  noChange && noChange.prevClose === null && fc.compareOne(REQ.havells, angel(48, 44.35), noChange, SESSION).identity === "NO_PREVIOUS_CLOSE",
  JSON.stringify(noChange));
const fut = fc.nseFigures(REQ.sbinOct, NSE.SBIN);
check("a future is found by its own expiry, not the first one in NSE's list", fut && fut.prevClose === 986.3 && fut.last === 987.8, JSON.stringify(fut));

const same = fc.compareOne(REQ.sbinOct, angel(987.8, 986.3), fut, SESSION);
check("the same contract on both is SAME, with no price gap", same.identity === "SAME" && same.gapPct === 0, JSON.stringify(same));
const wrong = fc.compareOne(REQ.sbinOct, angel(982.8, 981.3), fut, SESSION);
check("SBIN's SEPTEMBER future priced as its October one is DIFFERENT -- the next expiry does not pass",
  wrong.identity === "DIFFERENT", JSON.stringify(wrong));
check("...even though its price is only 0.5% away, inside the price band", wrong.priceOff === false && wrong.gapPct < 1);

const stale = fc.compareOne(REQ.sbinOct, angel(986.3, 985, "24-Sep-2026 15:29:59"), fut, SESSION);
check("a contract not traded this session proves nothing either way", stale.identity === "NOT_TRADED_THIS_SESSION");
const never = fc.compareOne(REQ.havells, angel(44.35, 40, "01-Jan-1970 05:30:00"), opt, SESSION);
check("nor does one carrying the never-traded stamp", never.identity === "NOT_TRADED_THIS_SESSION");

const ipca = fc.compareOne(REQ.ipca, angel(1970.8, 1997.1, "25-Sep-2026 15:53:16"), fc.nseFigures(REQ.ipca, NSE["IPCALAB|EQ"]), SESSION);
check("after the close a share's closing-session price is NSE's too (IPCALAB 1970.80, not a 0.61% gap)",
  ipca.identity === "SAME" && ipca.gapPct === 0 && ipca.nse === 1970.8, JSON.stringify(ipca));

// ---- Monday 28 Sep, 09:13: NSE's page had not rolled over to the new session ----
// NSE's own 25 Sep file for WIPRO OCT FUT: LastPric 162.55, ClsPric 162.35, PrvsClsgPric 162.87.
const wiproReq = { kind: "FUT", symbol: "WIPRO", expiry: "2026-10-27" };
const wiproFile = { last: 162.55, close: 162.35, prevClose: 162.87 };
const wiproNse = { last: 162.55, prevClose: 162.87 };   // NSE's page at 09:13 on 28 Sep
const monday = fc.compareOne(wiproReq, angel(162.49, 162.35, "28-Sep-2026 09:09:02"), wiproNse, "2026-09-28", wiproFile);
check("NSE's page still showing Friday is not a different contract (WIPRO OCT FUT, 28 Sep 09:13)",
  monday.identity === "NSE_NOT_ROLLED_TO_TODAY" && monday.priceOff === false, JSON.stringify(monday));
check("...which is what the check said without the file: the false alarm of 28 Sep",
  fc.compareOne(wiproReq, angel(162.49, 162.35, "28-Sep-2026 09:09:02"), wiproNse, "2026-09-28").identity === "DIFFERENT");
check("once NSE rolls over, the same contract is SAME",
  fc.compareOne(wiproReq, angel(160.2, 162.35, "28-Sep-2026 09:40:00"), { last: 160.25, prevClose: 162.35 }, "2026-09-28", wiproFile).identity === "SAME");
check("and a wrong contract is still DIFFERENT with the file present",
  fc.compareOne(wiproReq, angel(160.2, 158.1, "28-Sep-2026 09:40:00"), { last: 160.25, prevClose: 162.35 }, "2026-09-28", wiproFile).identity === "DIFFERENT");
check("on the weekend both carry Friday's session: SAME, not 'not rolled'",
  fc.compareOne(wiproReq, angel(162.55, 162.87, "25-Sep-2026 15:29:00"), wiproNse, "2026-09-25", wiproFile).identity === "SAME");
check("a stale NSE page never turns the build red", !fc.summarise([monday]).wrongContract.length && fc.summarise([monday]).pricesMostlyOff === false);

const band = (ours, theirs) => fc.compareOne(REQ.havells, angel(ours, 44.35), { last: theirs, prevClose: 44.35 }, SESSION);
check("an option 5% apart in seconds is within the band", band(2.0, 2.1).priceOff === false);
check("an option 20% and 8 ticks apart is flagged", band(2.0, 2.4).priceOff === true);
check("an option 12% but only 2 ticks apart is not -- one tick on 1 rupee is 5%", band(1.0, 1.12).priceOff === false);

// ---- the whole check, with NSE's site faked at the network ----
function fakeNse({ down = false, status = 200 } = {}) {
  return async (url) => {
    if (down) throw new Error("getaddrinfo ENOTFOUND www.nseindia.com");
    if (!url.includes("/api/")) return { ok: true, status: 200, headers: { getSetCookie: () => ["nsit=abc; Path=/"] }, json: async () => ({}) };
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const q = new URL(url).searchParams;
    const sym = q.get("symbol");
    const body = url.includes("getSymbolData") ? NSE[`${sym}|EQ`]
      : url.includes("getSymbolDerivativesData") ? NSE[sym]
      : NSE[`${sym}|2026-10-27`];
    return { ok: true, status: 200, json: async () => body || {} };
  };
}
const reqs = [REQ.bel, REQ.sbinOct, REQ.havells];
const good = [angel(393.55, 392, "25-Sep-2026 15:58:17"), angel(987.8, 986.3), angel(48, 44.35)];

(async () => {
  const ok = await fc.crossCheck(reqs, { ours: async () => good, session: SESSION, fetchImpl: fakeNse(), pauseMs: 0 });
  check("a clean sample: checked, 3 of 3 the same contract, nothing flagged",
    ok.checked === true && ok.sameContract === 3 && ok.identityCompared === 3 && ok.wrongContract.length === 0 && ok.priceOff.length === 0,
    JSON.stringify({ ...ok, rows: undefined }));

  const bad = await fc.crossCheck(reqs, { ours: async () => [good[0], angel(982.8, 981.3), good[2]], session: SESSION, fetchImpl: fakeNse(), pauseMs: 0 });
  check("one wrong contract in the sample is named", bad.checked === true && bad.wrongContract.length === 1 && /SBIN 2026-10-27 FUT/.test(bad.wrongContract[0]),
    JSON.stringify(bad.wrongContract));

  const down = await fc.crossCheck(reqs, { ours: async () => good, session: SESSION, fetchImpl: fakeNse({ down: true }), pauseMs: 0 });
  check("NSE unreachable is NOT CHECKED, never failed", down.checked === false && /NSE not reached/.test(down.reason), JSON.stringify(down));
  const refused = await fc.crossCheck(reqs, { ours: async () => good, session: SESSION, fetchImpl: fakeNse({ status: 403 }), pauseMs: 0 });
  check("NSE refusing every request is NOT CHECKED too, and says why", refused.checked === false && refused.nseErrors.includes("HTTP 403"),
    JSON.stringify({ ...refused, rows: undefined }));

  // A STALL, not a refusal: NSE holds some cloud addresses open instead of
  // answering. These fetches never settle and ignore their abort signal, the
  // worst case; the check must still come back, quickly, as not checked.
  const never = () => new Promise(() => {});
  let t0 = Date.now();
  const stalled = await fc.crossCheck(reqs, { ours: async () => good, session: SESSION, fetchImpl: never, pauseMs: 0, timeoutMs: 200, budgetMs: 500 });
  check("NSE stalling on the first request: not checked, and back in well under a second",
    stalled.checked === false && /no answer/.test(stalled.reason) && Date.now() - t0 < 1500, `${stalled.reason} in ${Date.now() - t0} ms`);
  const home = fakeNse();
  const apiStalls = async (url, init) => (url.includes("/api/") ? never() : home(url, init));
  t0 = Date.now();
  const slow = await fc.crossCheck([...reqs, { kind: "EQ", symbol: "IPCALAB" }, { kind: "FUT", symbol: "BEL", expiry: "2026-10-27" }],
    { ours: async () => [...good, null, null], session: SESSION, fetchImpl: apiStalls, pauseMs: 0, timeoutMs: 200, budgetMs: 500 });
  check("every quote stalling: the budget stops the asking -- not checked, back in about a second",
    slow.checked === false && slow.nseErrors.some((e) => /budget/.test(e)) && Date.now() - t0 < 2000,
    `${JSON.stringify(slow.nseErrors)} in ${Date.now() - t0} ms`);
  const hungAngel = await fc.crossCheck(reqs, { ours: never, session: SESSION, fetchImpl: fakeNse(), pauseMs: 0, timeoutMs: 100 });
  check("our own feed stalling on the re-quote is not checked too", hungAngel.checked === false && /Angel One re-quote failed/.test(hungAngel.reason), hungAngel.reason);

  // ---- the rotating sample ----
  const futures = [{ symbol: "BEL", priceBasis: "CONTRACT", expiry: "2026-10-27" }, { symbol: "IEX", priceBasis: "SHARE", expiry: "2026-10-27" },
    { symbol: "SBIN", priceBasis: "CONTRACT", expiry: "2026-10-27" }, { symbol: "TCS", priceBasis: "SHARE", expiry: null }, { symbol: "WIPRO", priceBasis: "CONTRACT", expiry: "2026-10-27" }];
  const options = Array.from({ length: 30 }, (_, i) => ({ symbol: "HAVELLS", expiry: "2026-10-27", strike: 1000 + 20 * i, right: "CE" }));
  const s0 = fc.sampleRows({ futures, options, nowMs: 0 });
  check("each build samples 4 from the futures tab and 12 from the options tab", s0.length === 16
    && s0.filter((r) => r.kind === "OPT").length === 12);
  check("a futures row is checked on the instrument its level froze on: the contract, or the share",
    s0.some((r) => r.kind === "FUT" && r.symbol === "BEL") && s0.some((r) => r.kind === "EQ" && r.symbol === "IEX"));
  const seen = new Set();
  for (let slot = 0; slot < 6; slot += 1) for (const r of fc.sampleRows({ futures, options, nowMs: slot * 20 * 60_000 })) seen.add(fc.label(r));
  check("a few builds walk the whole page", seen.size === futures.length + options.length, `${seen.size} of ${futures.length + options.length}`);

  // ---- the gate ----
  const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
  const live = { marketPhase: "OPEN", brokerCheck: { ok: true }, pricedLive: 202, levelsFrozen: true, quoteStatus: { lastExchangeDate: "2026-09-24" } };
  const red = checkLivePath({ ...live, feedCheck: bad }, ist("2026-09-24", "11:13"));
  check("in session, a wrong contract turns the build RED", red.problems.length === 1 && /WHICH contract/.test(red.problems[0]), red.problems.join(" | "));
  check("NSE unreachable leaves it green", checkLivePath({ ...live, feedCheck: down }, ist("2026-09-24", "11:13")).problems.length === 0);
  check("a clean check leaves it green", checkLivePath({ ...live, feedCheck: ok }, ist("2026-09-24", "11:13")).problems.length === 0);
  check("after the close the gate does not judge it", checkLivePath({ ...live, marketPhase: "CLOSED", feedCheck: bad }, ist("2026-09-24", "15:53")).problems.length === 0);
  const mostly = { ...ok, pricesMostlyOff: true, priceOff: ["a", "b"] };
  check("prices off on most of the sample -- a stale or mis-scaled feed -- is red too",
    /differ from NSE/.test(checkLivePath({ ...live, feedCheck: mostly }, ist("2026-09-24", "11:13")).problems[0] || ""));

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack); process.exit(1); });
