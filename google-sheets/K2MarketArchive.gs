/**
 * K² Google Sheets historical-market archive.
 *
 * Bind this script to the private archive spreadsheet, run setupK2Archive()
 * once, and deploy it as a Web app executing as you. Access may be set to
 * "Anyone" because every write is still rejected unless its long random
 * shared secret matches the Script Property created by setupK2Archive().
 */

const K2_HEADERS = [
  'Symbol', 'Session', 'Open', 'High', 'Low', 'Close', 'Volume',
  'Sector', 'Market Cap Category', 'Recorded At'
];

function setupK2Archive() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the destination Sheet and run this as a bound script.');
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty('K2_SPREADSHEET_ID', spreadsheet.getId());
  if (!properties.getProperty('K2_ARCHIVE_SECRET')) {
    properties.setProperty('K2_ARCHIVE_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  console.log('K2_SPREADSHEET_ID=' + spreadsheet.getId());
  console.log('K2_GOOGLE_SHEETS_ARCHIVE_SECRET=' + properties.getProperty('K2_ARCHIVE_SECRET'));
}

function doGet() {
  return json_({ ok: true, service: 'K2 market archive', writable: true });
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const payload = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    const properties = PropertiesService.getScriptProperties();
    if (!constantTimeEqual_(String(payload.secret || ''), String(properties.getProperty('K2_ARCHIVE_SECRET') || ''))) {
      return json_({ ok: false, error: 'Unauthorized' });
    }
    const shard = Number(payload.shard);
    if (!Number.isInteger(shard) || shard < 0 || shard > 9) return json_({ ok: false, error: 'Invalid shard' });
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length > 25000) return json_({ ok: false, error: 'Payload too large' });
    const spreadsheetId = properties.getProperty('K2_SPREADSHEET_ID');
    if (!spreadsheetId) return json_({ ok: false, error: 'Archive is not configured' });
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = getShardSheet_(spreadsheet, shard);
    const existing = existingKeys_(sheet);
    const recordedAt = new Date();
    const additions = [];
    rows.forEach(function (row) {
      const symbol = String(row.symbol || '').trim().toUpperCase();
      const session = String(row.session || '').trim();
      if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(session)) return;
      const key = symbol + '|' + session;
      if (existing.has(key)) return;
      additions.push([
        symbol, session, numeric_(row.open), numeric_(row.high), numeric_(row.low),
        numeric_(row.close), numeric_(row.volume), String(row.sector || ''),
        String(row.marketCapCategory || ''), recordedAt
      ]);
      existing.add(key);
    });
    if (additions.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, K2_HEADERS.length).setValues(additions);
    }
    return json_({ ok: true, rows: additions.length, received: rows.length, shard: shard });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error).slice(0, 200) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function getShardSheet_(spreadsheet, shard) {
  const name = 'OHLCV_' + shard;
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, K2_HEADERS.length).setValues([K2_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, K2_HEADERS.length).setFontWeight('bold').setBackground('#201d31').setFontColor('#ffffff');
  }
  return sheet;
}

function existingKeys_(sheet) {
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return new Set();
  return new Set(sheet.getRange(2, 1, count, 2).getDisplayValues().map(function (row) { return row[0] + '|' + row[1]; }));
}

function numeric_(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function constantTimeEqual_(left, right) {
  if (!left || left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
