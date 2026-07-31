# K² — Range Desk

K² converts `journal (1).xlsx` into a hosted NSE watchlist, private cross-device portfolios, a transparent rolling 31-calendar-day range desk, and an automatic Monday-grid paper-trading laboratory. It is dedicated to the friendship between Kamlesh and Kuldeep.

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

## AI Monday-grid paper ledger

- Each workbook stock receives an isolated ₹2,00,000 virtual cash ledger.
- Each stock resets to the opening price of its first market session of the current Monday week.
- Five whole-share slots can deploy up to ₹40,000 each at successive compounded 2% declines from that Monday base.
- Cumulative weekly movement is used, so several smaller daily declines can cross a level.
- Every filled lot receives its own 2% paper exit target.
- The ₹40,000 maximum slot is scaled down by recorded volatility, drawdown, trend evidence, empirical weekly frequency, and walk-forward analogue diagnostics.
- Same-daily-candle buy-and-sell fills are forbidden because daily high/low data cannot establish event order.
- Fill IDs are deterministic and shard writes use optimistic concurrency, making scheduler retries idempotent.
- Ten private Blob shards cover the full workbook without mixing the two manual portfolios.
- On first run, each stock backfills up to five years / 1,300 daily OHLCV sessions; later runs merge and deduplicate new sessions.
- The market calculation endpoint merges this stored history with the current quote, so longer-history models use the private database instead of repeatedly trusting a short live-feed window.
- A secured GitHub Actions workflow evaluates the grid during NSE hours; Vercel Cron supplies a daily post-close fallback.
- `CRON_SECRET` is stored only in Vercel and the private GitHub repository. The automation endpoint rejects requests without its bearer token.

Copy `.env.local.example` to `.env.local` and provide a private `BLOB_READ_WRITE_TOKEN` plus a strong `K2_SESSION_SECRET` for local backend work. Never commit either value.

## Google Sheets database and historical archive

K² can use a private Google Sheet as both the operational portfolio/paper-ledger database and the deduplicated OHLCV archive. Operational JSON documents are gzip-compressed, split below the Google Sheets cell limit, versioned, and protected by Script Lock plus optimistic concurrency:

1. Create or open the private destination Sheet.
2. Open Extensions → Apps Script and paste `google-sheets/K2MarketArchive.gs`.
3. Run `setupK2Archive()` once and copy the generated archive secret from the execution log.
4. Deploy the script as a Web app, executing as the Sheet owner.
5. Add the deployment URL as `K2_GOOGLE_SHEETS_WEB_APP_URL` and the generated secret as `K2_GOOGLE_SHEETS_ARCHIVE_SECRET` in Vercel.

When both variables are present, K² automatically switches the operational database from Vercel Blob to the private Sheet. The next secured AI runner pass builds `K2_STATE`, backfills `OHLCV_0` … `OHLCV_49`, and then sends deduplicated daily observations. The Vercel functions never expose the Sheet URL or shared secret to the browser.

The server endpoint is in `api/market.js`. The current feed uses Yahoo Finance's unofficial chart endpoint and can be delayed. For exchange-grade realtime NSE data, replace `fetchChart()` with a licensed provider while preserving the endpoint response shape.

## Refreshing the workbook import

Run:

```powershell
python .\scripts\extract_watchlist.py
```

This regenerates `watchlist-data.js` from the source workbook.
