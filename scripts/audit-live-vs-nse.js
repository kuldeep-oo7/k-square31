"use strict";

/**
 * THE PUBLIC PAGE AGAINST NSE'S OWN SITE, EVERY ROW.
 *
 *   node scripts/audit-live-vs-nse.js [--all-options]
 *
 * The user, 28 Sep: "verify against the internet ... this is showing it is right
 * or wrong". The build's own check samples 16 contracts; this reads every row
 * of what the PUBLIC page shows and asks four questions of each:
 *   1. Does the page show the build's own numbers? (docs/data.json of the same
 *      build, matched on the stamp)
 *   2. Are its levels the stated arithmetic, on the contract's own tick? (buy
 *      0.8% under the anchor, rounded down; targets +2.5% / +5%; stop -1.5%;
 *      a call's stop half its buy)
 *   3. Is NOW the exchange's price? Read from nseindia.com seconds later: equal
 *      after the close, within a price band in session.
 *   4. Is it the same CONTRACT? The previous close on both.
 * Plus the header's India VIX and Nifty against NSE's allIndices, the F&O ban
 * list against NSE's own ban file, every lot size against NSE's fo_mktlots.csv,
 * every futures tick against NSE's own ticksize, and TRACK's verdicts on the
 * day's futures trades against NSE's own day high and low: a STOP needs a low
 * at or under the stop, a TARGET a high through the target, a fill a trade
 * under the buy. And every contract name the page tells you to type into
 * Zerodha is looked up in ZERODHA'S OWN instrument list (api.kite.trade, public):
 * it must exist, with the same expiry, strike, side and lot. Calls and puts
 * alike -- index options included -- since the page shows puts in a downtrend.
 * Network only: not in the check chain.
 */

const fs = require("node:fs");
const path = require("node:path");
const { toTick, ENTRY_DISCOUNT, TARGET_1, TARGET_2, STOP } = require("../api/_lib/session-levels");
const nse = require("../api/_lib/nse-crosscheck");

const PAGE = "https://kuldeep-oo7.github.io/k2-desk/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const allOptions = process.argv.includes("--all-options") || process.argv.includes("--all-calls");
const problems = [];
const notes = [];
const bad = (msg) => problems.push(msg);
const px = (v) => "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eq = (a, b, tol = 0.011) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

async function nseSession() {
  const home = await fetch("https://www.nseindia.com/option-chain", { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  return (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}
async function nseGet(url, cookie) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*", Cookie: cookie, Referer: "https://www.nseindia.com/" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "docs", "data.json"), "utf8"));
  const html = await (await fetch(`${PAGE}?audit=${Date.now()}`, { signal: AbortSignal.timeout(20_000) })).text();
  const text = html.replace(/<style[\s\S]*?<\/style>/, "").replace(/<script[\s\S]*?<\/script>/, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const stamp = (text.match(/Built (\S+ \S+) IST/) || [])[1];
  console.log(`public page: Built ${stamp} IST | docs/data.json: ${data.builtAtIst}`);
  if (!stamp || !data.builtAtIst.startsWith(stamp)) {
    console.log("The public page is a different build from docs/data.json -- git pull, or wait for the mirror.");
    process.exit(2);
  }
  const afterClose = data.sessionOver === true || data.marketPhase !== "OPEN";

  // 1 + 2: every futures row as the page shows it, and its arithmetic.
  for (const f of data.futures) {
    for (const [what, v] of [["buy", f.buy], ["target 1", f.target1], ["target 2", f.target2], ["stop", f.stop], ["now", f.spot]]) {
      if (v === null || v === undefined) continue;
      if (!text.includes(px(v))) bad(`${f.display || f.symbol}: its ${what} ${px(v)} is not on the page`);
    }
    const tick = Number(f.tick) || 0.05;
    const onGrid = (v) => Math.abs(v / tick - Math.round(v / tick)) < 1e-6;
    if (![f.buy, f.target1, f.target2, f.stop].every(onGrid)) bad(`${f.symbol}: a level is off its ${tick} tick`);
    const wantBuy = toTick(f.anchor * ENTRY_DISCOUNT, tick, "down");
    if (!eq(f.buy, wantBuy)) bad(`${f.symbol}: buy ${f.buy} is not ${wantBuy} (anchor ${f.anchor} x ${ENTRY_DISCOUNT}, rounded down)`);
    if (!eq(f.target1, toTick(f.buy * TARGET_1, tick, "nearest")) || !eq(f.target2, toTick(f.buy * TARGET_2, tick, "nearest"))
        || !eq(f.stop, toTick(f.buy * STOP, tick, "nearest"))) bad(`${f.symbol}: target or stop is not buy x ${TARGET_1}/${TARGET_2}/${STOP}`);
  }
  // Every option, calls and puts: what the page shows, the stop, and the tick.
  const calls = data.options;
  for (const c of calls) {
    for (const [what, v] of [["buy", c.buy], ["sell", c.sell], ["stop", c.stop], ["now", c.now]]) {
      if (v === null || v === undefined) continue;
      if (!text.includes(px(v))) bad(`${c.display}: its ${what} ${px(v)} is not on the page`);
    }
    const tick = Number(c.tick) || 0.05;
    if (![c.buy, c.sell, c.stop].every((v) => Math.abs(v / tick - Math.round(v / tick)) < 1e-6)) bad(`${c.display}: a level is off its ${tick} tick`);
    if (!eq(c.stop, toTick(c.buy / 2, tick, "nearest"))) bad(`${c.display}: stop ${c.stop} is not half the buy ${c.buy}`);
    if (!(c.sell > c.buy)) bad(`${c.display}: sell ${c.sell} is not above buy ${c.buy}`);
    if (!(c.lotSize > 0) || Math.abs(c.costPerLot - c.buy * c.lotSize) > 0.02) bad(`${c.display}: cost per lot ${c.costPerLot} is not ${c.buy} x ${c.lotSize}`);
  }
  const putCount = calls.filter((c) => c.right === "PE").length;
  console.log(`page vs build: ${data.futures.length} futures, ${calls.length - putCount} calls and ${putCount} puts read off the page`
    + (data.direction ? ` | direction ${data.direction.available ? `${data.direction.regime} since ${data.direction.since} (close of ${data.direction.asOf}${data.direction.stale ? ", STALE" : ""})` : "not read"}` : ""));

  // 3 + 4: against NSE's own site.
  const cookie = await nseSession();
  let compared = 0;
  const futRows = data.futures.filter((f) => f.priceBasis === "CONTRACT" && f.expiry);
  const bySymbol = new Map();
  for (const f of futRows) {
    let body = bySymbol.get(f.symbol);
    if (!body) {
      try { body = await nseGet(nse.urlFor({ kind: "FUT", symbol: f.symbol }), cookie); } catch (e) { body = { error: e.message }; }
      bySymbol.set(f.symbol, body);
      await pause(250);
    }
    const n = nse.nseFigures({ kind: "FUT", symbol: f.symbol, expiry: f.expiry }, body);
    if (!n) { notes.push(`${f.symbol} FUT: NSE did not answer (${body?.error || "no row"})`); continue; }
    const row = (body.data || []).find((x) => /^FUT/.test(x.instrumentType) && x.expiryDate === new Date(`${f.expiry}T00:00:00Z`)
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).replace(/ /g, "-"));
    if (row && Number(row.ticksize) > 0 && !eq(Number(row.ticksize), Number(f.tick), 1e-9)) bad(`${f.symbol} FUT: tick ${f.tick} on the page, ${row.ticksize} on NSE`);
    compared += 1;
    // AFTER THE CLOSE the page shows NSE's OFFICIAL close (the settlement file), which is not the
    // last trade: on 1 Oct 2026 DRREDDY's Oct future closed officially at 1210.7 (closePrice, and
    // the F&O bhavcopy's close and settlement) while its last trade was 1212.9 (lastPrice). The audit
    // compared against lastPrice and flagged four correct rows. After the close, compare against
    // NSE's own closePrice; in session, the last trade.
    const official = afterClose && Number(row?.closePrice) > 0 ? Number(row.closePrice) : null;
    const ref = official ?? n.last, refName = official !== null ? "NSE official close" : "NSE last";
    const gap = Math.abs(f.spot - ref) / ref * 100;
    if (afterClose ? !eq(f.spot, ref, Math.max(0.011, ref * 0.0005)) : gap > 1) {
      bad(`${f.symbol} ${f.expiry} FUT: page NOW ${f.spot}, ${refName} ${ref} (${gap.toFixed(2)}%)`);
    }
  }
  const chains = new Map();
  const sampleCalls = allOptions ? calls : calls.filter((c, i, a) => a.findIndex((x) => x.symbol === c.symbol) === i);
  for (const c of sampleCalls) {
    const req = { kind: "OPT", symbol: c.symbol, expiry: c.expiry, strike: c.strike, optionType: c.right };
    const key = `${c.symbol}|${c.expiry}`;
    let body = chains.get(key);
    if (!body) {
      try { body = await nseGet(nse.urlFor(req), cookie); } catch (e) { body = { error: e.message }; }
      chains.set(key, body);
      await pause(250);
    }
    const n = nse.nseFigures(req, body);
    if (!n || !(n.last > 0)) { notes.push(`${c.display}: no NSE last price (${body?.error || "untraded leg"})`); continue; }
    compared += 1;
    const tol = afterClose ? 0.011 : Math.max(0.15, n.last * 0.1);
    if (!eq(c.now, n.last, tol)) bad(`${c.display}: page NOW ${c.now}, NSE last ${n.last}`);
  }
  console.log(`page vs NSE: ${compared} contracts compared (${futRows.length} futures, ${sampleCalls.length} options${allOptions ? "" : ", one strike per name"})`);

  // Every name the page gives for Zerodha, in Zerodha's own instrument list.
  try {
    const csv = await (await fetch("https://api.kite.trade/instruments/NFO", { signal: AbortSignal.timeout(60_000) })).text();
    const kite = new Map();
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const cells = line.split(",");
      if (cells.length >= 12) kite.set(cells[2], { expiry: cells[5], strike: Number(cells[6]), lot: Number(cells[8]), type: cells[9] });
    }
    let named = 0;
    for (const c of calls) {
      const k = kite.get(c.zerodha);
      named += 1;
      if (!k) { bad(`${c.display}: Zerodha has no contract named ${c.zerodha}`); continue; }
      if (k.expiry !== c.expiry || k.strike !== Number(c.strike) || k.type !== c.right || k.lot !== Number(c.lotSize)) {
        bad(`${c.zerodha}: Zerodha lists expiry ${k.expiry}, strike ${k.strike}, ${k.type}, lot ${k.lot}; the page says ${c.expiry}, ${c.strike}, ${c.right}, lot ${c.lotSize}`);
      }
    }
    for (const f of data.futures.filter((x) => x.priceBasis === "CONTRACT" && x.tradingSymbol)) {
      const k = kite.get(f.tradingSymbol);
      named += 1;
      if (!k) bad(`${f.symbol}: Zerodha has no contract named ${f.tradingSymbol}`);
      else if (k.expiry !== f.expiry || k.type !== "FUT") bad(`${f.tradingSymbol}: Zerodha lists ${k.type} expiring ${k.expiry}; the page says ${f.expiry}`);
    }
    console.log(`Zerodha names: ${named} contracts looked up in Zerodha's own instrument list (${kite.size} NFO contracts)`);
  } catch (e) { notes.push(`Zerodha names not checked: ${e.message}`); }

  // Every lot size against NSE's own lot file.
  try {
    const csv = String(await nseGet("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv", cookie)).split(/\r?\n/);
    const head = csv[0].split(",").map((x) => x.trim().toUpperCase());
    const lots = new Map();
    for (const line of csv.slice(1)) {
      const cells = line.split(",").map((x) => x.trim());
      if (cells[1]) lots.set(cells[1], Object.fromEntries(head.map((h, i) => [h, Number(cells[i]) || null])));
    }
    const col = (iso) => `${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`;
    let lotChecked = 0;
    for (const c of calls) {
      const want = lots.get(c.symbol)?.[col(c.expiry)];
      if (!want) continue;
      lotChecked += 1;
      if (Number(c.lotSize) !== want) bad(`${c.display}: lot ${c.lotSize} on the page, ${want} in NSE's lot file`);
    }
    for (const f of data.futures.filter((x) => x.expiry && x.exchangeLot)) {
      const want = lots.get(f.symbol)?.[col(f.expiry)];
      if (want && Number(f.exchangeLot) !== want) bad(`${f.symbol} FUT: lot ${f.exchangeLot}, ${want} in NSE's lot file`);
    }
    console.log(`lot sizes: ${lotChecked} options checked against NSE's fo_mktlots.csv`);
  } catch (e) { notes.push(`lot sizes not checked: ${e.message}`); }

  // TRACK's verdicts on today's futures trades against NSE's own day range.
  const today = data.sessionDate;
  const trades = [...(data.track?.open || []), ...(data.track?.recentClosed || [])]
    .filter((t) => t.kind === "FUT" && t.sessionDate === today && t.priceBasis !== "SHARE" && t.expiry);
  let judged = 0;
  for (const t of trades) {
    const body = bySymbol.get(t.symbol);
    const row = (body?.data || []).find((x) => /^FUT/.test(x.instrumentType) && x.expiryDate === new Date(`${t.expiry}T00:00:00Z`)
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).replace(/ /g, "-"));
    const hi = Number(row?.highPrice), lo = Number(row?.lowPrice);
    if (!(hi > 0) || !(lo > 0)) continue;
    judged += 1;
    if (t.filledAt && !(lo < t.buy)) bad(`TRACK ${t.contract}: filled, but NSE's low ${lo} never traded under the buy ${t.buy}`);
    if (t.status === "STOP" && !(lo <= t.stop)) bad(`TRACK ${t.contract}: STOP, but NSE's low ${lo} is above the stop ${t.stop}`);
    if (t.status === "TARGET" && !(hi > t.target)) bad(`TRACK ${t.contract}: TARGET, but NSE's high ${hi} is not through ${t.target}`);
  }
  console.log(`TRACK: ${judged} of today's futures trades checked against NSE's day high and low`);

  // The header against NSE's allIndices.
  try {
    const idx = await nseGet("https://www.nseindia.com/api/allIndices", cookie);
    const row = (name) => (idx.data || []).find((x) => x.index === name);
    const nifty = row("NIFTY 50"), vix = row("INDIA VIX");
    const pageNifty = Number((text.match(/Nifty ([\d,.]+)/) || [])[1]?.replace(/,/g, ""));
    const pageVix = Number((text.match(/India VIX ([\d.]+)/) || [])[1]);
    // After the close the page shows NSE's OFFICIAL close (ind_close_all), not allIndices' 15:30 value.
    const official = await require("../api/_lib/nse-market-context").officialClose(idx.timestamp);
    const refVix = official?.vix?.close ?? vix?.last, refNifty = official?.nifty?.close ?? nifty?.last, src = official ? "NSE official close" : "NSE";
    if (!eq(pageNifty, refNifty, 0.051)) bad(`header Nifty ${pageNifty}, ${src} ${refNifty}`);
    if (!eq(pageVix, refVix, 0.0051)) bad(`header India VIX ${pageVix}, ${src} ${refVix}`);
    console.log(`header: Nifty ${pageNifty} (${src} ${refNifty}), India VIX ${pageVix} (${src} ${refVix})`);
  } catch (e) { notes.push(`header not checked: ${e.message}`); }

  // The ban list against NSE's own file.
  try {
    const csv = await nseGet("https://nsearchives.nseindia.com/content/fo/fo_secban.csv", cookie);
    const nseBan = String(csv).split(/\r?\n/).slice(1).map((l) => l.split(",")[1]?.trim()).filter(Boolean).sort();
    const dated = (String(csv).match(/(\d{2}-[A-Z]{3}-\d{4})/i) || [])[1] || "?";
    const ours = (data.banList?.symbols || []).slice().sort();
    const same = JSON.stringify(nseBan) === JSON.stringify(ours);
    console.log(`ban list: page ${ours.join(", ") || "none"} (for ${data.banList?.tradeDate}); NSE's file (${dated}) ${nseBan.join(", ") || "none"}`);
    if (!same) notes.push(`the ban lists differ -- NSE's file may be for the next session (${dated}); the next build reads it`);
  } catch (e) { notes.push(`ban list not checked: ${e.message}`); }

  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n  ` + problems.join("\n  ") : "\nNo problem: every level is its arithmetic on its tick, the page shows the build's numbers, and NOW is NSE's price.");
  if (notes.length) console.log(`notes:\n  ` + notes.slice(0, 20).join("\n  "));
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error("audit failed:", e.message); process.exit(3); });
