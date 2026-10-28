"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { plan, result } = require("../api/_lib/gm-weekly-goal");
const T = require("../api/_lib/gm-technical-research");
const { futuresHistory } = require("../api/_lib/gm-research-feed");
const { run, parseArgs, lastClosedSession } = require("./scan-gm-weekly");
const { audit } = require("./audit-gm-goal");

const base = { entryPrice: 1000, side: "BUY", tickSize: 0.05, entryDate: "2026-10-26", expiry: "2026-11-23" };
assert.equal(plan(base).targetPrice, 1030);
assert.equal(plan({ ...base, side: "SELL" }).targetPrice, 970);
assert.equal(plan(base).deadline, "2026-10-30", "the weekly deadline is a tradable session, not Sunday");
assert.equal(plan({ ...base, entryDate: "2026-12-21", expiry: "2026-12-29" }).deadline, "2026-12-24", "skip the exchange's Christmas holiday");
assert.equal(plan({ ...base, expiry: "2026-10-27" }).deadline, "2026-10-27");
const swing = plan({ ...base, maxHoldingSessions: 20 });
assert.equal(swing.deadline, "2026-11-23");
assert.equal(result(swing, { exitPrice: 1030, exitDate: "2026-11-02" }).grossGoalMet, true, "a target after one week still counts under the stored 20-session policy");
assert.equal(result(swing, { exitPrice: 1030, exitDate: "2026-10-26" }).grossGoalMet, true, "entry-day targets exit immediately");
assert.equal(result(swing, { exitPrice: 1030, exitDate: "2026-11-02" }).withinWeek, false);
assert.equal(plan(swing).deadline, swing.deadline, "saved holding policies do not change when reloaded");
for (const side of ["BUY", "SELL"]) {
  const p = plan({ ...base, entryPrice: 1000.15, side });
  assert.ok(p.targetReturnPct >= 3 - 1e-9, "round the target away from entry");
  const net = plan({ ...base, side, roundTripCostsInr: 120 });
  assert.equal(net.targetPrice, side === "BUY" ? 1036 : 964);
  assert.equal(net.netPnlInr, 600);
  const r = result(net, { exitPrice: net.targetPrice, exitDate: "2026-10-30", roundTripCostsInr: 120 });
  assert.equal(r.netGoalMet, true);
  assert.equal(r.netReturnPct, 3);
}
const gross = result(plan(base), { exitPrice: 1030, exitDate: "2026-10-30" });
assert.equal(gross.grossGoalMet, true);
assert.equal(gross.netGoalMet, null, "unknown costs must not become zero");
assert.equal(result(plan(base), { exitPrice: 1030, exitDate: "2026-11-02" }).grossGoalMet, false);
assert.equal(result(plan({ ...base, side: "SELL" }), { exitPrice: 970, exitDate: "2026-10-30" }).grossReturnPct, 3);
for (const invalid of [{ entryPrice: null }, { entryPrice: Infinity }, { quantity: 19 }, { quantity: 20.5 }, { side: "long" },
  { tickSize: null }, { tickSize: 0.015 }, { entryDate: "2026-02-30" }, { expiry: "2026-10-25" }, { roundTripCostsInr: -1 }]) {
  assert.throws(() => plan({ ...base, ...invalid }));
}
assert.throws(() => result(plan(base), { exitPrice: null, exitDate: "2026-10-30" }));

function fixture() {
  const dates = []; let d = "2026-10-26";
  while (dates.length < 60) {
    const wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) dates.unshift(d);
    d = new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
  }
  const bars = dates.map((date, i) => {
    const close = 100 + i * 0.1 + 0.8 * Math.sin(i * 2.4);
    return { symbol: "TEST", expiry: base.expiry, date, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
  });
  const res = Math.max(...bars.slice(-21, -1).map((b) => b.high));
  Object.assign(bars.at(-1), { open: res - 0.1, close: res + 0.2, high: res + 0.4, low: res - 0.4, volume: 2000 });
  return { symbol: "TEST", expiry: base.expiry, tickSize: 0.05, asOf: "2026-10-26", source: "NSE_FUTURES", bars };
}
const f = fixture(), found = T.scan(f);
assert.ok(Object.values(T.indicators(f.bars.slice(-35))).every(Number.isFinite), "the 35-bar research variant has no missing 50-day EMA");
assert.equal(found.status, "RESEARCH_ONLY", JSON.stringify(found));
assert.equal(found.candidates[0].setup, "CHANNEL_BREAKOUT");
assert.equal(found.candidates[0].probability, null);
const mirrored = { ...f, bars: f.bars.map((b) => ({ ...b, open: 250 - b.open, close: 250 - b.close, high: 250 - b.low, low: 250 - b.high })) };
assert.equal(T.scan(mirrored).candidates[0].setup, "CHANNEL_BREAKDOWN");
assert.equal(T.scan({ ...f, source: "YAHOO_CASH" }).reason, "ACTUAL_FUTURES_DATA_REQUIRED");
assert.equal(T.scan({ ...f, tickSize: 0.015 }).reason, "CONTRACT_METADATA_REQUIRED");
assert.equal(T.scan({ ...f, bars: f.bars.slice(-30) }).reason, "INSUFFICIENT_SAME_CONTRACT_HISTORY");
assert.equal(T.scan({ ...f, asOf: "2026-10-27" }).reason, "STALE_FUTURES_HISTORY");
assert.equal(T.scan({ ...f, bars: [...f.bars, f.bars.at(-1)] }).reason, "INVALID_OR_UNSORTED_BARS");
assert.equal(T.scan({ ...f, bars: f.bars.map((b, i) => i ? b : { ...b, expiry: "2026-10-27" }) }).reason, "CONTRACT_IDENTITY_MISMATCH");
assert.equal(T.scan({ ...f, bars: f.bars.map((b) => ({ ...b, volume: 0 })) }).reason, "INVALID_OR_UNSORTED_BARS");
assert.equal(T.scan({ ...f, bars: f.bars.map((b, i) => i ? b : { ...b, corporateAction: true }) }).reason, "EXTREME_GAP_OR_CORPORATE_ACTION_REQUIRES_REVIEW");
assert.equal(T.scan({ ...f, bars: f.bars.map((b) => ({ ...b, volume: 1000 })) }).reason, "VOLUME_NOT_CONFIRMED");
assert.equal(T.nextSession("2026-10-19"), "2026-10-21", "use the exchange holiday list");
assert.equal(T.nextSession("2026-10-23"), "2026-10-26");
assert.equal(T.nextSession("2026-12-31"), null, "never guess an uncovered calendar year");
const candidate = found.candidates[0];
const bound = T.bindEntry(candidate, { entryPrice: candidate.signalClose, entryDate: "2026-10-27" });
assert.ok(bound.targetReturnPct >= 3 && bound.status === "PAPER_ONLY");
assert.throws(() => T.bindEntry(candidate, { entryPrice: candidate.signalClose + 10, entryDate: "2026-10-27" }));
assert.throws(() => T.bindEntry(candidate, { entryPrice: candidate.signalClose, entryDate: "2026-10-28" }));

const position = { ...plan(base), symbol: "TEST", stopPrice: 985 };
const bar = (date, o, h, l, c) => ({ symbol: "TEST", expiry: base.expiry, date, open: o, high: h, low: l, close: c, volume: 100 });
const entry = bar("2026-10-26", 1000, 1010, 990, 1002);
const opts = { entryAtSessionOpen: true };
assert.equal(T.replay(position, [bar("2026-10-26", 1000, 1040, 980, 1000)], opts).reason, "STOP_FIRST_AMBIGUOUS_BAR");
assert.equal(T.replay(position, [entry, bar("2026-10-27", 970, 1000, 960, 990)], opts).exitPrice, 970);
assert.equal(T.replay(position, [entry, bar("2026-10-27", 1040, 1050, 980, 990)], opts).reason, "TARGET", "target fill at the open precedes later lows");
assert.equal(T.replay(position, [entry, bar("2026-10-28", 1002, 1040, 990, 1030)], opts).status, "CENSORED");
assert.equal(T.replay(position, [entry]).reason, "INTRADAY_ENTRY_ORDER_UNKNOWN");
assert.equal(T.replay(position, []).reason, "INTRADAY_ENTRY_ORDER_UNKNOWN");
assert.equal(T.replay(position, [], opts).reason, "ENTRY_SESSION_MISSING");
assert.throws(() => T.replay(position, [{ ...entry, expiry: "2026-10-27" }], opts));
const week = [entry, ...["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"].map((d) => bar(d, 1002, 1010, 990, 1005))];
assert.equal(T.replay(position, week, { ...opts, completeThrough: "2026-11-01" }).reason, "TIME_EXIT");
assert.equal(T.replay(position, week.slice(0, -1), { ...opts, completeThrough: "2026-11-01" }).status, "CENSORED", "missing Friday is not a Thursday exit");
assert.equal(T.replay(position, week, { ...opts, completeThrough: "2026-10-30" }).reason, "TIME_EXIT");

async function main() {
  const now = Date.parse("2026-10-26T16:00:00+05:30");
  const instruments = { fetchedAt: new Date(now - 2 * 3600e3).toISOString(), futures: { "TEST|2026-11-23": { token: "DUMMY", exchange: "NFO", tickSize: 0.05 } } };
  const credentials = { apiKey: "DUMMY", accessToken: "DUMMY" };
  let request;
  const data = f.bars.map((b) => [`${b.date}T00:00:00+05:30`, b.open, b.high, b.low, b.close, b.volume]);
  const fetchImpl = async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ status: true, data }) }; };
  const input = { symbol: "TEST", expiry: base.expiry, asOf: "2026-10-26", now, instruments, credentials, fetchImpl };
  const live = await futuresHistory(input);
  assert.equal(live.ok, true); assert.deepEqual(live.bars, f.bars);
  assert.ok(request.url.endsWith("/historical/v1/getCandleData"));
  assert.equal(JSON.parse(request.init.body).exchange, "NFO");
  assert.equal(JSON.parse(request.init.body).interval, "ONE_DAY");
  assert.equal((await futuresHistory({ ...input, now: now - 3600e3 })).reason, "SESSION_NOT_CLOSED");
  assert.equal((await futuresHistory({ ...input, credentials: null })).reason, "ANGEL_SESSION_NOT_CONFIGURED");
  assert.equal((await futuresHistory({ ...input, instruments: { ...instruments, fetchedAt: "2026-10-14" } })).reason, "INSTRUMENT_MASTER_STALE");
  const response = (rows) => async () => ({ ok: true, json: async () => ({ status: true, data: rows }) });
  assert.equal((await futuresHistory({ ...input, fetchImpl: response([...data, data[0]]) })).reason, "DUPLICATE_SESSION_CANDLES");
  assert.equal((await futuresHistory({ ...input, fetchImpl: response([["2026-10-26T00:00:00", 1, 2, 1, 2, 100]]) })).reason, "INVALID_CANDLE_RESPONSE");
  assert.equal((await futuresHistory({ ...input, fetchImpl: async () => { throw Object.assign(new Error("DO_NOT_LOG_REQUEST"), { cause: { code: "EACCES" } }); } })).reason, "NETWORK_ACCESS_DENIED");
  assert.equal((await futuresHistory({ ...input, fetchImpl: async () => ({ ok: false, status: 401 }) })).reason, "ANGEL_SESSION_REJECTED");
  // Angel's real expired-session reply (27 Oct 2026): HTTP 200 with success/errorCode, not status/errorcode.
  assert.equal((await futuresHistory({ ...input, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, message: "Invalid Token", errorCode: "AG8001", data: "" }) }) })).reason, "ANGEL_SESSION_REJECTED");
  let calls = 0, refreshes = 0;
  const liveReport = await run({ live: true, asOf: f.asOf, symbols: ["TEST"] }, { now, instruments,
    history: async () => ++calls === 1 ? { ok: false, reason: "ANGEL_SESSION_REJECTED" } : f,
    ensureSession: async () => { refreshes++; return { ok: true }; } });
  assert.equal(calls, 2); assert.equal(refreshes, 1); assert.equal(liveReport.candidates.length, 1);
  const deniedReport = await run({ live: true, asOf: f.asOf, symbols: ["TEST"] }, { now, instruments,
    history: async () => ({ ok: false, reason: "NETWORK_ACCESS_DENIED" }) });
  assert.equal(deniedReport.candidates.length, 0); assert.equal(deniedReport.rejected.NETWORK_ACCESS_DENIED, 1);
  assert.equal(deniedReport.status, "DATA_UNAVAILABLE", "a failed feed is not evidence that the market has no setup");
  assert.equal(deniedReport.partial, true, "a scan that stops early must be retried by the next build");
  // Angel's burst limit (27 Oct 2026): AG8001 again after the refresh -> pause, retry the same contract once.
  let burst = 0;
  const burstReport = await run({ live: true, asOf: f.asOf, symbols: ["TEST"] }, { now, instruments, pauseMs: 1,
    history: async () => ++burst <= 2 ? { ok: false, reason: "ANGEL_SESSION_REJECTED" } : f,
    ensureSession: async () => ({ ok: true }) });
  assert.equal(burst, 3); assert.equal(burstReport.candidates.length, 1); assert.notEqual(burstReport.partial, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-weekly-test-"));
  try {
    const file = path.join(dir, "input.json"); fs.writeFileSync(file, JSON.stringify([f]));
    const report = await run({ input: file, asOf: f.asOf }, { now });
    assert.equal(report.candidates.length, 1); assert.equal(report.mode, "PAPER_RESEARCH_ONLY");
    assert.equal(report.status, "UNVALIDATED_PAPER_CANDIDATES");
    assert.equal(audit(dir).evidence.every((e) => e.available === false), true, "missing evidence stays unavailable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(lastClosedSession(Date.parse("2026-10-26T09:00:00+05:30")), "2026-10-23");
  assert.throws(() => parseArgs(["--live", "--input", "x"]));
  assert.throws(() => parseArgs(["--live", "--symbols", "../bad"]));
  assert.equal(parseArgs(["--live", "--symbols", "TEST"]).symbols[0], "TEST");
  console.log("GM weekly research: target arithmetic, causal signals, conservative exits, feed and runner checks passed (synthetic data).");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
