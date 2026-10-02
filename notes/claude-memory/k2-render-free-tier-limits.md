---
name: k2-render-free-tier-limits
description: "K² runs on Render's 512 MB free tier with an ephemeral disk and no .private; this shapes crashes, memory and why prices go missing during a session"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-20T15:21:39.266Z
---

The K² desk at k-square31.onrender.com runs on Render's **free tier: 512 MB RAM,
ephemeral disk, and no `.private/` directory** (it is gitignored, so credentials,
the SQLite database and every cache are absent on a fresh container). On
2026-09-18 the desk failed during live market hours — blank page, then 502 — and
the causes were all consequences of that environment.

**Why:** the code paths that only run on a cold, credential-less host are the
ones least exercised locally, and they are exactly what production runs.

**How to apply — the four failure modes, all fixed 2026-09-20:**

- **A single throw returns 502 for the whole desk.** `/api/state` had no outer
  try/catch, so `new Date(NaN).toISOString()` on a bar with no timestamp killed
  every card and every price. Any new field in that handler must degrade to
  null, never throw.
- **The bhavcopy for *today* does not exist during a session.** NSE publishes it
  after close. `refreshReference` now walks back up to 7 days; asking only for
  today meant no strikes, no lot sizes and no prices for an entire trading day.
- **Memory.** `getUniverse()` recomputes 210 names (~260 ms, ~40 MB) and
  `/api/state` calls it three times per request. Cached 2.5 s → 313 MB down to
  262 MB RSS. Anything added to the per-request path must be measured, not
  assumed cheap.
- **Payload.** 3.5 MB JSON per poll on a phone over 4G. Now gzipped to 244 KB
  (93% less) and the duplicate nested option chain was removed from universe
  rows. Check `curl -sI -H "Accept-Encoding: gzip"` still returns
  `Content-Encoding: gzip` after touching that handler.

Verify a cold host by running the engine with `.private` absent — but do NOT do
it with `mv .private .private.bak`: the restore nests the real directory inside
the new one. Copy the repo elsewhere instead. Related:
[[k2-realtime-path-unverified]], [[k2-hosting-and-store]].
