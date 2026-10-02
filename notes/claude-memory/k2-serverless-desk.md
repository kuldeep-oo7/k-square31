---
name: k2-serverless-desk
description: "The desk now builds on a GitHub Actions schedule instead of a server; Pages is blocked on this private repo, the deployed Apps Script is older than the source, and the run summary is the view that needs nothing"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-23T02:35:20.371Z
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
---

**From 2026-09-23 the desk has no server.** `.github/workflows/desk.yml` builds
it on a schedule and commits the output. The insight that made it possible: the
option build measures **one second** on this machine — the minute around it is
all fetching — and the output is a list of prices, which is a file. Nothing here
needs a machine that stays awake.

This replaces the local-tunnel arrangement in [[k2-hosting-and-store]].

**Three external facts, each checked against the owner of the fact, each of
which changed the design:**

- **GitHub Pages will not serve this repository.** Asked directly, the API
  answered `422: "Your current plan does not support GitHub Pages for this
  repository."` Pages needs a **public** repo on GitHub Free, and `k-square31`
  is private and holds the strategy. A GET returning 404 only means no site is
  configured; the POST is what actually answers the question.
- **Private repos get 2,000 Linux minutes a month and are BLOCKED when they run
  out** (Actions is free and unmetered only on public repos). Measured run:
  **1m44s**. With the outside clock: 21 dispatches/day plus 8 one-minute backstop
  gates ≈ 1,050 min/month. The Angel One instrument master is
  the expensive part and changes once a day, so `.private/cache` is cached on
  the IST date.
- **GitHub's scheduler cannot be the clock — measured, not theorised.** On
  2026-09-23, the first day, the cron was every 20 minutes through the session
  and GitHub started **nothing between 09:13 and 14:13 IST**, then fired runs at
  19:46, 20:14, 20:35 IST matching no slot at all. GitHub's docs: "If the load
  is sufficiently high enough, some queued jobs may be dropped." Independent 2026
  reports describe delays past four hours. The primary clock is now **cron-job.org**
  (free, no paid tier, per-job `timezone` field, POST with headers, visible
  execution history) calling `POST /repos/.../actions/workflows/desk.yml/dispatches`
  with body `{"ref":"main"}`. That call returned **204** when made on 2026-09-23
  (the docs page says 200 — it describes API version 2026-03-10). Token: fine-grained,
  *Actions: Read and write* on k-square31 only. Setup is `deploy/CLOCK.md`. The
  GitHub schedule survives as an hourly backstop behind a `gate` job that stands
  down if a build landed in the last 12 minutes; the gate runs only on `schedule`
  events so a dispatch is never billed for it.
- **Git Bash on this machine ignores `TZ=Asia/Kolkata`** and prints UTC with no
  warning. I read 15:43 UTC as 15:43 IST and told the user the market had just
  closed when it had closed five hours earlier. Read times from the GitHub run
  list (UTC `Z` timestamps) or convert explicitly in Python — never trust `date`
  with a `TZ=` prefix here.
- **Do not schedule on the hour.** GitHub's docs: "The schedule event can be
  delayed during periods of high loads... High load times include the start of
  every hour." The backstop crons are `43 3`, `13 4-9` and `3 10` (UTC), i.e.
  09:13, 09:43–14:43 hourly and 15:33 IST; the outside clock uses IST minutes 13, 33, 53.

**The deployed Apps Script is older than `google-sheets/K2MarketArchive.gs`.**
Measured 2026-09-23 with an empty-payload probe: `listTabs`,
`appendTradeSignals` and `appendDailyRecommendations` all answer
`Invalid action`. Only `readDocuments` and `writeDocument` exist in the live web
app — those work, and a write was read back identical. So the Sheet holds the
machine-readable snapshot (`k2/desk-<date>.json`) but **cannot write a
human-readable row until the user re-deploys the script** (Extensions → Apps
Script → Deploy → Manage deployments → Edit → New version). `publish-to-sheet.js`
probes on every run and upgrades itself automatically once that happens.

**The view that needs nothing from anybody is `$GITHUB_STEP_SUMMARY`.** GitHub
renders it as markdown on the run page, the run page is private to the repo, and
the GitHub mobile app opens it anywhere. No Pages plan, no Apps Script deploy,
no second account, nothing that can be suspended. Repo → Actions → newest
"Build the desk" run.

**Without the `K2_BROKERS_JSON` secret the options table is EMPTY during market
hours, not wrong.** `contract-screener.js` refuses a settled price outright when
the session is open rather than quoting yesterday's close as today's entry. That
is correct behaviour and it reads exactly like "nothing qualified", so the run
summary says so explicitly. The user ran `! bash scripts/make-public-url.sh` on 2026-09-23 ~21:27 IST
(auto mode blocks me from creating public repos and writing secrets, and I must
not route around that by running the script myself). Result, each checked
rather than trusted: `K2_BROKERS_JSON` and `K2_MIRROR_DEPLOY_KEY` stored;
public repo `kuldeep-oo7/k2-desk` holds only `index.html`; Pages `built`;
**https://kuldeep-oo7.github.io/k2-desk/ returns HTTP 200** and the build bot
republishes to it by itself (log line `published to ...`).

**Angel One login from a GitHub runner — VERIFIED 2026-09-23.** Every build now
logs in and prices four NIFTY legs regardless of market phase
(`prepare-static-build.js`, "broker login and one live quote"), writes
`.private/cache/broker-check.json`, and the page and run summary both say
"Broker login OK / FAILED". First runner result: session minted, 4 legs priced
in 1.8s. The rules allowed it (Angel One: a static IP is mandatory only for
Orders & GTT from 1 April 2026); now it is measured too.

**The cron-job.org clock is LIVE (set up 2026-09-23 ~22:05 IST).** Job id
8497700, "K2 desk build", crontab `13,33,53 9-15 * * 1-5` in Asia/Kolkata,
headers Accept / Content-Type / Authorization (fine-grained token "k2 desk clock",
Actions R/W on k-square31 only, no expiry). First test run: `204`, build started
the same second and published. **Sunset date:** GitHub served it on API version
2022-11-28, which sunsets **10 March 2028** — add header
`X-GitHub-Api-Version: 2026-03-10` before then (success becomes 200). Written in
`deploy/CLOCK.md`. Do NOT
suggest putting their `gh auth token` into a third-party service instead: that
token has full `repo` scope over every repository they own.

See [[k2-session-freeze-in-git]] for why the levels stopped moving, and
[[verify-against-the-internet]] for how each fact above was settled.

**Added 2026-09-24 (production audit):**
- **NSE's F&O settlement file lands ~18:40-19:10 IST** (the archive's own
  Last-Modified: 22 Sep 18:52, 23 Sep 18:40, 24 Sep 19:08). Every build between
  the 15:30 close and then prices options on the PREVIOUS day's file. Evening
  backstop crons: 19:43 and 21:13 IST.
- **Price history never advanced on the runner** until 2026-09-24: the build
  fetched only names with NO bars, so the 210 names downloaded on 23 Sep 07:54
  stayed on bars ending 22 Sep, and would have crossed the 5-day staleness gate
  on Sunday and emptied the futures tab. Now `refreshStaleBars` refetches any
  history fetched before the latest 15:30 close (~64 s for 285 names).
- **actions/cache saves only "if the job completes successfully"** (GitHub
  docs), so the cache is now split into `actions/cache/restore` + `save` (key
  `k2-desk-cache-<IST date>-<am|pm>`), with the save placed before the health gate.
- **The commit step used `git reset --soft`**, which keeps the checked-out
  index and would silently revert any code pushed mid-build (proved in a scratch
  repo). It is `--mixed` now. Never push docs/ repairs while a run is in flight.
- **Health gate** (`scripts/check-desk-health.js`, last step): fails the run on
  ledger integrity violations and, from 09:40 IST in session, on a failed Angel
  One login / zero live prices / no freeze. Holidays are recognised from the
  feed itself (`quoteStatus.lastExchangeDate`), not a calendar. GitHub emails
  the owner on failed runs only if their notification settings allow it (docs
  do not state the default).

**Apps Script, measured 2026-09-25:** the deployed web app answers "Invalid
action" to listTabs, appendTradeSignals and appendDailyRecommendations, so NO
order ticket has reached K2_DAILY_RECOMMENDATIONS; snapshot documents
(k2/desk-*.json, k2/ledger-*.json) are written and read back identical. The
repo's google-sheets/K2MarketArchive.gs (2d8f437, 17 Sep) has all three. Fix is
the user's: Extensions > Apps Script > paste the repo file > Deploy > Manage
deployments > Edit > New version (editing keeps the same URL, so the
K2_GOOGLE_SHEETS_WEB_APP_URL secret stays valid). Since dd8daae every frozen
level is appended once (keys in docs/levels.json sheetPublishedKeys), not only
the first batch.

**RESOLVED 2026-09-27:** the GitHub secrets K2_GOOGLE_SHEETS_WEB_APP_URL /
K2_GOOGLE_SHEETS_ARCHIVE_SECRET dated from 2026-08-16 and pointed at an OLD
August script. User re-deployed the K2 Archive project (Version 2, deployment
AKfycb…(redacted)) and updated both secrets; build 36324656646: documents
written and read back, tabs listed, appendDailyRecommendations and
appendTradeSignals supported = true. The desk now writes to [[k2-google-sheet]].


**Freshness, measured 28 Sep 2026 (the user asked "is it live and dynamic?").** A snapshot, not a stream: cron-job.org dispatches at :13/:33/:53 09:13-15:53; an in-session build takes ~4.5 min (live option chains 95 s for 52 chains; Google Sheet step 108 s rewriting three backup docs with read-back); GitHub Pages sends Cache-Control max-age=600. First live page after the open was 09:37. Fixes the same night: page shows its age and polls docs/version.json (mirrored) to reload itself past the cache, keeping the tab (#futures/#calls/#puts/#track); a 09:16 IST build (GitHub cron backstop + gate exception "first build after the open"; user to add a 09:16 cron-job.org job) so levels freeze ~09:18. Buy/target/stop stay frozen for the day by design; NOW updates per build.
**Actions budget:** GitHub Free = 2,000 min/month private, $0.006/min Linux after (docs.github.com); public repos free. Desk alone ~1,800-2,000/month at 20-min cadence; every 10 min ≈ +1,500 (not free). User chose (28 Sep): 09:16 build YES, live-prices service YES (Cloudflare Worker, private key, user must create account + `npx wrangler login`), 10-min builds only if free.
