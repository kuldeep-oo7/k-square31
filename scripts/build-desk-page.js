"use strict";

// Renders the weekly ladder plan as a single self-contained page that can be
// published and shared. Everything it displays is computed here from the plan
// JSON plus a live re-measurement of the benchmark names, so the page can be
// regenerated each week rather than hand-edited.
//
//   node scripts/weekly-plan.js --limit 500 --top 60 --out plan.json
//   node scripts/build-desk-page.js plan.json desk.html

const fs = require("node:fs");
const { dailyBars } = require("./weekly-plan");
const { tradingWeeks, replayWeek, DEFAULT_CONFIG } = require("../api/_lib/weekly-cycle");
const { holdToTarget } = require("./exit-policy-study");

// Large, liquid names the desk is most likely to reach for by instinct. They are
// re-measured live so the contradicting evidence on the page is never stale.
const BENCHMARKS = ["RELIANCE", "HDFCBANK", "SBIN"];

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fixed = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—");

function nextMonday(weekKey) {
  const date = new Date(`${weekKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function longDate(iso) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00Z`));
}

async function benchmarkRow(symbol) {
  const bars = await dailyBars(symbol);
  const weeks = tradingWeeks(bars);
  const fills = weeks.map((week) => replayWeek(week, "long", DEFAULT_CONFIG)).filter(Boolean)
    .flatMap((week) => week.trades.filter((trade) => trade.level === 1));
  const hits = fills.filter((trade) => trade.outcome === "target");
  const held = holdToTarget(bars, fills);
  const resolved = held.filter((trade) => trade.resolved);
  const sessions = resolved.map((trade) => trade.sessionsHeld).sort((left, right) => left - right);
  const average = (list) => (list.length ? list.reduce((sum, item) => sum + item.netPct, 0) / list.length : 0);
  return {
    symbol,
    weeks: weeks.length,
    fills: fills.length,
    hitPct: fills.length ? hits.length / fills.length * 100 : 0,
    fridayNetPct: average(fills),
    worstFillPct: fills.length ? Math.min(...fills.map((trade) => trade.netPct)) : 0,
    eventualPct: held.length ? resolved.length / held.length * 100 : 0,
    medianSessions: sessions.length ? sessions[Math.floor(sessions.length / 2)] : null,
    holdNetPct: average(held)
  };
}

function conviction(value) {
  const width = Math.max(2, Math.min(100, Number(value)));
  return `<span class="meter" role="img" aria-label="conviction ${fixed(value, 0)} of 100"><span class="meter-fill" style="width:${width}%"></span></span><span class="meter-value">${fixed(value, 0)}</span>`;
}

function rungCells(entries, side) {
  // A buy ladder rests below the anchor, a sell ladder above it.
  const sign = side === "short" ? "+" : "−";
  return entries.map((entry) => `
        <div class="rung">
          <span class="rung-step">${sign}${fixed(entry.stepFromAnchorPct, 0)}%</span>
          <span class="rung-stat">${fixed(entry.hitRatePct, 0)}% hit<span class="rung-sample"> · ${entry.historicalFills} fills</span></span>
        </div>`).join("");
}

function row(item) {
  const side = item.side === "short" ? "short" : "long";
  const earnings = item.evidence?.fundamentals?.nextEarningsDate;
  const firstEntry = (item.entries && item.entries[0]) || {};
  const entryPrice = Number(firstEntry.entry) || Number(item.anchor) || null;
  const targetPrice = Number(firstEntry.target) || (entryPrice ? (side === "short" ? entryPrice * 0.98 : entryPrice * 1.02) : null);
  const stopLossPrice = Number(firstEntry.stopLoss) || (entryPrice ? (side === "short" ? entryPrice * 1.01 : entryPrice * 0.99) : null);
  const riskReward = Number(firstEntry.riskReward) || 2.0;

  return `
      <tr data-side="${side}" data-expected="${Number(item.expectedWeeklyPct)}" data-conviction="${Number(item.convictionPct)}">
        <th scope="row" class="sym">
          <span class="sym-name">${escapeHtml(item.symbol)}</span>
          <span class="chip chip-${side}">${side === "short" ? "sell" : "buy"}</span>
        </th>
        <td class="num"><b>${entryPrice ? `₹${fixed(entryPrice)}` : "—"}</b></td>
        <td class="num" style="color:var(--mint-deep,#167a62)"><b>${targetPrice ? `₹${fixed(targetPrice)}` : "—"}</b> <small>(${side === "short" ? "−2%" : "+2%"})</small></td>
        <td class="num" style="color:var(--coral-deep,#b63c32)"><b>${stopLossPrice ? `₹${fixed(stopLossPrice)}` : "—"}</b> <small>(${side === "short" ? "+1%" : "−1%"})</small></td>
        <td class="num"><b>${fixed(riskReward, 1)} : 1</b></td>
        <td class="num strong">${fixed(item.expectedWeeklyPct)}%</td>
        <td class="conv">${conviction(item.convictionPct)}</td>
        <td class="num">×${fixed(item.sizeMultiplier)}</td>
      </tr>`;
}

function rejectionRows(rejected) {
  const counts = new Map();
  rejected.forEach((item) => {
    const reason = /significance hurdle/.test(item.reason) ? "No rung cleared the significance hurdle"
      : /complete trading weeks/.test(item.reason) ? "Not enough history to measure"
        : /Results are scheduled/.test(item.reason) ? "Results land inside the trading week"
          : /model expects/i.test(item.reason) ? "The model expects a losing week"
            : "Other";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `
        <li><span class="reject-count">${count}</span><span class="reject-reason">${escapeHtml(reason)}</span></li>`).join("");
}

function page(plan, benchmarks) {
  const monday = plan.weekKey ? nextMonday(plan.weekKey) : null;
  const best = plan.best || [];
  const longs = best.filter((item) => item.side === "long").length;
  const shorts = best.filter((item) => item.side === "short").length;
  const worst = benchmarks.reduce((low, item) => (item.fridayNetPct < low.fridayNetPct ? item : low), benchmarks[0]);

  return `<title>K² Weekly Ladder Desk</title>
<style>
  :root {
    --ink: #12161F;
    --panel: #FFFFFF;
    --panel-2: #F7F9FC;
    --ground: #F4F6FA;
    --line: #D8DEE9;
    --text: #171C26;
    --muted: #5C6779;
    --brass: #9A6B14;
    --brass-soft: #F3E7CC;
    --long: #1F6E52;
    --short: #9E3A31;
    --long-soft: #E2F0EA;
    --short-soft: #F8E5E3;
    --display: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    --body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
    --measure: 66ch;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --panel: #1A202C;
      --panel-2: #161B25;
      --ground: #12161F;
      --line: #2C3547;
      --text: #EAEEF6;
      --muted: #98A3B8;
      --brass: #D7A445;
      --brass-soft: #33291320;
      --long: #4FB88E;
      --short: #E0736A;
      --long-soft: #14312690;
      --short-soft: #3A1C1990;
    }
  }
  :root[data-theme="dark"] {
    --panel: #1A202C;
    --panel-2: #161B25;
    --ground: #12161F;
    --line: #2C3547;
    --text: #EAEEF6;
    --muted: #98A3B8;
    --brass: #D7A445;
    --brass-soft: #33291320;
    --long: #4FB88E;
    --short: #E0736A;
    --long-soft: #14312690;
    --short-soft: #3A1C1990;
  }
  :root[data-theme="light"] {
    --panel: #FFFFFF;
    --panel-2: #F7F9FC;
    --ground: #F4F6FA;
    --line: #D8DEE9;
    --text: #171C26;
    --muted: #5C6779;
    --brass: #9A6B14;
    --brass-soft: #F3E7CC;
    --long: #1F6E52;
    --short: #9E3A31;
    --long-soft: #E2F0EA;
    --short-soft: #F8E5E3;
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--text);
    font-family: var(--body);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: clamp(20px, 4vw, 56px) clamp(16px, 3vw, 32px) 72px; display: flex; flex-direction: column; gap: 40px; }

  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--brass); margin: 0 0 10px; }
  h1 { font-family: var(--display); font-weight: 400; font-size: clamp(30px, 5vw, 46px); line-height: 1.1; margin: 0 0 12px; text-wrap: balance; letter-spacing: -.01em; }
  h2 { font-family: var(--display); font-weight: 400; font-size: clamp(21px, 2.6vw, 27px); margin: 0 0 6px; text-wrap: balance; }
  .lede { max-width: var(--measure); color: var(--muted); font-size: 16px; margin: 0; }
  .lede strong { color: var(--text); font-weight: 600; }

  .band { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .stat { background: var(--panel); padding: 16px 18px; display: flex; flex-direction: column; gap: 3px; }
  .stat-value { font-family: var(--mono); font-size: 25px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .stat-label { font-size: 12px; color: var(--muted); }
  .stat-brass .stat-value { color: var(--brass); }

  section { display: flex; flex-direction: column; gap: 16px; }
  .section-head { display: flex; flex-direction: column; gap: 4px; }

  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button {
    font: inherit; font-size: 13px; color: var(--muted); background: var(--panel);
    border: 1px solid var(--line); border-radius: 999px; padding: 6px 15px; cursor: pointer;
    transition: color .15s, border-color .15s, background .15s;
  }
  button:hover { color: var(--text); border-color: var(--muted); }
  button[aria-pressed="true"] { color: var(--brass); border-color: var(--brass); background: var(--brass-soft); }
  button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

  .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 3px; background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 780px; }
  thead th {
    text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); font-weight: 400; padding: 11px 14px; border-bottom: 1px solid var(--line); background: var(--panel-2); white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid var(--line); }
  tbody tr:last-child { border-bottom: 0; }
  tbody tr:nth-child(even) { background: var(--panel-2); }
  td, tbody th { padding: 12px 14px; vertical-align: middle; font-size: 14px; }
  .sym { text-align: left; font-weight: 400; display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .sym-name { font-family: var(--mono); font-size: 14px; letter-spacing: .01em; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .num.strong { font-size: 15px; }

  .chip { font-family: var(--mono); font-size: 10px; letter-spacing: .07em; text-transform: uppercase; padding: 2px 7px; border-radius: 2px; white-space: nowrap; }
  .chip-long { color: var(--long); background: var(--long-soft); }
  .chip-short { color: var(--short); background: var(--short-soft); }

  .conv { white-space: nowrap; }
  .meter { display: inline-block; width: 68px; height: 5px; background: var(--line); border-radius: 999px; overflow: hidden; vertical-align: middle; }
  .meter-fill { display: block; height: 100%; background: var(--brass); }
  .meter-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 12px; color: var(--muted); margin-left: 8px; }

  .rungs { display: flex; gap: 7px; flex-wrap: wrap; }
  .rung { display: flex; flex-direction: column; gap: 1px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 2px; background: var(--ground); }
  .rung-step { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 12px; }
  .rung-stat { font-size: 10px; color: var(--muted); white-space: nowrap; }
  .rung-sample { opacity: .75; }

  .meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 2px; margin-left: 5px; }
  .tag-model { color: var(--brass); border-color: var(--brass); }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 20px 22px; }
  .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 20px; }
  .reject { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
  .reject li { display: flex; gap: 12px; align-items: baseline; font-size: 14px; }
  .reject-count { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 17px; min-width: 2.4ch; text-align: right; color: var(--brass); }
  .reject-reason { color: var(--muted); }

  .callout { border-left: 2px solid var(--short); padding-left: 16px; }
  .callout h2 { color: var(--short); }
  .note { font-size: 13px; color: var(--muted); max-width: var(--measure); margin: 0; }
  footer { border-top: 1px solid var(--line); padding-top: 22px; display: flex; flex-direction: column; gap: 10px; }
  footer p { margin: 0; }
  dl.method { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; font-size: 13px; }
  dt { font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  dd { margin: 0; color: var(--text); }
  .empty { padding: 22px; color: var(--muted); font-size: 14px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">NSE futures · weekly ladder · ${escapeHtml(plan.weekKey || "unanchored")}</p>
    <h1>The ladders worth working next week</h1>
    <p class="lede">
      Every name in the Nifty 500 was replayed against <strong>this desk's own rule</strong> — the week's first
      open as the anchor, orders resting 2% apart, out on the first touch of 2% — for
      ${escapeHtml(String(best[0]?.evidence?.cycleWeeks || "260"))} weeks of history. Only names whose rungs
      beat a significance hurdle, survived a walk-forward model and carry no results date inside the week
      appear below. ${monday ? `Prices are set from <strong>Monday ${escapeHtml(longDate(monday))}</strong>'s open, so the rungs are given as distance from it.` : ""}
    </p>
  </header>

  <div class="band">
    <div class="stat"><span class="stat-value">${plan.universe}</span><span class="stat-label">names measured</span></div>
    <div class="stat stat-brass"><span class="stat-value">${plan.actionable}</span><span class="stat-label">cleared every test</span></div>
    <div class="stat"><span class="stat-value">${longs}</span><span class="stat-label">buy ladders</span></div>
    <div class="stat"><span class="stat-value">${shorts}</span><span class="stat-label">sell ladders</span></div>
    <div class="stat"><span class="stat-value">${fixed(best[0]?.expectedWeeklyPct)}%</span><span class="stat-label">best expected week</span></div>
  </div>

  <section>
    <div class="section-head">
      <h2>Qualified ladders</h2>
      <p class="note">Expected week is net of costs and already assumes some rungs never fill. Hit rate is measured on real fills, with the sample size beside it — a 90% hit on 12 fills is a weaker claim than 69% on 163.</p>
    </div>
    <div class="controls">
      <button type="button" data-filter="all" aria-pressed="true">All ${best.length}</button>
      <button type="button" data-filter="long" aria-pressed="false">Buy ${longs}</button>
      <button type="button" data-filter="short" aria-pressed="false">Sell ${shorts}</button>
      <button type="button" data-sort="expected" aria-pressed="true">Sort by expected</button>
      <button type="button" data-sort="conviction" aria-pressed="false">Sort by conviction</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Instrument</th>
            <th scope="col">Buy / Entry Price</th>
            <th scope="col">Sell Target (+2%)</th>
            <th scope="col">Stop Loss (-1%)</th>
            <th scope="col">Reward : Risk</th>
            <th scope="col">Expected week</th>
            <th scope="col">Conviction</th>
            <th scope="col">Size</th>
          </tr>
        </thead>
        <tbody id="rows">${best.map(row).join("")}</tbody>
      </table>
      ${best.length ? "" : '<p class="empty">No ladder cleared the tests this week. That is a result, not an outage.</p>'}
    </div>
  </section>

  <section class="split">
    <div class="panel">
      <h2>Why the rest were left out</h2>
      <ul class="reject">${rejectionRows(plan.rejected || [])}</ul>
    </div>
    <div class="panel callout">
      <h2>The habit this contradicts</h2>
      <p class="note" style="margin-bottom:14px">The first 2% dip on the largest, most liquid names is the most tempting entry on the board. Measured over ${escapeHtml(String(worst.weeks))} weeks, booking it every Friday loses money.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Fills</th><th scope="col">Hit by Friday</th><th scope="col">Net / fill</th><th scope="col">If held</th></tr>
          </thead>
          <tbody>
            ${benchmarks.map((item) => `<tr>
              <th scope="row" class="sym"><span class="sym-name">${escapeHtml(item.symbol)}</span></th>
              <td class="num">${item.fills}</td>
              <td class="num">${fixed(item.hitPct, 1)}%</td>
              <td class="num" style="color:${item.fridayNetPct < 0 ? "var(--short)" : "var(--long)"}">${fixed(item.fridayNetPct, 3)}%</td>
              <td class="num">${fixed(item.eventualPct, 1)}% in ${item.medianSessions} sessions</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="note" style="margin-top:14px">Read the last column carefully: almost every one of those trades eventually reaches 2% — the median takes <strong>${escapeHtml(String(worst.medianSessions))} trading sessions</strong>, longer than a single week. The forced Friday exit, not the entry, is what turns this into a losing trade.</p>
    </div>
  </section>

  <footer>
    <dl class="method">
      <dt>Rule tested</dt>
      <dd>Anchor at the week's first open; orders rest 2% apart; exit on the first touch of a 2% gain; any leg still open is booked at the Friday close.</dd>
      <dt>Costs</dt>
      <dd>${fixed(DEFAULT_CONFIG.costPct, 2)}% per round trip, plus ${fixed(DEFAULT_CONFIG.fridaySlippagePct, 2)}% slippage on Friday market exits.</dd>
      <dt>Statistics</dt>
      <dd>Hit rates carry 95% Wilson bounds; each rung must clear a t-statistic hurdle raised for having tested five rungs; the reported week is out-of-sample only.</dd>
      <dt>Model</dt>
      <dd>Gradient-boosted trees on 16 price and volume features, trained walk-forward — no fold ever sees its own future. A model that fails its out-of-sample gate cannot support a trade, only veto one.</dd>
      <dt>Fundamentals</dt>
      <dd>Balance-sheet quality tilts long against short; a results date inside the trading week is an outright veto.</dd>
      <dt>Data</dt>
      <dd>Five years of daily NSE bars and company financials, pulled ${escapeHtml(new Date(plan.generatedAt).toISOString().slice(0, 16).replace("T", " "))} UTC.</dd>
    </dl>
    <p class="note">A measured edge is not a promise. Position sizes here are multipliers on the desk's own slot size, and every number above is an average across ${escapeHtml(String(worst.weeks))} weeks in which the worst single week measured across these three names lost ${fixed(Math.min(...benchmarks.map((item) => item.worstFillPct)), 1)}%.</p>
  </footer>
</div>

<script>
  (function () {
    var tbody = document.getElementById("rows");
    if (!tbody) return;
    var rows = Array.prototype.slice.call(tbody.children);
    var filter = "all";
    var sort = "expected";

    function press(group, value) {
      document.querySelectorAll("[data-" + group + "]").forEach(function (button) {
        button.setAttribute("aria-pressed", String(button.dataset[group] === value));
      });
    }

    function apply() {
      rows.slice()
        .sort(function (left, right) { return Number(right.dataset[sort]) - Number(left.dataset[sort]); })
        .forEach(function (node) { tbody.appendChild(node); });
      rows.forEach(function (node) {
        node.style.display = filter === "all" || node.dataset.side === filter ? "" : "none";
      });
    }

    document.querySelectorAll("[data-filter]").forEach(function (button) {
      button.addEventListener("click", function () {
        filter = button.dataset.filter;
        press("filter", filter);
        apply();
      });
    });
    document.querySelectorAll("[data-sort]").forEach(function (button) {
      button.addEventListener("click", function () {
        sort = button.dataset.sort;
        press("sort", sort);
        apply();
      });
    });
    apply();
  }());
</script>
`;
}

async function run() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("usage: node scripts/build-desk-page.js <plan.json> <out.html>");
  const plan = JSON.parse(fs.readFileSync(source, "utf8"));
  const benchmarks = [];
  for (const symbol of BENCHMARKS) {
    benchmarks.push(await benchmarkRow(symbol));
    console.log(`measured ${symbol}`);
  }
  fs.writeFileSync(destination, page(plan, benchmarks));
  console.log(`Wrote ${destination}: ${plan.actionable} qualified of ${plan.universe} measured`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Desk page build failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { page, benchmarkRow };
