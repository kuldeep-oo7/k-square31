---
name: k2-audit-protocol-v2-2026-10-04
description: The owner asked to audit the testing method itself. The old verdict rule was too strict, so FAIL meant "unproven". Under protocol v2 (full 6 years, excess return, t>=3, Holm + DSR), the short NIFTY 2% strangle PASSES and 4 rules are PROMISING. Desk candles LONG are significantly NEGATIVE.
metadata:
  type: project
---

**What the audit found (4 Oct 2026; research/audit-2026-10-04).** The old rule judged each strategy
on the final 12 months only, clustered by month (11 df), required the validation year to be
positive, and applied Holm across up to 36 members. Passing needed an annual Sharpe of about 4 in
one year, so the old FAILs meant "unproven". Long-only signals were also scored on raw returns,
which market moves swamped.

**Protocol v2** (PROTOCOL.txt sha256 be9d3dce..., fixed before re-scoring):
- all 6 years, as a monthly series with a Newey-West(3) t;
- stock trades scored in EXCESS of an equal-weight top-200 universe over the same window;
- PASS at t >= 3 (Harvey-Liu-Zhu 2016); PROMISING at 2-3;
- Holm across 73 testable members, plus the Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014);
- members with fitted parameters scored on validation + final only.

rescore.js runs each study's OWN run() unchanged.

**Results:**
- **PASS:** short NIFTY 2% strangle to weekly expiry. +0.101% of NIFTY a trade, t 4.66, annual
  Sharpe 1.93, 61 months; it survives Holm across 73. But DSR is 0.39, below the 2.05 expected
  best Sharpe from 73 trials. The variant was motivated by F11, and it is option SELLING.
- **PROMISING:** in excess terms, the MA 5-150 and MA 1-150 cross-DOWN shorts (+0.31/+0.34%,
  t 2.6/2.3), the short NIFTY straddle (t 2.34), and the Connors RSI2 short (t 2.22).
- **Significantly NEGATIVE:**
  - desk candlestick bullish signal: −0.092% excess a trade, t −3.33, 37k trades;
  - MA cross-UP longs: t −3.1 to −3.2;
  - MACD short: t −3.16;
  - desk "rising on own" H2/H3;
  - the option BUYER's long straddle: t −2.79.

**Why:** the owner suspected the testing itself was wrong, and partly it was.

**How to apply:**
- Use protocol v2 for every future test: whole sample, excess return, t>=3, and report DSR.
- Never call a FAIL under the old rule "doesn't work"; it means "unproven".
- The desk's candlestick input to the rating measurably hurts (t −3.33). Propose dropping it from
  the composite, and get the owner's yes first.

See [[k2-ta-atlas-2026-10-03]] and [[k2-families-2026-10-04]].

**Done 4 Oct 2026 (owner: "yes do all three"; commit 3f22349):**
1. The candle term in unified-quant-scanner.js is held at a neutral 50; no weight moves. The rank
   correlation with the old rating is 0.935, and 52/280 names moved one band.
2. and 3. Forward paper tests, preregistered in studies/forward-v2-2026-10-04 and built by
   api/_lib/forward-v2.js and scripts/forward-v2.js into docs/paper-rules/forward-v2.json:
   - the NIFTY 2% strangle, a verdict after 26 trades;
   - the MA150 cross-down shorts A/B, scored against the market, a verdict after 100 trades and
     3 months.
- The daily job (springy-dip.yml) now also fetches ind_close_all (NIFTY close) and option
  aggregates for the last 40 days.
- The universe includes ETFs such as LIQUIDBEES, as in the original study; this is a known quirk
  and was left as registered.

**Audit items fixed 4 Oct 2026 (the owner: "SO YOU KNOW THEN FIX THIS"); commits b81325b, bca451d, dc428c8:**
- **After-hours futures check.** The page was right. The audit had compared against NSE's lastPrice
  instead of closePrice (the official close, which equals the bhavcopy close/settle). It now uses
  closePrice after the close.
- **F3.** The page now states that no shock gate runs. The K2-lang "INDIA_VIX < 22" REQUIRE is
  evaluated, but k2StrategyPassed is read by nothing, so there is NO VIX gate either. Verify claims
  like this in code before writing them.
- **F23.** Release data-nse-idx holds 561 sessions of the five option indices from ind_close_all.
  desk.yml downloads it; prepare-static-build fills bar-cache and risk-history where Yahoo is thin;
  springy-dip.yml keeps it current. FINNIFTY now has rv 14 and touch 44.1%, and the risk view covers
  358/358 puts.
- **F26.** The citation is replaced by the rating replay ([[k2-rating-replay-2026-10-04]]).
- **F27.** After the close the header uses ind_close_all's official India VIX close (1 Oct: 14.46,
  where allIndices kept 14.44).
- **Order flow.** Angel FULL depth (best 5 with order counts, totBuy/totSell, avg) is now kept on the
  quotes. Each in-session build appends a line to the private release orderflow-rec
  (of-YYYY-MM-DD.jsonl.gz). The first recording is due Mon 5 Oct from 09:16.
- **NSE throttling.** Two parallel nsearchives downloads from the laptop cause "fetch failed" and
  "terminated" errors; run them one after another.
