"use strict";

// Prints the distinct symbols in a GM book dump as a comma-separated list, for
// feeding straight into the weekly plan's --symbols argument.
//
//   node scripts/held-symbols.js gm-positions.json

const fs = require("node:fs");

function run() {
  const source = process.argv[2] || "gm-positions.json";
  const book = JSON.parse(fs.readFileSync(source, "utf8"));
  const symbols = [...new Set((book.positions || [])
    .map((position) => String(position.symbol || "").toUpperCase())
    .filter((symbol) => /^[A-Z0-9&-]{1,30}$/.test(symbol)))];
  process.stdout.write(symbols.join(","));
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(`Could not read held symbols: ${String(error?.message || error).slice(0, 160)}`);
    process.exitCode = 1;
  }
}
