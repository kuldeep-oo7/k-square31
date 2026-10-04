"use strict";
// Merges daily NSE index files (scripts/nse-index-close-history.js) into one archive, the release asset
// data-nse-idx/nse-idx.json = { "Nifty 50": [[date, o, h, l, c], ...], ... } (api/_lib/nse-index-history.js).
//   node scripts/nse-index-archive.js <daily dir> <archive.json in> <archive.json out>
const fs = require("node:fs");
const path = require("node:path");
const { mergeDaily, loadArchive } = require("../api/_lib/nse-index-history");
const [dir, inFile, outFile] = process.argv.slice(2);
const daily = {}; for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) daily[f.slice(0, 10)] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const merged = mergeDaily(inFile && fs.existsSync(inFile) ? loadArchive(inFile) : null, daily);
fs.writeFileSync(outFile, JSON.stringify(merged));
console.log(Object.entries(merged).map(([k, v]) => `${k}: ${v.length} sessions, ${v[0]?.[0]} .. ${v.at(-1)?.[0]}`).join(" | "));
