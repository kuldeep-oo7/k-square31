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
function project({ report, state = {}, quotes = {}, now = Date.now(), marketOpen = false } = {}) {
  const today = dateAt(now), positions = { ...(state.positions || {}) }, rows = [];
  const candidates = report?.candidates || [];
  const expected = report?.asOf ? nextSession(report.asOf) : null;
  const usable = !!report && !!expected && (expected >= today) && report.mode === "PAPER_RESEARCH_ONLY";
  for (const [key, position] of Object.entries(positions)) {
    if (position.deadline < today) continue;
    rows.push({ ...position, status: "PAPER_ENTRY_FROZEN", last: null, quoteAt: null });
  }
  if (usable) for (const c of candidates) {
    const key = keyOf(c); if (positions[key]) continue;
    const entryDate = nextSession(c.signalDate);
    if (!entryDate || c.expiry < entryDate || entryDate < today) continue;
    let row;
    try {
      const preview = plan({ entryPrice: c.signalClose, side: c.side, quantity: RULE.quantity,
        tickSize: c.tickSize, entryDate, expiry: c.expiry });
      row = { ...preview, symbol: c.symbol, setup: c.setup, signalDate: c.signalDate,
        stopPrice: c.stopPrice, status: "PREVIEW", last: null, quoteAt: null };
    } catch { continue; }
    if (entryDate === today && now > Date.parse(`${today}T15:30:00+05:30`)) row.status = "ENTRY_WINDOW_CLOSED";
    if (entryDate === today && marketOpen) {
      const q = quotes[`${c.symbol}|${c.expiry}`];
      const bid = q?.bid, ask = q?.ask;
      if (freshQuote(q, now) && finite(bid) && finite(ask) && bid > 0 && ask >= bid) {
        try {
          const p = bindEntry(c, { entryPrice: c.side === "BUY" ? ask : bid, entryDate, quantity: RULE.quantity });
          const position = { ...p, signalDate: c.signalDate, frozenAt: new Date(now).toISOString(),
            entrySource: c.side === "BUY" ? "FIRST_OBSERVED_ASK" : "FIRST_OBSERVED_BID" };
          positions[key] = position; row = { ...position, status: "PAPER_ENTRY_FROZEN", last: null, quoteAt: null };
        } catch { row.status = "SKIP_ENTRY_GAP_OR_RISK"; }
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
  return { state: { positions }, view: { version: 1, builtAt: new Date(now).toISOString(), date: today,
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
    SKIP_ENTRY_GAP_OR_RISK: "SKIP · entry outside risk limit", PAPER_ENTRY_FROZEN: "PAPER ENTRY · fixed", ENTRY_WINDOW_CLOSED: "MISSED · entry session has closed" };
  const cards = rows.map((r, i) => {
    const frozen = r.status === "PAPER_ENTRY_FROZEN", long = r.side === "BUY";
    const data = { entryPrice: r.entryPrice, entryDate: r.entryDate, side: r.side, expiry: r.expiry,
      tickSize: r.tickSize, quantity: r.quantity, stopPrice: r.stopPrice };
    return `<article class="gm-card" data-gm-plan="${esc(JSON.stringify(data))}">
      <div class="gm-card-head"><b>${esc(r.symbol)}</b><b class="${long ? "up" : "down"}">${long ? "BUY / LONG" : "SELL / SHORT"}</b></div>
      <div class="sub">${esc(r.expiry)} futures · ${esc(r.setup.replace(/_/g, " "))}</div>
      <div class="gm-status ${r.status.startsWith("SKIP") ? "down" : "warn"}">${esc(label[r.status] || r.status)}</div>
      <dl class="gm-prices"><div><dt>${frozen ? "Paper entry" : "Entry reference"}</dt><dd>₹${price(r.entryPrice)}</dd></div>
      <div><dt>Stop-loss${long ? " · sell" : " · buy back"}</dt><dd class="down">₹${price(r.stopPrice)}</dd></div>
      <div><dt>${long ? "Sell target" : "Buy-back target"} · 3%</dt><dd class="up gm-target">₹${price(r.targetPrice)}</dd></div></dl>
      <div class="sub">${esc(r.quantity)} units · entry ${esc(r.entryDate)} · review/exit by ${esc(r.deadline)}${finite(r.last) ? ` · last ₹${price(r.last)}` : ""}</div>
      <details class="fold"><summary class="sub">Use my GM fill price<span class="more"></span></summary><div class="gm-fill-row">
      <label for="gm-fill-${i}">My entry ₹</label><input id="gm-fill-${i}" class="gm-fill" type="number" min="0.01" step="any" inputmode="decimal" value="${esc(r.entryPrice)}">
      <output class="gm-fill-result" aria-live="polite">Enter your fill to recalculate the target.</output></div></details>
      <div class="sub lec">${frozen ? `Entry: ${esc(r.entrySource)} at ${esc(r.frozenAt)}. These are paper levels, not a recorded GM fill.` : "The reference uses the completed signal candle. The first fresh next-session bid/ask must pass the entry gap and risk checks before paper levels freeze."}
      Your fill changes the target on this screen only. Stops and fills can gap. Prices and targets are before unknown GM charges.</div></article>`;
  }).join("");
  const empty = !current || view?.status === "DATA_UNAVAILABLE" ? "Waiting for fresh futures data. No entry prices issued."
    : "No verified setup available: filters or data checks did not pass.";
  return `<div class="note focus" id="gm-weekly-panel" style="margin:0 0 14px;border-left-color:var(--amber)">
    <b>GM · 3% WEEKLY PLAN</b> · <b class="warn">UNVALIDATED PAPER RESEARCH</b>
    <div class="sub">${current && view.signalDate ? `Signal ${esc(view.signalDate)} · next entry ${esc(view.entrySession)} · ${esc(view.examined)} contracts checked${view.partial ? " · scan incomplete" : ""}` : "Fresh signal scan pending"}</div>
    ${current && view.status === "DATA_UNAVAILABLE" && cards ? `<div class="sub warn">Fresh scan unavailable; showing previously frozen paper levels only.</div>` : ""}
    ${cards ? `<div class="gm-cards">${cards}</div>` : `<div class="sub warn" style="margin-top:8px">${empty}</div>`}
    <div class="sub lec">3% is a target from entry, not a promised weekly return. New paper research requested for the GM friends competition. Existing registered tests retain their original rules.</div>
    <style>#gm-weekly-panel .gm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:12px;margin-top:12px}#gm-weekly-panel .gm-card{border:1px solid var(--line,#42454b);border-radius:8px;padding:12px;min-width:0}#gm-weekly-panel .gm-card-head{display:flex;justify-content:space-between;gap:8px}#gm-weekly-panel .gm-status{font-size:12px;margin:8px 0}#gm-weekly-panel .gm-prices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:10px 0}#gm-weekly-panel dt{font-size:11px;color:var(--muted)}#gm-weekly-panel dd{font-size:17px;font-weight:700;margin:4px 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}#gm-weekly-panel .gm-fill-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0}#gm-weekly-panel input{width:120px;padding:8px;background:var(--bg,#15171a);color:inherit;border:1px solid var(--muted);border-radius:4px}#gm-weekly-panel output{width:100%;font-size:13px}</style>
    <script>(function(){var goal=(${createGmWeeklyGoal.toString()})(${JSON.stringify(CALENDAR)});document.querySelectorAll('#gm-weekly-panel .gm-card').forEach(function(card){var input=card.querySelector('.gm-fill'),out=card.querySelector('output'),p=JSON.parse(card.getAttribute('data-gm-plan'));input.addEventListener('input',function(){try{if(!input.value.trim())throw Error('Enter your actual fill.');var n=Number(input.value),sign=p.side==='BUY'?1:-1,risk=sign*(n-p.stopPrice)/n*100;if(!(risk>0&&risk<=${RULE.maxStopPct}))throw Error('Fill outside the planned stop/risk limit.');var g=goal.plan(Object.assign({},p,{entryPrice:n}));out.textContent=(p.side==='BUY'?'Sell target':'Buy-back target')+' ₹'+g.targetPrice.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})+' · stop ₹'+p.stopPrice.toLocaleString('en-IN')+' · before GM costs';out.className='gm-fill-result up';}catch(e){out.textContent=e.message;out.className='gm-fill-result down';}});});})();</script>
  </div>`;
}
module.exports = { project, render, freshQuote };
