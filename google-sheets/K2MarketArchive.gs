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
  // P1-026: Shared secret is stored safely in ScriptProperties and must never be dumped to logs.
}

function doGet() {
  return json_({
    ok: true,
    service: 'K2 Google Sheets database',
    version: '2026.09.06',
    capabilities: [
      'readDocuments', 'writeDocument', 'appendTradeSignals',
      'appendPortfolioAudit', 'appendMacroRadar', 'appendStockFundamentals',
      'readTabRows', 'appendDailyRecommendations', 'appendRecommendationAudit'
    ],
    writable: true
  });
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
    if (payload.action === 'appendStockFundamentals') {
      return json_(withWriteLock_(function () {
        return appendStockFundamentals_(spreadsheet, payload.fundamentals);
      }));
    }
    if (payload.action === 'appendDailyRecommendations') {
      return json_(withWriteLock_(function () {
        return appendDailyRecommendations_(spreadsheet, payload.recommendations);
      }));
    }
    if (payload.action === 'appendRecommendationAudit') {
      return json_(withWriteLock_(function () {
        return appendRecommendationAudit_(spreadsheet, payload.audit);
      }));
    }
    if (payload.action === 'readTabRows') {
      return json_(readTabRows_(spreadsheet, payload));
    }
    return json_({ ok: false, error: 'Invalid action' });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error).slice(0, 200) });
  }
}

function readTabRows_(spreadsheet, payload) {
  const tabName = String(payload.tab || '').trim();
  const limit = Math.min(Math.max(1, Number(payload.limit) || 100), 500);
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Tab not found: ' + tabName };
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { ok: true, tab: tabName, count: 0, rows: [] };
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (lastRow === 1) return { ok: true, tab: tabName, count: 0, headers: headers, rows: [] };
  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, lastCol).getValues();
  const rows = data.map(function (row) {
    const obj = {};
    headers.forEach(function (h, idx) {
      obj[String(h)] = row[idx];
    });
    return obj;
  });
  return { ok: true, tab: tabName, totalRows: lastRow - 1, count: rows.length, headers: headers, rows: rows };
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

const K2_DAILY_RECOMMENDATIONS_HEADERS = [
  'Timestamp', 'Symbol', 'Asset Class', 'Action', 'Trading Symbol',
  'Strike', 'Expiry', 'Lot Size', 'Entry Limit', 'Stop Loss',
  'Target 1', 'Target 2', 'Runner Target', 'Capital Required INR',
  'Max Risk INR', 'Hedge Strategy', 'Status', 'Reason', 'Zerodha Fast Copy'
];

const K2_RECOMMENDATION_AUDIT_HEADERS = [
  'Audited At', 'Session', 'Status', 'Recommendation Count',
  'Accepted Outcomes', 'Excluded Count', 'Win Rate %', 'Net PnL INR',
  'Average Trade INR', 'Proposal'
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

const K2_FUNDAMENTALS_HEADERS = [
  'Timestamp', 'Week Key', 'Symbol', 'Forward P/E', 'Debt / Equity',
  'Current Ratio', 'Quick Ratio', 'Return on Equity (ROE %)', 'Return on Assets (ROA %)',
  'Operating Margin %', 'Profit Margin %', 'Revenue Growth %', 'Earnings Growth %',
  'Total Cash', 'Total Debt', 'Enterprise Value', 'Beta',
  'Balance Sheet Score (-1 to +1)', 'Next Earnings Date', 'Earnings Inside Week Veto'
];

function appendStockFundamentals_(spreadsheet, fundamentals) {
  if (!Array.isArray(fundamentals) || !fundamentals.length) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_FUNDAMENTALS_BALANCE_SHEET', K2_FUNDAMENTALS_HEADERS);
  var now = new Date();
  var rows = fundamentals.map(function (f) {
    var m = f.metrics || {};
    var e = f.events || {};
    return [
      now,
      f.weekKey || '',
      f.symbol || '',
      Number(m.forwardPE || 0),
      Number(m.debtToEquity || 0),
      Number(m.currentRatio || 0),
      Number(m.quickRatio || 0),
      Number(m.returnOnEquity || 0) * 100,
      Number(m.returnOnAssets || 0) * 100,
      Number(m.operatingMargin || 0) * 100,
      Number(m.profitMargin || 0) * 100,
      Number(m.revenueGrowth || 0) * 100,
      Number(m.earningsGrowth || 0) * 100,
      Number(m.totalCash || 0),
      Number(m.totalDebt || 0),
      Number(m.enterpriseValue || 0),
      Number(m.beta || 0),
      Number(f.balanceSheetScore || 0),
      e.nextEarningsDate || 'None Announced',
      e.insideTradingWeek ? 'YES (EVENT VETO)' : 'NO'
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, K2_FUNDAMENTALS_HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
  return { ok: true, appended: rows.length, sheet: 'K2_FUNDAMENTALS_BALANCE_SHEET' };
}

function appendDailyRecommendations_(spreadsheet, recommendations) {
  if (!Array.isArray(recommendations) || !recommendations.length) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_DAILY_RECOMMENDATIONS', K2_DAILY_RECOMMENDATIONS_HEADERS);
  var now = new Date();
  var rows = recommendations.map(function (r) {
    var hedge = r.definedRiskHedge ? (r.definedRiskHedge.strategyType || 'HEDGED') : 'NONE';
    return [
      now,
      r.symbol || '',
      r.assetClass || 'OPTION',
      r.action || 'BUY',
      r.tradingSymbol || '',
      Number(r.strike || 0),
      r.expiry || '',
      Number(r.lotSize || 1),
      Number(r.entryTrigger || 0),
      Number(r.stopLoss || 0),
      Number(r.targetRung1 || 0),
      Number(r.targetRung2 || 0),
      Number(r.runnerTarget || 0),
      Number(r.capitalRequiredInr || 0),
      Number(r.maxRiskInr || 0),
      hedge,
      r.status || 'ACTIVE',
      r.reason || '',
      r.zerodhaFastCopy || ''
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, K2_DAILY_RECOMMENDATIONS_HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
  return { ok: true, appended: rows.length, sheet: 'K2_DAILY_RECOMMENDATIONS' };
}

function appendRecommendationAudit_(spreadsheet, audit) {
  if (!audit) return { ok: true, appended: 0 };
  var sheet = getOrCreateSheet_(spreadsheet, 'K2_RECOMMENDATION_AUDIT', K2_RECOMMENDATION_AUDIT_HEADERS);
  var userGroup = (audit.groups && audit.groups.USER_CONFIRMED) || {};
  var proposal = (audit.proposals && audit.proposals[0] && audit.proposals[0].id) || 'MAINTAIN';
  var row = [
    audit.auditedAt || new Date().toISOString(),
    audit.session || '',
    audit.status || 'REVIEW',
    Number(audit.recommendationCount || 0),
    Number(audit.acceptedOutcomes || 0),
    Number(audit.excludedOutcomes && audit.excludedOutcomes.length || 0),
    Number(userGroup.winRatePct || 0),
    Number(userGroup.netPnlInr || 0),
    Number(userGroup.averageNetPnlPerTradeInr || 0),
    proposal
  ];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, K2_RECOMMENDATION_AUDIT_HEADERS.length).setValues([row]);
  SpreadsheetApp.flush();
  return { ok: true, appended: 1, sheet: 'K2_RECOMMENDATION_AUDIT' };
}

