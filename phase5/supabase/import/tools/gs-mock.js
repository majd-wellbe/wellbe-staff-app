// Node stand-in for the Google services the Apps Script files need when import.js reads old rows with them.
// STAFF / PACKAGE TYPES / SETTINGS come from the Operations .xlsx in WB_OPS_XLSX (read only); without it cfg_() uses Config.gs defaults.
// Minimal node mock of the Google Apps Script services, enough for import.js (pure helper functions + cfg_()).
// SpreadsheetApp.openById throws, so cfg_() falls back to CFG_DEFAULTS (logged).
const crypto = require('crypto');
function fmt(d, tz, f) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
}
global.Utilities = { formatDate: fmt, getUuid: () => crypto.randomUUID(), sleep: () => {} };
global.Logger = { log: m => { if (process.env.GS_LOG) console.error('[gs]', m); } };
const cache = {};
global.CacheService = { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }, removeAll: () => {} }) };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
// Read-only sheets backed by the downloaded Operations .xlsx (env WB_OPS_XLSX), so cfg_() reads the real STAFF / PACKAGE TYPES / SETTINGS tabs.
let OPS = null;
function opsBook() {
  if (OPS) return OPS;
  let XLSX; try { XLSX = require(process.env.WB_XLSX_MOD || 'xlsx'); } catch (e) { XLSX = require(require('path').join(__dirname, '../../tests/node_modules/xlsx')); } const wb = XLSX.readFile(process.env.WB_OPS_XLSX, { cellDates: true });
  OPS = { getSheetByName: n => { const ws = wb.Sheets[n]; if (!ws) return null;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    return { getLastRow: () => rows.length, getRange: (r, c, nr, nc) => ({ getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) { const row = rows[r - 1 + i] || [], x = []; for (let j = 0; j < (nc || 1); j++) x.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); o.push(x); } return o; } }) }; } };
  return OPS;
}
global.SpreadsheetApp = { openById: id => { if (process.env.WB_OPS_XLSX && id === CFG.OPS_ID) return opsBook(); throw new Error('no sheet ' + id + ' in the import mock'); }, flush: () => {} };
global.LockService = { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) };
global.ContentService = { MimeType: {}, createTextOutput: () => ({ setMimeType: () => ({}) }) };
['UrlFetchApp', 'ScriptApp', 'CalendarApp', 'MailApp', 'DriveApp', 'Session'].forEach(n => { global[n] = {}; });
