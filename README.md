# K² — Range Desk

K² converts `journal (1).xlsx` into a hosted NSE watchlist, private cross-device portfolios, a transparent rolling 31-calendar-day range desk, and an automatic Friday-grid paper-trading laboratory. It is dedicated to the friendship between Kamlesh and Kuldeep.

## Local preview

```powershell
npm run dev
```

Then open `http://127.0.0.1:4173`.

## Core model

- Rolling low/high: lowest daily low and highest daily high in the last 31 calendar days.
- Midpoint: `(high + low) / 2`.
- Levels 1–3: symmetric positions inside the observed range.
- Levels 4–5: outside the observed range using `max(10% of range, 0.75 × ATR14)`, capped at 20% of range.
- Volatility: annualized standard deviation of daily log returns.
- Regime engine: trend, range, transition, or shock/high-volatility.
- Trend mode: five-session momentum, double-EMA direction, and Nifty-relative strength.
- Range mode: 31-day position, RSI pressure, and 20-day Z-score.
- Diagnostics: ATR, beta, correlation, acceleration, trend fit, and a shock veto.
- Holdings: five clickable exit bands above the actual average entry, with equal quantity slices and R multiples.

## Private backend

- Three server-authenticated accounts with peppered scrypt password hashes, including a read-only AI paper account.
- Signed `HttpOnly`, `Secure`, `SameSite=Strict` sessions.
- CSRF and origin validation on every mutation.
- Rate-limited login attempts.
- Per-user portfolios stored in a private Vercel Blob store with optimistic concurrency.
- API routes and market data require authentication.

## AI Friday-grid paper ledger

- Each workbook stock receives an isolated ₹2,00,000 virtual cash ledger.
- The latest completed Friday close becomes the weekly reference.
- Five whole-share slots can deploy up to ₹40,000 each at successive compounded 3% declines.
- Every filled lot receives its own 2% paper exit target.
- Same-daily-candle buy-and-sell fills are forbidden because daily high/low data cannot establish event order.
- Fill IDs are deterministic and shard writes use optimistic concurrency, making scheduler retries idempotent.
- Ten private Blob shards cover the full workbook without mixing the two manual portfolios.
- On first run, each stock backfills up to five years / 1,300 daily OHLCV sessions; later runs merge and deduplicate new sessions.
- The market calculation endpoint merges this stored history with the current quote, so longer-history models use the private database instead of repeatedly trusting a short live-feed window.
- A secured GitHub Actions workflow evaluates the grid during NSE hours; Vercel Cron supplies a daily post-close fallback.
- `CRON_SECRET` is stored only in Vercel and the private GitHub repository. The automation endpoint rejects requests without its bearer token.

Copy `.env.local.example` to `.env.local` and provide a private `BLOB_READ_WRITE_TOKEN` plus a strong `K2_SESSION_SECRET` for local backend work. Never commit either value.

## Google Sheets historical archive

K² keeps Vercel Blob as the operational database because portfolio and paper-ledger writes require private access and optimistic concurrency. A private Google Sheet can be attached as a deduplicated OHLCV archive:

1. Create or open the private destination Sheet.
2. Open Extensions → Apps Script and paste `google-sheets/K2MarketArchive.gs`.
3. Run `setupK2Archive()` once and copy the generated archive secret from the execution log.
4. Deploy the script as a Web app, executing as the Sheet owner.
5. Add the deployment URL as `K2_GOOGLE_SHEETS_WEB_APP_URL` and the generated secret as `K2_GOOGLE_SHEETS_ARCHIVE_SECRET` in Vercel.

The next secured AI runner pass backfills the `OHLCV_0` … `OHLCV_9` tabs, then sends deduplicated daily observations. A failed Sheet sync never corrupts or blocks the trading ledger.

The server endpoint is in `api/market.js`. The current feed uses Yahoo Finance's unofficial chart endpoint and can be delayed. For exchange-grade realtime NSE data, replace `fetchChart()` with a licensed provider while preserving the endpoint response shape.

## Refreshing the workbook import

Run:

```powershell
python .\scripts\extract_watchlist.py
```

This regenerates `watchlist-data.js` from the source workbook.
