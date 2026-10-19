# K² desk: rules for every Claude session (laptop or cloud)

Also read `HANDOVER.md` (study results, the owner's chat rules, known problems) and `notes/claude-memory/MEMORY.md`, a one-line index of the laptop Claude's memory notes. **To save the owner's credit, do NOT read every note.** Open a note only when the task touches its subject. Treat each note as true when written, and check names and numbers against the code. Add new durable facts there, never secrets. Keep replies and file reads lean: the owner pays per token. A cloud session can't see the owner's laptop. It has no `~/.claude` memory, no `.private/`
and no `research/`. This file carries what it needs. Nothing secret belongs here.

## Who reads the desk, and how

- The page is https://kuldeep-oo7.github.io/k2-desk/: NSE F&O, with tabs FUTURES, CALLS, PUTS
  and TRACK.
- The owner reads it **mostly on a phone** (Samsung Galaxy S25, base model, from 11 Oct 2026: a 360 x 780 px page at 3x, per YesViz; was a Galaxy M32 at 412 px),
  usually at the office during market hours.
- They trade futures **by hand** on GM Global, a paper competition among friends.
  **Fetch, read and store NOTHING from GM Global. Never add a GM data source.** "Broker" on
  this desk means Angel One (market data only).
- They buy real calls and puts on Zerodha. Every option shown must be an order Zerodha
  accepts.
- They want plain words, short sentences, and numbers with their source. Answer in chat;
  don't make artifacts unless asked.

## Standing rules

1. **Verify every outside fact against its primary owner before coding or stating it**: NSE's
   own files, the broker's own docs, the paper itself. Use at least two sources when you can.
   Quote the number and name the source. Label anything unverified. On this desk, guessed
   facts were repeatedly wrong *silently*: a tax rate, a symbol format, the expiry weekday.
2. **"Pushed" is not "deployed", and "deployed" is not "serving".** Before saying something
   is live, fetch it and read what comes back.
3. **Photograph the page after every change that reaches it, and read the photos yourself.**
   Check every tab, top and scrolled, phone first. Without the laptop, use the
   `page-check` workflow (below). Backend checks are not this check. If you can't get the
   photos, say so. Never report success without them.
4. **Never claim a guarantee or a proven edge.** A rule reaches the page only after a
   **pre-registered** test passes. Write the rules, hash them with sha256, and commit them
   *before* computing anything on real data. Even then it goes to TRACK as a paper rule
   first. Report FAIL as FAIL, with its numbers.
5. **Upgrade only; never silently downgrade or remove a working feature.** No display cap on
   passing rows: every contract that clears every gate is shown, and several strikes of one
   stock count as one bet. Tighten a gate instead, and say which one.
6. **Never push to `main` between 09:13 and 09:40 IST on trading days.** That is when the day's
   levels freeze. Prefer a branch plus a pull request that the owner merges.
7. **Never ask for, print or commit secrets.** They live in GitHub Actions secrets and in
   Cloudflare. The owner sets them; you don't.
8. Don't commit downloaded market data. It lives on releases of the PRIVATE repo `kuldeep-oo7/k2-data` (from 16 Oct 2026;
   **k-square31 is PUBLIC since 18 Oct 2026**: never put data, predictions or secrets in commits, logs or artifacts). Workflows use it when repo variable `K2_DATA_REPO` is set, with secret `K2_DATA_TOKEN` (test: data-token-check.yml); `page-check` stays here.
9. **Audit like a sceptic, and follow every change through the web (owner, 12 Oct 2026).**
   - Question every figure and feature from several angles: what is it, why is it there, where does
     the number come from, when was it true, who uses it, is it right, what would prove it wrong.
   - Check it against its primary source on the live internet and against the logs and data, not
     against what the code intends.
   - Before and after any fix, trace what it touches: if this changes, what else reads it (page,
     TRACK, tests, health gate, workflows, Sheet, live script, memory), and what do THOSE feed?
     Change, test and photograph every link in that chain, phone and laptop.
   - After the market closes, audit the whole day's screen: what was right, what was wrong, with
     the evidence. Then update memory and this file.

## How the desk runs (no server)

- `.github/workflows/desk.yml` builds the page and commits it to `main` (`docs/`). The build
  is started by cron-job.org at `13,33,53 9-15 * * 1-5` IST, plus 09:16. GitHub's own
  scheduler is only a backstop, because it dropped whole mornings.
- A `desk: rebuilt` commit from k2-desk-bot appears every ~20 min. Pull before pushing.
- To rebuild now: `gh workflow run desk.yml`.
- The page is mirrored to the public repo `kuldeep-oo7/k2-desk` (GitHub Pages).
- Market direction (`api/_lib/market-direction.js`): when NIFTY's close < EMA20 < SMA50, the
  page shows puts only (index puts, plus SELL/REDUCE stocks in their own downtrend). It has
  done so since 2 Sep 2026. That rule's own pre-registered test FAILED, and the page says so.
- **Proven only (owner, 13 Oct 2026):** every tab opens on NO TRADE and its rows fold as UNTESTED - WATCH ONLY; tab counts
  are proven trades. A kind leaves the fold only when its rule passes and is added to `PROVEN_KINDS` (publish-static-desk.js).
  Don't present untested rows as suggestions anywhere (owner: "suggest me only that you are sure").
- **Focus rule (owner, 14 Oct 2026: "focus on the one thing ... for a period of time"):** short build-up only, at the top
  of FUTURES (sbFocusBox, never folded on the phone), for GM Global (paper) only, until its forward verdict (100 trades +
  3 months from 5 Oct, ~Jan 2027). Signals from docs/paper-rules/oi-flow.json; a list made for another session is never
  shown. The NSE downloaders fetch today's file from 19:00 IST so the evening job makes the next day's list.
- **Live now (18 Oct 2026):** in session, the focus box and Kronos box show each listed future's open, gap from the PREVIOUS close, last
  price and paper P&L (api/_lib/paper-live.js; Angel `close` = previous close, checked vs NSE). Information only; rules unchanged.
- **Look (19 Oct 2026):** graphite tokens + IBM Plex Sans/Mono/Condensed (publish-static-desk.js :root). Owner reads in Samsung Internet on the S25;
  wants a researched trading-app look with charts and interaction, not a template. Keep token names; never remove features.
- Futures geometry (`api/_lib/session-levels.js`):
  - buy = open × 0.992, rounded down to 0.05;
  - target +2.5%, stop −1.5%;
  - hold up to 20 sessions.
- TRACK (`scripts/paper-ledger.js`) marks every frozen level as a paper trade.
- NSE F&O expiry is **Tuesday**. Read expiries from the exchange file, never compute them.
  Zerodha and Angel One name the same contract differently (`api/_lib/fno-reference.js`).
- Checks: `npm run check`. Some tests need cached market bars that a fresh clone may lack.
  Say which ones were skipped rather than calling the run green.

## Working without the laptop

A cloud session's network allows GitHub and the package registries, but **not NSE**. So
NSE work runs on GitHub Actions, and you collect the results from a release:

- **Photos and NSE audit of the live page:**
  ```
  gh workflow run page-check.yml -f expect="YYYY-MM-DD HH:MM" -f label=what-changed
  gh run watch $(gh run list -w page-check.yml -L1 --json databaseId -q '.[0].databaseId')
  gh release download page-check -p page-check.zip --clobber && unzip -o page-check.zip -d page-check
  ```
  Then read `page-check/shots/*.png`, `SHOOT.txt` and `AUDIT.txt`. The `expect` value is the
  "Built … IST" stamp of the build you are waiting for: the PAGE's stamp, which can be a minute
  before the "desk: rebuilt" commit's time. TRACK's forward paper-test boxes are several screens
  down: their photos are `*-track-paper-*.png`.
- **NSE daily equity bhavcopy, every stock, from 2020-09:**
  ```
  gh release download data-nse-cm -R kuldeep-oo7/k2-data -p nse-cm.tar.gz && tar -xzf nse-cm.tar.gz
  ```
  This gives `nse-data/cm/YYYY-MM-DD.json` = `[isin, symbol, series, open, high, low, close,
  prevClose, volume, value]`, with series EQ/BE/BZ, unadjusted. A `.none` file marks a
  holiday. NIFTY 50 history is in `nse-data/nifty-50-nse.json` when present. To add new days:
  `gh workflow run nse-data.yml`.
- **If `gh` says its login fails** (a cloud session's `GH_TOKEN` is a placeholder that the
  GitHub proxy swaps for the real one): `gh auth status` can report failure even though API
  calls work, so try the real command first. Fallback, REST only:
  ```
  gh api repos/kuldeep-oo7/k-square31/releases/tags/page-check -q '.assets[0].id'      # -> ID
  gh api -H "Accept: application/octet-stream" repos/kuldeep-oo7/k-square31/releases/assets/ID > page-check.zip
  gh api -X POST repos/kuldeep-oo7/k-square31/actions/workflows/page-check.yml/dispatches -f ref=main -f 'inputs[label]=x'
  ```
  The same works with curl to api.github.com. Say which route worked.
- **Packages:** run `npm install` first (the npm registry is allowed), then `npm run check`.
- **Restore every study's data:** `bash scripts/restore-research-data.sh` (private releases `data-nse-cm` + `data-research`; `--no-sopt` skips the 257 MB stock options). `research/` is git-ignored: code + rules + results live in `studies/` (index: `studies/README.md`).
- Research studies go in `studies/<name>-<date>/` on a `claude/...` branch: code, the
  registration, and the results. Never the data.
- Already tested on this desk, all pre-registered:
  - FAIL: the composite rating, NIFTY candlesticks, the NIFTY trend reader, 12-1 momentum,
    time-series momentum, low volatility, the 10-month trend filter, and the US-overnight
    and crude cues; NIFTY gamma exposure, daily (4 Oct 2026: 0 PASS; branch claude/gex-2026-10-04, PR #1).
  - NOT TESTABLE: gap continuation, VIX spike.
  - 12-13 Oct 2026: NSE data atlas (14 members, 0 PASS, S2 PROMISING; branch claude/nse-atlas-2026-10-11); loan fee
    on NSE's SLB bhavcopy (0 PASS, F1 t 1.90; branch claude/loan-fee-2026-10-13); foundation models TimesFM-2.5 /
    Chronos-2 / Kronos-small + blend + trees + reversal (branch claude/forecast-models-2026-10-13, scored only from
    Jul 2024 because Kronos trained on NSE to Jun 2024): 0 PASS, best t 0.62 (reversal); Kronos and the blend VOID
    (fake dates, review 14 Oct); re-run with real dates 15 Oct: Kronos t 1.35, blend t 0.28, both FAIL. Combined model (branch claude/combined-model-2026-10-13; amendment A2: live-only universe, look-ahead fix; checks 7.2/7.3 PASSED):
    REAL RUN 18 Oct (Actions 39143272481): 0 PASS; trees long-only excess t 3.39, Holm yes, DSR 0.87 PROMISING; trees long-short t 2.78 PROMISING; ridge FAIL. Audit file for the owner: studies/ALL-TESTS-2026-10-13.txt. Research list: studies/research-open-source-2026-10-12/REPORT.md.
  - Don't re-run these as "new".

## Open work (as of 2 Oct 2026). Pick up from here

- **Strategy atlas (30 Sep): SUPERSEDED, do not run.** Its folder only ever held a downloader. The 3 Oct
  TA atlas tested the same families (Turtle, Connors RSI-2, NR7, the desk's candle and pattern detectors)
  and all FAILED; the 52-week high (George & Hwang) failed in the families studies.
- **Whole-project audit 12 Oct 2026:** studies/audit-2026-10-12/PROBLEMS.md lists every problem found, with
  evidence and status. Read it first; continue the OPEN items.
- **Audit findings, as of 4 Oct 2026:**
  - FIXED:
    - F3: the page now says no shock gate runs. Its inputs failed their tests. The K2-lang
      "INDIA_VIX < 22" REQUIRE is evaluated, but nothing reads it.
    - F23: FINNIFTY and MIDCPNIFTY get 2 years of NSE history from release data-nse-idx
      (api/_lib/nse-index-history.js).
    - F26: the false "t = 0.75" citation is replaced by the real rating replay
      (research/rating-replay-2026-10-04: BUY/ACC −0.03%/trade FAIL; SELL/REDUCE shorts LOSE,
      t −3.31).
    - The NSE audit now compares after-hours futures with NSE's OFFICIAL close (closePrice), not
      the last trade.
    - F21 (2c21bb0): the futures rows show the day's VWAP (Angel's average traded price) as
      information only; no VWAP rule has been tested.
    - F25 (2c21bb0): TRACK's 95% hit-rate range is the wider of Wilson-on-bets and a
      session-clustered interval, with no verdict under 10 sessions.
    - F27 (dc428c8): after the close the header shows India VIX's official close from NSE.
    - Google Apps Script: safe calls (reads, probes, document writes) retry on 404/408/429/5xx;
      appends never retry (api/_lib/google-store.js).
  - STARTED: order-flow recording. Each in-session build saves the best-5 order book, totals and
    OI to the private release orderflow-rec (api/_lib/orderflow-recorder.js). Nothing decides on it
    until there is a history to test.
  - Still open:
    - F24: depth is now recorded but not yet tested.
- **Forward paper tests on TRACK (rules fixed before 5 Oct 2026; docs/paper-rules/*.json, written by
  .github/workflows/springy-dip.yml at 07:45 IST):**
  - springy dip;
  - long-unwinding bounce;
  - short build-up;
  - NIFTY 2% strangle (option selling, information only);
  - 150-day cross-down shorts A and B (scored against the market);
  - cheap-vol straddle and industry reversal (studies/forward-v3-2026-10-04; "-" industries are one
    group, as in the backtest; the industry file is pinned by sha256).
  - S2 borrowing surge (from 13 Oct 2026; studies/forward-v4-2026-10-12, the NSE atlas study's only PROMISING
    member, t 2.23; its forward code replays the study exactly). Reads NSE slb_openpos (nse-slb/, fetched from 1 Aug).
  - Nine rules in all. Their daily NSE files live in release `data-paper-inputs`.
- `npm run check` had outgrown Windows' command line: add new tests to `scripts/check-forward.js`,
  not to the package.json chain.
- **Testing standard:** protocol v2 (research/audit-2026-10-04/PROTOCOL.txt): the whole sample,
  excess over the market for stock trades, t >= 3, with Holm and the Deflated Sharpe ratio reported.
  The old final-year-only verdicts were underpowered. From 14 Oct (independent review): PASS needs t >= 3 AND Holm AND
  the FULL Deflated Sharpe (Bailey & Lopez de Prado 2014, with skew/kurtosis) >= 0.95. Older DSR figures omit that term;
  the strangle's t 4.66 had DSR 0.39, so it is NOT a PASS.
- **GM Global:** the workflows `gm-cloud-sync`, `gm-explore` and `gm-portfolio-dump` are
  disabled, and GM's secrets were deleted on 30 Sep. Removing the remaining GM code (the three
  workflows, `api/gm-sync.js`, `scripts/gm-*.js` and their tests) is approved, by pull request.
  First check that nothing on the desk path references it.
- **The owner's own to-dos** (not yours): reset the Angel One TOTP secret, then update it in
  GitHub secret `K2_BROKERS_JSON` and in Cloudflare `ANGEL_TOTP_SECRET`.
- **Live-price Worker:** `worker/k2-live.mjs`, deployed by the owner at
  k2-live.kdesk-4817.workers.dev. Its key is a secret; never ask for it.
