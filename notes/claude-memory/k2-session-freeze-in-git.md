---
name: k2-session-freeze-in-git
description: "The buy/target/stop freeze lives in docs/levels.json under git, not SQLite, because a GitHub runner has no disk; this is what stopped the moving-limit complaint"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-23T02:35:35.737Z
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
---

**The complaint, verbatim:** *"in futures you are constantly changing the price
of the futures so i do feel it is double standards you need to be sure exact buy
at this it will hit your buy limit and it will hit your sell limit also ... for
example ashokley it gives me 3 prices with variation."* It was correct. Every
level was derived from the price at the moment of rendering, so reading the page
three times gave three different buy limits. **Each was computed correctly. None
was usable.** Correctness and usability are different tests, and every audit up
to that point had only ever asked the first one.

**`api/_lib/session-levels.js` fixes this only on a machine with a disk.** It
inserts once per (symbol, session, instrument) into SQLite at
`.private/k2-trading.db`. A GitHub Actions runner is destroyed after every job:
the table is empty on arrival, so wiring it into a scheduled build would
recompute a *new* level every 20 minutes and reproduce `spot × 0.992` exactly,
with more machinery in the way and a stronger claim to be fixed.

**So the freeze lives in git.** `scripts/session-freeze.js` reads
`docs/levels.json` — committed by the previous run, already in the checkout —
and carries forward every level whose session date is still today. A level is
computed once per contract per session and never again. No network on the
critical path; the audit trail is the commit history.

**Two rules that are easy to get wrong, both tested:**

- **Nothing freezes before the bell.** A pre-open build has only yesterday's
  settlement, and a level anchored there is anchored on a price nobody can
  trade. Pre-open builds show indicative numbers, label them, and persist
  nothing.
- **A contract that first qualifies at noon still gets a level**, stamped at
  noon. Freezing the whole list at the open would mean a name that only
  qualifies later could never appear.

**`scripts/test-session-freeze.js` asks for the same limit twice with the input
moved 148% and asserts it did not budge** — which is the only way to tell a
fixed limit from a moving one, since reading the code cannot.

That test immediately caught a live defect in the page code it was written
against: **`Number(null)` is `0`**, so a contract with no quote rendered as
"AT OR BELOW LIMIT" — the most attractive message on the page, shown precisely
when there was no price at all. Same family as everything in
[[k2-find-defects-by-distribution]]: a number the system made up, presented as a
number it measured.

Part of the serverless build described in [[k2-serverless-desk]].
