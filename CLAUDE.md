# K² desk: rules for every Claude session (laptop or cloud)

**Owner reset, 28 Oct 2026:** build a fresh GM futures application that evaluates
BUY/LONG and SELL/SHORT equally. This replaces the earlier short-only focus for
new development. The standalone implementation is in `fresh-desk/`; it imports
no old ratings, strategy engines or track records. Its first intraday hypotheses
are unvalidated research. Existing deployed files and held positions are retained;
the new prototype does not change an existing stop. The older design below is
historical context, not a mandate to suppress upside in the replacement.

Every system, timer, secret NAME and outside data source, and how to reach each, is in `HANDOVER-CODEX.md` (28 Oct 2026; `AGENTS.md` points Codex there).
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
- The morning check: desk.yml starts page-check.yml (cloud photos + NSE audit, release page-check) on the first build
  between 09:30 and 10:00 IST, because the laptop goes into Modern Standby (a wake lock does not stop it).
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
- **Essentials only (owner, 21 Oct 2026: "remove all of the lectures from the page"):** every explanation carries class `lec`
  and is hidden; "Show the notes" at the foot brings them back. New text on the page is one line, numbers first; reasons go
  in a `lec` element; lists go in `listFold(...)`. Alarms stay visible.
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
  - PASS (the desk's first): expiry-day NIFTY option selling, the owner's friend's method (branch claude/expiry-selling-2026-10-20,
    prereg 02af144 + A1): all four members PASS on 351 expiries 2020-2026 (X2 ATM straddle with 2x stop +17.6 points, t 4.43,
    DSR 1.00), positive in every sub-period; worst expiry -3.19% of NIFTY; the edge needs selling AFTER the open (post-hoc
    audit). On TRACK as a forward paper test from 27 Oct 2026 (studies/expiry-selling-forward-2026-10-21; verdict X2 after 52
    expiries). NIFTY lot is 65 (NSE FO bhavcopy NewBrdLotQty, 21 Oct 2026).
    Call side vs put side of X2 (branch claude/expiry-legs-2026-10-25, prereg 8a6be362 committed before data, 25 Oct; reproduced
    the study exactly first): NO DIFFERENCE FOUND (put - call t -1.48; low power). Call leg +15.0, put leg +2.6 points an expiry,
    but each leg follows NIFTY's direction (NIFTY settled below its open on 194 of 351 expiries); X2 paid on up days (+20.3) and
    down days (+15.4); the put leg's stop was hit more (42% vs 31%). Single legs are information only, never a rule. TRACK shows
    the split in one line and each leg's result (display only; api/_lib/expiry-forward.js run() adds callPoints/putPoints).
  - GM tournament (branch claude/gm-tournament-2026-10-21, prereg e38edd4 + A1 51321cc + A2 dd86733): FULL BOARD 21 Oct
    (Actions 39644817254): 86 members under GM's rules, 0 PASS; PROMISING SB short build-up (t 3.94, Holm, DSR 0.57; since
    Sep 2024 only t 0.91), CM1 trees long-short (t 3.48), LU (t 2.68); Kronos t 0.98 FAIL. The one 2005-2020 re-check
    (Actions 39710811828): SB CONFIRMED (34,332 trades, +0.28%/trade, t 4.83; examined data), LU and SD NOT CONFIRMED,
    CM1 and S2 NOT CONFIRMABLE. On TRACK as information (docs/paper-rules/gm-tournament.json). Done; don't re-run.
  - FAIL: macro pod (branch claude/macro-pod-2026-10-20, prereg 3661fa5 + A1 69683fe + A2 4265622; Actions 39712865277):
    FII futures position, NSDL FPI cash flow, dollar index, all three with a 3% stop, 2012-04..2026-10: 0 PASS, best t 0.67;
    all below buy-and-hold. Learned: NSE cat_turnover has no FPI rows; FRED DTWEXBGS is weekly (H.10, Mondays 4:15 p.m.
    ET); NSE's index file named NIFTY "S&P CNX Nifty"/"CNX Nifty" until Nov 2015; the NSE index API returns block pages.
  - FAIL: night lab (branch claude/night-lab-2026-10-23, prereg a67caf2 + A1 ccb7787; Actions 39828578979): 17 members,
    discovery 2005-2020, confirmation 2020-2026: 0 PASS. SB stop-losses at 1/1.5/2/3% all LOSE vs holding to the close
    (both periods). PROMISING: SB strong signal (fall >= 3%, OI >= 6%) t 2.99/2.73; tug of war intraday/overnight
    (Lou-Polk-Skouras) t 6.71/6.16 then 4.14/4.62, DSR 0.00, ~+0.05%/day after 2020 before spreads. MAX, high-volume,
    seasonality, pre-holiday, lead-lag, squeeze long FAIL.
  - FAIL, 23 Oct 2026 (all pre-registered, one run each, discovery 2005-2020 + confirmation 2020-2026):
    09:15 lab (claude/open-lab-2026-10-23; Actions 39832831164): 7 filters known at the open + trees/logistic/neural
    network picking SB trades, share-priced: 0 PASS (share-gap filter and the 3 models PROMISING). Options lab
    (claude/options-lab-2026-10-23; Actions 39835168794): smirk, call-put spread, IV changes, RV-IV, option/futures volume:
    0 PASS; the US smirk effect runs the OTHER way in India (t -2.28/-2.84). Futures lab (claude/futures-lab-2026-10-23;
    Actions 39835994636), everything priced on the near-month FUTURE: 0 PASS; plain SB NOT significant on futures
    (2005-2020 t 1.92; 2020-2026 t -0.14); PROMISING: trees picking SB trades (t 6.31, DSR 0.94; then t 2.63), strong SB
    (t 3.46; then 1.87), LU bounce (t 3.84; then 4.21, net, mostly market beta).
  - 23 Oct 2026 evening, all pre-registered, NIFTY/stock futures prices: index lab (claude/index-lab-2026-10-23; 0 PASS;
    turn of the month +0.54%/trade t 2.84 then +0.43% t 1.77; big-drop bounce t 3.09, too few since 2020); breadth lab
    (claude/breadth-lab-2026-10-23; 0 PASS; washout t 2.99 and new lows t 4.52 not testable since 2020; shorting NIFTY after
    an SB crowd LOSES both periods); rollover lab (claude/rollover-lab-2026-10-23; 0 PASS; broker rollover reading fails,
    rolling shorts reversed after 2020). AI day-trader lab (claude/daytrader-lab-2026-10-23, Actions 39980410271): trees /
    neural network ranking all stock futures at 09:15, long top tenth / short bottom tenth, open to close: PASS 2008-2020
    (t 13.96, DSR 1.00) and CONFIRMED 2020-2026 (+0.10%/day, t 6.09). Post-hoc audit (Actions 39982142707): NOT a stale-print
    artifact (shares and a no-gap model agree; it buys weak openers, sells strong ones), but it DECAYED: +0.31%/day 2008-12,
    +0.11% 2020-25, +0.01% (t 0.63) from 8 Dec 2025. VIX lab (claude/vix-lab-2026-10-23): 0 PASS; variance premium t 2.07/2.29.
    On TRACK from Mon 26 Oct as a forward paper test (studies/daytrader-forward-2026-10-26, model sha 03e56858..., private
    release daytrader-model). Weekly OI lab (claude/weekly-oi-lab-2026-10-23): 0 PASS; a strong week of rising price and OI
    UNDERPERFORMS the next week (t -1.96/-2.42). VRP lab (claude/vrp-lab-2026-10-23): 0 PASS; the expiry-day straddle sold on
    days -1..-4 earns +3..+10 points, not reliable -- the edge is on expiry day itself.
  - KEY FACT (23 Oct): desk tests price at the SHARE's official open (NSE pre-open auction); the near-month FUTURE's
    open->close beat the share's by +0.085% a day on average (2021-2026, 276k stock-days), so share pricing flatters shorts
    and penalises longs by ~0.1% a trade. Price anything meant for GM on futures (open -> settlement close, roll at expiry).
    The strong-SB TRACK test is futures-priced (studies/sb-strong-forward-2026-10-23, amendment A1).
  - FAIL, 29 Oct 2026: chart lab (branch claude/ta-champions-2026-10-29, prereg 1914ffff before data; Actions 40907737425).
    14 own members built from champion traders' setups, both directions, futures-priced, excess over the market. Members:
    Minervini/O'Neil breakout, gap-and-hold, capitulation bounce / parabolic fade, Raschke Holy Grail, Turtle Soup +1,
    candle at the 50-day, tight inside day. 0 PASS. PROMISING: capitulation bounce (t 2.23, then 1.91, 92 trades), bear
    candle at the 50-day (2.15, then 0.64), inside day up (2.25, then 0.16). Holy Grail SHORT loses in both periods
    (t -3.55 / -2.30). Laggard breakdown shorts lose after 2020 (t -4.31). Limitation: the NIFTY filter only had index
    closes on 2,131 of 3,909 discovery sessions (from about 2012, inferred), so the filtered members (A, B, G) start
    there. Reading and sources: LEARN.md in that folder.
  - FAIL, 29 Oct 2026: GM weekly lab (branch claude/gm-weekly-lab-2026-10-29, prereg c6065d9f before data; Actions
    40912563154). 10 weekly-chart members scored GM's way: bought at Monday open, booked at Friday close, weekend gap not
    counted, cut at expiry. Members: Weinstein stage 2/4, weekly Donchian 20/10, relative strength top/bottom tenth,
    weekly candle at the 30-week line, NIFTY futures trend. 0 PASS. PROMISING: stage-4 short (t 3.89, then 0.31) and RS
    bottom short (2.66, then 0.78). Every member made money in only about 43-60% of expiry months. In raw GM rupees the
    longs made money after 2020 and the shorts lost: market direction, not skill.
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
    - F24: depth recorded and tested once (interim, 25 Oct 2026; branch claude/orderbook-2026-10-25, prereg 877af02e):
      15 sessions, 6 members (total buy/sell qty, 5-level depth, top of book x next 15-30 min / to the close), fills walk
      the recorded book + 0.104% charges. Total buy/sell quantity predicts NOTHING; the visible book leans the right way
      (rank IC t 3.9-5.1) but the best gross move (+0.033% a trade) is ~1/6 of the cost (0.19-0.21%): TOO SMALL TO TRADE
      / FAIL. THE VERDICT: one re-run, code unchanged, at 60 recorded sessions (~31 Dec 2026):
      `K2_OF_DIR=<orderflow-rec files> node studies/orderbook-2026-10-25/study.js --first 60`. No look before then.
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
  - Expiry-day NIFTY option selling X1-X4 (from 27 Oct 2026; studies/expiry-selling-forward-2026-10-21; api/_lib/expiry-forward.js
    is the study's code, scripts/expiry-forward-replay.js reproduces its 351 expiries exactly). Reads nse-nod/ (NSE F&O bhavcopy
    NIFTY rows, from 22 Oct) and nse-idx/ (NIFTY's open). Information only, never a row on CALLS/PUTS.
    Amendment A1 (18c0101, 25 Oct, information only): on expiry sessions each desk build fetches the EXPIRING NIFTY options
    nearest NIFTY's open (NSE allIndices "open"; api/_lib/expiry-live.js), TRACK shows X2 live (expiryLiveLine), and the
    order-flow recorder keeps their books, so the day's audit can compare a real sale with the official open. Zerodha:
    no SL-M on index options (use SL); expiry day adds 2% x NIFTY x lot of margin per short lot; one 65-unit ATM straddle
    needed Rs 2.03 lakh on Zerodha's SPAN calculator on 25 Oct, about Rs 2.6 lakh on expiry day.
  - Trees watch (from 28 Oct 2026; studies/trees-forward-2026-10-22): the combined model C1 trees run live by trees.yml after the paper
    job (code 04a0b39, libs pinned; replay MATCH 22 Oct: 30,333 predictions identical); symbols only in docs/paper-rules/trees.json.
  - Eleven rules in all. Their daily NSE files live in release `data-paper-inputs`. GitHub ran the evening paper and Kronos jobs
    3-5 hours late (21-22 Oct), so the 15:33/15:53 desk build (cron-job.org) starts evening-kick.yml, which starts springy-dip.yml
    at 19:30 and kronos.yml at 20:30 IST (tested 22 Oct). The owner does not need to add cron-job.org jobs.
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
