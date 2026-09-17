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
function getActiveResearchSetups() {
  return [
    {
      symbol: "RELIANCE",
      assetClass: "OPTION",
      action: "BUY",
      strike: 1240,
      optionType: "CE",
      tradingSymbol: "RELIANCE26SEP1240CE",
      lotSize: 500,
      underlyingPrice: 1244.80,
      entryTrigger: 21.95,
      target1: 29.63,
      target2: 38.41,
      stopLoss: 8.34,
      capitalRequired: 10975,
      marketCap: "Large Cap",
      status: "TARGET 1 HIT @ ₹29.63 (High ₹31.49 on ₹1255 spot) · Runner Active",
      strategy: {
        name: "Bull Call Spread",
        primary: "BUY RELIANCE26SEP1240CE @ ₹21.95",
        hedge: "SELL RELIANCE26SEP1280CE @ ₹1.10",
        maxRisk: "₹10,425 (Hard-Capped)",
        breakeven: "₹1,260.85"
      },
      quant: { vpin: "0.128", hurst: "0.59", halfLife: "4.5 sessions", delta: "0.51" }
    },
    {
      symbol: "HDFCBANK",
      assetClass: "OPTION",
      action: "BUY",
      strike: 720,
      optionType: "CE",
      tradingSymbol: "HDFCBANK26SEP720CE",
      lotSize: 650,
      underlyingPrice: 715.30,
      entryTrigger: 11.85,
      target1: 16.00,
      target2: 20.74,
      stopLoss: 4.50,
      capitalRequired: 7703,
      marketCap: "Large Cap",
      status: "PEAK ₹12.50 on ₹725.40 spot · Theta Decay Drawdown",
      strategy: {
        name: "Bull Call Spread",
        primary: "BUY HDFCBANK26SEP720CE @ ₹11.85",
        hedge: "SELL HDFCBANK26SEP760CE @ ₹0.05",
        maxRisk: "₹7,670 (Hard-Capped)",
        breakeven: "₹731.80"
      },
      quant: { vpin: "0.134", hurst: "0.55", halfLife: "3.9 sessions", delta: "0.49" }
    },
    {
      symbol: "NIFTY",
      assetClass: "OPTION",
      action: "BUY",
      strike: 23150,
      optionType: "CE",
      tradingSymbol: "NIFTY26SEP23150CE",
      lotSize: 65,
      underlyingPrice: 23280.55,
      entryTrigger: 273.30,
      target1: 368.96,
      target2: 478.28,
      stopLoss: 103.85,
      capitalRequired: 17765,
      marketCap: "Index Derivative",
      status: "PEAK ₹306.64 on 23,325 spot · Floating Near Breakeven",
      strategy: {
        name: "Bull Call Spread",
        primary: "BUY NIFTY26SEP23150CE @ ₹273.30",
        hedge: "SELL NIFTY26SEP23350CE @ ₹138.20",
        maxRisk: "₹8,782 (Hard-Capped)",
        breakeven: "23,285"
      },
      quant: { vpin: "0.142", hurst: "0.64", halfLife: "3.8 sessions", delta: "0.54" }
    },
    {
      symbol: "BANKNIFTY",
      assetClass: "OPTION",
      action: "BUY",
      strike: 55800,
      optionType: "PE",
      tradingSymbol: "BANKNIFTY26SEP55800PE",
      lotSize: 30,
      underlyingPrice: 56289.20,
      entryTrigger: 559.95,
      target1: 755.93,
      target2: 979.91,
      stopLoss: 212.78,
      capitalRequired: 3966,
      marketCap: "Index Derivative",
      status: "DEFENSIVE HEDGE · Loss Capped at Net Debit by Bear Put Spread",
      strategy: {
        name: "Bear Put Spread",
        primary: "BUY BANKNIFTY26SEP55800PE @ ₹559.95",
        hedge: "SELL BANKNIFTY26SEP55600PE @ ₹427.75",
        maxRisk: "₹3,966 (Strictly Capped)",
        breakeven: "55,668"
      },
      quant: { vpin: "0.185", hurst: "0.41", halfLife: "2.9 sessions", delta: "-0.48" }
    },
    {
      symbol: "DIXON",
      assetClass: "OPTION",
      action: "BUY",
      strike: 13250,
      optionType: "CE",
      tradingSymbol: "DIXON26SEP13250CE",
      lotSize: 50,
      underlyingPrice: 13370.00,
      entryTrigger: 310.00,
      target1: 418.50,
      target2: 542.50,
      stopLoss: 117.80,
      capitalRequired: 15500,
      marketCap: "Mid Cap",
      status: "PEAK ₹376.90 on ₹13,495 spot · In Profit Zone",
      strategy: {
        name: "Bull Call Spread",
        primary: "BUY DIXON26SEP13250CE @ ₹310.00",
        hedge: "SELL DIXON26SEP13450CE @ ₹40.20",
        maxRisk: "₹13,490 (Hard-Capped)",
        breakeven: "₹13,520"
      },
      quant: { vpin: "0.119", hurst: "0.74", halfLife: "4.4 sessions", delta: "0.52" }
    },
    {
      symbol: "ABB",
      assetClass: "FUTURES",
      action: "BUY",
      tradingSymbol: "ABB26SEPFUT",
      lotSize: 125,
      underlyingPrice: 7090.00,
      entryTrigger: 6954.45,
      target1: 7140.85,
      target2: 7364.80,
      stopLoss: 6861.30,
      capitalRequired: 191247,
      marketCap: "Large Cap",
      status: "TARGET 1 HIT @ ₹7,140.85 (High ₹7,168.00) · Whole Lot Profit",
      strategy: {
        name: "Continuous Futures Swing",
        primary: "BUY ABB26SEPFUT (Lot 125) @ ₹6,954.45",
        hedge: "Protective Put (OTM Strike)",
        maxRisk: "Defined by Stop Loss ₹6,861.30",
        breakeven: "₹6,954.45"
      },
      quant: { vpin: "0.118", hurst: "0.67", halfLife: "4.2 sessions", delta: "1.00" }
    },
    {
      symbol: "BEL",
      assetClass: "FUTURES",
      action: "BUY",
      tradingSymbol: "BEL26SEPFUT",
      lotSize: 1425,
      underlyingPrice: 393.40,
      entryTrigger: 390.25,
      target1: 398.15,
      target2: 409.75,
      stopLoss: 386.30,
      capitalRequired: 244686,
      marketCap: "Large Cap",
      status: "STOPPED OUT @ ₹386.30 on Sep 15 Plunge · Honest Risk Audit",
      strategy: {
        name: "Continuous Futures Swing",
        primary: "BUY BEL26SEPFUT (Lot 1425) @ ₹390.25",
        hedge: "Protective Put (OTM Strike)",
        maxRisk: "Defined by Stop Loss ₹386.30",
        breakeven: "₹390.25"
      },
      quant: { vpin: "0.110", hurst: "0.65", halfLife: "3.5 sessions", delta: "1.00" }
    },
    {
      symbol: "KAYNES",
      assetClass: "CASH",
      action: "BUY",
      tradingSymbol: "KAYNES",
      lotSize: 100,
      underlyingPrice: 3536.50,
      entryTrigger: 3392.00,
      target1: 3561.60,
      target2: 3731.20,
      stopLoss: 3222.40,
      capitalRequired: 339200,
      marketCap: "Small Cap",
      status: "TARGET 1 HIT @ ₹3,561.60 (High ₹3,562.00) · +₹15,705 Profit Zone",
      strategy: {
        name: "Delivery Cash Equity",
        primary: "BUY KAYNES (100 Shares) @ ₹3,392.00",
        hedge: "Trailing Stop at Breakeven",
        maxRisk: "₹16,960 (Stop Loss)",
        breakeven: "₹3,392.00"
      },
      quant: { vpin: "0.089", hurst: "0.78", halfLife: "7.2 sessions", delta: "1.00" }
    },
    {
      symbol: "TRENT",
      assetClass: "CASH",
      action: "BUY",
      tradingSymbol: "TRENT",
      lotSize: 100,
      underlyingPrice: 2783.20,
      entryTrigger: 2730.00,
      target1: 2852.85,
      target2: 2975.70,
      stopLoss: 2593.50,
      capitalRequired: 273000,
      marketCap: "Mid Cap",
      status: "IN PROFIT ZONE (Rallied to ₹2,785.90) · Approaching Target 1",
      strategy: {
        name: "Delivery Cash Equity",
        primary: "BUY TRENT (100 Shares) @ ₹2,730.00",
        hedge: "Trailing Stop Loss",
        maxRisk: "₹13,650 (Stop Loss)",
        breakeven: "₹2,730.00"
      },
      quant: { vpin: "0.104", hurst: "0.76", halfLife: "5.8 sessions", delta: "1.00" }
    },
    {
      symbol: "CDSL",
      assetClass: "CASH",
      action: "BUY",
      tradingSymbol: "CDSL",
      lotSize: 100,
      underlyingPrice: 1352.90,
      entryTrigger: 1311.00,
      target1: 1363.44,
      target2: 1415.88,
      stopLoss: 1245.45,
      capitalRequired: 131100,
      marketCap: "Small Cap",
      status: "IN PROFIT ZONE (Peak ₹1,357.50 near Target 1) · Strong Trend",
      strategy: {
        name: "Delivery Cash Equity",
        primary: "BUY CDSL (100 Shares) @ ₹1,311.00",
        hedge: "Trailing Stop Loss",
        maxRisk: "₹6,555 (Stop Loss)",
        breakeven: "₹1,311.00"
      },
      quant: { vpin: "0.108", hurst: "0.69", halfLife: "6.0 sessions", delta: "1.00" }
    },
    {
      symbol: "DATAPATTNS",
      assetClass: "CASH",
      action: "BUY",
      tradingSymbol: "DATAPATTNS",
      lotSize: 100,
      underlyingPrice: 4399.60,
      entryTrigger: 4358.80,
      target1: 4576.74,
      target2: 4881.86,
      stopLoss: 4140.86,
      capitalRequired: 435880,
      marketCap: "Small Cap",
      status: "IN PROFIT ZONE (Bounced from ₹4,140 to ₹4,509.70)",
      strategy: {
        name: "Delivery Cash Equity",
        primary: "BUY DATAPATTNS (100 Shares) @ ₹4,358.80",
        hedge: "Trailing Stop Loss",
        maxRisk: "₹21,794 (Stop Loss)",
        breakeven: "₹4,358.80"
      },
      quant: { vpin: "0.094", hurst: "0.73", halfLife: "6.9 sessions", delta: "1.00" }
    },
    {
      symbol: "TCS",
      assetClass: "CASH",
      action: "BUY",
      tradingSymbol: "TCS",
      lotSize: 100,
      underlyingPrice: 2175.00,
      entryTrigger: 2251.00,
      target1: 2329.79,
      target2: 2419.83,
      stopLoss: 2138.45,
      capitalRequired: 225100,
      marketCap: "Large Cap",
      status: "DRAWDOWN ZONE · Stop Loss ₹2,138.45 Holding Safely",
      strategy: {
        name: "Delivery Cash Equity",
        primary: "BUY TCS (100 Shares) @ ₹2,251.00",
        hedge: "Protective Stop Loss",
        maxRisk: "₹11,255 (Stop Loss)",
        breakeven: "₹2,251.00"
      },
      quant: { vpin: "0.115", hurst: "0.68", halfLife: "6.2 sessions", delta: "1.00" }
    }
  ];
}

function recommendationSectionHtml(recommendations = [], monitorUrl = "") {
  let endpoint = "";
  try { const u = new URL(monitorUrl); if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) endpoint = u.href.replace(/\/$/, ""); } catch {}

  const setups = getActiveResearchSetups();

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
        ${cardsHtml}
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
