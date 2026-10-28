---
name: k2-fresh-desk-2026-10-29
description: "Fresh Desk (Codex's both-directions app) live at /k2-desk/fresh/ from 29 Oct 2026; two publishers share the mirror; how Codex can publish itself"
metadata:
  type: project
---

- 28-29 Oct 2026: the owner rejected the short-only logic and had Codex build `fresh-desk/` (four
  price-action families, BUY and SELL equally, UNVALIDATED). Claude reviewed and merged it (PR #10, merge
  60a2d66); `fresh-desk.yml` publishes static files to https://kuldeep-oo7.github.io/k2-desk/fresh/ every 10 min
  in session (crons 09:15, 09:25, then */10 to 15:20 IST; hourly otherwise). Its crypto feed (Binance public
  spot) reads DATA_UNAVAILABLE from GitHub runners. The main page links to it under the title.
- Two publishers push to the mirror repo k2-desk: desk.yml owns the root, fresh-desk.yml only `fresh/`.
  desk.yml's mirror push now retries (fetch, reset --mixed, stage root files only); simulated race kept both.
- Codex could not publish because its session ran with approval policy `never` and network off. Fix (owner's
  decision; Claude Code's auto-mode blocked Claude from editing Codex's permissions): in
  `~/.codex/config.toml` set `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"` and
  `[sandbox_workspace_write] network_access = true` (OpenAI config reference + `codex --help`, v0.164.0).
  Codex then uses the laptop's git/gh login and asks before writing .git or pushing.
