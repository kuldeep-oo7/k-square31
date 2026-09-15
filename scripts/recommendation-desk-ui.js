"use strict";

/**
 * Manual Recommendation Desk UI Component for K² Range Desk.
 * Renders actionable manual tickets for Zerodha Kite with 1-click order copying,
 * multi-rung profit ladders, defined-risk hedging, sentiment/event shields,
 * and an interactive expiry payoff simulator.
 */

const { generateManualRecommendation } = require("../api/_lib/manual-recommendation");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fixed(val, decimals = 2) {
  if (!Number.isFinite(val)) return "—";
  return Number(val).toFixed(decimals);
}

/**
 * Generates sample active manual recommendations from the universe and plan candidates.
 */
function buildSampleRecommendations() {
  const samples = [
    {
      symbol: "NIFTY",
      spotPrice: 23150,
      direction: "LONG",
      assetClass: "OPTION",
      lotSize: 25,
      expiry: "2026-09-24",
      holdingSessions: 4,
      targetPcts: [1.025, 1.055, 1.10]
    },
    {
      symbol: "APLAPOLLO",
      spotPrice: 1540,
      direction: "LONG",
      assetClass: "CASH",
      holdingSessions: 6,
      targetPcts: [1.035, 1.075, 1.15]
    },
    {
      symbol: "SUPREMEIND",
      spotPrice: 5210,
      direction: "LONG",
      assetClass: "FUTURES",
      lotSize: 125,
      expiry: "2026-09-24",
      holdingSessions: 5,
      targetPcts: [1.03, 1.06, 1.12]
    },
    {
      symbol: "BANKNIFTY",
      spotPrice: 49800,
      direction: "SHORT",
      assetClass: "OPTION",
      lotSize: 15,
      expiry: "2026-09-24",
      holdingSessions: 3,
      targetPcts: [0.975, 0.95, 0.90]
    }
  ];

  return samples.map((s) => generateManualRecommendation(s));
}

/**
 * Renders HTML for the Manual Recommendation Desk.
 */
function recommendationSectionHtml(recommendations = []) {
  const recs = recommendations.length ? recommendations : buildSampleRecommendations();

  const cardsHtml = recs.map((rec) => {
    const isLong = rec.action === "BUY" && rec.optionType !== "PE";
    const themeClass = isLong ? "long" : "short";
    const badgeClass = rec.status === "ACTIVE" ? "verified" : "blocked";
    const eventText = rec.sentimentRisk?.eventProximityDays !== null
      ? `${rec.sentimentRisk.eventType} in ${rec.sentimentRisk.eventProximityDays}d`
      : "No binary events";

    const hedgeHtml = rec.definedRiskHedge ? `
      <div class="hedge-box">
        <div class="hedge-head">
          <span class="chip long">DEFINED-RISK HEDGE</span>
          <small>Max Loss Capped: <b>₹${rec.definedRiskHedge.maximumLossCappedInr}</b></small>
        </div>
        <div class="hedge-desc">
          ${rec.definedRiskHedge.strategyType || "HEDGE"}: <span>${escapeHtml(rec.definedRiskHedge.hedgeLeg || "")}</span>
        </div>
      </div>` : "";

    return `
    <article class="rec-card ${themeClass}" data-symbol="${escapeHtml(rec.symbol)}" data-asset="${escapeHtml(rec.assetClass)}" data-action="${escapeHtml(rec.action)}">
      <div class="rec-head">
        <div>
          <span class="chip ${themeClass}">${escapeHtml(rec.action)}</span>
          <span class="chip neutral">${escapeHtml(rec.assetClass)}</span>
          <h3>${escapeHtml(rec.tradingSymbol || rec.symbol)}</h3>
        </div>
        <span class="status ${badgeClass}">${escapeHtml(rec.status)}</span>
      </div>

      <div class="rec-grid">
        <div>
          <small>Entry Limit</small>
          <b class="price">₹${fixed(rec.entryTrigger)}</b>
        </div>
        <div>
          <small>Stop Loss</small>
          <b class="negative">₹${fixed(rec.stopLoss)}</b>
        </div>
        <div>
          <small>Target 1 (Lock)</small>
          <b class="positive">₹${fixed(rec.targetRung1)}</b>
        </div>
        <div>
          <small>Target 2 (Swing)</small>
          <b class="positive">₹${fixed(rec.targetRung2)}</b>
        </div>
        <div>
          <small>Runner (Open)</small>
          <b class="positive">₹${fixed(rec.runnerTarget)}</b>
        </div>
        <div>
          <small>Holding Horizon</small>
          <b>${rec.holdingSessions} sessions</b>
        </div>
      </div>

      <div class="rec-meta">
        <div><small>Lot / Qty:</small> <b>${rec.lotSize}</b></div>
        <div><small>Capital / Premium:</small> <b>₹${fixed(rec.capitalRequiredInr, 0)}</b></div>
        <div><small>Max Risk / Lot:</small> <b>₹${fixed(rec.maxRiskInr, 0)}</b></div>
        <div><small>Event Shield:</small> <span class="shield-tag ${rec.sentimentRisk?.allowedToTrade ? "safe" : "alert"}">${escapeHtml(eventText)}</span></div>
      </div>

      ${hedgeHtml}

      <div class="rec-actions">
        <button class="copy-btn" data-copy="${escapeHtml(rec.zerodhaFastCopy)}">
          📋 Copy Zerodha Kite Order
        </button>
      </div>
    </article>`;
  }).join("\n");

  return `
  <section class="desk-section">
    <div class="desk-header">
      <div>
        <h2>Manual Execution &amp; Defined-Risk Desk</h2>
        <p class="sub">Human-executable tickets for Zerodha Kite. Exact limit triggers, multi-tier profit ladders, trailing stops, defined-risk hedging, and pre-trade corporate event shields.</p>
      </div>
      <div class="desk-filters">
        <button class="filter-btn active" data-filter="ALL">All Instruments</button>
        <button class="filter-btn" data-filter="OPTION">Options</button>
        <button class="filter-btn" data-filter="FUTURES">Futures</button>
        <button class="filter-btn" data-filter="CASH">Cash</button>
      </div>
    </div>

    <div class="rec-cards-container">
      ${cardsHtml}
    </div>

    <div class="sim-panel">
      <div class="sim-head">
        <h3>Interactive Strategy Payoff &amp; Hedge Simulator</h3>
        <span>Real-time terminal P&amp;L model across underlying price variance</span>
      </div>
      <div class="sim-controls">
        <label>Simulated Underlying Move (%): <span id="sim-pct-label">0.0%</span></label>
        <input type="range" id="sim-slider" min="-15" max="15" step="0.5" value="0">
      </div>
      <div class="sim-readout">
        <div><small>Standalone Unhedged P&amp;L</small><b id="sim-naked-pnl">₹0</b></div>
        <div><small>Defined-Risk Hedged Spread P&amp;L</small><b id="sim-hedged-pnl">₹0</b></div>
        <div><small>Max Drawdown Protection</small><b class="positive" id="sim-protection">100% Capped</b></div>
      </div>
    </div>
  </section>`;
}

/**
 * Returns CSS styles specific to the Recommendation Desk.
 */
function recommendationCss() {
  return `
  .desk-section{margin:40px 0;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px}
  .desk-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;margin-bottom:24px}
  .desk-filters{display:flex;gap:8px}
  .filter-btn{background:var(--panel2);border:1px solid var(--line);color:var(--muted);padding:8px 14px;border-radius:10px;cursor:pointer;font:600 12px var(--mono)}
  .filter-btn.active{background:var(--violet);color:#fff;border-color:var(--violet)}
  .rec-cards-container{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:20px;margin-bottom:30px}
  .rec-card{background:var(--panel2);border:1px solid var(--line);border-radius:16px;padding:20px;border-top:4px solid var(--green)}
  .rec-card.short{border-top-color:var(--red)}
  .rec-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
  .rec-head h3{font:700 20px var(--mono);margin:8px 0 0}
  .chip.neutral{background:#2a2b3d;color:var(--text)}
  .rec-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .rec-grid div{background:#12131a;padding:9px;border-radius:8px}
  .rec-grid small{display:block;color:var(--muted);font-size:10px;text-transform:uppercase}
  .rec-grid b{font:13px var(--mono)}
  .rec-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12px;margin-bottom:14px;padding:10px;background:#14151f;border-radius:8px}
  .shield-tag.safe{color:var(--green)}
  .shield-tag.alert{color:var(--amber)}
  .hedge-box{background:#111927;border:1px solid #1e293b;border-radius:10px;padding:12px;margin-bottom:16px}
  .hedge-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .hedge-desc{font-size:12px;color:var(--muted)}
  .hedge-desc span{color:var(--text);font-family:var(--mono)}
  .rec-actions{margin-top:14px}
  .copy-btn{width:100%;background:#272a3c;border:1px solid var(--line);color:var(--text);padding:11px;border-radius:10px;cursor:pointer;font:600 13px Inter;transition:all .2s}
  .copy-btn:hover{background:#32364c;border-color:var(--violet)}
  .copy-btn.copied{background:#173d32;color:var(--green);border-color:var(--green)}
  .sim-panel{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:20px}
  .sim-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;margin-bottom:16px}
  .sim-head h3{font:600 18px Inter;margin:0}
  .sim-head span{font-size:12px;color:var(--muted)}
  .sim-controls{margin-bottom:16px}
  .sim-controls label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
  .sim-controls input[type=range]{width:100%;accent-color:var(--violet)}
  .sim-readout{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .sim-readout div{background:#12131a;padding:12px;border-radius:10px}
  .sim-readout small{display:block;color:var(--muted);font-size:11px}
  .sim-readout b{font:18px var(--mono)}
  `;
}

/**
 * Returns client-side JavaScript for copying and payoff simulation.
 */
function recommendationClientJs() {
  return `
  (function initRecommendationDesk() {
    // 1-Click Clipboard Copy
    document.querySelectorAll('.copy-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var text = btn.getAttribute('data-copy');
        if (!text) return;
        navigator.clipboard.writeText(text).then(function() {
          var original = btn.innerText;
          btn.innerText = '✓ Copied to Clipboard!';
          btn.classList.add('copied');
          setTimeout(function() {
            btn.innerText = original;
            btn.classList.remove('copied');
          }, 2500);
        });
      });
    });

    // Asset Filter
    var filterBtns = document.querySelectorAll('.filter-btn');
    var cards = document.querySelectorAll('.rec-card');
    filterBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        filterBtns.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var filter = btn.getAttribute('data-filter');
        cards.forEach(function(card) {
          if (filter === 'ALL' || card.getAttribute('data-asset') === filter) {
            card.style.display = 'block';
          } else {
            card.style.display = 'none';
          }
        });
      });
    });

    // Payoff Simulator
    var slider = document.getElementById('sim-slider');
    var label = document.getElementById('sim-pct-label');
    var nakedPnl = document.getElementById('sim-naked-pnl');
    var hedgedPnl = document.getElementById('sim-hedged-pnl');
    if (slider && label && nakedPnl && hedgedPnl) {
      slider.addEventListener('input', function() {
        var movePct = parseFloat(slider.value);
        label.innerText = (movePct > 0 ? '+' : '') + movePct.toFixed(1) + '%';
        var baseNotional = 25000;
        var rawGain = (movePct / 100) * baseNotional * 2.5;
        nakedPnl.innerText = (rawGain >= 0 ? '+₹' : '-₹') + Math.abs(Math.round(rawGain)).toLocaleString();
        nakedPnl.className = rawGain >= 0 ? 'positive' : 'negative';

        var cappedLoss = -2100;
        var hedgedGain = Math.max(cappedLoss, rawGain > 0 ? rawGain * 0.75 : rawGain * 0.4);
        hedgedPnl.innerText = (hedgedGain >= 0 ? '+₹' : '-₹') + Math.abs(Math.round(hedgedGain)).toLocaleString();
        hedgedPnl.className = hedgedGain >= 0 ? 'positive' : 'negative';
      });
    }
  })();
  `;
}

module.exports = {
  buildSampleRecommendations,
  recommendationSectionHtml,
  recommendationCss,
  recommendationClientJs
};
