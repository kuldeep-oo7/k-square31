#!/usr/bin/env bash
# REBUILD research/ ANYWHERE (a cloud session, a new laptop), from the private GitHub releases.
#   bash scripts/restore-research-data.sh            # everything (~600 MB download)
#   bash scripts/restore-research-data.sh --no-sopt  # without the 257 MB stock-option prices
# research/ is git-ignored: the DATA lives on releases, the CODE + locked rules + results in studies/.
# After this, every study runs unchanged from research/<name>/ (e.g. node research/rating-replay-2026-10-04/study.js).
# If `gh release download` fails in a cloud session, use the REST fallback in CLAUDE.md.
set -euo pipefail
# Data releases live in the PRIVATE repo kuldeep-oo7/k2-data (16 Oct 2026). Override with GH_REPO if needed.
export GH_REPO="${GH_REPO:-kuldeep-oo7/k2-data}"
cd "$(git rev-parse --show-toplevel)"
mkdir -p research

# 1. NSE's daily equity bhavcopy (every stock, 2020-09 ..) -- the studies read it from this path.
gh release download data-nse-cm -p nse-cm.tar.gz --clobber
tar -xzf nse-cm.tar.gz && rm nse-cm.tar.gz
mkdir -p research/rising-stocks-2026-10-02 && rm -rf research/rising-stocks-2026-10-02/nse-data && mv nse-data research/rising-stocks-2026-10-02/nse-data

# 2. Everything else the studies read (paths inside the archives are research/...).
for a in research-misc.tar.gz research-nse-fo.tar.gz research-nse-extra.tar.gz; do
  gh release download data-research -p "$a" --clobber && tar -xzf "$a" && rm "$a"
done
if [ "${1:-}" != "--no-sopt" ]; then
  gh release download data-research -p research-nse-sopt.tar --clobber && tar -xf research-nse-sopt.tar && rm research-nse-sopt.tar
fi

# 3. The code, the locked rules and the results, next to their data.
for d in studies/*/; do n=$(basename "$d"); mkdir -p "research/$n"; cp -n "$d"* "research/$n/" 2>/dev/null || true; done

echo "research/ restored:"; du -sh research/* 2>/dev/null | sort -h | tail -12
