const fs = require("node:fs");
const path = require("node:path");

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\"") {
      if (quoted && source[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift();
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function readList(file) {
  return parseCsv(fs.readFileSync(file, "utf8"));
}

function main() {
  const [nifty500File, largeFile, midFile, smallFile] = process.argv.slice(2);
  if (!smallFile) {
    throw new Error("Usage: node scripts/refresh-ai-universe.js nifty500.csv nifty100.csv midcap150.csv smallcap250.csv");
  }
  const large = new Set(readList(largeFile).map((item) => item.Symbol));
  const mid = new Set(readList(midFile).map((item) => item.Symbol));
  const small = new Set(readList(smallFile).map((item) => item.Symbol));
  const items = readList(nifty500File).map((item) => {
    const symbol = String(item.Symbol || "").toUpperCase();
    const marketCapCategory = large.has(symbol) ? "Large Cap" : mid.has(symbol) ? "Mid Cap" : small.has(symbol) ? "Small Cap" : "Unclassified";
    return {
      symbol,
      name: item["Company Name"],
      sector: item.Industry || "Other",
      marketCapCategory
    };
  }).filter((item) => /^[A-Z0-9&-]{1,30}$/.test(item.symbol));
  const categoryCounts = items.reduce((counts, item) => {
    counts[item.marketCapCategory] = (counts[item.marketCapCategory] || 0) + 1;
    return counts;
  }, {});
  if (items.length !== 500 || categoryCounts["Large Cap"] !== 100 || categoryCounts["Mid Cap"] !== 150 || categoryCounts["Small Cap"] !== 250) {
    throw new Error(`Unexpected official universe: ${items.length} stocks; ${JSON.stringify(categoryCounts)}`);
  }
  const output = {
    name: "Nifty 500 broad market",
    source: "NSE Indices",
    sourceUrl: "https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500",
    constituentUrl: "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv",
    generatedAt: new Date().toISOString(),
    categoryCounts: { large: 100, mid: 150, small: 250 },
    stocks: items
  };
  const target = path.join(__dirname, "..", "ai-universe-data.json");
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${items.length} official stocks to ${target}`);
}

main();
