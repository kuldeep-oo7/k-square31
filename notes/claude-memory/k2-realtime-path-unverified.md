---
name: k2-realtime-path-unverified
description: "RESOLVED 2026-09-24 — the REALTIME (executable) quote path works in a live session, cross-checked against the user's own Zerodha screen"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-24T16:36:32.272Z
---

RESOLVED. The worry (first written 2026-09-17) was that Angel One's
`exchFeedTime` might lag the freshness window during a session, so REALTIME
would never fire and the desk would silently run on closing books all day.

Measured in session on 2026-09-24 (the serverless build, cron-job.org clock):
levels froze at 09:34 from live books; 197-202 option contracts priced
`BROKER_REALTIME` per build; every futures row read `SHARE_LIVE`; 21 builds, 0
failures.

Independent cross-check, the user's own Zerodha screenshot of GLENMARK OCT 2500
CE at ~10:05 IST against the desk's TRACK record: day high 68.45 on both
(exact), day low 57.00 on both (exact, as of the 09:54 mark), Zerodha last 58.30
between the desk's marks of 57.00 (09:54) and 60.00 (10:15). Zerodha spread at
10:05 was 1.9% (57.10/58.20).

**How to apply:** do not re-raise this as an open risk. The live path is now
watched by the production health gate (`scripts/check-desk-health.js`): from
09:40 IST a build with no live price, a failed Angel One login, or no freeze
turns the run red. A user screenshot of their broker at a known time is the best
audit evidence available — compare it field by field against the ledger marks
in `git show <commit>:docs/ledger/open.json` for the builds either side.
See [[k2-serverless-desk]].
