#!/usr/bin/env bash
# One-time: pack the laptop's research/nse-atlas history into release data-nse-atlas, one tarball per month
# (paths inside: nse-atlas/<dataset>/<date>.<ext>, the same as springy-dip.yml's daily step). ".none" is left out.
set -euo pipefail
cd "$(dirname "$0")/.."
gh release view data-nse-atlas >/dev/null 2>&1 || gh release create data-nse-atlas --title "NSE data atlas (raw daily files)" --notes "NSE's own daily files listed in studies/nse-data-atlas-2026-10-11/ATLAS.md, one tarball per month. Built by springy-dip.yml." --latest=false
months=$(ls research/nse-atlas/*/ | grep -oE '^[0-9]{4}-[0-9]{2}' | sort -u)
for mm in $months; do
  list=$(cd research && ls -d nse-atlas/*/$mm* 2>/dev/null | grep -v '\.none$' || true)
  [ -z "$list" ] && continue
  (cd research && tar --force-local -czf "../atlas-$mm.tar.gz" $list)
  gh release upload data-nse-atlas "atlas-$mm.tar.gz" --clobber && echo "atlas-$mm: $(echo "$list" | wc -l) files" && rm "atlas-$mm.tar.gz"
done
