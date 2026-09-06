"use strict";

/**
 * Builds the comprehensive paper trading / shadow performance dashboard.
 * Outputs:
 *   publish/shadow-report.json
 *   publish/shadow-report.html
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadShadowLedger } = require("../api/_lib/shadow-ledger");
const { round } = require("../api/_lib/shadow-broker");

function buildShadowReport() {
  const ledger = loadShadowLedger();
  const closed = ledger.closedTrades || [];
  const openPositions = ledger.positions || [];

  const totalTrades = closed.length;
  const wins = closed.filter((t) => t.netRealizedPnl > 0);
  const losses = closed.filter((t) => t.netRealizedPnl <= 0);

  const totalNetPnl = round(closed.reduce((sum, t) => sum + t.netRealizedPnl, 0));
  const totalGrossPnl = round(closed.reduce((sum, t) => sum + (t.grossPnl || 0), 0));
  const totalTaxesPaid = round(closed.reduce((sum, t) => sum + (t.totalTaxesAndCharges || 0), 0));

  const winRatePct = totalTrades > 0 ? round((wins.length / totalTrades) * 100, 1) : 0;
  const totalWinPnl = wins.reduce((sum, t) => sum + t.netRealizedPnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((sum, t) => sum + t.netRealizedPnl, 0));
  const profitFactor = totalLossPnl > 0 ? round(totalWinPnl / totalLossPnl, 2) : totalWinPnl > 0 ? 99.0 : 1.0;

  const report = {
    generatedAt: new Date().toISOString(),
    accountEquity: ledger.accountEquity,
    availableMargin: ledger.availableMargin,
    totalTrades,
    openPositionsCount: openPositions.length,
    winsCount: wins.length,
    lossesCount: losses.length,
    winRatePct,
    profitFactor,
    totalGrossPnl,
    totalTaxesPaid,
    totalNetPnl,
    openPositions,
    closedTrades: closed.slice(-50), // last 50
    contractNotesSummary: (ledger.contractNotes || []).slice(-20)
  };

  const publishDir = path.resolve(__dirname, "../publish");
  if (!fs.existsSync(publishDir)) fs.mkdirSync(publishDir, { recursive: true });

  const jsonPath = path.join(publishDir, "shadow-report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>K² Range Desk - Shadow Operations Performance Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #e2e8f0; margin: 0; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; }
    .header { border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
    .title { font-size: 24px; font-weight: 700; color: #38bdf8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    .card-label { font-size: 12px; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px; }
    .card-value { font-size: 22px; font-weight: 700; }
    .positive { color: #4ade80; }
    .negative { color: #f87171; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; font-size: 13px; }
    th { background: #0f172a; color: #94a3b8; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">K² Range Desk · Shadow Operations & Paper Trading Ledger</div>
      <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Verified Institutional NSE Stock Futures Performance Tracking (Gate B)</div>
    </div>
    <div class="grid">
      <div class="card">
        <div class="card-label">Account Equity</div>
        <div class="card-value">₹${report.accountEquity.toLocaleString("en-IN")}</div>
      </div>
      <div class="card">
        <div class="card-label">Net Realized P&L</div>
        <div class="card-value ${report.totalNetPnl >= 0 ? "positive" : "negative"}">₹${report.totalNetPnl.toLocaleString("en-IN")}</div>
      </div>
      <div class="card">
        <div class="card-label">Win Rate</div>
        <div class="card-value">${report.winRatePct}% (${report.winsCount}W / ${report.lossesCount}L)</div>
      </div>
      <div class="card">
        <div class="card-label">Total Taxes & Slippage</div>
        <div class="card-value negative">₹${report.totalTaxesPaid.toLocaleString("en-IN")}</div>
      </div>
      <div class="card">
        <div class="card-label">Profit Factor</div>
        <div class="card-value">${report.profitFactor}</div>
      </div>
      <div class="card">
        <div class="card-label">Open Shadow Positions</div>
        <div class="card-value">${report.openPositionsCount}</div>
      </div>
    </div>

    <h3 style="color: #f1f5f9; margin-top: 32px;">Active Shadow Positions (Carried Continuously)</h3>
    ${openPositions.length === 0 ? "<p style='color: #64748b;'>No open shadow positions.</p>" : `
    <table>
      <thead>
        <tr>
          <th>Contract</th>
          <th>Side</th>
          <th>Entry Price</th>
          <th>Weekly Ref Price</th>
          <th>Target</th>
          <th>Stop Loss</th>
          <th>Quantity</th>
          <th>Sessions Held</th>
        </tr>
      </thead>
      <tbody>
        ${openPositions.map((p) => `
        <tr>
          <td><strong>${p.contractSymbol}</strong></td>
          <td>${p.side}</td>
          <td>₹${p.originalEntryPrice.toFixed(2)}</td>
          <td>₹${p.weeklyReferencePrice.toFixed(2)}</td>
          <td class="positive">₹${p.targetPrice.toFixed(2)}</td>
          <td class="negative">₹${p.stopLossPrice.toFixed(2)}</td>
          <td>${p.quantity}</td>
          <td>${p.holdingSessions}</td>
        </tr>`).join("")}
      </tbody>
    </table>`}
  </div>
</body>
</html>`;

  const htmlPath = path.join(publishDir, "shadow-report.html");
  fs.writeFileSync(htmlPath, html, "utf8");

  console.log(`Shadow report generated: ${jsonPath} and ${htmlPath}`);
  return report;
}

if (require.main === module) {
  buildShadowReport();
}

module.exports = { buildShadowReport };
