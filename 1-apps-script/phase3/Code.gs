// =====================================================================
// WELLBE W40 LANDING PAGE BACKEND
// Standalone Apps Script project (NOT inside the CRM project).
// Reads SESSIONS 1:3 + LEADS W40 in the Operations sheet, serves open
// slots to the landing page, saves leads, takes bookings, sends alerts.
// =====================================================================

var CFG = {
  OPS_ID: '1qACLaOmg5Ph4gZ0oW8uVWpXteJLp-LNzXDI1pcPhQJI',
  LEADS_TAB: 'LEADS W40',
  SESS_TAB: 'SESSIONS 1:3',
  TZ: 'Asia/Beirut',
  // trial hours, window and the trial trainer come from the settings (Config.gs: hours, windows, trial, STAFF tab)
  get HOURS() { return cfg_().hours.trial; },                      // session start hours, 60 min each
  get CAP() { return cfgTrialStaff_().cap || cfgService_('1:3').cap; },   // the trial trainer's max clients in one hour
  get DAYS_AHEAD() { return cfg_().windows.trialAhead; },          // booking window
  get MIN_HOURS_NOTICE() { return cfg_().windows.trialNoticeH; },  // slot must start at least this many hours from now
  get BLOCKED_DATES() { return cfg_().hours.blocked; },            // holidays (yyyy-MM-dd), SETTINGS key hours.blocked
  // WhatsApp numbers and CallMeBot keys are NOT here any more: Project Settings > Script Properties
  // CALLMEBOT_KEY, WHATSAPP_TO, ROMY_WA, ROMY_KEY (run setupSecrets_help() to see what is missing)
  ALERT_EMAIL: 'majdbouhabib@gmail.com',
  // --- auto confirm (Status = Confirmed) ---
  CLIENTS_ID: '1L9lEzSWrKqDZ5kIvSztsx58Kd_WtGurIQbSb8dn_g84', // Sheet 1 Client Portal
  CLIENTS_TAB: 'CLIENTS',
  PKG_TAB: 'PACKAGES',
  get TRIAL_TYPE() { return cfgTrialType_(); },                    // PACKAGE TYPES row with Trial = Y
  get TRIAL_EXPIRY_DAYS() { return cfg_().windows.trialExpiryDays; },
  get TRAINER_MATCH() { return cfgTrialStaff_().match; }           // trial trainer's Match text (STAFF tab)
};

// SESSIONS 1:3 columns (0 based): B=Date, C=Start, H/J/L = client names, M = Status
var S13 = { DATE: 1, START: 2, NAMES: [7, 9, 11], STATUS: 12 };

// LEADS W40 columns
var LH = ['Lead ID', 'Submitted', 'Name', 'Phone', 'Trained Before', 'What Stopped Her',
          'Why Now', 'Injuries', 'Trial Date', 'Trial Time', 'Booking Type', 'Status',
          'Called', 'Notes', 'Source', 'Client ID', 'Package ID', 'Session ID', 'Email'];
var L = { ID: 0, SUB: 1, NAME: 2, PHONE: 3, TRAINED: 4, STOPPED: 5, WHY: 6, INJ: 7,
          DATE: 8, TIME: 9, TYPE: 10, STATUS: 11, CALLED: 12, NOTES: 13, SRC: 14,
          CID: 15, PKG: 16, SID: 17, EMAIL: 18 };
var STATUSES = ['No Booking', 'Pending', 'Confirmed', 'Cancelled', 'No Answer'];

// ---------------------------------------------------------------------
// RUN ONCE: creates the LEADS W40 tab with headers + dropdowns
// ---------------------------------------------------------------------
function setupW40() {
  var ss = SpreadsheetApp.openById(CFG.OPS_ID);
  var sh = ss.getSheetByName(CFG.LEADS_TAB) || ss.insertSheet(CFG.LEADS_TAB);
  sh.getRange(1, 1, 1, LH.length).setValues([LH]).setFontWeight('bold')
    .setBackground('#1f2a2e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  var statusRule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build();
  sh.getRange(2, L.STATUS + 1, 1000, 1).setDataValidation(statusRule);
  var ynRule = SpreadsheetApp.newDataValidation().requireValueInList(['Y', 'N'], true).build();
  sh.getRange(2, L.CALLED + 1, 1000, 1).setDataValidation(ynRule);
  sh.getRange(2, L.PHONE + 1, 1000, 1).setNumberFormat('@');
  sh.getRange(2, L.DATE + 1, 1000, 2).setNumberFormat('@'); // Trial Date + Trial Time stay plain text
  sh.setColumnWidths(1, LH.length, 140);
  sh.setColumnWidths(L.STOPPED + 1, 3, 240);
  sh.getRange(1, L.CID + 1, 1, 3).setBackground('#23735f'); // auto filled, do not type here
  installW40Trigger();
  Logger.log('LEADS W40 ready + auto confirm trigger installed');
}

// RUN to check slot math without the page (look at the log)
function testSlots() {
  Logger.log(JSON.stringify(getSlots_(), null, 1));
}

// RUN to check WhatsApp + email alerts
function testW40Alert() {
  alert_('TEST W40 alert from landing page backend');
  flushNotify_();
}

// RUN ONCE after a new key: lists the Script Properties the alerts need (values are never printed)
function setupSecrets_help() {
  var p = PropertiesService.getScriptProperties();
  var help = {
    CALLMEBOT_KEY: 'CallMeBot API key for Majd\'s WhatsApp (new key from CallMeBot)',
    WHATSAPP_TO: 'Majd\'s WhatsApp number, digits only with country code, e.g. 961xxxxxxxx',
    ROMY_WA: 'Romy\'s WhatsApp number, digits only with country code',
    ROMY_KEY: 'CallMeBot API key for Romy\'s WhatsApp (new key from CallMeBot)'
  };
  Logger.log('Project Settings (gear icon) > Script Properties > Add script property:');
  SECRET_KEYS.forEach(function (k) { Logger.log((p.getProperty(k) ? '[set]     ' : '[MISSING] ') + k + '  =  ' + help[k]); });
  Logger.log('Other properties used: ANTHROPIC_KEY (AI), CL_SECRET (auto), APP_KEYS (auto). APP_VER is no longer used (you can delete it).');
}

// ---------------------------------------------------------------------
// WEB ENDPOINTS
// ---------------------------------------------------------------------
function doGet(e) {
  reqStart_();
  var action = (e && e.parameter && e.parameter.action) || 'slots';
  try {
    if (action === 'slots') return json_(getSlots_());
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  reqStart_();
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (x) { return json_({ ok: false, error: 'bad request' }); }
  if (String(body.action || '').indexOf('app_') === 0) {          // staff app + client app (App.gs, Client.gs)
    try { return app_route_(body); }
    catch (err) { return json_({ ok: false, error: String((err && err.message) || err) }); }
    finally { flushNotify_(); }                                     // WhatsApp / email only after the lock is free
  }
  try {
    if (body.action === 'lead') return json_(saveLead_(body));      // locks only around its own sheet write
    var lock = LockService.getScriptLock();
    lock.waitLock(20000); LOCK_HELD_ = true;
    try {
      if (body.action === 'answers') return json_(saveAnswers_(body));
      if (body.action === 'book') return json_(book_(body));
      return json_({ ok: false, error: 'unknown action' });
    } finally { LOCK_HELD_ = false; try { lock.releaseLock(); } catch (x) {} }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    flushNotify_();
  }
}

// ---------------------------------------------------------------------
// SLOT ENGINE (trial trainer = Joe, see the settings)
// Joe's load per hour = his clients in SESSIONS 1:1 + 1:2 + 1:3 + Pending W40 bookings. Max = his max per hour.
// instant  = bookable: Joe has room and no 1:1 / 1:2 client at that hour
// full     = Joe has 3 clients (any tab) + Pending W40 bookings
// Other trainers' sessions never count against Joe.
// ---------------------------------------------------------------------
function getSlots_() {
  var ss = SpreadsheetApp.openById(CFG.OPS_ID);
  var load = joeLoad_(ss);              // { all: key -> Joe clients any tab, s13: key -> Joe clients in 1:3 }
  var pendCount = countPending_(ss);    // key -> Pending W40 bookings
  var now = new Date();
  var days = [];
  for (var i = 0; i <= CFG.DAYS_AHEAD; i++) {
    var d = new Date(now.getTime() + i * 86400000);
    var ymd = Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
    var dow = Number(Utilities.formatDate(d, CFG.TZ, 'u')); // 1=Mon ... 7=Sun
    if (cfg_().hours.trialDays.indexOf(dow) < 0 || CFG.BLOCKED_DATES.indexOf(ymd) > -1) continue;
    var slots = [];
    CFG.HOURS.forEach(function (h) {
      var start = beirutDate_(ymd, h);
      if (start.getTime() - now.getTime() < CFG.MIN_HOURS_NOTICE * 3600000) return;
      var key = ymd + '|' + h;
      var taken = (load.all[key] || 0) + (pendCount[key] || 0);
      var left = Math.max(0, CFG.CAP - taken);
      // no spot counts are sent to the page, only the label
      slots.push({
        hour: h,
        type: (left === 0 || ((load.all[key] || 0) - (load.s13[key] || 0)) > 0) ? 'full' : 'instant'
      });
    });
    if (slots.length) days.push({ date: ymd, dow: dow, slots: slots });
  }
  return { ok: true, days: days, cap: CFG.CAP };
}

// one trainer's booked clients per date|hour across 1:1, 1:2 and 1:3 (match = text in the Trainer cell)
// columns come from AT (App.gs), 0 based here
function trainerLoad_(ss, match) {
  var out = { all: {}, s13: {} };
  var tz = ss.getSpreadsheetTimeZone();
  ['1:1', '1:2', '1:3'].forEach(function (k) {
    var cfg = AT[k], names = cfg.slots.map(function (sl) { return sl.name - 1; }), status = cfg.status - 1, tcol = cfg.trainer - 1;
    var sh = ss.getSheetByName(cfg.sheet);
    if (!sh || sh.getLastRow() < 2) return;
    var rng = sh.getRange(1, 1, sh.getLastRow(), status + 1);
    var vals = rng.getValues(), disp = rng.getDisplayValues();
    for (var r = 1; r < vals.length; r++) {
      if (!match || String(vals[r][tcol] || '').toLowerCase().indexOf(match) < 0) continue;
      var ymd = toYmd_(vals[r][1], disp[r][1], tz);
      var h = toHour_(disp[r][2]);
      if (!ymd || h === null) continue;
      if (String(vals[r][status] || '').toLowerCase().indexOf('cancel') > -1) continue;
      var n = 0;
      names.forEach(function (c) { if (String(vals[r][c] || '').trim()) n++; });
      if (!n) continue;
      var key = ymd + '|' + h;
      out.all[key] = (out.all[key] || 0) + n;
      if (cfg.sheet === CFG.SESS_TAB) out.s13[key] = (out.s13[key] || 0) + n;
    }
  });
  return out;
}
// the trial trainer's load (Joe)
function joeLoad_(ss) { return trainerLoad_(ss, CFG.TRAINER_MATCH); }

function countPending_(ss) {
  var out = {};
  var sh = ss.getSheetByName(CFG.LEADS_TAB);
  if (!sh || sh.getLastRow() < 2) return out;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, LH.length).getDisplayValues();
  vals.forEach(function (row) {
    if (row[L.STATUS] !== 'Pending') return;
    var h = toHour_(row[L.TIME]);
    if (!row[L.DATE] || h === null) return;
    var key = row[L.DATE] + '|' + h;
    out[key] = (out[key] || 0) + 1;
  });
  return out;
}

// ---------------------------------------------------------------------
// LEAD + BOOKING
// ---------------------------------------------------------------------
function saveLead_(b) {
  var name = clean_(b.name, 80), phone = clean_(b.phone, 30), email = String(b.email || '').trim().toLowerCase();
  if (!name || phoneKey_(phone).length < 7) return { ok: false, error: 'Please enter your name and a valid phone number.' };
  if (email && !emailOk_(email)) return { ok: false, error: 'Please check your email.' };
  // the lock is held only for the sheet read + write; the alert goes out after (flushNotify_)
  var lock = null;
  if (!LOCK_HELD_) { lock = LockService.getScriptLock(); lock.waitLock(20000); LOCK_HELD_ = true; }
  try {
    return saveLeadRow_(b, name, phone, email);
  } finally {
    if (lock) { LOCK_HELD_ = false; try { lock.releaseLock(); } catch (x) {} }
  }
}
function saveLeadRow_(b, name, phone, email) {
  var sh = leadsSheet_();
  var existing = findByPhone_(sh, phone, name, email);
  if (existing) {
    return { ok: true, leadId: existing.id, booked: existing.status === 'Pending' || existing.status === 'Confirmed',
             date: existing.date, time: existing.time, type: existing.type };
  }
  var id = 'W40-' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMdd') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  var row = new Array(LH.length).fill('');
  row[L.ID] = id;
  row[L.SUB] = new Date();
  row[L.NAME] = name;
  row[L.PHONE] = phone;
  row[L.TRAINED] = clean_(b.trained, 120);
  row[L.STOPPED] = clean_(b.stopped, 400);
  row[L.WHY] = clean_(b.why, 400);
  row[L.INJ] = clean_(b.injuries, 400);
  row[L.STATUS] = 'No Booking';
  row[L.CALLED] = 'N';
  row[L.SRC] = clean_(b.source, 200);
  row[L.EMAIL] = email;
  var r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  sh.getRange(r, L.PHONE + 1).setNumberFormat('@');
  sh.getRange(r, L.DATE + 1, 1, 2).setNumberFormat('@');    // Trial Date + Trial Time stay plain text
  sh.getRange(r, 1, 1, LH.length).setValues([row]);
  alert_('NEW W40 LEAD\n' + name + '\n' + phone + '\n' + email + (/by=/.test(row[L.SRC]) ? '\nInvited by a friend' : '') + '\n(answers + booking may follow, call if nothing within 15 min)');
  return { ok: true, leadId: id, booked: false };
}
// same phone = same person only when the emails match, or (one has no email) the names match
function leadSame_(ex, name, email) {
  var oe = String(ex.email || '').trim().toLowerCase(), ne = String(email || '').trim().toLowerCase();
  if (oe && ne) return oe === ne;
  return String(ex.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase();
}

// screen 2 to 5 of the page: the 4 questions, saved onto the lead row
function saveAnswers_(b) {
  var sh = leadsSheet_();
  var ids = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues();
  for (var i = 1; i < ids.length; i++) {
    if (ids[i][0] === b.leadId) {
      sh.getRange(i + 1, L.TRAINED + 1, 1, 4).setValues([[clean_(b.trained, 120), clean_(b.stopped, 400),
                                                          clean_(b.why, 400), clean_(b.injuries, 400)]]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'We could not find your details. Please start again.' };
}

function book_(b) {
  var sh = leadsSheet_();
  var data = sh.getRange(1, 1, sh.getLastRow(), LH.length).getDisplayValues();
  var r = -1;
  for (var i = 1; i < data.length; i++) if (data[i][L.ID] === b.leadId) { r = i; break; }
  if (r < 0) return { ok: false, error: 'We could not find your details. Please submit the form again.' };
  var st = data[r][L.STATUS];
  if (st === 'Pending' || st === 'Confirmed') {
    return { ok: false, already: true, error: 'You already have a trial booked: ' + data[r][L.DATE] + ' at ' + hourLabel_(toHour_(data[r][L.TIME])) + '.' };
  }
  var h = Number(b.hour);
  var res = getSlots_();
  var slot = null;
  res.days.forEach(function (d) {
    if (d.date === b.date) d.slots.forEach(function (s) { if (s.hour === h) slot = s; });
  });
  if (!slot) return { ok: false, error: 'That time is no longer available. Please pick another.' };
  if (slot.type === 'full') return { ok: false, full: true, error: 'That session just filled up. Please pick another time.' };
  var type = 'Instant';
  var rowNum = r + 1;
  sh.getRange(rowNum, L.DATE + 1, 1, 2).setNumberFormat('@');   // plain text, never a Sheets date
  sh.getRange(rowNum, L.DATE + 1, 1, 4).setValues([[String(b.date), hourLabel_(h), type, 'Pending']]);
  alert_('W40 TRIAL BOOKED (' + type.toUpperCase() + ')\n' + data[r][L.NAME] + '\n' + data[r][L.PHONE] +
         '\n' + b.date + ' at ' + hourLabel_(h) +
         '\nTrained: ' + data[r][L.TRAINED] + '\nStopped: ' + data[r][L.STOPPED] +
         '\nWhy now: ' + data[r][L.WHY] + '\nInjuries: ' + data[r][L.INJ] +
         '\nWhatsApp her within 24h, then set Status = Confirmed (auto adds her to SESSIONS 1:3).');
  return { ok: true, type: slot.type === 'instant' ? 'Instant' : 'Request', date: b.date, hour: h };
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function leadsSheet_() {
  var ss = SpreadsheetApp.openById(CFG.OPS_ID);
  var sh = ss.getSheetByName(CFG.LEADS_TAB);
  if (!sh) { setupW40(); sh = ss.getSheetByName(CFG.LEADS_TAB); }
  return sh;
}

// latest lead with this phone; with name/email given, only a lead of the same person (leadSame_)
function findByPhone_(sh, phone, name, email) {
  if (sh.getLastRow() < 2) return null;
  var key = phoneKey_(phone), check = name !== undefined;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, LH.length).getDisplayValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (phoneKey_(vals[i][L.PHONE]) === key && (!check || leadSame_({ name: vals[i][L.NAME], email: vals[i][L.EMAIL] }, name, email))) {
      return { id: vals[i][L.ID], status: vals[i][L.STATUS], date: vals[i][L.DATE], time: vals[i][L.TIME], type: vals[i][L.TYPE], name: vals[i][L.NAME], email: vals[i][L.EMAIL] };
    }
  }
  return null;
}

function phoneKey_(p) {
  var d = String(p || '').replace(/\D/g, '');
  d = d.replace(/^00/, '').replace(/^961/, '').replace(/^0/, ''); // +961 3.. = 03.. = 3..
  return d;
}

function toYmd_(v, disp, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var m = String(disp || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/MM/yyyy
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return null;
}

function toHour_(s) {
  var m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  var h = Number(m[1]);
  var ap = (m[3] || '').toLowerCase();
  if (ap.charAt(0) === 'p' && h < 12) h += 12;
  if (ap.charAt(0) === 'a' && h === 12) h = 0;
  return h;
}

function hourLabel_(h) {
  if (h === null || h === undefined) return '';
  var ap = h < 12 ? 'AM' : 'PM';
  var hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ':00 ' + ap;
}

function beirutDate_(ymd, h) {
  var off = Utilities.formatDate(new Date(ymd + 'T12:00:00Z'), CFG.TZ, 'XXX'); // +02:00 / +03:00
  return new Date(ymd + 'T' + ('0' + h).slice(-2) + ':00:00' + off);
}

function clean_(v, max) {
  var s = String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  if (/^[=+\-@]/.test(s)) s = "'" + s; // block formula injection
  return s.slice(0, max || 200);
}
// any text going into a cell (user text, AI text): a leading = + - @ is kept as plain text
function cellSafe_(v) {
  var s = String(v === undefined || v === null ? '' : v);
  return /^\s*[=+\-@]/.test(s) ? "'" + s : s;
}
// one strict email check for the whole project (landing page, client app, staff app)
function emailOk_(e) {
  e = String(e || '').trim().toLowerCase();
  if (!e || e.length > 120 || /^[=+\-@]/.test(e) || e.indexOf('..') > -1) return false;
  return /^[a-z0-9](?:[a-z0-9._%+\-]*[a-z0-9_\-])?@[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,24}$/.test(e);
}
// next ID in column A: highest number + 1 (same rule as scanIds_, also works on an empty tab). Call it under the lock.
function nextId_(sh, prefix, pad) {
  var n = sh.getLastRow(), max = 0, re = new RegExp('^' + prefix.replace(/[\-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '(\\d+)$', 'i');
  if (n > 0) sh.getRange(1, 1, n, 1).getDisplayValues().forEach(function (r) { var m = re.exec(String(r[0]).trim()); if (m && Number(m[1]) > max) max = Number(m[1]); });
  return prefix + String(max + 1).padStart(pad || 4, '0');
}

// ---------------------------------------------------------------------
// ALERTS: queued during the request, sent by flushNotify_() AFTER the script lock is released
// (a slow WhatsApp or email never blocks the other users)
// ---------------------------------------------------------------------
var SECRET_KEYS = ['CALLMEBOT_KEY', 'WHATSAPP_TO', 'ROMY_WA', 'ROMY_KEY'];
var NOTIFY_Q = [];
var LOCK_HELD_ = false;   // true while this request holds the script lock

// ---------------------------------------------------------------------
// SPEED (Phase 4)
// Lock free reads: a read only answer (game screen, workout, nutrition answers) is first built
// WITHOUT the script lock, so nobody waits in line behind a write. RO_ is true during that try.
// Any sheet write on such a path calls roGuard_() first: the lock free try stops there and the
// router runs the same action again, under the lock, exactly like before.
// ---------------------------------------------------------------------
var RO_ = false;
var REQ_MEMO_ = {};                          // per request: Script Properties and versions read once
function reqStart_() { REQ_MEMO_ = {}; }
function roGuard_() { if (RO_) { var e = new Error('needs the lock'); e.needLock = true; throw e; } }
// { v: answer } when it worked without the lock, null when it has to write (run it again under the lock)
function roTry_(fn) {
  RO_ = true;
  try { return { v: fn() }; }
  catch (e) { if (e && e.needLock) return null; throw e; }
  finally { RO_ = false; }
}
// Script Properties have a daily quota: the ones read on every request are kept in the cache too.
// propSet_ updates the cache at once, so a change (sign everybody out, new staff key) is seen everywhere.
var PROP_HOT_ = { CL_SECRET: 1, APP_KEYS: 1, CL_DELETED: 1 };
var PROP_NONE_ = '\u0001none';
function propGet_(k) {
  var mk = 'p|' + k;
  if (mk in REQ_MEMO_) return REQ_MEMO_[mk];
  var v = null, c = null, hit = null;
  if (PROP_HOT_[k]) { try { c = CacheService.getScriptCache(); hit = c.get('prop|' + k); } catch (e) {} }
  if (hit !== null && hit !== undefined) v = hit === PROP_NONE_ ? null : hit;
  else {
    v = PropertiesService.getScriptProperties().getProperty(k);
    // fill the cache only if no writer filled it meanwhile (a sign out / key reset must never be undone by a slow reader)
    if (c) { try { if (c.get('prop|' + k) === null) c.put('prop|' + k, v === null ? PROP_NONE_ : v, 600); } catch (e) {} }
  }
  REQ_MEMO_[mk] = v;
  return v;
}
function propSet_(k, v) {
  var p = PropertiesService.getScriptProperties();
  if (v === null || v === undefined) p.deleteProperty(k); else p.setProperty(k, String(v));
  REQ_MEMO_['p|' + k] = v === undefined ? null : (v === null ? null : String(v));
  if (PROP_HOT_[k]) { try { CacheService.getScriptCache().put('prop|' + k, v === null || v === undefined ? PROP_NONE_ : String(v), 600); } catch (e) {} }
}
// Cache versions: a cached answer is stored under its versions; changing a version makes every
// answer that depends on it reload, without touching the others.
//   S        every staff screen        C        every client / guest screen
//   c|C012   the screens of the people who can see client C012
// Versions live in the cache only (no Properties quota). A lost version gets a brand new value,
// so an old cached answer can never come back.
function verNew_() { return String(Date.now()) + Math.floor(Math.random() * 1e6); }
function verGet_(names) {
  var out = {}, need = [];
  names.forEach(function (n) { if (('v|' + n) in REQ_MEMO_) out[n] = REQ_MEMO_['v|' + n]; else need.push(n); });
  if (need.length) {
    var c = CacheService.getScriptCache(), got = {}, put = {};
    try { got = c.getAll(need.map(function (n) { return 'ver|' + n; })) || {}; } catch (e) {}
    need.forEach(function (n) { var v = got['ver|' + n]; if (!v) { v = verNew_(); put['ver|' + n] = v; } out[n] = v; REQ_MEMO_['v|' + n] = v; });
    if (Object.keys(put).length) { try { c.putAll(put, 21600); } catch (e) {} }
  }
  return out;
}
function verBump_(names) {
  if (!names || !names.length) return;
  var put = {};
  names.forEach(function (n) { var v = verNew_(); put['ver|' + n] = v; REQ_MEMO_['v|' + n] = v; });
  try { CacheService.getScriptCache().putAll(put, 21600); } catch (e) { Logger.log('verBump_: ' + e); }
}
// big values (over 100 KB) in the cache, split in pieces
function cacheGetBig_(key) {
  try {
    var c = CacheService.getScriptCache(), head = c.get(key); if (!head) return null;
    var n = Number(head), keys = []; for (var i = 0; i < n; i++) keys.push(key + '|' + i);
    var parts = c.getAll(keys), txt = '';
    for (var j = 0; j < n; j++) { if (!parts[keys[j]]) return null; txt += parts[keys[j]]; }
    return JSON.parse(txt);
  } catch (e) { return null; }
}
function cachePutBig_(key, obj, ttl) {
  try {
    var str = JSON.stringify(obj), size = 30000, chunks = {}, n = 0;   // 30,000 characters stay under 100 KB even in Arabic
    for (var k = 0; k < str.length; k += size) chunks[key + '|' + (n++)] = str.slice(k, k + size);
    var c = CacheService.getScriptCache(); c.putAll(chunks, ttl); c.put(key, String(n), ttl);
  } catch (e) { Logger.log('cache skip: ' + e); }
}
function secret_(k) { var v = PropertiesService.getScriptProperties().getProperty(k); return v ? String(v).trim() : ''; }
// to: 'all' = Majd WhatsApp + Romy WhatsApp + email (default) · 'romy' = Romy WhatsApp only
function notifyLater_(msg, to) { NOTIFY_Q.push({ msg: String(msg || ''), to: to || 'all' }); }
function flushNotify_() {
  var q = NOTIFY_Q; NOTIFY_Q = [];
  q.forEach(function (n) {
    if (n.to === 'romy') { waSend_(secret_('ROMY_WA'), secret_('ROMY_KEY'), n.msg, 'Romy (ROMY_WA, ROMY_KEY)'); return; }
    waSend_(secret_('WHATSAPP_TO'), secret_('CALLMEBOT_KEY'), n.msg, 'Majd (WHATSAPP_TO, CALLMEBOT_KEY)');
    waSend_(secret_('ROMY_WA'), secret_('ROMY_KEY'), n.msg, 'Romy (ROMY_WA, ROMY_KEY)');
    try { MailApp.sendEmail(CFG.ALERT_EMAIL, n.msg.split('\n')[0], n.msg); } catch (e) { Logger.log('Email failed: ' + e); }
  });
}
function waSend_(phone, key, msg, who) {
  if (!phone || !key) { Logger.log('WARNING: WhatsApp to ' + who + ' not sent, Script Properties missing. Run setupSecrets_help().'); return; }
  try {
    UrlFetchApp.fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(phone) +
      '&text=' + encodeURIComponent(msg) + '&apikey=' + encodeURIComponent(key), { muteHttpExceptions: true });
  } catch (e) { Logger.log('WhatsApp failed: ' + e); }
}
function alert_(msg) { notifyLater_(msg, 'all'); }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// AUTO CONFIRM
// Romy sets Status = Confirmed in LEADS W40  ->
//   1. client found (by phone, then name) or created in Sheet 1 CLIENTS
//   2. PACKAGES row: "Trial Session - 1:3 (Free)", 1 pass, $0
//   3. SESSIONS 1:3: joins the open session at that date/hour, or creates a new row (Joe, Scheduled)
//   4. Client ID / Package ID / Session ID written back to the lead row
// The CRM calendar scanner then creates the calendar event as usual.
// =====================================================================

function installW40Trigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'w40_onEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('w40_onEdit').forSpreadsheet(CFG.OPS_ID).onEdit().create();
}

function w40_onEdit(e) {
  var rng = e && e.range;
  if (!rng || rng.getSheet().getName() !== CFG.LEADS_TAB) return;
  var col = L.STATUS + 1;
  if (col < rng.getColumn() || col > rng.getLastColumn()) return;
  for (var r = rng.getRow(); r <= rng.getLastRow(); r++) {
    if (r < 2) continue;
    if (String(rng.getSheet().getRange(r, col).getValue()) === 'Confirmed') w40_confirmRow(r);
  }
}

// Can also be run by hand: w40_confirmRow(5) confirms lead on sheet row 5
function w40_confirmRow(rowNum) {
  var lock = LockService.getScriptLock(), had = LOCK_HELD_;
  if (!had) { lock.waitLock(30000); LOCK_HELD_ = true; }
  try { w40_confirmRowLocked_(rowNum); }
  finally {
    if (!had) { LOCK_HELD_ = false; try { lock.releaseLock(); } catch (x) {} flushNotify_(); }
  }
}
function w40_confirmRowLocked_(rowNum) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  var lsh = ops.getSheetByName(CFG.LEADS_TAB);
  var lead = lsh.getRange(rowNum, 1, 1, LH.length).getDisplayValues()[0];
  try {
    if (lead[L.PKG]) return; // already done, never duplicate
    var ymd = parseYmd_(lead[L.DATE]);
    var h = toHour_(lead[L.TIME]);
    if (!ymd || h === null) throw new Error('Fill Trial Date (yyyy-MM-dd) and Trial Time (e.g. 8:00 AM) first');
    var name = lead[L.NAME].trim(), phone = lead[L.PHONE].trim();

    var plan = planSession13_(ops, ymd, h);          // checks capacity BEFORE creating anything
    var client = getOrCreateClient_(name, phone, lead[L.EMAIL]);
    var pkgId = createTrialPackage_(ops, client, ymd, name);
    var sessId = commitSession13_(ops, plan, ymd, h, pkgId, name);

    lsh.getRange(rowNum, L.CID + 1, 1, 3).setValues([[client.id, pkgId, sessId]]);
    lsh.getRange(rowNum, L.NOTES + 1).setValue(appendNote_(lead[L.NOTES], 'Auto: ' + sessId + ' ' + ymd + ' ' + hourLabel_(h)));
    alert_('W40 CONFIRMED\n' + name + ' (' + client.id + (client.isNew ? ', new client' : '') + ')\n' +
           pkgId + ' in ' + sessId + '\n' + ymd + ' at ' + hourLabel_(h));
  } catch (err) {
    lsh.getRange(rowNum, L.STATUS + 1).setValue('Pending');
    lsh.getRange(rowNum, L.NOTES + 1).setValue(appendNote_(lead[L.NOTES], 'AUTO FAILED: ' + err.message));
    alert_('W40 CONFIRM FAILED for ' + lead[L.NAME] + '\n' + err.message + '\nStatus set back to Pending.');
  }
}

// ---------- 1. CLIENTS (Sheet 1) ----------
function getOrCreateClient_(name, phone, email) {
  var sh = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB);
  var vals = sh.getDataRange().getDisplayValues();
  var key = phoneKey_(phone), lname = name.toLowerCase();
  var byName = null, maxN = 0, pad = 3, lastRow = 1;
  for (var i = 0; i < vals.length; i++) {
    var m = String(vals[i][0]).trim().match(/^C(\d+)$/i);
    if (!m) continue;
    lastRow = i + 1;
    var n = Number(m[1]); if (n > maxN) { maxN = n; pad = m[1].length; }
    if (key && phoneKey_(vals[i][3]) === key) return { id: vals[i][0].trim(), isNew: false };
    if (!byName && String(vals[i][1]).trim().toLowerCase() === lname) byName = vals[i][0].trim();
  }
  if (byName) return { id: byName, isNew: false };
  var id = 'C' + String(maxN + 1).padStart(pad, '0');
  var r = lastRow + 1;
  sh.getRange(r, 4).setNumberFormat('@');
  sh.getRange(r, 1, 1, 2).setValues([[id, name]]);
  sh.getRange(r, 4).setValue(phone);
  if (email) sh.getRange(r, 3).setValue(email); // C = Email, so the calendar invite reaches her
  if (email) { try { CacheService.getScriptCache().remove('clacc|' + String(email).trim().toLowerCase()); } catch (e) {} }   // the client app sees the new client at once
  return { id: id, isNew: true };
}

// ---------- 2. PACKAGES ----------
function createTrialPackage_(ops, client, ymd, name) {
  var sh = ops.getSheetByName(CFG.PKG_TAB);
  var info = scanIds_(sh, 0, /^(PKG-)(\d+)$/i, 'PKG-', 4);
  var pkgId = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  var start = beirutDate_(ymd, 0);
  var exp = new Date(start.getTime() + CFG.TRIAL_EXPIRY_DAYS * 86400000);
  var row = [];
  row[0] = pkgId;            // A Package ID
  row[1] = client.id;        // B Client ID
  row[2] = name;             // C Client Name
  row[3] = CFG.TRIAL_TYPE;   // D Package Type
  row[4] = 1;                // E Total Passes
  row[5] = 0;                // F Used
  row[6] = 1;                // G Remaining
  row[7] = 0;                // H Price per Pass
  row[8] = 0;                // I Package Price
  row[9] = start;            // J Start Date
  row[10] = exp;             // K Default Expiry
  row[11] = '';              // L Extended Expiry
  row[12] = exp;             // M Effective Expiry
  row[13] = 'Active';        // N Status
  row[14] = '';              // O Unused Pass Disposition
  row[15] = 'N';             // P New Client? Always N: Romy's bonus is on the first PAID package (2+ sessions)
  row[16] = ''; row[17] = ''; row[18] = ''; // Q R S alert flags
  row[19] = 0;               // T Discount %
  row[20] = 'W40 landing page trial'; // U Notes
  row[21] = 0;               // V Amount Paid
  row[22] = 0;               // W Remaining Amount
  return writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, pkgId);
}

// ---------- 3. SESSIONS 1:3 ----------
// finds where she goes: an open session with a free pair, or a new row. Throws if the hour is full.
function planSession13_(ops, ymd, h) {
  var sh = ops.getSheetByName(CFG.SESS_TAB);
  var rng = sh.getDataRange();
  var vals = rng.getValues(), disp = rng.getDisplayValues();
  var tz = ops.getSpreadsheetTimeZone();
  var PAIRS = AT['1:3'].slots.map(function (sl) { return [sl.pkg - 1, sl.name - 1]; }); // G/H, I/J, K/L
  var isJoe = function (v) { return String(v || '').toLowerCase().indexOf(CFG.TRAINER_MATCH) > -1; };

  // hard cap: Joe never above 3 clients in one hour, across 1:1, 1:2 and 1:3
  var key = ymd + '|' + h;
  var joeNow = joeLoad_(ops).all[key] || 0;
  if (joeNow >= CFG.CAP) throw new Error(cfgTrialStaff_().trainer + ' already has ' + joeNow + ' clients on ' + ymd + ' at ' + hourLabel_(h));

  var trainer = '', room = '';
  for (var i = vals.length - 1; i >= 0; i--) {
    if (isJoe(vals[i][4])) { trainer = String(vals[i][4]); room = vals[i][5]; break; }
  }
  // join Joe's open 1:3 at that hour
  for (var r = 0; r < vals.length; r++) {
    if (!isJoe(vals[r][4])) continue;
    if (toYmd_(vals[r][1], disp[r][1], tz) !== ymd || toHour_(disp[r][2]) !== h) continue;
    if (String(vals[r][12] || '').toLowerCase().indexOf('cancel') > -1) continue;
    for (var p = 0; p < PAIRS.length; p++) {
      if (!String(vals[r][PAIRS[p][0]]).trim() && !String(vals[r][PAIRS[p][1]]).trim()) {
        return { mode: 'join', row: r + 1, col: PAIRS[p][0] + 1, sessId: String(vals[r][0]) };
      }
    }
  }
  if (!trainer) throw new Error('No ' + cfgTrialStaff_().trainer + ' row found in SESSIONS 1:3 to copy trainer name from');
  return { mode: 'new', trainer: trainer, room: room };
}

function commitSession13_(ops, plan, ymd, h, pkgId, name) {
  var sh = ops.getSheetByName(CFG.SESS_TAB);
  if (plan.mode === 'join') {
    sh.getRange(plan.row, plan.col, 1, 2).setValues([[pkgId, name]]);
    return plan.sessId;
  }
  var info = scanIds_(sh, 0, /^(S13-)(\d+)$/i, 'S13-', 4);
  var sessId = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  var row = [];
  row[0] = sessId;
  row[1] = beirutDate_(ymd, 0);
  row[2] = h + ':00';
  row[3] = (h + 1) + ':00';
  row[4] = plan.trainer;
  row[5] = plan.room;
  row[6] = pkgId; row[7] = name;
  row[12] = 'Scheduled';
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, sessId);
  return sessId;
}

// ---------- shared helpers ----------
// finds last row with an ID in column `col`, the highest number and its prefix/padding
function scanIds_(sh, col, re, defPrefix, defPad) {
  var vals = sh.getLastRow() > 0 ? sh.getRange(1, col + 1, sh.getLastRow(), 1).getDisplayValues() : [];   // rows after the last filled row hold no ID
  var out = { prefix: defPrefix, pad: defPad, max: 0, lastRow: 0 };
  for (var i = 0; i < vals.length; i++) {
    var m = String(vals[i][0]).trim().match(re);
    if (!m) continue;
    out.lastRow = i + 1;
    var n = Number(m[2]);
    if (n >= out.max) { out.max = n; out.prefix = m[1].toUpperCase(); out.pad = m[2].length; }
  }
  if (!out.lastRow) throw new Error('No existing IDs found in ' + sh.getName() + ', add the first row by hand');
  return out;
}

// writes a row; any column where the template row holds a FORMULA keeps that formula
// (so Remaining, expiry, lookups etc. stay live), formats and dropdowns are copied too
function writeLikeTemplate_(sh, rowNum, tplRow, row, fix, id) {
  if (fix) fix(row);
  var width = Math.max(row.length, sh.getLastColumn());
  if (rowNum > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  var tpl = sh.getRange(tplRow, 1, 1, width);
  var target = sh.getRange(rowNum, 1, 1, width);
  tpl.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  tpl.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  var f = tpl.getFormulasR1C1()[0];
  // same cells as one setValue per cell, but each run of side by side values is written in one call
  var start = -1, run = [];
  var flush = function () { if (run.length) sh.getRange(rowNum, start + 1, 1, run.length).setValues([run]); start = -1; run = []; };
  for (var c = 0; c < width; c++) {
    if (f[c]) { flush(); sh.getRange(rowNum, c + 1).setFormulaR1C1(f[c]); continue; }
    var v = row[c];
    if (v === undefined || v === null || v === '') { flush(); continue; }
    if (start < 0) start = c;
    run.push(v);
  }
  flush();
  return id;
}

function parseYmd_(s) {
  s = String(s || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return null;
}

function appendNote_(old, add) {
  return (old ? old + ' | ' : '') + add;
}
function testRomy() { clPingRomy_('Wellbe test: if you see this, the bot works.'); flushNotify_(); }