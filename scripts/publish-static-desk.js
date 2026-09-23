"use strict";

/**
 * THE DESK WITHOUT A SERVER.
 *
 * Everything that has gone wrong with hosting this comes from one assumption:
 * that a trading desk needs a machine running all day. It does not. The work is
 * a few seconds of computation on a settlement file and a live option chain, and
 * the output is a list of prices. A list of prices is a FILE.
 *
 * So this produces the file, on a schedule, on a machine that is destroyed
 * afterwards. There is no uptime to lose, no 512 MB ceiling, no fifteen-minute
 * sleep, no monthly hour cap and no laptop that has to stay open in a dark
 * house.
 *
 * WHAT IT WRITES:
 *   docs/levels.json  the session ledger: the buy limit, target and stop for
 *                     every contract, FROZEN the first time that contract
 *                     qualified today and never recomputed after. See
 *                     scripts/session-freeze.js for why this is the load-
 *                     bearing file and not an implementation detail.
 *   docs/data.json    the whole snapshot as data, for the Google Sheet and for
 *                     anything else that wants to read it.
 *   docs/index.html   one self-contained page, readable on a phone.
 *
 * WHAT IT DOES NOT DO: pretend the numbers are live when they are not. Every
 * page says when it was built and where each price came from, because a
 * scheduled job is by definition a snapshot, and a snapshot presented as a live
 * quote is the defect this project spent a week removing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { openSession, driftPct, istStamp, numeric } = require("./session-freeze");

const OUT_DIR = path.resolve(__dirname, "..", "docs");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function money(value) {
  return Number.isFinite(Number(value)) ? "₹" + Number(value).toLocaleString("en-IN") : "—";
}
function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function round(value, dp = 2) {
  const n = numeric(value);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Where the live price sits relative to the limit that was frozen this morning.
 *
 * This is the column that was missing. A frozen limit is only half an answer:
 * the other half is whether the market has come to it, and saying so in one
 * word is the difference between a list of prices and an instruction.
 */
function fillState(limit, now) {
  const l = numeric(limit);
  const p = numeric(now);
  // numeric(), not Number(): a contract with no quote must not be reported as
  // sitting far below your limit, which is what Number(null) === 0 produces.
  if (l === null || p === null || l <= 0) return { word: "NO PRICE", tone: "" };
  const gap = ((p - l) / l) * 100;
  // A BUY limit fills only when the price comes DOWN to it. The first version
  // called anything within 1% "AT THE LIMIT" -- and every futures row sits 0.8%
  // above its limit at the moment it is set, by design, because the limit is
  // placed under the price to catch a dip. So every futures row read as
  // fillable when not one of them was. Within a tick or two is "at the limit";
  // anything more is waiting, and says how far the price has to fall.
  if (gap <= 0) return { word: "AT OR BELOW LIMIT", tone: "up" };
  if (gap <= 0.1) return { word: "AT THE LIMIT", tone: "up" };
  const dip = ((p - l) / p) * 100;
  return { word: `WAITING — needs a ${dip.toFixed(1)}% dip`, tone: dip > 5 ? "down" : "" };
}

async function build({ limit = 40, futuresLimit = 25, ledgerFile, forceFreeze = null } = {}) {
  const { fnoUniverseEngine } = require("../api/_lib/universe-210");
  const { screenContracts } = require("../api/_lib/contract-screener");
  const { loadReference } = require("../api/_lib/fno-reference");
  const live = require("../api/_lib/live-quotes");

  const macro = { severity: "NORMAL", shieldActive: false };
  const reference = loadReference();
  const phase = live.marketPhase();

  const universe = fnoUniverseEngine.getUniverse(macro) || [];
  const scores = {};
  for (const row of universe) {
    if (Number.isFinite(Number(row.compositeScore))) scores[row.symbol] = Number(row.compositeScore);
  }

  const screen = screenContracts({
    reference, underlyingScores: scores, limit,
    liveQuoteFor: (s, e, k, t) => { try { return live.liveQuote(s, e, k, t); } catch (err) { return null; } },
    marketOpen: phase.open === true
  });

  /**
   * A LEVEL IS ONLY FROZEN AGAINST A PRICE THAT TRADED.
   *
   * The clock is not enough evidence. marketPhase() knows weekends and the
   * session hours and nothing else -- it has no NSE holiday calendar -- so on a
   * trading holiday a 09:33 run sees a weekday inside the window, reports OPEN,
   * and would freeze the whole day against yesterday's settlement file. Which
   * is exactly what the do-not-freeze-before-the-bell rule exists to prevent,
   * arriving through a door that rule does not cover.
   *
   * So the gate is evidence, not inference: freeze only once the exchange has
   * actually priced something live. That single condition covers the holiday,
   * the broker login being absent, and the feed being down -- all of which look
   * identical from the clock and identical to each other.
   */
  const sawLiveBook = Number(screen.pricedLive) > 0;
  const canFreeze = forceFreeze === null ? (phase.open === true && sawLiveBook) : forceFreeze === true;
  const session = openSession({ canFreeze, file: ledgerFile });

  const options = (screen.contracts || []).map((c) => {
    const zerodha = `${c.symbol}${String(c.expiry).slice(2, 4)}${MONTHS[Number(String(c.expiry).slice(5, 7)) - 1]}${c.strike}${c.optionType}`;
    const nowPrice = round(c.premium);
    const levels = session.level("options", zerodha, () => {
      if (!Number.isFinite(Number(c.premium)) || Number(c.premium) <= 0) return null;
      return {
        buy: round(c.premium),
        sell: round(c.targetPremium),
        stop: round(Number(c.premium) / 2),
        lotSize: c.lotSize,
        expiry: c.expiry,
        strike: c.strike,
        right: c.optionType,
        symbol: c.symbol,
        priceSourceAtFreeze: c.priceSource
      };
    });
    if (!levels) return null;
    return {
      symbol: c.symbol, strike: c.strike, right: c.optionType, expiry: c.expiry, zerodha,
      buy: levels.buy, sell: levels.sell, stop: levels.stop,
      now: nowPrice, drift: driftPct(levels.buy, nowPrice),
      frozen: levels.frozen, frozenAtIst: levels.frozenAtIst,
      lotSize: c.lotSize, costPerLot: c.costPerLot,
      netProfit: c.netProfit, costPct: c.costAsPctOfGross,
      iv: c.impliedVol, rv: c.realisedVol, vrp: c.varianceRiskPremium,
      touchPct: c.touchPct, daysToTarget: c.medianDaysToTarget, daysLeft: c.daysToExpiry,
      thetaBurnPct: c.thetaBurnPct, term: c.termShape, skew: c.skewPoints,
      priceSource: c.priceSource, priceIsLive: c.priceIsLive, score: c.screenScore
    };
  }).filter(Boolean);

  const futures = universe
    .filter((r) => (r.action === "BUY" || r.action === "ACCUMULATE") && r.perUnit)
    .sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0))
    .slice(0, futuresLimit)
    .map((r) => {
      const nowPrice = round(r.spotPrice);
      const levels = session.level("futures", r.symbol, () => {
        if (!Number.isFinite(Number(r.entryPrice))) return null;
        return {
          buy: round(r.entryPrice), target1: round(r.target1), target2: round(r.target2),
          stop: round(r.stopLoss), anchor: round(r.spotPrice),
          tradingSymbol: r.tradingSymbol, lotSize: r.lotSize, symbol: r.symbol
        };
      });
      if (!levels) return null;
      return {
        symbol: r.symbol, tradingSymbol: levels.tradingSymbol || r.tradingSymbol,
        spot: nowPrice, buy: levels.buy, target1: levels.target1, target2: levels.target2, stop: levels.stop,
        anchor: levels.anchor, drift: driftPct(levels.buy, nowPrice),
        frozen: levels.frozen, frozenAtIst: levels.frozenAtIst,
        perUnitCapital: r.perUnit?.capitalPerUnit,
        riskPerUnit: r.perUnit?.riskPerUnit, rewardPerUnit: r.perUnit?.rewardPerUnitAtTarget1,
        rewardToRisk: r.perUnit?.rewardToRisk,
        exchangeLot: r.lotSize, score: r.compositeScore
      };
    }).filter(Boolean);

  const saved = session.save();

  // What scripts/prepare-static-build.js found when it tried to log in. Carried
  // onto the page because "no options" has two causes that look identical from
  // the outside -- the login failed, or the exchange simply is not trading --
  // and only one of them is something you can fix.
  let brokerCheck = null;
  try {
    brokerCheck = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", ".private", "cache", "broker-check.json"), "utf8"));
  } catch { brokerCheck = null; }

  return {
    builtAt: new Date().toISOString(),
    builtAtIst: istStamp(),
    sessionDate: session.sessionDate,
    levelsFrozen: session.canFreeze,
    // Naming the reason matters: "the market is closed" and "nobody logged in
    // to the broker" produce the same empty screen and need different fixes.
    freezeBlockedBecause: session.canFreeze ? null
      : phase.open !== true
        ? `The market is ${String(phase.phase).toLowerCase()}.`
        : "The market says it is open, but not one contract came back with a live exchange book "
          + "-- an NSE holiday, or no broker session. The clock alone is not evidence.",
    levelsOpenedAtIst: session.ledger.openedAtIst,
    freezeTally: session.tally,
    ledgerWritten: saved,
    marketPhase: phase.phase,
    settlementFile: reference?.session || null,
    pricedLive: screen.pricedLive ?? 0,
    pricedFromSettlement: screen.pricedFromSettlement ?? 0,
    examined: screen.examined ?? 0,
    survived: screen.survived ?? 0,
    brokerCheck,
    options,
    futures
  };
}

function page(d) {
  // Calls, puts and futures are three different trades, and they were asked
  // for as three separate things: "you have mixed up the call and put and the
  // futures ... keep it separate". One long page with the futures under forty
  // option rows meant the futures were effectively not on it.
  const calls = d.options.filter((c) => c.right === "CE");
  const puts = d.options.filter((c) => c.right === "PE");
  const optionRows = (list) => list.map((c) => {
    const state = fillState(c.buy, c.now);
    return `
      <tr>
        <td><b>${esc(c.symbol)} ${esc(c.strike)} ${esc(c.right)}</b>
          <div class="sub"><code>${esc(c.zerodha)}</code></div>
          <div class="sub">${esc(c.expiry)} &middot; ${esc(c.daysLeft)}d left</div></td>
        <td class="num"><b>${money(c.buy)}</b><div class="sub">&times;${esc(c.lotSize)} = ${money(c.costPerLot)}</div></td>
        <td class="num up"><b>${money(c.sell)}</b><div class="sub">net ${money(c.netProfit)}</div></td>
        <td class="num down">${money(c.stop)}</td>
        <td class="num">${money(c.now)}<div class="sub ${state.tone}">${esc(state.word)}</div></td>
        <td class="num">${esc(c.iv)}% / ${esc(c.rv)}%<div class="sub">VRP ${esc(c.vrp)}</div></td>
        <td class="num">${esc(c.touchPct)}%<div class="sub">~${esc(c.daysToTarget)}d</div></td>
        <td class="num ${Number(c.thetaBurnPct) > 12 ? "down" : ""}">${esc(c.thetaBurnPct)}%</td>
        <td class="num">${esc(c.score)}</td>
      </tr>`;
  }).join("");

  const optionTable = (list, empty) => `
<div class="wrap"><table>
  <thead><tr>
    <th>CONTRACT</th><th class="num">BUY LIMIT</th><th class="num">SELL &middot; NET</th><th class="num">STOP</th>
    <th class="num">NOW</th>
    <th class="num">IV / REALISED</th><th class="num">P(TOUCH)</th><th class="num">DECAY</th><th class="num">SCORE</th>
  </tr></thead><tbody>${optionRows(list) || `<tr><td colspan="9">${empty}</td></tr>`}</tbody>
</table></div>`;

  const futRows = d.futures.map((r) => {
    const state = fillState(r.buy, r.spot);
    return `
      <tr>
        <td><b>${esc(r.symbol)}</b><div class="sub"><code>${esc(r.tradingSymbol)}</code></div></td>
        <td class="num"><b>${money(r.buy)}</b></td>
        <td class="num up">${money(r.target1)}<div class="sub">${money(r.target2)}</div></td>
        <td class="num down">${money(r.stop)}</td>
        <td class="num">${money(r.spot)}<div class="sub ${state.tone}">${esc(state.word)}</div></td>
        <td class="num">${money(r.perUnitCapital)}<div class="sub">per unit</div></td>
        <td class="num">${esc(r.rewardToRisk)}<div class="sub">+${money(r.rewardPerUnit)} / &minus;${money(r.riskPerUnit)}</div></td>
      </tr>`;
  }).join("");

  const bc = d.brokerCheck;
  const brokerNote = !bc
    ? ""
    : bc.ok
      ? ` <b class="up">Broker login OK</b> from the build server at ${esc(istStamp(Date.parse(bc.checkedAt)))}
         &mdash; a NIFTY quote came back.`
      : ` <b class="down">Broker login FAILED</b> at ${esc(istStamp(Date.parse(bc.checkedAt)))}
         (stage ${esc(bc.stage)}: ${esc(bc.reason)}${bc.message ? " &mdash; " + esc(bc.message) : ""}).
         Until this is fixed the options table stays empty during market hours, because a
         settled price is never quoted as a live one.`;

  const liveNote = d.pricedLive > 0
    ? `<b class="up">${d.pricedLive}</b> priced from a live broker book, <b>${d.pricedFromSettlement}</b> from the ${esc(d.settlementFile)} settlement file.`
    : `All prices are from the <b>${esc(d.settlementFile)}</b> settlement file. The market was ${esc(d.marketPhase).toLowerCase()} when this was built, so nothing here is executable right now.`;

  const freezeNote = d.levelsFrozen
    ? `<b>BUY, SELL AND STOP ARE FIXED FOR TODAY.</b> They were set at
       <b>${esc(d.levelsOpenedAtIst || "the first build after the open")}</b> and they do not move again,
       however far the market runs. ${esc(d.freezeTally.carried)} carried from earlier in the session,
       ${esc(d.freezeTally.frozenThisBuild)} set on this build. The <b>NOW</b> column is the only
       number that changes &mdash; it tells you whether the market has come to your limit yet.`
    : `<b>THESE LEVELS ARE INDICATIVE, NOT FIXED.</b> ${esc(d.freezeBlockedBecause)}
       There is no traded price to anchor them to, so nothing has been written down.
       They are set once &mdash; and then held all day &mdash; on the first build that
       sees a live exchange book.`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K&sup2; Desk</title>
<style>
  :root { color-scheme: dark; --bg:#0c0d14; --panel:#14161f; --line:#262a40; --muted:#8e93a6;
          --text:#e6e8f0; --green:#00e676; --red:#ff5252; --amber:#ffb300; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:14px }
  h1 { font-size:18px; margin:0 0 4px } h2 { font-size:15px; margin:26px 0 8px }
  .stamp { color:var(--muted); font-size:12px; margin-bottom:14px }
  .note { border:1px solid var(--line); border-left:3px solid var(--amber); border-radius:8px;
          padding:10px 12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--muted) }
  .note.frozen { border-left-color:var(--green) }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--panel) }
  table { border-collapse:collapse; width:100%; min-width:760px }
  th { text-align:left; font-size:9px; letter-spacing:.06em; color:var(--muted);
       padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap }
  td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align:top }
  .num { text-align:right; white-space:nowrap }
  .sub { font-size:10px; color:var(--muted); margin-top:2px }
  code { font-size:10px; color:var(--text); word-break:break-all }
  .up { color:var(--green) } .down { color:var(--red) }
  tr:last-child td { border-bottom:none }
  /* Three tabs, no JavaScript: a radio button per tab, and CSS shows the pane
     whose button is checked. Works on any phone, with scripts off, forever. */
  .desk > input { position:absolute; opacity:0; pointer-events:none }
  .tabs { position:sticky; top:0; z-index:5; display:flex; gap:8px; padding:10px 0; background:var(--bg) }
  .tabs label { flex:1; text-align:center; padding:12px 6px; border:1px solid var(--line); border-radius:10px;
                cursor:pointer; font-weight:700; letter-spacing:.05em; color:var(--muted); background:var(--panel) }
  .tabs label span { display:inline-block; margin-left:6px; padding:0 8px; border-radius:99px;
                     background:var(--line); color:var(--text); font-weight:400 }
  .pane { display:none }
  .pane h2 { margin-top:8px }
  #v-fut:checked ~ .pane-fut, #v-ce:checked ~ .pane-ce, #v-pe:checked ~ .pane-pe { display:block }
  #v-fut:checked ~ .tabs .t-fut { color:var(--bg); background:var(--amber); border-color:var(--amber) }
  #v-ce:checked ~ .tabs .t-ce { color:var(--bg); background:var(--green); border-color:var(--green) }
  #v-pe:checked ~ .tabs .t-pe { color:var(--bg); background:var(--red); border-color:var(--red) }
</style></head><body>

<h1>K&sup2; Desk</h1>
<div class="stamp">Built ${esc(d.builtAtIst)} &middot; session ${esc(d.sessionDate)} &middot; market ${esc(d.marketPhase)} &middot;
  ${esc(Number(d.examined).toLocaleString("en-IN"))} contracts examined, ${esc(Number(d.survived).toLocaleString("en-IN"))} cleared every gate</div>

<div class="note ${d.levelsFrozen ? "frozen" : ""}">${freezeNote}</div>

<main class="desk">
  <input type="radio" name="view" id="v-fut" checked>
  <input type="radio" name="view" id="v-ce">
  <input type="radio" name="view" id="v-pe">

  <nav class="tabs">
    <label for="v-fut" class="t-fut">FUTURES <span>${d.futures.length}</span></label>
    <label for="v-ce" class="t-ce">CALLS <span>${calls.length}</span></label>
    <label for="v-pe" class="t-pe">PUTS <span>${puts.length}</span></label>
  </nav>

  <section class="pane pane-fut">
    <h2>Futures &mdash; buy per unit, not per lot</h2>
    <div class="wrap"><table>
      <thead><tr>
        <th>SYMBOL</th><th class="num">BUY LIMIT</th><th class="num">TARGET 1 &middot; 2</th>
        <th class="num">STOP</th><th class="num">NOW</th><th class="num">1 UNIT</th><th class="num">R : R</th>
      </tr></thead><tbody>${futRows || '<tr><td colspan="7">No futures cleared the hurdle on this build.</td></tr>'}</tbody>
    </table></div>
  </section>

  <section class="pane pane-ce">
    <h2>Calls &mdash; you BUY the call, it pays if the stock RISES</h2>
    ${optionTable(calls, "No calls cleared every gate on this build.")}
  </section>

  <section class="pane pane-pe">
    <h2>Puts &mdash; you BUY the put, it pays if the stock FALLS</h2>
    ${optionTable(puts, "No puts cleared every gate on this build.")}
  </section>
</main>

<div class="note" style="margin-top:20px">
  <b>WHERE THESE PRICES COME FROM.</b> ${liveNote}${brokerNote}
  This page is a <b>snapshot</b>, rebuilt on a schedule &mdash; it is not a live feed.
  <b>Check the price on your broker before placing anything.</b>
  Net figures are after brokerage, STT at 0.15%, exchange, stamp and GST; the
  spread is extra and is only known where a live book was seen.
</div>

<div class="note" style="margin-top:20px;border-left-color:var(--red)">
  <b>WHAT THIS DOES NOT ESTABLISH.</b> That any of it makes money. The paper ledger
  has no closed trades yet, so nothing here has a measured hit rate &mdash; the ranking
  is built on things that were measured, which is not the same as an edge that was
  proven. Size accordingly.
</div>

</body></html>`;
}

async function main() {
  const data = await build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "data.json"), JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), page(data));
  // GitHub Pages will not serve a directory containing an underscore path
  // without this, and the failure is a silent 404 rather than an error.
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");
  console.log(`built ${data.options.length} option rows and ${data.futures.length} futures rows`);
  console.log(`  ${data.pricedLive} live, ${data.pricedFromSettlement} from the ${data.settlementFile} settlement file`);
  console.log(`  levels: ${data.freezeTally.carried} carried, ${data.freezeTally.frozenThisBuild} frozen now, ` +
              `${data.freezeTally.indicative} indicative — ${data.ledgerWritten.written ? "ledger written" : data.ledgerWritten.reason}`);
  console.log(`  -> docs/index.html, docs/data.json, docs/levels.json`);
  return data;
}

module.exports = { build, page, fillState, main };

// Exported above so a test can drive build() twice and prove the levels did not
// move. Run directly, it is still just a build.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error("static build failed:", error.message);
    process.exit(1);
  });
}
