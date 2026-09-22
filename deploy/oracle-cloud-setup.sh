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
# WHICH SHAPE TO ASK FOR, from Oracle's own Always Free resource reference:
#
#   VM.Standard.A1.Flex    2 OCPU / 12 GB total   ARM. Best, but Oracle HALVED
#                          this on 15 June 2026 (it was 4/24) and capacity is
#                          shared per region -- "out of host capacity" on a
#                          first attempt is normal, not a mistake you made.
#   VM.Standard.E2.1.Micro 1/8 OCPU / 1 GB, x2    AMD. Smaller, and almost
#                          always actually available.
#   Block storage          200 GB across both, boot volume 50 GB by default.
#
# TAKE THE ARM SHAPE IF YOU CAN GET IT. If it says out of capacity, take the
# AMD micro instead and do not wait: this desk holds about 550 MB and Ubuntu
# minimal about 180 MB, so 1 GB fits with roughly 290 MB to spare. The script
# adds a 2 GB swap file either way, because the memory pressure here is BURSTY
# -- the screener walks 27,536 contracts in a third of a second -- rather than
# sustained, and swap absorbs a burst without ever being touched at rest.
#
# A card is taken for identity only. Always Free resources are not billed.
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

say "4/8  Swap, so a 1 GB micro survives the screener"
# The screener walks the whole listed option chain in a burst. On a 1 GB AMD
# micro that burst is the difference between running and being killed by the
# OOM reaper -- which is exactly how the desk died on an 8 GB laptop tonight,
# unattended, in under an hour. Swap costs nothing at rest.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 3000 ]; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Prefer real memory; touch swap only under genuine pressure.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-k2-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-k2-swap.conf >/dev/null
  echo "   2 GB swap added"
else
  echo "   swap already present, or the machine is large enough not to need it"
fi

say "5/8  Private directory for credentials and the ledger"
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

say "6/8  systemd service, so it restarts itself and survives a reboot"
# Size the heap to the machine rather than assuming. On a 1 GB micro a default
# V8 ceiling can exceed the box itself, so the process grows until the kernel
# kills it -- which looks like a crash and is really a mis-sized heap.
TOTAL_MB="$(free -m | awk '/^Mem:/{print $2}')"
if [ "$TOTAL_MB" -lt 1500 ]; then HEAP_MB=420; else HEAP_MB=1024; fi
echo "   ${TOTAL_MB} MB of RAM detected -> node heap capped at ${HEAP_MB} MB"
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
ExecStart=/usr/bin/node --max-old-space-size=${HEAP_MB} ${APP_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

sudo systemctl daemon-reload
sudo systemctl enable k2desk

say "7/8  Firewall"
# Oracle also has a cloud-level security list. Open the same port THERE, in the
# console, under Networking -> Virtual Cloud Networks -> your VCN -> Security
# Lists -> Ingress Rules, or the port will look closed however open it is here.
sudo ufw allow OpenSSH >/dev/null 2>&1 || true
sudo ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
sudo iptables -I INPUT -p tcp --dport "${PORT}" -j ACCEPT 2>/dev/null || true
sudo netfilter-persistent save >/dev/null 2>&1 || true
yes | sudo ufw enable >/dev/null 2>&1 || true

say "8/8  Start"
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
