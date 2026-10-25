"use strict";
// Tests for scripts/nse-nifty-option-days.js holiday markers (25 Oct 2026: run with <to> = 2026-12-31, the old rule marked
// every session after the run as a holiday). NSE is replaced by a stub that answers 404 to everything.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { holidayMarker, istToday } = require("./nse-nifty-option-days");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };

check("a 404 eleven days ago is a holiday", holidayMarker("2026-10-14", "2026-10-25"));
check("a 404 ten days ago or later is not (yet) a holiday", !holidayMarker("2026-10-15", "2026-10-25") && !holidayMarker("2026-10-27", "2026-10-25"));
check("today is the IST date", istToday(Date.parse("2026-10-26T19:00:00Z")) === "2026-10-27" && istToday(Date.parse("2026-10-26T18:00:00Z")) === "2026-10-26");

// The whole run, against a stub NSE: today is fixed by the stub's clock.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-nod-"));
const out = path.join(dir, "nod");
fs.mkdirSync(out);
for (const d of ["2026-09-29", "2026-10-21", "2026-10-22", "2026-12-18"]) fs.writeFileSync(path.join(out, `${d}.none`), "");
fs.writeFileSync(path.join(out, "2026-10-23.json.gz"), "kept");
const stub = path.join(dir, "stub.js");
fs.writeFileSync(stub, `Date.now = () => Date.parse("2026-10-25T06:30:00Z"); global.fetch = async () => ({ status: 404, ok: false });`);
const r = spawnSync(process.execPath, ["-r", stub, path.join(__dirname, "nse-nifty-option-days.js"), out, "2026-09-28", "2026-12-31"], { encoding: "utf8" });
const files = fs.readdirSync(out).sort();
check("the run finishes", r.status === 0, (r.stderr || "").slice(0, 200));
check("an old holiday marker stays", files.includes("2026-09-29.none"));
check("recent and future markers are removed and re-checked", !files.includes("2026-10-21.none") && !files.includes("2026-10-22.none") && !files.includes("2026-12-18.none"), files.join(" "));
check("a recent 404 writes no marker", !files.includes("2026-10-19.none") && !files.includes("2026-10-20.none"), files.join(" "));
check("an old 404 writes a marker", files.includes("2026-09-28.none") && files.includes("2026-10-14.none"));
check("no day after today is fetched or marked", !files.some((f) => f >= "2026-10-26"), files.join(" "));
check("a saved day is kept", fs.readFileSync(path.join(out, "2026-10-23.json.gz"), "utf8") === "kept");
check("the report says what was re-checked", /, 3 recent holiday markers re-checked$/.test(r.stdout.trim()), r.stdout.trim());
fs.rmSync(dir, { recursive: true, force: true });

console.log(`nifty option days: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
