#!/usr/bin/env bash
set -euo pipefail
# Called on the isolated Actions runner, never a workaround for local approval.
repo="${MIRROR_REPO:-kuldeep-oo7/k2-desk}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid mirror repository"; exit 1; }
[ -n "${MIRROR_KEY:-}" ] || { echo "K2_MIRROR_DEPLOY_KEY is unavailable"; exit 1; }
source_dir="$PWD/.private/fresh-desk/pages"
[ -f "$source_dir/index.html" ] && [ -f "$source_dir/version.json" ] || { echo "Pages build missing"; exit 1; }
publish_dir=$(mktemp -d)
key_file="$publish_dir/deploy-key"
printf '%s\n' "$MIRROR_KEY" > "$key_file"
chmod 600 "$key_file"
ssh-keyscan -t ed25519 github.com > "$publish_dir/known_hosts" 2>/dev/null
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$publish_dir/known_hosts -o StrictHostKeyChecking=yes"
git clone --quiet --depth 1 "git@github.com:${repo}.git" "$publish_dir/site"
mkdir -p "$publish_dir/site/fresh"
cp -R "$source_dir/." "$publish_dir/site/fresh/"
cd "$publish_dir/site"
git config user.name "k2-desk-bot"
git config user.email "noreply@users.noreply.github.com"
# Stage only this app. The existing 20-minute desk publisher owns the root.
for attempt in 1 2 3; do
  git fetch --quiet origin main
  git reset --mixed --quiet origin/main
  git add -- fresh/
  if git diff --cached --quiet; then echo "Fresh Desk unchanged"; exit 0; fi
  git commit --quiet -m "fresh: publish research desk"
  if git push --quiet origin HEAD:main; then echo "Fresh Desk published; served verification follows"; exit 0; fi
done
echo "Mirror push failed after three attempts"
exit 1
