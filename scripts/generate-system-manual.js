"use strict";
// Never regenerate the withdrawn static profit / institutional-performance claims.
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "K2_FORENSIC_DATA_AND_PROFIT_AUDIT_2026-09-17.txt");
if (!fs.existsSync(source)) throw new Error("Reviewed audit document is required; no synthetic manual may be generated");
fs.writeFileSync(path.join(root, "K2_COMPLETE_SYSTEM_MANUAL_AND_ARCHITECTURE_2026.txt"),
  "K2 SYSTEM MANUAL — AUDITED CORRECTION\nSee the forensic audit below. The previous profit certification is withdrawn.\n\n" + fs.readFileSync(source, "utf8"));
console.log("Manual generated from the reviewed forensic audit; no performance numbers invented.");
