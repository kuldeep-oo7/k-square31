"use strict";

const { plan, createGmWeeklyGoal, CALENDAR } = require("./gm-weekly-goal");
const { bindEntry, nextSession, RULE } = require("./gm-technical-research");
const { parseExchangeClock } = require("./live-quotes");

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const dateAt = (n) => new Date(n + 330 * 60000).toISOString().slice(0, 10);
const keyOf = (c) => `${c.signalDate}|${c.symbol}|${c.expiry}|${c.setup}|${c.side}`;
function freshQuote(q, now) {
  const clock = parseExchangeClock(q?.exchangeFeedTime);
  return finite(clock) && now - clock >= -30000 && now - clock <= 120000 && dateAt(clock) === dateAt(now);
}
// The session's first fresh quote decides the paper entry, as close to the tested next-session open as a 20-minute
// build allows: if it fails the gap/risk check the plan is skipped for the day, and with no fresh quote by 09:45 IST it
// is missed. Until 28 Oct 2026 every build retried, so two shorts froze at 12:53 and 13:13 after opening outside range.
const ENTRY_CUTOFF_IST = "09:45";
const lateEntry = (p) => !!p.frozenAt && Date.parse(p.frozenAt) > Date.parse(`${p.entryDate}T${ENTRY_CUTOFF_IST}:00+05:30`);

// Paper exit of a frozen entry, conservative as in studies/gm-target-speed-2026-10-27: a session that opens through the
// stop or target fills at that open, and a stop and target touched in one session count as the stop. On the entry day
// only prices after the freeze count -- the sampled last price, a session high/low set after the freeze and, once the
// day is over, the official close -- never the day's high/low, which may come before the entry.
function track(position, { quote: q, bars, barsAsOf, now, today, marketOpen }) {
  let p = position;
  const sell = p.side === "SELL";
  const through = (hi, lo, open) => {
    const stop = (x) => sell ? x >= p.stopPrice : x <= p.stopPrice, target = (x) => sell ? x <= p.targetPrice : x >= p.targetPrice;
    if (finite(open) && stop(open)) return ["STOP", open];
    if (finite(open) && target(open)) return ["TARGET", open];
    if (stop(sell ? hi : lo)) return ["STOP", p.stopPrice];
    if (target(sell ? lo : hi)) return ["TARGET", p.targetPrice];
    return null;
  };
  const exit = (reason, price, date) => {
    const move = sell ? p.entryPrice - price : price - p.entryPrice;
    return { position: { ...p, exit: { reason, price, date, at: new Date(now).toISOString(),
      pnlInr: Math.round(move * p.quantity * 100) / 100, pnlPct: move / p.entryPrice * 100 } }, unchecked: false };
  };
  for (const b of Array.isArray(bars) ? bars : []) {
    if (b.date < p.entryDate || b.date <= (p.checkedThrough || "") || b.date > today || (b.date === today && marketOpen)) continue;
    const hit = b.date === p.entryDate ? through(b.close, b.close, null) : through(b.high, b.low, b.open);
    if (hit) return exit(hit[0], hit[1], b.date);
    p = { ...p, checkedThrough: b.date };
    if (b.date >= p.deadline) return exit(b.date >= p.expiry ? "EXPIRY" : "TIME", b.close, b.date);
  }
  if (marketOpen && today >= p.entryDate && freshQuote(q, now) && finite(q.price) && q.price > 0) {
    const entryDay = today === p.entryDate;
    const newHigh = finite(q.high) && (!entryDay || (finite(p.entryHigh) && q.high > p.entryHigh)) ? q.high : q.price;
    const newLow = finite(q.low) && (!entryDay || (finite(p.entryLow) && q.low < p.entryLow)) ? q.low : q.price;
    const hit = through(Math.max(q.price, newHigh), Math.min(q.price, newLow), entryDay ? null : q.open);
    if (hit) return exit(hit[0], hit[1], today);
  }
  return { position: p, unchecked: !!barsAsOf && barsAsOf >= p.entryDate && (p.checkedThrough || "") < barsAsOf };
}
function project({ report, state = {}, quotes = {}, bars = {}, barsAsOf = null, now = Date.now(), marketOpen = false } = {}) {
  const today = dateAt(now), positions = { ...(state.positions || {}) }, decided = state.skipped || {}, skipped = {}, rows = [];
  const candidates = report?.candidates || [];
  const expected = report?.asOf ? nextSession(report.asOf) : null;
  const usable = !!report && !!expected && (expected >= today) && report.mode === "PAPER_RESEARCH_ONLY";
  for (const [key, position] of Object.entries(positions)) {
    const contract = `${position.symbol}|${position.expiry}`;
    const { position: p, unchecked } = position.exit ? { position, unchecked: false }
      : track(position, { quote: quotes[contract], bars: bars[contract], barsAsOf, now, today, marketOpen });
    positions[key] = p;
    // An exit stays on the screen through the next session, so the morning after shows what happened.
    if (p.exit ? (nextSession(p.exit.date) || p.exit.date) < today : p.deadline < today) continue;
    rows.push({ ...p, status: p.exit ? `EXIT_${p.exit.reason}` : "PAPER_ENTRY_FROZEN", unchecked, last: null, quoteAt: null });
  }
  if (usable) for (const c of candidates) {
    const key = keyOf(c); if (positions[key]) continue;
    const entryDate = nextSession(c.signalDate);
    if (!entryDate || c.expiry < entryDate || entryDate < today) continue;
    let row;
    try {
      const preview = plan({ entryPrice: c.signalClose, side: c.side, quantity: RULE.quantity,
        tickSize: c.tickSize, entryDate, expiry: c.expiry, maxHoldingSessions: RULE.maxHoldingSessions ?? null });
      row = { ...preview, symbol: c.symbol, setup: c.setup, signalDate: c.signalDate,
        stopPrice: c.stopPrice, status: "PREVIEW", last: null, quoteAt: null };
    } catch { continue; }
    if (decided[key]) {
      skipped[key] = decided[key];
      rows.push({ ...row, status: decided[key].status, skipPrice: decided[key].price ?? null }); continue;
    }
    if (entryDate === today && now > Date.parse(`${today}T15:30:00+05:30`)) row.status = "ENTRY_WINDOW_CLOSED";
    if (entryDate === today && marketOpen) {
      const q = quotes[`${c.symbol}|${c.expiry}`];
      const bid = q?.bid, ask = q?.ask;
      if (now > Date.parse(`${today}T${ENTRY_CUTOFF_IST}:00+05:30`)) {
        skipped[key] = { status: "MISSED_NO_OPENING_QUOTE", at: new Date(now).toISOString() }; row.status = skipped[key].status;
      } else if (freshQuote(q, now) && finite(bid) && finite(ask) && bid > 0 && ask >= bid) {
        const entryPrice = c.side === "BUY" ? ask : bid;
        try {
          const p = bindEntry(c, { entryPrice, entryDate, quantity: RULE.quantity });
          const position = { ...p, signalDate: c.signalDate, frozenAt: new Date(now).toISOString(),
            entrySource: c.side === "BUY" ? "FIRST_OBSERVED_ASK" : "FIRST_OBSERVED_BID",
            entryHigh: finite(q.high) ? q.high : null, entryLow: finite(q.low) ? q.low : null };
          positions[key] = position; row = { ...position, status: "PAPER_ENTRY_FROZEN", last: null, quoteAt: null };
        } catch {
          skipped[key] = { status: "SKIP_ENTRY_GAP_OR_RISK", at: new Date(now).toISOString(), price: entryPrice };
          row.status = skipped[key].status; row.skipPrice = entryPrice;
        }
      } else row.status = "WAITING_FOR_FRESH_QUOTE";
    }
    rows.push(row);
  }
  for (const row of rows) {
    const q = quotes[`${row.symbol}|${row.expiry}`];
    if (freshQuote(q, now) && finite(q.price) && q.price > 0) { row.last = q.price; row.quoteAt = q.exchangeFeedTime; }
    // No automatic paper fills from a daily high/low: the daily extreme may
    // have occurred before the first observed bid/ask entry.
  }
  return { state: { positions, skipped }, view: { version: 1, builtAt: new Date(now).toISOString(), date: today,
    signalDate: report?.asOf ?? null, entrySession: expected, mode: "PAPER_RESEARCH_ONLY",
    status: !usable || report.status === "DATA_UNAVAILABLE" ? "DATA_UNAVAILABLE" : rows.length ? "PAPER_RESEARCH" : "NO_SETUP",
    partial: report?.partial === true, examined: report?.examined ?? 0, rows,
    dataReason: !report ? "SCAN_NOT_RUN" : !usable ? "MISSING_OR_STALE_SIGNAL_REPORT" : Object.keys(report.rejected || {}).filter((r) => /NETWORK|SESSION|MASTER/.test(r)).join(", ") || null } };
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (s) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
const price = (n) => finite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
function render(view, sessionDate) {
  const current = view?.date === sessionDate;
  const rows = current ? view.rows || [] : [];
  const label = { PREVIEW: "PREVIEW · entry not recorded", WAITING_FOR_FRESH_QUOTE: "WAIT · fresh quote needed",
    SKIP_ENTRY_GAP_OR_RISK: "SKIP · first live price outside the plan's range", PAPER_ENTRY_FROZEN: "PAPER ENTRY · fixed",
    ENTRY_WINDOW_CLOSED: "MISSED · entry session has closed", MISSED_NO_OPENING_QUOTE: `MISSED · no live price by ${ENTRY_CUTOFF_IST}` };
  const rupees = (n) => `${n < 0 ? "−" : "+"}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
  const status = (r) => {
    if (r.exit) {
      const name = { STOP: "STOP HIT", TARGET: "TARGET HIT", TIME: "TIME LIMIT", EXPIRY: "EXPIRY" }[r.exit.reason] || r.exit.reason;
      return [`${name} ${r.exit.date} · ${r.side === "BUY" ? "sold" : "bought back"} ₹${price(r.exit.price)} · ${rupees(r.exit.pnlInr)} (${r.exit.pnlPct < 0 ? "−" : "+"}${Math.abs(r.exit.pnlPct).toFixed(2)}%)`,
        r.exit.pnlInr < 0 ? "down" : "up"];
    }
    let text = label[r.status] || r.status;
    if (finite(r.skipPrice)) text += ` (₹${price(r.skipPrice)})`;
    if (r.status === "PAPER_ENTRY_FROZEN" && lateEntry(r)) text += ` · late ${new Date(Date.parse(r.frozenAt) + 330 * 60000).toISOString().slice(11, 16)}, old rule`;
    if (r.unchecked) text += " · exit check waiting for the daily bar";
    return [text, /^(SKIP|MISSED)/.test(r.status) ? "down" : "warn"];
  };
  const cards = rows.map((r, i) => {
    const frozen = r.status === "PAPER_ENTRY_FROZEN" || !!r.exit, long = r.side === "BUY", [statusText, statusClass] = status(r);
    const data = { entryPrice: r.entryPrice, entryDate: r.entryDate, side: r.side, expiry: r.expiry,
      tickSize: r.tickSize, quantity: r.quantity, stopPrice: r.stopPrice, maxHoldingSessions: r.maxHoldingSessions ?? null };
    return `<article class="gm-card" data-gm-plan="${esc(JSON.stringify(data))}">
      <div class="gm-card-head"><b>${esc(r.symbol)}</b><b class="${long ? "up" : "down"}">${long ? "BUY / LONG" : "SELL / SHORT"}</b></div>
      <div class="sub">${esc(r.expiry)} futures · ${esc(r.setup.replace(/_/g, " "))}</div>
      <div class="gm-status ${statusClass}">${esc(statusText)}</div>
      <dl class="gm-prices"><div><dt>${frozen ? "Paper entry" : "Entry reference"}</dt><dd>₹${price(r.entryPrice)}</dd></div>
      <div><dt>Stop-loss${long ? " · sell" : " · buy back"}</dt><dd class="down">₹${price(r.stopPrice)}</dd></div>
      <div><dt>${long ? "Sell target" : "Buy-back target"} · 3%</dt><dd class="up gm-target">₹${price(r.targetPrice)}</dd></div></dl>
      <div class="sub">${esc(r.quantity)} units · entry ${esc(r.entryDate)} · review/exit by ${esc(r.deadline)}${finite(r.last) ? ` · last ₹${price(r.last)}` : ""}</div>
      ${r.exit ? "" : `<details class="fold"><summary class="sub">Use my GM fill price<span class="more"></span></summary><div class="gm-fill-row">
      <label for="gm-fill-${i}">My entry ₹</label><input id="gm-fill-${i}" class="gm-fill" type="number" min="0.01" step="any" inputmode="decimal" value="${esc(r.entryPrice)}">
      <output class="gm-fill-result" aria-live="polite">Enter your fill to recalculate the target.</output></div></details>`}
      <div class="sub lec">${frozen ? `Entry: ${esc(r.entrySource)} at ${esc(r.frozenAt)}. These are paper levels, not a recorded GM fill.` : "The reference uses the completed signal candle. The first fresh next-session bid/ask must pass the entry gap and risk checks before paper levels freeze."}
      Your fill changes the target on this screen only. Stops and fills can gap. Prices and targets are before unknown GM charges.</div></article>`;
  }).join("");
  const empty = !current || view?.status === "DATA_UNAVAILABLE" ? "Waiting for fresh futures data. No entry prices issued."
    : "No verified setup available: filters or data checks did not pass.";
  return `<div class="note focus" id="gm-weekly-panel" style="margin:0 0 14px;border-left-color:var(--amber)">
    <b>GM · 3% TRADE PLAN</b> · <b class="warn">UNVALIDATED PAPER RESEARCH</b>
    <div class="sub">Entry on the first live price, by ${ENTRY_CUTOFF_IST} · exit at target or stop, including the same day · maximum ${RULE.maxHoldingSessions || 20} sessions, capped by expiry</div>
    <div class="sub">${current && view.signalDate ? `Signal ${esc(view.signalDate)} · next entry ${esc(view.entrySession)} · ${esc(view.examined)} contracts checked${view.partial ? " · scan incomplete" : ""}` : "Fresh signal scan pending"}</div>
    ${current && view.status === "DATA_UNAVAILABLE" && cards ? `<div class="sub warn">Fresh scan unavailable; showing previously frozen paper levels only.</div>` : ""}
    ${cards ? `<div class="gm-cards">${cards}</div>` : `<div class="sub warn" style="margin-top:8px">${empty}</div>`}
    <div class="sub lec">3% is a target from entry. No weekly deadline or minimum holding time. This v2 research has not established a profitable edge. Existing registered tests retain their original rules.</div>
    <style>#gm-weekly-panel .gm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:12px;margin-top:12px}#gm-weekly-panel .gm-card{border:1px solid var(--line,#42454b);border-radius:8px;padding:12px;min-width:0}#gm-weekly-panel .gm-card-head{display:flex;justify-content:space-between;gap:8px}#gm-weekly-panel .gm-status{font-size:12px;margin:8px 0}#gm-weekly-panel .gm-prices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:10px 0}#gm-weekly-panel dt{font-size:11px;color:var(--muted)}#gm-weekly-panel dd{font-size:17px;font-weight:700;margin:4px 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}#gm-weekly-panel .gm-fill-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0}#gm-weekly-panel input{width:120px;padding:8px;background:var(--bg,#15171a);color:inherit;border:1px solid var(--muted);border-radius:4px}#gm-weekly-panel output{width:100%;font-size:13px}</style>
    <script>(function(){var goal=(${createGmWeeklyGoal.toString()})(${JSON.stringify(CALENDAR)});document.querySelectorAll('#gm-weekly-panel .gm-card').forEach(function(card){var input=card.querySelector('.gm-fill'),out=card.querySelector('output'),p=JSON.parse(card.getAttribute('data-gm-plan'));input.addEventListener('input',function(){try{if(!input.value.trim())throw Error('Enter your actual fill.');var n=Number(input.value),sign=p.side==='BUY'?1:-1,risk=sign*(n-p.stopPrice)/n*100;if(!(risk>0&&risk<=${RULE.maxStopPct}))throw Error('Fill outside the planned stop/risk limit.');var g=goal.plan(Object.assign({},p,{entryPrice:n}));out.textContent=(p.side==='BUY'?'Sell target':'Buy-back target')+' ₹'+g.targetPrice.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})+' · stop ₹'+p.stopPrice.toLocaleString('en-IN')+' · before GM costs';out.className='gm-fill-result up';}catch(e){out.textContent=e.message;out.className='gm-fill-result down';}});});})();</script>
  </div>`;
}
module.exports = { project, render, freshQuote };
