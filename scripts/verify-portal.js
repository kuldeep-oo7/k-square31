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
  const set = new Set([...html.matchAll(/<span class="tkr">([A-Z0-9&;amp-]{1,30})<\/span>/g)]
    .map((match) => match[1].replace(/&amp;/g, "&")));
  for (const match of html.matchAll(/data-(?:public-symbol|symbol)="([A-Z0-9&;amp-]{1,30})"/g)) set.add(match[1].replace(/&amp;/g, "&"));
  set.add("NIFTY");
  set.add("BANKNIFTY");
  return set;
}

function held(book) {
  return [...new Set((book.positions || []).map((position) => String(position.symbol || "").toUpperCase()))];
}

// The sealed payload is base64, so it contains long runs of random letters in
// which a short ticker appears by chance: "...aLTx..." reads as a standalone LT
// under any boundary rule that treats lowercase as a separator. Scanning it
// would fail builds at random, because the salt and IV change every build.
function readableText(html) {
  return html.replace(/<script id="sealed"[\s\S]*?<\/script>/g, "");
}

function boundaryHit(html, symbol) {
  const escaped = symbol.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A ticker only counts as disclosed when nothing alphanumeric touches it on
  // either side, in either case: LT inside "DEFAULT" or "aLTx" is not a leak.
  return new RegExp(`(^|[^A-Za-z0-9&;-])${escaped}([^A-Za-z0-9&-]|$)`).test(html);
}

function verify(rawHtml, book = null, options = {}) {
  const html = readableText(rawHtml);
  const vm = require("node:vm");
  const scriptTags = [...rawHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (let index = 0; index < scriptTags.length; index++) {
    const [, attributes, code] = scriptTags[index];
    if (/type=["']application\/json["']/.test(attributes)) JSON.parse(code);
    else if (code.trim()) new vm.Script(code, { filename: `portal-inline-${index + 1}.js` });
  }
  if (options.expectSealed && !/AES-256-GCM/.test(rawHtml)) throw new Error("Expected encrypted broker book is missing");

  if (!book) return { scriptsChecked: scriptTags.length, privateBookIncluded: false };
  const publicSymbols = planSymbols(html);
  const leaks = held(book).filter((symbol) => !publicSymbols.has(symbol) && boundaryHit(html, symbol));

  const totals = [book.totalMtm, book.totalQuantity]
    .map((value) => Math.abs(Math.round(Number(value))))
    .filter((value) => Number.isFinite(value) && value > 999)
    .filter((value) => html.includes(String(value)));

  if (leaks.length || totals.length) {
    throw new Error(`The portal would publish the book in the clear. Symbols: ${leaks.join(", ") || "none"}. Totals: ${totals.join(", ") || "none"}.`);
  }
  return { scriptsChecked: scriptTags.length, heldSymbolsChecked: held(book).length, privateBookIncluded: /AES-256-GCM/.test(rawHtml) };
}

function run() {
  const [htmlPath, bookPath] = process.argv.slice(2);
  if (!htmlPath) throw new Error("usage: node scripts/verify-portal.js <index.html> [gm-positions.json] [--expect-sealed]");
  const book = bookPath && fs.existsSync(bookPath) ? JSON.parse(fs.readFileSync(bookPath, "utf8")) : null;
  console.log("Portal verification:", verify(fs.readFileSync(htmlPath, "utf8"), book, { expectSealed: process.argv.includes("--expect-sealed") }));
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(String(error?.message || error).slice(0, 300));
    process.exitCode = 1;
  }
}

module.exports = { boundaryHit, planSymbols, readableText, verify };
