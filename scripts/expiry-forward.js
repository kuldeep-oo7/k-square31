"use strict";
// THE EXPIRY-SELLING FORWARD PAPER TEST, run by the paper job (.github/workflows/springy-dip.yml) after NSE posts the day's
// files: every NIFTY expiry session from 2026-10-27, from NSE's own files only. Rules: api/_lib/expiry-forward.js
// (studies/expiry-selling-forward-2026-10-21/PREREGISTRATION.txt). Writes docs/paper-rules/expiry-selling.json.
//   K2_NOD_DIR=nse-nod K2_IDX_DIR=nse-idx node scripts/expiry-forward.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ef = require("../api/_lib/expiry-forward");

const ROOT = path.resolve(__dirname, "..");
const NOD = path.resolve(process.env.K2_NOD_DIR || "nse-nod"), IDX = path.resolve(process.env.K2_IDX_DIR || "nse-idx");
const OUT = path.join(ROOT, "docs", "paper-rules", "expiry-selling.json");
const PREREG = "studies/expiry-selling-forward-2026-10-21/PREREGISTRATION.txt";

function build({ nodDir = NOD, idxDir = IDX } = {}) {
  const files = fs.existsSync(nodDir) ? fs.readdirSync(nodDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort() : [];
  const niftyOpen = (d) => { const p = path.join(idxDir, `${d}.json`); if (!fs.existsSync(p)) return null; const v = JSON.parse(fs.readFileSync(p, "utf8"))["Nifty 50"]; return Array.isArray(v) && v[0] > 0 ? v[0] : null; };
  const days = []; let lot = null, last = null, nextExpiry = null;
  for (const f of files) { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(nodDir, f)))); last = j.date; if (j.lot > 0) lot = j.lot;
    const later = (j.rows || []).map((r) => r[0]).filter((e) => e > j.date).sort(); if (later.length) nextExpiry = later[0];
    if (j.date < ef.START) continue; const d = ef.expiryDay(j, niftyOpen(j.date)); if (d) days.push(d); }
  const { out, skipped } = ef.run(days, true);
  const members = Object.fromEntries(Object.keys(ef.MEMBERS).map((k) => [k, { name: ef.MEMBERS[k], summary: ef.summary(out[k]),
    expiries: out[k].slice(-52).reverse().map((t) => ({ date: t.date, call: t.call, put: t.put, credit: +t.credit.toFixed(2), points: +t.points.toFixed(2), pct: +t.pct.toFixed(3), stops: t.stops })) }]));
  let sha = null; try { sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, PREREG), "utf8").replace(/\r\n/g, "\n")).digest("hex"); } catch { /* registration missing: shown as unknown */ }
  return { preregistration: PREREG, preregSha256: sha, start: ef.START, primary: ef.PRIMARY, need: ef.NEED, dataThrough: last, nextExpiry: nextExpiry && nextExpiry >= ef.START ? nextExpiry : ef.START,
    lot, expirySessions: days.length, skipped, builtAt: new Date().toISOString(), members };
}

if (require.main === module) {
  const r = build(); fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + "\n");
  const s = r.members[r.primary].summary;
  console.log(`expiry selling (forward from ${r.start}): data through ${r.dataThrough || "none"}, ${r.expirySessions} expiry sessions counted, ${r.skipped} skipped; ${r.primary} ${s.expiries} expiries${s.expiries ? `, ${s.meanPoints} points an expiry, ${s.won}% won` : ""} -> ${s.verdict}; next expiry ${r.nextExpiry}; NIFTY lot ${r.lot ?? "unknown"}`);
}
module.exports = { build };
