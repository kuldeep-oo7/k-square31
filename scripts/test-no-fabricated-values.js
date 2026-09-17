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

console.log("Fabricated-value guard passed: no literal analytics in generators, no built-in name list, no published fingerprints, no seeded ledger, provenance flags present");
