"use strict";
// Implements EXACTLY research/momentum-2026-09-25/PREREGISTRATION.txt
// (sha256 8018767c949b3c313102e0fdc749694ff6fe39096f589437bb8df01618654f60).
// No parameter here may differ from that file.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const PANEL = path.resolve(HERE, "..", "..", ".cache", "panel-bars");
const PREREG_SHA = "8018767c949b3c313102e0fdc749694ff6fe39096f589437bb8df01618654f60";
const TOP = 10, COST = 0.002, HURDLE = 1.6648;
const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", DATA_END = "2026-09-15";

const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex");
if (sha !== PREREG_SHA) { console.error(`PRE-REGISTRATION CHANGED (${sha}); result void.`); process.exit(2); }

// Month-end closes per symbol, keyed "YYYY-MM"; the last daily close of the month (IST date).
const istDay = (ts) => new Date((ts > 1e11 ? ts : ts * 1000) + 330 * 60_000).toISOString().slice(0, 10);
const closes = {};
const monthLastDay = {};
for (const file of fs.readdirSync(PANEL).filter((f) => f.endsWith(".json"))) {
  const sym = file.replace(/\.json$/, "");
  const bars = JSON.parse(fs.readFileSync(path.join(PANEL, file), "utf8"));
  const m = {};
  for (const b of bars) {
    const day = istDay(b[0]); const close = Number(b[4]);
    if (!(close > 0) || day > DATA_END) continue;
    const key = day.slice(0, 7);
    if (!m[key] || day >= m[key].day) m[key] = { day, close };
    if (!monthLastDay[key] || day > monthLastDay[key]) monthLastDay[key] = day;
  }
  closes[sym] = m;
}
const months = Object.keys(monthLastDay).sort();
// Complete months only: a month counts when its last trading day is within the data
// and it is not the final, partial month.
const lastMonth = DATA_END.slice(0, 7);
// The month holding DATA_END (Sep 2026: data ends on the 15th) is partial and is
// excluded, as the pre-registration says (final window Sep 2025 .. Aug 2026). The
// first run kept it by mistake -- a coding error, corrected to match the rule.
const complete = months.filter((k) => k !== lastMonth);
const idx = (k) => complete.indexOf(k);
const shift = (k, n) => complete[idx(k) + n];
const window = (h) => {
  const end = monthLastDay[h];
  if (end < DEV_END) return "development";
  if (end < FINAL_FROM) return "validation";
  return "final";
};

const rows = [];
for (let i = 12; i < complete.length - 1; i += 1) {
  const F = complete[i], H = complete[i + 1];
  const Fm12 = shift(F, -12), Fm1 = shift(F, -1);
  const elig = [];
  for (const [sym, m] of Object.entries(closes)) {
    if (!(m[Fm12] && m[Fm1] && m[F] && m[H])) continue;
    elig.push({ sym, signal: m[Fm1].close / m[Fm12].close - 1, ret: m[H].close / m[F].close - 1 });
  }
  if (elig.length < 3 * TOP) continue;
  elig.sort((a, b) => b.signal - a.signal);
  const mean = (a) => a.reduce((s, x) => s + x.ret, 0) / a.length;
  const bench = mean(elig), long = mean(elig.slice(0, TOP)), short = mean(elig.slice(-TOP));
  rows.push({ H, window: window(H), n: elig.length, bench, long, short,
    h1: long - bench - COST, h2: bench - short - COST, longNames: elig.slice(0, TOP).map((x) => x.sym) });
}

const stats = (xs) => {
  const n = xs.length; if (n < 2) return { n, mean: null, t: null };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, mean: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
};
const pct = (v) => (v === null ? "--" : (v * 100).toFixed(2) + "%");
const out = [];
const line = (s = "") => { out.push(s); console.log(s); };
line(`MOMENTUM 12-1 ON THE K2 PANEL -- result of the pre-registered test (prereg sha256 ${sha.slice(0, 16)}...)`);
line(`Run ${new Date().toISOString()}. ${Object.keys(closes).length} stocks, holding months ${rows[0]?.H} .. ${rows[rows.length - 1]?.H}, eligible per month ${Math.min(...rows.map((r) => r.n))}-${Math.max(...rows.map((r) => r.n))}.`);
line("");
line("window        months   H1 long-bench (net)   t      H2 bench-short (net)   t      long raw   bench raw");
const verdicts = {};
for (const w of ["development", "validation", "final"]) {
  const r = rows.filter((x) => x.window === w);
  const a = stats(r.map((x) => x.h1)), b = stats(r.map((x) => x.h2));
  const lr = stats(r.map((x) => x.long)), br = stats(r.map((x) => x.bench));
  verdicts[w] = { a, b };
  line(`${w.padEnd(13)} ${String(r.length).padStart(6)}   ${pct(a.mean).padStart(10)}/month       ${a.t === null ? "--" : a.t.toFixed(2).padStart(5)}   ${pct(b.mean).padStart(10)}/month        ${b.t === null ? "--" : b.t.toFixed(2).padStart(5)}   ${pct(lr.mean).padStart(8)}  ${pct(br.mean).padStart(8)}`);
}
const decide = (key) => {
  const f = verdicts.final[key], v = verdicts.validation[key];
  return f.mean > 0 && f.t !== null && f.t >= HURDLE && v.mean > 0 ? "PASS" : "FAIL";
};
line("");
line(`H1 (futures and calls on the long names): ${decide("a")}  -- rule: final mean > 0 AND final t >= ${HURDLE} AND validation mean > 0`);
line(`H2 (puts on the short names):             ${decide("b")}`);
line("A PASS means paper tracking on the TRACK tab only (the data was profiled before); a FAIL with ~12 months per window is weak evidence, not proof.");
line("");
line("final-window months (long leg names):");
for (const r of rows.filter((x) => x.window === "final")) line(`  ${r.H}  long ${pct(r.long).padStart(8)}  bench ${pct(r.bench).padStart(8)}  short ${pct(r.short).padStart(8)}  | ${r.longNames.join(" ")}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
