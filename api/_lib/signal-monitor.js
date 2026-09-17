"use strict";
const crypto = require("node:crypto");
const { sessionDate } = require("./indian-instruments");
const { planIsCurrent } = require("../../scripts/plan-is-current");
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const stamp = (v) => typeof v === "number" ? v : typeof v === "string" && v.trim() ? Date.parse(v) : NaN;

// Event-driven observation engine; every emitted item is a research alert, NOT
// an executable recommendation. Confidence never defaults to a probability.
class SignalMonitor {
  constructor({ instruments = [], plan = {}, maxQuoteAgeMs = 5000, maxGapMs = 10000, cooldownMs = 300000, clock = Date.now, restored = null } = {}) {
    if (![maxQuoteAgeMs, maxGapMs, cooldownMs].every((x) => finite(x) && x > 0)) throw new Error("Monitor limits must be finite and positive");
    this.instruments = new Map(instruments.map((i) => [i.key, i]));
    this.plan = plan; this.maxQuoteAgeMs = maxQuoteAgeMs; this.maxGapMs = maxGapMs; this.cooldownMs = cooldownMs; this.clock = clock;
    this.last = new Map(); this.cooldowns = new Map(); this.alerts = []; this.processed = 0; this.rejected = {}; this.lastAcceptedAt = null;
    if (restored?.schemaVersion === "signal-monitor-v1") {
      this.alerts = (restored.alerts || []).slice(-200);
      this.cooldowns = new Map((restored.cooldowns || []).filter(([, t]) => finite(t) && t <= clock()));
    }
  }
  reject(reason) { this.rejected[reason] = (this.rejected[reason] || 0) + 1; return { accepted: false, reason, alerts: [] }; }
  consume(q) {
    const now = this.clock(), instrument = this.instruments.get(q?.instrumentKey), t = stamp(q?.eventAt);
    if (!instrument) return this.reject("UNKNOWN_INSTRUMENT");
    if (!q.provider || q.timestampKind !== "EXCHANGE" || !finite(t) || t > now + 1000 || now - t > this.maxQuoteAgeMs) return this.reject("STALE_OR_UNVERIFIED_QUOTE");
    if (!finite(q.lastPrice) || q.lastPrice <= 0) return this.reject("INVALID_PRICE");
    if (q.marketOpen !== true) return this.reject("MARKET_CLOSED_OR_SESSION_UNVERIFIED");
    if (q.session !== sessionDate(t)) return this.reject("SESSION_MISMATCH");
    if (instrument.expiry && instrument.expiry < q.session) return this.reject("EXPIRED_CONTRACT");
    const local = new Date(t + 330 * 60000), weekday = local.getUTCDay(), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (weekday === 0 || weekday === 6 || minute < 555 || minute > 930) return this.reject("OUTSIDE_NORMAL_CASH_DERIVATIVES_SESSION");
    // Special sessions require a separately verified calendar adapter, not a guess.
    const previous = this.last.get(q.instrumentKey);
    if (previous && t <= previous.eventAt) return this.reject("DUPLICATE_OR_OUT_OF_ORDER");
    const current = { eventAt: t, lastPrice: q.lastPrice, session: q.session };
    this.last.set(q.instrumentKey, current); this.lastAcceptedAt = now; this.processed += 1;
    const alerts = [];
    const emit = (kind, explanation, level, identity = kind) => {
      const key = `${q.session}:${q.instrumentKey}:${identity}`;
      if (this.cooldowns.has(key) && now - this.cooldowns.get(key) < this.cooldownMs) return;
      this.cooldowns.set(key, now);
      alerts.push({ id: crypto.createHash("sha256").update(`${key}:${t}`).digest("hex").slice(0, 24),
        status: "RESEARCH_ALERT_NOT_TRADE_INSTRUCTION", kind, instrumentKey: q.instrumentKey,
        symbol: instrument.tradingSymbol, instrumentType: instrument.type, expiry: instrument.expiry || null,
        eventAt: new Date(t).toISOString(), detectedAt: new Date(now).toISOString(), provider: q.provider,
        observedPrice: q.lastPrice, triggerLevel: level, explanation, confidenceProbability: null,
        actionable: false, requiredNextCheck: "Confirm liquidity, full strategy evidence, costs, hedge, expiry and risk before any manual trade" });
    };
    if (previous && previous.session === q.session && t - previous.eventAt <= this.maxGapMs) {
      // Prior-session levels must come from a dated, completed bar. Today's
      // evolving high/low must not be accidentally used as a previous-day level.
      const p = q.priorSession;
      if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") && p.date < q.session && p.sourceVerified === true
          && q.calendar?.verified === true && q.calendar.session === q.session && q.calendar.previousSession === p.date
          && t - Date.parse(p.date + "T00:00:00+05:30") <= 7 * 86400000
          && finite(p.availableAt) && p.availableAt < t && [p.high, p.low].every((n) => finite(n) && n > 0) && p.high >= p.low) {
        if (previous.lastPrice <= p.high && q.lastPrice > p.high) emit("PRIOR_HIGH_BREAKOUT", "Price crossed the completed prior-session high; predictive edge is unproven", p.high);
        if (previous.lastPrice >= p.low && q.lastPrice < p.low) emit("PRIOR_LOW_BREAKDOWN", "Price crossed the completed prior-session low; predictive edge is unproven", p.low);
      }
      if (planIsCurrent(this.plan, now)) {
        for (const rec of this.plan.best || []) for (const entry of rec.entries || []) {
          const intent = entry.orderIntent;
          if (entry.portfolioRisk?.admitted !== true || !intent || intent.contractSymbol !== instrument.tradingSymbol || String(intent.instrumentId) !== instrument.exchangeToken) continue;
          if (!finite(intent.entryPrice) || !["long", "short"].includes(rec.side)) continue;
          const crossed = rec.side === "long" ? previous.lastPrice > intent.entryPrice && q.lastPrice <= intent.entryPrice : previous.lastPrice < intent.entryPrice && q.lastPrice >= intent.entryPrice;
          if (crossed) emit("WEEKLY_LEVEL_REACHED", "An existing weekly research level was reached intraday; this is not proof of a fill or a new risk approval", intent.entryPrice, intent.clientOrderId || `L${entry.level}`);
        }
      }
    }
    this.alerts.push(...alerts); this.alerts = this.alerts.slice(-200);
    return { accepted: true, alerts };
  }
  status() {
    const now = this.clock();
    return { schemaVersion: "signal-monitor-v1", generatedAt: new Date(now).toISOString(),
      state: this.lastAcceptedAt === null ? "WAITING_FOR_VERIFIED_FEED" : now - this.lastAcceptedAt > this.maxQuoteAgeMs ? "FEED_STALE" : "OBSERVING_RESEARCH_ONLY",
      catalogueInstruments: this.instruments.size, observedInstruments: this.last.size, processedQuotes: this.processed,
      rejectedQuotes: { ...this.rejected }, latestVerifiedQuoteReceivedAt: this.lastAcceptedAt === null ? null : new Date(this.lastAcceptedAt).toISOString(),
      weeklyPlanCurrent: planIsCurrent(this.plan, now), realOrdersEnabled: false, certaintyClaim: false };
  }
  snapshot() { return { ...this.status(), alerts: this.alerts, cooldowns: [...this.cooldowns] }; }
}
module.exports = { SignalMonitor };
