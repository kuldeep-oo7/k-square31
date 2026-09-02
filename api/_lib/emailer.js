"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_RECIPIENT = "kuldeepsavaliya70@gmail.com";

// Auto-load .env.local if present
const envLocal = path.resolve(__dirname, "../../.env.local");
if (fs.existsSync(envLocal)) {
  const lines = fs.readFileSync(envLocal, "utf8").split("\n");
  for (const line of lines) {
    const [k, ...v] = line.trim().split("=");
    if (k && v.length && !process.env[k]) process.env[k] = v.join("=");
  }
}

/**
 * Builds an ultra high-contrast, responsive, mobile-first HTML email briefing.
 */
function buildEmailHtml({
  dateStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
  radar = {},
  macroAssets = [],
  sells = [],
  buys = [],
  shortsAndPuts = [],
  holds = []
}) {
  const isBloodbath = radar.severity === "CRITICAL_BLOODBATH";
  const isElevated = radar.severity === "ELEVATED_RISK";

  const radarBorder = isBloodbath ? "#dc2626" : isElevated ? "#d97706" : "#059669";
  const radarBg = isBloodbath ? "#fef2f2" : isElevated ? "#fffbeb" : "#ecfdf5";
  const radarTitleColor = isBloodbath ? "#991b1b" : isElevated ? "#92400e" : "#065f46";
  const radarBadgeText = isBloodbath ? "CRITICAL BLOOD BATH SHIELD ACTIVE" : isElevated ? "ELEVATED RISK SHIELD ACTIVE" : "GLOBAL MARKET REGIME: STABLE";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>K² Range Desk Daily Briefing</title>
<style>
  body {
    margin: 0;
    padding: 16px 8px;
    background-color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a;
    -webkit-font-smoothing: antialiased;
  }
  .wrapper {
    max-width: 720px;
    margin: 0 auto;
    background-color: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(15, 23, 42, 0.08);
    overflow: hidden;
  }
  .masthead {
    background-color: #0f172a;
    color: #ffffff;
    padding: 24px 20px;
    text-align: left;
  }
  .masthead h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 6px 0;
    color: #ffffff;
    line-height: 1.2;
  }
  .masthead .sub {
    font-size: 12px;
    color: #94a3b8;
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    line-height: 1.4;
  }
  .content {
    padding: 20px 16px;
  }
  .radar-card {
    background-color: ${radarBg};
    border-left: 5px solid ${radarBorder};
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 24px;
  }
  .radar-title {
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${radarTitleColor};
    margin: 0 0 4px 0;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  }
  .radar-desc {
    font-size: 14px;
    color: #334155;
    margin: 0;
    line-height: 1.5;
  }
  .section-header {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 28px 0 12px 0;
    padding-bottom: 6px;
    border-bottom: 2px solid #e2e8f0;
  }
  .sh-red { color: #dc2626; border-color: #fca5a5; }
  .sh-green { color: #047857; border-color: #6ee7b7; }
  .sh-blue { color: #1d4ed8; border-color: #93c5fd; }
  .sh-purple { color: #7c3aed; border-color: #c4b5fd; }
  .sh-amber { color: #b45309; border-color: #fcd34d; }

  /* Mobile-first card elements */
  .stock-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  }
  .card-exit { border-left: 4px solid #dc2626; background: #fffbfb; }
  .card-buy { border-left: 4px solid #059669; background: #fbfdfc; }
  .card-hold { border-left: 4px solid #d97706; background: #fffdfa; }
  .card-short { border-left: 4px solid #2563eb; background: #fbfdff; }

  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .ticker {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 16px;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: 0.02em;
  }
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 5px;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .badge-sell { background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .badge-buy { background-color: #dcfce7; color: #166534; border: 1px solid #86efac; }
  .badge-level { background-color: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }
  .badge-hold { background-color: #fef3c7; color: #92400e; border: 1px solid #fde68a; }

  .data-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
    margin-top: 6px;
    font-size: 13px;
  }
  .data-item {
    background: #f8fafc;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid #f1f5f9;
  }
  .data-label {
    font-size: 11px;
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
    display: block;
    margin-bottom: 2px;
  }
  .data-val {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
  }
  .val-green { color: #047857; }
  .val-red { color: #b91c1c; }
  .val-amber { color: #b45309; }

  .reason-box {
    margin-top: 8px;
    padding: 8px 10px;
    background: #fef2f2;
    border-radius: 6px;
    font-size: 12.5px;
    color: #991b1b;
    font-weight: 500;
    line-height: 1.4;
  }

  .table-scroll {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin-bottom: 16px;
  }
  table {
    width: 100%;
    min-width: 500px;
    border-collapse: collapse;
  }
  th {
    background-color: #f8fafc;
    color: #475569;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    text-align: left;
    padding: 8px 10px;
    border-bottom: 2px solid #cbd5e1;
  }
  td {
    padding: 10px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 13px;
    color: #1e293b;
    vertical-align: middle;
  }
  th.n, td.n { text-align: right; }

  .footer {
    background-color: #f8fafc;
    border-top: 1px solid #e2e8f0;
    padding: 20px 16px;
    font-size: 12px;
    color: #64748b;
    line-height: 1.6;
    text-align: center;
  }

  @media only screen and (max-width: 600px) {
    body { padding: 4px 2px; }
    .wrapper { border-radius: 8px; }
    .masthead { padding: 18px 14px; }
    .masthead h1 { font-size: 19px; }
    .content { padding: 14px 10px; }
    .data-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<div class="wrapper">
  <div class="masthead">
    <h1>K² Range Desk · Daily Trade Briefing</h1>
    <div class="sub">SESSION: ${dateStr.toUpperCase()}<br>RECIPIENT: ${DEFAULT_RECIPIENT}</div>
  </div>

  <div class="content">
    <!-- Macro Radar Header -->
    <div class="radar-card">
      <div class="radar-title">🛡️ ${radarBadgeText}</div>
      <p class="radar-desc">${radar.summary || "Global macro drivers are within operating boundaries. Normal risk management rules apply."}</p>
    </div>

    <!-- Section 1: Exits & Sells -->
    ${sells.length ? `
    <div class="section-header sh-red">🚨 1. IMMEDIATE EXITS & SELLS (ACTION AT 9:15 AM OPEN)</div>
    ${sells.map(s => `
      <div class="stock-card card-exit">
        <div class="card-top">
          <span class="ticker">${s.symbol}</span>
          <span class="badge badge-sell">SELL AT OPEN</span>
        </div>
        <div class="data-grid">
          <div class="data-item">
            <span class="data-label">Exit Level</span>
            <span class="data-val val-red">₹${s.price ? s.price.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Action</span>
            <span class="data-val val-red">CUT / PROTECT</span>
          </div>
        </div>
        <div class="reason-box">⚠️ <b>Risk Rationale:</b> ${s.reason}</div>
      </div>
    `).join("")}
    ` : ""}

    <!-- Section 2: Buy Setups -->
    ${buys.length ? `
    <div class="section-header sh-green">🎯 2. QUALIFIED BUY SETUPS (TODAY'S LADDERS)</div>
    ${buys.map(b => `
      <div class="stock-card card-buy">
        <div class="card-top">
          <span class="ticker">${b.symbol}</span>
          <span class="badge badge-level">LEVEL ${b.level || 1}</span>
        </div>
        <div class="data-grid">
          <div class="data-item">
            <span class="data-label">Buy Entry</span>
            <span class="data-val">₹${b.entry ? b.entry.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Max Buy Cap (+0.8%)</span>
            <span class="data-val">₹${b.maxCap ? b.maxCap.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Sell Target 1</span>
            <span class="data-val val-green">₹${b.target ? b.target.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Stop Loss</span>
            <span class="data-val val-red">₹${b.stop ? b.stop.toFixed(2) : "—"}</span>
          </div>
        </div>
      </div>
    `).join("")}
    ` : ""}

    <!-- Section 3: Shorts & Hedges -->
    ${shortsAndPuts.length ? `
    <div class="section-header sh-blue">📉 3. SHORT LADDERS & INDEX PUT HEDGES (PE)</div>
    ${shortsAndPuts.map(p => `
      <div class="stock-card card-short">
        <div class="card-top">
          <span class="ticker">${p.name}</span>
          <span class="badge badge-sell">${p.action}</span>
        </div>
        <div class="data-grid">
          <div class="data-item">
            <span class="data-label">Strike / Entry</span>
            <span class="data-val">₹${p.entry ? p.entry.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Target Exit</span>
            <span class="data-val val-green">₹${p.target ? p.target.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Stop Loss</span>
            <span class="data-val val-red">₹${p.stop ? p.stop.toFixed(2) : "—"}</span>
          </div>
        </div>
      </div>
    `).join("")}
    ` : ""}

    <!-- Section 4: Existing Open Holdings -->
    ${holds.length ? `
    <div class="section-header sh-amber">🛡️ 4. OPEN HOLDINGS & TRAILING STOPS</div>
    ${holds.map(h => `
      <div class="stock-card card-hold">
        <div class="card-top">
          <span class="ticker">${h.symbol}</span>
          <span class="badge ${h.status === 'SELL AT OPEN' ? 'badge-sell' : 'badge-hold'}">${h.status}</span>
        </div>
        <div class="data-grid">
          <div class="data-item">
            <span class="data-label">Mark Price</span>
            <span class="data-val">₹${h.current ? h.current.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Trailing Stop</span>
            <span class="data-val val-amber">₹${h.trailingStop ? h.trailingStop.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Target 1</span>
            <span class="data-val val-green">₹${h.target ? h.target.toFixed(2) : "—"}</span>
          </div>
          <div class="data-item">
            <span class="data-label">P&L Status</span>
            <span class="data-val ${h.pnlPct >= 0 ? 'val-green' : 'val-red'}">${h.pnlPct ? (h.pnlPct >= 0 ? '+' : '') + h.pnlPct.toFixed(2) + '%' : '0.00%'}</span>
          </div>
        </div>
      </div>
    `).join("")}
    ` : ""}

    <!-- Section 5: Global Macro Assets Table (Horizontal scroll on mobile) -->
    ${macroAssets.length ? `
    <div class="section-header sh-purple">🌐 GLOBAL MACRO & WAR RADAR (9 KEY DRIVERS)</div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Ticker</th>
            <th class="n">Price</th>
            <th class="n">Change</th>
            <th>Impact</th>
            <th>Threat</th>
          </tr>
        </thead>
        <tbody>
          ${macroAssets.map(m => `
            <tr>
              <td><b>${m.name}</b></td>
              <td><code>${m.ticker}</code></td>
              <td class="n">${m.price ? (m.price >= 1000 ? m.price.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : m.price.toFixed(2)) : "—"}</td>
              <td class="n"><span style="font-weight:700;color:${m.threat === 'ELEVATED' || m.threat === 'CRITICAL' ? '#b91c1c' : '#047857'}">${m.changePct ? (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2) + '%' : '0.00%'}</span></td>
              <td style="font-size:12px;color:#475569;">${m.impact}</td>
              <td><span class="badge ${m.threat === 'CRITICAL' ? 'badge-sell' : m.threat === 'ELEVATED' ? 'badge-hold' : 'badge-buy'}">${m.threat || 'NORMAL'}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ` : ""}
  </div>

  <div class="footer">
    Sent by <b>K² Range Desk Quantitative Decision Engine</b> to <b>${DEFAULT_RECIPIENT}</b>.<br>
    Mathematical safeguards active: Black-Scholes-Merton PDE, Hurst Fractal Dimension ($H$), VPIN Flow Toxicity, and Classical Structure Recognition.
  </div>
</div>
</body>
</html>`;
}

/**
 * Saves report locally and dispatches email via Google Apps Script Webhook.
 */
async function sendDailyTradeEmail(payload) {
  const html = buildEmailHtml(payload);
  const outDir = path.resolve(__dirname, "../../exports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "daily-trade-email.html");
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`\nDaily trade email report generated: file:///${outPath.replace(/\\\\/g, "/")}`);

  const webhookUrl = process.env.K2_EMAIL_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      console.log(`Sending mobile-optimized executive briefing to ${DEFAULT_RECIPIENT} via Webhook...`);
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: DEFAULT_RECIPIENT,
          subject: `⚡ K² Desk Briefing: ${payload.dateStr || "Today"} (${payload.radar?.severity || "NORMAL"})`,
          html
        })
      });
      const text = await response.text();
      console.log(`Google Webhook response: ${text.slice(0, 150)}`);
      return { success: true, method: "google_apps_script", recipient: DEFAULT_RECIPIENT };
    } catch (e) {
      console.warn("Google Apps Script Webhook dispatch failed:", e.message);
    }
  } else {
    console.log("Tip: Set K2_EMAIL_WEBHOOK_URL in environment or GitHub Secrets to enable automatic Gmail delivery.");
  }

  return { success: true, method: "local_html_ready", file: outPath, recipient: DEFAULT_RECIPIENT };
}

module.exports = {
  DEFAULT_RECIPIENT,
  buildEmailHtml,
  sendDailyTradeEmail
};
