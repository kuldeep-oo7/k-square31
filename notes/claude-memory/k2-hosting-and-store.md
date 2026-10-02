---
name: k2-hosting-and-store
description: "Render free tier suspended the desk on 2026-09-22 after 750 monthly hours ran out; the desk now runs locally with a Cloudflare quick tunnel, and Oracle Always Free is the planned permanent home"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-22T17:16:55.061Z
---

**SUPERSEDED 2026-09-23.** The desk no longer runs on a server or the laptop. It is built by
GitHub Actions on an outside clock (cron-job.org) and served at
https://kuldeep-oo7.github.io/k2-desk/. Everything below is the history of how it got
there. See [[k2-serverless-desk]].


**Render free is structurally wrong for this desk, not merely small.** On
2026-09-22 it showed "This service has been suspended by its owner" — Render's
wording for free instance-hours exhausted, which suspends every free web service
until the next calendar month.

Three properties caused most of the grief, and none is fixable in code:

- **The disk is wiped on every deploy.** This is what destroyed the paper ledger
  each time the code changed (the win rate kept resetting to zero) and why
  `iv_history` could never reach the 30 sessions IV rank needs — it counted to
  two, got wiped, started again.
- **It sleeps after 15 minutes**, producing `NO_CONTRACT_REFERENCE` and an empty
  shortlist on the first look after a quiet spell.
- **750 instance-hours per month, shared across ALL services**, and hours are
  only consumed while a service is AWAKE. One always-on web service is 720.

**What exhausted it:** `render.yaml` declared a second always-on Docker worker,
`k2-gm-portfolio-sync` (720 h/month for something `server.js` cannot even
reach), plus heavy `/api/state` polling during verification which kept the web
service from ever sleeping. The yaml and `Dockerfile.gm-worker` are deleted, but
**the service itself must be deleted in the Render dashboard** or it keeps
burning hours.

**How the desk runs now:** `npm start` locally on port **4173**, plus
`npx cloudflared tunnel --url http://localhost:4173` for a public HTTPS URL that
works anywhere, free, no account. `START-DESK.cmd` does both and checks the port
first so a second launch cannot produce EADDRINUSE. **The quick-tunnel URL
changes on every restart**; read the current one from cloudflared's metrics port
(`Get-NetTCPConnection -OwningProcess <pid>`, then `/metrics`, grep
`userHostname`) rather than hunting for the console window.

Local is genuinely better than free Render: the ledger, `iv_history` and
`session_levels` all persist, nothing sleeps, and the 512 MB ceiling is gone
(the desk peaks near 238 MB).

**Planned permanent home:** Oracle Cloud Always Free — 2-4 ARM cores, 12-24 GB
RAM, 200 GB *persistent* storage, never sleeps, no monthly cap, does not expire.
`deploy/oracle-cloud-setup.sh` installs it with a systemd unit. Catch: Ampere
capacity is region-limited, "out of capacity" on a first attempt is normal, and
a card is taken for identity only. The user must create the account — signup
needs their own identity.

The Google Sheets archive is separate and still the durable store for the
ledger; see [[k2-render-free-tier-limits]] for the cold-start failure modes and
[[verify-against-the-internet]] for how the Render semantics were confirmed.

**Laptop server stopped 2026-09-27** (user: "stop it"): `node server.js` (port
4173, via npm start) and a Cloudflare quick tunnel had kept running since
2026-09-22 22:43, still logging in to Angel One (touching .private/brokers.json).
Both process trees ended; no startup item, Run key or scheduled task restarts
them. The desk needs nothing on the laptop.

