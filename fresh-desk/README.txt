FRESH DESK — PRICE-ACTION WORKBENCH

Start the local app:
  npm run fresh:start
  Open http://127.0.0.1:4174
  Or double-click START-FRESH-DESK.cmd.
  Use --demo for synthetic examples, --crypto for the public crypto spot source,
  or --port 4175 if the default port is occupied. Ctrl+C stops the app.

Four workspaces: Plans, Market Read, Playbook, Paper Record.
Four independent families: trend pullback, structure breakout, failed breakout,
range bounce. Each family evaluates BUY and SELL independently. This is a new
mechanical interpretation of public concepts, not any named trader's complete
method or a validated profitable system. Exact choices live in rules.json.

Entry references use fresh ask (BUY) or bid (SELL) after a completed candle.
Stops invalidate that setup; primary targets come from market structure.
The 3% price is a separate reference recalculated from the entered fill. An actual
fill can fail because risk is too large or too little structural reward remains.
No minimum holding period. Quotes may miss intrabar touches. Costs stay unknown
until supplied; paper net P&L is never substituted with gross or zero fees.

Charts: real OHLC candles or a line through actual closes, with entry/stop/target
annotations. Context comes from completed 3x bars before the last three entry
bars. Candle geometry, boundaries, volume/activity and every rejected family are
visible. No confidence score, guaranteed return or predicted time to profit.

LIVE SOURCES
- NSE futures: the existing Angel credentials and market-data transport only.
  Same-session master and verified NSE ban state are required. Calendar coverage
  remains explicit. No new reference after 15:00 IST; 24 five-minute bars are
  needed, so this version's first possible NSE evaluation is 11:15 IST.
- Crypto SPOT: public Binance exchangeInfo, klines, book ticker and server time.
  No keys or accounts. Quote time is conservatively bracketed by exchange-server
  calls; slow/unverifiable responses are rejected. No naked-short spot entries.
- Forex, equities and commodity futures: import normalized current-session JSON
  in Market Read. Live connectors for those venues are not implemented here.
  Tick volume must be labelled TICK_VOLUME; unknown activity cannot confirm a
  volume breakout. The app does not invent funding, exchange calendars or fees.
- Event momentum and genuine trade-by-trade order flow are not implemented.

IMPORT SHAPE
{inputs:[{symbol, instrumentId, market, currency, source, sourceUrl, intervalMinutes,
  sessionStart, isOpen, tradeable, canShort, tickSize, minQuantity, quantityStep,
  volumeKind, expiry, expiryAt, defaultQuantity,
  bars:[{symbol,expiry,at,open,high,low,close,volume}],
  quote:{symbol,expiry,instrumentId,at,bid,ask}}]}
Use JSON syntax (quoted keys) in a .json file. ISO timestamps require a timezone.
All bars must be contiguous from sessionStart. At least 24 completed bars; last
signal must be current. Incomplete bars are excluded. source is provenance, not
verification of a user-supplied dataset. Imports are always IMPORTED_RESEARCH,
use the actual current clock, and cannot enable demo mode. Use null expiry for
spot/forex and null volume for unavailable volume. Supported market values:
NSE_FUTURES, CRYPTO_SPOT, CRYPTO_PERP, FOREX, EQUITY, COMMODITY_FUTURES.
Non-NSE eligibility, calendar, expiryAt and short capability must be supplied;
that metadata is not independently certified by the importer.

PAPER RECORD
Record a fresh plan with a user-entered paper fill and quantity. The plan's stop
and structural target freeze. One open position per instrument; a plan cannot be
recorded twice. Manual exits accept total costs optionally. Live observations can
close a paper position only from fresh post-entry bid/ask data. Stops gap at the
observed worse quote; a target exit is capped at the target. Missing expiry data
is marked for review, never turned into a fabricated exit. Currency totals are
kept separate. Demo, imported and live books are separate files.
No existing account, position or stop is migrated or modified. No broker order
endpoint and no GM account access exist in this application.

FILES AND OPERATION
State, prices, paper books and exported snapshots stay under .private/fresh-desk/.
The loopback server uses same-origin request tokens, blocks other Host headers,
limits imports to 4 MB and serves only its fixed routes/assets. It refreshes the
selected live source every five minutes while running. It is not a public host
or a background scheduled service; closing the app stops those timers.

Other commands:
  npm run fresh:demo             labelled offline export
  npm run fresh:scan             NSE current-session snapshot
  npm run fresh:test             synthetic strategy/data/paper checks
  node fresh-desk/test-server.js HTTP persistence and request protection
  npm run fresh:audit            phone/laptop browser flow and screenshots
  node scripts/check-forward.js regression checks including both fresh suites

Synthetic examples exercise all eight family/side combinations. They do not
measure profitability. replay.js is a conservative single-trade OHLC utility,
not a historical strategy verdict. Ambiguous bars resolve stop-first; incomplete
exit data is censored. No real-data strategy test or forward validation has been
claimed. Commit a fixed protocol/code hash before a new historical study and
require separate forward evidence before promotion as a validated strategy.

The old deployed page and workflows remain separate. This app is local, not
published. Node's default fetch must be able to reach Angel/NSE/Binance for the
live connectors. This session's crypto connectivity check returned
NETWORK_ACCESS_DENIED; its NSE run returned MARKET_CLOSED. There is no demo
fallback in live mode.

Position monitoring is independent of new-entry/ban gates and continues through
the NSE session after the 15:00 new-entry cutoff. Partial scans are labelled;
Angel burst/session errors cool down and retry before a single auth refresh.
Publication attempt was rejected: the GitHub tool requires approval but this
session's approval policy is never; connector metadata also reports push=false.
All three handover files, including the private file in code, were read.

GITHUB PAGES BUILD (28 OCT 2026, STILL UNPUBLISHED)
The Node server is for local use. The Pages builder creates a separate static
application with the same engine/rendering and a browser-only paper journal:
  npm run fresh:pages
  node fresh-desk/build-pages.js --offline   explicit no-data build for review
  npm run fresh:pages:audit                 24 local hosting/browser checks
Output: .private/fresh-desk/pages/, including crypto/ and demo/ routes. No broker
or secret-reading module enters the browser bundle. Only generated display files
are copied to the mirror; raw source histories and credentials stay private.

.github/workflows/fresh-desk.yml uses existing K2_BROKERS_JSON and
K2_MIRROR_DEPLOY_KEY, plus optional K2_MIRROR_REPO. It publishes alongside the
working site at https://kuldeep-oo7.github.io/k2-desk/fresh/; that is a TARGET
address, not a claim it is serving. The old page gets a Fresh Desk link on its
next build after the source changes land. No old timer or tab is removed.
Run the Publish Fresh Desk workflow after merging. verify-pages.js checks the
served version, HTML and all assets for all three routes against that build.
Read live phone/laptop photographs as well before reporting publication complete.

Scheduled snapshots are every ten minutes during NSE hours, hourly outside.
This leaves space below the branch-based Pages 10-build/hour soft limit for the
old desk's three builds/hour. GitHub scheduling/build/CDN delays are possible:
this is NOT streaming market data. Entry references expire after their original
five-minute window, even if publication arrives too late. Never extend validity
to compensate. Use the local app for more frequent connected observations.
Sources: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
and https://docs.github.com/en/actions/how-tos/troubleshoot-workflows

Pages paper records live only in that browser, with demo/live separated. Download
a backup; they do not sync to Google Sheets or another device. Observed exits are
checked only on newly loaded published snapshots. A closed page cannot monitor a
position; a missed touch is not reconstructed from old candles. The local server
continues to provide the fuller monitoring/import functionality documented above.
