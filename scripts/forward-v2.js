"use strict";
// Writes docs/paper-rules/forward-v2.json: the forward paper tests of the protocol-v2 survivors
// (studies/forward-v2-2026-10-04/PREREGISTRATION.txt).
//   K2_CM_DIR=nse-data/cm K2_IDX_DIR=nse-idx K2_OPT_DIR=nse-extra/opt node scripts/forward-v2.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { START, strangle, maCross } = require("../api/_lib/forward-v2");
const { loadCm } = require("./springy-dip-forward");
const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), idxDir = path.resolve(process.env.K2_IDX_DIR || "nse-idx"), optDir = path.resolve(process.env.K2_OPT_DIR || "nse-extra/opt");
const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "forward-v2.json"));
const data = loadCm(cm);
const niftyClose = new Map(); if (fs.existsSync(idxDir)) for (const f of fs.readdirSync(idxDir).filter((x) => x.endsWith(".json"))) { const j = JSON.parse(fs.readFileSync(path.join(idxDir, f), "utf8")); if (j["Nifty 50"]) niftyClose.set(f.slice(0, 10), j["Nifty 50"][3]); }
const opt = new Map(); if (fs.existsSync(optDir)) for (const f of fs.readdirSync(optDir).filter((x) => x.endsWith(".json"))) opt.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(optDir, f), "utf8")));
const s = strangle({ sessions: data.sessions, niftyClose, opt }); const m = maCross(data);
const prereg = path.join(__dirname, "..", "studies", "forward-v2-2026-10-04", "PREREGISTRATION.txt");
const doc = { preregistration: "studies/forward-v2-2026-10-04/PREREGISTRATION.txt", preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg)).digest("hex"), start: START,
  dataThrough: data.sessions[data.sessions.length - 1], builtAt: new Date().toISOString(),
  STRANGLE: { rule: "Sell the NIFTY call about 2% above and the put about 2% below, at the close of the first session with 4-10 days to the weekly expiry; hold to expiry", backtest: "PASS under protocol v2: +0.101% of NIFTY a week, t 4.66, 61 months (not significant after the 73-trial Deflated Sharpe check)", ...s },
  MA150A: { rule: "Short a stock whose close crosses below its 150-day average; cover 10 sessions later; scored against the market", backtest: "PROMISING: +0.338% a trade above the market, t 2.26", pending: m.A.pending, trades: m.A.trades.slice(0, 300), summary: m.A.summary },
  MA150B: { rule: "Short a stock whose 5-day average crosses below its 150-day average; cover 10 sessions later; scored against the market", backtest: "PROMISING: +0.307% a trade above the market, t 2.58", pending: m.B.pending, trades: m.B.trades.slice(0, 300), summary: m.B.summary } };
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(`data through ${doc.dataThrough}: strangle ${s.trades.length} trade(s); MA150-A ${m.A.pending.length} signal(s), MA150-B ${m.B.pending.length}`);
