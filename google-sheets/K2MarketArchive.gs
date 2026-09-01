/**
 * K² Google Sheets historical-market archive.
 *
 * Bind this script to the private archive spreadsheet, run setupK2Archive()
 * once, and deploy it as a Web app executing as you. Access may be set to
 * "Anyone" because every write is still rejected unless its long random
 * shared secret matches the Script Property created by setupK2Archive().
 */

const K2_STATE_HEADERS = [
  'Path', 'Version', 'Chunk', 'Chunk Count', 'Gzip Base64', 'Updated At'
];
const K2_STATE_CHUNK_SIZE = 40000;
const K2_MAX_STATE_DOCUMENT = 5000000;

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
      return json_(withWriteLock_(function () {
        ensureStateOnlyStorage_(spreadsheet);
        return writeDocument_(spreadsheet, payload);
      }));
    }
    if (payload.action === 'appendTradeSignals') {
      return json_(withWriteLock_(function () {
        return appendTradeSignals_(spreadsheet, payload.signals);
      }));
    }
    if (payload.action === 'appendPortfolioAudit') {
      return json_(withWriteLock_(function () {
        return appendPortfolioAudit_(spreadsheet, payload.holdings);
      }));
    }
    if (payload.action === 'appendMacroRadar') {
      return json_(withWriteLock_(function () {
        return appendMacroRadar_(spreadsheet, payload.radar);
      }));
    }
    return json_({ ok: false, error: 'Invalid action' });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error).slice(0, 200) });
  }
}

function readDocuments_(spreadsheet, payload) {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  if (!paths.length || paths.length > 60) return { ok: false, error: 'Invalid document paths' };
  const sheet = getStateSheet_(spreadsheet);
  const rowsByPath = stateRowsByPath_(sheet, new Set(paths.map(validPath_)));
  return {
    ok: true,
    documents: paths.map(function (path) {
      path = validPath_(path);
      const document = latestDocument_(rowsByPath.get(path) || []);
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
  return stateRowsByPath_(sheet, new Set([path])).get(path) || [];
}

function stateRowsByPath_(sheet, wantedPaths) {
  const grouped = new Map();
  wantedPaths.forEach(function (path) { grouped.set(path, []); });
  if (sheet.getLastRow() < 2) return grouped;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, K2_STATE_HEADERS.length).getValues();
  values.forEach(function (row, index) {
    const path = String(row[0] || '');
    if (!wantedPaths.has(path)) return;
    grouped.get(path).push({
      row: index + 2,
      version: Number(row[1]),
      chunk: Number(row[2]),
      chunkCount: Number(row[3]),
      data: String(row[4] || '')
    });
  });
  return grouped;
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

function ensureStateOnlyStorage_(spreadsheet) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('K2_STATE_ONLY_V2') === 'ready') return;
  spreadsheet.getSheets().forEach(function (sheet) {
    if (/^OHLCV_\d+$/.test(sheet.getName())) spreadsheet.deleteSheet(sheet);
  });
  properties.setProperty('K2_STATE_ONLY_V2', 'ready');
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

const K2_TRADE_LEDGER_HEADERS = [
  'Timestamp', 'Week Key', 'Signal ID', 'Symbol', 'Side', 'Action',
  'Entry Price', 'Target Price', 'Stop Loss', 'Risk/Reward',
  'Conviction %', 'Size Multiplier', 'VPIN', 'Hurst Exponent',
  'Kaufman ER', 'Meta Decision', 'Outcome'
];

const K2_HOLDINGS_AUDIT_HEADERS = [
  'Timestamp', 'Symbol', 'Buy Average', 'Mark Price', 'P&L %',
  'Trailing Stop', 'Target Price', 'Action Status', 'Risk Rationale'
];

const K2_MACRO_RADAR_HEADERS = [
  'Timestamp', 'Global Regime', 'Action Directive', 'GIFT Nifty %',
  'Brent Crude ($)', 'India VIX', 'US VIX', 'US 10Y Yield', 'Macro Summary'
];

function getOrCreateSheet_(spreadsheet, sheetName, headers) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#201d31').setFontColor('#ffffff');
  }
  return sheet;
}

function appendTradeSignals_(spreadsheet, signals) {
  if (!Array.isArray(signals) || !signals.length) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_TRADE_LEDGER', K2_TRADE_LEDGER_HEADERS);
  var now = new Date();
  var rows = signals.map(function (s) {
    return [
      now,
      s.weekKey || '',
      s.id || s.signalId || '',
      s.symbol || '',
      s.side || '',
      s.action || '',
      Number(s.entryPrice || s.entry || 0),
      Number(s.targetPrice || s.target || 0),
      Number(s.stopLossPrice || s.stopLoss || s.stop || 0),
      Number(s.riskReward || 0),
      Number(s.convictionPct || 0),
      Number(s.sizeMultiplier || 1.0),
      Number(s.vpin || (s.advancedQuant && s.advancedQuant.vpin) || 0),
      Number(s.hurst || (s.advancedQuant && s.advancedQuant.hurst) || 0),
      Number(s.er || (s.advancedQuant && s.advancedQuant.er) || 0),
      s.metaDecision || (s.advancedQuant && s.advancedQuant.metaDecision) || 'TAKE',
      s.outcome || 'PENDING'
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, K2_TRADE_LEDGER_HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
  return { ok: true, appended: rows.length, sheet: 'K2_TRADE_LEDGER' };
}

function appendPortfolioAudit_(spreadsheet, holdings) {
  if (!Array.isArray(holdings) || !holdings.length) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_PORTFOLIO_AUDIT', K2_HOLDINGS_AUDIT_HEADERS);
  var now = new Date();
  var rows = holdings.map(function (h) {
    return [
      now,
      h.symbol || '',
      Number(h.buyAverage || h.avg || 0),
      Number(h.markPrice || h.current || 0),
      Number(h.pnlPct || 0),
      Number(h.trailingStop || 0),
      Number(h.target || 0),
      h.status || h.action || 'HOLD',
      h.reason || h.riskRationale || ''
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, K2_HOLDINGS_AUDIT_HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
  return { ok: true, appended: rows.length, sheet: 'K2_PORTFOLIO_AUDIT' };
}

function appendMacroRadar_(spreadsheet, radar) {
  if (!radar) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_MACRO_RADAR', K2_MACRO_RADAR_HEADERS);
  var now = new Date();
  var row = [
    now,
    radar.regime || radar.severity || 'NORMAL',
    radar.actionDirective || 'STANDARD_EXECUTION',
    Number(radar.giftNiftyGapPct || 0),
    Number(radar.brentCrudePrice || 0),
    Number(radar.indiaVix || 0),
    Number(radar.usVix || 0),
    Number(radar.us10y || 0),
    radar.summary || ''
  ];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, K2_MACRO_RADAR_HEADERS.length).setValues([row]);
  SpreadsheetApp.flush();
  return { ok: true, appended: 1, sheet: 'K2_MACRO_RADAR' };
}
