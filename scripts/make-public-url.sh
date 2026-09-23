#!/usr/bin/env bash
#
# GIVE THE DESK A PLAIN URL. Run this once. It takes about a minute.
#
#   bash scripts/make-public-url.sh
#
# WHY YOU HAVE TO RUN IT AND NOT ME: two of these steps are ones an assistant is
# not allowed to take on your behalf, and they are exactly the two a public URL
# needs -- creating a public repository, and writing secrets into your account.
# Everything else is already done and already running.
#
# WHAT BECOMES PUBLIC: one file, docs/index.html, in a NEW repository. It is the
# rendered page and nothing else -- no strategy code, no ledger, no credentials,
# no commit history from k-square31. Anyone who finds the URL can read the day's
# buy limits. That is the same exposure the Cloudflare tunnel had, except the
# URL is stable instead of changing on every restart. If that is not acceptable,
# do not run this: the run page under Actions already shows the same table,
# privately, and the GitHub mobile app opens it from anywhere.
#
# WHAT IT DOES, in order:
#   1. creates the public repository that Pages can actually serve
#   2. pushes today's page into it, so the URL works immediately
#   3. turns Pages on and prints the URL
#   4. makes a deploy key so every future build republishes automatically
#   5. stores your Angel One credentials, without which the options table is
#      EMPTY during market hours

set -euo pipefail

OWNER="${K2_OWNER:-kuldeep-oo7}"
SOURCE_REPO="${K2_SOURCE_REPO:-${OWNER}/k-square31}"
MIRROR_REPO="${K2_MIRROR_REPO:-${OWNER}/k2-desk}"
KEY_FILE="${TMPDIR:-/tmp}/k2-mirror-key"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }

cd "$(dirname "$0")/.."

say "1/5  A public repository, because Pages will not serve a private one"
# Verified rather than assumed: POSTing to the Pages API on k-square31 returns
# 422 "Your current plan does not support GitHub Pages for this repository".
if gh repo view "$MIRROR_REPO" >/dev/null 2>&1; then
  echo "     $MIRROR_REPO already exists"
else
  gh repo create "$MIRROR_REPO" --public \
    --description "K2 desk - the rendered page only. No strategy code." >/dev/null
  echo "     created $MIRROR_REPO"
fi

say "2/5  Today's page, so the URL works the moment it is switched on"
if [ ! -f docs/index.html ]; then
  echo "     docs/index.html is missing -- building it first"
  node scripts/publish-static-desk.js
fi
WORK="${TMPDIR:-/tmp}/k2-mirror-seed"
rm -rf "$WORK"
git clone -q "https://github.com/${MIRROR_REPO}.git" "$WORK" 2>/dev/null || {
  mkdir -p "$WORK" && git -C "$WORK" init -q && git -C "$WORK" remote add origin "https://github.com/${MIRROR_REPO}.git"
}
cp docs/index.html "$WORK/index.html"
: > "$WORK/.nojekyll"
git -C "$WORK" add -A
git -C "$WORK" -c user.name="k2-desk-bot" -c user.email="noreply@users.noreply.github.com" \
  commit -q -m "desk: first publish" 2>/dev/null || echo "     page already current"
git -C "$WORK" branch -M main
git -C "$WORK" push -q -u origin main 2>/dev/null || git -C "$WORK" push -q origin main
echo "     pushed index.html"

say "3/5  Switch Pages on"
gh api -X POST "repos/${MIRROR_REPO}/pages" \
  -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || echo "     (already on)"
URL="https://${OWNER}.github.io/$(echo "$MIRROR_REPO" | cut -d/ -f2)/"
echo "     $URL"

say "4/5  A deploy key, so every build republishes on its own"
# A deploy key is scoped to ONE repository. Even if it leaked it could not touch
# k-square31, which is the whole reason to use one instead of a personal token.
if [ ! -f "$KEY_FILE" ]; then
  ssh-keygen -t ed25519 -N "" -C "k2-desk-mirror" -f "$KEY_FILE" >/dev/null
fi
gh api -X POST "repos/${MIRROR_REPO}/keys" \
  -f title="k2 desk build" -f key="$(cat "${KEY_FILE}.pub")" -F read_only=false >/dev/null 2>&1 \
  || echo "     (key already installed)"
gh secret set K2_MIRROR_DEPLOY_KEY -R "$SOURCE_REPO" < "$KEY_FILE"
gh variable set K2_MIRROR_REPO -R "$SOURCE_REPO" --body "$MIRROR_REPO" >/dev/null 2>&1 || true
rm -f "$KEY_FILE" "${KEY_FILE}.pub"
echo "     installed, and the local copy of the private key is deleted"

say "5/5  Broker credentials, or the options table is empty all session"
# Not a nicety. api/_lib/contract-screener.js refuses a settled price outright
# while the market is open, rather than quoting yesterday's close as today's
# entry. With no broker session that refusal applies to every contract, and an
# empty table reads exactly like "nothing qualified".
if [ -f .private/github-secret-brokers.json ]; then
  gh secret set K2_BROKERS_JSON -R "$SOURCE_REPO" < .private/github-secret-brokers.json
  echo "     stored apiKey, clientCode, mpin and totpSecret (no access tokens)"
else
  echo "     .private/github-secret-brokers.json is missing -- run:"
  echo "       node -e 'const a=require(\"./.private/brokers.json\").angelone;require(\"fs\").writeFileSync(\".private/github-secret-brokers.json\",JSON.stringify({angelone:{apiKey:a.apiKey,clientCode:a.clientCode,mpin:a.mpin,totpSecret:a.totpSecret}}))'"
fi

say "Done"
gh workflow run desk.yml -R "$SOURCE_REPO" >/dev/null 2>&1 && echo "     a build was kicked off to publish immediately"
cat <<DONEEOF

  YOUR URL:   ${URL}

  Pages takes a minute or two to serve the first time; a 404 straight away is
  normal and is not a mistake you made. It republishes on every build, which is
  every twenty minutes through the session.

  ONE MORE STEP, AND IT IS NOT OPTIONAL: the clock. GitHub's own scheduler
  started nothing between 09:13 and 14:13 IST on the first day, so the builds
  are started from outside GitHub instead. Five minutes, free:
    deploy/CLOCK.md

  The private view, which already works and needs no URL at all:
    https://github.com/${SOURCE_REPO}/actions/workflows/desk.yml
    -> newest run -> the table at the top. Opens in the GitHub mobile app.

DONEEOF
