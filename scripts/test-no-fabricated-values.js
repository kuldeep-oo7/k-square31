"use strict";

/**
 * Cross-surface guard against fabricated numbers.
 *
 * This repository has fixed the same defect three times in three places and it
 * came back each time somewhere new, because every guard was written against
 * one file:
 *
 *   11:51  a forensic audit records F01 -- a literal array of trades with
 *          hand-written prices and quant scores rendered as live analytics --
 *          and fixes it by emptying buildSampleRecommendations().
 *   12:22  commit 075ccb8 adds getActiveResearchSetups() beside it holding the
 *          same content. The emptied function still passes its check. The
 *          published portal carries the fabricated cards again.
 *   14:13  a new SQLite engine seeds the same figures as an "audited" ledger.
 *          RELIANCE26SEP1240CE at 21.95 / 29.63 / 8.34 appears verbatim in the
 *          portal array, in the seeded database, and in the disputed profit
 *          table, because all three were copied from one invented dataset.
 *   14:04+ a new Apex engine prices 160 of 210 symbols from a hash or a stale
 *          table and computes every score from a generated sine wave.
 *
 * So this test does not belong to any one module. It checks every surface that
 * can reach a human, and it checks for the specific fingerprints of the numbers
 * that have already been published once.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => {
  const full = path.join(ROOT, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
};

// --- 1. Generators must not carry literal analytics --------------------------
// A quant metric written as a string literal in source was never measured. The
// pattern is deliberately syntactic (key, colon, quoted number) so that prose
// and comments describing the defect do not trip it.
const GENERATORS = [
  "scripts/recommendation-desk-ui.js",
  "scripts/build-portal.js",
  "api/_lib/universe-210.js",
  "api/_lib/unified-quant-scanner.js"
];
const LITERAL_METRIC = /\b(vpin|hurst|halfLife|half_life|delta|gamma|theta|vega|compositeScore|neuralScore|conviction)\s*:\s*["'][\d.+-]+["']/gi;
for (const file of GENERATORS) {
  const source = read(file);
  if (source === null) continue;
  const hits = source.match(LITERAL_METRIC) || [];
  assert.equal(
    hits.length, 0,
    `${file} contains hand-written quantitative values presented as measurements: ${hits.slice(0, 5).join(", ")}`
  );
}

// --- 2. The portal generator must render what it is given --------------------
const deskUi = read("scripts/recommendation-desk-ui.js");
if (deskUi) {
  const symbolLiterals = deskUi.match(/\bsymbol\s*:\s*"[A-Z&]{2,}"/g) || [];
  assert.equal(
    symbolLiterals.length, 0,
    `The desk generator holds a built-in list of tradeable names: ${symbolLiterals.slice(0, 6).join(", ")}`
  );
  assert.ok(
    /function getActiveResearchSetups\(recommendations/.test(deskUi),
    "getActiveResearchSetups must take the recommendations it is asked to render"
  );
  assert.ok(
    /const setups = getActiveResearchSetups\(recommendations\)/.test(deskUi),
    "recommendationSectionHtml must pass its recommendations through, not discard them for a default table"
  );
}

// --- 3. Published surfaces must not carry known-fabricated figures -----------
// These exact values were published once. They are the disputed profit table,
// the seeded ledger and the restored portal cards.
// A COUNT is a measurement. The desk shipped with "46", "423", "210" and "9"
// written directly into the tab labels, so the page advertised 46 recommended
// buys and 9 purchased trades over an empty grid and an empty ledger. The
// screenshot that caught this showed a stale count above a blank page.
const HARDCODED_COUNT = /id="(count-[a-z]+|header-purchased-count)">\s*[0-9]+\s*</g;
for (const file of ["site/live-desk.html", "site/index.html", "index.html"]) {
  const markup = read(file);
  if (markup === null) continue;
  const hits = markup.match(HARDCODED_COUNT) || [];
  assert.equal(hits.length, 0,
    `${file} writes counts into the markup instead of measuring them: ${hits.slice(0, 5).join(", ")}`);
}

const FINGERPRINTS = [
  { value: "71.4%", what: "a win rate computed from seven seeded ledger rows" },
  { value: "51,492", what: "cumulative profit summed from seeded ledger rows" },
  { value: "29,078", what: "a seeded account realized-P&L figure" },
  { value: "50,031", what: "the withdrawn profit-table total" },
  { value: "61.54", what: "a win rate that is arithmetically 8 of 13 hypothetical positions" },
  { value: "0.128", what: "a hand-written VPIN value from the restored portal cards" },
  { value: "4.5 sessions", what: "a hand-written mean-reversion half-life" },
  { value: "Hard-Capped", what: "a max-risk claim for an unspecified hedge leg" }
];
const PUBLISHED = ["index.html", "site/index.html", "site/live-desk.html"];
for (const file of PUBLISHED) {
  const markup = read(file);
  if (markup === null) continue;
  // Strip script comments so an explanatory note about the defect is not itself
  // read as the defect.
  const visible = markup.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const { value, what } of FINGERPRINTS) {
    assert.ok(
      !visible.includes(value),
      `${file} publishes "${value}" -- ${what}. It must be computed or absent, never written in.`
    );
  }
}

// --- 4. The ledger must not seed itself --------------------------------------
const dbSource = read("api/_lib/db-sqlite.js");
if (dbSource) {
  assert.ok(
    !/seedDefaultData/.test(dbSource),
    "db-sqlite.js must not seed invented history; a fresh ledger reports nothing"
  );
  for (const literal of ["29078", "20121.25", "-5628.75", "51492", "SIG-ABB-01", "TRD-ABB-01"]) {
    assert.ok(
      !dbSource.includes(literal),
      `db-sqlite.js still contains the seeded value ${literal}`
    );
  }
  // A statistic with no observations must be null, never a stand-in number.
  assert.ok(
    !/winRatePct\s*=[^;]*:\s*75(\.0)?\b/.test(dbSource),
    "db-sqlite.js must not fall back to a 75% win rate when there is no data"
  );
}

// --- 5. Desk rows must declare where their inputs came from ------------------
const universeSource = read("api/_lib/universe-210.js");
if (universeSource) {
  for (const flag of ["priceSource", "hasObservedPrice", "historicalBarsAreSynthetic"]) {
    assert.ok(
      universeSource.includes(flag),
      `universe-210.js must carry ${flag} so a consumer can tell a measured input from a placeholder`
    );
  }
  assert.ok(
    !/const\s+vpinVal\s*=\s*\(0\.10/.test(universeSource),
    "VPIN must not be derived from the symbol's position in the array"
  );
}

// --- 6. A score pinned at its own ceiling is not a score --------------------
// Measured on the live 210-name universe on 2026-09-17: 205 names carried a
// neuralScore of exactly 98, which is the Math.min(98, ...) ceiling, and the
// "neural >= 70" hurdle passed 210 of 210. The cause was channel scaling in
// extractTemporalTensor -- volume entered the convolution around 1.0 while
// returns sat in [-0.2, 0.2], and the absorption kernel weights it [1.0, 1.4,
// 1.8], so roughly +4.2 of constant was added to the logit for every symbol and
// the sigmoid saturated. A gate that admits the whole universe is not a gate.
{
  const { fnoUniverseEngine } = require("../api/_lib/universe-210");
  const rows = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false });
  const scores = rows.map((row) => Number(row.neuralScore)).filter(Number.isFinite);
  if (scores.length >= 50) {
    const ceiling = Math.max(...scores);
    const atCeiling = scores.filter((value) => value >= ceiling).length;
    const share = atCeiling / scores.length;
    assert.ok(
      share < 0.90,
      `neuralScore is saturated: ${atCeiling} of ${scores.length} names (${(share * 100).toFixed(1)}%) sit at the ceiling ${ceiling}. `
      + "A score that returns the same number for nearly every input carries no information and cannot gate anything."
    );
    const distinct = new Set(scores).size;
    assert.ok(distinct >= 5, `neuralScore takes only ${distinct} distinct values across ${scores.length} names`);
  }
}

// --- 7. Contract identity must come from the exchange, never a literal -------
// universe-210.js carried `const niftySpot = 25440.00` and
// `const bankNiftySpot = 52680.00` while the exchange file for that session
// reported 23,270.60 and 56,055.75 -- wrong by 9.3% and 6.0% -- with lot sizes
// of 25 and 15 against a real 65 and 30, published as one-tap buy cards.
// ANGELONE was quoted at lot 250 against a real 2500, understating the money at
// risk tenfold.
{
  const universeSource = read("api/_lib/universe-210.js");
  if (universeSource) {
    const hardcodedSpot = /const\s+(nifty|bankNifty)Spot\s*=\s*[\d.]+/gi;
    const hits = universeSource.match(hardcodedSpot) || [];
    assert.equal(hits.length, 0,
      `universe-210.js hardcodes an index level: ${hits.join(", ")}. Index levels come from the exchange file.`);
    assert.ok(universeSource.includes("fno-reference"),
      "universe-210.js must consult the exchange contract reference for strikes, lots and index levels");
  }
}
{
  const { fnoUniverseEngine } = require("../api/_lib/universe-210");
  const rows = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false });
  const withChains = rows.filter((row) => row.options);
  if (withChains.length > 50) {
    const synthetic = withChains.filter((row) => row.options.strikeSource !== "EXCHANGE_LISTED_LADDER");
    assert.equal(synthetic.length, 0,
      `${synthetic.length} names still derive strikes from the hand-written step table rather than the exchange ladder`);
    // Lot size is what turns a premium into money. A wrong one misstates risk
    // by its own ratio and nothing downstream can detect it.
    for (const row of withChains.slice(0, 40)) {
      assert.ok(Number(row.lotSize) > 0, `${row.symbol} must carry a positive lot size`);
    }
  }
}

console.log("Fabricated-value guard passed: no literal analytics in generators, no built-in name list, no published fingerprints, no seeded ledger, provenance flags present");
