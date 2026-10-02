---
name: pc-memory-constraint
description: Dev laptop has 8 GB soldered RAM; pagefile was capped at 4 GB causing OOM crashes that killed Claude CLI and the desktop compositor
metadata:
  type: project
---

Samsung Galaxy Book 750XED (i5-1235U), Windows 11 Home 26200. **8 GB RAM, soldered
(8x1 GB onboard, MaxCapacity = 8 GB) — not upgradeable.** Usable RAM 7,891 MB.

On 2026-09-07 the machine was crashing hard: white/black screen then a forced
power-off. Root cause was NOT malware — the pagefile had been manually pinned at
4096/4096 MB (`AutomaticManagedPagefile = False`), capping the commit limit at
11,987 MB. Windows logged 15 Resource-Exhaustion event 2004s in 30 days plus an
explicit "Out of Virtual Memory" popup 11 seconds before a crash cluster that took
out dwm.exe (the white screen), WindowsTerminal.exe (Claude CLI), Explorer and the
Start menu. `BugcheckCode = 0` confirmed a hang, not a hardware fault or BSOD.

Fixed to `C:\pagefile.sys 6144 10240` -> commit limit **14,035 MB**, extending to
~18,100 under load.

**Constraint that still applies:** raising the commit limit stops apps being
*killed*, but 8 GB of real RAM is the hard ceiling. Running Claude CLI (~550 MB)
+ Antigravity's language_server (~750 MB) + Edge (~830 MB) + Defender (up to
1,150 MB) together will page to disk and feel slow. Suggest closing Antigravity
or Edge before long Claude Code sessions in this repo.

**Do not put the pagefile on D:.** It was tried and Windows silently refused to
create it, even though D: is unencrypted with SYSTEM FullControl and 156 GB free.
Reason never determined. C: is the only volume that reliably takes one here.

See [[k2-build-rewrites-package-type]] for the other environment gotcha on this box.
