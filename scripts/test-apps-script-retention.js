"use strict";

/**
 * THE APPS SCRIPT'S K2_STATE RETENTION, RUN AS WRITTEN AGAINST A SIMULATED SHEET.
 *
 * google-sheets/K2MarketArchive.gs is loaded unchanged into a sandbox whose
 * SpreadsheetApp, LockService and PropertiesService are small fakes over plain
 * arrays, so the functions Google runs are the functions tested: every write
 * keeps the newest three versions of its document and deletes the rest, reads
 * still return the newest complete version, a multi-chunk document survives
 * pruning whole, other documents are untouched, and the one-time pruneK2State()
 * cleans a sheet that had kept every version (181 rows on 28 Sep).
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { gzipSync, gunzipSync } = require("node:zlib");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

// ---- a fake Sheet: rows[0] is the header, getRange is 1-based ----
function fakeSheet(name) {
  const rows = [];
  const range = (r, c, nr, nc) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => Array.from({ length: nc }, (_, i) => (row[c - 1 + i] === undefined ? "" : row[c - 1 + i]))),
    setValues: (values) => { values.forEach((v, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; v.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; }); }); return range(r, c, nr, nc); },
    setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
  });
  return {
    rows, name,
    getName: () => name,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((r) => r.length)),
    getRange: range,
    setFrozenRows() {},
    deleteRows: (start, count) => { rows.splice(start - 1, count); }
  };
}
function sandbox() {
  const sheets = new Map();
  const spreadsheet = {
    getId: () => "SHEET",
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = fakeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()]
  };
  const context = {
    console: { log() {} },
    SpreadsheetApp: { flush() {}, openById: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "K2_SPREADSHEET_ID" ? "SHEET" : "secret"), setProperty() {} }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: "json" } },
    Utilities: { getUuid: () => "u" }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "google-sheets", "K2MarketArchive.gs"), "utf8"), context);
  return { context, spreadsheet, sheets };
}
const encode = (obj) => gzipSync(Buffer.from(JSON.stringify(obj))).toString("base64");
const decode = (b64) => JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString());

console.log("K2_STATE retention in the Apps Script:");
{
  const { context: gs, spreadsheet } = sandbox();
  const write = (p, obj, expected) => gs.writeDocument_(spreadsheet, { path: p, expectedVersion: expected, encoding: "gzip-base64", encoded: encode(obj) });
  const read = (p) => gs.readDocuments_(spreadsheet, { paths: [p] }).documents[0];
  let v = 0;
  for (let i = 1; i <= 6; i += 1) {
    const r = write("k2/ledger-open.json", { n: i }, v);
    check(`write ${i} is version ${i}`, r.ok === true && r.version === i, JSON.stringify(r));
    v = r.version;
  }
  const state = spreadsheet.getSheetByName("K2_STATE");
  const versions = [...new Set(state.rows.slice(1).filter((r) => r[0] === "k2/ledger-open.json").map((r) => r[1]))].sort();
  check("after six writes only the newest three versions remain (4, 5, 6)", JSON.stringify(versions) === "[4,5,6]", JSON.stringify(versions));
  const doc = read("k2/ledger-open.json");
  check("and a read returns the newest, whole", doc.found && doc.version === 6 && decode(doc.encoded).n === 6, JSON.stringify({ found: doc.found, version: doc.version }));
  const conflict = write("k2/ledger-open.json", { n: 7 }, 3);
  check("a write against an old version is still refused (CONFLICT), nothing deleted", conflict.ok === false && conflict.code === "CONFLICT"
    && [...new Set(state.rows.slice(1).map((r) => r[1]))].length === 3);

  // A document larger than one 40,000-character chunk.
  const big = { blob: Array.from({ length: 60000 }, (_, i) => (i * 7919) % 104729).join(",") };
  let bv = 0;
  for (let i = 0; i < 5; i += 1) bv = write("k2/desk-2026-09-29.json", { ...big, i }, bv).version;
  const bigRows = state.rows.slice(1).filter((r) => r[0] === "k2/desk-2026-09-29.json");
  const chunkCount = bigRows.find((r) => r[1] === bv)[3];
  check("a multi-chunk document keeps its newest three versions with every chunk", chunkCount > 1
    && JSON.stringify([...new Set(bigRows.map((r) => r[1]))].sort()) === "[3,4,5]" && bigRows.length === 3 * chunkCount,
    `${bigRows.length} rows, ${chunkCount} chunks a version`);
  check("and reads back whole", decode(read("k2/desk-2026-09-29.json").encoded).i === 4);
  check("writing one document never touches another", read("k2/ledger-open.json").version === 6 && decode(read("k2/ledger-open.json").encoded).n === 6);
}

console.log("\nthe one-time cleanup of a sheet that kept everything:");
{
  const { context: gs, spreadsheet } = sandbox();
  const state = gs.getStateSheet_(spreadsheet);
  // 28 Sep's shape: every version kept, three documents.
  for (const [p, n] of [["k2/desk-2026-09-28.json", 26], ["k2/ledger-open.json", 26], ["k2/ledger-closed-2026-09.json", 26]]) {
    for (let v = 1; v <= n; v += 1) state.rows.push([p, v, 0, 1, encode({ p, v }), "t"]);
  }
  state.rows.push(["", "", "", "", "", ""]);
  const before = state.rows.length - 1;
  const deleted = gs.pruneK2State();
  const left = state.rows.slice(1);
  check(`pruneK2State deletes all but the newest three of each (${before} rows -> ${left.length})`, left.length === 9 && deleted === before - 9, `${deleted} deleted`);
  for (const p of ["k2/desk-2026-09-28.json", "k2/ledger-open.json", "k2/ledger-closed-2026-09.json"]) {
    const d = gs.readDocuments_(spreadsheet, { paths: [p] }).documents[0];
    check(`${p}: the newest version still reads back (26)`, d.found && d.version === 26 && decode(d.encoded).v === 26);
  }
  check("the header row is untouched", state.rows[0][0] === "Path");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
