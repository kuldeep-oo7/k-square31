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
 * Builds an ultra high-contrast, institutional research-grade HTML email briefing.
 */
function buildEmailHtml({
  dateStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
  radar = {},
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>K² Range Desk Intelligence</title>
<style>
  body {
    margin: 0;
    padding: 24px 12px;
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
    border-radius: 16px;
    box-shadow: 0 4px 20px rgba(15, 23, 42, 0.08);
    overflow: hidden;
  }
  .masthead {
    background-color: #0f172a;
    color: #ffffff;
    padding: 28px 32px;
  }
  .masthead h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 26px;
    font-weight: 700;
    margin: 0 0 6px 0;
    letter-spacing: -0.02em;
    color: #ffffff;
  }
  .masthead .sub {
    font-size: 13px;
    color: #94a3b8;
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  }
  .content {
    padding: 28px 32px;
  }
  .radar-card {
    background-color: ${radarBg};
    border-left: 5px solid ${radarBorder};
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 28px;
  }
  .radar-title {
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
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
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    margin: 28px 0 12px 0;
    padding-bottom: 8px;
    border-bottom: 2px solid #e2e8f0;
  }
  .sh-red { color: #dc2626; border-color: #fca5a5; }
  .sh-green { color: #047857; border-color: #6ee7b7; }
  .sh-blue { color: #1d4ed8; border-color: #93c5fd; }
  .sh-amber { color: #b45309; border-color: #fcd34d; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 24px;
  }
  th {
    background-color: #f8fafc;
    color: #475569;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 2px solid #cbd5e1;
  }
  th.n, td.n { text-align: right; }
  td {
    padding: 12px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 13.5px;
    color: #1e293b;
    vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background-color: #f8fafc; }

  /* High-Contrast Stock Tickers - Black, Bold, Monospace */
  .stock-ticker {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 15px;
    font-weight: 800;
    color: #0f172a !important;
    letter-spacing: 0.02em;
    display: inline-block;
  }
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 6px;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    margin-left: 6px;
    vertical-align: middle;
  }
  .badge-buy { background-color: #dcfce7; color: #15803d; border: 1px solid #86efac; }
  .badge-sell { background-color: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
  .badge-level { background-color: #dbeafe; color: #1d4ed8; border: 1px solid #bfdbfe; }
  .badge-hold { background-color: #fef3c7; color: #b45309; border: 1px solid #fde68a; }

  .price-entry { font-family: ui-monospace, Consolas, monospace; font-weight: 800; font-size: 14.5px; color: #0f172a; }
  .price-cap { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #334155; font-weight: 700; }
  .price-target { font-family: ui-monospace, Consolas, monospace; font-weight: 800; font-size: 14px; color: #047857; }
  .price-stop { font-family: ui-monospace, Consolas, monospace; font-weight: 800; font-size: 14px; color: #b91c1c; }

  .footer {
    background-color: #f8fafc;
    border-top: 1px solid #e2e8f0;
    padding: 20px 32px;
    font-size: 12px;
    color: #64748b;
    line-height: 1.6;
    text-align: center;
  }
</style>
</head>
<body>
<div class="wrapper">
  <div class="masthead">
    <h1>K² Range Desk · Daily Trade Briefing</h1>
    <div class="sub">SESSION: ${dateStr.toUpperCase()} · RECIPIENT: ${DEFAULT_RECIPIENT}</div>
  </div>

  <div class="content">
    <div class="radar-card">
      <div class="radar-title">🛡️ ${radarBadgeText}</div>
      <p class="radar-desc">${radar.summary || "All global macro drivers (GIFT Nifty, India VIX, Brent Crude, US Futures) are within standard operating thresholds. Normal trade execution authorized."}</p>
    </div>

    ${sells.length ? `
    <div class="section-header sh-red">🚨 1. IMMEDIATE EXITS & SELLS (ACTION AT 9:15 AM OPEN)</div>
    <table>
      <thead>
        <tr>
          <th>Stock Instrument</th>
          <th>Action</th>
          <th class="n">Exit Price</th>
          <th>Risk Rationale</th>
        </tr>
      </thead>
      <tbody>
        ${sells.map(s => `
          <tr>
            <td><span class="stock-ticker">${s.symbol}</span></td>
            <td><span class="badge badge-sell">SELL AT OPEN</span></td>
            <td class="n"><span class="price-stop">₹${s.price?.toFixed(2) || "—"}</span></td>
            <td style="color:#b91c1c;font-weight:600;">${s.reason}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ` : ""}

    ${buys.length ? `
    <div class="section-header sh-green">🎯 2. QUALIFIED BUY SETUPS (TODAY'S LADDERS)</div>
    <table>
      <thead>
        <tr>
          <th>Instrument</th>
          <th>Level</th>
          <th class="n">Buy Entry</th>
          <th class="n">Max Buy Cap (+0.8%)</th>
          <th class="n">Sell Target 1</th>
          <th class="n">Stop Loss</th>
        </tr>
      </thead>
      <tbody>
        ${buys.map(b => `
          <tr>
            <td><span class="stock-ticker">${b.symbol}</span></td>
            <td><span class="badge badge-level">L${b.level || 1}</span></td>
            <td class="n"><span class="price-entry">₹${b.entry?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-cap">₹${b.maxCap?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-target">₹${b.target?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-stop">₹${b.stop?.toFixed(2) || "—"}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ` : ""}

    ${shortsAndPuts.length ? `
    <div class="section-header sh-blue">📉 3. SHORT LADDERS & INDEX PUT OPTION HEDGING (PE)</div>
    <table>
      <thead>
        <tr>
          <th>Instrument / Option Contract</th>
          <th>Type</th>
          <th class="n">Entry Strike / Price</th>
          <th class="n">Target Exit</th>
          <th class="n">Stop Loss</th>
        </tr>
      </thead>
      <tbody>
        ${shortsAndPuts.map(p => `
          <tr>
            <td><span class="stock-ticker">${p.name}</span></td>
            <td><span class="badge badge-sell">${p.action}</span></td>
            <td class="n"><span class="price-entry">₹${p.entry?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-target">₹${p.target?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-stop">₹${p.stop?.toFixed(2) || "—"}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ` : ""}

    ${holds.length ? `
    <div class="section-header sh-amber">🛡️ 4. YOUR EXISTING OPEN HOLDINGS (MONITORING & TRAILING STOPS)</div>
    <table>
      <thead>
        <tr>
          <th>Holding Instrument</th>
          <th>Status</th>
          <th class="n">Current Price</th>
          <th class="n">Trailing Stop-Loss</th>
          <th class="n">Target 1</th>
        </tr>
      </thead>
      <tbody>
        ${holds.map(h => `
          <tr>
            <td><span class="stock-ticker">${h.symbol}</span></td>
            <td><span class="badge badge-hold">${h.status}</span></td>
            <td class="n"><span class="price-entry">₹${h.current?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-stop" style="color:#b45309;">₹${h.trailingStop?.toFixed(2) || "—"}</span></td>
            <td class="n"><span class="price-target">₹${h.target?.toFixed(2) || "—"}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ` : ""}
  </div>

  <div class="footer">
    Sent by <b>K² Range Desk Quantitative Engine</b> to <b>${DEFAULT_RECIPIENT}</b>.<br>
    Mathematical foundations: Black-Scholes-Merton PDE, Hurst Fractal Dimension, Kaufman Efficiency Ratio & Volume-Synchronized Probability of Informed Trading (VPIN).
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
      console.log(`Sending high-contrast executive email to ${DEFAULT_RECIPIENT} via Google Apps Script Webhook...`);
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
