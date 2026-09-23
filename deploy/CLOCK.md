# The desk's clock — one-time setup, about five minutes

## Why this exists

On 2026-09-23, the first day the desk ran on GitHub, GitHub's own scheduler
started **nothing between 09:13 and 14:13 IST**, then fired runs at 19:46,
20:14 and 20:35 IST, hours after the close. GitHub documents this: *"If the
load is sufficiently high enough, some queued jobs may be dropped."* A trading
desk cannot run on a best-effort clock.

cron-job.org is free (no paid tier), schedules in **Asia/Kolkata** directly,
and shows you every call it made and what GitHub answered. It calls GitHub's
`workflow_dispatch` API, which starts the build **immediately** instead of
putting it in the same queue that dropped the morning.

GitHub's own schedule stays on as a backstop. It stands down on its own
whenever the outside clock has built in the last twelve minutes, so the two
clocks never double-bill.

---

## Step 1 — a GitHub token that can do exactly one thing

1. Open **https://github.com/settings/personal-access-tokens/new**
2. **Token name:** `k2 desk clock`
3. **Expiration:** 1 year (or your choice — write the date down; the clock stops when it expires)
4. **Repository access:** *Only select repositories* → **k-square31**
5. **Permissions → Repository permissions → Actions:** **Read and write**
   *(GitHub's docs list exactly this for the dispatch endpoint. Nothing else is needed — leave every other permission at "No access".)*
6. **Generate token** → copy it. It starts with `github_pat_`. You will not see it again.

Scoped this way, the token can start this one workflow and nothing else. It
cannot read your code, touch another repository or see a secret.

## Step 2 — the clock itself

1. Sign up at **https://cron-job.org** (free) and verify your email.
2. **Create cronjob.**
3. **Title:** `K2 desk build`
4. **URL:**
   ```
   https://api.github.com/repos/kuldeep-oo7/k-square31/actions/workflows/desk.yml/dispatches
   ```
5. **Execution schedule → Custom:**
   - **Days of week:** Monday, Tuesday, Wednesday, Thursday, Friday
   - **Hours:** 9, 10, 11, 12, 13, 14, 15
   - **Minutes:** 13, 33, 53
   - **Time zone:** `Asia/Kolkata`

   That is 21 builds a day: 09:13 (pre-open, freezes nothing), **09:33 (the
   first build that can freeze the day's levels)**, then every twenty minutes
   to 15:53.
6. **Advanced → Request method:** `POST`
7. **Advanced → Headers** — add these three:
   | Key | Value |
   |---|---|
   | `Authorization` | `Bearer github_pat_…` *(your token from step 1)* |
   | `Accept` | `application/vnd.github+json` |
   | `Content-Type` | `application/json` |
8. **Advanced → Request body:**
   ```json
   {"ref":"main"}
   ```
9. **Save.**

## Step 3 — prove it works before you trust it

In cron-job.org, open the job and press **Test run**.

- **`204 No Content`** (or `200`) → working. Measured on 2026-09-23: this exact
  call returned `204`. Within a minute a new run appears at
  https://github.com/kuldeep-oo7/k-square31/actions/workflows/desk.yml
- **`401`** → the token is wrong or was copied with a space.
- **`403`** → the token does not have *Actions: Read and write* on k-square31.
- **`404`** → the URL has a typo, or the token cannot see the repository.
- **`422`** → the body is not exactly `{"ref":"main"}`.

After that, **the execution history in cron-job.org is your check** that the
clock fired: every row shows the time and the status GitHub returned.

## What it costs

21 builds a day × about 2 billed minutes, plus the backstop's one-minute checks,
is near **1,050 minutes a month** against the 2,000 a private repository gets
free. cron-job.org is free.

## Before 10 March 2028 — one header to add

The first real test run (2026-09-23, 22:05 IST) returned `204 No Content` and
started a build within the same second. GitHub's reply also carried:

```
x-github-api-version-selected: 2022-11-28
Deprecation: Tue, 10 Mar 2026 00:00:00 GMT
Sunset: Fri, 10 Mar 2028 00:00:00 GMT
```

With no version header, GitHub answers with the 2022-11-28 API, which is already
deprecated and is switched off on **10 March 2028**. Before then, add a fourth
header to the cron-job.org job:

| Key | Value |
|---|---|
| `X-GitHub-Api-Version` | `2026-03-10` |

and run TEST RUN again. On that version GitHub's documentation lists the success
code as `200` rather than `204` -- both mean it worked. If this is missed, the
failure-notification email set up on the job is the warning.
