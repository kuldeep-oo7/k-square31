"use strict";
// DESCRIPTIVE: open-to-close change of the futures-vs-share gap, for EVERY stock-day with a near-month future (2021 .. 2026-10-01),
// compared with short build-up days, and split by the share's move the day before. Not a test.
const fs = require("node:fs"), path = require("node:path");
const R = "C:/Users/kulde/Downloads/pivot31/research";
const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), futDir = path.join(R, "orderflow-2026-10-03", "nse-fo", "fut");
const files = fs.readdirSync(futDir).filter((x) => x.endsWith(".json") && x >= "2020-12-01").sort();
let prevCm = null; const buckets = new Map(); const add = (k, v) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(v); };
for (const f of files) { const d = f.slice(0, 10); let cm; try { cm = JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8")); } catch { continue; }
  const sh = new Map(); for (const r of cm) if (r[2] === "EQ" && r[3] > 0 && r[6] > 0) sh.set(r[1], { o: r[3], c: r[6], pc: r[7] });
  const near = new Map(); for (const r of JSON.parse(fs.readFileSync(path.join(futDir, f), "utf8"))) { if (r[1] !== "STK" || !(r[3] > 0 && r[6] > 0) || r[2] < d) continue; if (!near.has(r[0]) || r[2] < near.get(r[0])[2]) near.set(r[0], r); }
  for (const [s, r] of near) { const b = sh.get(s); if (!b) continue; const v = Math.log(r[6] / b.c) - Math.log(r[3] / b.o); if (!Number.isFinite(v) || Math.abs(v) > 0.05) continue;
    add("all", v); const prevMove = prevCm && prevCm.get(s) ? b.pc && prevCm.get(s).c ? prevCm.get(s).c / prevCm.get(s).pc - 1 : null : null;
    if (prevMove !== null) add(prevMove <= -0.0156 ? "share fell >= 1.56% the day before" : prevMove >= 0.0156 ? "share rose >= 1.56% the day before" : "share moved less the day before", v);
    const gap = b.o / b.pc - 1; add(gap < 0 ? "share opened below yesterday's close" : "share opened at or above", v); }
  prevCm = sh; }
const m = (v) => v.reduce((a, x) => a + x, 0) / v.length;
for (const [k, v] of buckets) console.log(`${k.padEnd(40)} n ${String(v.length).padStart(7)} | futures gain vs share, open -> close: ${(m(v) * 100).toFixed(3)}%`);
