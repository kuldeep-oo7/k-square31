---
name: verify-against-the-internet
description: "Standing rule from the user: check every external fact against a primary source on the internet before acting on it or stating it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-22T17:16:33.348Z
---

**Always verify against the live internet, from MULTIPLE sources.** Any fact
that lives outside this codebase — a tax rate, a broker's symbol format, an
exchange's expiry weekday, a platform's limits, a statistical convention — gets
checked before it is coded against or stated as true. Not one source: at least
two, and at least one of them the primary owner of the fact.

This rule is GLOBAL, not project-scoped. It lives in `~/.claude/CLAUDE.md` so it
loads in every project and every chat; this file is the worked evidence for it.
The user has asked for it repeatedly and in those words.

**Why:** on this project every single external fact I assumed turned out to be
wrong or stale, and each one was silently wrong — it produced a plausible number
rather than an error. Verification is not diligence theatre here; it is the only
thing that catches this class of defect.

**How to apply — prefer the primary source over a summary.** A general web
search returns blog posts that disagree; the broker's own charges page, the
exchange's own contract file, the platform's own docs and the vendor's own
developer forum do not. When two sources conflict, go to the one whose author
owns the fact.

Cases from 2026-09-21/22, each of which changed code:

- **Zerodha's charges page** — STT on options is **0.15%** on the sell side from
  April 2026, having been 0.0625% then 0.10%. A model carrying the old figure
  understates the largest single cost by 2.4x.
- **Zerodha's developer forum** — a monthly option symbol is `SYM+YY+MMM`
  (`NIFTY21MAY15300CE`, where 21 is the YEAR and there is no day in it at all);
  weeklies are `SYM+YY+M+DD`. This settled "why does it say 26SEP when there is
  no expiry on the 26th". A generic search had confidently said the opposite.
- **Render's own docs** — free web services are suspended for the rest of the
  calendar month once 750 instance-hours are used, and hours are only consumed
  while a service is AWAKE. That explained a three-day outage, and that my own
  polling helped cause it.
- **Anis & Lloyd (1976)** — classical R/S is positively biased on short series,
  so a random walk reads ~0.58 not 0.50. Without that the Hurst estimator looks
  broken when it is correct.
- **Bulkowski** — a cup-and-handle runs 7 to 65 weeks on daily bars, which is
  why 67 bars of history can only ever produce the short end of the pattern set.
- **Nison** — hammer versus hanging man is decided entirely by the prior trend,
  which is a definition, not a refinement.

**Two sources, because one can be confidently wrong.** On the "26SEP" question
a general web search stated flatly that the 26 was the DAY. Zerodha's own
developer forum said it is the YEAR and that a monthly symbol contains no day at
all. Had I stopped at the first answer I would have "fixed" a symbol that was
already correct and broken every order link.

**Also verify the live system, not only the literature.** The same rule applies
to claims about this desk: read the deployed `/api/state`, count the rows in the
real table, fetch the URL before handing it over. See
[[k2-find-defects-by-distribution]] and [[k2-live-path-is-narrow]].
