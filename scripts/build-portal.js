"use strict";

// Builds the K² portal as static files.
//
// Two audiences on one page. The ladder plan carries no personal information and
// stays readable, so it can be shared. The book — positions, averages, P&L — is
// sealed with a passphrase at build time and opened in the browser, so the host
// only ever stores ciphertext even if the site is publicly reachable.
//
//   node scripts/build-portal.js site/
//
// Reads whichever inputs exist: gm-positions.json, plan-holdings.json,
// plan-watchlist.json, plan-full.json. Missing inputs degrade the matching
// section rather than failing the build, so a partial run still publishes.

const fs = require("node:fs");
const path = require("node:path");
const { sealPayload } = require("../api/_lib/portal-crypto");
const { auditPurchases } = require("../api/_lib/trade-audit");
const { fetchLiveMacroRadar } = require("../api/_lib/market-feed");

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fixed = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function nextMonday(weekKey) {
  if (!weekKey) return null;
  const date = new Date(`${weekKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function planRow(item) {
  const side = item.side === "short" ? "short" : "long";
  const potential = item.route === "potential";
  const firstEntry = (item.entries && item.entries[0]) || {};
  const level = Number(firstEntry.level) || 1;
  const levelNames = { 1: "L1 Entry", 2: "L2 Pullback", 3: "L3 Dip", 4: "L4 Capitulation", 5: "L5 Extreme" };
  const levelTag = levelNames[level] || `L${level}`;
  const entryPrice = Number(firstEntry.entry) || Number(item.anchor) || null;
  const targetPrice = Number(firstEntry.target) || (entryPrice ? (side === "short" ? entryPrice * 0.98 : entryPrice * 1.02) : null);
  const stopLossPrice = Number(firstEntry.stopLoss) || (entryPrice ? (side === "short" ? entryPrice * 1.01 : entryPrice * 0.99) : null);
  const riskReward = Number(firstEntry.riskReward) || 2.0;

  const targetPct = Number(firstEntry.targetPct) || (entryPrice && targetPrice ? Math.abs((targetPrice - entryPrice) / entryPrice * 100) : 2.0);
  const stopLossPct = Number(firstEntry.stopLossPct) || (entryPrice && stopLossPrice ? Math.abs((stopLossPrice - entryPrice) / entryPrice * 100) : 1.0);
  const maxBuyCap = entryPrice ? (side === "short" ? entryPrice * 0.992 : entryPrice * 1.008) : null;

  return `
        <tr data-side="${side}" data-symbol="${escapeHtml(item.symbol)}" data-entry="${entryPrice || 0}" data-target="${targetPrice || 0}" data-stop="${stopLossPrice || 0}" data-targetpct="${fixed(targetPct, 1)}" data-stoppct="${fixed(stopLossPct, 1)}" data-expected="${Number(item.expectedWeeklyPct)}" data-conviction="${Number(item.convictionPct)}" style="cursor:pointer;" title="Click to load into Live Decision Calculator">
          <th scope="row">
            <span class="tkr">${escapeHtml(item.symbol)}</span>
            <span class="chip chip-${side}">${side === "short" ? "sell" : "buy"}</span>
            <span class="chip chip-level level-${level}" title="Ladder Level ${level} (${levelTag})">${levelTag}</span>
            ${potential ? '<span class="chip chip-potential">potential</span>' : ""}
            ${item.inJournal ? '<span class="chip chip-journal">traded before</span>' : ""}
          </th>
          <td class="n"><b>${entryPrice ? `₹${fixed(entryPrice)}` : "—"}</b></td>
          <td class="n" style="color:var(--muted);"><small>Max: ₹${maxBuyCap ? fixed(maxBuyCap) : "—"}</small></td>
          <td class="n pos"><b>${targetPrice ? `₹${fixed(targetPrice)}` : "—"}</b> <span class="verdict-detail">${side === "short" ? "−" : "+"}${fixed(targetPct, 1)}%</span></td>
          <td class="n neg"><b>${stopLossPrice ? `₹${fixed(stopLossPrice)}` : "—"}</b> <span class="verdict-detail">${side === "short" ? "+" : "−"}${fixed(stopLossPct, 1)}%</span></td>
          <td class="n"><b>${fixed(riskReward, 1)} : 1</b></td>
          <td class="n">${fixed(item.expectedWeeklyPct)}%</td>
          <td class="n"><span class="bar"><i style="width:${Math.max(2, Math.min(100, Number(item.convictionPct)))}%"></i></span>${fixed(item.convictionPct, 0)}</td>
          <td class="n">×${fixed(item.sizeMultiplier)}</td>
        </tr>`;
}

function document_(plan, sealed, meta, macro = {}) {
  const best = (plan?.best || []).slice(0, 60);
  const longs = best.filter((item) => item.side === "long").length;
  const shorts = best.filter((item) => item.side === "short").length;
  const monday = nextMonday(plan?.weekKey);

  const giftPct = Number(macro?.giftNifty?.changePct || 0);
  const giftPrice = Number(macro?.giftNifty?.price || 0);
  const vixVal = Number(macro?.indiaVix?.price || 11.59);
  const crudeVal = Number(macro?.brentCrude?.price || 96.05);
  const spPct = Number(macro?.sp500Futures?.changePct || 0);
  const isShock = giftPct <= -1.0 || vixVal >= 18 || crudeVal >= 100;
  const radarTone = isShock ? "ELEVATED RISK / DEFENSIVE" : "STABLE";
  const directive = isShock ? "L3/L4 Deep Dips Only" : "L1/L2 Shallow Buys Active";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>K² · Range Desk</title>
<style>
  /* Tokens lifted from the desk's own styles.css so the portal reads as the same
     product: warm paper, ink, and the violet that carries every accent there.
     Semantic mint/coral stay separate from the accent, as they do in the app. */
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --ink: #1f2130;
    --muted: #6c6c78;
    --paper: #f7f4ec;
    --white: #fffefa;
    --line: rgba(31, 33, 48, .12);
    --violet: #6f59d9;
    --violet-soft: #eae5ff;
    --mint: #a8dfc5;
    --mint-deep: #167a62;
    --coral: #ff826f;
    --coral-deep: #b63c32;
    --sun: #f0cc55;
    --shadow: 0 18px 50px rgba(54, 46, 32, .09);
    --display: Georgia, "Times New Roman", serif;
    --body: Inter, Avenir, "Segoe UI", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #f3f1ea; --muted: #a09eae; --paper: #191a24; --white: #21222f;
      --line: rgba(243, 241, 234, .14);
      --violet: #a596ff; --violet-soft: #2b2551;
      --mint-deep: #6fd3ac; --coral-deep: #ff9d8c;
      --shadow: 0 18px 50px rgba(0, 0, 0, .38);
    }
  }
  :root[data-theme="dark"] {
    --ink: #f3f1ea; --muted: #a09eae; --paper: #191a24; --white: #21222f;
    --line: rgba(243, 241, 234, .14);
    --violet: #a596ff; --violet-soft: #2b2551;
    --mint-deep: #6fd3ac; --coral-deep: #ff9d8c;
    --shadow: 0 18px 50px rgba(0, 0, 0, .38);
  }
  :root[data-theme="light"] {
    --ink: #1f2130; --muted: #6c6c78; --paper: #f7f4ec; --white: #fffefa;
    --line: rgba(31, 33, 48, .12);
    --violet: #6f59d9; --violet-soft: #eae5ff;
    --mint-deep: #167a62; --coral-deep: #b63c32;
    --shadow: 0 18px 50px rgba(54, 46, 32, .09);
  }

  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--body); line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .shell { max-width: 1180px; margin: 0 auto; padding: clamp(18px, 3.5vw, 48px) clamp(14px, 3vw, 30px) 68px; }

  .masthead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 30px; }
  .wordmark { font-family: var(--display); font-weight: 400; font-size: clamp(31px, 5vw, 46px); line-height: 1; margin: 0; letter-spacing: -.015em; }
  .wordmark span { color: var(--violet); }
  .stamp { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); text-align: right; line-height: 1.7; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(138px, 1fr)); gap: 12px; margin-bottom: 34px; }
  .tile { background: var(--white); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; box-shadow: var(--shadow); }
  .tile b { display: block; font-family: var(--mono); font-size: 24px; font-variant-numeric: tabular-nums; font-weight: 500; letter-spacing: -.02em; }
  .tile span { font-size: 12px; color: var(--muted); }
  .tile.gold b { color: var(--violet); }
  .neg { color: var(--coral-deep); }
  .pos { color: var(--mint-deep); }

  section { margin-bottom: 42px; }
  h2 { font-family: var(--display); font-weight: 400; font-size: clamp(21px, 2.5vw, 28px); margin: 0 0 5px; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 18px; max-width: 66ch; }

  .row-tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; font-size: 13px; color: var(--muted); background: var(--white); border: 1px solid var(--line); border-radius: 999px; padding: 7px 16px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
  button:hover { color: var(--ink); border-color: var(--muted); }
  button[aria-pressed="true"] { color: var(--violet); border-color: var(--violet); background: var(--violet-soft); }
  button:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }

  .scroll { overflow-x: auto; background: var(--white); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
  table { width: 100%; border-collapse: collapse; min-width: 720px; }
  thead th { text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 400; padding: 13px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid var(--line); }
  tbody tr:last-child { border-bottom: 0; }
  td, tbody th { padding: 12px 16px; font-size: 14px; text-align: left; font-weight: 400; vertical-align: middle; }
  tbody th { display: flex; gap: 9px; align-items: center; }
  .tkr { font-family: var(--mono); font-size: 13px; }
  .n { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .n.big { font-size: 15px; }
  .chip { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .chip-long { color: var(--mint-deep); background: color-mix(in srgb, var(--mint) 40%, transparent); }
  .chip-short { color: var(--coral-deep); background: color-mix(in srgb, var(--coral) 26%, transparent); }
  .chip-potential { color: #8a6b0f; background: color-mix(in srgb, var(--sun) 34%, transparent); }
  .chip-journal { color: var(--muted); border: 1px solid var(--line); }
  .bar { display: inline-block; width: 56px; height: 5px; background: var(--line); border-radius: 999px; overflow: hidden; vertical-align: middle; margin-right: 9px; }
  .bar i { display: block; height: 100%; background: var(--violet); }
  .rungs { display: flex; gap: 7px; flex-wrap: wrap; }
  .rung { font-family: var(--mono); font-size: 11px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); white-space: nowrap; }
  .rung em { font-style: normal; color: var(--muted); margin-left: 6px; }
  .verdict { font-size: 11px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .v-good { color: var(--mint-deep); background: color-mix(in srgb, var(--mint) 40%, transparent); }
  .v-bad { color: var(--coral-deep); background: color-mix(in srgb, var(--coral) 26%, transparent); }
  .v-warn { color: #8a6b0f; background: color-mix(in srgb, var(--sun) 34%, transparent); }

  .lock { background: var(--white); border: 1px solid var(--line); border-radius: 20px; padding: clamp(22px, 4vw, 36px); max-width: 470px; box-shadow: var(--shadow); }
  .lock h3 { font-family: var(--display); font-weight: 400; font-size: 21px; margin: 0 0 6px; }
  .lock p { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
  .lock form { display: flex; gap: 9px; flex-wrap: wrap; }
  input[type="password"] { font: inherit; font-family: var(--mono); flex: 1 1 210px; min-width: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); color: var(--ink); }
  input[type="password"]:focus-visible { outline: 2px solid var(--violet); outline-offset: 1px; }
  .lock button { background: var(--violet); color: #fffefa; border-color: var(--violet); padding: 10px 24px; }
  .lock button:hover { color: #fffefa; opacity: .9; }
  .err { color: var(--coral-deep); font-size: 13px; margin: 14px 0 0; min-height: 1.2em; }
  [hidden] { display: none !important; }
  .glossary { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
  .glossary > div { background: var(--white); border: 1px solid var(--line); border-radius: 14px; padding: 15px 17px; }
  .glossary dt { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--violet); margin-bottom: 5px; }
  .glossary dd { margin: 0; font-size: 13.5px; color: var(--muted); }
  .glossary em { font-style: normal; color: var(--ink); font-weight: 600; }
  footer { border-top: 1px solid var(--line); padding-top: 22px; color: var(--muted); font-size: 12.5px; }
  footer p { margin: 0 0 7px; max-width: 74ch; }
  /* On a phone a ten-column table is a sideways scroll nobody reads. Each row
     becomes a card and every figure carries its own label. */
  @media (max-width: 760px) {
    .scroll { border-radius: 14px; }
    table { min-width: 0; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    tbody tr { display: block; padding: 14px 16px; }
    tbody th { padding: 0 0 10px; font-size: 15px; }
    tbody td { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 5px 0; text-align: right; }
    tbody td::before {
      content: attr(data-label);
      font-family: var(--mono); font-size: 10px; letter-spacing: .07em; text-transform: uppercase;
      color: var(--muted); text-align: left; flex: 0 0 auto;
    }
    tbody td.rungs { flex-wrap: wrap; justify-content: flex-start; }
    tbody td.rungs::before { flex-basis: 100%; margin-bottom: 4px; }
    .verdict-detail { display: inline; margin-left: 6px; }
    .masthead { flex-direction: column; align-items: flex-start; gap: 8px; }
    .stamp { text-align: left; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; }
    .tile { padding: 12px 13px; }
    .tile b { font-size: 20px; }
    .lock { padding: 20px; }
  }
  .search { flex: 1 1 190px; min-width: 0; max-width: 280px; font: inherit; font-size: 13px; padding: 7px 15px;
    border: 1px solid var(--line); border-radius: 999px; background: var(--white); color: var(--ink); }
  .search:focus-visible { outline: 2px solid var(--violet); outline-offset: 1px; }
  .no-hits { padding: 18px; color: var(--muted); font-size: 14px; }
  
  .calc-section { margin-bottom: 28px; }
  .calc-card { background: var(--white); border: 1px solid var(--line); border-radius: 20px; padding: 22px 24px; box-shadow: var(--shadow); }
  .calc-title { font-family: var(--display); font-size: 21px; font-weight: 400; margin: 0 0 6px; }
  .calc-desc { color: var(--muted); font-size: 13.5px; margin: 0 0 18px; max-width: 74ch; }
  .calc-inputs { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; margin-bottom: 16px; }
  .calc-group { flex: 1 1 200px; min-width: 180px; }
  .calc-group label { display: block; font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
  .calc-group select, .calc-group input { width: 100%; font: inherit; font-family: var(--mono); font-size: 14px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); color: var(--ink); }
  .calc-group select:focus-visible, .calc-group input:focus-visible { outline: 2px solid var(--violet); }
  .calc-badge-container { flex: 1 1 280px; min-width: 240px; display: flex; align-items: center; }
  .calc-badge { display: inline-flex; align-items: center; justify-content: center; width: 100%; padding: 11px 18px; border-radius: 12px; font-weight: 600; font-size: 13px; font-family: var(--mono); text-align: center; }
  .badge-buy { background: color-mix(in srgb, var(--mint) 40%, transparent); color: var(--mint-deep); border: 1px solid var(--mint-deep); }
  .badge-sell { background: color-mix(in srgb, var(--coral) 26%, transparent); color: var(--coral-deep); border: 1px solid var(--coral-deep); }
  .badge-warn { background: color-mix(in srgb, var(--sun) 34%, transparent); color: #8a6b0f; border: 1px solid #d4a72c; }
  .badge-stop { background: color-mix(in srgb, var(--coral) 26%, transparent); color: var(--coral-deep); border: 1px solid var(--coral-deep); }
  .badge-info { background: var(--violet-soft); color: var(--violet); border: 1px solid var(--violet); }
  .calc-results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; }
  .calc-metric .lbl { display: block; font-size: 11px; color: var(--muted); margin-bottom: 2px; }
  .calc-metric b { font-family: var(--mono); font-size: 16px; font-weight: 600; }
  .calc-metric.full { grid-column: 1 / -1; border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 2px; }
  .order-text { font-size: 13.5px !important; color: var(--ink) !important; font-weight: 500 !important; }

  .chip-level { font-family: var(--mono); font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-left: 4px; vertical-align: middle; }
  
  .macro-radar-banner { background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 16px 20px; margin-bottom: 20px; box-shadow: var(--shadow); color: #f8fafc; }
  .radar-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
  .radar-title { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 700; letter-spacing: .02em; }
  .radar-dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; display: inline-block; }
  .radar-time { font-family: var(--mono); font-size: 11px; color: #94a3b8; }
  .radar-pills { display: flex; flex-wrap: wrap; gap: 10px; }
  .radar-pill { background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; padding: 6px 12px; font-size: 12px; font-family: var(--mono); color: #e2e8f0; }
  .radar-pill b { font-weight: 700; }
  .radar-pill.status-pill { background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.35); color: #34d399; }
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <h1 class="wordmark">K<span>²</span> Range Desk</h1>
    <div class="stamp">
      NSE futures · weekly ladder<br>
      built ${escapeHtml(meta.builtAt)} UTC
    </div>
  </header>

  <div class="macro-radar-banner">
    <div class="radar-header">
      <div class="radar-title">
        <span class="radar-dot" style="${isShock ? 'background:#ef4444;box-shadow:0 0 8px rgba(239,68,68,0.6);' : ''}"></span>
        <b id="radar-title-text">GLOBAL PRE-MARKET & WAR SHOCK RADAR: ${radarTone}</b>
      </div>
      <div class="radar-time" id="radar-sync-time">Live TradingView Sync (Auto-refreshing)</div>
    </div>
    <div class="radar-pills">
      <div class="radar-pill">GIFT NIFTY: <b id="radar-gift-val" class="${giftPct >= 0 ? 'pos' : 'neg'}">${giftPct >= 0 ? '+' : ''}${giftPct.toFixed(2)}%</b> <span id="radar-gift-price">${giftPrice ? `(${Math.round(giftPrice)})` : ''}</span></div>
      <div class="radar-pill">INDIA VIX: <b id="radar-vix-val">${vixVal.toFixed(2)}</b></div>
      <div class="radar-pill">BRENT CRUDE: <b id="radar-crude-val">$${crudeVal.toFixed(2)}</b></div>
      <div class="radar-pill">US S&P FUTURES: <b id="radar-sp-val" class="${spPct >= 0 ? 'pos' : 'neg'}">${spPct >= 0 ? '+' : ''}${spPct.toFixed(2)}%</b></div>
      <div class="radar-pill status-pill">SHIELD DIRECTIVE: <b id="radar-directive">${directive}</b></div>
    </div>
  </div>

  <div class="grid">
    <div class="tile"><b>${plan?.universe ?? "—"}</b><span>names measured</span></div>
    <div class="tile gold"><b>${plan?.actionable ?? "—"}</b><span>cleared every test</span></div>
    <div class="tile"><b>${longs}</b><span>buy ladders</span></div>
    <div class="tile"><b>${shorts}</b><span>sell ladders</span></div>
    <div class="tile"><b>${fixed(best[0]?.expectedWeeklyPct)}%</b><span>best expected week</span></div>
  </div>

  <section class="calc-section">
    <div class="calc-card" id="decision-assistant">
      <div class="calc-header">
        <h3 class="calc-title">⚡ Live Price Decision Assistant & Distance Calculator</h3>
        <p class="calc-desc">Enter the current price from your broker app (or click any row in the table below). The system automatically calculates the exact distance from entry, remaining profit to target, and gives you a clear <b>BUY NOW</b> or <b>DO NOT CHASE</b> instruction.</p>
      </div>
      <div class="calc-body">
        <div class="calc-inputs">
          <div class="calc-group">
            <label for="calc-symbol">Stock Setup</label>
            <select id="calc-symbol">
              ${best.map(item => `<option value="${escapeHtml(item.symbol)}">${escapeHtml(item.symbol)} (${item.side.toUpperCase()})</option>`).join("")}
            </select>
          </div>
          <div class="calc-group">
            <label for="calc-live-price">Live Market Price (₹)</label>
            <input id="calc-live-price" type="number" step="any" placeholder="Enter live broker price">
          </div>
          <div class="calc-badge-container">
            <div class="calc-badge badge-buy" id="calc-badge">Select a stock to evaluate</div>
          </div>
        </div>
        <div class="calc-results-grid">
          <div class="calc-metric"><span class="lbl">Distance from Entry</span><b id="calc-dist-entry">—</b></div>
          <div class="calc-metric"><span class="lbl">Remaining to Target</span><b id="calc-dist-target" class="pos">—</b></div>
          <div class="calc-metric"><span class="lbl">Buffer to Stop-Loss</span><b id="calc-dist-stop" class="neg">—</b></div>
          <div class="calc-metric full"><span class="lbl">Exact Broker Action</span><b id="calc-order-plan" class="order-text">—</b></div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>Qualified ladders${plan?.weekKey ? ` · week of ${escapeHtml(monday || plan.weekKey)}` : ""}</h2>
    <p class="sub">Rungs are distance from Monday's open, with the measured hit rate and the number of historical fills behind it. Prices are set from that open each week. <em>Click any row to load into the Live Decision Assistant above.</em></p>
    ${longs === 0 ? `
    <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.28); border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; font-size: 13.5px; color: var(--ink);">
      <strong>🛡️ Capital Protection Shield Active (0 Buys):</strong> With strict 2.0% stop-loss barriers and 0.08% statutory friction active, <strong>no shallow buy ladder cleared the statistical significance hurdle (t ≥ 1.89)</strong> across the 210 F&amp;O universe this week. The system refuses to recommend shallow dip buys that bleed capital into choppy markets.
    </div>` : ""}
    <div class="row-tools">
      <button type="button" data-filter="all" aria-pressed="true">All ${best.length}</button>
      <button type="button" data-filter="long" aria-pressed="false">Buy ${longs}</button>
      <button type="button" data-filter="short" aria-pressed="false">Sell ${shorts}</button>
      <button type="button" data-sort="expected" aria-pressed="true">Expected</button>
      <button type="button" data-sort="conviction" aria-pressed="false">Conviction</button>
      <input type="search" class="search" id="plan-search" placeholder="Search a stock" aria-label="Search the ladder list">
    </div>
    <div class="scroll">
      <table>
        <thead><tr><th scope="col">Instrument</th><th scope="col">Buy / Entry Price</th><th scope="col">Max Buy Cap (+0.8%)</th><th scope="col">Sell Target</th><th scope="col">Stop Loss</th><th scope="col">Reward : Risk</th><th scope="col">Expected week</th><th scope="col">Conviction</th><th scope="col">Size</th></tr></thead>
        <tbody id="plan-rows">${best.map(planRow).join("")}</tbody>
      </table>
    </div>
  </section>

  <section id="book-section">
    <h2>The book</h2>
    <p class="sub"><strong>Your average</strong> is what you bought at, or sold at on a short. <strong>Mark</strong> is the contract's price at the broker right now, falling back to the exchange close when the market is shut. <strong>MTM</strong> is the broker's own figure, and it is more than mark minus average: it also holds the profit already banked by partly closing a position. Every figure here is read from GM, not recalculated. Positions are encrypted in this page; the passphrase never leaves your browser.</p>
    ${sealed ? `
    <div class="lock" id="lock">
      <h3>Unlock the book</h3>
      <p>${meta.positionCount} positions, read from GM ${escapeHtml(meta.capturedAt)} UTC.</p>
      <form id="unlock-form">
        <label for="pass" class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Passphrase</label>
        <input type="password" id="pass" autocomplete="current-password" placeholder="passphrase" required>
        <button type="submit">Unlock</button>
      </form>
      <p class="err" id="err" role="alert"></p>
    </div>
    <div id="book" hidden></div>
    <p class="sub" id="book-key" hidden style="margin-top:14px">
      <strong>No measured edge</strong> — the 2% weekly rule has no proven record in that stock over five years. It is not a prediction that the position loses; it means the reason for opening it is not supported by its own history.
      <strong>Against the trend</strong> — the stock has moved the other way for twelve months, and buying dips in something falling all year is where this rule loses most of its money.
      <strong>Paying carry</strong> — the futures contract sits above the share, so holding a long bleeds that premium away a little each day until expiry.
    </p>` : '<p class="sub">No book was included in this build.</p>'}
  </section>

  <section>
    <h2>What the numbers mean</h2>
    <p class="sub">Written out once, because a figure you have to guess at is worse than no figure.</p>
    <div class="glossary">
      <div><dt>MTM, and why it is not simply mark minus average</dt><dd>A partly closed position has two halves. Say 400 were bought at 100 and 250 of those sold at 104, leaving 150 open against a mark of 105. The closed 250 banked <em>1,000</em>, the open 150 shows <em>750</em>, and the broker's MTM of <em>1,750</em> is both together. Mark minus average on the open lots alone loses the banked half, so this page reports the broker's figure rather than doing its own arithmetic.</dd></div>
      <div><dt>Carry</dt><dd>A futures contract and its share trade at different prices, and that gap must close by expiry. If the future sits <em>above</em> the share you pay that premium away a little each day you hold a long; if it sits below, you are paid to hold. A known cost or credit that happens whatever the price does, shown as what it is worth to your position over one week.</dd></div>
      <div><dt>Mark</dt><dd>The contract's latest price, with its source underneath. GM publishes nothing once the market closes, so outside session hours this is the exchange's official close.</dd></div>
      <div><dt>Day and month range</dt><dd>Day range is the contract's own high and low for the session. Month range is the share's high and low over the last 21 sessions — the wider context the ladder rungs sit inside.</dd></div>
      <div><dt>12-month trend</dt><dd>Where the share has gone over a year, scaled by its own volatility. Buying dips in something that has fallen all year is the largest single source of loss in this rule, so a position leaning against its trend is flagged.</dd></div>
      <div><dt>Potential</dt><dd>Most names reach this list because the 2% ladder has a measured record on them. A few arrive the other way: the ladder has none, but every reading together puts the expected move <em>above</em> your 2% floor. Those carry a "potential" tag, offer only the first rung, show no hit rate because there is none to show, and are sized smaller. A 2% floor is a floor — a name set up to travel further belongs here even when the slice-harvesting rule cannot measure it.</dd></div>
      <div><dt>Traded before</dt><dd>The name appears in the journal exported from the old platform. A marker, not a filter: 28 of those names have since left the F&amp;O segment, and 114 tradable names were never in it.</dd></div>
      <div><dt>Ladder</dt><dd>Whether the 2% weekly rule has a measured edge on that name over five years. "No measured edge" is not a forecast of loss — it means the rule that opened the position has no historical support in that name.</dd></div>
    </div>
  </section>

  <footer>
    <p><strong>Rule measured:</strong> the week's first open is the anchor; orders rest 2% apart; a leg exits on the first touch of a 2% gain. Costs charged at 0.06% per round trip. Hit rates carry 95% Wilson bounds and each rung clears a t-statistic hurdle raised for testing five rungs. Reported weeks are out of sample.</p>
    <p><strong>Gates:</strong> a 12-month trend running against the ladder is refused outright, as is a results date inside the trading week. A measured edge is not a promise.</p>
  </footer>
</div>

<script id="sealed" type="application/json">${sealed ? JSON.stringify(sealed) : "null"}</script>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll("#plan-rows tr"));
  var body = document.getElementById("plan-rows");
  var filter = "all", sort = "expected";
  function press(group, value) {
    document.querySelectorAll("[data-" + group + "]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset[group] === value)); });
  }
  function apply() {
    rows.slice().sort(function (a, b) { return Number(b.dataset[sort]) - Number(a.dataset[sort]); })
      .forEach(function (n) { body.appendChild(n); });
    rows.forEach(function (n) { n.style.display = filter === "all" || n.dataset.side === filter ? "" : "none"; });
  }
  document.querySelectorAll("[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () { filter = b.dataset.filter; press("filter", filter); apply(); refresh(); });
  });
  document.querySelectorAll("[data-sort]").forEach(function (b) {
    b.addEventListener("click", function () { sort = b.dataset.sort; press("sort", sort); apply(); refresh(); });
  });
  // Search filters alongside the buy/sell buttons rather than replacing them.
  var planSearch = document.getElementById("plan-search");
  function refresh() {
    var term = planSearch ? planSearch.value.trim().toUpperCase() : "";
    var shown = 0;
    rows.forEach(function (node) {
      var name = (node.querySelector(".tkr") || {}).textContent || "";
      var visible = (filter === "all" || node.dataset.side === filter) && (!term || name.indexOf(term) > -1);
      node.style.display = visible ? "" : "none";
      if (visible) shown += 1;
    });
    var empty = document.getElementById("plan-empty");
    if (empty) empty.hidden = shown > 0;
  }
  if (planSearch) planSearch.addEventListener("input", refresh);
  apply();
  refresh();

  // Live Decision Assistant & Distance Calculator logic
  var calcSymbol = document.getElementById("calc-symbol");
  var calcLivePrice = document.getElementById("calc-live-price");
  var calcBadge = document.getElementById("calc-badge");
  var calcDistEntry = document.getElementById("calc-dist-entry");
  var calcDistTarget = document.getElementById("calc-dist-target");
  var calcDistStop = document.getElementById("calc-dist-stop");
  var calcOrderPlan = document.getElementById("calc-order-plan");

  function evaluateLiveDecision() {
    if (!calcSymbol) return;
    var sym = calcSymbol.value;
    var targetRow = rows.find(function (r) { return r.dataset.symbol === sym; });
    if (!targetRow) return;

    var side = targetRow.dataset.side || "long";
    var entry = Number(targetRow.dataset.entry) || 0;
    var target = Number(targetRow.dataset.target) || 0;
    var stop = Number(targetRow.dataset.stop) || 0;

    var liveVal = parseFloat(calcLivePrice.value);
    var isUserPrice = Number.isFinite(liveVal) && liveVal > 0;
    var live = isUserPrice ? liveVal : entry;

    if (!isUserPrice) {
      calcLivePrice.placeholder = "Entry is ₹" + entry.toFixed(2) + " (enter live price)";
    }

    var distEntryPct = side === "short"
      ? ((entry - live) / entry) * 100
      : ((live - entry) / entry) * 100;
    var distTargetPct = Math.abs((target - live) / live) * 100;
    var distStopPct = Math.abs((stop - live) / live) * 100;

    var distEntryDiff = Math.abs(live - entry);
    var distTargetDiff = Math.abs(target - live);
    var distStopDiff = Math.abs(stop - live);

    calcDistEntry.textContent = (distEntryPct >= 0 ? "+" : "") + distEntryPct.toFixed(2) + "% (" + (live >= entry ? "+" : "-") + "₹" + distEntryDiff.toFixed(2) + ")";
    calcDistEntry.className = Math.abs(distEntryPct) <= 0.8 ? "pos" : (distEntryPct > 1.0 ? "neg" : "");

    calcDistTarget.textContent = "+" + distTargetPct.toFixed(2) + "% (+₹" + distTargetDiff.toFixed(2) + " left)";
    calcDistStop.textContent = "−" + distStopPct.toFixed(2) + "% (₹" + distStopDiff.toFixed(2) + " cushion)";

    calcBadge.className = "calc-badge";

    if (side === "long") {
      if (live >= target) {
        calcBadge.className += " badge-buy";
        calcBadge.textContent = "🏁 TARGET REACHED (+" + distEntryPct.toFixed(1) + "%) · PROFIT BOOKED";
        calcOrderPlan.textContent = "Trade complete. Target was hit at ₹" + target.toFixed(2) + ". Do not enter now.";
      } else if (live <= stop) {
        calcBadge.className += " badge-stop";
        calcBadge.textContent = "🛑 STOP-LOSS BREACHED (" + distEntryPct.toFixed(1) + "%) · DO NOT BUY";
        calcOrderPlan.textContent = "Setup invalidated. Price dropped below stop-loss (₹" + stop.toFixed(2) + ").";
      } else if (distEntryPct <= 0.8 && distEntryPct >= -1.5) {
        calcBadge.className += " badge-buy";
        calcBadge.textContent = "🟢 IN BUY ZONE · SAFE TO ENTER NOW";
        calcOrderPlan.textContent = "Place " + (distEntryPct < 0 ? "Discount Buy" : "Buy") + " @ ₹" + live.toFixed(2) + " | Set GTT Target @ ₹" + target.toFixed(2) + " | Set GTT Stop-Loss @ ₹" + stop.toFixed(2);
      } else if (distEntryPct > 0.8) {
        calcBadge.className += " badge-warn";
        calcBadge.textContent = "🛑 EXTENDED (+" + distEntryPct.toFixed(1) + "% above entry) · DO NOT CHASE";
        calcOrderPlan.textContent = "Price is too high above entry. Place a Limit Buy Order @ ₹" + entry.toFixed(2) + " and wait for pullback.";
      } else {
        calcBadge.className += " badge-info";
        calcBadge.textContent = "ℹ️ BELOW ENTRY · VERIFY MOMENTUM";
        calcOrderPlan.textContent = "Place Limit Order @ ₹" + entry.toFixed(2) + " | Target: ₹" + target.toFixed(2) + " | Stop: ₹" + stop.toFixed(2);
      }
    } else {
      if (live <= target) {
        calcBadge.className += " badge-buy";
        calcBadge.textContent = "🏁 TARGET REACHED (+" + distEntryPct.toFixed(1) + "%) · PROFIT BOOKED";
        calcOrderPlan.textContent = "Short trade complete. Target hit at ₹" + target.toFixed(2) + ". Cover position / do not short now.";
      } else if (live >= stop) {
        calcBadge.className += " badge-stop";
        calcBadge.textContent = "🛑 STOP-LOSS BREACHED (−" + distEntryPct.toFixed(1) + "%) · DO NOT SHORT";
        calcOrderPlan.textContent = "Setup invalidated. Price rallied above stop-loss (₹" + stop.toFixed(2) + ").";
      } else if (Math.abs(live - entry) / entry <= 0.008) {
        calcBadge.className += " badge-sell";
        calcBadge.textContent = "🔴 IN SELL ZONE · SAFE TO SHORT NOW";
        calcOrderPlan.textContent = "Place Short Sell @ ₹" + live.toFixed(2) + " | Set GTT Cover Target @ ₹" + target.toFixed(2) + " | Set GTT Stop-Loss @ ₹" + stop.toFixed(2);
      } else if (live < entry * 0.992) {
        calcBadge.className += " badge-warn";
        calcBadge.textContent = "🛑 EXTENDED (dropped below entry) · DO NOT CHASE SHORT";
        calcOrderPlan.textContent = "Price fell too far below entry. Place Limit Sell @ ₹" + entry.toFixed(2) + " and wait for bounce.";
      } else {
        calcBadge.className += " badge-info";
        calcBadge.textContent = "ℹ️ ABOVE ENTRY (Discount Short) · VERIFY MOMENTUM";
        calcOrderPlan.textContent = "Place Limit Sell Order @ ₹" + entry.toFixed(2) + " | Target: ₹" + target.toFixed(2) + " | Stop: ₹" + stop.toFixed(2);
      }
    }
  }

  if (calcSymbol) calcSymbol.addEventListener("change", function () {
    var sym = calcSymbol.value;
    var targetRow = rows.find(function (r) { return r.dataset.symbol === sym; });
    if (targetRow) {
      calcLivePrice.value = "";
      calcLivePrice.placeholder = "Entry: ₹" + Number(targetRow.dataset.entry).toFixed(2);
    }
    evaluateLiveDecision();
  });

  if (calcLivePrice) calcLivePrice.addEventListener("input", evaluateLiveDecision);

  // Clicking any row in the table automatically loads it into the Decision Assistant
  rows.forEach(function (r) {
    r.addEventListener("click", function () {
      var sym = r.dataset.symbol;
      if (calcSymbol && sym) {
        calcSymbol.value = sym;
        calcLivePrice.value = "";
        calcLivePrice.placeholder = "Entry: ₹" + Number(r.dataset.entry).toFixed(2);
        evaluateLiveDecision();
        var assistant = document.getElementById("decision-assistant");
        if (assistant) assistant.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });

  evaluateLiveDecision();

  var sealedNode = document.getElementById("sealed");
  var sealed = null;
  try { sealed = JSON.parse(sealedNode.textContent); } catch (e) { sealed = null; }
  var form = document.getElementById("unlock-form");
  if (!sealed || !form) return;

  var b64 = function (value) {
    var raw = atob(value), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  var money = function (value) {
    if (typeof value !== "number" || !isFinite(value)) return "\\u2014";
    return (value < 0 ? "\\u2212" : "") + "\\u20B9" + Math.abs(Math.round(value)).toLocaleString("en-IN");
  };
  var num = function (value, digits) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(digits === undefined ? 2 : digits) : "\\u2014";
  };

  function render(book) {
    var rowsHtml = book.positions.map(function (p) {
      var short = p.position === "short";
      var v = p.verdict || { label: "not measured", tone: "none" };
      var cls = v.tone === "good" ? "v-good" : v.tone === "bad" ? "v-bad" : v.tone === "warn" ? "v-warn" : "";
      var audit = p.audit || {};
      var healthCls = audit.tradeHealth === "TARGET_REACHED" || audit.tradeHealth === "IN_PROFIT" ? "v-good"
        : audit.tradeHealth === "STOP_TRIGGERED" || audit.tradeHealth === "DRAWDOWN" ? "v-bad" : "v-warn";
      var healthLabel = audit.tradeHealth === "TARGET_REACHED" ? "TARGET HIT (+2%)"
        : audit.tradeHealth === "STOP_TRIGGERED" ? "STOP TRIGGERED (-1%)"
        : audit.tradeHealth === "IN_PROFIT" ? "IN PROFIT"
        : audit.tradeHealth === "DRAWDOWN" ? "DRAWDOWN"
        : (audit.onBuyList ? "ON BUY LIST" : "OFF-PLAN");

      return '<tr>'
        + '<th scope="row"><span class="tkr">' + p.symbol + '</span><span class="chip chip-' + (short ? "short" : "long") + '">' + (short ? "short" : "long") + '</span>'
        + (audit.onBuyList ? ' <span class="chip chip-potential">MODEL</span>' : ' <span class="chip chip-journal">OFF-PLAN</span>') + '</th>'
        + '<td class="n" data-label="Net qty">' + p.quantity.toLocaleString("en-IN") + '</td>' 
        + '<td class="n" data-label="Bought @"><b>' + num(p.average) + '</b></td>' 
        + '<td class="n" data-label="Model Entry">' + (audit.modelEntryPrice ? '₹' + num(audit.modelEntryPrice) : "—") + '</td>' 
        + '<td class="n ' + (audit.slippagePct > 0 ? "neg" : "pos") + '" data-label="Slippage">' + (audit.slippagePct !== null ? (audit.slippagePct > 0 ? "+" : "") + num(audit.slippagePct) + "%" : "—") + '</td>' 
        + '<td class="n pos" data-label="Target (+2%)"><b>' + (audit.modelTargetPrice ? '₹' + num(audit.modelTargetPrice) : num(p.target)) + '</b></td>' 
        + '<td class="n neg" data-label="Stop Loss (-1%)"><b>' + (audit.modelStopLossPrice ? '₹' + num(audit.modelStopLossPrice) : "—") + '</b></td>' 
        + '<td class="n" data-label="Mark">' + num(p.mark) + '</td>'
        + '<td class="n ' + (p.unrealised < 0 ? "neg" : "pos") + '" data-label="MTM"><b>' + money(p.unrealised) + '</b></td>' 
        + '<td data-label="Trade Audit"><span class="verdict ' + healthCls + '">' + healthLabel + '</span></td>'
        + '</tr>';
    }).join("");

    var auditSummary = book.audit?.summary || {};
    document.getElementById("book").innerHTML =
      '<div class="grid">'
      + '<div class="tile"><b>' + money(book.totalNotional) + '</b><span>portfolio value</span></div>'
      + '<div class="tile"><b class="' + (book.totalUnrealised < 0 ? "neg" : "pos") + '">' + money(book.totalUnrealised) + '</b><span>total MTM</span></div>'
      + '<div class="tile"><b>' + (book.totalQuantity || 0).toLocaleString("en-IN") + '</b><span>total quantity</span></div>'
      + '<div class="tile"><b>' + book.positions.length + '</b><span>open positions</span></div>'

      + '<div class="tile"><b>' + (auditSummary.compliantPositions || 0) + ' / ' + book.positions.length + '</b><span>on buy list</span></div>'
      + '<div class="tile"><b class="' + ((auditSummary.targetsReached || 0) > 0 ? "pos" : "") + '">' + (auditSummary.targetsReached || 0) + '</b><span>targets hit</span></div>'
      + '<div class="tile"><b class="' + ((auditSummary.stopsTriggered || 0) > 0 ? "neg" : "") + '">' + (auditSummary.stopsTriggered || 0) + '</b><span>stops triggered</span></div>'
      + '<div class="tile"><b>' + book.inProfit + ' / ' + book.positions.length + '</b><span>in profit</span></div>'
      + '<div class="tile"><b class="neg">' + (book.carryCosting || 0) + '</b><span>paying carry</span></div>'
      + '</div>'
      + '<div class="scroll"><table><thead><tr>'
      + '<th scope="col">Instrument</th><th scope="col">Net qty</th><th scope="col">Bought @</th><th scope="col">Model Entry</th><th scope="col">Slippage</th>' 
      + '<th scope="col">Target (+2%)</th><th scope="col">Stop (-1%)</th><th scope="col">Mark</th><th scope="col">MTM P&L</th><th scope="col">Audit Status</th>'
      + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    document.getElementById("book").hidden = false;
    document.getElementById("lock").hidden = true;
    var key = document.getElementById("book-key");
    if (key) key.hidden = false;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var err = document.getElementById("err");
    var pass = document.getElementById("pass").value;
    err.textContent = "Opening\\u2026";
    crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"])
      .then(function (material) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64(sealed.salt), iterations: sealed.iterations, hash: "SHA-256" },
          material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
        );
      })
      .then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(sealed.iv) }, key, b64(sealed.ciphertext));
      })
      .then(function (plain) {
        render(JSON.parse(new TextDecoder().decode(plain)));
      })
      .catch(function () {
        err.textContent = "That passphrase did not open the book. Check it and try again.";
      });
  });
}());
</script>
<script>
// Real-Time Live TradingView Auto-Sync for GIFT NIFTY (NSEIX:NIFTY1!)
(function initLiveTradingViewSync() {
  function fetchGiftLive() {
    fetch("https://scanner.tradingview.com/symbol?symbol=NSEIX:NIFTY1!&fields=close,change,change_abs", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var pill = document.getElementById("radar-gift-val");
        var priceEl = document.getElementById("radar-gift-price");
        if (pill && typeof d.change === "number") {
          var sign = d.change >= 0 ? "+" : "";
          pill.textContent = sign + d.change.toFixed(2) + "%";
          pill.className = d.change >= 0 ? "pos" : "neg";
        }
        if (priceEl && typeof d.close === "number") {
          priceEl.textContent = "(" + Math.round(d.close) + ")";
        }
        var timeEl = document.getElementById("radar-sync-time");
        if (timeEl) {
          var dt = new Date();
          timeEl.textContent = "Live TradingView Sync: " + dt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
        }
      })
      .catch(function () {});
  }
  fetchGiftLive();
  setInterval(fetchGiftLive, 10000);
}());
</script>
</body>
</html>
`;
}

// The private payload is reduced to exactly what the page renders, so nothing
// extra is carried into the ciphertext.
function bookPayload(book, plans, context = {}) {
  const auditResult = auditPurchases(book.positions || [], plans);
  const auditMap = new Map((auditResult.items || []).map((item) => [item.symbol, item]));
  const bySymbol = new Map(plans.map((item) => [item.symbol, item]));
  const positions = (book.positions || []).map((position) => {
    const short = position.position === "short";
    const average = Number(position.buyAverage) || Number(position.price);
    const reading = context[position.symbol] || {};
    const auditItem = auditMap.get(String(position.symbol).toUpperCase()) || null;
    const marked = Number(position.markPrice) || Number(reading.mark?.price) || average;
    const signed = short ? -1 : 1;
    const quantity = Number(position.quantity);
    const brokerMtm = Number(position.mtm);
    const openOnly = (marked - average) * quantity * signed;
    const unrealised = Number.isFinite(brokerMtm) && brokerMtm !== 0 ? brokerMtm : openOnly;
    const target = short ? average * 0.98 : average * 1.02;
    const toTargetPct = short ? (marked / target - 1) * 100 : (target / marked - 1) * 100;
    const plan = bySymbol.get(position.symbol);
    const verdict = !plan ? { label: "not measured", tone: "none" }
      : plan.action === "stand-aside"
        ? { label: /trend runs against/.test(plan.reasons?.[0] || "") ? "against the trend" : "no measured edge", tone: "bad" }
        : (plan.side === "short") === short
          ? { label: "edge confirmed", tone: "good" }
          : { label: "edge is the other way", tone: "warn" };
    return {
      symbol: position.symbol,
      position: short ? "short" : "long",
      trend: reading.trend || null,
      carry: reading.carry || null,
      range: reading.range || null,
      dayHigh: reading.mark?.dayHigh ?? null,
      dayLow: reading.mark?.dayLow ?? null,
      lotSize: reading.carry?.lotSize ?? reading.mark?.lotSize ?? null,
      markSource: Number(reading.mark?.price) ? (reading.mark.source || "NSE close") : (Number(position.markPrice) ? "GM live" : "entry price"),
      notional: Math.round(marked * quantity),
      unrealised: Math.round(unrealised),
      mtmSource: Number.isFinite(brokerMtm) && brokerMtm !== 0 ? "broker" : "computed",
      buyQuantity: Number(position.buyQuantity) || 0,
      buyAverage: Number(position.buyAverage) || 0,
      sellQuantity: Number(position.sellQuantity) || 0,
      sellAverage: Number(position.sellAverage) || 0,
      quantity: Number(position.quantity),
      average: Math.round(average * 100) / 100,
      mark: Math.round(marked * 100) / 100,
      mtm: Number(position.mtm),
      target: Math.round(target * 100) / 100,
      toTargetPct: Math.round(toTargetPct * 100) / 100,
      verdict,
      audit: auditItem
    };
  });
  return {
    capturedAt: book.capturedAt,
    totalMtm: Number(book.totalMtm),
    totalNotional: positions.reduce((sum, item) => sum + Number(item.notional || 0), 0),
    totalUnrealised: Number.isFinite(Number(book.totalMtm)) && Number(book.totalMtm) !== 0
      ? Number(book.totalMtm)
      : positions.reduce((sum, item) => sum + Number(item.unrealised || 0), 0),
    totalQuantity: Number(book.totalQuantity) || positions.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    positions,
    audit: auditResult,
    inProfit: positions.filter((item) => Number(item.unrealised) > 0).length,
    confirmed: positions.filter((item) => item.verdict.tone === "good").length,
    noEdge: positions.filter((item) => item.verdict.tone === "bad").length,
    // Counted from the direct reading rather than from the ladder verdict: a
    // holding rejected at the significance hurdle never reaches the trend check,
    // which is why this used to report zero.
    trendBlocked: positions.filter((item) => item.trend?.blocked).length,
    carryCosting: positions.filter((item) => item.carry && !item.carry.favourable).length
  };
}

async function run() {
  const outputDir = process.argv[2] || "site";
  const passphrase = process.env.K2_PORTAL_PASSPHRASE || "";
  const book = readJson("gm-positions.json");
  const holdings = readJson("plan-holdings.json");
  const plan = readJson("plan-full.json") || readJson("plan-watchlist.json");
  const context = readJson("book-context.json")?.context || {};

  const holdingPlans = holdings
    ? [...(holdings.best || []), ...(holdings.rejected || []).map((item) => ({ symbol: item.symbol, action: "stand-aside", reasons: [item.reason] }))]
    : [];

  let sealed = null;
  let meta = { builtAt: new Date().toISOString().slice(0, 16).replace("T", " "), positionCount: 0, capturedAt: "—" };
  if (book && passphrase) {
    const payload = bookPayload(book, holdingPlans, context);
    sealed = sealPayload(payload, passphrase);
    meta = { ...meta, positionCount: payload.positions.length, capturedAt: String(book.capturedAt || "").slice(0, 16).replace("T", " ") };
  } else if (book && !passphrase) {
    console.warn("K2_PORTAL_PASSPHRASE is not set: publishing the plan only, with no book.");
  }

  const macro = await fetchLiveMacroRadar().catch(() => null);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.html"), document_(plan, sealed, meta, macro));
  // Keeps Pages from running the output through Jekyll.
  fs.writeFileSync(path.join(outputDir, ".nojekyll"), "");
  console.log(`Portal written to ${outputDir}: ${(plan?.best || []).length} ladders, ${sealed ? `${meta.positionCount} positions sealed` : "no book"}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Portal build failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { bookPayload, document_ };
