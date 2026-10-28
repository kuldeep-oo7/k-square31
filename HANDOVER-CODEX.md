# K² desk: operations handover (for Codex or any new engineer), 28 Oct 2026

This file names every moving part, every timer and every outside source, and says how to reach each one. It
holds **no secret values**: only their names and where they live. This repository is **public**.

Read these first:
- `CLAUDE.md`: the standing rules. **They bind you too.**
- `HANDOVER.md`: the owner's chat rules and known problems.
- `notes/claude-memory/MEMORY.md`: a one-line index of facts learned so far. Open a note only when you need it.
- `studies/README.md`: every strategy study and its verdict. Don't re-run them as "new".

On the owner's laptop only, `.private/HANDOVER-PRIVATE.md` adds the private links: the Google Sheet and the
secret file locations. It is git-ignored; never commit it.

## 0. Rules you must not break (short form; full text in CLAUDE.md)

- **Secrets:** never ask for, print, log or commit them. The owner sets them in GitHub, Cloudflare and Google.
- **GM Global:** fetch, read and store **nothing** from it. The owner trades there by hand, and it is futures
  only. Never add a GM data source. The GM workflows are disabled, and GM's secrets were deleted on 30 Sep.
- **The 09:13–09:40 IST freeze:** no pushes to `main` in that window on trading days, when the day's levels
  freeze. Prefer a branch plus a pull request.
- **Public repository, private data:** no market data, predictions or secrets in commits, logs or release
  assets. Market data lives in the private repo `kuldeep-oo7/k2-data`.
- **A rule reaches the page only after a pre-registered test passes.** Write the rules, sha256 them, commit
  and push them before touching real data. PASS = t ≥ 3 AND Holm AND full Deflated Sharpe ≥ 0.95. Report a
  FAIL as FAIL.
- **Pushed ≠ deployed ≠ serving.** Read `version.json` from the live URL, then photograph every tab on phone
  (360×780) and laptop and look at the photos before calling a change done.
- **Verify outside facts at the primary source,** with two sources when you can: NSE's own files, Angel's docs.
- **Talking to the owner:** they read on a Samsung Galaxy S25 in Samsung Internet. Use plain words, short
  sentences and numbers with their source. Keep the page to essentials: explanations go in a `lec` element,
  which is hidden behind "Show the notes".

## 1. The map

| Piece | Where | Notes |
|---|---|---|
| Code, workflows, studies | `github.com/kuldeep-oo7/k-square31` (PUBLIC since 18 Oct 2026) | `main` holds the built page in `docs/` |
| The page the owner reads | https://kuldeep-oo7.github.io/k2-desk/ | GitHub Pages of the public mirror repo `kuldeep-oo7/k2-desk` |
| Market data | `kuldeep-oo7/k2-data` (PRIVATE), as release assets | Never commit data to k-square31 |
| Live prices between builds | Cloudflare Worker `worker/k2-live.mjs`, at k2-live.kdesk-4817.workers.dev | Deployed by the owner; private viewer key |
| Archive / state store | A private Google Sheet with the bound Apps Script `google-sheets/K2MarketArchive.gs` | Link in the private handover |
| Outside clock | cron-job.org, which calls GitHub's workflow_dispatch API | Setup steps: `deploy/CLOCK.md` |

The build in one line: `desk.yml` restores data, writes the broker credentials, fetches NSE files and Angel
prices, prepares the paper boxes, then `scripts/publish-static-desk.js` builds `docs/`. Then it mirrors the
page to k2-desk, publishes to the Google Sheet, commits "desk: rebuilt …" as k2-desk-bot, and runs the health
gate.

## 2. GitHub

### Secrets (Settings → Secrets → Actions), names only

| Name | Holds | Used by |
|---|---|---|
| `K2_BROKERS_JSON` | Angel One credentials as JSON (shape in §4) | `desk.yml` writes it to `.private/brokers.json` (chmod 600) |
| `K2_DATA_TOKEN` | Fine-grained token that reads and writes `kuldeep-oo7/k2-data` releases | Every data workflow (38 uses); test with `data-token-check.yml` |
| `K2_MIRROR_DEPLOY_KEY` | Deploy key that pushes `docs/` to the mirror repo | `desk.yml` step "Mirror the page to the public URL" |
| `K2_GOOGLE_SHEETS_WEB_APP_URL` | URL of the Apps Script web app | `api/_lib/google-store.js`, `scripts/publish-to-sheet.js` |
| `K2_GOOGLE_SHEETS_ARCHIVE_SECRET` | Shared secret the Apps Script checks on every write | same |
| `K2_EMAIL_WEBHOOK_URL` | Alert webhook | Only the disabled `portal.yml` |
| `K2_CRON_SECRET` | Not referenced by any current code (left from an earlier setup) | Check before deleting |
| `K2_PORTAL_DEPLOY_KEY`, `K2_PORTAL_PASSPHRASE` | The old "K2 portal" | `portal.yml` is **disabled**; leave it so |

Repository **variables:** `K2_DATA_REPO = kuldeep-oo7/k2-data` and `K2_MIRROR_REPO = kuldeep-oo7/k2-desk`.
Workflows also mention `K2_GOOGLE_STORAGE_AUDITED` and `K2_MONITOR_PUBLIC_URL`, but those are not set.

### Workflows that run the desk (the rest are one-off research labs, dispatch only)

| Workflow | What it does | Started by |
|---|---|---|
| `desk.yml` "Build the desk" | Builds and publishes the page; freezes the day's levels; records order books; GM panel | cron-job.org (§3), the GitHub backstop crons, evening-kick, or by hand: `gh workflow run desk.yml` |
| `page-check.yml` | Cloud photos of every tab on phone and laptop, plus an audit of the page against NSE and Zerodha | desk.yml, on the first build 09:30–10:00 IST; or by hand (§9) |
| `evening-kick.yml` | Waits, then starts springy-dip at 19:30, kronos at 20:30 and desk at 20:45–21:15 IST | desk.yml at the 15:33/15:53 build, once a day |
| `springy-dip.yml` | The evening paper job: writes `docs/paper-rules/*.json` (the next day's lists for every forward test) from NSE's daily files; release `data-paper-inputs` | evening-kick at 19:30, plus backstop crons |
| `trees.yml`, `sb-trees.yml`, `daytrader-forward.yml` | Forward tests of the tree models and the AI day-trader | workflow_run after springy-dip, plus backstop crons |
| `kronos.yml` | Kronos forecast watch (its test FAILED; information only) | evening-kick at 20:30, plus backstop crons |
| `nse-all.yml` | Collects every NSE daily file into release `data-nse-all-2026` | Cron 20:45 IST |
| `nse-data.yml` | Adds new days to `data-nse-cm` (the equity bhavcopy) | By hand |
| `data-token-check.yml` | Proves that `K2_DATA_TOKEN` still works | By hand |

**Disabled, keep them so:** `gm-cloud-sync`, `gm-explore`, `gm-portfolio-dump` and `portal`. The owner has
approved removing the GM code by pull request, once nothing on the desk path references it.

### Releases (how to fetch)

- **k-square31, public:** `page-check` (the latest cloud photos and audit):
  `gh release download page-check -p page-check.zip --clobber`
- **k2-data, private (needs the owner's gh login):**
  - Daily data: `data-nse-cm` (equity bhavcopy from 2020-09), `data-nse-idx` (NSE index history),
    `data-paper-inputs` (the forward tests' daily NSE files), `data-nse-all-2026`, `data-nse-atlas`,
    `data-research`, `data-oos`, `data-macro`, `data-nse-financials`, `data-nifty-options`.
  - Recorded best-5 books: `orderflow-rec`.
  - Models and outputs: `trees-forward`, `daytrader-model`, `sb-trees-model`, `forecast-models-dated`,
    `combined-model-run`.

  Example: `gh release download data-nse-cm -R kuldeep-oo7/k2-data -p nse-cm.tar.gz`.
  To restore every study's data: `bash scripts/restore-research-data.sh`.
- **Caches between builds:** `.private/cache` is kept with `actions/cache`, one entry per run; the newest is
  restored. It holds the GM scan, histories and the F&O reference.

## 3. Every timer (IST, Monday–Friday unless noted)

| When | What | Clock |
|---|---|---|
| 07:00 (Tue–Sat) | kronos backstop | GitHub cron `30 1 * * 2-6` |
| 07:20 (Tue–Sat) | trees backstop | GitHub cron `50 1 * * 2-6` |
| 07:45, 08:35, 11:05 | springy-dip backstops (morning re-checks of the paper lists) | GitHub crons `15 2`, `5 3`, `35 5` |
| **09:13–15:53 every 20 min (:13, :33, :53), plus 09:16** | **desk build** | **cron-job.org** job "K2 desk build", POST to `…/actions/workflows/desk.yml/dispatches` with a fine-grained PAT (Actions read/write on k-square31 only). Setup: `deploy/CLOCK.md`. The PAT expires; when it does, the morning builds stop. |
| 09:13, 09:16, 09:43…15:43 hourly, 15:33, 19:43, 21:13 | desk backstops; they stand down if the outside clock built within 12 min | GitHub crons in `desk.yml` |
| first build 09:30–10:00 | page-check (cloud photos + NSE audit) | desk.yml step |
| 15:33/15:53 build | starts evening-kick | desk.yml step |
| 19:15 | springy-dip backstop | GitHub cron `45 13` |
| **19:30** | **springy-dip** (needs NSE's day files, which post from about 19:00) | evening-kick |
| 20:15 | kronos backstop | GitHub cron `45 14` |
| **20:30** | **kronos** | evening-kick |
| **20:45–21:15** | **desk rebuild**, once the evening jobs are in | evening-kick |
| 20:45 | nse-all | GitHub cron `15 15` |
| 21:20, 22:00, 22:15 | trees, sb-trees, daytrader-forward backstops | GitHub crons |

GitHub's own scheduler dropped whole mornings (23 Sep) and ran evening jobs 3–5 hours late (21–22 Oct).
That is why the outside clock and evening-kick exist. A list is stored once, so a duplicate run changes nothing.

## 4. Angel One (market data only; never orders)

- **API:** SmartAPI, `https://apiconnect.angelone.in`. Code: `api/_lib/broker-auth.js` (login),
  `api/_lib/broker-feed.js` (master, quotes), `api/_lib/gm-research-feed.js` (daily candles).
- **Credentials:** GitHub secret `K2_BROKERS_JSON` → `.private/brokers.json`, an object keyed by provider:
  `{"angelone": {apiKey, clientCode, mpin, totpSecret}}`. The login code adds `accessToken`, `refreshToken`
  and `feedToken`; read `broker-auth.js` for the exact keys. Environment overrides: `ANGELONE_API_KEY`,
  `ANGELONE_CLIENT_CODE`, `ANGELONE_MPIN`, `ANGELONE_TOTP_SECRET`, `ANGELONE_ACCESS_TOKEN`. On the laptop the
  same values sit in `.private/` (see the private handover). Never print them.
- **Login:** `POST /rest/auth/angelbroking/user/v1/loginByPassword` with client code, MPIN and a TOTP from
  `totpSecret` → JWT. Refresh: `/rest/auth/angelbroking/jwt/v1/generateTokens`.
- **Data calls:**
  - Quotes: `POST /rest/secure/angelbroking/market/v1/quote`, FULL mode, at most 50 tokens a request. Fields
    used: ltp, open, high, low, close, best-5 depth, OI, exchFeedTime.
  - Daily candles: `POST /rest/secure/angelbroking/historical/v1/getCandleData`.
- **Instrument master:** `https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json`
  (about 4.7 MB). Refreshed when older than 36 h. On the laptop the refresh can need a 240 s timeout.
- **Quirks, all measured:**
  - Quote `close` is the **previous** session's close (checked against NSE).
  - An expired session answers **HTTP 200** `{"success":false,"errorCode":"AG8001","message":"Invalid Token"}`.
    The same AG8001 also comes back for about 20 s after about 80 quick history requests; it is a burst limit,
    and the same token works again afterwards. The GM scan pauses 30 s and retries once.
  - The historical limit is 3 requests/s, so the code spaces them 400 ms apart.
  - Some candles have open or close outside high–low; they are rejected.
  - The master is about 52% BSE/MCX rows and collides with NSE names.
  - Angel and Zerodha name the same contract differently: `api/_lib/fno-reference.js`.
  - A second login does not end the first session, so the Worker and the builds can both run.
- **Owner's to-do (not yours):** reset the Angel TOTP secret, then update it in `K2_BROKERS_JSON` and in
  Cloudflare `ANGEL_TOTP_SECRET`.

### Cloudflare Worker (live prices on the page)
`worker/k2-live.mjs`. `GET /quotes?t=NFO:<token>,…` with header `X-K2-Key`; it gives a 401 without the
key. Its secrets and variables, names only: `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_MPIN`,
`ANGEL_TOTP_SECRET`, `K2_VIEW_KEY` and `ALLOWED_ORIGIN`. Only the owner deploys it and holds the viewer key.

## 5. Google Sheet (archive and state store)

- **Script:** `google-sheets/K2MarketArchive.gs`. It is bound to the private spreadsheet: open the sheet, then
  Extensions → Apps Script. `setupK2Archive()` was run once, and the script is deployed as a web app that
  executes as the owner. Every write must carry the shared secret held in Script Properties.
- **Owner's account:** the sheet belongs to the owner's **second** Google account. The link is in the
  private handover.
- **From GitHub:** `K2_GOOGLE_SHEETS_WEB_APP_URL` + `K2_GOOGLE_SHEETS_ARCHIVE_SECRET`. The writes come from
  `desk.yml` step "Publish to the Google Sheet" (`scripts/publish-to-sheet.js`) and from
  `api/_lib/google-store.js`.
- **Retries:** reads, probes and document writes retry on 404, 408, 429 and 5xx; **appends never retry**.
- **Retention:** the newest 3 versions of each state document (owner approved, 29 Sep).

## 6. NSE and other public sources

| Source | URL pattern | Notes |
|---|---|---|
| F&O bhavcopy (UDiFF) | `nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip` | Posted after the close (about 19:00). The source of strikes, settle and `NewBrdLotQty` (lot) |
| Equity bhavcopy | `…/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip`; `…/products/content/sec_bhavdata_full_DDMMYYYY.csv` | Official open, close, delivery |
| Lot file | `…/content/fo/fo_mktlots.csv` | One column per contract month. **Lots change between sessions** (28 Oct: 7 stocks halved); `fno-reference.js` uses it when its bhavcopy is from an earlier session |
| Ban list | `…/content/fo/fo_secban.csv` | Next session's F&O ban |
| Index closes | `…/content/indices/ind_close_all_DDMMYYYY.csv` | Named "CNX Nifty" / "S&P CNX Nifty" before Nov 2015 |
| Participant OI, SPAN | `…/content/nsccl/fao_participant_oi_DDMMYYYY.csv`, `…/archives/nsccl/span/` | |
| Website APIs | `www.nseindia.com/api/allIndices`, `holiday-master`, `corporates-corporateActions`, `corporate-board-meetings`, option-chain | Load the home page first for cookies. A browser user agent is needed |
| Zerodha instruments | `https://api.kite.trade/instruments/NFO` | Public; the audit checks that every contract on the page exists in Zerodha's list |
| NSDL FPI | `www.fpi.nsdl.co.in/web/Reports/…` | Macro study only |
| FRED | `fred.stlouisfed.org/graph/fredgraph.csv?id=…` | Macro study only (DTWEXBGS is weekly) |

NSE expiries are read from the exchange file, never computed. The NSE F&O expiry is **Tuesday**, moved to
the day before a holiday: November 2026 is **Mon 23 Nov**. **Claude cloud sessions cannot reach NSE.**
GitHub Actions and the laptop can.

## 7. The laptop (owner's Windows PC, 8 GB RAM)

- **`.private/` (git-ignored, secret):** `brokers.json`, `github-secret-brokers.json`, `production.env`,
  `k2-live-view-key.txt`, plus caches (`cache/`, `gm-weekly/`, `gm-target-speed/`, `ledger/`) and a SQLite
  `k2-trading.db`. Read secret values only in code, never on screen.
- **Other folders:**
  - `research/`: downloaded study data, git-ignored.
  - `exports/`: the **owner's own files**; never commit them.
  - `K2_APEX_PANEL_STUDY_REPORT_2026-09-17.txt`: the owner's file, often modified; never commit it.
- **Sleep:** the laptop goes into Modern Standby, so anything that must run on time runs on GitHub, not here.
- **Memory:** with Chrome open, only about 0.3 GB is free, and background jobs get killed.

## 8. What is on the page now (28 Oct 2026)

- **FUTURES, top down:**
  - The GM "3% TRADE PLAN" panel, UNVALIDATED.
  - The short build-up "FOCUS RULE" box.
  - Kronos (FAILED its test).
  - Untested rows, folded.
- **CALLS / PUTS:** untested rows, folded. Market direction is DOWN since 19 Oct.
- **TRACK:** the forward paper tests (`docs/paper-rules/*.json`, scored by `scripts/paper-ledger.js`):
  - springy dip;
  - long-unwinding bounce;
  - short build-up and strong short build-up;
  - NIFTY strangle;
  - 150-day cross-down A and B;
  - cheap-vol straddle;
  - industry reversal;
  - S2 borrowing surge;
  - the expiry-day straddle X1–X4;
  - trees;
  - AI day-trader.
- **The only rule that ever PASSED:** expiry-day NIFTY ATM straddle selling, X2: 351 expiries, t 4.43. It is on
  TRACK as a forward paper test from 27 Oct; 1 expiry so far, +89.6 points.
- **Short build-up** follows NIFTY one-for-one, the other way (26 Oct analysis): 100 paper trades, −₹7,911.
  On 28 Oct the owner rejected the old short-only logic and asked Codex for a **fresh start**: a GM futures app
  that weighs BUY/LONG and SELL/SHORT equally. Codex began it in `fresh-desk/`. At 22:30 IST on 28 Oct that
  folder was only on the laptop, not committed; it is unvalidated. The paragraph "Owner reset" in `CLAUDE.md`
  describes it. The deployed page is unchanged.
- **GM panel:** scanner v2. From 28 Oct, only the first live quote by 09:45 can open an entry, and exits are
  tracked. Its own exploratory test found no edge.

## 9. How to check your work

- **Tests:**
  - `node scripts/check-forward.js` (47 steps; add new tests here).
  - `npm run check`: the older chain. Some tests need cached bars; say which were skipped.
- **Served:** fetch `https://kuldeep-oo7.github.io/k2-desk/version.json` and compare `builtAtIst` with your
  build.
- **Photos on the laptop:** `node scripts/shoot-live-page.js "YYYY-MM-DD HH:MM" <out-dir>`.
- **Photos in the cloud:** `gh workflow run page-check.yml -f expect="YYYY-MM-DD HH:MM" -f label=<what>`, then
  `gh release download page-check -p page-check.zip --clobber`. Read `AUDIT.txt` and `shots/*.png`.
- **The day's NSE truth:** download the F&O bhavcopy (above) into an empty folder, read it with your own
  script, and compare it with the page.


## 10. Fresh workbench implementation update (28 Oct 2026)

The owner requested fundamental TA research first, then explicitly said BUILD IT.
The app now runs with npm run fresh:start at http://127.0.0.1:4174; Windows launcher
START-FRESH-DESK.cmd. Four workspaces: Plans, Market Read, Playbook, Paper Record.
Four independent research families: trend pullback, structure breakout, failed
breakout, range bounce; both directions and separate structural targets. A 3%
price remains a separate reference. No historical profitability claim. All
numeric rules are custom research interpretations, not named traders' full rules.

Market-data adapters: Angel NSE futures; public Binance SPOT (no naked shorts).
Forex/equities/commodity-futures imports use normalized JSON, explicitly labelled.
Paper records are private local JSON, separated between demo, import and live;
no account/GM reads or orders. Position quotes are monitored independently of
new-entry/ban gates, including 15:00–15:30 IST. Source and run instructions:
fresh-desk/README.txt. Node backend is NOT runnable on GitHub Pages as static HTML.

Verified software: 47 synthetic strategy/data/paper checks, 14 HTTP checks,
20 browser checks (all four workspaces, phone/laptop, actual paper entry/exit).
Regression pipeline: 49 steps. No real-data strategy test or forward validation.
Snapshots/screenshots/books stay under .private/. Do not commit them or exports/.

All three handovers were read, including HANDOVER-PRIVATE in code with values
withheld. Angel credentials exist locally; the public-master connectivity test
returned NETWORK_ACCESS_DENIED. Crypto connection test: NETWORK_ACCESS_DENIED.
NSE scan: MARKET_CLOSED. Google operational store configuration was absent from
this session's loaded local environment; no assertion about remote Sheet health.
GitHub connector permissions: pull true, push false. Creating branch
codex/price-action-workbench-2026-10-28 was rejected by the tool with
"MCP tool call requires approval, but approval policy is never". No branch, commit,
PR, deployment or publication from this batch was claimed. The review patch is
exports/fresh-start-both-directions.patch (owner-local artifact; never commit it).

Pages follow-up on 28 Oct: the local Node server now has a separate static-hosting
build, fresh-desk/build-pages.js, with browser-only paper entries/exits, backups,
and separate NSE/crypto/demo routes. The workflow is .github/workflows/fresh-desk.yml;
mirror copy script deploy/publish-fresh-desk.sh; served verification verify-pages.js.
Existing secret names are reused. Destination is /fresh/ beside the old root,
which gets a link through publish-static-desk.js on its next build after merge.
This target URL is NOT published. Static snapshots run ten-minute/hourly schedules,
not streaming; original five-minute expiry always applies. Browser journals do
not sync to Sheets and cannot monitor while closed. No source histories/secrets
are included in the browser bundle or publication directory.
24 additional local Pages hosting/browser checks passed, including entries/exits,
backup, source separation and damaged storage. All 22 private phone/laptop images
were read. GitHub branch attempt codex/fresh-desk-pages-2026-10-28 was again rejected:
"MCP tool call requires approval, but approval policy is never". Metadata push=false
on BOTH source and mirror. No remote writes/deployments were made. The updated
review patch includes the Pages workflow. See fresh-desk/README.txt for commands.
