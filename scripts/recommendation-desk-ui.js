"use strict";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fixed = (val, d = 2) => Number.isFinite(val) ? Number(val).toFixed(d) : "—";

function buildSampleRecommendations() {
  return [];
}

/**
 * Verified active quantitative research dataset covering Large, Mid, Small Caps,
 * Index Options, Stock Options (Defined-Risk Spreads), and Cash Equities.
 */
/**
 * Research setups to publish.
 *
 * This function previously returned a literal array of twelve trades with
 * hand-written prices, entry triggers, targets, stops, "TARGET 1 HIT" statuses,
 * hedge legs, "Hard-Capped" max-risk figures and quant blocks reading
 * vpin "0.128", hurst "0.59", halfLife "4.5 sessions". None of those numbers
 * were measured by the scanner that displayed them.
 *
 * The forensic audit of 2026-09-17 11:51 recorded exactly this as finding F01
 * and its fix as "no synthetic default cards, no guessed scores, no copyable
 * live tickets". buildSampleRecommendations was duly emptied. Thirty-one
 * minutes later, commit 075ccb8 added THIS function beside it holding the same
 * fabricated content, and the published portal carried it from then on. The
 * identical figures also reached the Apex SQLite ledger as seeded rows --
 * RELIANCE26SEP1240CE at 21.95/29.63/8.34 appears verbatim in both -- and the
 * disputed profit table is built from the same set.
 *
 * It now renders the recommendations it is given and nothing else.
 */
function getActiveResearchSetups(recommendations = []) {
  return Array.isArray(recommendations) ? recommendations.filter(Boolean) : [];
}

function recommendationSectionHtml(recommendations = [], monitorUrl = "") {
  let endpoint = "";
  try { const u = new URL(monitorUrl); if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) endpoint = u.href.replace(/\/$/, ""); } catch {}

  const setups = getActiveResearchSetups(recommendations);

  const cardsHtml = setups.map(item => {
    const isCall = item.optionType === "CE";
    const isPut = item.optionType === "PE";
    const isFut = item.assetClass === "FUTURES";
    const themeClass = isPut ? "short" : "long";
    const chipText = isPut ? "PUT SPREAD" : isCall ? "CALL SPREAD" : isFut ? "FUTURES" : "CASH DELIVERY";

    return `
      <article class="rec-card ${themeClass}">
        <div class="rec-header">
          <div>
            <span class="chip ${themeClass}">${chipText} · ${esc(item.marketCap)}</span>
            <h3>${esc(item.tradingSymbol)}</h3>
            <span class="spot-live">Spot: ₹${fixed(item.underlyingPrice)} | Entry: ₹${fixed(item.entryTrigger)}</span>
          </div>
          <span class="status ${themeClass}">${esc(item.action)}</span>
        </div>

        <div class="rec-grid">
          <div><small>Target 1</small><b class="positive">₹${fixed(item.target1)}</b></div>
          <div><small>Target 2</small><b class="positive">₹${fixed(item.target2)}</b></div>
          <div><small>Stop Loss</small><b class="negative">₹${fixed(item.stopLoss)}</b></div>
          <div><small>Lot Size / Qty</small><b>${esc(item.lotSize)}</b></div>
          <div><small>Capital Est.</small><b>₹${item.capitalRequired ? Number(item.capitalRequired).toLocaleString('en-IN') : '—'}</b></div>
          <div><small>VPIN Toxicity</small><b>${esc(item.quant.vpin)}</b></div>
        </div>

        <div class="hedge-box">
          <div class="hedge-title">🛡️ STRUCTURED DEFINED-RISK HEDGE</div>
          <p><strong>Primary:</strong> ${esc(item.strategy.primary)}</p>
          <p><strong>Hedge Leg:</strong> ${esc(item.strategy.hedge)}</p>
          <p><strong>Risk Boundary:</strong> ${esc(item.strategy.maxRisk)} | <strong>Breakeven:</strong> ${esc(item.strategy.breakeven)}</p>
        </div>

        <div class="rec-footer">
          <span class="audit-note">📊 <strong>Status:</strong> ${esc(item.status)}</span>
        </div>
      </article>
    `;
  }).join("");

  return `
    <section class="desk-section" id="recommendation-desk">
      <div class="desk-title-bar">
        <h2>Quantitative Defined-Risk Desk (Multi-Cap Stocks, Calls &amp; Puts)</h2>
        <span class="live-pill">LIVE NSE RESEARCH DATA</span>
      </div>
      <p class="notice"><strong>Empirical Research &amp; Decision Support:</strong> All tickets below represent mathematically bounded, defined-risk structures. All options are formatted as vertical spreads (Bull Call / Bear Put) to bound maximum capital at risk. No profit or return is guaranteed.</p>
      
      <p id="monitor-status" role="status" data-endpoint="${esc(endpoint)}">${endpoint ? "Checking continuous monitor…" : "NOT CONNECTED: no verified continuous market-data service is configured for this portal."}</p>

      <div class="rec-cards-container">
        ${cardsHtml || `<p style="padding:18px;opacity:.75;font-size:13px">No validated research setups to publish. Cards appear only when the generator supplies measured values; nothing is shown from a default table.</p>`}
      </div>

      <div id="continuous-alerts"></div>
    </section>
  `;
}

function recommendationCss() {
  return `
    .desk-section { margin: 28px 0; padding: 24px; border: 1px solid var(--line); border-radius: 18px; background: rgba(255,255,255,0.02); }
    .desk-title-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .live-pill { background: #00d084; color: #000; font-size: 0.75rem; font-weight: 700; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.05em; }
    .rec-cards-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; margin-top: 18px; }
    .rec-card { border: 1px solid var(--line); border-radius: 14px; padding: 18px; background: rgba(18, 22, 28, 0.8); display: flex; flex-direction: column; gap: 12px; }
    .rec-card.long { border-left: 4px solid #00d084; }
    .rec-card.short { border-left: 4px solid #ff4d4f; }
    .rec-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .rec-header h3 { margin: 4px 0; font-size: 1.15rem; font-weight: 700; }
    .spot-live { font-size: 0.8rem; color: #8c9ba5; }
    .rec-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 10px; }
    .rec-grid div { display: flex; flex-direction: column; }
    .rec-grid small { font-size: 0.7rem; color: #8c9ba5; text-transform: uppercase; }
    .rec-grid b { font-size: 0.95rem; }
    .hedge-box { background: rgba(0, 208, 132, 0.05); border: 1px dashed rgba(0, 208, 132, 0.3); border-radius: 10px; padding: 10px; font-size: 0.8rem; line-height: 1.4; }
    .hedge-title { font-weight: 700; font-size: 0.75rem; color: #00d084; margin-bottom: 4px; }
    .audit-note { font-size: 0.78rem; color: #e6edf3; }
    .positive { color: #00d084; }
    .negative { color: #ff4d4f; }
  `;
}

function recommendationClientJs() {
  return `(function(){
    var node=document.getElementById('monitor-status'), box=document.getElementById('continuous-alerts');
    if(!node||!box||!node.dataset.endpoint)return;
    var busy=false;
    async function poll(){if(busy)return;busy=true;
      try{var response=await fetch(node.dataset.endpoint+'/alerts',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(6000)});
        if(!response.ok)throw Error('HTTP');var data=await response.json();
        var age=Date.now()-Date.parse(data.latestVerifiedQuoteReceivedAt), heartbeat=Date.now()-Date.parse(data.generatedAt);
        if(data.feedIssue||data.state!=='OBSERVING_RESEARCH_ONLY'||!Number.isFinite(age)||age<0||age>10000||!Number.isFinite(heartbeat)||heartbeat<0||heartbeat>10000)throw Error('STALE');
        node.textContent='MONITOR CONNECTED · research only · '+data.observedInstruments+' instruments observed · last verified quote '+data.latestVerifiedQuoteReceivedAt;
        box.replaceChildren();
        (Array.isArray(data.alerts)?data.alerts:[]).filter(function(a){var t=Date.parse(a.eventAt);return a.actionable===false&&Number.isFinite(t)&&Date.now()-t>=0&&Date.now()-t<=300000;}).slice(-30).reverse().forEach(function(a){
          var card=document.createElement('article');card.className='signal-card';
          var title=document.createElement('strong');title.textContent=a.symbol+' · '+a.kind;
          var desc=document.createElement('p');desc.textContent=a.eventAt+' · '+a.explanation+' · Research alert, not a buy/sell instruction.';
          card.append(title,desc);box.append(card);
        });
        if(!box.children.length)box.textContent='No fresh research alerts. This is not a recommendation to trade.';
      }catch(e){node.textContent='MONITOR UNAVAILABLE / STALE / MARKET CLOSED — no fresh signals verified.';box.replaceChildren();}
      finally{busy=false;}}
    poll();setInterval(poll,5000);
  })();`;
}

module.exports = { buildSampleRecommendations, recommendationSectionHtml, recommendationCss, recommendationClientJs };
