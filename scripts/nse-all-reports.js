"use strict";
// EVERY DAILY FILE NSE PUBLISHES (owner, 12 Oct 2026: "every data that nse publish ... from even a minor to major").
// Reads NSE's own "All Reports" list -- www.nseindia.com/api/daily-reports?key=<segment> for CM, FO, INDEX, SLBS,
// CD, COM, NBF (144 distinct files on 11 Oct 2026) -- and downloads every file it lists for the current and the
// previous trading day. Nothing is hand-picked, so a file NSE adds is collected too. ~140 MB a trading day.
//   K2_ALL_DIR=nse-all node scripts/nse-all-reports.js      -> nse-all/<YYYY-MM-DD>/<SEG>/<file> + manifest.json
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEGMENTS = ["CM", "FO", "INDEX", "SLBS", "CD", "COM", "NBF"];
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isoOf = (s) => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(s || "")); return m && MON[m[2]] ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null; };

// NSE's list -> [{ segment, date, name, url, display }], one entry per distinct file
function filesFromList(segment, json) {
  const out = new Map();
  for (const day of ["PreviousDay", "CurrentDay"]) for (const r of Array.isArray(json?.[day]) ? json[day] : []) {
    const date = isoOf(r.tradingDate); if (!date || !r.filePath || !r.fileActlName) continue;
    const url = String(r.filePath).replace(/\/?$/, "/") + r.fileActlName;
    if (!/^https:\/\/(nsearchives|www|archives)\.nseindia\.com\//.test(url)) continue;     // NSE's own hosts only
    const name = path.basename(r.fileActlName); if (!name || name.startsWith(".")) continue;
    out.set(`${date}|${name}`, { segment, date, name, url, display: String(r.displayName || "").replace(/<[^>]+>|&reg;/g, "").replace(/\s+/g, " ").trim() });
  }
  return [...out.values()];
}

async function main() {
  const root = path.resolve(process.env.K2_ALL_DIR || "nse-all");
  const home = await fetch("https://www.nseindia.com/all-reports", { headers: { "User-Agent": UA } });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const files = [];
  for (const seg of SEGMENTS) {
    try {
      const r = await fetch(`https://www.nseindia.com/api/daily-reports?key=${seg}`, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.nseindia.com/all-reports", Cookie: cookie }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      files.push(...filesFromList(seg, await r.json()));
    } catch (e) { console.log(`list ${seg}: FAILED ${e.message}`); }
    await pause(1000);
  }
  const byDate = {}; let got = 0, had = 0, failed = 0, bytes = 0;
  for (const f of files) {
    const dir = path.join(root, f.date, f.segment); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, f.name); const entry = { segment: f.segment, name: f.name, display: f.display, url: f.url };
    if (fs.existsSync(file)) { had += 1; entry.bytes = fs.statSync(file).size; }
    else {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const r = await fetch(f.url, { headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://www.nseindia.com/all-reports" }, signal: AbortSignal.timeout(120000) });
          if (r.status === 404) { entry.missing = "404 on NSE"; break; }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer()); if (!buf.length) throw new Error("empty");
          fs.writeFileSync(file, buf); entry.bytes = buf.length; entry.sha256 = crypto.createHash("sha256").update(buf).digest("hex"); got += 1; bytes += buf.length; break;
        } catch (e) { if (attempt === 3) { entry.missing = e.message; failed += 1; } else await pause(5000 * attempt); }
      }
      await pause(500);
    }
    (byDate[f.date] ||= []).push(entry);
  }
  for (const [date, entries] of Object.entries(byDate)) {
    const mf = path.join(root, date, "manifest.json");
    const prev = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, "utf8")).files || [] : [];
    const merged = new Map([...prev, ...entries].map((e) => [`${e.segment}|${e.name}`, e]));
    fs.writeFileSync(mf, JSON.stringify({ date, source: "www.nseindia.com/api/daily-reports", updatedAt: new Date().toISOString(), files: [...merged.values()] }, null, 1));
  }
  console.log(`NSE all reports: ${files.length} listed (${Object.keys(byDate).sort().join(", ")}); ${got} downloaded (${(bytes / 1048576).toFixed(1)} MB), ${had} already here, ${failed} failed`);
  if (!files.length) process.exit(1);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { filesFromList, isoOf };
