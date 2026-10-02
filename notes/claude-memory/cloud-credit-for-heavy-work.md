---
name: cloud-credit-for-heavy-work
description: "User wants heavy work run in Claude Code cloud sessions (one-time $100 credit, expires 5 Nov 2026 13:29 IST) so the laptop session doesn't burn their plan"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-30T02:25:58.796Z
---

On 30 Sep 2026 the user said "use the 100 dollars credit please else i will be out of credits
for the next 2 days". Last night the laptop session hit its session limit mid-task.

Checked facts:
- The user's claude.ai/code popup shows $100 for cloud sessions, expiring 1:29 PM IST on
  5 Nov 2026 and applied automatically.
- ClaudeDevs on X: "Cloud sessions run on your Pro or Max plan ... This promo is an optional
  one-time credit that your cloud sessions spend first, before falling back onto your normal
  plan usage."
- A LOCAL session, like this laptop one, does not use the credit.

The user refined it the same morning: "optimize it in a way so we do not use all of the weekly
limit, but use the 100 dollars when we are over using". So the plan stays for small, quick work.
Long jobs, and anything once the weekly meter runs high, go to the credit. The meter is at
claude.ai Settings > Usage. Stay lean everywhere: no needless advisor calls, since each one
re-sends the whole transcript. Start fresh sessions rather than dragging a huge context.

**How to apply:**
- Put long research and coding into a cloud session.
- `claude --cloud "task"` refuses to run without a TTY ("--cloud requires an interactive
  terminal"). Start it through `Start-Process pwsh -ArgumentList '-NoExit','-File',<ps1>`, where
  the .ps1 does `Set-Location <checkout on the branch>; claude --cloud '<task>'`. It prints
  "Created cloud session ... View: https://claude.ai/code/session_..." and exits.
- The cloud VM clones the GitHub remote at the checkout's CURRENT branch. Push a brief on a side
  branch first (a git worktree keeps main's checkout untouched). research/ and .private/ never
  reach it.
- Cloud network defaults to "Trusted" (package registries and GitHub only). NSE needs
  "Full" or "Custom", which the user sets in the environment settings.
- Keep the laptop session lean for work that needs this machine: local Chrome screenshots, and
  NSE access that is proven from this IP.

First cloud session: "Strategy atlas 2026-09-30",
https://claude.ai/code/session_01G2ojMKhesmeTeyvDV8xwME, branch
claude/strategy-atlas-2026-09-30 (brief at studies/strategy-atlas-2026-09-30/BRIEF.md). See
[[k2-open-requests-2026-09-29]].

**Laptop-free setup, built 2 Oct 2026 (commit bc2679a on main):**
- The repo's `CLAUDE.md` carries the standing rules for cloud sessions, which can't read
  ~/.claude.
- `page-check.yml` photographs the live page on GitHub and runs `audit-live-vs-nse.js` there.
  It puts the results on release `page-check` (page-check.zip). First run 37040048673 was
  green: NSE and Zerodha were both reachable from Actions, and the photos were read and good.
- `nse-data.yml` keeps the NSE CM bhavcopy archive on release `data-nse-cm` (nse-cm.tar.gz).
  It was seeded from the laptop's 845 files plus nifty-50-nse.json.
- The Claude GitHub App is installed on k-square31 ONLY (the user chose "only select").
