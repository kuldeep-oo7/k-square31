---
name: gm-global-manual-only
description: "GM Global is only where the user places futures trades by hand; the desk must fetch, read or store nothing from it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-29T18:43:29.691Z
---

GM Global is the user's futures trading platform, used manually. The desk has
NO relation to it: nothing is fetched from it, read from an export of it, or
stored for it. All data comes from the exchange (NSE files) and the Angel One
API.

**Why:** the user said so twice, emphatically — earlier "remove every part of
the gm global from here, everything should be fetched and stored from the api",
and on 2026-09-24 "THERE IS NO RELATION WITH GM GLOBAL ... I WILL USE AS THE
FUTURE TRADING ... YOU DON'T HAVE TO FETCH IT ANYTHING". The last live leftover,
a 31-Aug GM portfolio CSV used by `universe-210.js` as a fallback price stamped
`hasObservedPrice: true`, was removed that night.

**How to apply:** never add a GM data source or suggest one. "Broker login" on
this desk means Angel One SmartAPI (market data), never GM — say so explicitly,
because the user reads "broker" as GM. Old GM tooling (manual-dispatch
workflows, the gm-k2-bridge extension, scripts/gm-*.js) is inert and not part of
the desk. The one legitimate GM question is which price GM's screen shows for
a future (share vs contract) — that decides `K2_FUTURES_ANCHOR`; ask the user to
compare screens, never fetch. See [[k2-trading-rules]].

**Cleaned up 2026-09-30 (user approved "yes, unless the project uses it"):**
verified first that nothing on the desk path uses GM (desk.yml uses no GM
secret; none of the 23 modules prepare/publish load references GM; GM code
lives only in api/gm-sync.js, scripts/gm-*.js and two tests). Then the three
manual GM workflows (gm-cloud-sync, gm-explore, gm-portfolio-dump) were
DISABLED, and the user deleted the secrets GM_USERNAME, GM_PASSWORD and
K2_GM_CLOUD_SYNC_SECRET (checked: 0 GM secrets left). GitHub holds no GM login.

**Measured 2026-09-24/25:** GM Global's NSE tab quotes the NSE **near-month
futures** price EXACTLY -- 6 names of 6 to the paisa against NSE's own files,
its change column included (LT 3,859.80 = Sep future; share 3,858.40). So the
futures anchor becomes the CONTRACT from the session of 28 Sep 2026 (switch
tested and SCHEDULED to be pushed after the 25-Sep close -- check git log for
"anchor" before assuming it is live; `K2_FUTURES_ANCHOR=SHARE` reverts). GM lists only the
expiring month until expiry, while the desk plans on the first expiry >= 7 days
out -- so in each month's last week the desk's contract is not yet on GM.

**20 units is not an NSE contract (checked 2026-09-25).** NSE's lot for LT is
175 and for MOTHERSON 6,150 (NSE fo_mktlots.csv, Last-Modified 25 Aug 2026, and
the desk's NSE contract file), so a 20-unit position cannot be an NSE futures
contract; it is a product priced off NSE. The user was told how to check GM
themselves: NSE's "Know/Locate your Stock Broker" (nseindia.com/invest/find-a-stock-broker),
SEBI's registered-broker list (equity derivatives, intmId=31), and RBI's Alert
List (updated 19 Nov 2025). NSE's press release of 4 Aug 2026 says off-exchange
schemes get none of the exchange's investor protection, dispute resolution or
grievance redressal. Nothing was fetched from GM, and no claim was made about
what GM is.

**From the user's own screenshot, 2026-09-27 (nothing fetched from GM):** in roll
week GM lists BOTH 29SEP2026 and 27OCT2026 contracts, so the desk's October
rows exist on GM. Its after-close BID/ASK equals NSE's official SETTLEMENT price,
not the last trade -- 6 of 6 against the 25 Sep F&O bhavcopy (BEL OCT 394.55
settle vs 394.95 last; AXISBANK OCT 1226.60; NIFTY OCT 23263.60) -- and its
CLOSE column is NSE's previous close. User says GM settles P&L at Friday close
and restarts from Monday OPEN as the new purchase price; whether the weekend
gap is counted was asked, not yet answered. GM's logo carries the tagline
"Training purpose only".

**What GM is, from the user (2026-09-27):** a paper-trading competition among
friends, built for fun; the weakest performer pays the group's monthly
hotel/restaurant/trip bills, so reputation and money ride on it. Do NOT ask the
user to run a regulator/withdrawal check on GM -- not relevant. Real money goes
only into OPTIONS on Zerodha, bought from the desk's calls tab: every option
price shown must be an order Zerodha accepts. User does NOT want the weekend-gap
accounting question pursued -- only correct prices and targets.

