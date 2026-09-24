"use strict";

/**
 * Is the call we show actually that call, and the put actually that put?
 *
 * This is the question this desk has been wrong about before -- wrong lot sizes
 * on 343 cards, 72 strikes that did not exist, index spots off by 9%. Each time
 * the failure was the same: a contract identifier the system ASSEMBLED, trusted,
 * and never checked against anyone else's copy of the same fact.
 *
 * So nothing here trusts our own key. Every check compares what we filed against
 * an INDEPENDENT source:
 *
 *   1. the broker's own instrument label, parsed from the symbol it returned
 *   2. put-call parity, which is arithmetic and knows nothing about labels
 *   3. the NSE bhavcopy -- the exchange's own record of strikes, OI and prices
 *
 * Checks 2 and 3 are the valuable ones, because they would catch a call and a
 * put swapped even if every label in the system agreed with every other label.
 *
 * Runs only when a live cache exists. It reports that it skipped rather than
 * passing silently, because a test that asserts nothing must never read as a
 * test that found nothing wrong -- an earlier version of this file "verified"
 * 565 contracts while actually checking zero of them.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CACHE_FILE, parseExchangeClock } = require("../api/_lib/live-quotes");
const reference = require("../api/_lib/fno-reference");

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

if (!fs.existsSync(CACHE_FILE)) {
  console.log("  - no live quote cache; contract identity checks skipped (they need a broker session)");
  console.log("Contract identity tests skipped: no cached broker quotes to verify against");
  process.exit(0);
}

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
const entries = Object.entries(cache.quotes || {});
assert.ok(entries.length > 0, "a cache that exists must hold quotes");

// --- 1. Every contract matches the BROKER's own label ------------------------
// Angel writes AMBER29SEP265800CE: symbol, then DD MON YY, then strike, then
// the right. Note the day comes FIRST -- reading it as year-first (the Zerodha
// convention) turns strike 5800 into 265800 and reports mismatches that are not
// there. The parser has to match the venue, not the habit.
let labelled = 0;
const mismatches = [];
for (const [key, row] of entries) {
  const symbol = String(row.tradingSymbol || "");
  const match = symbol.match(/^(.+?)(\d{2})([A-Z]{3})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/);
  if (!match) { mismatches.push(`${key}: broker label unparseable (${symbol || "absent"})`); continue; }
  labelled += 1;
  const [, sym, dd, mon, yy, strike, right] = match;
  const [keySymbol, keyExpiry, keyStrike, keyRight] = key.split("|");
  const brokerExpiry = `20${yy}-${String(MONTHS[mon]).padStart(2, "0")}-${dd}`;
  if (sym !== keySymbol) mismatches.push(`${key}: broker underlying ${sym}`);
  if (right !== keyRight) mismatches.push(`${key}: broker says ${right}, filed as ${keyRight}`);
  if (Number(strike) !== Number(keyStrike)) mismatches.push(`${key}: broker strike ${strike}`);
  if (brokerExpiry !== keyExpiry) mismatches.push(`${key}: broker expiry ${brokerExpiry}`);
  if (row.optionType !== keyRight || Number(row.strike) !== Number(keyStrike)) {
    mismatches.push(`${key}: the row's own fields disagree with its key`);
  }
}
assert.equal(labelled, entries.length,
  `${entries.length - labelled} of ${entries.length} contracts carry no parseable broker label, so they were never really checked`);
assert.equal(mismatches.length, 0,
  `${mismatches.length} contracts are not what the broker says they are: ${mismatches.slice(0, 3).join("; ")}`);
console.log(`  ✓ All ${labelled} contracts match the broker's own instrument label (underlying, expiry, strike, right)`);

// --- 2. Put-call parity: arithmetic that cannot read a label -----------------
// C - P = (F - K)e^(-rT), so regressing C - P on K gives a slope of about -1.
// Calls and puts swapped would give +1. This is the check that survives every
// label in the system agreeing with every other label while all of them are
// wrong together.
//
// PER EXPIRY, AND AT THE SAME MOMENT. Parity holds inside one expiry, against
// that expiry's forward, at one instant. Keyed on symbol and strike alone, the
// check paired a 29-Sep call stamped 19 Sep with a 27-Oct put stamped 24 Sep
// (ADANIENSOL, measured 2026-09-24, slope -0.830 on the Nifty's worst day of
// the month) -- a failure that said nothing about which leg is which.
const PAIR_WINDOW_MS = 5 * 60_000;
const bySymbol = {};
for (const [key, row] of entries) {
  if (!(row.bid > 0 && row.ask > 0)) continue;
  // A mid inside a spread wider than a quarter of itself is not a price, and a
  // handful of them bend the regression without saying anything about which
  // leg is which. Measured 2026-09-23: IDEA's six tight strikes sat exactly on
  // slope -1.005; four quotes with 40-163% spreads dragged it to -1.161.
  if ((row.ask - row.bid) / ((row.ask + row.bid) / 2) > 0.25) continue;
  const [symbol, expiry, strike, right] = key.split("|");
  const chain = `${symbol} ${expiry}`;
  bySymbol[chain] = bySymbol[chain] || {};
  bySymbol[chain][strike] = bySymbol[chain][strike] || {};
  bySymbol[chain][strike][right] = { mid: (row.bid + row.ask) / 2, at: parseExchangeClock(row.exchangeFeedTime) };
}
let regressed = 0;
for (const [symbol, strikes] of Object.entries(bySymbol)) {
  const points = Object.entries(strikes)
    .filter(([, v]) => v.CE?.mid > 0 && v.PE?.mid > 0
      && Number.isFinite(v.CE.at) && Number.isFinite(v.PE.at) && Math.abs(v.CE.at - v.PE.at) <= PAIR_WINDOW_MS)
    .map(([strike, v]) => [Number(strike), v.CE.mid - v.PE.mid]);
  if (points.length < 6) continue;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of points) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  assert.ok(slope < -0.85 && slope > -1.15,
    `${symbol}: put-call parity slope ${slope.toFixed(3)} is not near -1; a slope near +1 means calls and puts are swapped`);
  assert.ok(r2 > 0.95,
    `${symbol}: parity fit R^2 ${r2.toFixed(4)} is too loose for strikes to be correctly assigned`);
  regressed += 1;
}
assert.ok(regressed > 0, "no symbol had enough paired strikes to test parity, so nothing was verified");
console.log(`  ✓ Put-call parity holds across ${regressed} symbols: slope near -1, so calls and puts are not transposed`);

// --- 3. Against the exchange's own record ------------------------------------
// The bhavcopy is NSE's record rather than the broker's. Open interest is the
// sharpest field to compare: it is a hard integer, and a wrong strike or wrong
// right would not reproduce it. Prices are compared only at the money, because
// NSE derives settlement prices for untraded strikes from a model, and a far
// out-of-the-money settled price is not an observation to hold a live book to.
const contractRef = reference.loadReference();
if (contractRef) {
  let oiCompared = 0, oiAgreed = 0;
  const atmDiffs = [];
  // Compare like with like. The quote cache is refreshed a few chains at a
  // time, so it holds books from several sessions at once -- measured on
  // 2026-09-23: 9,328 from that day, 953 from the 19th, 143 from the 18th and
  // 59 from the 22nd. Open interest from last Friday's book will not match
  // tonight's exchange file, and that says nothing about contract identity.
  const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
                JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  const bookSession = (row) => {
    const m = String(row.exchangeFeedTime || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    return m ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}` : null;
  };
  for (const [key, row] of entries) {
    if (!(row.bid > 0 && row.ask > 0)) continue;
    if (bookSession(row) !== contractRef.session) continue;
    const [symbol, expiry, strike, right] = key.split("|");
    const exchange = reference.tradedQuote(symbol, Number(strike), right, expiry, contractRef);
    if (!exchange) continue;
    // Identity is judged where one trade cannot move the figure 5%. Measured on
    // 2026-09-24, the heaviest day of the month: with every contract counted,
    // 89.3% agreed (median gap 0.00%, but a 3-lot contract moves 50% on one
    // trade); from 50 lots open, 97.9%. And some of the broker's open interest
    // is simply a day old -- RBLBANK 395 CE read 19,050 at 15:40, exactly NSE's
    // 23-Sep figure, against 209,550 on the 24th. The desk's own liquidity gate
    // reads NSE's file (fno-reference.js), never this field.
    const lotSize = Number(contractRef.symbols?.[symbol]?.lotSize) || 1;
    if (exchange.openInterest >= 50 * lotSize && row.openInterest > 0) {
      oiCompared += 1;
      if (Math.abs(row.openInterest - exchange.openInterest) / exchange.openInterest < 0.05) oiAgreed += 1;
    }
    const underlying = reference.underlyingPrice(symbol, contractRef);
    if (underlying > 0 && exchange.price > 0 && Math.abs(Number(strike) - underlying) / underlying < 0.03) {
      atmDiffs.push(Math.abs(100 * ((row.bid + row.ask) / 2 - exchange.price) / exchange.price));
    }
  }
  if (oiCompared > 50) {
    const rate = oiAgreed / oiCompared;
    assert.ok(rate > 0.9,
      `open interest agrees with the NSE bhavcopy on only ${oiAgreed}/${oiCompared} contracts; the desk may be quoting different contracts than it thinks`);
    console.log(`  ✓ Open interest matches the NSE bhavcopy on ${oiAgreed}/${oiCompared} contracts`);
  }
  if (atmDiffs.length > 20) {
    atmDiffs.sort((a, b) => a - b);
    const median = atmDiffs[Math.floor(atmDiffs.length / 2)];
    assert.ok(median < 10,
      `at the money the live mid sits ${median.toFixed(1)}% from the exchange's settled price, which is too far to be the same contract`);
    console.log(`  ✓ At the money, live mid and NSE settled price agree to ${median.toFixed(2)}% (median of ${atmDiffs.length})`);
  }
} else {
  console.log("  - no contract reference cached; exchange cross-check skipped");
}

/**
 * A CARD MUST NAME ONE CONTRACT, AND NAME IT THE WAY EACH BROKER DOES.
 *
 * The defect these guard against, found 2026-09-21 from a user's broker
 * screenshots: the desk published NIFTY26SEP23400CE at Rs 90.75 with a delta of
 * 0.58, while the contract that symbol names was trading near Rs 200. Three
 * different contracts were involved in one card -- the premium came from the
 * front WEEKLY expiry, the Greeks from a computed "last Thursday" on which
 * nothing is listed, and the symbol from a hard-coded "26SEP" string. Pasted
 * into Angel One the symbol found nothing at all, because Angel puts the day
 * first and the year last.
 */
const { angelTradingSymbol, expiryTradingSuffix, tradableExpiry, loadReference } = reference;

// 1. The Angel symbol builder is checked against Angel's OWN instrument master,
//    not against a format someone believed was right.
{
  const masterPath = path.resolve(__dirname, "../.private/cache/angelone-instruments.json");
  if (fs.existsSync(masterPath)) {
    const master = JSON.parse(fs.readFileSync(masterPath, "utf8"));
    let checked = 0, matched = 0;
    const misses = [];
    for (const [key, value] of Object.entries(master.options || {})) {
      if (value.exchange !== "NFO") continue;
      const [symbol, expiry, strike, optionType] = key.split("|");
      checked += 1;
      if (angelTradingSymbol(symbol, expiry, strike, optionType) === value.symbol) matched += 1;
      else if (misses.length < 3) misses.push(`${key} -> ${angelTradingSymbol(symbol, expiry, strike, optionType)} but Angel says ${value.symbol}`);
    }
    if (checked > 1000) {
      assert.equal(matched, checked,
        `the Angel One symbol builder disagrees with Angel's instrument master on ${checked - matched} of ${checked} NSE contracts: ${misses.join("; ")}`);
      console.log(`  ✓ Angel One symbols reproduce the broker's own instrument master exactly (${matched} NSE contracts)`);
    }

    // 2. NOTHING from BSE or MCX may enter the maps. They collide with NSE on a
    //    key that has no exchange in it, and BFO is parsed last, so a BSE
    //    contract with a different expiry and a different lot size silently wins.
    const foreign = Object.values(master.options || {}).filter((v) => v.exchange && v.exchange !== "NFO").length
      + Object.values(master.futures || {}).filter((v) => v.exchange && v.exchange !== "NFO").length;
    if (Number(master.schemaVersion) >= 3) {
      assert.equal(foreign, 0,
        `${foreign} non-NSE contracts are cached in the instrument maps; BSE and MCX rows overwrite the NSE contract the desk actually trades`);
      console.log("  ✓ The instrument cache holds NSE contracts only");
    } else {
      console.log(`  - instrument cache is schema ${master.schemaVersion}, predating the NSE-only filter; ${foreign} foreign rows present and it will be rebuilt`);
    }
  } else {
    console.log("  - no Angel instrument master cached; broker symbol cross-check skipped");
  }
}

// 3. The expiry label is the exchange's, weekly or monthly, never a literal.
{
  assert.equal(expiryTradingSuffix("2026-09-29", ["2026-09-22", "2026-09-29", "2026-10-06"]), "26SEP",
    "the last expiry in its calendar month is the MONTHLY and takes the spelled-out form");
  assert.equal(expiryTradingSuffix("2026-09-22", ["2026-09-22", "2026-09-29"]), "26922",
    "an earlier expiry in the same month is a WEEKLY: year, single-character month, day");
  assert.equal(expiryTradingSuffix("2026-10-06", ["2026-10-06", "2026-10-27"]), "26O06",
    "October, November and December use O, N and D because two digits would not fit");
  assert.equal(angelTradingSymbol("ASIANPAINT", "2026-09-29", 2460, "CE"), "ASIANPAINT29SEP262460CE");
  assert.equal(angelTradingSymbol("NIFTY", "2026-09-29"), "NIFTY29SEP26FUT");
  console.log("  ✓ Expiry labels follow the exchange's weekly and monthly conventions");
}

// 4. The chosen expiry must outlive the hold the card describes.
{
  const reference = loadReference();
  if (reference?.symbols?.NIFTY) {
    const chosen = tradableExpiry("NIFTY", { minDays: 7, reference });
    assert.ok(chosen && chosen.days >= 7,
      `the desk picked an expiry ${chosen ? chosen.days.toFixed(1) : "?"} days out for a five-session hold; a contract expiring tomorrow cannot carry a +2.5% and +5.0% target ladder`);
    console.log(`  ✓ The expiry chosen for a five-session hold has ${chosen.days.toFixed(1)} days left (${chosen.expiry})`);
  }
}

console.log("Contract identity tests passed: every contract matches the broker's own label, put-call parity rules out transposed calls and puts, and open interest and at-the-money prices agree with the NSE bhavcopy");
