# Instructions for Codex (and any agent) in this repository

Read these in order before changing anything:

1. `CLAUDE.md`: the standing rules. They apply to every agent, not only Claude.
2. `HANDOVER-CODEX.md`: every system, timer, secret name and data source, and how to reach each one.
3. `HANDOVER.md`: the owner's chat rules and known problems.
4. `notes/claude-memory/MEMORY.md`: an index of facts learned so far. Open a note only when you need it.

The rules that do the most damage when broken:

- **Secrets:** never print, log or commit them, and never ask the owner for them.
- **GM Global:** nothing from it. No fetching, no storing, no new GM data source.
- **The freeze window:** no pushes to `main` between 09:13 and 09:40 IST on trading days. Prefer a branch
  plus a pull request.
- **Public repository:** no market data, predictions or secrets in commits, logs or release assets.
- **Testing first:** nothing reaches the page as a suggestion without a pre-registered test that passed. Report
  a FAIL as FAIL.
- **Pushed ≠ deployed ≠ serving:** read the live `version.json` and photograph the page, phone first, before
  saying done.

On the owner's laptop, `.private/HANDOVER-PRIVATE.md` holds the private links. It is git-ignored; never commit it.
