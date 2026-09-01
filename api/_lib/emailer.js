"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const DEFAULT_RECIPIENT = "kuldeepsavaliya70@gmail.com";

/**
 * Builds a beautifully styled HTML trade recommendation and threat email.
 */
function buildEmailHtml({
  dateStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
  radar = {},
  sells = [],
  buys = [],
  shortsAndPuts = [],
  holds = []
}) {
  const radarTone = radar.severity === "CRITICAL_BLOODBATH" ? "#dc2626" : radar.severity === "ELEVATED_RISK" ? "#d97706" : "#16a34a";
  const radarBadge = radar.severity === "CRITICAL_BLOODBATH" ? "🔴 CRITICAL BLOOD BATH" : radar.severity === "ELEVATED_RISK" ? "🟡 ELEVATED RISK" : "🟢 STABLE / NORMAL REGIME";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f111a; color: #e2e8f0; margin: 0; padding: 20px; }
  .box { max-width: 680px; margin: 0 auto; background: #1a1d2e; border: 1px solid #2d334d; border-radius: 14px; padding: 24px; }
  .header { border-bottom: 1px solid #2d334d; padding-bottom: 16px; margin-bottom: 20px; }
  .title { font-size: 22px; font-weight: 800; color: #fff; margin: 0; }
  .sub { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .radar-card { background: #131625; border-left: 4px solid ${radarTone}; padding: 14px 16px; border-radius: 8px; margin-bottom: 24px; }
  .radar-title { font-size: 14px; font-weight: 700; color: ${radarTone}; margin-bottom: 6px; }
  .radar-desc { font-size: 13px; color: #cbd5e1; margin: 0; }
  .sec-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin: 20px 0 10px; display: flex; align-items: center; gap: 8px; }
  .red { color: #f87171; }
  .green { color: #4ade80; }
  .purple { color: #c084fc; }
  .yellow { color: #facc15; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #232840; color: #94a3b8; font-size: 11px; text-transform: uppercase; }
  td { padding: 10px; border-bottom: 1px solid #232840; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: monospace; }
  .b-red { background: rgba(239, 68, 68, 0.2); color: #f87171; }
  .b-green { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
  .b-blue { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #2d334d; font-size: 11px; color: #64748b; text-align: center; }
</style>
</head>
<body>
<div class="box">
  <div class="header">
    <h1 class="title">⚡ K² Range Desk · Daily Trade Alert</h1>
    <div class="sub">Market Actionable Report for <b>${dateStr}</b> · Target Recipient: ${DEFAULT_RECIPIENT}</div>
  </div>

  <div class="radar-card">
    <div class="radar-title">${radarBadge}</div>
    <p class="radar-desc">${radar.summary || "GIFT Nifty, VIX, and Brent Crude Oil within stable baseline limits."}</p>
  </div>

  ${sells.length ? `
  <div class="sec-title red">🚨 WHAT TO SELL / EXIT IMMEDIATELY</div>
  <table>
    <tr><th>Stock</th><th>Action</th><th>Price / Stop</th><th>Reason</th></tr>
    ${sells.map(s => `
      <tr>
        <td><b>${s.symbol}</b></td>
        <td><span class="badge b-red">SELL AT OPEN</span></td>
        <td>₹${s.price?.toFixed(2) || "—"}</td>
        <td style="color:#f87171;">${s.reason}</td>
      </tr>
    `).join("")}
  </table>
  ` : ""}

  ${buys.length ? `
  <div class="sec-title green">🎯 WHAT TO BUY (FRESH LADDERS)</div>
  <table>
    <tr><th>Stock</th><th>Level</th><th>Buy Entry</th><th>Max Cap (+0.8%)</th><th>Target 1</th><th>Stop Loss</th></tr>
    ${buys.map(b => `
      <tr>
        <td><b>${b.symbol}</b></td>
        <td><span class="badge b-blue">L${b.level || 1}</span></td>
        <td style="color:#4ade80;font-weight:700;">₹${b.entry?.toFixed(2) || "—"}</td>
        <td>₹${b.maxCap?.toFixed(2) || "—"}</td>
        <td style="color:#4ade80;">₹${b.target?.toFixed(2) || "—"}</td>
        <td style="color:#f87171;">₹${b.stop?.toFixed(2) || "—"}</td>
      </tr>
    `).join("")}
  </table>
  ` : ""}

  ${shortsAndPuts.length ? `
  <div class="sec-title purple">📉 WHAT TO SHORT & WHICH PUT OPTIONS (PE)</div>
  <table>
    <tr><th>Instrument / PE Contract</th><th>Action</th><th>Strike / Entry</th><th>Target</th><th>Stop</th></tr>
    ${shortsAndPuts.map(p => `
      <tr>
        <td><b>${p.name}</b></td>
        <td><span class="badge b-red">${p.action}</span></td>
        <td>₹${p.entry?.toFixed(2) || "—"}</td>
        <td style="color:#4ade80;">₹${p.target?.toFixed(2) || "—"}</td>
        <td style="color:#f87171;">₹${p.stop?.toFixed(2) || "—"}</td>
      </tr>
    `).join("")}
  </table>
  ` : ""}

  ${holds.length ? `
  <div class="sec-title yellow">🛡️ EXISTING HOLDINGS & TRAILING STOPS</div>
  <table>
    <tr><th>Stock</th><th>Status</th><th>Current</th><th>Trailing Stop</th><th>Target 1</th></tr>
    ${holds.map(h => `
      <tr>
        <td><b>${h.symbol}</b></td>
        <td><span class="badge ${h.status.includes('HOLD') ? 'b-green' : 'b-blue'}">${h.status}</span></td>
        <td>₹${h.current?.toFixed(2) || "—"}</td>
        <td style="color:#facc15;font-weight:700;">₹${h.trailingStop?.toFixed(2) || "—"}</td>
        <td style="color:#4ade80;">₹${h.target?.toFixed(2) || "—"}</td>
      </tr>
    `).join("")}
  </table>
  ` : ""}

  <div class="footer">
    Sent automatically by K² Range Desk Quantitative Engine to ${DEFAULT_RECIPIENT}.<br>
    All calculations backed by BSM Trillion Dollar Equation, Hurst Exponent & Meta-Labeling.
  </div>
</div>
</body>
</html>`;
}

/**
 * Saves report locally and attempts email dispatch via Google Apps Script Webhook.
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
      console.log(`Sending email to ${DEFAULT_RECIPIENT} via Google Apps Script Webhook...`);
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: DEFAULT_RECIPIENT,
          subject: `⚡ K² Desk Trade Alert: ${payload.dateStr || "Today"} (${payload.radar?.severity || "NORMAL"})`,
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
