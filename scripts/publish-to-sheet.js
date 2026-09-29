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
const known = (value, unit = "") => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "not measured" : `${value}${unit}`);

function optionTickets(data) {
  return data.options.filter((c) => c.frozen).map((c) => ({
    symbol: c.symbol,
    assetClass: "OPTION",
    action: "BUY",
    tradingSymbol: c.zerodha,
    frozenAt: c.frozenAt || null,
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
    // A figure the desk could not measure says so: "realised null%" and "exit
    // by null" were what an index put would have written.
    reason: "IV " + known(c.iv, "%") + " vs realised " + known(c.rv, "%") + " (VRP " + known(c.vrp) + "), touch odds "
      + known(c.touchPct, "%") + " in ~" + known(c.daysToTarget, "d") + " (ignores the stop), needs " + known(c.breakEvenPct, "%") + " wins to break even, decay "
      + known(c.thetaBurnPct, "%") + "/target, " + c.daysLeft + "d to expiry, "
      + (c.exitBy ? "exit by " + c.exitBy : c.isIndex ? "held to expiry (an index option is cash-settled)" : "exit date not known")
      + ", score " + c.score + ". Priced from " + c.priceSource
      + (c.priceIsLive ? " (live book)." : " (not a live book)."),
    zerodhaFastCopy: c.zerodha
  }));
}

function futureTickets(data) {
  return data.futures.filter((r) => r.frozen).map((r) => ({
    symbol: r.symbol,
    assetClass: "FUTURE",
    action: "BUY",
    // A share-only name has no contract; its NSE symbol is what is searched.
    tradingSymbol: r.tradingSymbol || r.symbol,
    frozenAt: r.frozenAt || null,
    strike: 0,
    expiry: r.expiry || "",
    lotSize: r.exchangeLot,
    entryTrigger: money(r.buy),
    stopLoss: money(r.stop),
    targetRung1: money(r.target1),
    targetRung2: money(r.target2),
    runnerTarget: 0,
    // In the size actually traded: GM Global's minimum of 20 units (the user,
    // 2026-09-25), not the exchange lot and not one unit.
    capitalRequiredInr: money(r.minCapital ?? r.perUnitCapital),
    maxRiskInr: money(r.minLossAtStop ?? r.riskPerUnit),
    status: "ACTIVE",
    reason: "Anchored at " + r.anchor + " when the level was set. Reward:risk " + r.rewardToRisk
      + " (+" + money(r.rewardPerUnit) + " / -" + money(r.riskPerUnit) + " per unit), needs " + r.breakEvenPct
      + "% wins to break even, composite score " + r.score + ". Capital and risk are for " + (r.minUnits || 20)
      + " units (GM Global's minimum), before GM's charges; the exchange lot is " + r.exchangeLot + ".",
    zerodhaFastCopy: r.tradingSymbol || r.symbol
  }));
}

/**
 * The same ticket, folded into the older K2_TRADE_LEDGER shape.
 *
 * That tab has no column for the broker symbol, which is the single field you
 * actually retype into the broker app -- so it goes in Signal ID, which is
 * free text and otherwise unused here. Losing it would make the row useless.
 */
function asTradeSignal(ticket) {
  const risk = Number(ticket.entryTrigger) - Number(ticket.stopLoss);
  const reward = Number(ticket.targetRung1) - Number(ticket.entryTrigger);
  return {
    signalId: ticket.tradingSymbol,
    symbol: ticket.symbol,
    side: ticket.assetClass,
    action: ticket.action,
    entryPrice: ticket.entryTrigger,
    targetPrice: ticket.targetRung1,
    stopLossPrice: ticket.stopLoss,
    riskReward: risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0,
    convictionPct: 0,
    sizeMultiplier: 1,
    metaDecision: "TAKE",
    outcome: "PENDING"
  };
}

/**
 * EVERY FROZEN LEVEL, EACH ONCE. Levels keep freezing through the day as
 * contracts first qualify -- on 25 Sep 59 of 124 froze after the 09:34 batch --
 * and a once-a-session append could never have sent them. Returns the tickets
 * not yet on the Sheet and the full set of keys once they are. A session file
 * from before the key list existed counts what froze up to its append as sent.
 */
function pendingTickets(data, ledger) {
  // The stock is part of the key: share-only rows have no contract symbol, and
  // on 25 Sep twelve of them shared one key -- eleven would never be sent.
  const ticketKey = (t) => t.assetClass + "|" + t.symbol + "|" + t.tradingSymbol;
  const sent = new Set(ledger.sheetPublishedKeys || []);
  if (ledger.sheetPublishedAt && !ledger.sheetPublishedKeys) {
    for (const t of [...optionTickets(data), ...futureTickets(data)]) if (String(t.frozenAt || "") <= ledger.sheetPublishedAt) sent.add(ticketKey(t));
  }
  const tickets = [...optionTickets(data), ...futureTickets(data)].filter((t) => !sent.has(ticketKey(t)));
  return { tickets, alreadySent: sent.size, keysAfter: [...sent, ...tickets.map(ticketKey)] };
}

async function main() {
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

  // WHEN THE DOCUMENTS ARE WRITTEN. The deployed Apps Script KEEPS every
  // version of a document as new rows on K2_STATE ("Preserve prior versions")
  // and scans the whole sheet on every read and write -- so writing three
  // documents on every build added ~26 copies a day, the Sheet step took 108 s
  // at 10:53 on 28 Sep, and after the close the biggest writes came back 404.
  // Git keeps the page and the ledger on every build; the Sheet is the second
  // copy, and twice a day is enough: when the levels freeze, and from 21:00,
  // after the evening settlement file (the 21:13 build). K2_SHEET_DOCS=always
  // forces it.
  const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  const writeDocs = process.env.K2_SHEET_DOCS === "always"
    || Number(data.freezeTally?.frozenThisBuild) > 0 || istHour >= 21;
  if (!writeDocs) {
    console.log("google sheet: backup documents not written on this build (they are written when levels freeze and from 21:00; git holds every build)");
  }

  // 1. The full snapshot.
  const documentPath = "k2/desk-" + data.sessionDate + ".json";
  if (writeDocs) try {
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

  // 1b. The track record, as documents: the running trades and this month's
  //     finished ones. Git holds the primary copy (docs/ledger/, committed every
  //     build); this is the second copy, somewhere a repository accident cannot
  //     reach.
  if (writeDocs) try {
    const ledgerDir = path.join(DOCS, "ledger");
    const files = fs.existsSync(ledgerDir)
      ? fs.readdirSync(ledgerDir).filter((f) => f === "open.json" || /^closed-\d{4}-\d{2}\.json$/.test(f))
      : [];
    const month = "closed-" + String(data.sessionDate).slice(0, 7) + ".json";
    for (const f of files.filter((f) => f === "open.json" || f === month)) {
      const body = JSON.parse(fs.readFileSync(path.join(ledgerDir, f), "utf8"));
      const docPath = "k2/ledger-" + f;
      const existing = await store.readGoogleDocument(docPath, null);
      await store.writeGoogleDocument(docPath, body, existing.etag);
      const back = await store.readGoogleDocument(docPath, null);
      const n = (body.trades || []).length;
      console.log("google sheet: wrote " + docPath + " (" + n + " trades) -- "
        + ((back?.data?.trades || []).length === n ? "read back and identical" : "READ BACK DID NOT MATCH"));
    }
    if (!files.length) console.log("google sheet: no ledger files yet -- nothing has been frozen and tracked");
  } catch (error) {
    console.log("google sheet: could not back up the track record --", error.message);
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
  // WRITE TO WHATEVER IS ACTUALLY DEPLOYED, and prefer the richer tab when it
  // is there. Measured on 2026-09-23: appendDailyRecommendations answered
  // "Invalid action", so the live web app predates it. Requiring a re-deploy
  // before the desk could write a readable row would have meant no rows at all
  // on the morning it was needed, for a reason nobody would see until 09:30.
  const routes = [
    { action: "appendDailyRecommendations", tab: "K2_DAILY_RECOMMENDATIONS", shape: "full order ticket" },
    { action: "appendTradeSignals", tab: "K2_TRADE_LEDGER", shape: "entry, target and stop" }
  ];
  let route = null;
  for (const candidate of routes) {
    const probe = await store.probeGoogleAction(candidate.action);
    console.log("google sheet: " + candidate.action + " -> " + candidate.tab
      + " supported = " + probe.supported + (probe.reason ? " (" + probe.reason + ")" : ""));
    if (probe.supported === true && route === null) route = candidate;
  }
  if (route === null) {
    console.log("google sheet: the deployed Apps Script has NO append action. Re-deploy "
      + "google-sheets/K2MarketArchive.gs (Extensions > Apps Script > Deploy > Manage "
      + "deployments > Edit > New version). The snapshot document was still written.");
  } else if (route.action !== "appendDailyRecommendations") {
    console.log("google sheet: falling back to " + route.tab + " (" + route.shape
      + "). Re-deploying the Apps Script would unlock the fuller ticket.");
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
  const { tickets, alreadySent, keysAfter } = pendingTickets(data, ledger);
  if (!tickets.length) {
    console.log("google sheet: no level frozen since the last append (" + alreadySent + " already on the Sheet for " + data.sessionDate + ").");
    process.exit(0);
  }

  if (route === null) {
    console.log("google sheet: " + tickets.length + " tickets are ready but there is no action to write them with.");
    process.exit(0);
  }

  try {
    const appended = route.action === "appendDailyRecommendations"
      ? await store.appendDailyRecommendationsToGoogle(tickets)
      : await store.appendTradeSignalsToGoogle(tickets.map(asTradeSignal));
    // Marked published only AFTER the append returned ok. If it threw, the flag
    // stays unset and the next build tries again rather than losing the day.
    ledger.sheetPublishedAt = ledger.sheetPublishedAt || new Date().toISOString();
    ledger.sheetPublishedKeys = keysAfter;
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));
    console.log("google sheet: appended " + (appended.appended ?? tickets.length)
      + " order tickets to " + (appended.sheet || route.tab)
      + " for " + data.sessionDate + ".");
  } catch (error) {
    console.log("google sheet: tickets could not be appended --", error.message);
  }

  process.exit(0);
}

module.exports = { optionTickets, futureTickets, pendingTickets };

if (require.main === module) {
  main().catch((error) => {
    console.error("sheet publish failed outright:", error.message);
    process.exit(0);
  });
}
