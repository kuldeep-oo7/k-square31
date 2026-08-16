"use strict";

// Builds the K² portal as static files.
//
// Two audiences on one page. The ladder plan carries no personal information and
// stays readable, so it can be shared. The book — positions, averages, P&L — is
// sealed with a passphrase at build time and opened in the browser, so the host
// only ever stores ciphertext even if the site is publicly reachable.
//
//   node scripts/build-portal.js site/
//
// Reads whichever inputs exist: gm-positions.json, plan-holdings.json,
// plan-watchlist.json, plan-full.json. Missing inputs degrade the matching
// section rather than failing the build, so a partial run still publishes.

const fs = require("node:fs");
const path = require("node:path");
const { sealPayload } = require("../api/_lib/portal-crypto");

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fixed = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function nextMonday(weekKey) {
  if (!weekKey) return null;
  const date = new Date(`${weekKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function planRow(item) {
  const side = item.side === "short" ? "short" : "long";
  const sign = side === "short" ? "+" : "−";
  const rungs = (item.entries || []).map((entry) => `
            <span class="rung">${sign}${fixed(entry.stepFromAnchorPct, 0)}%<em>${fixed(entry.hitRatePct, 0)}% · ${entry.historicalFills}</em></span>`).join("");
  return `
        <tr data-side="${side}" data-expected="${Number(item.expectedWeeklyPct)}" data-conviction="${Number(item.convictionPct)}">
          <th scope="row"><span class="tkr">${escapeHtml(item.symbol)}</span><span class="chip chip-${side}">${side === "short" ? "sell" : "buy"}</span></th>
          <td class="n big">${fixed(item.expectedWeeklyPct)}%</td>
          <td class="n"><span class="bar"><i style="width:${Math.max(2, Math.min(100, Number(item.convictionPct)))}%"></i></span>${fixed(item.convictionPct, 0)}</td>
          <td class="rungs">${rungs}</td>
          <td class="n">×${fixed(item.sizeMultiplier)}</td>
        </tr>`;
}

function document_(plan, sealed, meta) {
  const best = (plan?.best || []).slice(0, 60);
  const longs = best.filter((item) => item.side === "long").length;
  const shorts = best.filter((item) => item.side === "short").length;
  const monday = nextMonday(plan?.weekKey);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>K² · Range Desk</title>
<style>
  /* Tokens lifted from the desk's own styles.css so the portal reads as the same
     product: warm paper, ink, and the violet that carries every accent there.
     Semantic mint/coral stay separate from the accent, as they do in the app. */
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --ink: #1f2130;
    --muted: #6c6c78;
    --paper: #f7f4ec;
    --white: #fffefa;
    --line: rgba(31, 33, 48, .12);
    --violet: #6f59d9;
    --violet-soft: #eae5ff;
    --mint: #a8dfc5;
    --mint-deep: #167a62;
    --coral: #ff826f;
    --coral-deep: #b63c32;
    --sun: #f0cc55;
    --shadow: 0 18px 50px rgba(54, 46, 32, .09);
    --display: Georgia, "Times New Roman", serif;
    --body: Inter, Avenir, "Segoe UI", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #f3f1ea; --muted: #a09eae; --paper: #191a24; --white: #21222f;
      --line: rgba(243, 241, 234, .14);
      --violet: #a596ff; --violet-soft: #2b2551;
      --mint-deep: #6fd3ac; --coral-deep: #ff9d8c;
      --shadow: 0 18px 50px rgba(0, 0, 0, .38);
    }
  }
  :root[data-theme="dark"] {
    --ink: #f3f1ea; --muted: #a09eae; --paper: #191a24; --white: #21222f;
    --line: rgba(243, 241, 234, .14);
    --violet: #a596ff; --violet-soft: #2b2551;
    --mint-deep: #6fd3ac; --coral-deep: #ff9d8c;
    --shadow: 0 18px 50px rgba(0, 0, 0, .38);
  }
  :root[data-theme="light"] {
    --ink: #1f2130; --muted: #6c6c78; --paper: #f7f4ec; --white: #fffefa;
    --line: rgba(31, 33, 48, .12);
    --violet: #6f59d9; --violet-soft: #eae5ff;
    --mint-deep: #167a62; --coral-deep: #b63c32;
    --shadow: 0 18px 50px rgba(54, 46, 32, .09);
  }

  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--body); line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .shell { max-width: 1180px; margin: 0 auto; padding: clamp(18px, 3.5vw, 48px) clamp(14px, 3vw, 30px) 68px; }

  .masthead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 30px; }
  .wordmark { font-family: var(--display); font-weight: 400; font-size: clamp(31px, 5vw, 46px); line-height: 1; margin: 0; letter-spacing: -.015em; }
  .wordmark span { color: var(--violet); }
  .stamp { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); text-align: right; line-height: 1.7; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(138px, 1fr)); gap: 12px; margin-bottom: 34px; }
  .tile { background: var(--white); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; box-shadow: var(--shadow); }
  .tile b { display: block; font-family: var(--mono); font-size: 24px; font-variant-numeric: tabular-nums; font-weight: 500; letter-spacing: -.02em; }
  .tile span { font-size: 12px; color: var(--muted); }
  .tile.gold b { color: var(--violet); }
  .neg { color: var(--coral-deep); }
  .pos { color: var(--mint-deep); }

  section { margin-bottom: 42px; }
  h2 { font-family: var(--display); font-weight: 400; font-size: clamp(21px, 2.5vw, 28px); margin: 0 0 5px; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 18px; max-width: 66ch; }

  .row-tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; font-size: 13px; color: var(--muted); background: var(--white); border: 1px solid var(--line); border-radius: 999px; padding: 7px 16px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
  button:hover { color: var(--ink); border-color: var(--muted); }
  button[aria-pressed="true"] { color: var(--violet); border-color: var(--violet); background: var(--violet-soft); }
  button:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }

  .scroll { overflow-x: auto; background: var(--white); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
  table { width: 100%; border-collapse: collapse; min-width: 720px; }
  thead th { text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 400; padding: 13px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid var(--line); }
  tbody tr:last-child { border-bottom: 0; }
  td, tbody th { padding: 12px 16px; font-size: 14px; text-align: left; font-weight: 400; vertical-align: middle; }
  tbody th { display: flex; gap: 9px; align-items: center; }
  .tkr { font-family: var(--mono); font-size: 13px; }
  .n { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .n.big { font-size: 15px; }
  .chip { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .chip-long { color: var(--mint-deep); background: color-mix(in srgb, var(--mint) 40%, transparent); }
  .chip-short { color: var(--coral-deep); background: color-mix(in srgb, var(--coral) 26%, transparent); }
  .bar { display: inline-block; width: 56px; height: 5px; background: var(--line); border-radius: 999px; overflow: hidden; vertical-align: middle; margin-right: 9px; }
  .bar i { display: block; height: 100%; background: var(--violet); }
  .rungs { display: flex; gap: 7px; flex-wrap: wrap; }
  .rung { font-family: var(--mono); font-size: 11px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); white-space: nowrap; }
  .rung em { font-style: normal; color: var(--muted); margin-left: 6px; }
  .verdict { font-size: 11px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .v-good { color: var(--mint-deep); background: color-mix(in srgb, var(--mint) 40%, transparent); }
  .v-bad { color: var(--coral-deep); background: color-mix(in srgb, var(--coral) 26%, transparent); }
  .v-warn { color: #8a6b0f; background: color-mix(in srgb, var(--sun) 34%, transparent); }

  .lock { background: var(--white); border: 1px solid var(--line); border-radius: 20px; padding: clamp(22px, 4vw, 36px); max-width: 470px; box-shadow: var(--shadow); }
  .lock h3 { font-family: var(--display); font-weight: 400; font-size: 21px; margin: 0 0 6px; }
  .lock p { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
  .lock form { display: flex; gap: 9px; flex-wrap: wrap; }
  input[type="password"] { font: inherit; font-family: var(--mono); flex: 1 1 210px; min-width: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); color: var(--ink); }
  input[type="password"]:focus-visible { outline: 2px solid var(--violet); outline-offset: 1px; }
  .lock button { background: var(--violet); color: #fffefa; border-color: var(--violet); padding: 10px 24px; }
  .lock button:hover { color: #fffefa; opacity: .9; }
  .err { color: var(--coral-deep); font-size: 13px; margin: 14px 0 0; min-height: 1.2em; }
  [hidden] { display: none !important; }
  footer { border-top: 1px solid var(--line); padding-top: 22px; color: var(--muted); font-size: 12.5px; }
  footer p { margin: 0 0 7px; max-width: 74ch; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <h1 class="wordmark">K<span>²</span> Range Desk</h1>
    <div class="stamp">
      NSE futures · weekly ladder<br>
      built ${escapeHtml(meta.builtAt)} UTC
    </div>
  </header>

  <div class="grid">
    <div class="tile"><b>${plan?.universe ?? "—"}</b><span>names measured</span></div>
    <div class="tile gold"><b>${plan?.actionable ?? "—"}</b><span>cleared every test</span></div>
    <div class="tile"><b>${longs}</b><span>buy ladders</span></div>
    <div class="tile"><b>${shorts}</b><span>sell ladders</span></div>
    <div class="tile"><b>${fixed(best[0]?.expectedWeeklyPct)}%</b><span>best expected week</span></div>
  </div>

  <section id="book-section">
    <h2>The book</h2>
    <p class="sub">Your positions are encrypted in this page. The passphrase never leaves your browser, and the server only ever stores ciphertext.</p>
    ${sealed ? `
    <div class="lock" id="lock">
      <h3>Unlock the book</h3>
      <p>${meta.positionCount} positions, read from GM ${escapeHtml(meta.capturedAt)} UTC.</p>
      <form id="unlock-form">
        <label for="pass" class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Passphrase</label>
        <input type="password" id="pass" autocomplete="current-password" placeholder="passphrase" required>
        <button type="submit">Unlock</button>
      </form>
      <p class="err" id="err" role="alert"></p>
    </div>
    <div id="book" hidden></div>` : '<p class="sub">No book was included in this build.</p>'}
  </section>

  <section>
    <h2>Qualified ladders${plan?.weekKey ? ` · week of ${escapeHtml(monday || plan.weekKey)}` : ""}</h2>
    <p class="sub">Rungs are distance from Monday's open, with the measured hit rate and the number of historical fills behind it. Prices are set from that open each week.</p>
    <div class="row-tools">
      <button type="button" data-filter="all" aria-pressed="true">All ${best.length}</button>
      <button type="button" data-filter="long" aria-pressed="false">Buy ${longs}</button>
      <button type="button" data-filter="short" aria-pressed="false">Sell ${shorts}</button>
      <button type="button" data-sort="expected" aria-pressed="true">Expected</button>
      <button type="button" data-sort="conviction" aria-pressed="false">Conviction</button>
    </div>
    <div class="scroll">
      <table>
        <thead><tr><th scope="col">Instrument</th><th scope="col">Expected week</th><th scope="col">Conviction</th><th scope="col">Rungs from Monday's open</th><th scope="col">Size</th></tr></thead>
        <tbody id="plan-rows">${best.map(planRow).join("")}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <p><strong>Rule measured:</strong> the week's first open is the anchor; orders rest 2% apart; a leg exits on the first touch of a 2% gain. Costs charged at 0.06% per round trip. Hit rates carry 95% Wilson bounds and each rung clears a t-statistic hurdle raised for testing five rungs. Reported weeks are out of sample.</p>
    <p><strong>Gates:</strong> a 12-month trend running against the ladder is refused outright, as is a results date inside the trading week. A measured edge is not a promise.</p>
  </footer>
</div>

<script id="sealed" type="application/json">${sealed ? JSON.stringify(sealed) : "null"}</script>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll("#plan-rows tr"));
  var body = document.getElementById("plan-rows");
  var filter = "all", sort = "expected";
  function press(group, value) {
    document.querySelectorAll("[data-" + group + "]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset[group] === value)); });
  }
  function apply() {
    rows.slice().sort(function (a, b) { return Number(b.dataset[sort]) - Number(a.dataset[sort]); })
      .forEach(function (n) { body.appendChild(n); });
    rows.forEach(function (n) { n.style.display = filter === "all" || n.dataset.side === filter ? "" : "none"; });
  }
  document.querySelectorAll("[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () { filter = b.dataset.filter; press("filter", filter); apply(); });
  });
  document.querySelectorAll("[data-sort]").forEach(function (b) {
    b.addEventListener("click", function () { sort = b.dataset.sort; press("sort", sort); apply(); });
  });
  apply();

  var sealedNode = document.getElementById("sealed");
  var sealed = null;
  try { sealed = JSON.parse(sealedNode.textContent); } catch (e) { sealed = null; }
  var form = document.getElementById("unlock-form");
  if (!sealed || !form) return;

  var b64 = function (value) {
    var raw = atob(value), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  var money = function (value) {
    if (typeof value !== "number" || !isFinite(value)) return "\\u2014";
    return (value < 0 ? "\\u2212" : "") + "\\u20B9" + Math.abs(Math.round(value)).toLocaleString("en-IN");
  };
  var num = function (value, digits) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(digits === undefined ? 2 : digits) : "\\u2014";
  };

  function render(book) {
    var rowsHtml = book.positions.map(function (p) {
      var short = p.position === "short";
      var v = p.verdict || { label: "not measured", tone: "none" };
      var cls = v.tone === "good" ? "v-good" : v.tone === "bad" ? "v-bad" : v.tone === "warn" ? "v-warn" : "";
      return '<tr>'
        + '<th scope="row"><span class="tkr">' + p.symbol + '</span><span class="chip chip-' + (short ? "short" : "long") + '">' + (short ? "short" : "long") + '</span></th>'
        + '<td class="n">' + p.quantity.toLocaleString("en-IN") + '</td>'
        + '<td class="n">' + num(p.average) + '</td>'
        + '<td class="n">' + num(p.mark) + '</td>'
        + '<td class="n ' + (p.mtm < 0 ? "neg" : "pos") + '">' + money(p.mtm) + '</td>'
        + '<td class="n">' + num(p.target) + '</td>'
        + '<td class="n">' + (p.toTargetPct <= 0 ? "reached" : num(p.toTargetPct) + "%") + '</td>'
        + '<td>' + (p.trend
            ? '<span class="verdict ' + (p.trend.blocked ? "v-bad" : "v-good") + '">' + p.trend.label + '</span>'
              + '<span class="verdict-detail">12m ' + num(p.trend.returnPct, 1) + '%</span>'
            : '<span class="verdict-detail">not measured</span>') + '</td>'
        + '<td class="n ' + (p.carry ? (p.carry.favourable ? "pos" : "neg") : "") + '">'
            + (p.carry ? num(p.carry.weeklyPct) + '%/wk' : '—') + '</td>'
        + '<td><span class="verdict ' + cls + '">' + v.label + '</span></td>'
        + '</tr>';
    }).join("");

    document.getElementById("book").innerHTML =
      '<div class="grid">'
      + '<div class="tile"><b>' + book.positions.length + '</b><span>open positions</span></div>'
      + '<div class="tile"><b class="' + (book.totalMtm < 0 ? "neg" : "pos") + '">' + money(book.totalMtm) + '</b><span>mark to market</span></div>'
      + '<div class="tile"><b>' + book.inProfit + ' / ' + book.positions.length + '</b><span>in profit</span></div>'
      + '<div class="tile"><b>' + book.confirmed + '</b><span>edge confirmed</span></div>'
      + '<div class="tile"><b class="neg">' + book.noEdge + '</b><span>no measured edge</span></div>'
      + '<div class="tile"><b class="neg">' + book.trendBlocked + '</b><span>against the trend</span></div>'
      + '<div class="tile"><b class="neg">' + (book.carryCosting || 0) + '</b><span>paying carry</span></div>'
      + '</div>'
      + '<div class="scroll"><table><thead><tr>'
      + '<th scope="col">Instrument</th><th scope="col">Qty</th><th scope="col">Your average</th><th scope="col">Mark</th>'
      + '<th scope="col">MTM</th><th scope="col">2% target</th><th scope="col">To target</th>'
      + '<th scope="col">12-month trend</th><th scope="col">Carry</th><th scope="col">Ladder</th>'
      + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    document.getElementById("book").hidden = false;
    document.getElementById("lock").hidden = true;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var err = document.getElementById("err");
    var pass = document.getElementById("pass").value;
    err.textContent = "Opening\\u2026";
    crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"])
      .then(function (material) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64(sealed.salt), iterations: sealed.iterations, hash: "SHA-256" },
          material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
        );
      })
      .then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(sealed.iv) }, key, b64(sealed.ciphertext));
      })
      .then(function (plain) {
        render(JSON.parse(new TextDecoder().decode(plain)));
      })
      .catch(function () {
        err.textContent = "That passphrase did not open the book. Check it and try again.";
      });
  });
}());
</script>
</body>
</html>
`;
}

// The private payload is reduced to exactly what the page renders, so nothing
// extra is carried into the ciphertext.
function bookPayload(book, plans, context = {}) {
  const bySymbol = new Map(plans.map((item) => [item.symbol, item]));
  const positions = (book.positions || []).map((position) => {
    const short = position.position === "short";
    const average = Number(position.buyAverage) || Number(position.price);
    const mark = Number(position.markPrice) || average;
    const target = short ? average * 0.98 : average * 1.02;
    const toTargetPct = short ? (mark / target - 1) * 100 : (target / mark - 1) * 100;
    const plan = bySymbol.get(position.symbol);
    const verdict = !plan ? { label: "not measured", tone: "none" }
      : plan.action === "stand-aside"
        ? { label: /trend runs against/.test(plan.reasons?.[0] || "") ? "against the trend" : "no measured edge", tone: "bad" }
        : (plan.side === "short") === short
          ? { label: "edge confirmed", tone: "good" }
          : { label: "edge is the other way", tone: "warn" };
    const reading = context[position.symbol] || {};
    return {
      symbol: position.symbol,
      position: short ? "short" : "long",
      trend: reading.trend || null,
      carry: reading.carry || null,
      quantity: Number(position.quantity),
      average: Math.round(average * 100) / 100,
      mark: Math.round(mark * 100) / 100,
      mtm: Number(position.mtm),
      target: Math.round(target * 100) / 100,
      toTargetPct: Math.round(toTargetPct * 100) / 100,
      verdict
    };
  });
  return {
    capturedAt: book.capturedAt,
    totalMtm: Number(book.totalMtm),
    positions,
    inProfit: positions.filter((item) => item.mtm > 0).length,
    confirmed: positions.filter((item) => item.verdict.tone === "good").length,
    noEdge: positions.filter((item) => item.verdict.tone === "bad").length,
    // Counted from the direct reading rather than from the ladder verdict: a
    // holding rejected at the significance hurdle never reaches the trend check,
    // which is why this used to report zero.
    trendBlocked: positions.filter((item) => item.trend?.blocked).length,
    carryCosting: positions.filter((item) => item.carry && !item.carry.favourable).length
  };
}

function run() {
  const outputDir = process.argv[2] || "site";
  const passphrase = process.env.K2_PORTAL_PASSPHRASE || "";
  const book = readJson("gm-positions.json");
  const holdings = readJson("plan-holdings.json");
  const plan = readJson("plan-full.json") || readJson("plan-watchlist.json");
  const context = readJson("book-context.json")?.context || {};

  const holdingPlans = holdings
    ? [...(holdings.best || []), ...(holdings.rejected || []).map((item) => ({ symbol: item.symbol, action: "stand-aside", reasons: [item.reason] }))]
    : [];

  let sealed = null;
  let meta = { builtAt: new Date().toISOString().slice(0, 16).replace("T", " "), positionCount: 0, capturedAt: "—" };
  if (book && passphrase) {
    const payload = bookPayload(book, holdingPlans, context);
    sealed = sealPayload(payload, passphrase);
    meta = { ...meta, positionCount: payload.positions.length, capturedAt: String(book.capturedAt || "").slice(0, 16).replace("T", " ") };
  } else if (book && !passphrase) {
    console.warn("K2_PORTAL_PASSPHRASE is not set: publishing the plan only, with no book.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.html"), document_(plan, sealed, meta));
  // Keeps Pages from running the output through Jekyll.
  fs.writeFileSync(path.join(outputDir, ".nojekyll"), "");
  console.log(`Portal written to ${outputDir}: ${(plan?.best || []).length} ladders, ${sealed ? `${meta.positionCount} positions sealed` : "no book"}`);
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(`Portal build failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  }
}

module.exports = { bookPayload, document_ };
