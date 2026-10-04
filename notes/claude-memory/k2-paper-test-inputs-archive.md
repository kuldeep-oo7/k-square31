---
name: k2-paper-test-inputs-archive
description: The forward paper tests replay from 5 Oct on every run, but the runner fetched only 40 days of NSE F&O/option files; fixed 4 Oct by keeping them in release data-paper-inputs, with a guard
metadata:
  type: project
---
The forward paper tests (docs/paper-rules/*.json, written by springy-dip.yml at 07:45 IST) recompute
everything from START 2026-10-05 on each run and keep nothing from the previous JSON. Their F&O, index,
NIFTY-option and stock-option folders were fetched for the last 40 days only, so from mid-November the
first trades of the OI-flow, strangle/MA150 and cheap-vol tests would have dropped out with no error.

Fixed in 174d6f3 (4 Oct 2026):
- restore release data-paper-inputs (paper-inputs.tar.gz);
- the downloaders add only new days (they skip existing files);
- a guard stops the job, committing nothing, if any folder starts after 2026-10-01;
- the archive is uploaded again.

**Why:** a replay-from-start design needs every input since the start. A rolling fetch window loses
history silently.

**How to apply:** a new forward test that reads per-day NSE files must put its folder in that archive
and in the guard's list. Springy dip and INDREV read only data-nse-cm (full history). See
[[k2-paper-ledger]] and [[k2-find-defects-by-distribution]].
