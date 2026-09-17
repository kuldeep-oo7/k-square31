"use strict";

/**
 * The one check that cannot be run after the close.
 *
 * Everything in the freshness contract is verified except the REALTIME path
 * itself, because that path only exists between 09:15 and 15:30 IST and the
 * work was done in the evening. The tests that cover REALTIME do so against a
 * CONSTRUCTED timestamp, which proves the classification logic and proves
 * nothing about what Angel actually puts in exchFeedTime while the market runs.
 *
 * What is already known, from 565 contracts pulled after the close: the field
 * is per-contract, not a batch mark. Stamps ranged across 34 distinct values
 * from 15:39:51 to 15:40:09, varying second by second between contracts. That
 * is consistent with a genuine feed time and inconsistent with a single
 * end-of-session stamp.
 *
 * What is NOT known: whether, during a session, that stamp lands inside the
 * 120-second window. If it lags by minutes, REALTIME never fires, every card
 * reads CLOSING BOOK all day, the order buttons never appear, and the spread
 * gate ends up keyed permanently to close-of-day spreads -- which are wider,
 * because makers pull quotes at the close.
 *
 * Run this after 09:20 IST on a trading day:
 *
 *     node scripts/check-live-session.js
 *
 * The two things that decide it are printed at the bottom: whether the median
 * lag is inside the window, and whether the lag VARIES between contracts. A
 * lag that is identical everywhere is a batch stamp whatever its value.
 */

const { classifyBook, marketPhase, parseExchangeClock } = require("../api/_lib/live-quotes");
const brokers = require("../api/_lib/broker-feed");
const reference = require("../api/_lib/fno-reference");

const SYMBOL = process.argv[2] || "RELIANCE";

(async () => {
  const now = Date.now();
  const phase = marketPhase(now);
  console.log(`Market phase: ${phase.phase} (IST date ${phase.istDate})`);
  if (!phase.open) {
    console.log("\nThe market is shut, so this check cannot answer its question.");
    console.log("It has to run between 09:15 and 15:30 IST on a trading day.");
    process.exit(0);
  }

  const contractRef = reference.loadReference();
  const spot = contractRef ? reference.underlyingPrice(SYMBOL, contractRef) : null;
  const near = spot ? reference.nearestListedStrike(SYMBOL, spot, { reference: contractRef }) : null;
  if (!near) {
    console.log(`No listed expiry found for ${SYMBOL}. Pass another symbol as an argument.`);
    process.exit(1);
  }

  const chain = await brokers.optionChain(SYMBOL, near.expiry, { referencePrice: spot });
  if (!chain.ok) {
    console.log(`Chain request failed: ${chain.reason}`);
    process.exit(1);
  }

  const legs = (chain.chain || []).filter((leg) => leg.bid > 0 && leg.ask > 0).slice(0, 12);
  if (!legs.length) {
    console.log("No two-sided books returned; nothing to measure.");
    process.exit(1);
  }

  console.log(`\n${SYMBOL} ${near.expiry} -- ${legs.length} two-sided legs\n`);
  console.log("strike type  exchFeedTime           lag  verdict");
  const lags = [];
  for (const leg of legs) {
    const feed = parseExchangeClock(leg.exchangeFeedTime);
    const book = classifyBook(feed, { now: Date.now() });
    if (book.exchangeAgeSeconds !== null) lags.push(book.exchangeAgeSeconds);
    console.log(
      `${String(leg.strike).padStart(6)} ${leg.optionType}   ${String(leg.exchangeFeedTime || "(none)").padEnd(22)}`
      + `${String(book.exchangeAgeSeconds ?? "-").padStart(5)}s  ${book.kind}${book.executable ? " EXECUTABLE" : ""}`
    );
  }

  lags.sort((a, b) => a - b);
  const median = lags[Math.floor(lags.length / 2)];
  const spread = lags.length ? lags[lags.length - 1] - lags[0] : 0;
  const realtime = legs.filter((leg) => classifyBook(parseExchangeClock(leg.exchangeFeedTime), { now: Date.now() }).kind === "REALTIME").length;

  console.log(`\nmedian lag        ${median}s  (window is 120s)`);
  console.log(`spread of lags    ${spread}s  across ${legs.length} contracts`);
  console.log(`REALTIME legs     ${realtime} of ${legs.length}`);
  console.log("");

  if (realtime > 0 && spread > 0) {
    console.log("PASS. The exchange stamp is per-contract and inside the window, so");
    console.log("REALTIME fires and the desk can mark quotes executable during a session.");
  } else if (realtime === 0) {
    console.log("FAIL. No leg classified REALTIME while the market is open. exchFeedTime");
    console.log("lags the window, so cards will read CLOSING BOOK all day and the spread");
    console.log("gate is keyed to close-of-day spreads. Either the window needs widening");
    console.log("to the measured lag WITH THAT STATED, or this field is not a quote time.");
  } else {
    console.log("INCONCLUSIVE. Lags are inside the window but identical across every");
    console.log("contract, which is what a batch stamp looks like. Re-run a minute later:");
    console.log("if the value does not advance, it is not a per-quote timestamp.");
  }
})().catch((error) => {
  console.error("Check failed:", error.message);
  process.exit(1);
});
