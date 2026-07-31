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
const K2_STATE_HEADERS = [
  'Path', 'Version', 'Chunk', 'Chunk Count', 'Gzip Base64', 'Updated At'
];
const K2_STATE_CHUNK_SIZE = 40000;
const K2_MAX_STATE_DOCUMENT = 5000000;
const K2_SHARD_COUNT = 50;

function setupK2Archive() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the destination Sheet and run this as a bound script.');
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty('K2_SPREADSHEET_ID', spreadsheet.getId());
  if (!properties.getProperty('K2_ARCHIVE_SECRET')) {
    properties.setProperty('K2_ARCHIVE_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  getStateSheet_(spreadsheet);
  console.log('K2_SPREADSHEET_ID=' + spreadsheet.getId());
  console.log('K2_GOOGLE_SHEETS_ARCHIVE_SECRET=' + properties.getProperty('K2_ARCHIVE_SECRET'));
}

function doGet() {
  return json_({ ok: true, service: 'K2 Google Sheets database', writable: true });
}

function doPost(event) {
  try {
    const payload = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    const properties = PropertiesService.getScriptProperties();
    if (!constantTimeEqual_(String(payload.secret || ''), String(properties.getProperty('K2_ARCHIVE_SECRET') || ''))) {
      return json_({ ok: false, error: 'Unauthorized' });
    }
    const spreadsheetId = properties.getProperty('K2_SPREADSHEET_ID');
    if (!spreadsheetId) return json_({ ok: false, error: 'Database is not configured' });
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (payload.action === 'readDocuments') {
      return json_(readDocuments_(spreadsheet, payload));
    }
    if (payload.action === 'writeDocument') {
      return json_(withWriteLock_(function () { return writeDocument_(spreadsheet, payload); }));
    }
    return json_(withWriteLock_(function () { return archiveRows_(spreadsheet, payload); }));
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error).slice(0, 200) });
  }
}

function archiveRows_(spreadsheet, payload) {
  try {
    const shard = Number(payload.shard);
    if (!Number.isInteger(shard) || shard < 0 || shard >= K2_SHARD_COUNT) return { ok: false, error: 'Invalid shard' };
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length > 25000) return { ok: false, error: 'Payload too large' };
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
    return { ok: true, rows: additions.length, received: rows.length, shard: shard };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error).slice(0, 200) };
  }
}

function readDocuments_(spreadsheet, payload) {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  if (!paths.length || paths.length > 60) return { ok: false, error: 'Invalid document paths' };
  const sheet = getStateSheet_(spreadsheet);
  return {
    ok: true,
    documents: paths.map(function (path) {
      path = validPath_(path);
      const document = latestDocument_(findStateRows_(sheet, path));
      if (!document) return { path: path, found: false, version: 0 };
      return {
        path: path,
        found: true,
        version: document.version,
        encoding: 'gzip-base64',
        encoded: document.chunks.join('')
      };
    })
  };
}

function writeDocument_(spreadsheet, payload) {
  const path = validPath_(payload.path);
  const expectedVersion = Number(payload.expectedVersion || 0);
  const encoded = String(payload.encoded || '');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { ok: false, error: 'Invalid expected version' };
  if (payload.encoding !== 'gzip-base64' || !encoded || encoded.length > K2_MAX_STATE_DOCUMENT || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return { ok: false, error: 'Invalid encoded document' };
  }
  const sheet = getStateSheet_(spreadsheet);
  const existingRows = findStateRows_(sheet, path);
  const current = latestDocument_(existingRows);
  const currentVersion = current ? current.version : 0;
  if (currentVersion !== expectedVersion) {
    return { ok: false, code: 'CONFLICT', error: 'Document changed', currentVersion: currentVersion };
  }
  const nextVersion = currentVersion + 1;
  const chunks = [];
  for (let offset = 0; offset < encoded.length; offset += K2_STATE_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + K2_STATE_CHUNK_SIZE));
  }
  const now = new Date();
  const additions = chunks.map(function (chunk, index) {
    return [path, nextVersion, index, chunks.length, chunk, now];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, K2_STATE_HEADERS.length).setValues(additions);
  SpreadsheetApp.flush();

  // The replacement becomes readable before the previous version is removed.
  // Deleting bottom-up keeps row references stable and avoids a blank window.
  deleteRows_(sheet, existingRows.map(function (row) { return row.row; }));
  return { ok: true, path: path, version: nextVersion, chunks: chunks.length };
}

function getStateSheet_(spreadsheet) {
  const name = 'K2_STATE';
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, K2_STATE_HEADERS.length).setValues([K2_STATE_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, K2_STATE_HEADERS.length).setFontWeight('bold').setBackground('#201d31').setFontColor('#ffffff');
  }
  return sheet;
}

function findStateRows_(sheet, path) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(path)
    .matchEntireCell(true)
    .findAll()
    .map(function (cell) {
      const row = cell.getRow();
      const values = sheet.getRange(row, 1, 1, K2_STATE_HEADERS.length).getValues()[0];
      return {
        row: row,
        version: Number(values[1]),
        chunk: Number(values[2]),
        chunkCount: Number(values[3]),
        data: String(values[4] || '')
      };
    });
}

function deleteRows_(sheet, rowNumbers) {
  const rows = rowNumbers.slice().sort(function (left, right) { return left - right; });
  const groups = [];
  rows.forEach(function (row) {
    const last = groups[groups.length - 1];
    if (last && row === last.start + last.count) last.count += 1;
    else groups.push({ start: row, count: 1 });
  });
  groups.reverse().forEach(function (group) {
    sheet.deleteRows(group.start, group.count);
  });
}

function latestDocument_(rows) {
  const versions = new Map();
  rows.forEach(function (row) {
    if (!Number.isInteger(row.version) || row.version < 1) return;
    if (!versions.has(row.version)) versions.set(row.version, []);
    versions.get(row.version).push(row);
  });
  return Array.from(versions.keys()).sort(function (left, right) { return right - left; }).map(function (version) {
    const chunks = versions.get(version).sort(function (left, right) { return left.chunk - right.chunk; });
    const expected = chunks[0] && chunks[0].chunkCount;
    const complete = Number.isInteger(expected) && expected > 0 && chunks.length === expected &&
      chunks.every(function (chunk, index) { return chunk.chunk === index && chunk.chunkCount === expected; });
    return complete ? { version: version, chunks: chunks.map(function (chunk) { return chunk.data; }) } : null;
  }).find(function (document) { return Boolean(document); }) || null;
}

function validPath_(value) {
  const path = String(value || '');
  if (!/^[A-Za-z0-9/_.-]{1,200}$/.test(path)) throw new Error('Invalid document path');
  return path;
}

function withWriteLock_(callback) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    return callback();
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
