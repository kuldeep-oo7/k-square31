"use strict";
// The 97-name panel rebuilt from NSE's own security-wise history (series EQ,
// unadjusted), 2021-09-01 .. 2026-09-28, in 80-day requests (NSE answers at
// most 70 rows a request). Yahoo's panel had wrong bars: IRFC 15 Jan 2024 was
// flat at 109.55; NSE has it 116.70 -> 130.10 on a 113.40 previous close.
// A symbol NSE renamed is followed back through NSE's symbol-change file, but
// only when the current name's history starts late (most old names in that
// file predate this window). Three symbols at a time.
// Output: nse-panel/SYMBOL.json = [[date, open, high, low, close, prevClose], ...]

const fs = require("node:fs");
const path = require("node:path");
const HERE = __dirname;
const OUT = path.join(HERE, "nse-panel");
const PANEL = path.resolve(HERE, "..", "..", ".cache", "panel-bars");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const START = "2021-09-01", END = "2026-09-28";
const dmy = (d) => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
const istDay = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// GENTLE, AND STOPS ON REFUSAL (29 Sep night). The first run asked every 0.4 s
// and kept retrying when NSE began refusing, until NSE refused this machine
// outright. Now: 3 s between requests; one retry for a timeout; a second
// failure in a row STOPS the whole run (resume later: finished symbols are
// kept). And nothing after 07:00 IST, so NSE still answers this machine for
// the morning's check of the live page.
const GAP_MS = 3000;
const DEADLINE_IST_MINUTES = 7 * 60;
const istMinutesNow = () => { const t = new Date(Date.now() + 330 * 60_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
const pastDeadline = () => { const m = istMinutesNow(); return m >= DEADLINE_IST_MINUTES && m < 20 * 60; };
class Refused extends Error {}

async function cookieFor(symbol) {
  const r = await fetch(`https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}

let requests = 0;
// NSE's own session calendar (its NIFTY 50 history), to count what each window should hold.
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "nifty-50-nse.json"), "utf8")).rows.map((r) => r.date);
const sessionsIn = (a, b) => CAL.filter((d) => d >= a && d <= b).length;

async function window(name, from, to, rows, state) {
  const url = `https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData?from=${dmy(from)}&to=${dmy(to)}&symbol=${encodeURIComponent(name)}&type=priceVolumeDeliverable&series=EQ`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (pastDeadline()) throw new Refused("07:00 IST deadline reached");
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: state.cookie, Referer: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(name)}` }, signal: AbortSignal.timeout(30_000) });
      requests += 1;
      if (res.status === 401 || res.status === 403) { state.cookie = await cookieFor(name); throw new Error(`HTTP ${res.status}`); }
      const j = await res.json();
      const got = (j.data || []).filter((r) => r.CH_SERIES === "EQ");
      for (const x of got) {
        const day = istDay(Date.parse(x.CH_TIMESTAMP));
        if (!rows.has(day)) rows.set(day, [day, x.CH_OPENING_PRICE, x.CH_TRADE_HIGH_PRICE, x.CH_TRADE_LOW_PRICE, x.CH_CLOSING_PRICE, x.CH_PREVIOUS_CLS_PRICE]);
      }
      return got.length;
    } catch (e) {
      if (e instanceof Refused) throw e;
      if (attempt === 2) throw new Refused(`${name} ${dmy(from)}: ${e.message} -- NSE refused twice in a row; stopping the whole run`);
      await pause(10_000);
    }
  }
  return -1;
}

async function history(name, rows, state) {
  let from = new Date(`${START}T00:00:00Z`);
  const end = new Date(`${END}T00:00:00Z`);
  while (from <= end) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + 80 * 86_400_000));
    const want = sessionsIn(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    const got = await window(name, from, to, rows, state);
    // Short but not empty: a capped or cut answer. Ask again in two halves.
    if (got > 0 && got < want) {
      const mid = new Date(from.getTime() + Math.floor((to - from) / 2 / 86_400_000) * 86_400_000);
      await pause(GAP_MS);
      await window(name, from, mid, rows, state);
      await pause(GAP_MS);
      await window(name, new Date(mid.getTime() + 86_400_000), to, rows, state);
    }
    from = new Date(to.getTime() + 86_400_000);
    await pause(GAP_MS);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let changes = {};
  try { changes = require("../../api/_lib/nse-symbols").loadNseSymbols()?.changes || {}; } catch {}
  const oldNames = (sym) => Object.entries(changes).filter(([, to]) => to === sym).map(([from]) => from);
  const queue = fs.readdirSync(PANEL).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
    .filter((sym) => !fs.existsSync(path.join(OUT, `${sym}.json`)) && !fs.existsSync(path.join(OUT, `${sym}.incomplete.json`)));
  console.log(`${queue.length} symbols to fetch`);
  const worker = async () => {
    const state = { cookie: await cookieFor("INFY") };
    while (queue.length) {
      const sym = queue.shift();
      const rows = new Map();
      await history(sym, rows, state);
      const first = [...rows.keys()].sort()[0] || "9999";
      const also = [];
      if (first > "2021-09-20") for (const old of oldNames(sym)) { also.push(old); await history(old, rows, state); }
      const list = [...rows.values()].sort((a, b) => a[0].localeCompare(b[0]));
      // COMPLETE OR NOT AT ALL: every NSE session from the first to the last date must be there.
      const have = new Set(list.map((r) => r[0]));
      const missing = list.length ? CAL.filter((d) => d >= list[0][0] && d <= list[list.length - 1][0] && !have.has(d)) : [];
      if (missing.length) {
        fs.writeFileSync(path.join(OUT, `${sym}.incomplete.json`), JSON.stringify({ sym, sessions: list.length, missing }));
        console.log(`${sym}: INCOMPLETE -- ${missing.length} NSE sessions missing (${missing.slice(0, 3).join(", ")}...); left out of the study`);
        continue;
      }
      fs.writeFileSync(path.join(OUT, `${sym}.json`), JSON.stringify(list));
      console.log(`${sym}: ${list.length} sessions ${list[0]?.[0] || "-"} .. ${list.at(-1)?.[0] || "-"}${also.length ? ` (also as ${also.join(", ")})` : ""}`);
    }
  };
  try {
    await worker();   // one at a time: three at once made NSE time out (29 Sep)
    console.log(`done: ${requests} requests`);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.log(`STOPPED: ${e.message}. ${requests} requests; ${queue.length} symbols not reached. Finished symbols are kept; run again later to resume.`);
  }
})().catch((e) => { console.error("fetch failed:", e.message); process.exit(1); });
