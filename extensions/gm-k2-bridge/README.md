# K² GM Portfolio Extractor

This Chrome/Edge Manifest V3 extension automatically synchronizes the signed-in GM portfolio to the private Kamlesh K² account every 30 or 60 minutes. It also retains the manual evidence export for troubleshooting. It never places, changes, or closes a GM order.

The capture allowlist is limited to:

- `datatables/position_book_list.php`
- `datatables/position_book_list_new.php`
- `datatables/position_book_list_forex.php`
- `ajaxfiles/get_position_report_filter.php`

It never records or uploads the GM username, password, cookies, authorization headers, request headers, request bodies, or order/close actions. Only normalized open-position fields are uploaded to K².

## Install

1. Extract `gm-k2-bridge.zip`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the extracted `gm-k2-bridge` folder.

## One-time connection

1. Sign in to GM in the same Edge/Chrome profile.
2. Sign in to K² with the Kamlesh account.
3. Open the extension and press **Connect K² once**.
4. Press **Sync now** to verify the first upload.

The background worker then opens GM Portfolio in an inactive tab every 30 minutes, captures the portfolio response, securely uploads the normalized snapshot, and closes the temporary tab. The browser must be running and the GM login session must remain valid.

## Manual verification fallback

1. Sign in to GM and open `https://gmglobal.org/#/Portfolio`.
2. Open the extension and press **Arm capture and reload GM**.
3. Wait until the portfolio table is populated, then reopen the extension.
4. Press **Read current table now**.
5. Press **Export captured JSON**.

The JSON contains the exact captured endpoint URL and response, the rendered headers/rows after live updates, and normalized open NSE futures positions. Verify this file before any K² integration is enabled.
