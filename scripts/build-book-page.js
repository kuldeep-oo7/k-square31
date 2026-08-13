"use strict";

// Renders the live GM book and the watchlist as one shareable page, with each
// position annotated by what the weekly-cycle measurement says about that name.
//
// A position list on its own only says what is held. Pairing every holding with
// the measured edge of the rule that opened it says whether it should be.
//
//   node scripts/gm-portfolio-dump.js gm-positions.json      (in CI, has the credentials)
//   node scripts/weekly-plan.js --symbols ... --out plan-holdings.json
//   node scripts/build-book-page.js gm-positions.json plan-holdings.json plan-watchlist.json book.html

const fs = require("node:fs");

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fixed = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—");

const rupees = (value) => {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const sign = number < 0 ? "−" : "";
  return `${sign}₹${Math.abs(Math.round(number)).toLocaleString("en-IN")}`;
};

function verdictOf(plans, symbol) {
  return plans.find((item) => item.symbol === symbol) || null;
}

// Distance from the current mark to the price that would realise the desk's 2%
// target on the position's own average, which is the number that decides whether
// a holding is close to being finished.
function toTarget(position) {
  const entry = Number(position.buyAverage) || Number(position.price);
  const mark = Number(position.markPrice) || entry;
  const short = position.position === "short";
  const target = short ? entry * 0.98 : entry * 1.02;
  const distancePct = short ? (mark / target - 1) * 100 : (target / mark - 1) * 100;
  return { target, distancePct };
}

function positionRow(position, plans) {
  const short = position.position === "short";
  const plan = verdictOf(plans, position.symbol);
  const { target, distancePct } = toTarget(position);
  const mtm = Number(position.mtm);
  const reached = distancePct <= 0;

  const verdict = !plan ? { label: "not measured", tone: "none", detail: "" }
    : plan.action === "stand-aside"
      ? { label: "no measured edge", tone: "bad", detail: plan.reasons?.[0] || "" }
      : (plan.side === "short") === short
        ? { label: "edge confirmed", tone: "good", detail: `${fixed(plan.expectedWeeklyPct)}% expected week` }
        : { label: "edge is the other way", tone: "warn", detail: `measurement favours the ${plan.side} ladder` };

  return `
      <tr data-tone="${verdict.tone}" data-mtm="${Number.isFinite(mtm) ? mtm : 0}" data-distance="${Number.isFinite(distancePct) ? distancePct : 99}">
        <th scope="row" class="sym">
          <span class="sym-name">${escapeHtml(position.symbol)}</span>
          <span class="chip chip-${short ? "short" : "long"}">${short ? "short" : "long"}</span>
        </th>
        <td class="num">${Number(position.quantity).toLocaleString("en-IN")}</td>
        <td class="num">${fixed(position.buyAverage || position.price)}</td>
        <td class="num">${fixed(position.markPrice)}</td>
        <td class="num ${mtm < 0 ? "neg" : "pos"}">${rupees(mtm)}</td>
        <td class="num">${fixed(target)}</td>
        <td class="num ${reached ? "pos" : ""}">${reached ? "reached" : `${fixed(distancePct)}%`}</td>
        <td><span class="verdict verdict-${verdict.tone}">${verdict.label}</span>${verdict.detail ? `<span class="verdict-detail">${escapeHtml(verdict.detail)}</span>` : ""}</td>
      </tr>`;
}

function watchRow(item) {
  const actionable = item.action !== "stand-aside";
  const side = item.side === "short" ? "short" : "long";
  return `
      <tr data-actionable="${actionable}">
        <th scope="row" class="sym"><span class="sym-name">${escapeHtml(item.symbol)}</span></th>
        <td>${actionable ? `<span class="chip chip-${side}">${side === "short" ? "sell ladder" : "buy ladder"}</span>` : '<span class="verdict verdict-bad">stand aside</span>'}</td>
        <td class="num">${actionable ? `${fixed(item.expectedWeeklyPct)}%` : "—"}</td>
        <td class="num">${actionable ? fixed(item.convictionPct, 0) : "—"}</td>
        <td class="rungs">${actionable ? (item.entries || []).map((entry) => `<span class="rung">${side === "short" ? "+" : "−"}${fixed(entry.stepFromAnchorPct, 0)}% <em>${fixed(entry.hitRatePct, 0)}%</em></span>`).join("") : `<span class="verdict-detail">${escapeHtml((item.reasons?.[0] || "").slice(0, 74))}</span>`}</td>
      </tr>`;
}

function page(book, holdingPlans, watchPlans) {
  const positions = book.positions || [];
  const longs = positions.filter((item) => item.position !== "short");
  const shorts = positions.filter((item) => item.position === "short");
  const winners = positions.filter((item) => Number(item.mtm) > 0);
  const measured = positions.map((item) => verdictOf(holdingPlans, item.symbol));
  const noEdge = measured.filter((plan) => plan && plan.action === "stand-aside").length;
  const confirmed = positions.filter((item) => {
    const plan = verdictOf(holdingPlans, item.symbol);
    return plan && plan.action !== "stand-aside" && (plan.side === "short") === (item.position === "short");
  }).length;
  const watchActionable = watchPlans.filter((item) => item.action !== "stand-aside");
  const captured = new Date(book.capturedAt);

  return `<title>K² Book &amp; Watchlist</title>
<style>
  :root {
    --panel: #FFFFFF; --panel-2: #F7F9FC; --ground: #F4F6FA; --line: #D8DEE9;
    --text: #171C26; --muted: #5C6779; --brass: #9A6B14; --brass-soft: #F3E7CC;
    --long: #1F6E52; --short: #9E3A31; --long-soft: #E2F0EA; --short-soft: #F8E5E3;
    --warn: #8A5A12; --warn-soft: #FAEDD6;
    --display: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    --body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
    --measure: 66ch;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --panel: #1A202C; --panel-2: #161B25; --ground: #12161F; --line: #2C3547;
      --text: #EAEEF6; --muted: #98A3B8; --brass: #D7A445; --brass-soft: #33291320;
      --long: #4FB88E; --short: #E0736A; --long-soft: #14312690; --short-soft: #3A1C1990;
      --warn: #D9A busy; --warn-soft: #3A2E1490;
    }
  }
  @media (prefers-color-scheme: dark) { :root { --warn: #D9A families; } }
  :root[data-theme="dark"] {
    --panel: #1A202C; --panel-2: #161B25; --ground: #12161F; --line: #2C3547;
    --text: #EAEEF6; --muted: #98A3B8; --brass: #D7A445; --brass-soft: #33291320;
    --long: #4FB88E; --short: #E0736A; --long-soft: #14312690; --short-soft: #3A1C1990;
    --warn: #D9A94B; --warn-soft: #3A2E1490;
  }
  :root[data-theme="light"] {
    --panel: #FFFFFF; --panel-2: #F7F9FC; --ground: #F4F6FA; --line: #D8DEE9;
    --text: #171C26; --muted: #5C6779; --brass: #9A6B14; --brass-soft: #F3E7CC;
    --long: #1F6E52; --short: #9E3A31; --long-soft: #E2F0EA; --short-soft: #F8E5E3;
    --warn: #8A5A12; --warn-soft: #FAEDD6;
  }

  body { margin: 0; background: var(--ground); color: var(--text); font-family: var(--body); line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: clamp(20px, 4vw, 56px) clamp(16px, 3vw, 32px) 72px; display: flex; flex-direction: column; gap: 40px; }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--brass); margin: 0 0 10px; }
  h1 { font-family: var(--display); font-weight: 400; font-size: clamp(30px, 5vw, 46px); line-height: 1.1; margin: 0 0 12px; text-wrap: balance; letter-spacing: -.01em; }
  h2 { font-family: var(--display); font-weight: 400; font-size: clamp(21px, 2.6vw, 27px); margin: 0 0 6px; text-wrap: balance; }
  .lede { max-width: var(--measure); color: var(--muted); font-size: 16px; margin: 0; }
  .lede strong { color: var(--text); font-weight: 600; }

  .band { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .stat { background: var(--panel); padding: 16px 18px; display: flex; flex-direction: column; gap: 3px; }
  .stat-value { font-family: var(--mono); font-size: 24px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .stat-label { font-size: 12px; color: var(--muted); }
  .neg { color: var(--short); }
  .pos { color: var(--long); }

  section { display: flex; flex-direction: column; gap: 16px; }
  .section-head { display: flex; flex-direction: column; gap: 4px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 6px 15px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
  button:hover { color: var(--text); border-color: var(--muted); }
  button[aria-pressed="true"] { color: var(--brass); border-color: var(--brass); background: var(--brass-soft); }
  button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

  .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 3px; background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 860px; }
  thead th { text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 400; padding: 11px 13px; border-bottom: 1px solid var(--line); background: var(--panel-2); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid var(--line); }
  tbody tr:last-child { border-bottom: 0; }
  tbody tr:nth-child(even) { background: var(--panel-2); }
  td, tbody th { padding: 10px 13px; vertical-align: middle; font-size: 14px; }
  .sym { text-align: left; font-weight: 400; display: flex; gap: 8px; align-items: center; }
  .sym-name { font-family: var(--mono); font-size: 13px; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .chip { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 6px; border-radius: 2px; white-space: nowrap; }
  .chip-long { color: var(--long); background: var(--long-soft); }
  .chip-short { color: var(--short); background: var(--short-soft); }
  .verdict { font-size: 11px; padding: 2px 7px; border-radius: 2px; white-space: nowrap; }
  .verdict-good { color: var(--long); background: var(--long-soft); }
  .verdict-bad { color: var(--short); background: var(--short-soft); }
  .verdict-warn { color: var(--warn); background: var(--warn-soft); }
  .verdict-none { color: var(--muted); border: 1px solid var(--line); }
  .verdict-detail { display: block; font-size: 10px; color: var(--muted); margin-top: 3px; }
  .rungs { display: flex; gap: 6px; flex-wrap: wrap; }
  .rung { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border: 1px solid var(--line); border-radius: 2px; background: var(--ground); white-space: nowrap; }
  .rung em { font-style: normal; color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 20px 22px; }
  .callout { border-left: 2px solid var(--brass); padding-left: 16px; }
  .note { font-size: 13px; color: var(--muted); max-width: var(--measure); margin: 0; }
  footer { border-top: 1px solid var(--line); padding-top: 22px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">GM Global · read live ${escapeHtml(captured.toISOString().slice(0, 16).replace("T", " "))} UTC</p>
    <h1>The book, and what the numbers say about it</h1>
    <p class="lede">
      ${positions.length} open futures positions, every one expiring ${escapeHtml(positions[0]?.expiry || "—")}.
      Each holding is paired with the measurement for that name: whether this desk's 2% ladder has ever
      actually worked on it. <strong>${noEdge} of ${positions.length}</strong> are in names where it has not.
    </p>
  </header>

  <div class="band">
    <div class="stat"><span class="stat-value">${positions.length}</span><span class="stat-label">open positions</span></div>
    <div class="stat"><span class="stat-value ${book.totalMtm < 0 ? "neg" : "pos"}">${rupees(book.totalMtm)}</span><span class="stat-label">mark to market</span></div>
    <div class="stat"><span class="stat-value">${winners.length}<span style="color:var(--muted);font-size:16px"> / ${positions.length}</span></span><span class="stat-label">in profit</span></div>
    <div class="stat"><span class="stat-value">${longs.length}<span style="color:var(--muted);font-size:16px"> / ${shorts.length}</span></span><span class="stat-label">long / short</span></div>
    <div class="stat"><span class="stat-value pos">${confirmed}</span><span class="stat-label">edge confirmed</span></div>
    <div class="stat"><span class="stat-value neg">${noEdge}</span><span class="stat-label">no measured edge</span></div>
  </div>

  <section>
    <div class="section-head">
      <h2>Open positions</h2>
      <p class="note">Target is 2% from your own average, not from the week's anchor. "To target" is how far the mark still has to travel to get there.</p>
    </div>
    <div class="controls">
      <button type="button" data-book="all" aria-pressed="true">All ${positions.length}</button>
      <button type="button" data-book="bad" aria-pressed="false">No measured edge ${noEdge}</button>
      <button type="button" data-book="good" aria-pressed="false">Edge confirmed ${confirmed}</button>
      <button type="button" data-booksort="distance" aria-pressed="true">Closest to target</button>
      <button type="button" data-booksort="mtm" aria-pressed="false">Worst first</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Instrument</th><th scope="col">Qty</th><th scope="col">Your average</th>
            <th scope="col">Mark</th><th scope="col">MTM</th><th scope="col">2% target</th>
            <th scope="col">To target</th><th scope="col">Measurement</th>
          </tr>
        </thead>
        <tbody id="book">${positions.map((position) => positionRow(position, holdingPlans)).join("")}</tbody>
      </table>
    </div>
  </section>

  <section>
    <div class="section-head">
      <h2>Watchlist · ${watchPlans.length} names</h2>
      <p class="note">${watchActionable.length} of ${watchPlans.length} carry a measured edge. Rungs are distance from Monday's open with the hit rate beside them; prices are set from that open each week.</p>
    </div>
    <div class="controls">
      <button type="button" data-watch="all" aria-pressed="true">All ${watchPlans.length}</button>
      <button type="button" data-watch="true" aria-pressed="false">With an edge ${watchActionable.length}</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th scope="col">Instrument</th><th scope="col">Call</th><th scope="col">Expected week</th><th scope="col">Conviction</th><th scope="col">Rungs / hit rate</th></tr>
        </thead>
        <tbody id="watch">${watchPlans.map(watchRow).join("")}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <div class="panel callout">
      <h2>How to read the measurement column</h2>
      <p class="note" style="margin-bottom:10px"><strong>Edge confirmed</strong> — over roughly five years of weeks, the 2% ladder on this name and this side beat a significance hurdle out of sample.</p>
      <p class="note" style="margin-bottom:10px"><strong>No measured edge</strong> — the ladder was tested on this name and did not clear it. That is not a prediction the position will lose; it means the rule that opened it has no measured support here.</p>
      <p class="note"><strong>Edge is the other way</strong> — the measurement favours the opposite side on this name.</p>
    </div>
  </footer>
</div>

<script>
  (function () {
    function wire(bodyId, filterAttr, sortAttr, matcher) {
      var body = document.getElementById(bodyId);
      if (!body) return;
      var rows = Array.prototype.slice.call(body.children);
      var filter = "all";
      var sort = sortAttr ? "distance" : null;

      function press(group, value) {
        document.querySelectorAll("[data-" + group + "]").forEach(function (button) {
          button.setAttribute("aria-pressed", String(button.dataset[group] === value));
        });
      }
      function apply() {
        if (sort) {
          rows.slice().sort(function (left, right) {
            return sort === "mtm"
              ? Number(left.dataset.mtm) - Number(right.dataset.mtm)
              : Number(left.dataset.distance) - Number(right.dataset.distance);
          }).forEach(function (node) { body.appendChild(node); });
        }
        rows.forEach(function (node) {
          node.style.display = filter === "all" || matcher(node, filter) ? "" : "none";
        });
      }
      document.querySelectorAll("[data-" + filterAttr + "]").forEach(function (button) {
        button.addEventListener("click", function () {
          filter = button.dataset[filterAttr];
          press(filterAttr, filter);
          apply();
        });
      });
      if (sortAttr) {
        document.querySelectorAll("[data-" + sortAttr + "]").forEach(function (button) {
          button.addEventListener("click", function () {
            sort = button.dataset[sortAttr];
            press(sortAttr, sort);
            apply();
          });
        });
      }
      apply();
    }

    wire("book", "book", "booksort", function (node, filter) { return node.dataset.tone === (filter === "bad" ? "bad" : "good"); });
    wire("watch", "watch", null, function (node, filter) { return node.dataset.actionable === filter; });
  }());
</script>
`;
}

function run() {
  const [bookPath, holdingPath, watchPath, destination] = process.argv.slice(2);
  if (!bookPath || !holdingPath || !watchPath || !destination) {
    throw new Error("usage: node scripts/build-book-page.js <gm-positions.json> <plan-holdings.json> <plan-watchlist.json> <out.html>");
  }
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const holdings = JSON.parse(fs.readFileSync(holdingPath, "utf8"));
  const watch = JSON.parse(fs.readFileSync(watchPath, "utf8"));
  const holdingPlans = [...(holdings.best || []), ...(holdings.rejected || []).map((item) => ({ symbol: item.symbol, action: "stand-aside", reasons: [item.reason] }))];
  const watchPlans = [...(watch.best || []), ...(watch.rejected || []).map((item) => ({ symbol: item.symbol, action: "stand-aside", reasons: [item.reason] }))]
    .sort((left, right) => (right.action === "stand-aside" ? -1 : 1) - (left.action === "stand-aside" ? -1 : 1)
      || Number(right.expectedWeeklyPct || 0) - Number(left.expectedWeeklyPct || 0)
      || left.symbol.localeCompare(right.symbol));
  fs.writeFileSync(destination, page(book, holdingPlans, watchPlans));
  console.log(`Wrote ${destination}: ${(book.positions || []).length} positions, ${watchPlans.length} watchlist names`);
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(`Book page build failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  }
}

module.exports = { page, toTarget };
