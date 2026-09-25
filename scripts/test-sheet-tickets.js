"use strict";

/**
 * EVERY FROZEN LEVEL REACHES THE SHEET, EACH EXACTLY ONCE.
 *
 * scripts/publish-to-sheet.js appended the order tickets once a session, at the
 * first freeze. Levels keep freezing through the day as contracts first qualify
 * -- on 25 Sep 59 of 124 froze after the 09:34 batch -- so half the day's levels
 * could never reach the Sheet. And twelve share-only rows, which have no
 * contract symbol, shared one key, so eleven would have been skipped.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pendingTickets, optionTickets, futureTickets } = require("./publish-to-sheet");
const { openSession } = require("./session-freeze");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

const opt = (zerodha, frozenAt, frozen = true) => ({ symbol: zerodha.replace(/\d.*/, ""), zerodha, strike: 100, right: "CE", expiry: "2026-10-27",
  exitBy: "2026-10-21", lotSize: 100, buy: 10, sell: 15, stop: 5, costPerLot: 1000, frozen, frozenAt, iv: 20, rv: 18, vrp: 1.1,
  touchPct: 50, daysToTarget: 9, breakEvenPct: 52, thetaBurnPct: 10, daysLeft: 31, score: 60, priceSource: "EXCHANGE_TRADED_PRICE", priceIsLive: true });
const fut = (symbol, tradingSymbol, frozenAt, frozen = true) => ({ symbol, tradingSymbol, expiry: tradingSymbol ? "2026-10-27" : null, exchangeLot: 500,
  buy: 100, stop: 98.5, target1: 102.5, target2: 105, perUnitCapital: 100, riskPerUnit: 1.5, rewardPerUnit: 2.5, rewardToRisk: 1.67,
  minUnits: 20, minCapital: 2000, minLossAtStop: 30, breakEvenPct: 37.5, anchor: "FUTURES_LIVE", score: 80, frozen, frozenAt });

const T0934 = "2026-09-25T04:04:00.000Z", T1214 = "2026-09-25T06:44:00.000Z";

console.log("sheet tickets:");

const morning = { options: [opt("TATAPOWER26OCT365CE", T0934), opt("SBIN26OCT980CE", T0934, false)],
  futures: [fut("LT", "LT26OCTFUT", T0934), fut("BERGEPAINT", null, T0934), fut("CESC", null, T0934)] };
const first = pendingTickets(morning, {});
check("only FROZEN levels are tickets -- an indicative row is not an order", first.tickets.length === 4
  && !first.tickets.some((t) => t.tradingSymbol === "SBIN26OCT980CE"), first.tickets.map((t) => t.tradingSymbol).join(","));
check("two share-only rows with no contract symbol are two tickets, each under its NSE symbol",
  first.tickets.filter((t) => t.assetClass === "FUTURE" && !/FUT$/.test(t.tradingSymbol)).map((t) => t.tradingSymbol).sort().join(",") === "BERGEPAINT,CESC"
    && new Set(first.keysAfter).size === 4);

const noon = { options: [...morning.options, opt("DIVISLAB26OCT9600CE", T1214)], futures: [...morning.futures, fut("HAVELLS", "HAVELLS26OCTFUT", T1214)] };
const second = pendingTickets(noon, { sheetPublishedAt: T0934, sheetPublishedKeys: first.keysAfter });
check("a level frozen at 12:14 is sent at 12:14 -- and only it", second.tickets.map((t) => t.tradingSymbol).sort().join(",") === "DIVISLAB26OCT9600CE,HAVELLS26OCTFUT",
  second.tickets.map((t) => t.tradingSymbol).join(","));
const third = pendingTickets(noon, { sheetPublishedAt: T0934, sheetPublishedKeys: second.keysAfter });
check("nothing is sent twice", third.tickets.length === 0);

const legacy = pendingTickets(noon, { sheetPublishedAt: "2026-09-25T04:10:00.000Z" });
check("a session file from before the key list: what froze by its append counts as sent, what froze after is sent",
  legacy.tickets.map((t) => t.tradingSymbol).sort().join(",") === "DIVISLAB26OCT9600CE,HAVELLS26OCTFUT");

const lt = futureTickets({ futures: [fut("LT", "LT26OCTFUT", T0934)] })[0];
check("a futures ticket is in the size traded: 20 units' capital and risk, with its expiry",
  lt.capitalRequiredInr === 2000 && lt.maxRiskInr === 30 && lt.expiry === "2026-10-27" && /20 units \(GM Global's minimum\)/.test(lt.reason));
const call = optionTickets({ options: [opt("TATAPOWER26OCT365CE", T0934)] })[0];
check("an option ticket says its touch odds ignore the stop, and gives the break-even and exit-by date",
  /ignores the stop/.test(call.reason) && /needs 52% wins to break even/.test(call.reason) && /exit by 2026-10-21/.test(call.reason));

// The key list survives the next build's save of the session file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-sheet-"));
const file = path.join(tmp, "levels.json");
const s1 = openSession({ canFreeze: true, file });
s1.level("options", "TATAPOWER26OCT365CE", () => ({ buy: 10, sell: 15, stop: 5 }));
s1.save();
const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
onDisk.sheetPublishedAt = T0934; onDisk.sheetPublishedKeys = ["OPTION|TATAPOWER|TATAPOWER26OCT365CE"];
fs.writeFileSync(file, JSON.stringify(onDisk));
const s2 = openSession({ canFreeze: true, file });
s2.level("options", "SBIN26OCT980CE", () => ({ buy: 20, sell: 30, stop: 10 }));
s2.save();
const after = JSON.parse(fs.readFileSync(file, "utf8"));
check("the list of levels already on the Sheet survives the next build's save (or every ticket would be re-sent)",
  JSON.stringify(after.sheetPublishedKeys) === JSON.stringify(["OPTION|TATAPOWER|TATAPOWER26OCT365CE"]) && after.sheetPublishedAt === T0934,
  JSON.stringify(after.sheetPublishedKeys));
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
