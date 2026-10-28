"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "../..");
const SPEC = require("./PROTOCOL.json");
const { indicators, ema, scan } = require("../../api/_lib/gm-technical-research");
const { identifyCandlestickPatterns } = require("../../api/_lib/candlestick-engine");
const { scanChartPatterns } = require("../../api/_lib/chart-patterns");
const { normalCdf, normalQuantile } = require("../../api/_lib/panel");
const FAMILIES = SPEC.families;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const b = [...a].sort((x, y) => x - y), n = b.length; return n ? n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2 : null; };
const sd = (a) => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : null;
function rsi(values, n) {
  const delta = values.slice(1).map((v, i) => v - values[i]);
  let u = mean(delta.slice(0, n).map((x) => Math.max(x, 0))), d = mean(delta.slice(0, n).map((x) => Math.max(-x, 0)));
  for (let i = n; i < delta.length; i++) { u = (u * (n - 1) + Math.max(delta[i], 0)) / n; d = (d * (n - 1) + Math.max(-delta[i], 0)) / n; }
  return u === 0 && d === 0 ? 50 : d === 0 ? 100 : 100 - 100 / (1 + u / d);
}
function signals(bars, context = {}) {
  if (bars.length < SPEC.minHistory) return [];
  const b = bars.at(-1), p = bars.at(-2), closes = bars.map((x) => x.close), previous = bars.slice(0, -1);
  const x = indicators(bars), e10 = ema(closes, 10), e20 = ema(closes, 20);
  const trend = b.close > e10.at(-1) && e10.at(-1) > e20.at(-1) ? 1 : b.close < e10.at(-1) && e10.at(-1) < e20.at(-1) ? -1 : 0;
  const out = [], add = (family, side, stopPrice = null) => { if (side) out.push({ family, side, stopPrice }); };
  add("BASELINE", 1); add("BASELINE", -1);
  if (e10.at(-1) > e20.at(-1) && e10.at(-2) <= e20.at(-2)) add("EMA10_20_CROSS", 1);
  if (e10.at(-1) < e20.at(-1) && e10.at(-2) >= e20.at(-2)) add("EMA10_20_CROSS", -1);
  if (b.close > x.resistance20) add("CHANNEL20", 1);
  if (b.close < x.support20) add("CHANNEL20", -1);
  const prevRsi = rsi(closes.slice(0, -1), 14);
  if (x.rsi14 > 30 && prevRsi <= 30) add("RSI14_REVERSAL", 1);
  if (x.rsi14 < 70 && prevRsi >= 70) add("RSI14_REVERSAL", -1);
  const r2 = rsi(closes, 2);
  if (r2 < 10 && trend === 1) add("RSI2_TREND20", 1);
  if (r2 > 90 && trend === -1) add("RSI2_TREND20", -1);
  const prevHist = indicators(previous).macdHistogram;
  if (x.macdHistogram > 0 && prevHist <= 0) add("MACD_CROSS", 1);
  if (x.macdHistogram < 0 && prevHist >= 0) add("MACD_CROSS", -1);
  const bb = (c) => { const a = c.slice(-20), m = mean(a), s = Math.sqrt(mean(a.map((v) => (v - m) ** 2))); return [m - 2 * s, m + 2 * s]; };
  const bands = bb(closes), oldBands = bb(closes.slice(0, -1));
  if (p.close < oldBands[0] && b.close >= bands[0]) add("BOLLINGER_REENTRY", 1);
  if (p.close > oldBands[1] && b.close <= bands[1]) add("BOLLINGER_REENTRY", -1);
  if (b.high - b.low < Math.min(...bars.slice(-7, -1).map((v) => v.high - v.low))) add("NR7_TREND", trend);
  const candles = identifyCandlestickPatterns(bars);
  add("CANDLE_CONTEXT", candles.bias === "BULLISH" ? 1 : candles.bias === "BEARISH" ? -1 : 0);
  for (const pattern of scanChartPatterns(bars).patterns || []) {
    const side = pattern.bias === "BULLISH" ? 1 : -1;
    const level = pattern.neckline ?? pattern.breakoutLevel ?? pattern.breakdownLevel ?? pattern.rimPrice;
    if (Number.isFinite(level) && side * (b.close - level) > 0 && side * (p.close - level) <= 0) add("CHART_FORMATION", side);
  }
  // Heikin-Ashi is a causal feature only. Every entry and exit below uses raw futures prices.
  let haOpen = (bars[0].open + bars[0].close) / 2, haClose = mean([bars[0].open, bars[0].high, bars[0].low, bars[0].close]);
  const haSides = [];
  for (let i = 1; i < bars.length; i++) { haOpen = (haOpen + haClose) / 2; const a = bars[i]; haClose = mean([a.open, a.high, a.low, a.close]); haSides.push(Math.sign(haClose - haOpen)); }
  if (trend && haSides.slice(-3).every((v) => v === trend)) add("HEIKIN_ASHI_TREND", trend);
  const priceMove = 100 * (b.close / p.close - 1), oiMove = context.oiMovePct;
  if (Number.isFinite(oiMove)) {
    if (oiMove >= 6 && priceMove >= 3) add("OI_BUILDUP", 1);
    if (oiMove >= 6 && priceMove <= -3) add("OI_BUILDUP", -1);
    if (oiMove <= -3.04 && priceMove <= -1.56) add("OI_UNWINDING_REVERSAL", 1);
    if (oiMove <= -3.04 && priceMove >= 1.56) add("OI_UNWINDING_REVERSAL", -1);
  }
  const live = scan({ symbol: b.symbol, expiry: b.expiry, tickSize: 0.05, bars, asOf: b.date, source: "NSE_FUTURES" });
  for (const c of live.candidates) add("GM_V2_" + c.setup, c.side === "BUY" ? 1 : -1, c.stopPrice);
  return [...new Map(out.map((s) => [s.family + "|" + s.side, s])).values()];
}
function exitOnBar(position, b, index) {
  const p = position, side = p.side, held = index - p.entryIndex + 1;
  if (side * (b.open - p.stop) <= 0) return { price: b.open, reason: "GAP_STOP", held };
  if (side * (b.open - p.target) >= 0) return { price: p.target, reason: "TARGET", held };
  const stop = side > 0 ? b.low <= p.stop : b.high >= p.stop;
  const target = side > 0 ? b.high >= p.target : b.low <= p.target;
  if (stop) return { price: p.stop, reason: target ? "AMBIGUOUS_STOP_FIRST" : "STOP", held };
  if (target) return { price: p.target, reason: "TARGET", held };
  if (b.date === p.expiry || held >= SPEC.maxHoldingSessions) return { price: b.close, reason: b.date === p.expiry ? "EXPIRY" : "TIME", held };
  return null;
}
function newAccumulator() { return { attempts: 0, closed: 0, censored: 0, gross: 0, positive: 0, negative: 0, worst: null, reasons: {}, speed: { 1: 0, 2: 0, 5: 0, 10: 0, 20: 0 }, targetDays: [], months: {}, periods: { earlier: { n: 0, sum: 0 }, recent: { n: 0, sum: 0 } } }; }
function account(a, p, exit) {
  a.closed++; const gross = 100 * p.side * (exit.price / p.entry - 1), net = gross - SPEC.costPct;
  a.gross += gross; if (net > 0) a.positive += net; else a.negative += net;
  a.worst = a.worst === null ? net : Math.min(a.worst, net); a.reasons[exit.reason] = (a.reasons[exit.reason] || 0) + 1;
  const m = p.entryDate.slice(0, 7); a.months[m] ||= { sum: 0, n: 0 }; a.months[m].sum += net; a.months[m].n++;
  const period = a.periods[p.entryDate < "2024-01-01" ? "earlier" : "recent"]; period.n++; period.sum += net;
  if (exit.reason === "TARGET") { a.targetDays.push(exit.held); for (const n of [1, 2, 5, 10, 20]) if (exit.held <= n) a.speed[n]++; }
}
function seriesStats(a) {
  const n = a.length; if (n < 2) return { mean: n ? a[0] : null, t: null, sharpe: null, skew: null, kurtosis: null };
  const m = mean(a), residual = a.map((v) => v - m); let longVar = mean(residual.map((v) => v * v));
  for (let lag = 1; lag <= Math.min(3, n - 1); lag++) {
    let cov = 0; for (let i = lag; i < n; i++) cov += residual[i] * residual[i - lag];
    longVar += 2 * (1 - lag / 4) * cov / n;
  }
  const sigma = sd(a), moment2 = mean(residual.map((v) => v * v));
  return { mean: m, t: longVar > 0 ? m / Math.sqrt(longVar / n) : null, sharpe: sigma > 0 ? m / sigma : null,
    skew: moment2 > 0 ? mean(residual.map((v) => v ** 3)) / moment2 ** 1.5 : 0,
    kurtosis: moment2 > 0 ? mean(residual.map((v) => v ** 4)) / moment2 ** 2 : 3 };
}
function summarize(books) {
  const rows = Object.entries(books).map(([member, a]) => {
    const monthly = Object.entries(a.months).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v.sum / v.n), stats = seriesStats(monthly);
    return { member, attempts: a.attempts, closed: a.closed, censored: a.censored, reasons: a.reasons,
      grossMeanPct: a.closed ? a.gross / a.closed : null, meanNetAssumedPct: a.closed ? a.gross / a.closed - SPEC.costPct : null,
      meanStressAssumedPct: a.closed ? a.gross / a.closed - SPEC.stressCostPct : null,
      profitFactorAssumed: a.negative < 0 ? a.positive / -a.negative : null, worstNetAssumedPct: a.worst,
      targetWithinPct: Object.fromEntries(Object.entries(a.speed).map(([k, n]) => [k, a.attempts ? 100 * n / a.attempts : null])),
      medianSessionsToTargetConditional: median(a.targetDays), months: monthly.length, stats,
      earlierNetAssumedPct: a.periods.earlier.n ? a.periods.earlier.sum / a.periods.earlier.n : null,
      recentNetAssumedPct: a.periods.recent.n ? a.periods.recent.sum / a.periods.recent.n : null,
      p: stats.t === null ? 1 : 1 - normalCdf(stats.t), holm: false, dsr: null, verdict: "EXPLORATORY_INSUFFICIENT_EVIDENCE" };
  });
  // A1: tiny two/four-trade pattern samples cannot estimate the dispersion of
  // Sharpe ratios used to deflate adequately sampled strategies.
  const trials = rows.length, scores = rows.filter((r) => r.closed >= 100 && r.months >= 24 && r.stats.sharpe !== null).map((r) => r.stats.sharpe);
  const s = sd(scores), N = 317 + trials;
  const reference = s === null ? null : s * ((1 - 0.5772156649) * normalQuantile(1 - 1 / N) + 0.5772156649 * normalQuantile(1 - 1 / (N * Math.E)));
  let ok = true;
  for (const [i, r] of [...rows].sort((a, b) => a.p - b.p).entries()) { r.holm = ok && r.p <= 0.05 / (trials - i); if (!r.holm) ok = false; }
  for (const r of rows) {
    const { sharpe: sr, skew, kurtosis } = r.stats;
    const variance = sr === null ? null : 1 - skew * sr + (kurtosis - 1) / 4 * sr * sr;
    if (reference !== null && variance > 0 && r.months >= 24 && r.closed >= 100) r.dsr = normalCdf((sr - reference) * Math.sqrt(r.months - 1) / Math.sqrt(variance));
    if (r.closed >= 100 && r.months >= 24 && r.meanStressAssumedPct > 0 && r.earlierNetAssumedPct > 0 && r.recentNetAssumedPct > 0 && r.stats.t >= 3 && r.holm && r.dsr >= 0.95 && r.censored / Math.max(1, r.attempts) < 0.01) r.verdict = "EXPLORATORY_PROMISING_NOT_VALIDATED";
  }
  return rows.sort((a, b) => (b.stats.t ?? -Infinity) - (a.stats.t ?? -Infinity));
}
function validRow(r, date) { return Array.isArray(r) && r[1] === "STK" && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[2]) && r[2] >= date && [3, 4, 5, 6, 10].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] > 0) && r[4] >= Math.max(r[3], r[6]) && r[5] <= Math.min(r[3], r[6]); }
function runFiles(files, readDay, { progress = () => {} } = {}) {
  const books = Object.fromEntries(FAMILIES.flatMap((f) => ["BUY", "SELL"].map((s) => [f + "|" + s, newAccumulator()])));
  const histories = new Map(), positions = new Map(); let pending = [], lastOi = new Map();
  const coverage = { sessions: files.length, invalidRows: 0, gaps: 0, eligibleContractDays: 0, pendingMissing: 0, structuralRiskSkipped: 0 };
  for (const [index, file] of files.entries()) {
    const date = file.slice(0, 10), raw = readDay(file), rows = new Map(), oi = new Map();
    for (const r of raw) {
      if (r[1] === "STK" && Number.isFinite(r[8]) && r[8] >= 0) oi.set(r[0], (oi.get(r[0]) || 0) + r[8]);
      if (!validRow(r, date)) { if (r[1] === "STK") coverage.invalidRows++; continue; }
      const b = { symbol: r[0], expiry: r[2], date, open: r[3], high: r[4], low: r[5], close: r[6], volume: r[10] };
      rows.set(`${b.symbol}|${b.expiry}`, b);
    }
    for (const intent of pending) {
      const key = intent.family + "|" + (intent.side > 0 ? "BUY" : "SELL"), positionKey = key + "|" + intent.symbol;
      if (positions.has(positionKey)) continue;
      const b = rows.get(intent.symbol + "|" + intent.expiry);
      if (!b) { coverage.pendingMissing++; continue; }
      const stop = intent.stopPrice ?? b.open * (1 - intent.side * SPEC.fixedStopPct / 100), risk = intent.side * (b.open - stop) / b.open * 100;
      if (!(stop > 0 && risk > 0 && risk <= SPEC.fixedStopPct + 1e-8)) { coverage.structuralRiskSkipped++; continue; }
      if (intent.family.startsWith("GM_V2_") && Math.abs(b.open - intent.signalClose) > 0.5 * intent.atr14) { coverage.structuralRiskSkipped++; continue; }
      positions.set(positionKey, { ...intent, key, entry: b.open, entryDate: date, entryIndex: index, stop, target: b.open * (1 + intent.side * SPEC.targetPct / 100) });
      books[key].attempts++;
    }
    for (const [key, p] of positions) {
      const b = rows.get(p.symbol + "|" + p.expiry), a = books[p.key];
      if (!b) { a.censored++; positions.delete(key); continue; }
      const exit = exitOnBar(p, b, index);
      if (exit) { account(a, p, exit); positions.delete(key); }
    }
    for (const [key, history] of histories) if (history.expiry < date) histories.delete(key);
    for (const [key, b] of rows) {
      let h = histories.get(key);
      if (!h || h.lastIndex !== index - 1) { if (h) coverage.gaps++; h = { bars: [], expiry: b.expiry }; histories.set(key, h); }
      h.bars.push(b); if (h.bars.length > SPEC.historyWindow) h.bars.shift(); h.lastIndex = index;
    }
    const nearest = new Map();
    for (const b of rows.values()) if (b.expiry > date && (!nearest.has(b.symbol) || b.expiry < nearest.get(b.symbol).expiry)) nearest.set(b.symbol, b);
    pending = [];
    for (const b of nearest.values()) {
      const h = histories.get(b.symbol + "|" + b.expiry), bars = h.bars;
      if (bars.length < SPEC.minHistory || median(bars.slice(-20).map((v) => v.volume)) < SPEC.minMedianContracts20) continue;
      coverage.eligibleContractDays++;
      const oldOi = lastOi.get(b.symbol), oiMovePct = oldOi > 0 && oi.has(b.symbol) ? 100 * (oi.get(b.symbol) / oldOi - 1) : null;
      const atr14 = indicators(bars).atr14;
      for (const sig of signals(bars, { oiMovePct })) pending.push({ ...sig, symbol: b.symbol, expiry: b.expiry, signalClose: b.close, atr14 });
    }
    lastOi = oi;
    if (index % 200 === 0) progress({ sessionsProcessed: index + 1, totalSessions: files.length });
  }
  for (const p of positions.values()) books[p.key].censored++;
  return { coverage, rows: summarize(books) };
}
function lockHash() {
  const list = ["PROTOCOL.json", "study.js"], h = crypto.createHash("sha256");
  for (const name of list) h.update(name).update("\0").update(fs.readFileSync(path.join(__dirname, name))).update("\0");
  for (const name of ["config/gm-weekly-research.json", "api/_lib/gm-technical-research.js", "api/_lib/chart-patterns.js", "api/_lib/candlestick-engine.js"]) h.update(name).update("\0").update(fs.readFileSync(path.join(ROOT, name))).update("\0");
  return h.digest("hex");
}
function main(args) {
  if (args.includes("--lock")) { fs.writeFileSync(path.join(__dirname, "LOCK.sha256"), lockHash() + "\n"); console.log("Exploratory rules and implementation locked locally; no preregistration commit claimed."); return; }
  if (!args.includes("--exploratory")) throw new Error("Use --lock before --exploratory. This is not a registered validation.");
  const lock = fs.readFileSync(path.join(__dirname, "LOCK.sha256"), "utf8").trim(); if (lock !== lockHash()) throw new Error("Study rules or code changed after lock; do not run.");
  const dir = process.env.K2_GM_STUDY_FUT_DIR || path.join(ROOT, "research/orderflow-2026-10-03/nse-fo/fut");
  let files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) throw new Error("No futures archive available.");
  const cmDir = path.join(ROOT, "research/rising-stocks-2026-10-02/nse-data/cm");
  if (fs.existsSync(cmDir)) {
    const first = files[0], last = files.at(-1);
    files = [...new Set([...files, ...fs.readdirSync(cmDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f >= first && f <= last)])].sort();
  }
  const results = runFiles(files, (file) => fs.existsSync(path.join(dir, file)) ? JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) : [], { progress: (v) => console.log(JSON.stringify(v)) });
  const report = { status: SPEC.status, preregistered: false, codeLockSha256: lock, builtAt: new Date().toISOString(), firstSession: files[0].slice(0, 10), lastSession: files.at(-1).slice(0, 10), spec: SPEC, ...results };
  const out = path.join(ROOT, ".private/gm-target-speed"); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, coverage: results.coverage, comparisons: results.rows.length, promising: results.rows.filter((r) => r.verdict === "EXPLORATORY_PROMISING_NOT_VALIDATED").length, report: ".private/gm-target-speed/result.json" }));
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { SPEC, signals, exitOnBar, runFiles, summarize, seriesStats, lockHash };
