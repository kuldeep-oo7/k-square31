# K² GM Portfolio Extractor

This Chrome/Edge Manifest V3 extension is the extraction-only phase of the GM integration. It captures the authenticated GM portfolio data source and exports evidence for verification. It does **not** write to K² or place any broker action.

The capture allowlist is limited to:

- `datatables/position_book_list.php`
- `datatables/position_book_list_new.php`
- `datatables/position_book_list_forex.php`
- `ajaxfiles/get_position_report_filter.php`

It never records the GM username, password, cookies, authorization headers, request headers, request bodies, or order/close actions.

## Install

1. Extract `gm-k2-bridge.zip`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the extracted `gm-k2-bridge` folder.

## Capture

1. Sign in to GM and open `https://gmglobal.org/#/Portfolio`.
2. Open the extension and press **Arm capture and reload GM**.
3. Wait until the portfolio table is populated, then reopen the extension.
4. Press **Read current table now**.
5. Press **Export captured JSON**.

The JSON contains the exact captured endpoint URL and response, the rendered headers/rows after live updates, and normalized open NSE futures positions. Verify this file before any K² integration is enabled.
