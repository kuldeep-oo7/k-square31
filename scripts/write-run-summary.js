"use strict";

/**
 * A PLACE TO READ THE PRICES THAT NEEDS NOTHING FROM ANYBODY.
 *
 * The question was "what if i want to go to my office or any where in this
 * world then how i can see it". Every answer so far has had a catch:
 *
 *   GitHub Pages   asked directly, the API said "Your current plan does not
 *                  support GitHub Pages for this repository" (HTTP 422). Pages
 *                  needs a PUBLIC repository on GitHub Free, and this one holds
 *                  the strategy.
 *   Google Sheet   the deployed Apps Script web app is an older version than
 *                  the source in google-sheets/: measured on 2026-09-23, it has
 *                  neither appendDailyRecommendations nor appendTradeSignals,
 *                  so it can store the snapshot document but cannot write a row
 *                  a human can read. That needs a re-deploy, by hand, in a
 *                  Google account this process cannot reach.
 *   Cloudflare,
 *   Netlify        free and they serve private repositories -- but both need an
 *                  account authorised through a browser.
 *
 * This one has no catch. GitHub renders $GITHUB_STEP_SUMMARY as markdown on the
 * run page, the run page is private to the repository, and the GitHub mobile
 * app opens it on any phone on any network in the world. Nothing to deploy,
 * nothing to authorise, nothing that can be suspended, and no second account.
 *
 * Open: the repository -> Actions -> the newest "Build the desk" run.
 */

const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.resolve(__dirname, "..", "docs");

function rupee(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** Has the market come to the limit yet? The only line that moves all day. */
function gap(limit, now) {
  const l = Number(limit);
  const p = Number(now);
  if (!Number.isFinite(l) || !Number.isFinite(p) || l <= 0) return "no price";
  const pct = ((p - l) / l) * 100;
  // Same rule as the page: a buy limit fills only when the price comes DOWN to
  // it. The old 1% tolerance marked every futures row ✅ at the moment it was
  // set, because every futures limit sits 0.8% under the price by design.
  if (pct <= 0) return "**at or below** ✅";
  if (pct <= 0.1) return "**at limit** ✅";
  return "waiting — needs a " + (((p - l) / p) * 100).toFixed(1) + "% dip";
}

function main() {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (!out) { console.log("run summary: not on a GitHub runner, nothing written"); return; }

  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(DOCS, "data.json"), "utf8")); }
  catch (error) { fs.appendFileSync(out, "## K² Desk\n\nNo build output to show — " + error.message + "\n"); return; }

  const lines = [];
  lines.push("# K² Desk — " + d.sessionDate);
  lines.push("");
  lines.push("Built **" + d.builtAtIst + "** · market **" + d.marketPhase + "** · "
    + Number(d.examined).toLocaleString("en-IN") + " contracts examined, "
    + Number(d.survived).toLocaleString("en-IN") + " cleared every gate.");
  lines.push("");

  if (d.levelsFrozen) {
    lines.push("> **The buy limit, target and stop below are FIXED for today.** They were set at **"
      + (d.levelsOpenedAtIst || "the first build after the open")
      + "** and do not move again, however far the market runs. Only the `NOW` column changes.");
  } else {
    lines.push("> **These levels are INDICATIVE, not fixed.** The market is "
      + String(d.marketPhase).toLowerCase() + ", so there is no traded price to anchor them to "
      + "and nothing has been written down. They are set once — and then held all day — "
      + "on the first build after the opening bell.");
  }
  lines.push("");

  if (d.pricedLive > 0) {
    lines.push("**" + d.pricedLive + "** contracts priced from a live broker book, **"
      + d.pricedFromSettlement + "** from the " + d.settlementFile + " settlement file.");
  } else {
    lines.push("⚠️ **No live broker book was seen.** Every price here comes from the **"
      + d.settlementFile + "** settlement file. During an open session the screener refuses a "
      + "settled price outright rather than quoting yesterday's close as today's entry, so an "
      + "empty options table during market hours means the broker login is missing, not that "
      + "nothing qualified.");
  }
  lines.push("");

  // Said separately from the line above, because "no live book" has two causes
  // and only one of them is fixable: the login failed, or nothing is trading.
  if (d.brokerCheck) {
    const at = new Date(Date.parse(d.brokerCheck.checkedAt) + 330 * 60_000).toISOString().slice(11, 16) + " IST";
    lines.push(d.brokerCheck.ok
      ? "✅ **Broker login OK** from the build server at " + at + " — a NIFTY quote came back."
      : "❌ **Broker login FAILED** at " + at + " (stage " + d.brokerCheck.stage + ": " + d.brokerCheck.reason
        + (d.brokerCheck.message ? " — " + d.brokerCheck.message : "")
        + "). Until this is fixed the options table stays empty during market hours.");
    lines.push("");
  }

  // The track record, one line per kind, before the prices: whether the desk has
  // been right is the first thing worth knowing about today's list.
  if (d.track && d.track.summary) {
    const s = d.track.summary;
    const line = (label, x) => "| " + label + " | " + x.shown + " | " + x.open + " | " + x.target + " | " + x.stop
      + " | " + (x.expired + x.unfilled) + " | " + (x.hitRatePct === null ? "—" : x.hitRatePct + "%")
      + " | " + (x.randomHitRatePct === null || x.randomHitRatePct === undefined ? "—" : x.randomHitRatePct + "%") + " |";
    lines.push("## Track record — every price shown, bought on paper");
    lines.push("");
    lines.push("| | Shown | Open | Target ✓ | Stop ✗ | Expired / unfilled | Hit rate | If random (break-even) |");
    lines.push("|---|--:|--:|--:|--:|--:|--:|--:|");
    lines.push(line("Futures", s.FUT));
    lines.push(line("Calls", s.CE));
    lines.push(line("Puts", s.PE));
    lines.push(line("**All**", s.ALL));
    lines.push("");
  } else if (d.ledgerError) {
    lines.push("❌ **Track record not updated on this build:** " + d.ledgerError);
    lines.push("");
  }

  // Futures first, then calls, then puts: three different trades, kept apart,
  // in the order the money is actually on them.
  lines.push("## Futures — GM minimum 20 units (" + d.futures.length + ")");
  lines.push("");
  if (!d.futures.length) {
    lines.push("_Nothing cleared the hurdle on this build._");
  } else {
    lines.push("| Symbol | Buy limit | Target 1 | Target 2 | Stop | Now | 20 units | At stop | At target | R:R |");
    lines.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const r of d.futures) {
      lines.push("| `" + r.tradingSymbol + "`"
        + " | **" + rupee(r.buy) + "** | " + rupee(r.target1) + " | " + rupee(r.target2)
        + " | " + rupee(r.stop) + " | " + rupee(r.spot) + "<br>" + gap(r.buy, r.spot)
        + " | " + rupee(r.minCapital ?? r.perUnitCapital) + " | −" + rupee(r.minLossAtStop) + " | +" + rupee(r.minGainAtTarget)
        + " | " + (r.rewardToRisk ?? "—") + " |");
    }
  }
  lines.push("");

  const optionSection = (title, list, empty) => {
    lines.push("## " + title + " (" + list.length + ")");
    lines.push("");
    if (!list.length) {
      lines.push("_" + empty + "_");
    } else {
      lines.push("| Contract | Buy limit | Sell | Stop | Now | Per lot | Net at sell | Net at stop |");
      lines.push("|---|--:|--:|--:|--:|--:|--:|--:|");
      for (const c of list) {
        lines.push("| `" + c.zerodha + "`<br>" + c.daysLeft + "d left"
          + " | **" + rupee(c.buy) + "** | " + rupee(c.sell) + " | " + rupee(c.stop)
          + " | " + rupee(c.now) + "<br>" + gap(c.buy, c.now)
          + " | " + rupee(c.costPerLot) + " | +" + rupee(c.netProfit) + " | " + (c.netLossAtStop != null ? "−" + rupee(Math.abs(c.netLossAtStop)) : "—") + " |");
      }
    }
    lines.push("");
  };
  optionSection("Calls — pays if the stock RISES", d.options.filter((c) => c.right === "CE"),
    "No calls cleared every gate on this build.");
  optionSection("Puts — pays if the stock FALLS", d.options.filter((c) => c.right === "PE"),
    d.optionsDirection
      ? "No puts, by design: the desk has no bearish view, and betting on falls lost money in all 24 tested set-ups."
      : "No puts cleared every gate on this build.");
  lines.push("---");
  lines.push("");
  lines.push("Net figures are after brokerage, STT at 0.15% on the sell side, exchange charges, "
    + "stamp duty and GST; the spread is extra and is only known where a live book was seen. "
    + "**Check the price on your broker before placing anything** — this is a snapshot, not a feed.");
  lines.push("");
  lines.push("The paper ledger still has no closed trades, so nothing here has a measured hit "
    + "rate. The ranking is built on things that were measured, which is not the same as an "
    + "edge that was proven.");

  fs.appendFileSync(out, lines.join("\n") + "\n");
  console.log("run summary: wrote " + d.options.length + " option rows and "
    + d.futures.length + " futures rows to the run page");
}

try { main(); } catch (error) {
  // A summary is a convenience. It must never cost the build that made the prices.
  console.log("run summary: skipped --", error.message);
}
