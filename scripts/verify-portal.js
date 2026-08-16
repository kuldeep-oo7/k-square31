"use strict";

// Fails the build if the portal would publish the book in the clear.
//
// The seal is applied by build-portal.js, but a future edit could reintroduce a
// plaintext render, and a hosted page cannot be un-leaked once it is served. So
// the published HTML is checked against the book it was built from, and the job
// stops rather than deploying.
//
//   node scripts/verify-portal.js site/index.html gm-positions.json

const fs = require("node:fs");

// Symbols in the public ladder plan are not secrets — they carry no holding,
// quantity or P&L. Only symbols the book holds and the plan does not would
// disclose a position, so those are what a leak means here.
function planSymbols(html) {
  return new Set([...html.matchAll(/<span class="tkr">([A-Z0-9&;amp-]{1,30})<\/span>/g)]
    .map((match) => match[1].replace(/&amp;/g, "&")));
}

function held(book) {
  return [...new Set((book.positions || []).map((position) => String(position.symbol || "").toUpperCase()))];
}

function boundaryHit(html, symbol) {
  const escaped = symbol.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9&;-])${escaped}([^A-Z0-9&-]|$)`).test(html);
}

function run() {
  const [htmlPath, bookPath] = process.argv.slice(2);
  if (!htmlPath) throw new Error("usage: node scripts/verify-portal.js <index.html> [gm-positions.json]");
  const html = fs.readFileSync(htmlPath, "utf8");

  if (!bookPath || !fs.existsSync(bookPath)) {
    console.log("No book in this build; nothing to seal, nothing to leak.");
    return;
  }
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const publicSymbols = planSymbols(html);
  const leaks = held(book).filter((symbol) => !publicSymbols.has(symbol) && boundaryHit(html, symbol));

  const totals = [book.totalMtm, book.totalQuantity]
    .map((value) => Math.abs(Math.round(Number(value))))
    .filter((value) => Number.isFinite(value) && value > 999)
    .filter((value) => html.includes(String(value)));

  if (leaks.length || totals.length) {
    throw new Error(`The portal would publish the book in the clear. Symbols: ${leaks.join(", ") || "none"}. Totals: ${totals.join(", ") || "none"}.`);
  }
  if (!/AES-256-GCM/.test(html)) {
    throw new Error("The portal contains no sealed payload; the book would be missing rather than protected");
  }
  console.log(`Portal verified: ${held(book).length} held symbols, none readable in the published HTML.`);
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(String(error?.message || error).slice(0, 300));
    process.exitCode = 1;
  }
}

module.exports = { boundaryHit, planSymbols };
