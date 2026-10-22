"use strict";
// LIVE INFORMATION FOR THE PAPER LISTS (owner, 18 Oct 2026: "feed it the live data ... if the market opens gap down or
// gap up"). During the session, each stock on today's short build-up list and today's Kronos list gets its futures
// open, the gap from the previous close, the last price and the running paper P&L on GM's units. INFORMATION ONLY: the
// tested rules trade at the open whatever the gap; nothing here skips, flips or adds a trade.
// Fields checked on 18 Oct 2026 against NSE's F&O files: Angel's FULL quote `open` = the session's open, `close` (stored
// as previousClose) = the PREVIOUS session's close (DIXON Oct fut: open 12827 and close 12755 = NSE 16 Oct open and
// 15 Oct close).

// Today's lists: what to ask Angel One for. sbExpiry(symbol) -> the nearest futures expiry on or after the session.
function paperRequests({ oiFlow, kronos, trees = null, target, nextTradingDate, sbExpiry }) {
  const out = []; const seen = new Set();
  const add = (symbol, expiry, book, side) => { if (!symbol || !expiry) return; const key = `${book}|${symbol}`; if (seen.has(key)) return; seen.add(key); out.push({ symbol, expiry, book, side }); };
  for (const p of oiFlow?.SB?.pending || []) if (p.signalDate && nextTradingDate(p.signalDate) === target) add(p.symbol, sbExpiry(p.symbol), "SB", -1);
  const onTime = (x) => Date.parse(x.madeAt) < Date.parse(`${x.entry}T09:15:00+05:30`);
  for (const day of Object.values(kronos?.days || {})) {
    if (day.entry !== target || !day.enough || !onTime(day)) continue;
    for (const p of day.long || []) add(p.symbol, p.expiry, "KRONOS", 1);
    for (const p of day.short || []) add(p.symbol, p.expiry, "KRONOS", -1);
  }
  // the trees watch (studies/trees-forward-2026-10-22): the list entered today; names without NSE futures have no expiry
  for (const list of Object.values(trees?.lists || {})) {
    if (list.entry !== target || !list.enough || !onTime(list)) continue;
    for (const p of list.long || []) add(p.symbol, p.expiry, "TREES", 1);
    for (const p of list.short || []) add(p.symbol, p.expiry, "TREES", -1);
  }
  return out;
}

// The rows shown on the page, or null outside the session. getQuote(symbol, expiry) -> the cached live future;
// feedDate(text) -> the session an Angel exchange time belongs to. A quote from another session, or with no open yet
// (before 09:15), is left out rather than shown with a wrong gap.
function paperLive({ requests, sessionDate, inSession, getQuote, feedDate, units = 20 }) {
  if (!inSession || !requests.length) return null;
  const rows = []; let latest = null;
  for (const r of requests) {
    const q = getQuote(r.symbol, r.expiry);
    if (!q || !(q.price > 0) || !(q.open > 0) || feedDate(q.exchangeFeedTime) !== sessionDate) continue;
    const gapPct = q.previousClose > 0 ? (q.open / q.previousClose - 1) * 100 : null;
    rows.push({ book: r.book, side: r.side, symbol: r.symbol, expiry: r.expiry, open: q.open, last: q.price, high: q.high ?? null, low: q.low ?? null,
      previousClose: q.previousClose ?? null, gapPct, movePct: (q.price / q.open - 1) * 100, pnl: r.side * (q.price - q.open) * units, at: q.exchangeFeedTime });
    if (!latest || String(q.exchangeFeedTime) > String(latest)) latest = q.exchangeFeedTime;
  }
  return rows.length ? { at: latest, units, rows } : null;
}

module.exports = { paperRequests, paperLive };
