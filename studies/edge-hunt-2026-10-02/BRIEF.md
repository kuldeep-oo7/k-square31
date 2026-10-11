# Edge hunt, 2 Oct 2026: find a rule that makes money on NSE, honestly

The owner's words: "do whatever, build whatever, test it and give me something that can make me
profit". Read `CLAUDE.md` and `HANDOVER.md` first. Open the notes in `notes/claude-memory/` only
when you need them, because the owner pays per token.

The owner wants profit, not process. Nothing is guaranteed, and you must never claim it is.
Your job is to find rules that **pass** an honest test, and to say plainly which ones fail.

## Rules of the work

- **Branch and folder:** work on branch `claude/edge-hunt-2026-10-02`, in
  `studies/edge-hunt-2026-10-02/`. Never push to `main`. Open a PR at the end.
- **Pre-registration:** write and commit `PREREGISTRATION.txt` (with its sha256 in
  `PREREGISTRATION.sha256`) and push it BEFORE computing anything on real data. Test the code
  on synthetic data first. Include:
  - a planted edge that must be found;
  - pure noise that must not pass;
  - a check that changing future prices never changes past signals.
- **Data:** `gh release download data-nse-cm -p nse-cm.tar.gz` gives NSE's daily equity
  bhavcopy, every stock, 2020-09 → 2026-10-01, unadjusted, plus `nifty-50-nse.json`. If `gh`
  fails, use the REST fallback in CLAUDE.md. The cloud cannot reach NSE, so add any new NSE
  data via a GitHub Actions workflow on your branch. Copy `.github/workflows/nse-data.yml`,
  run it with `gh workflow run <file> --ref claude/edge-hunt-2026-10-02`, and publish to a
  release. Verify every NSE file name and its columns against NSE's own site from inside the
  workflow, and log what came back.
- **Splits and bonuses:** verify on known ex-dates (RELIANCE 1:1 bonus Oct 2024, TATASTEEL 1:10
  split Jul 2022, IRCTC 1:5 split Oct 2021) whether the prevClose column is adjusted. Drop any
  trade whose window crosses a corporate action.
- **Universe:** each month, the top 200 EQ stocks by median traded value over the previous 60
  sessions. Delisted names stay in.
- **Trade geometry:** the desk's futures geometry, as the gap-filter study and the strategy-atlas
  brief define it:
  - buy at open × 0.992, rounded down to 0.05, filled only if the low trades below it;
  - target +2.5%, stop −1.5%; on the same bar the stop comes first; gaps exit at the open;
  - hold at most 20 sessions;
  - the mirror for shorts.
- **Costs:** dated, from `api/_lib/shadow-broker.js` `calculateNseFuturesCharges` on both legs,
  quantity = ceil(500000/price). Returns are net.
- **Windows:**
  - development: before 2024-09-19;
  - validation: 2024-09-19 .. 2025-09-17;
  - final: 2025-09-18 .. 2026-09-15.

  The final window has been reused about 10 times, so say so.
- **Statistics:** clustered by calendar month. PASS = validation mean > 0 AND final mean > 0 AND
  the one-sided final p survives Holm across the whole family at 5%. Fewer than 30 final
  trades = NOT TESTABLE.

## The family (register all, then run once)

**A. The rule now LIVE on the page (most urgent: it is shown untested).**
In a NIFTY downtrend (NIFTY close < EMA20 < SMA50, `api/_lib/market-regime.js`
`classifyMarketRegime`), stocks in their own uptrend (the same reader on the stock's own bars:
BULL_TRENDING) are bought with the desk geometry the next session. Also report, descriptively,
the same stocks in every market, and the matching put side: falling stocks in a downtrend,
shorted. If A fails, say so loudly: the page must then carry that verdict.

**B. Order flow / open interest (what the owner hears "market makers and FIIs" use).**
Data: NSE's F&O bhavcopy, which has open interest and change in OI per contract.
- B1, long build-up: near-month stock future with OI up and price up on day d-1 (thresholds
  fixed in the registration) → long on day d.
- B2, short build-up: OI up and price down → short.
- B3, short covering: OI down and price up → long.

Use thresholds from published practice if you can source them. Otherwise use terciles fixed
on the development window only.

**C. Participant positioning.**
Use NSE's daily participant-wise open interest (FII / DII / Client / Pro, index futures long
and short), if the file exists and you can verify it on NSE. The rule: a change in FII net
index-futures position on day d-1 → NIFTY futures long or short on day d (and through d+4,
registered as a separate member).

**D. Optional, only if time and data allow:** the strategy-atlas members (Turtle, RSI(2), NR7,
52-week high) from branch `claude/strategy-atlas-2026-09-30`. Read its BRIEF. Its registration
was never pushed, so register it fresh here.

## Deliverables

- `RESULT.txt` and `READ-THIS-FIRST.txt`. One line per member: PASS / FAIL / NOT TESTABLE,
  with the validation and final mean, t and trades, written for a phone reader.
- If anything PASSES: open a SEPARATE pull request that adds it to the page as a labelled
  "passed on re-used data, paper first" row source, with tests and the
  `simulate-market-scenarios` checks. Then run `page-check.yml` after the owner merges and
  read the photos.
- If **A FAILS:** open a pull request that adds that verdict to the banner's rising-stocks
  sentence. Don't remove the rows; the owner wants them shown.
- Save durable lessons to `notes/claude-memory/` (no secrets).
- Final message: plain words, what passed, what failed, and what to do on Monday.
