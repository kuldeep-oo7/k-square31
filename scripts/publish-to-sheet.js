"use strict";

/**
 * THE ANSWER WHEN THERE IS NO SERVER LEFT TO RUN.
 *
 * Asked for, verbatim: "if there is no ui i am still happy you just give me the
 * price to buy and sell can you do it in the google sheet or not or take google
 * sheet as the database".
 *
 * That is the right instinct and it is worth saying why. A Google Sheet is the
 * one piece of this system that cannot go down, cannot run out of free hours,
 * cannot be suspended, and cannot be wiped by a deploy. It opens on a phone on
 * any network in the world, it is already the operational store this desk
 * writes its archive to, and it costs nothing. Render was suspended, the Vercel
 * account was suspended, the laptop has to be shut for the night. The Sheet is
 * still there.
 *
 * WHAT GOES INTO IT:
 *
 *   K2_DAILY_RECOMMENDATIONS   one row per trade, appended ONCE a session, at
 *                              the moment the levels freeze. Symbol, broker
 *                              symbol, entry limit, stop, target 1, target 2,
 *                              capital, worst case. This is the order ticket
 *                              and it is what you read on the phone.
 *   k2/desk-<date>.json        the whole snapshot, as a versioned document, on
 *                              every build. The machine-readable record of what
 *                              was on screen at each point in the day.
 *
 * WHY APPEND ONCE AND NOT EVERY BUILD: the levels do not change after they are
 * frozen, so a row per build would be the same row twenty-six times over and
 * the tab would be unreadable by Wednesday. The guard is a timestamp in
 * docs/levels.json, which is committed, so it survives the runner being
 * destroyed. The per-build record still happens -- it goes to the document
 * store, which is versioned and overwrites cleanly.
 *
 * NOTHING HERE IS ALLOWED TO FAIL THE BUILD. The page is already written by the
 * time this runs. A Sheets outage must not cost the day's prices.
 */

const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.resolve(__dirname, "..", "docs");
const LEDGER_FILE = path.join(DOCS, "levels.json");

function loadEnvFile() {
  const file = path.resolve(__dirname, "..", ".private", "production.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // Values are often quoted in a .env file, and a quoted URL does not parse.
    if (match && match[2] && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * One row of the tab, per contract.
 *
 * Every field the sheet asks for is either measured or left empty. Where the
 * desk does not know something -- a hedge it never constructed -- it says so
 * rather than inventing a plausible strategy name.
 */
function optionTickets(data) {
  return data.options.map((c) => ({
    symbol: c.symbol,
    assetClass: "OPTION",
    action: "BUY",
    tradingSymbol: c.zerodha,
    strike: c.strike,
    expiry: c.expiry,
    lotSize: c.lotSize,
    entryTrigger: money(c.buy),
    stopLoss: money(c.stop),
    targetRung1: money(c.sell),
    targetRung2: 0,
    runnerTarget: 0,
    capitalRequiredInr: money(c.costPerLot),
    // The stop is the plan, not the floor: an option can gap straight through
    // it overnight. The honest worst case on a bought option is the premium.
    maxRiskInr: money(Number(c.buy) * Number(c.lotSize)),
    status: "ACTIVE",
    reason: "IV " + c.iv + "% vs realised " + c.rv + "% (VRP " + c.vrp + "), P(touch) "
      + c.touchPct + "% in ~" + c.daysToTarget + "d, decay " + c.thetaBurnPct + "%/target, "
      + c.daysLeft + "d to expiry, score " + c.score + ". Priced from " + c.priceSource
      + (c.priceIsLive ? " (live book)." : " (not a live book)."),
    zerodhaFastCopy: c.zerodha
  }));
}

function futureTickets(data) {
  return data.futures.map((r) => ({
    symbol: r.symbol,
    assetClass: "FUTURE",
    action: "BUY",
    tradingSymbol: r.tradingSymbol,
    strike: 0,
    expiry: "",
    lotSize: r.exchangeLot,
    entryTrigger: money(r.buy),
    stopLoss: money(r.stop),
    targetRung1: money(r.target1),
    targetRung2: money(r.target2),
    runnerTarget: 0,
    // Per unit, not per lot -- the platform this is actually traded on does not
    // require the whole lot, and quoting lot capital overstates it enormously.
    capitalRequiredInr: money(r.perUnitCapital),
    maxRiskInr: money(r.riskPerUnit),
    status: "ACTIVE",
    reason: "Anchored at " + r.anchor + " when the level was set. Reward:risk " + r.rewardToRisk
      + " (+" + money(r.rewardPerUnit) + " / -" + money(r.riskPerUnit) + " per unit), composite score "
      + r.score + ". Figures are PER UNIT; the exchange lot is " + r.exchangeLot + ".",
    zerodhaFastCopy: r.tradingSymbol
  }));
}

(async () => {
  loadEnvFile();
  const store = require("../api/_lib/google-store");

  if (!store.googleStoreConfigured()) {
    console.log("google sheet: NOT CONFIGURED -- K2_GOOGLE_SHEETS_WEB_APP_URL and "
      + "K2_GOOGLE_SHEETS_ARCHIVE_SECRET are missing, so nothing was published.");
    process.exit(0);
  }

  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(DOCS, "data.json"), "utf8")); }
  catch (error) { console.log("google sheet: no docs/data.json to publish --", error.message); process.exit(0); }

  // 1. The full snapshot, every build. Versioned, so this overwrites cleanly
  //    instead of accumulating twenty-six copies of the same day.
  const documentPath = "k2/desk-" + data.sessionDate + ".json";
  try {
    const existing = await store.readGoogleDocument(documentPath, null);
    const written = await store.writeGoogleDocument(documentPath, data, existing.etag);
    // READ IT BACK. On this project "ARCHIVE: OK" once meant a READ had
    // succeeded while the write had never been attempted at all, and the gap
    // was found on the day the ledger was needed. A write that is not read back
    // is a claim, not a fact.
    const back = await store.readGoogleDocument(documentPath, null);
    const landed = back?.data?.builtAt === data.builtAt
      && (back?.data?.options?.length ?? -1) === data.options.length;
    console.log("google sheet: wrote " + documentPath + " v" + written.etag + " ("
      + data.options.length + " options, " + data.futures.length + " futures) -- "
      + (landed ? "read back and identical" : "READ BACK DID NOT MATCH; treat this document as unwritten"));
  } catch (error) {
    console.log("google sheet: could not write " + documentPath + " --", error.message);
  }

  // 2. What the DEPLOYED Apps Script supports, and which tabs exist. Printed on
  //    every run because the answer is a property of a deployment nobody here
  //    controls, and a silent "Invalid action" at 09:30 would cost the day.
  try {
    const tabs = await store.listGoogleTabs();
    console.log("google sheet: tabs -- " + (tabs.tabs || [])
      .map((t) => t.name + "(" + t.totalRows + ")").join(", "));
  } catch (error) {
    console.log("google sheet: could not list tabs --", error.message);
  }
  const probe = await store.probeGoogleAction("appendDailyRecommendations");
  console.log("google sheet: appendDailyRecommendations supported = " + probe.supported
    + (probe.reason ? " (" + probe.reason + ")" : ""));
  if (probe.supported === false) {
    console.log("google sheet: the deployed Apps Script is older than google-sheets/K2MarketArchive.gs. "
      + "Re-deploy it (Extensions > Apps Script > Deploy > Manage deployments > Edit > New version) "
      + "or the order tickets cannot be written.");
  }

  // 3. The order tickets, once a session, at the moment the levels froze.
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); } catch { ledger = null; }

  if (!data.levelsFrozen) {
    console.log("google sheet: levels are not frozen yet (market "
      + String(data.marketPhase).toLowerCase() + "), so no tickets were appended.");
    process.exit(0);
  }
  if (!ledger || ledger.sessionDate !== data.sessionDate) {
    console.log("google sheet: no ledger for this session; tickets skipped rather than duplicated.");
    process.exit(0);
  }
  if (ledger.sheetPublishedAt) {
    console.log("google sheet: tickets for " + data.sessionDate
      + " were already appended at " + ledger.sheetPublishedAt + ".");
    process.exit(0);
  }

  const tickets = [...optionTickets(data), ...futureTickets(data)];
  if (!tickets.length) {
    console.log("google sheet: nothing cleared the gates, so there is nothing to append.");
    process.exit(0);
  }

  try {
    const appended = await store.appendDailyRecommendationsToGoogle(tickets);
    // Marked published only AFTER the append returned ok. If it threw, the flag
    // stays unset and the next build tries again rather than losing the day.
    ledger.sheetPublishedAt = new Date().toISOString();
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));
    console.log("google sheet: appended " + (appended.appended ?? tickets.length)
      + " order tickets to " + (appended.sheet || "K2_DAILY_RECOMMENDATIONS")
      + " for " + data.sessionDate + ".");
  } catch (error) {
    console.log("google sheet: tickets could not be appended --", error.message);
  }

  process.exit(0);
})().catch((error) => {
  console.error("sheet publish failed outright:", error.message);
  process.exit(0);
});
