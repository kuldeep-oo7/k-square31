"use strict";

/**
 * A LIMIT THAT MOVES IS NOT A LIMIT.
 *
 * The complaint that produced this file, verbatim: "in futures you are
 * constantly changing the price of the futures so i do feel it is double
 * standards you need to be sure exact buy at this it will hit your buy limit
 * and it will hit your sell limit also ... for example ashokley it gives me 3
 * prices with variation".
 *
 * That was correct and it was the whole of the defect. Every level on the desk
 * was derived from the CURRENT price at the moment of rendering, so a page read
 * three times in a session quoted three different buy limits for the same
 * trade. Each one was computed correctly. None of them was usable, because you
 * cannot place an order against a number that will be different when you get to
 * your broker.
 *
 * The desk already had a fix for this -- api/_lib/session-levels.js, which
 * inserts a level once per (symbol, session, instrument) and returns the stored
 * row for ever after. It stores those rows in SQLite, in .private/k2-trading.db.
 *
 * THAT FIX DOES NOT SURVIVE HERE. A GitHub Actions runner is destroyed after
 * every job: there is no .private, there is no database, and the table is empty
 * on arrival. Wiring the SQLite freeze into a scheduled build would reproduce
 * the moving price exactly, with more machinery in the way and a stronger claim
 * to be fixed. The freeze needs a store that outlives the machine.
 *
 * Git is that store. The build already commits its output, so the previous
 * session ledger is sitting in the checkout before the new build starts. Read
 * it, carry every level whose session is still today, and only ever compute a
 * level for a contract that does not have one yet. No network on the critical
 * path, and the audit trail is the commit history.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG:
 *
 *   NOTHING FREEZES BEFORE THE BELL. A pre-open build has only yesterday's
 *   settlement to work from, and a level anchored there is a level anchored on
 *   a price nobody can trade. Pre-open builds show indicative numbers, say so,
 *   and persist nothing -- so the real freeze happens on the first build after
 *   the open, against a price that actually traded.
 *
 *   A NEW CONTRACT MAY STILL BE ADDED MID-SESSION. Freezing the whole list at
 *   09:30 would mean a name that only qualifies at noon could never appear.
 *   Each contract carries its own freeze stamp, so a level is fixed from the
 *   moment that contract first cleared the gates, and never after.
 */

const fs = require("node:fs");
const path = require("node:path");

const LEDGER_FILE = path.resolve(__dirname, "..", "docs", "levels.json");
const IST_OFFSET_MS = 330 * 60_000;

/** The trading date in India, which is the only date this desk has. */
function sessionDateFor(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istStamp(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16) + " IST";
}

function readLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

/**
 * Open the ledger for this build.
 *
 * `canFreeze` is the caller's answer to "is there a tradable price right now".
 * When it is false the session is advisory: levels are computed so the page is
 * not blank, they are labelled indicative, and nothing is written down.
 */
function openSession({ now = Date.now(), canFreeze = false, file = LEDGER_FILE } = {}) {
  const today = sessionDateFor(now);
  const previous = readLedger(file);
  const carried = previous && previous.sessionDate === today ? previous : null;

  const ledger = {
    sessionDate: today,
    // The first build that froze anything. A later build must not move it.
    openedAtIst: carried?.openedAtIst || (canFreeze ? istStamp(now) : null),
    sheetPublishedAt: carried?.sheetPublishedAt || null,
    options: { ...(carried?.options || {}) },
    futures: { ...(carried?.futures || {}) }
  };

  const tally = { carried: 0, frozenThisBuild: 0, indicative: 0 };

  /**
   * Return the levels for one contract, computing them only the first time.
   *
   * `compute` is called at most once per contract per session. After that the
   * stored numbers are returned unchanged however far the market has moved,
   * which is the entire point.
   */
  function level(bucket, key, compute) {
    const book = ledger[bucket];
    const existing = book[key];
    if (existing) { tally.carried += 1; return { ...existing, frozen: true, fresh: false }; }

    const computed = compute();
    if (!computed) return null;

    const stamped = { ...computed, frozenAtIst: istStamp(now), frozenAtSpot: computed.reference ?? null };
    if (!canFreeze) {
      // Indicative only: it is shown, it is labelled, it is not written down,
      // and tomorrow's first real build will compute it against a live price.
      tally.indicative += 1;
      return { ...stamped, frozen: false, fresh: true };
    }
    book[key] = stamped;
    tally.frozenThisBuild += 1;
    return { ...stamped, frozen: true, fresh: true };
  }

  function save() {
    if (!canFreeze) return { written: false, reason: "market was not open; nothing was frozen" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ledger, null, 1));
    return { written: true, options: Object.keys(ledger.options).length, futures: Object.keys(ledger.futures).length };
  }

  return { ledger, level, save, tally, sessionDate: today, canFreeze };
}

/**
 * A number, or nothing -- but never a number invented out of nothing.
 *
 * Number(null) is 0 and Number("") is 0, so the obvious Number.isFinite guard
 * waves both through as a real price of zero. That is how "no quote" became
 * "the market is 100% below your limit, go and buy it" in the first draft of
 * this file: a missing price rendered as the most attractive possible one.
 */
function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Drift of the live price away from the level that was frozen, in percent. */
function driftPct(frozen, current) {
  const from = numeric(frozen);
  const to = numeric(current);
  if (from === null || to === null || from === 0) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

module.exports = { openSession, sessionDateFor, istStamp, driftPct, numeric, LEDGER_FILE };
