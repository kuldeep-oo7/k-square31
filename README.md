# K² — Range Desk

K² converts `journal (1).xlsx` into a hosted NSE watchlist, private cross-device portfolios, and a transparent rolling 31-calendar-day trading range desk. It is dedicated to the friendship between Kamlesh and Kuldeep.

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

- Two server-authenticated accounts with scrypt password hashes.
- Signed `HttpOnly`, `Secure`, `SameSite=Strict` sessions.
- CSRF and origin validation on every mutation.
- Rate-limited login attempts.
- Per-user portfolios stored in a private Vercel Blob store with optimistic concurrency.
- API routes and market data require authentication.

Copy `.env.local.example` to `.env.local` and provide a private `BLOB_READ_WRITE_TOKEN` plus a strong `K2_SESSION_SECRET` for local backend work. Never commit either value.

The server endpoint is in `api/market.js`. The current feed uses Yahoo Finance's unofficial chart endpoint and can be delayed. For exchange-grade realtime NSE data, replace `fetchChart()` with a licensed provider while preserving the endpoint response shape.

## Refreshing the workbook import

Run:

```powershell
python .\scripts\extract_watchlist.py
```

This regenerates `watchlist-data.js` from the source workbook.
