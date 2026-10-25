"use strict";
// THE EXPIRY-DAY PAPER TRADE, LIVE (studies/expiry-selling-forward-2026-10-21, amendment A1). On a NIFTY expiry session the
// desk build fetches the expiring NIFTY options nearest NIFTY's open (scripts/prepare-static-build.js), and TRACK shows
// X2 as it stands: the ATM call and put sold at their opens, each bought back at 2x once the day's high reaches 2x, else
// marked at the last price. INFORMATION ONLY, before charges; the registered result is scored from NSE's files at night.
const { nearest } = require("./expiry-forward");

// What to fetch: today's NIFTY expiry, centred on NIFTY's open. expiries = NIFTY option expiries in the Angel master.
function expiryRequest({ today, expiries, niftyOpen }) {
  if (!today || !(niftyOpen > 0) || !(expiries || []).includes(today)) return null;
  return { symbol: "NIFTY", expiry: today, referencePrice: niftyOpen };
}

// X2 now, from the quote cache. quotes = live-quotes cache rows keyed SYMBOL|EXPIRY|STRIKE|TYPE; a quote counts only if
// the exchange stamped it today (feedDate). Strikes: the study's rule (expiry-forward nearest) over the fetched ones.
function expiryLive({ today, niftyOpen, quotes, lot, feedDate }) {
  if (!today || !(niftyOpen > 0) || !quotes) return null;
  const rows = [];
  for (const q of Object.values(quotes)) {
    if (q?.symbol !== "NIFTY" || String(q.expiry).slice(0, 10) !== today || feedDate(q.exchangeFeedTime) !== today) continue;
    rows.push([today, Number(q.strike), q.optionType, q]);
  }
  const call = nearest(rows, "CE", niftyOpen), put = nearest(rows, "PE", niftyOpen);
  if (!call || !put) return null;
  // the strike is the rule's whatever has traded; a leg with no open yet has no sale and no result
  const leg = ([, strike, type, q]) => { if (!(q.open > 0)) return { strike, type, open: null, stop: null, stopped: false, last: null, high: null, points: null, at: q.exchangeFeedTime || null };
    const stop = 2 * q.open, stopped = q.high >= stop, last = q.lastPrice > 0 ? q.lastPrice : null;
    // what the page shows (data.json is public); the books themselves stay in the private order-flow recording
    const exit = stopped ? stop : last; return { strike, type, open: q.open, stop: +stop.toFixed(2), stopped, last, high: q.high ?? null,
      points: exit === null ? null : +(q.open - exit).toFixed(2), at: q.exchangeFeedTime || null }; };
  const legs = [leg(call), leg(put)];
  const points = legs.every((l) => l.points !== null) ? +(legs[0].points + legs[1].points).toFixed(2) : null;
  const at = legs.map((l) => l.at).filter(Boolean).sort().pop() || null;
  return { date: today, niftyOpen, legs, credit: legs.every((l) => l.open > 0) ? +(legs[0].open + legs[1].open).toFixed(2) : null, points, rupees: points !== null && lot > 0 ? Math.round(points * lot) : null, lot: lot || null, at };
}

module.exports = { expiryRequest, expiryLive };
