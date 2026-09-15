"use strict";

/** Build the static K² decision-support portal. No real orders are submitted. */

const fs = require("node:fs");
const path = require("node:path");
const { sealPayload } = require("../api/_lib/portal-crypto");
const { auditPurchases } = require("../api/_lib/trade-audit");
const { fetchLiveMacroRadar, macroInputFromRadar } = require("../api/_lib/market-feed");
const { evaluateGlobalMacroShock } = require("../api/_lib/market-regime");
const { DEFAULT_CONFIG } = require("../api/_lib/weekly-cycle");
const { universe, universeMetadata } = require("../api/_lib/universe");
const { planIsCurrent } = require("./plan-is-current");
const { recommendationSectionHtml, recommendationCss, recommendationClientJs } = require("./recommendation-desk-ui");

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fixed = (value, digits = 2) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function firstIntent(item) {
  return approvedEntry(item)?.orderIntent || null;
}

function approvedEntry(item) {
  const entry = item?.entries?.find((row) => row?.portfolioRisk?.admitted === true && row.orderIntent?.executable === true
    && row.orderIntent.strategyVersion === "continuous-futures-v2"
    && [row.orderIntent.entryPrice, row.orderIntent.targetPrice, row.orderIntent.stopLossPrice].every((price) => Number.isFinite(price) && price > 0));
  // The calculator must use the exchange-tick-rounded raw contract levels.
  return entry ? { ...entry, entry: entry.orderIntent.entryPrice, target: entry.orderIntent.targetPrice, stopLoss: entry.orderIntent.stopLossPrice } : null;
}

function planRow(item) {
  const entry = approvedEntry(item) || {};
  const intent = firstIntent(item);
  const side = item?.side === "short" ? "short" : "long";
  const median = entry.holdingGuidance?.medianObservedSessions ?? entry.medianSessionsHeld;
  const ceiling = entry.holdingGuidance?.maximumRiskCeilingSessions ?? DEFAULT_CONFIG.maxHoldingSessions;
  const execution = intent?.liveExecutable
    ? "Current margin + final risk gate required"
    : intent?.executable
      ? "Shadow only"
      : "Not executable";
  return `<tr data-symbol="${escapeHtml(item.symbol)}" data-side="${side}" data-entry="${Number(entry.entry) || 0}" data-target="${Number(entry.target) || 0}" data-stop="${Number(entry.stopLoss) || 0}" data-hold="${Number(median) || 0}" data-ceiling="${Number(ceiling) || DEFAULT_CONFIG.maxHoldingSessions}" data-expected="${Number(item.expectedWeeklyPct) || 0}" data-conviction="${Number(item.convictionPct) || 0}">
    <th><span class="ticker">${escapeHtml(item.symbol)}</span> <span class="chip ${side}">${side}</span></th>
    <td>${escapeHtml(item.sector || "Unclassified")}</td>
    <td class="num">₹${fixed(entry.entry)}</td>
    <td class="num positive">₹${fixed(entry.target)}</td>
    <td class="num negative">₹${fixed(entry.stopLoss)}</td>
    <td class="num">${median ? `${fixed(median, 0)} sessions observed median` : "insufficient data"}</td>
    <td class="num">${ceiling} sessions</td>
    <td class="num">${fixed(item.expectedWeeklyPct, 3)}%</td>
    <td class="num">${fixed(item.convictionPct, 0)}</td>
    <td><span class="status ${intent?.executable ? "shadow" : "blocked"}">${escapeHtml(execution)}</span></td>
  </tr>`;
}

function guidanceCard(item) {
  const entry = approvedEntry(item) || {};
  const intent = firstIntent(item);
  const side = item?.side === "short" ? "short" : "long";
  const median = entry.holdingGuidance?.medianObservedSessions ?? entry.medianSessionsHeld;
  return `<article class="candidate-card ${side}">
    <div class="candidate-head"><div><span class="chip ${side}">${side}</span><h3>${escapeHtml(item.symbol)}</h3></div><span class="status ${intent?.executable ? "shadow" : "blocked"}">${intent?.executable ? "SHADOW CANDIDATE" : "NOT EXECUTABLE"}</span></div>
    <div class="candidate-grid">
      <div><small>Planned limit</small><b>₹${fixed(entry.entry)}</b></div>
      <div><small>Target</small><b class="positive">₹${fixed(entry.target)}</b></div>
      <div><small>Protective stop</small><b class="negative">₹${fixed(entry.stopLoss)}</b></div>
      <div><small>Observed median</small><b>${median ? `${fixed(median, 0)} sessions` : "Not established"}</b></div>
      <div><small>Risk ceiling</small><b>${DEFAULT_CONFIG.maxHoldingSessions} sessions</b></div>
      <div><small>Contract expiry</small><b>${escapeHtml(intent?.expiry || "Unverified")}</b></div>
    </div>
    <p>Friday creates no automatic exit. Monday changes only the weekly reporting reference. Target, gap-aware stop, risk ceiling, or a real expiry roll can end the position.</p>
  </article>`;
}

function researchRow(stock, futuresSymbols, candidateSymbols) {
  const symbol = String(stock?.symbol || "").toUpperCase();
  const currentFutures = futuresSymbols.has(symbol);
  const candidate = candidateSymbols.has(symbol);
  const scope = currentFutures ? "F&O snapshot; recheck before order" : candidate ? "Plan candidate; reverify contract" : "Research only";
  return `<tr data-public-symbol="${escapeHtml(symbol)}" data-research="${escapeHtml(`${symbol} ${stock?.name || ""} ${stock?.sector || ""} ${stock?.marketCapCategory || ""}`.toLowerCase())}">
    <th class="ticker">${escapeHtml(symbol)}</th>
    <td>${escapeHtml(stock?.name || "—")}</td>
    <td>${escapeHtml(stock?.sector || "—")}</td>
    <td>${escapeHtml(stock?.marketCapCategory || "—")}</td>
    <td><span class="status ${currentFutures ? "verified" : "research"}">${scope}</span></td>
  </tr>`;
}

function macroView(radar) {
  const input = macroInputFromRadar(radar);
  return { input, state: evaluateGlobalMacroShock(input), updatedAt: radar?.updatedAt || null };
}

function document_(plan, sealed, meta, macro = {}, broadUniverse = {}) {
  const currentPlan = planIsCurrent(plan, meta.nowMs || Date.now());
  const best = currentPlan && Array.isArray(plan?.best) ? plan.best.filter((item) => ["long", "short"].includes(item.side) && approvedEntry(item)).slice(0, 60) : [];
  const coverage = broadUniverse?.marketCoverage || plan?.marketCoverage || {};
  const futuresSymbols = new Set(Array.isArray(coverage.futuresSymbols) ? coverage.futuresSymbols : []);
  const directory = new Map((Array.isArray(broadUniverse?.stocks) ? broadUniverse.stocks : []).map((stock) => [stock.symbol, stock]));
  for (const symbol of futuresSymbols) if (!directory.has(symbol)) directory.set(symbol, { symbol, sector: "Unclassified", marketCapCategory: "Unclassified" });
  const broadStocks = [...directory.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const candidateSymbols = new Set(best.map((item) => item.symbol));
  const macroResult = macroView(macro);
  const macroLocked = macroResult.state.dataComplete !== true || macroResult.state.shieldActive;
  const shown = (value, prefix = "", suffix = "") => Number.isFinite(value) ? `${prefix}${fixed(value, 2)}${suffix}` : "UNAVAILABLE";
  const fnoCount = coverage.orderGeneratingStockFutures ?? plan?.universe ?? "—";
  const broadCount = broadStocks.length;
  const researchCount = futuresSymbols.size ? broadStocks.filter((stock) => !futuresSymbols.has(stock.symbol)).length : "Unverified";
  const longs = best.filter((item) => item.side === "long").length;
  const shorts = best.filter((item) => item.side === "short").length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">
<title>K² · Range Desk</title>
<style>
*{box-sizing:border-box} :root{--bg:#181923;--panel:#21222f;--panel2:#161720;--text:#f2f0ea;--muted:#aaa8b7;--line:#3a3b4b;--violet:#a38aff;--green:#61d6aa;--red:#ff917f;--amber:#f1c75b;--mono:ui-monospace,"Cascadia Mono",Consolas,monospace;--serif:Georgia,"Times New Roman",serif}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,"Segoe UI",sans-serif;line-height:1.5}.shell{max-width:1420px;margin:auto;padding:38px 24px 80px}.mast{display:flex;justify-content:space-between;align-items:end;gap:20px;flex-wrap:wrap;margin-bottom:30px}.mast h1{font:48px/1 var(--serif);margin:0}.mast h1 span{color:var(--violet)}.stamp{font:12px/1.7 var(--mono);color:var(--muted);text-align:right;text-transform:uppercase;letter-spacing:.08em}
.notice{border:1px solid var(--amber);background:#2b281d;padding:13px 16px;border-radius:12px;margin:0 0 18px;font-size:13px}.macro{background:#0e172a;border:1px solid #263755;border-radius:18px;padding:18px 22px;margin-bottom:24px}.macro-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;font:12px var(--mono)}.macro-head b{font:700 14px Inter}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${macroLocked ? "var(--red)" : "var(--green)"};margin-right:9px}.pills{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid #34445e;background:#172238;border-radius:8px;padding:7px 11px;font:12px var(--mono)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:13px;margin-bottom:38px}.tile{background:var(--panel);border:1px solid var(--line);border-radius:17px;padding:18px}.tile b{display:block;font:26px var(--mono);margin-bottom:3px}.tile span{font-size:12px;color:var(--muted)}section{margin:0 0 44px}h2{font:30px var(--serif);margin:0 0 5px}.sub{color:var(--muted);max-width:88ch;margin:0 0 17px;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}.candidate-card{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--green);border-radius:17px;padding:18px}.candidate-card.short{border-left-color:var(--red)}.candidate-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.candidate-head h3{font:22px var(--mono);margin:8px 0 12px}.candidate-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.candidate-grid div{background:var(--panel2);padding:10px;border-radius:9px}.candidate-grid small{display:block;color:var(--muted);font-size:10px;text-transform:uppercase}.candidate-grid b{font:13px var(--mono)}.candidate-card p{font-size:12px;color:var(--muted);margin:13px 0 0}
.chip,.status{display:inline-block;border-radius:999px;padding:3px 8px;font:700 10px var(--mono);text-transform:uppercase}.chip.long{background:#173d32;color:var(--green)}.chip.short{background:#4a292a;color:var(--red)}.status{border:1px solid var(--line);color:var(--muted)}.status.shadow{color:var(--amber);border-color:#66572b}.status.blocked{color:var(--red)}.status.verified{color:var(--green);border-color:#275a4b}.status.research{color:var(--muted)}
.calculator{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:22px}.calc-inputs{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field label{display:block;font:11px var(--mono);color:var(--muted);text-transform:uppercase;margin-bottom:6px}.field select,.field input,.search{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--text);padding:11px 12px;font:13px var(--mono)}.decision{margin-top:14px;padding:12px;border-radius:10px;background:var(--panel2);font:13px var(--mono)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}.metric{border-top:1px solid var(--line);padding-top:9px}.metric small{display:block;color:var(--muted)}.metric b{font:14px var(--mono)}
.tools{display:grid;grid-template-columns:auto auto 1fr;gap:9px;margin-bottom:12px}.tools button{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:8px 14px;cursor:pointer}.tools button[aria-pressed=true]{border-color:var(--violet);color:var(--violet)}.scroll{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:15px}table{width:100%;border-collapse:collapse;min-width:950px}th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;font-size:12px}thead th{font:10px var(--mono);color:var(--muted);text-transform:uppercase;white-space:nowrap}tbody th{font-weight:400}.ticker{font:700 12px var(--mono)}.num{font-family:var(--mono);white-space:nowrap}.positive{color:var(--green)}.negative{color:var(--red)}
.lock{background:var(--panel);border:1px solid var(--line);padding:18px;border-radius:14px}.lock form{display:flex;gap:8px}.lock input{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:10px;border-radius:8px}.lock button{background:var(--violet);border:0;padding:10px 18px;border-radius:8px}footer{border-top:1px solid var(--line);color:var(--muted);padding-top:20px;font-size:12px}.empty{background:var(--panel);border:1px solid var(--line);padding:18px;border-radius:14px;color:var(--muted)}
@media(max-width:760px){.shell{padding:24px 12px 60px}.mast h1{font-size:38px}.candidate-grid,.metrics{grid-template-columns:1fr 1fr}.calc-inputs{grid-template-columns:1fr}.tools{grid-template-columns:1fr 1fr}.tools .search{grid-column:1/-1}}
.tools{grid-template-columns:auto auto auto 1fr}@media(max-width:700px){.tools{grid-template-columns:repeat(3,1fr)}.tools .search{grid-column:1/-1}}
${recommendationCss()}
</style>
</head>
<body data-new-orders="${macroLocked || !currentPlan ? "locked" : "shadow-only"}"><main class="shell">
<header class="mast"><h1>K<span>²</span> Range Desk</h1><div class="stamp">NSE stock futures · continuous ladder<br>built ${escapeHtml(meta.builtAt)} UTC</div></header>
<p class="notice"><strong>Decision support—not an earnings promise.</strong> The larger equity list below improves coverage, not certainty. Only a currently verified NSE stock-futures contract can enter the order pipeline, and this build never submits a real broker order.</p>
${currentPlan ? "" : `<p class="notice" id="plan-stale">No current, version-verified plan. Stored plan: ${escapeHtml(plan?.weekKey || "unavailable")}. Old trade instructions are withheld; the research directory remains available.</p>`}
<section class="macro"><div class="macro-head"><b><span class="dot"></span>GLOBAL DATA &amp; SHOCK GATE: ${escapeHtml(macroResult.state.severity)}</b><span>${escapeHtml(macroResult.updatedAt || "timestamp unavailable")}</span></div><div class="pills">
  <span class="pill">GIFT NIFTY ${shown(macroResult.input.giftNiftyGapPct, "", "%")}</span>
  <span class="pill">INDIA VIX ${shown(macroResult.input.indiaVix)}</span>
  <span class="pill">BRENT Δ ${shown(macroResult.input.brentCrudeSpikePct, "", "%")}</span>
  <span class="pill">S&amp;P FUTURES ${shown(macroResult.input.sp500FuturesGapPct, "", "%")}</span>
  <span class="pill">${escapeHtml(macroResult.state.actionDirective)}</span>
</div></section>

<div class="tiles">
  <div class="tile"><b>${escapeHtml(fnoCount)}</b><span>stock-futures names in last snapshot · ${escapeHtml(coverage.derivativesAsOf || plan?.weekKey || "date unknown")}</span></div>
  <div class="tile"><b>${escapeHtml(broadCount)}</b><span>broad NSE equities tracked for research</span></div>
  <div class="tile"><b>${escapeHtml(researchCount)}</b><span>additional research-only equities</span></div>
  <div class="tile"><b>${best.length}</b><span>ranked shadow candidates</span></div>
  <div class="tile"><b>${longs} / ${shorts}</b><span>long / short candidates</span></div>
  <div class="tile"><b>${macroLocked || !currentPlan || coverage.banStatusVerified !== true ? "LOCKED" : "SHADOW"}</b><span>new-order data gate</span></div>
</div>

<section><h2>Current candidate guidance</h2><p class="sub">Generated from the plan—not hand-written cards. “Observed median” describes historical completed cohorts; it is not a promised exit date. The ${DEFAULT_CONFIG.maxHoldingSessions}-session ceiling is a provisional risk limit, not a claim that it is profit-optimal.</p>
  <div class="cards">${best.length ? best.slice(0, 6).map(guidanceCard).join("") : '<div class="empty">No current, risk-admitted candidate is available. Refresh the plan and review data availability.</div>'}</div>
</section>

${recommendationSectionHtml()}

<section><h2>Price-distance assistant</h2><p class="sub">This compares a manually entered broker price with the stored plan. It cannot see spread, live margin, ban changes, order queue, or your broker acknowledgement; therefore it never labels a trade “safe.”</p>
  <div class="calculator"><div class="calc-inputs"><div class="field"><label for="calc-symbol">Candidate</label><select id="calc-symbol">${best.map((item) => `<option value="${escapeHtml(item.symbol)}:${item.side}">${escapeHtml(item.symbol)} (${escapeHtml(item.side)})</option>`).join("")}</select></div><div class="field"><label for="calc-price">Current broker price ₹</label><input id="calc-price" type="number" step="any" placeholder="Enter current contract price"></div></div>
  <div class="decision" id="calc-decision">Select a candidate and enter a current contract price.</div><div class="metrics"><div class="metric"><small>Distance from limit</small><b id="calc-entry">—</b></div><div class="metric"><small>Distance to target</small><b id="calc-target">—</b></div><div class="metric"><small>Stop buffer</small><b id="calc-stop">—</b></div><div class="metric"><small>Holding evidence</small><b id="calc-hold">—</b></div></div></div>
</section>

<section><h2>Qualified ladder candidates</h2><p class="sub">Expected percentage is validation-period research evidence after the modeled cost assumption—not a guaranteed weekly return. Click a row to load its levels above.</p>
  <div class="tools"><button data-filter="all" aria-pressed="true">All</button><button data-filter="long" aria-pressed="false">Long</button><button data-filter="short" aria-pressed="false">Short</button><input id="plan-search" class="search" type="search" placeholder="Search candidates"></div>
  <div class="scroll"><table><thead><tr><th>Instrument</th><th>Sector</th><th>Planned limit</th><th>Target</th><th>Stop</th><th>Observed holding</th><th>Risk ceiling</th><th>Validation expectation</th><th>Evidence score</th><th>Execution scope</th></tr></thead><tbody id="plan-rows">${best.map(planRow).join("")}</tbody></table></div>
</section>

<section><h2>Expanded NSE equity radar</h2><p class="sub">This keeps the current stock-futures set and adds the broader ${broadCount}-name directory for research discovery. An extra cash-equity name is not a futures order: it must first obtain a current exchange contract ID, lot, expiry, liquidity, ban status, margin, and risk approval.</p>
  <input id="research-search" class="search" type="search" placeholder="Search all tracked symbols, companies, sectors or size" style="margin-bottom:12px">
  <div class="scroll"><table><thead><tr><th>Symbol</th><th>Company</th><th>Sector</th><th>Market-cap group</th><th>Scope</th></tr></thead><tbody id="research-rows">${broadStocks.map((stock) => researchRow(stock, futuresSymbols, candidateSymbols)).join("")}</tbody></table></div>
</section>

<section id="book-section"><h2>Private broker book</h2><p class="sub">If included, holdings stay encrypted in this static page. Broker MTM is shown as broker data, not reconstructed as cash-equity P&amp;L.</p>${sealed ? `<div class="lock" id="lock"><p>${meta.positionCount} encrypted positions captured ${escapeHtml(meta.capturedAt)} UTC.</p><form id="unlock-form"><input id="pass" type="password" autocomplete="current-password" placeholder="Passphrase" required><button>Unlock</button></form><p id="unlock-error"></p></div><div id="book" hidden></div>` : '<div class="empty">No encrypted broker book was included in this build.</div>'}</section>

<footer><p><strong>Canonical policy:</strong> weekly first-session anchor, 2% ladder spacing, conservative trade-through fills, protective target/stop, no automatic Friday liquidation, Monday reporting-reference reset only, ${DEFAULT_CONFIG.maxHoldingSessions}-session provisional risk ceiling, and a real close-and-open roll before expiry.</p><p><strong>Evidence boundary:</strong> five-year adjusted cash bars are a research proxy, not point-in-time futures history. Real execution remains disabled until current broker margin, full contract controls, reconciliation, regulatory checks, and prospective shadow evidence pass.</p></footer>
</main>
<script id="sealed" type="application/json">${sealed ? JSON.stringify(sealed) : "null"}</script>
<script>
(function(){
  var rows=Array.prototype.slice.call(document.querySelectorAll('#plan-rows tr'));
  var symbol=document.getElementById('calc-symbol'), price=document.getElementById('calc-price');
  function selected(){return rows.find(function(row){return row.dataset.symbol===(symbol&&symbol.value.split(':')[0])&&row.dataset.side===(symbol&&symbol.value.split(':')[1]);});}
  function pct(value){return (value>=0?'+':'')+value.toFixed(2)+'%';}
  function evaluate(){
    var row=selected(), live=Number(price&&price.value), decision=document.getElementById('calc-decision');
    if(!row||!(live>0)){decision.textContent='Select a candidate and enter a current contract price.';['calc-entry','calc-target','calc-stop','calc-hold'].forEach(function(id){document.getElementById(id).textContent='—';});return;}
    var entry=Number(row.dataset.entry),target=Number(row.dataset.target),stop=Number(row.dataset.stop),isShort=row.dataset.side==='short';
    var fromEntry=(isShort?(entry-live):(live-entry))/entry*100;
    var toTarget=(isShort?(live-target):(target-live))/live*100;
    var stopBuffer=(isShort?(stop-live):(live-stop))/live*100;
    document.getElementById('calc-entry').textContent=pct(fromEntry);
    document.getElementById('calc-target').textContent=pct(toTarget);
    document.getElementById('calc-stop').textContent=pct(stopBuffer);
    document.getElementById('calc-hold').textContent=(Number(row.dataset.hold)>0?row.dataset.hold+' session observed median; ':'')+row.dataset.ceiling+' session ceiling';
    var invalid=isShort?live>=stop:live<=stop;
    var condition=isShort?live>=entry:live<=entry;
    if(invalid) decision.textContent='SETUP INVALIDATED AT/THROUGH STOP. Do not create new exposure from this plan.';
    else if(document.body.dataset.newOrders==='locked') decision.textContent='DATA GATE LOCKED. Distances are for research; no new-order instruction is available.';
    else if(condition) decision.textContent='PLANNED LIMIT CONDITION MET — SHADOW ONLY. Refresh quote, contract/ban/margin checks and portfolio-risk approval.';
    else decision.textContent='PRICE HAS NOT REACHED THE PLANNED LIMIT. Do not chase; keep the order unfilled.';
  }
  if(symbol)symbol.addEventListener('change',evaluate);if(price)price.addEventListener('input',evaluate);
  rows.forEach(function(row){row.addEventListener('click',function(){if(symbol)symbol.value=row.dataset.symbol+':'+row.dataset.side;if(price){price.value='';price.placeholder='Planned limit ₹'+Number(row.dataset.entry).toFixed(2);}evaluate();document.querySelector('.calculator').scrollIntoView({behavior:'smooth',block:'center'});});});
  var filter='all',search=document.getElementById('plan-search');function filterRows(){var q=(search&&search.value||'').toLowerCase();rows.forEach(function(row){row.hidden=!((filter==='all'||row.dataset.side===filter)&&row.dataset.symbol.toLowerCase().includes(q));});}
  document.querySelectorAll('[data-filter]').forEach(function(button){button.addEventListener('click',function(){filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(node){node.setAttribute('aria-pressed',String(node===button));});filterRows();});});if(search)search.addEventListener('input',filterRows);
  var research=document.getElementById('research-search');if(research)research.addEventListener('input',function(){var q=research.value.toLowerCase();document.querySelectorAll('#research-rows tr').forEach(function(row){row.hidden=!row.dataset.research.includes(q);});});

  var sealedNode=document.getElementById('sealed'),sealed=null;try{sealed=JSON.parse(sealedNode.textContent);}catch(e){}var form=document.getElementById('unlock-form');if(!sealed||!form)return;
  function b64(value){var raw=atob(value),out=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function money(value){return typeof value==='number'&&Number.isFinite(value)?'₹'+value.toLocaleString('en-IN'):'—';}
  function render(book){var html='<div class="scroll"><table><thead><tr><th>Instrument</th><th>Side</th><th>Quantity</th><th>Average</th><th>Mark</th><th>Broker MTM</th></tr></thead><tbody>'+book.positions.map(function(p){return '<tr><th class="ticker">'+esc(p.symbol)+'</th><td>'+esc(p.position)+'</td><td class="num">'+esc(p.quantity)+'</td><td class="num">'+money(p.average)+'</td><td class="num">'+money(p.mark)+'</td><td class="num '+(Number(p.unrealised)<0?'negative':'positive')+'">'+money(p.unrealised)+'</td></tr>';}).join('')+'</tbody></table></div>';document.getElementById('book').innerHTML=html;document.getElementById('book').hidden=false;document.getElementById('lock').hidden=true;}
  form.addEventListener('submit',function(event){event.preventDefault();var error=document.getElementById('unlock-error');error.textContent='Opening…';crypto.subtle.importKey('raw',new TextEncoder().encode(document.getElementById('pass').value),'PBKDF2',false,['deriveKey']).then(function(material){return crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(sealed.salt),iterations:sealed.iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);}).then(function(key){return crypto.subtle.decrypt({name:'AES-GCM',iv:b64(sealed.iv)},key,b64(sealed.ciphertext));}).then(function(plain){render(JSON.parse(new TextDecoder().decode(plain)));}).catch(function(){error.textContent='The passphrase did not open the book.';});});
}());
${recommendationClientJs()}
</script></body></html>`;
}

function bookPayload(book, plans, context = {}) {
  const auditResult = auditPurchases(book?.positions || [], plans || []);
  const positions = (book?.positions || []).map((position) => {
    const short = position.position === "short";
    const average = Number(position.buyAverage) || Number(position.sellAverage) || Number(position.price) || 0;
    const mark = Number(position.markPrice) || Number(context[position.symbol]?.mark?.price) || null;
    const quantity = Number(position.quantity) || 0;
    const brokerMtm = position.mtm === null || position.mtm === undefined ? NaN : Number(position.mtm);
    return {
      symbol: String(position.symbol || ""),
      position: short ? "short" : "long",
      quantity,
      average: roundMoney(average),
      mark: roundMoney(mark),
      unrealised: Number.isFinite(brokerMtm) ? roundMoney(brokerMtm) : null
    };
  });
  return { capturedAt: book?.capturedAt || null, positions, audit: auditResult };
}

function roundMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function run() {
  const outputDir = process.argv[2] || "site";
  const passphrase = process.env.K2_PORTAL_PASSPHRASE || "";
  const book = readJson("gm-positions.json");
  const holdings = readJson("plan-holdings.json");
  const plan = readJson("plan-full.json") || readJson("plan-watchlist.json") || {};
  const broadUniverse = { ...universeMetadata(), stocks: universe(), marketCoverage: readJson("data/market-coverage.json") };
  const context = readJson("book-context.json")?.context || {};
  const holdingPlans = holdings ? [...(holdings.best || []), ...(holdings.rejected || []).map((item) => ({ symbol: item.symbol, action: "stand-aside", reasons: [item.reason] }))] : [];
  let sealed = null;
  let meta = { builtAt: new Date().toISOString().slice(0, 16).replace("T", " "), positionCount: 0, capturedAt: "—" };
  if (book && passphrase) {
    const payload = bookPayload(book, holdingPlans, context);
    sealed = sealPayload(payload, passphrase);
    meta = { ...meta, positionCount: payload.positions.length, capturedAt: String(book.capturedAt || "").slice(0, 16).replace("T", " ") };
  } else if (book && !passphrase) {
    console.warn("K2_PORTAL_PASSPHRASE is not set: publishing no broker holdings.");
  }
  const macro = process.argv.includes("--offline") ? null : await fetchLiveMacroRadar().catch(() => null);
  const html = document_(plan, sealed, meta, macro, broadUniverse);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(outputDir, ".nojekyll"), "", "utf8");
  if (process.argv.includes("--sync-root")) fs.writeFileSync(path.join(__dirname, "..", "index.html"), html, "utf8");
  const renderedCount = planIsCurrent(plan) ? (plan.best || []).filter((item) => approvedEntry(item)).length : 0;
  console.log(`Portal written to ${outputDir}: ${renderedCount} current risk-admitted candidates, ${broadUniverse.stocks?.length || 0} research names, ${sealed ? `${meta.positionCount} encrypted positions` : "no book"}`);
}

if (require.main === module) run().catch((error) => { console.error(`Portal build failed: ${error.message}`); process.exitCode = 1; });

module.exports = { bookPayload, document_, macroView, planRow, researchRow, run };
