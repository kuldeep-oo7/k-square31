"use strict";

/**
 * A RENAMED COMPANY IS WATCHED UNDER ITS NEW NAME, AND ONLY ON NSE'S WORD.
 *
 * api/_lib/nse-symbols.js resolves each workbook row to the symbol NSE trades
 * it as today. Fixture lines are NSE's own (EQUITY_L.csv and symbolchange.csv,
 * both read 2026-09-25). The failures that matter: a renamed company staying
 * invisible (AMARAJABAT, 25 Sep), and a guess -- following a ticker NSE does
 * not list, or emptying the whole list on a bad download.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const m = require("../api/_lib/nse-symbols");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

const CHANGES = [
  "SM_NAME_OF_COMPANY,SM_KEY_SYMBOL,SM_NEW_SYMBOL,SM_APPLICABLE_FROM",
  "Amara Raja Energy & Mobility Limited,AMARAJABAT,ARE&M,27-OCT-2023",
  "GUJARAT ENERGY LIMITED,GUJGASLTD,GUJENERGY,01-JUL-2026",
  "LTIMindtree Limited,LTI,LTIM,05-DEC-2022",
  "LTM Limited,LTIM,LTM,27-FEB-2026",
  "Sammaan Capital Limited,IBULHSGFIN,SAMMAANCAP,26-JUL-2024",
  // A company name with a comma in it, and an old symbol changed twice.
  "Some Company, Limited,OLDX,MIDX,01-JAN-2020",
  "Some Company Limited,OLDX,NEWX,01-JAN-2024"
].join("\n");
const LISTED = ["SYMBOL,NAME OF COMPANY, SERIES", "ARE&M,Amara Raja Energy & Mobility Limited,EQ", "GUJENERGY,Gujarat Energy Limited,EQ",
  "LTM,LTM Limited,EQ", "SAMMAANCAP,Sammaan Capital Limited,EQ", "PIRAMALFIN,Piramal Finance Limited,EQ",
  "WHIRLPOOL,Whirlpool of India Limited,EQ", "NEWX,New X,EQ", "SBIN,State Bank of India,EQ"].join("\n");

console.log("NSE symbols:");

const changes = m.parseChanges(CHANGES);
check("NSE's changes are read from the right, so a comma in a company name does not break a row", changes.OLDX === "NEWX" && changes.AMARAJABAT === "ARE&M");
check("where an old symbol changed twice, the latest change wins", changes.OLDX === "NEWX");
const nse = { listed: m.parseListed(LISTED), changes };
check("EQUITY_L.csv gives the listed symbols, header skipped", nse.listed.has("ARE&M") && nse.listed.has("SBIN") && !nse.listed.has("SYMBOL"));

const r = (symbol, yahoo) => m.resolveWatchSymbol({ symbol, yahoo }, nse);
check("a listed symbol is kept as written", r("SBIN", "SBIN.NS").symbol === "SBIN" && r("SBIN").from === null);
const amara = r("AMARAJABAT", "ARE&M.NS");
check("AMARAJABAT is watched as ARE&M, on NSE's own symbol-change record", amara.symbol === "ARE&M" && amara.from === "AMARAJABAT" && amara.how === "NSE_SYMBOL_CHANGE");
check("GUJGASLTD is watched as GUJENERGY (NSE, 1 Jul 2026)", r("GUJGASLTD", "GUJGASLTD.NS").symbol === "GUJENERGY");
check("a chain is followed to its end: LTI -> LTIM -> LTM", r("LTI").symbol === "LTM");
const pel = r("PEL", "PIRAMALFIN.NS");
check("with no NSE record, the workbook's own ticker is followed when NSE lists it (PEL -> PIRAMALFIN)",
  pel.symbol === "PIRAMALFIN" && pel.how === "WORKBOOK_TICKER");
check("a misspelt row is corrected the same way (WHIRPOOL -> WHIRLPOOL)", r("WHIRPOOL", "WHIRLPOOL.NS").symbol === "WHIRLPOOL");
const gspl = r("GSPL", "GSPL.NS");
check("a ticker NSE does not list is never followed: GSPL stays GSPL, marked unlisted", gspl.symbol === "GSPL" && gspl.unlisted === true && gspl.from === null);
check("a guess is not a rename: an unlisted workbook ticker is ignored", r("OLDCO", "MADEUP.NS").symbol === "OLDCO");
check("without NSE's lists every row is taken as written", m.resolveWatchSymbol({ symbol: "AMARAJABAT", yahoo: "ARE&M.NS" }, null).symbol === "AMARAJABAT");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-symbols-"));
  const file = path.join(tmp, "nse-symbols.json");
  const fake = (bodies) => async (url) => {
    const name = url.split("/").pop();
    return { ok: true, status: 200, headers: { get: () => "Thu, 24 Sep 2026 21:35:02 GMT" }, text: async () => bodies[name] };
  };
  const tiny = await m.refreshNseSymbols({ file, fetchImpl: fake({ "EQUITY_L.csv": LISTED, "symbolchange.csv": CHANGES }) });
  check("a short or broken EQUITY_L.csv is refused rather than unlisting everything", tiny.ok === false && /only 8 symbols/.test(tiny.reason), tiny.reason);
  check("and a refused download leaves nothing for the watch list to use", m.loadNseSymbols({ file }) === null);
  const big = ["SYMBOL,NAME", ...Array.from({ length: 1200 }, (_, i) => `SYM${i},Company ${i},EQ`), "ARE&M,Amara Raja,EQ"].join("\n");
  const good = await m.refreshNseSymbols({ file, fetchImpl: fake({ "EQUITY_L.csv": big, "symbolchange.csv": CHANGES }) });
  const loaded = m.loadNseSymbols({ file });
  check("a full download is cached and read back", good.ok === true && loaded && loaded.listed.has("ARE&M") && loaded.changes.AMARAJABAT === "ARE&M");
  check("and it goes stale after eight days", m.loadNseSymbols({ file, now: Date.now() + 9 * 86_400_000 }) === null);
  const down = await m.refreshNseSymbols({ file, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND nsearchives.nseindia.com"); } });
  check("NSE unreachable is recorded as a failure, with the reason", down.ok === false && /ENOTFOUND/.test(down.reason));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack); process.exit(1); });
