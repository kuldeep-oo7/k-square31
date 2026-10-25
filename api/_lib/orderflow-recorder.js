"use strict";
// RECORDING ORDER FLOW, BUILD BY BUILD (owner's request, 4 Oct 2026).
// Free daily files carry no order book, so no order-flow rule can be tested on the past. Every in-session
// build already asks Angel One for FULL quotes (best 5 bids and asks with quantities and order counts, total
// buy and sell quantity, open interest, volume); this keeps them, one line per build, so a history exists
// to test later. Nothing on the page decides on it.
// One line = { t, ist, futures: [[symbol, expiry, ltp, oi, volume, totBuy, totSell, avg, bids, asks, feedTime]],
//              options: [[key, ltp, oi, volume, totBuy, totSell, avg, bids, asks, feedTime, open, high, low]] }
// (open/high/low on option rows from 25 Oct 2026: the expiry-day fill audit, studies/expiry-selling-forward-2026-10-21 A1)
// bids/asks = [[price, quantity, orders] x up to 5].
const fs = require("node:fs");
const path = require("node:path");

const FRESH_MS = 15 * 60 * 1000;   // only quotes fetched by THIS build (a build takes a few minutes)

function snapshot({ store, now = Date.now() }) {
  if (!store) return null;
  const fresh = (q) => q && q.fetchedAt && now - Date.parse(q.fetchedAt) <= FRESH_MS && q.book;
  const futures = Object.values(store.futures || {}).filter(fresh).map((q) => [q.symbol, q.expiry, q.price ?? null, q.openInterest ?? null, q.volume ?? null,
    q.book.totBuy, q.book.totSell, q.book.avg, q.book.buy, q.book.sell, q.exchangeFeedTime || null]);
  const options = Object.entries(store.quotes || {}).filter(([, q]) => fresh(q)).map(([k, q]) => [k, q.lastPrice ?? null, q.openInterest ?? null, q.volume ?? null,
    q.book.totBuy, q.book.totSell, q.book.avg, q.book.buy, q.book.sell, q.exchangeFeedTime || null, q.open ?? null, q.high ?? null, q.low ?? null]);
  if (!futures.length && !options.length) return null;
  return { t: new Date(now).toISOString(), ist: new Date(now + 330 * 60_000).toISOString().slice(0, 16).replace("T", " "), futures, options };
}

// Appends this build's line to <dir>/YYYY-MM-DD.jsonl (IST date). Returns a one-line report.
function record({ store, dir = "orderflow", now = Date.now() }) {
  const line = snapshot({ store, now });
  if (!line) return { written: false, reason: "no fresh quote carries an order book on this build" };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${line.ist.slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(line) + "\n");
  return { written: true, file, futures: line.futures.length, options: line.options.length };
}

module.exports = { snapshot, record, FRESH_MS };
