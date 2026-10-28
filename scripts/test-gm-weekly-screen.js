"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { project, render, freshQuote } = require("../api/_lib/gm-weekly-screen");
const { prepare } = require("./prepare-gm-weekly");
const { pipelineSha256 } = require("./scan-gm-weekly");
const crypto = require("node:crypto");
const candidate = { symbol: "TEST", expiry: "2026-11-23", tickSize: 0.05, setup: "CHANNEL_BREAKOUT", side: "BUY", signalDate: "2026-10-26",
  signalClose: 1000, stopPrice: 990, atr14: 20, status: "UNVALIDATED_PAPER_CANDIDATE" };
const report = { mode: "PAPER_RESEARCH_ONLY", asOf: "2026-10-26", candidates: [candidate], examined: 200, status: "UNVALIDATED_PAPER_CANDIDATES" };
const now = Date.parse("2026-10-27T09:17:00+05:30");
const quote = { price: 1000, bid: 999, ask: 1001, exchangeFeedTime: "27-Oct-2026 09:17:00" };
const preview = project({ report, now: Date.parse("2026-10-26T21:00:00+05:30") });
assert.equal(preview.view.rows[0].status, "PREVIEW");
assert.equal(preview.view.rows[0].targetPrice, 1030);
assert.equal(Object.keys(preview.state.positions).length, 0);
assert.equal(freshQuote(quote, now), true);
assert.equal(freshQuote({ ...quote, exchangeFeedTime: "26-Oct-2026 09:17:00" }, now), false);
assert.equal(freshQuote({ ...quote, exchangeFeedTime: "27-Oct-2026 10:00:00" }, now), false);
const live = project({ report, quotes: { "TEST|2026-11-23": quote }, now, marketOpen: true });
assert.equal(live.view.rows[0].status, "PAPER_ENTRY_FROZEN");
assert.equal(live.view.rows[0].entryPrice, 1001, "a long enters on the observed ask, never retroactively on the open");
assert.equal(live.view.rows[0].targetPrice, 1031.05);
assert.equal(live.view.rows[0].stopPrice, 990);
const again = project({ report, state: live.state, now, marketOpen: true, quotes: { "TEST|2026-11-23": { ...quote, ask: 1005, bid: 1004 } } });
assert.equal(again.view.rows.length, 1); assert.equal(again.view.rows[0].entryPrice, 1001, "paper entry does not chase the market");
assert.equal(again.view.rows[0].targetPrice, 1031.05);
const short = project({ report: { ...report, candidates: [{ ...candidate, side: "SELL", stopPrice: 1010 }] }, now, marketOpen: true, quotes: { "TEST|2026-11-23": quote } });
assert.equal(short.view.rows[0].entryPrice, 999, "a short enters on the bid");
assert.equal(short.view.rows[0].targetPrice, 969);
const rejected = project({ report, quotes: { "TEST|2026-11-23": { ...quote, bid: 1050, ask: 1051 } }, now, marketOpen: true });
assert.equal(rejected.view.rows[0].status, "SKIP_ENTRY_GAP_OR_RISK"); assert.equal(Object.keys(rejected.state.positions).length, 0);
assert.equal(project({ report, now, marketOpen: true }).view.rows[0].status, "WAITING_FOR_FRESH_QUOTE");
assert.equal(project({ report, now: Date.parse("2026-10-27T16:00:00+05:30") }).view.rows[0].status, "ENTRY_WINDOW_CLOSED");
assert.equal(project({ report, now: Date.parse("2026-10-28T09:17:00+05:30"), marketOpen: true }).view.rows.length, 0, "no new entry from yesterday's list");
assert.equal(project({ report: null, state: live.state, now }).view.rows.length, 1, "feed failure must retain already frozen levels");
const html = render(live.view, "2026-10-27");
assert.ok(html.includes("Paper entry") && html.includes("1,001.00") && html.includes("Stop-loss") && html.includes("Sell target") && html.includes("1,031.05"));
assert.ok(render(short.view, "2026-10-27").includes("Buy-back target"));
assert.ok(render(live.view, "2026-10-28").includes("No entry prices issued") && !render(live.view, "2026-10-28").includes("1,001.00"));
assert.ok(render({ ...live.view, rows: [{ ...live.view.rows[0], symbol: '<img src=x onerror="x">' }] }, "2026-10-27").includes("&lt;img"));

// The first fresh quote decides (28 Oct 2026: entries froze at 12:53 and 13:13 after opening outside the range).
const t0933 = Date.parse("2026-10-27T09:33:00+05:30"), q0933 = { ...quote, exchangeFeedTime: "27-Oct-2026 09:33:00" };
const retried = project({ report, state: rejected.state, quotes: { "TEST|2026-11-23": q0933 }, now: t0933, marketOpen: true });
assert.equal(retried.view.rows[0].status, "SKIP_ENTRY_GAP_OR_RISK", "a later price in range never reopens a skipped plan");
assert.equal(Object.keys(retried.state.positions).length, 0); assert.equal(retried.view.rows[0].skipPrice, 1051);
const t1013 = Date.parse("2026-10-27T10:13:00+05:30");
const tooLate = project({ report, quotes: { "TEST|2026-11-23": { ...quote, exchangeFeedTime: "27-Oct-2026 10:13:00" } }, now: t1013, marketOpen: true });
assert.equal(tooLate.view.rows[0].status, "MISSED_NO_OPENING_QUOTE"); assert.equal(Object.keys(tooLate.state.positions).length, 0);
assert.equal(project({ report, state: tooLate.state, now: Date.parse("2026-10-27T20:00:00+05:30") }).view.rows[0].status, "MISSED_NO_OPENING_QUOTE");
assert.equal(live.state.positions[Object.keys(live.state.positions)[0]].entryHigh, null, "no session high in the quote, none recorded");

// Exits. PATANJALI on 28 Oct 2026 (NSE F&O bhavcopy): a legacy short frozen at 13:13 without the session high/low.
const pat = { symbol: "PAT", expiry: "2026-11-23", side: "SELL", entryPrice: 346.6, stopPrice: 349.7, targetPrice: 336.2, quantity: 20,
  tickSize: 0.05, entryDate: "2026-10-28", deadline: "2026-11-23", signalDate: "2026-10-27", setup: "CHANNEL_BREAKDOWN",
  frozenAt: "2026-10-28T07:43:47.501Z", entrySource: "FIRST_OBSERVED_BID" };
const bar28 = { date: "2026-10-28", open: 344.6, high: 375, low: 335.95, close: 368.05 };
const eve28 = Date.parse("2026-10-28T20:45:00+05:30"), eve29 = Date.parse("2026-10-29T20:45:00+05:30");
const exitAt = (bars, at = eve29, position = pat, asOf = "2026-10-29") =>
  project({ state: { positions: { k: position } }, bars: { [`PAT|${position.expiry}`]: bars }, barsAsOf: asOf, now: at }).view.rows[0];
const stopped = exitAt([bar28], eve28, pat, "2026-10-28");
assert.deepEqual([stopped.status, stopped.exit.price, stopped.exit.pnlInr, stopped.exit.date], ["EXIT_STOP", 349.7, -62, "2026-10-28"], "closed above the stop after the entry");
const html28 = render({ date: "2026-10-28", rows: [stopped] }, "2026-10-28");
assert.ok(html28.includes("STOP HIT 2026-10-28 · bought back ₹349.70 · −₹62 (−0.89%)") && !html28.includes('class="gm-fill"'), html28);
const calm = { date: "2026-10-28", open: 344.6, high: 375, low: 335.95, close: 347 };
assert.equal(exitAt([calm], eve28, pat, "2026-10-28").exit, undefined, "the entry day's high may predate the entry");
assert.deepEqual(exitAt([calm, { date: "2026-10-29", open: 352, high: 353, low: 351, close: 352 }]).exit.price, 352, "a gap through the stop fills at the open");
assert.deepEqual([exitAt([calm, { date: "2026-10-29", open: 347, high: 350, low: 336, close: 340 }]).exit.reason, exitAt([calm, { date: "2026-10-29", open: 347, high: 350, low: 336, close: 340 }]).exit.price], ["STOP", 349.7], "stop and target in one session: the stop counts");
const won = exitAt([calm, { date: "2026-10-29", open: 347, high: 349, low: 336.1, close: 337 }]);
assert.deepEqual([won.status, won.exit.price, won.exit.pnlInr], ["EXIT_TARGET", 336.2, 208]);
assert.deepEqual([exitAt([calm, { date: "2026-10-29", open: 347, high: 348, low: 345, close: 345.5 }], eve29, { ...pat, deadline: "2026-10-29" }).exit.reason,
  exitAt([calm, { date: "2026-10-29", open: 347, high: 348, low: 345, close: 345.5 }], eve29, { ...pat, deadline: "2026-10-29", expiry: "2026-10-29" }).exit.reason], ["TIME", "EXPIRY"]);
const waiting = exitAt([], eve28, pat, "2026-10-28");
assert.equal(waiting.status, "PAPER_ENTRY_FROZEN"); assert.equal(waiting.unchecked, true);
assert.ok(render({ date: "2026-10-28", rows: [waiting] }, "2026-10-28").includes("late 13:13, old rule · exit check waiting for the daily bar"));
assert.equal(project({ state: { positions: { k: stopped } }, now: eve29 }).view.rows.length, 1, "an exit shows through the next session");
assert.equal(project({ state: { positions: { k: stopped } }, now: Date.parse("2026-10-30T09:20:00+05:30") }).view.rows.length, 0);
// In session: a later day's whole range counts; on the entry day only a new extreme after the freeze does.
const q29 = (q) => ({ "PAT|2026-11-23": { exchangeFeedTime: "29-Oct-2026 10:00:00", ...q } }), t29 = Date.parse("2026-10-29T10:00:00+05:30");
const opened = { ...pat, checkedThrough: "2026-10-28" };
assert.equal(project({ state: { positions: { k: opened } }, quotes: q29({ price: 347, open: 346, high: 350, low: 345 }), barsAsOf: "2026-10-28", now: t29, marketOpen: true }).view.rows[0].exit.price, 349.7);
const fresh = { ...pat, entryDate: "2026-10-29", frozenAt: "2026-10-29T03:47:00Z", entryHigh: 348, entryLow: 345 };
assert.equal(project({ state: { positions: { k: fresh } }, quotes: q29({ price: 347, high: 348, low: 336 }), now: t29, marketOpen: true }).view.rows[0].exit.reason, "TARGET", "a new low after the freeze reached the target");
assert.equal(project({ state: { positions: { k: { ...fresh, entryLow: 335 } } }, quotes: q29({ price: 347, high: 348, low: 335 }), now: t29, marketOpen: true }).view.rows[0].exit, undefined, "a low set before the freeze does not count");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-screen-"));
  try {
    let scans = 0;
    const deps = { dir, now, scanRun: async () => { scans++; return report; }, quotesFor: async () => ({ quotes: { "TEST|2026-11-23": quote } }), marketOpen: true };
    const v = await prepare(deps); assert.equal(v.rows[0].entryPrice, 1001);
    const p = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(Object.values(p.positions)[0].entryPrice, 1001);
    const refreshed = await prepare({ ...deps, quotesFor: async () => ({ quotes: { "TEST|2026-11-23": { ...quote, ask: 1004 } } }) });
    assert.equal(refreshed.rows[0].entryPrice, 1001);
    const output = JSON.parse(fs.readFileSync(path.join(dir, "screen.json"), "utf8"));
    assert.ok(!JSON.stringify(output).includes("macdHistogram"), "public screen excludes model features and raw histories");
    assert.equal(scans, 2, "a report missing provenance is not trusted as a reusable scan");
    const outage = await prepare({ ...deps, quotesFor: async () => { throw new Error("provider down"); } });
    assert.equal(outage.rows[0].entryPrice, 1001, "a quote outage retains the existing entry, stop and target");
    assert.equal(outage.rows[0].last, null); assert.equal(outage.dataReason, "LIVE_QUOTES_UNAVAILABLE");
    const failedScan = await prepare({ ...deps, scanRun: async () => { throw new Error("scanner down"); } });
    assert.equal(failedScan.rows[0].entryPrice, 1001); assert.equal(failedScan.status, "DATA_UNAVAILABLE");
    const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", file))).digest("hex");
    const reusable = { ...report, configSha256: hash("config/gm-weekly-research.json"), engineSha256: hash("api/_lib/gm-technical-research.js"), pipelineSha256: pipelineSha256() };
    let cacheScans = 0;
    const cacheDeps = { ...deps, marketOpen: false, scanRun: async () => { cacheScans++; return reusable; } };
    const legacy = { ...reusable }; delete legacy.pipelineSha256;
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(legacy));
    await prepare(cacheDeps);
    assert.equal(cacheScans, 1, "legacy same-day cache must refresh after the pipeline fix");
    await prepare(cacheDeps);
    assert.equal(cacheScans, 1, "a complete result from the current pipeline is reused");
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ ...reusable, pipelineSha256: "old-feed-or-retry-version" }));
    await prepare(cacheDeps);
    assert.equal(cacheScans, 2, "a feed/retry-only change invalidates an otherwise current strategy result");
    const unchangedSources = pipelineSha256(() => "unchanged");
    for (const file of ["gm-research-feed.js", "scan-gm-weekly.js", "nse-holidays.js", "gm-weekly-goal.js"]) {
      assert.notEqual(pipelineSha256((p) => p.endsWith(file) ? "modified" : "unchanged"), unchangedSources, `the fingerprint covers ${file}`);
    }
    // prepare() reads each open entry's own daily bars (the scan may have stopped before reaching it) and stores the exit.
    const exitDir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-exit-"));
    try {
      fs.writeFileSync(path.join(exitDir, "state.json"), JSON.stringify({ positions: { k: pat } }));
      let asked = 0;
      const v28 = await prepare({ dir: exitDir, now: eve28, marketOpen: false, scanRun: async () => ({ ...report, asOf: "2026-10-28", candidates: [] }),
        history: async (a) => { asked++; return { ok: true, symbol: a.symbol, expiry: a.expiry, asOf: a.asOf, bars: [bar28] }; } });
      assert.equal(v28.rows[0].status, "EXIT_STOP"); assert.equal(asked, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(exitDir, "state.json"), "utf8")).positions.k.exit.reason, "STOP", "the exit is stored");
    } finally { fs.rmSync(exitDir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log("GM weekly screen: previews, bid/ask entries, frozen levels, stale data, shorts, escaping and preparation passed.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
