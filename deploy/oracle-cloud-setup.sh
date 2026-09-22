#!/usr/bin/env bash
#
# K² RANGE DESK — ONE-TIME SETUP ON AN ORACLE CLOUD ALWAYS FREE VM
#
# WHY THIS EXISTS. The desk spent three days on a Render free instance and the
# free tier is structurally wrong for it, not merely small:
#
#   THE DISK IS WIPED ON EVERY DEPLOY.  That is what destroyed the paper ledger
#     every time the code changed, and why the win rate kept resetting to zero.
#     It is also why the implied-volatility history could never reach the thirty
#     sessions IV rank needs -- it counted to two, got wiped, and started again.
#   IT SLEEPS AFTER FIFTEEN MINUTES.  Which is why the first look after a quiet
#     spell showed NO_CONTRACT_REFERENCE and an empty shortlist.
#   750 INSTANCE-HOURS A MONTH.  One always-on service is 720, so it fits only
#     just, and a second service -- a worker, say -- kills the month by day 15.
#
# An Oracle Always Free VM has none of those properties. It is a real machine
# with a real disk that persists, it never sleeps, there is no monthly hour cap,
# and it does not expire the way an AWS or GCP free tier does.
#
#   2-4 ARM cores, 12-24 GB RAM, 200 GB persistent storage, 10 TB egress.
#   The desk peaks at 238 MB. It will not notice the machine.
#
# THE ONE REAL CATCH, said plainly: Ampere ARM capacity is shared per region and
# Oracle does not guarantee you can claim it. "Out of capacity" on your first
# try is normal -- retry, or pick a different home region at signup. A card is
# required for identity only and Always Free resources are not billed.
#
# USAGE, on a fresh Ubuntu 24.04 ARM instance:
#   curl -fsSL <this file> -o setup.sh && bash setup.sh
# or copy it across and run it.

set -euo pipefail

REPO="${K2_REPO:-https://github.com/kuldeep-oo7/k-square31.git}"
APP_DIR="${K2_APP_DIR:-$HOME/k-square31}"
PORT="${K2_PORT:-4173}"
NODE_MAJOR=24

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }

say "1/7  System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates ufw

say "2/7  Node.js ${NODE_MAJOR}.x (the desk pins engines to 24.x)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v

say "3/7  Application"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

say "4/7  Private directory for credentials and the ledger"
# THIS IS THE WHOLE POINT. On Render this directory vanished on every deploy.
# Here it is on a disk that persists across restarts, reboots and code updates,
# so the paper record accumulates instead of resetting.
mkdir -p "$APP_DIR/.private/cache"
if [ ! -f "$APP_DIR/.private/production.env" ]; then
  cat > "$APP_DIR/.private/production.env" <<'ENVEOF'
# Copy the values from your Render dashboard's Environment tab.
# Nothing here is committed: .private is git-ignored.
ANGEL_ONE_API_KEY=
ANGEL_ONE_CLIENT_CODE=
ANGEL_ONE_PASSWORD=
ANGEL_ONE_TOTP_SECRET=
K2_GOOGLE_SHEETS_WEB_APP_URL=
K2_GOOGLE_SHEETS_ARCHIVE_SECRET=
ENVEOF
  chmod 600 "$APP_DIR/.private/production.env"
  echo "   created .private/production.env — FILL IT IN before starting"
fi

say "5/7  systemd service, so it restarts itself and survives a reboot"
sudo tee /etc/systemd/system/k2desk.service >/dev/null <<UNITEOF
[Unit]
Description=K2 Quantitative Range Desk
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.private/production.env
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=TZ=Asia/Kolkata
ExecStart=/usr/bin/node --max-old-space-size=1024 ${APP_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

sudo systemctl daemon-reload
sudo systemctl enable k2desk

say "6/7  Firewall"
# Oracle also has a cloud-level security list. Open the same port THERE, in the
# console, under Networking -> Virtual Cloud Networks -> your VCN -> Security
# Lists -> Ingress Rules, or the port will look closed however open it is here.
sudo ufw allow OpenSSH >/dev/null 2>&1 || true
sudo ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
sudo iptables -I INPUT -p tcp --dport "${PORT}" -j ACCEPT 2>/dev/null || true
sudo netfilter-persistent save >/dev/null 2>&1 || true
yes | sudo ufw enable >/dev/null 2>&1 || true

say "7/7  Start"
sudo systemctl restart k2desk
sleep 6
sudo systemctl --no-pager --lines=12 status k2desk || true

PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo 'YOUR_VM_IP')"
cat <<DONEEOF

========================================================================
  THE DESK IS INSTALLED AND WILL RESTART ITSELF FOR EVER

  Open it:      http://${PUBLIC_IP}:${PORT}
  Logs:         sudo journalctl -u k2desk -f
  Restart:      sudo systemctl restart k2desk
  Update:       cd ${APP_DIR} && git pull && npm install --omit=dev \\
                  && sudo systemctl restart k2desk

  BEFORE IT WILL FETCH LIVE QUOTES, fill in the broker credentials:
      nano ${APP_DIR}/.private/production.env
      sudo systemctl restart k2desk

  AND OPEN PORT ${PORT} IN THE ORACLE CONSOLE as well as in ufw:
      Networking -> Virtual Cloud Networks -> (your VCN)
        -> Security Lists -> Default -> Add Ingress Rule
           Source 0.0.0.0/0, TCP, destination port ${PORT}
  Nothing reaches the machine until that rule exists, however correct
  everything on this side is. It is the step everyone misses.

  WHAT THIS BUYS YOU OVER THE FREE RENDER INSTANCE:
    the ledger and the IV history live on a disk that PERSISTS, so the
    track record finally accumulates instead of resetting on every
    deploy; nothing sleeps, so there is no blank screen at 09:14; and
    there is no monthly hour cap to run out of on the 15th.
========================================================================
DONEEOF
