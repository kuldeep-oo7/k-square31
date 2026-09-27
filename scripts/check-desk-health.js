"use strict";

/**
 * THE PRODUCTION GATE: FAIL LOUDLY, NEVER QUIETLY.
 *
 * Until this existed, every failure mode of the desk produced a GREEN run. A
 * broker login that failed, a feed that returned nothing, a session that never
 * froze, a ledger that recorded a fill before the trade existed -- each one was
 * written honestly onto the page and not one of them told anybody. A page is
 * only read when someone thinks to look; a failed run is a red mark and a
 * notification.
 *
 * So this runs last in the workflow, after the page is published and the
 * ledger committed, and exits non-zero on:
 *
 *   THE DATABASE (always): the ledger in docs/ledger and the frozen levels in
 *   docs/levels.json must agree with themselves -- no duplicate trade, no
 *   running trade in a closed file or finished one in the open file, levels in
 *   order (stop < buy < target), time running forwards (shown, filled,
 *   closed), a stop never exited above the stop, no open trade already through
 *   its stop, every frozen level with its trade. The first run of this check,
 *   on 2026-09-24, found 37 fills stamped seconds before their trade existed.
 *
 *   THE LIVE PATH (only while NSE is trading, from 09:40 IST): the Angel One
 *   login must have worked, at least one contract must have been priced from a
 *   live book, and the session must have frozen its levels. Any of those
 *   missing during market hours means the page is showing something other
 *   than what it claims to be.
 *
 *     node scripts/check-desk-health.js                  # the workflow's gate
 *     node scripts/check-desk-health.js --database-only  # npm run check
 */

const fs = require("node:fs");
const path = require("node:path");
const { isNseHoliday } = require("../api/_lib/nse-holidays");

const DOCS = path.resolve(__dirname, "..", "docs");
const RUNNING = new Set(["WAITING", "OPEN"]);
const FINISHED = new Set(["TARGET", "STOP", "EXPIRED", "TIMED_OUT", "TIME_EXIT", "UNFILLED"]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function checkDatabase({ ledgerDir = path.join(DOCS, "ledger"), levelsFile = path.join(DOCS, "levels.json") } = {}) {
  const problems = [];
  const open = readJson(path.join(ledgerDir, "open.json"), { trades: [] }).trades || [];
  const closed = [];
  if (fs.existsSync(ledgerDir)) {
    for (const f of fs.readdirSync(ledgerDir).filter((x) => /^closed-\d{4}-\d{2}\.json$/.test(x))) {
      closed.push(...(readJson(path.join(ledgerDir, f), { trades: [] }).trades || []));
    }
  }
  const all = [...open, ...closed];
  const ids = new Map();
  for (const t of all) ids.set(t.id, (ids.get(t.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) problems.push(`duplicate trade ${id} (x${n})`);
  for (const t of open) if (!RUNNING.has(t.status)) problems.push(`finished trade in open.json: ${t.id} ${t.status}`);
  for (const t of closed) if (!FINISHED.has(t.status)) problems.push(`running trade in a closed file: ${t.id} ${t.status}`);
  for (const t of all) {
    for (const f of ["id", "kind", "symbol", "contract", "sessionDate", "shownAt", "buy", "target", "stop"]) {
      if (t[f] === undefined || t[f] === null || t[f] === "") problems.push(`${t.id}: missing ${f}`);
    }
    if (!(t.stop < t.buy && t.buy < t.target)) problems.push(`${t.id}: levels out of order (stop ${t.stop}, buy ${t.buy}, target ${t.target})`);
    if (t.filledAt && t.filledAt < t.shownAt) problems.push(`${t.id}: filled ${t.filledAt} before it was shown ${t.shownAt}`);
    if (t.closedAt && t.filledAt && t.closedAt < t.filledAt) problems.push(`${t.id}: closed ${t.closedAt} before it filled ${t.filledAt}`);
    if (t.status === "OPEN" && !t.filledAt) problems.push(`${t.id}: OPEN without a fill time`);
    if (t.status === "UNFILLED" && (t.filledAt || t.pnl)) problems.push(`${t.id}: unfilled but carries a fill or P&L`);
    if (t.status === "STOP" && !(Number(t.exitPrice) <= Number(t.stop) + 1e-9)) problems.push(`${t.id}: stopped at ${t.exitPrice}, above its stop ${t.stop}`);
    if (t.status === "OPEN" && t.last !== null && t.last !== undefined && Number(t.last) <= Number(t.stop) - 1e-9) {
      problems.push(`${t.id}: OPEN at ${t.last}, already through its stop ${t.stop}`);
    }
  }
  const levels = readJson(levelsFile, null);
  let levelCount = 0;
  if (levels) {
    for (const key of Object.keys(levels.options || {})) {
      levelCount += 1;
      const kind = key.endsWith("PE") ? "PE" : "CE";
      if (!ids.has(`${levels.sessionDate}|${kind}|${key}`)) problems.push(`frozen option level without its trade: ${key}`);
    }
    for (const [symbol, l] of Object.entries(levels.futures || {})) {
      levelCount += 1;
      const contract = l.tradingSymbol || `${symbol} (share)`;
      if (!ids.has(`${levels.sessionDate}|FUT|${contract}`)) problems.push(`frozen futures level without its trade: ${symbol}`);
    }
  }
  return { problems, trades: all.length, open: open.length, closed: closed.length, levels: levelCount };
}

function istMinutesOf(ms) {
  const d = new Date(ms + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function checkLivePath(data, nowMs = Date.now()) {
  const minutes = istMinutesOf(nowMs);
  const today = new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
  const inSession = data?.marketPhase === "OPEN" && minutes >= 9 * 60 + 40 && minutes <= 15 * 60 + 30;
  // The phase is weekday-and-clock only; it has no holiday table. So the feed
  // itself is asked: if every quote that came back carries a PREVIOUS
  // session's exchange time, the exchange has not traded today -- a holiday,
  // not an outage -- and the page already says so. With no quotes at all
  // nothing is proven, and the checks stand.
  const lastPrint = data?.quoteStatus?.lastExchangeDate || null;
  const feedSaysShut = inSession && lastPrint !== null && lastPrint < today;
  // ...and the exchange's own calendar is asked too, because a feed FROZEN on
  // yesterday's prints looks exactly like a holiday -- the one outage this gate
  // exists to catch. Both must agree the exchange is shut. For a year NSE's
  // list does not cover yet (null), the feed is trusted and the log says so.
  const calendar = isNseHoliday(today);
  const exchangeShut = feedSaysShut && calendar !== false;
  const problems = [];
  if (inSession) {
    if (!data.brokerCheck?.ok) problems.push(`in session and the Angel One login FAILED: ${data.brokerCheck?.stage || "?"} ${data.brokerCheck?.reason || ""}`.trim());
    if (feedSaysShut && calendar === false) {
      problems.push(`the feed has printed nothing since ${lastPrint}, but NSE lists ${today} as a trading day -- the feed is frozen, not a holiday`);
    } else if (!exchangeShut) {
      if (!(Number(data.pricedLive) > 0)) {
        problems.push(`in session and not one contract was priced from a live book: ${data.freezeBlockedBecause || "no reason given"}`);
      } else if (data.levelsFrozen !== true) {
        // Live books were seen, so the freeze should have happened; if it did
        // not, the build itself is wrong.
        problems.push("in session, live books were seen, and the levels still did not freeze");
      }
      // Angel One's prices checked against NSE's own site (nse-crosscheck.js).
      // Only a MEASURED disagreement counts: NSE unreachable is "not checked"
      // and never turns the build red.
      // Every price shown must be an order the broker accepts: on its tick.
      const offTick = (v, tick) => tick > 0 && Math.abs(Math.round(v / tick) * tick - v) > 1e-6;
      const bad = [
        ...(data.options || []).filter((c) => c.frozen && c.tick && [c.buy, c.sell, c.stop].some((v) => offTick(v, c.tick))).map((c) => c.display || c.zerodha),
        ...(data.futures || []).filter((f) => f.frozen && f.tick && [f.buy, f.target1, f.target2, f.stop].some((v) => offTick(v, f.tick))).map((f) => f.symbol)
      ];
      if (bad.length) problems.push(`${bad.length} frozen row(s) priced off their exchange tick -- the broker would reject them: ${bad.slice(0, 5).join(", ")}`);
      const fc = data.feedCheck;
      if (fc?.checked === true && fc.wrongContract?.length) {
        problems.push(`Angel One and NSE disagree on WHICH contract: ${fc.wrongContract.join("; ")}`);
      }
      if (fc?.checked === true && fc.pricesMostlyOff) {
        problems.push(`most sampled prices differ from NSE's beyond what seconds can explain: ${(fc.priceOff || []).join("; ")}`);
      }
    }
  }
  return { inSession, exchangeShut, calendar, lastPrint, problems };
}

module.exports = { checkDatabase, checkLivePath };

if (require.main === module) {
  const databaseOnly = process.argv.includes("--database-only");
  const db = checkDatabase();
  const liveData = databaseOnly ? null : readJson(path.join(DOCS, "data.json"), null);
  const live = databaseOnly ? { inSession: false, problems: [] } : checkLivePath(liveData);
  const problems = [...db.problems, ...live.problems];
  console.log(`desk health: ${db.trades} trades (${db.open} open, ${db.closed} closed), ${db.levels} frozen levels, `
    + (databaseOnly ? "database only"
      : live.inSession ? "live-path checks ON (market open)"
      : `live-path checks off (${liveData?.marketPhase === "OPEN" ? "market open, before the 09:40 window" : `market ${String(liveData?.marketPhase || "state unknown").toLowerCase()}`})`));
  if (problems.length) {
    console.log(`UNHEALTHY -- ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.log("  - " + p);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Desk unhealthy::${problems.length} problem(s), first: ${problems[0]}`);
    process.exit(1);
  }
  console.log("healthy: the database agrees with itself" + (live.exchangeShut
    ? `; the exchange has not traded today (last print ${live.lastPrint}) and ${live.calendar === true ? "NSE lists today as a holiday" : "NSE's calendar does not cover this year yet"} -- nothing live to check`
    : live.inSession ? "; Angel One is logged in, prices are live and levels are frozen" : ""));
}
