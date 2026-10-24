// =====================================================================
// WELLBE STAFF APP BACKEND
// Add as a NEW FILE called "App" in the "Wellbe W40 Backend" project
// (same project as Code.gs: it reuses its helpers and the same /exec URL).
//
// ONE TIME:
//  1. Run appSetup()  -> creates each person's private link (see the log),
//                        the CLIENT NOTES / SESSION NOTES / RECURRING EXPENSES tabs,
//                        and the 21:30 "default Present" trigger.
//  2. Deploy > Manage deployments > Edit > Version: New version > Deploy.
//  3. Send each person their link. Lost phone / person leaves: appResetKey('joe').
// =====================================================================

var APP = {
  CAL_ID: 'wellbe002@gmail.com',
  FILES_FOLDER: 'Wellbe Client Files',
  // the values below come from the settings (Config.gs: center, windows); they are read when used
  get SITE() { return cfg_().center.staffSite; },
  get BACK_DAYS() { return cfg_().windows.staffBack; },          // history loaded for staff (week template uses the last 60 days)
  get OWNER_BACK_DAYS() { return cfg_().windows.ownerBack; },    // all history for the owner's analytics
  get AHEAD_DAYS() { return cfg_().windows.ahead; },
  get TRAINER_SEE_DAYS() { return cfg_().windows.trainerSee; },  // trainers see clients they trained in the last N days, or have booked
  get STAFF() { return cfgStaff_(); }                             // people who can sign in (STAFF tab)
};

// session tabs: 1 based columns
var AT = {
  '1:1':    { sheet: 'SESSIONS 1:1', pre: 'S11', trainer: 5, room: 6, status: 9, note: 11, width: 12,
              slots: [{ pkg: 7, name: 8, pass: 10, gcal: 12 }] },
  '1:2':    { sheet: 'SESSIONS 1:2', pre: 'S12', trainer: 5, room: 6, status: 11, note: 14, width: 16,
              slots: [{ pkg: 7, name: 8, pass: 12, gcal: 15 }, { pkg: 9, name: 10, pass: 13, gcal: 16 }] },
  '1:3':    { sheet: 'SESSIONS 1:3', pre: 'S13', trainer: 5, room: 6, status: 13, note: 17, width: 23,
              slots: [{ pkg: 7, name: 8, pass: 14, gcal: 18, att: 21 }, { pkg: 9, name: 10, pass: 15, gcal: 19, att: 22 }, { pkg: 11, name: 12, pass: 16, gcal: 20, att: 23 }] },
  'PP':     { sheet: 'SESSIONS PHYSIO/PREHAB', pre: 'SPP', svc: 5, room: 6, pay: 9, status: 10, note: 12, width: 13, get fixed() { return cfgFixed_('Physio'); },
              slots: [{ pkg: 7, name: 8, pass: 11, gcal: 13 }] },
  'Osteo':  { sheet: 'SESSIONS OSTEO', pre: 'SOT', room: 5, status: 8, note: 10, width: 11, get fixed() { return cfgFixed_('Osteo'); },
              slots: [{ pkg: 6, name: 7, pass: 9, gcal: 11 }] },
  'Madero': { sheet: 'SESSIONS MADERO', pre: 'SMD', room: 5, status: 8, note: 10, width: 11, get fixed() { return cfgFixed_('Madero'); },
              slots: [{ pkg: 6, name: 7, pass: 9, gcal: 11 }] }
};
// tab headers used in more than one place
var NOTES_HEAD = ['Client ID', 'Client', 'Always show', 'Training program', 'Updated by', 'Updated at', 'Melanie client'];
var FILES_HEAD = ['Client ID', 'Client', 'File', 'Link', 'Type', 'Uploaded by', 'Date'];
var DEDUCTS = { 'Present': 1, 'Done': 1, 'Late Cancel': 1, 'No Show': 1 };

// =====================================================================
// SETUP
// =====================================================================
function appSetup() {
  var keys = appKeys_();
  APP.STAFF.forEach(function (s) { if (!keys[s.id]) keys[s.id] = Utilities.getUuid().replace(/-/g, ''); });
  propSet_('APP_KEYS', JSON.stringify(keys));
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  appTab_(ops, 'CLIENT NOTES', NOTES_HEAD);
  appTab_(ops, 'SESSION NOTES', ['Date', 'Session ID', 'Client ID', 'Client', 'By', 'Note', 'Logged at']);
  appTab_(ops, 'PHYSIO INTAKE', INTAKE_HEAD);
  appTab_(ops, 'CLIENT FILES', FILES_HEAD);
  appFolder_();
  appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
  appTab_(ops, 'RECURRING EXPENSES', ['ID', 'What', 'Category', 'Amount (USD)', 'Every', 'First date', 'End date', 'Active', 'Last logged']);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'appDefaultPresent') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('appDefaultPresent').timeBased().atHour(21).nearMinute(30).everyDays(1).inTimezone(CFG.TZ).create();
  appTagMelanie_();
  appLinks();
}

// Melanie's own clients: anyone with a "PT with Mel" package (others are ticked by hand in CLIENT NOTES, column G)
function appTagMelanie_() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), v = ops.getSheetByName('PACKAGES').getDataRange().getValues(), ids = {};
  for (var i = 2; i < v.length; i++) { var t = cfgType_(String(v[i][3])); if (t ? t.mel : /with mel/i.test(String(v[i][3]))) ids[String(v[i][1]).trim().toUpperCase()] = String(v[i][2]); }
  Object.keys(ids).forEach(function (cid) { if (!appIsMel_(cid)) appFlag_({ cid: cid, name: ids[cid], mel: true }); });
  Logger.log("Melanie's clients ticked: " + Object.keys(ids).map(function (k) { return ids[k] + ' (' + k + ')'; }).join(', '));
}

// prints every private link (send each person only their own)
function appLinks() {
  var keys = appKeys_();
  APP.STAFF.forEach(function (s) { Logger.log(s.name + ' (' + s.role + '): ' + APP.SITE + '#k=' + keys[s.id]); });
}

// kills one person's link and makes a new one, e.g. appResetKey('joe')
function appResetKey(id) {
  var keys = appKeys_(); keys[id] = Utilities.getUuid().replace(/-/g, '');
  propSet_('APP_KEYS', JSON.stringify(keys));
  appLinks();
}

function appKeys_() { try { return JSON.parse(propGet_('APP_KEYS') || '{}'); } catch (e) { return {}; } }
function appTab_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  roGuard_();   // a new tab is a write: never on the lock free path
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

// =====================================================================
// ROUTER (called from doPost in Code.gs for any action starting with app_)
// =====================================================================
function app_route_(b) {
  if (String(b.action).indexOf('app_cl_') === 0) return client_route_(b);
  reqStart_();   // client app (Client.gs)
  try { return appRoute_(b); }
  finally { flushNotify_(); }                                               // WhatsApp / email after the lock is released
}
function appRoute_(b) {
  var me = appWho_(b.key);
  if (!me) return json_({ ok: false, error: 'auth' });
  var staffOnly = { app_change: 1, app_book: 1, app_pay: 1, app_sell: 1, app_lead: 1, app_expense: 1, app_rec_add: 1, app_rec_stop: 1, app_pos: 1, app_week: 1, app_client: 1, app_flag: 1, app_req_done: 1, app_disc: 1, app_freeze: 1, app_cedit: 1, app_ins_set: 1, app_ins_submit: 1, app_ins_paid: 1, app_pkg_price: 1, app_sess_edit: 1, app_sess_remove: 1, app_notify: 1 };
  var ownerOnly = { app_intake: 1, app_upload: 1 };
  if (ownerOnly[b.action] && me.role !== 'owner') return json_({ ok: false, error: 'not allowed' });
  if (staffOnly[b.action] && me.role === 'trainer') return json_({ ok: false, error: 'not allowed' });
  if (b.action === 'app_boot') return json_(appCached_('b|' + me.id, function () {
    return appReadOnly_(function () {
      var d = appTrainerScope_(insBoot_(walletBoot_(appBoot_(me))), me);
      d.notices = noticesFor_(SpreadsheetApp.openById(CFG.OPS_ID), [me.id]);   // unread in-app notices for this person
      return d;
    });
  }));
  if (b.action === 'app_history') { if (me.role !== 'owner') return json_({ ok: false, error: 'not allowed' }); return json_(appCached_('h|' + me.id, function () { return appHistory_(); })); }
  if (b.action === 'app_lead') { var lr = appLead_(b); appBump_(); return json_(lr); } if (b.action === 'app_wo_list' || b.action === 'app_wo_get') { try { var ro = (b.action === 'app_wo_list' ? woList_ : woGet_)(b, me) || {}; ro.ok = true; return json_(ro); } catch (e) { return json_({ ok: false, error: String(e.message || e) }); } }       // has its own lock
  // read only: no waiting for the lock (a write on the way sends it to the locked path below)
  var roFn = { app_nut_list: nutList_, app_nut_get: nutGet_ }[b.action];
  if (roFn) {
    try { var rt = roTry_(function () { return roFn(b, me) || {}; }); if (rt) { rt.v.ok = true; return json_(rt.v); } }
    catch (e) { return json_({ ok: false, error: String(e.message || e) }); }
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000); LOCK_HELD_ = true;
    var fn = {
      app_att: appAtt_, app_change: appChange_, app_book: appBook_, app_pay: walletPay_, app_sell: walletSell_,
      app_notes: appNotes_, app_expense: appExpense_, app_rec_add: appRecAdd_, app_rec_stop: appRecStop_,
      app_pos: appPos_, app_week: appWeek_, app_client: appClient_, app_flag: appFlag_, app_intake: appIntake_, app_upload: appUpload_, app_req_done: appReqDone_, app_disc: appDisc_, app_freeze: appFreeze_, app_cedit: appClientEdit_, app_ins_set: insSet_, app_ins_submit: insSubmit_, app_ins_paid: insPaid_, app_pkg_price: pkgPrice_, app_sess_edit: appSessEdit_, app_sess_remove: appSessRemove_, app_notify: appNotify_
    , app_wo_list: woList_, app_wo_get: woGet_, app_wo_save: woSave_, app_wo_decide: woDecide_, app_wo_log: woLog_, app_wo_ex: woEx_, app_nut_list: nutList_, app_nut_get: nutGet_, app_nut_decide: nutDecide_, app_notice_read: appNoticeRead_ }[b.action];

    if (!fn) return json_({ ok: false, error: 'unknown action' });
    var out = fn(b, me) || {};
    if (/^app_(wo|nut)_/.test(b.action)) { out.ok = true; return json_(out); }                         // no client package or session changed
    if (b.action === 'app_notice_read') { appUnCache_('b|' + me.id); out.ok = true; return json_(out); }  // only this person's boot changes
    if (b.action === 'app_notify') { appBumpClients_(out.cids || []); delete out.cids; out.ok = true; return json_(out); }   // only those clients' screens
    if (b.action === 'app_sess_edit' || b.action === 'app_sess_remove') { appBumpStaff_(); appBumpClients_(out.cids || []); delete out.cids; out.ok = true; return json_(out); }   // staff + the clients of that session
    if (APP_STAFF_ONLY_WRITES_[b.action]) appBumpStaff_();   // nothing a client sees changed
    else if (b.action === 'app_ins_set') { appBumpStaff_(); appBumpClients_([b.cid]); }   // insurance shows on that client's packages only
    else appBump_();   // staff writes that change clients, packages or sessions: every cached boot reloads
    out.ok = true;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    LOCK_HELD_ = false;
    try { lock.releaseLock(); } catch (x) {}
  }
}

// staff writes that change nothing in the client app (client boots keep their cache)
var APP_STAFF_ONLY_WRITES_ = { app_expense: 1, app_rec_add: 1, app_rec_stop: 1, app_notes: 1, app_flag: 1, app_intake: 1, app_upload: 1, app_ins_submit: 1 };
function appWho_(key) {
  if (!key) return null;
  var keys = appKeys_();
  for (var i = 0; i < APP.STAFF.length; i++) if (keys[APP.STAFF[i].id] && keys[APP.STAFF[i].id] === key) return APP.STAFF[i];
  return null;
}

// =====================================================================
// READ: everything the app needs in one call
// =====================================================================
function appBoot_(me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), tz = CFG.TZ;
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var from = appShift_(today, -APP.BACK_DAYS), to = appShift_(today, APP.AHEAD_DAYS);   // older history: app_history, loaded only when the owner opens Numbers

  // packages
  var pkgs = [], pkgById = {};
  pkgsAll_(ops).forEach(function (x) {
    var p = { id: x.id, row: x.row, client: x.cid, name: x.name, type: x.type, total: x.total, used: x.used, price: x.price, paid: x.paid,
      start: x.start, expiry: x.d12 || x.d10, status: x.status };
    p.kind = cfgKind_(p.type);
    pkgs.push(p); pkgById[p.id] = p;
  });
  var frozen = clFrozen_(ops);
  pkgs.forEach(function (p) { if (frozen[p.id]) p.frozen = 1; });
  // 3 / 6 month bundles: same client + same type, 3 or more rows starting within ~6 months
  pkgs.forEach(function (p) {
    if (!/x\/month/.test(p.type) || !p.start) return;
    var n = pkgs.filter(function (q) { return q.client === p.client && q.type === p.type && q.start && Math.abs(appDays_(q.start, p.start)) <= cfg_().offers.bundleDays; }).length;
    if (n >= 3) p.months = 3;
  });

  // clients + notes
  var cv = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB).getDataRange().getDisplayValues();
  var clients = [], cById = {};
  for (var c = 1; c < cv.length; c++) {
    var cid = String(cv[c][0] || '').trim().toUpperCase(); if (!/^C\d+$/.test(cid)) continue;
    var cl = { id: cid, name: cv[c][1], email: cv[c][2], phone: cv[c][3], notes: '', program: '', log: [] };
    clients.push(cl); cById[cid] = cl;
  }
  var nsh = ops.getSheetByName('CLIENT NOTES');
  if (nsh && nsh.getLastRow() > 1) nsh.getRange(2, 1, nsh.getLastRow() - 1, Math.min(8, nsh.getMaxColumns())).getValues().forEach(function (r) {
    var x = cById[String(r[0]).trim().toUpperCase()]; if (x) { x.notes = String(r[2] || ''); x.program = String(r[3] || ''); x.mel = String(r[6]) === 'Y'; x.disc = Number(r[7]) || 0; }
  });
  var goals = clGoalsMap_(ops); clients.forEach(function (x) { if (goals[x.id]) x.goal = goals[x.id]; });
  var lsh = ops.getSheetByName('SESSION NOTES');
  if (lsh && lsh.getLastRow() > 1) lsh.getRange(2, 1, lsh.getLastRow() - 1, 6).getValues().reverse().forEach(function (r) {
    var x = cById[String(r[2]).trim().toUpperCase()]; if (x && x.log.length < 8) x.log.push({ d: appYmd_(r[0]), sid: String(r[1]), by: String(r[4]), t: String(r[5]) });
  });

  // sessions
  var sess = appSessions_(ops, from, to, pkgById);
  sess.forEach(function (s) { s.clients.forEach(function (x) { var p = pkgById[x.pkg]; x.cid = p ? p.client : ''; }); });

  var out = { ok: true, me: { id: me.id, name: me.name, role: me.role, trainer: me.trainer }, today: today,
    types: cfgTypes_().map(function (t) { return { t: t.name, n: t.passes, p: t.price, kind: t.kind }; }), cfg: cfgPublic_('staff', me.role, me.id) };

  if (me.role === 'trainer') {
    // a trainer sees only the clients they trained in the last 60 days or have booked (same rule as workouts)
    var mine = sess.filter(function (s) { return s.trainer === me.trainer; }), seeFrom = appShift_(today, -APP.TRAINER_SEE_DAYS);
    var ids = {}; mine.forEach(function (s) { if (s.status === 'Cancelled' || s.date < seeFrom) return; s.clients.forEach(function (x) { if (x.cid) ids[x.cid] = 1; }); });
    out.sessions = mine;
    out.clients = clients.filter(function (x) { return ids[x.id]; }).map(function (x) { return { id: x.id, name: x.name, phone: '', email: '', notes: x.notes, program: x.program, log: x.log, mel: !!x.mel, goal: x.goal }; });
    out.pkgs = pkgs.filter(function (p) { return ids[p.client]; }).map(function (p) {
      var due = Math.max(0, (p.price || 0) - (p.paid || 0));   // trainers see what the client owes, never the price
      return { id: p.id, client: p.client, name: p.name, type: p.type.replace(/\s*\(\$[^)]*\)/, ''), kind: p.kind, total: p.total, used: p.used, price: due, paid: 0, start: p.start, expiry: p.expiry, status: p.status, months: p.months, frozen: p.frozen };
    });
    // medical info of their own clients (physio intake), so they train them safely
    out.intakes = appRows_(ops, 'PHYSIO INTAKE', 2, INTAKE_HEAD.length).filter(function (r) { return r[1] && ids[String(r[1]).toUpperCase()]; }).map(appIntakeObj_);
    out.leads = []; out.leadFollowups = []; out.expenses = []; out.recurring = []; out.pos = []; out.inventory = [];
    return out;
  }
  out.sessions = sess; out.clients = clients; out.pkgs = pkgs;
  out.leads = appLeads_(ops);
  out.leadFollowups = appLeadFollowups_(ops);   // ad leads that still need a call: 15 min, 24 h, 72 h
  out.requests = clStaffRequests_(ops);     // client app requests waiting for Romy (Client.gs)
  if (me.role === 'owner') {
    out.intakes = appRows_(ops, 'PHYSIO INTAKE', 2, INTAKE_HEAD.length).filter(function (r) { return r[1]; }).map(appIntakeObj_);
    out.files = appRows_(ops, 'CLIENT FILES', 2, 7).filter(function (r) { return r[0]; }).map(function (r) {
      return { cid: String(r[0]).toUpperCase(), name: String(r[2]), url: String(r[3]), type: String(r[4]), by: String(r[5]), date: appYmd_(r[6]) };
    });
  }
  var monthStart = today.slice(0, 8) + '01';
  out.expenses = appRows_(ops, 'EXPENSES', 2, 8).filter(function (r) { return me.role === 'owner' || appYmd_(r[1]) >= appShift_(monthStart, -31); })
    .map(function (r) { return { d: appYmd_(r[1]), what: String(r[2]), cat: String(r[3]), amt: appNum_(r[4]) || 0 }; });
  out.recurring = appRows_(ops, 'RECURRING EXPENSES', 2, 9).filter(function (r) { return r[0] && String(r[7]) !== 'N'; })
    .map(function (r) { return { id: String(r[0]), what: String(r[1]), cat: String(r[2]), amt: appNum_(r[3]) || 0, every: String(r[4]), start: appYmd_(r[5]), end: appYmd_(r[6]), last: appYmd_(r[8]) }; });
  out.inventory = appRows_(ops, 'POS INVENTORY', 2, 11).filter(function (r) { return r[3]; })
    .map(function (r) { return { p: String(r[3]), left: Number(r[8]) || 0, price: appNum_(r[10]) || 0, cost: appNum_(r[5]) || 0 }; });
  out.pos = appRows_(ops, 'POS SALES', 2, 10).filter(function (r) { return r[0] && (me.role === 'owner' || appYmd_(r[1]) >= monthStart); })
    .map(function (r) { return { d: appYmd_(r[1]), p: String(r[2]), to: String(r[3]), qty: Number(r[4]) || 0, price: appNum_(r[5]) || 0, profit: appNum_(r[7]) || 0 }; });
  return out;
}

function appIntakeObj_(r) {
  var d = {}; try { d = JSON.parse(r[INTAKE_HEAD.length - 1] || '{}'); } catch (e) {}
  return { date: appYmd_(r[0]), cid: String(r[1]).toUpperCase(), by: String(r[3]), area: String(r[4]), complaint: String(r[5]), pain: r[6], flags: String(r[7]), dx: String(r[8]), plan: String(r[9]), data: d };
}

// trainers: wallet and insurance only for their own clients, no claims, no member numbers
function appTrainerScope_(d, me) {
  if (!d || me.role !== 'trainer') return d;
  var ids = {}; (d.clients || []).forEach(function (c) { ids[c.id] = 1; });
  if (d.wallet) { var w = {}; Object.keys(d.wallet).forEach(function (k) { if (ids[k]) w[k] = d.wallet[k]; }); d.wallet = w; }
  if (d.ins) d.ins = { clients: (d.ins.clients || []).filter(function (x) { return ids[x.cid]; }).map(function (x) { return { cid: x.cid, name: x.name, insurer: x.insurer }; }), claims: [] };
  return d;
}

// can this trainer see / change this client? trained them in the last 60 days, or booked with them (any session tab)
function appTrainerSees_(ops, me, cid) {
  if (me.role !== 'trainer') return true;
  cid = String(cid || '').toUpperCase(); if (!cid) return false;
  var today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), pc = appPkgCidMap_(ops);
  return appSessions_(ops, appShift_(today, -APP.TRAINER_SEE_DAYS), appShift_(today, APP.AHEAD_DAYS), null).some(function (s) {
    return s.trainer === me.trainer && s.status !== 'Cancelled' && s.clients.some(function (c) { return pc[c.pkg] === cid; });
  });
}
// ---------------------------------------------------------------------
// PACKAGES rows, parsed once. Inside a read only boot (appReadOnly_) the sheet is read one time
// for the whole boot; anywhere else every call reads fresh (writes may have happened).
// ---------------------------------------------------------------------
var READ_MEMO_ = null;
function appReadOnly_(fn) { var was = READ_MEMO_; READ_MEMO_ = {}; try { return fn(); } finally { READ_MEMO_ = was; } }
function pkgsAll_(ops) {
  if (READ_MEMO_ && READ_MEMO_.pkgs) return READ_MEMO_.pkgs;
  var pv = ops.getSheetByName('PACKAGES').getDataRange().getValues(), out = [];
  for (var i = 2; i < pv.length; i++) {
    var r = pv[i], id = String(r[0] || '').trim(); if (!id) continue;
    out.push({ id: id, row: i + 1, cid: String(r[1] || '').trim().toUpperCase(), name: String(r[2] || ''), type: String(r[3] || ''),
      total: Number(r[4]) || 0, used: Number(r[5]) || 0, price: appNum_(r[8]), paid: appNum_(r[21]),
      start: appYmd_(r[9]), d10: appYmd_(r[10]), d11: appYmd_(r[11]), d12: appYmd_(r[12]), status: String(r[13] || ''), disc: Number(r[19]) || 0 });
  }
  if (READ_MEMO_) READ_MEMO_.pkgs = out;
  return out;
}
// where a client package stands today: current | future | past (client app)
function pkgPhase_(p, today) {
  return /cancel/i.test(p.status) ? 'past' : (p.status === 'Active' && p.start > today ? 'future' : (p.status === 'Active' && p.total > 0 && !(p.end && p.end < today && p.used >= p.total) ? 'current' : 'past'));
}
// package ID -> client ID, read fresh (no cache)
function appPkgCidMap_(ops) {
  var sh = ops.getSheetByName('PACKAGES'), n = sh.getLastRow(), out = {};
  if (n < 3) return out;
  sh.getRange(3, 1, n - 2, 2).getValues().forEach(function (r) { if (r[0]) out[String(r[0]).trim()] = String(r[1] || '').trim().toUpperCase(); });
  return out;
}

// ad leads to follow up: No Booking, or Pending (trial asked, not confirmed yet).
// stage = the oldest step passed: 15m, 24h, 72h. They drop off once confirmed or cancelled. Leads older than 30 days are left out.
function appLeadFollowups_(ops) {
  var sh = ops.getSheetByName(CFG.LEADS_TAB); if (!sh || sh.getLastRow() < 2) return [];
  var rng = sh.getRange(2, 1, sh.getLastRow() - 1, LH.length), v = rng.getValues(), d = rng.getDisplayValues(), now = Date.now(), out = [];
  v.forEach(function (r, i) {
    if (!r[L.ID]) return;
    var st = String(r[L.STATUS] || '').trim();
    if (!(st === 'No Booking' || (st === 'Pending' && !String(r[L.PKG] || '').trim()))) return;
    var sub = r[L.SUB] instanceof Date ? r[L.SUB].getTime() : appParseStamp_(d[i][L.SUB]);
    if (!sub) return;
    if ((now - sub) / 60000 > 30 * 1440) return;
    var held = appLeadStart_(sub), min = (now - (held || sub)) / 60000;   // night leads count from the next morning
    var stage = min >= 72 * 60 ? '72h' : (min >= 24 * 60 ? '24h' : (min >= (held ? 0 : 15) ? '15m' : ''));
    if (!stage) return;
    out.push({ id: String(r[L.ID]), row: i + 2, name: String(r[L.NAME] || ''), phone: d[i][L.PHONE], stage: stage, status: st,
      submitted: Utilities.formatDate(new Date(sub), CFG.TZ, 'yyyy-MM-dd HH:mm'), date: parseYmd_(d[i][L.DATE]) || '', time: d[i][L.TIME] });
  });
  return out.sort(function (a, b) { return a.submitted < b.submitted ? -1 : 1; });
}
// a lead that came in during quiet hours (settings leads.quietFrom to leads.quietTo, Beirut) starts at quietTo; 0 = not held
function appLeadStart_(sub) {
  var q = cfg_().leads || {}, from = Number(q.quietFrom), to = Number(q.quietTo);
  if (isNaN(from) || isNaN(to) || from === to) return 0;
  var t = new Date(sub), hm = Utilities.formatDate(t, CFG.TZ, 'HH:mm').split(':'), h = Number(hm[0]) + Number(hm[1]) / 60;
  var quiet = from > to ? (h >= from || h < to) : (h >= from && h < to);
  if (!quiet) return 0;
  var ymd = Utilities.formatDate(t, CFG.TZ, 'yyyy-MM-dd');
  if (from > to && h >= from) ymd = appShift_(ymd, 1);
  return beirutDate_(ymd, to).getTime();
}
function appParseStamp_(s) {
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(s || '').trim());
  if (!m) return 0;
  return beirutDate_(m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2), 0).getTime() + ((Number(m[4]) || 0) * 60 + (Number(m[5]) || 0)) * 60000;
}

// =====================================================================
// NOTICES: in-app messages (NOTICES tab). For = client ID (C012, G0004) or staff id (joe, romy, majd)
// =====================================================================
var NOTICE_HEAD = ['ID', 'Created', 'For', 'Type', 'Text', 'Read'];
function noticeTab_(ops) { return appTab_(ops, 'NOTICES', NOTICE_HEAD); }
// the one way to write a notice. Call it under the script lock (IDs).
function noticeAdd_(ops, forId, type, text) {
  var sh = noticeTab_(ops), id = nextId_(sh, 'NT-', 5);
  sh.appendRow([id, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), String(forId || '').trim(), cellSafe_(String(type || '').slice(0, 60)), cellSafe_(String(text || '').slice(0, 600)), '']);
  return id;
}
// unread notices for these ids (newest first, max 30)
function noticesFor_(ops, ids) {
  var want = {}; (ids || []).forEach(function (x) { want[String(x).trim().toLowerCase()] = 1; });
  var sh = ops.getSheetByName('NOTICES'); if (!sh || sh.getLastRow() < 2) return [];
  var out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, NOTICE_HEAD.length).getDisplayValues().forEach(function (r) {
    if (!r[0] || String(r[5]).trim() || !want[String(r[2]).trim().toLowerCase()]) return;
    out.push({ id: r[0], created: r[1], for: r[2], type: r[3], text: r[4] });
  });
  return out.reverse().slice(0, 30);
}
// marks notices read, only those addressed to one of `owners`
function noticeMarkRead_(ops, ids, owners) {
  var want = {}, own = {}, n = 0; (ids || []).forEach(function (x) { want[String(x)] = 1; }); (owners || []).forEach(function (x) { own[String(x).trim().toLowerCase()] = 1; });
  var sh = ops.getSheetByName('NOTICES'); if (!sh || sh.getLastRow() < 2) return 0;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, NOTICE_HEAD.length).getValues(), now = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');
  for (var i = 0; i < v.length; i++) if (want[String(v[i][0])] && own[String(v[i][2]).trim().toLowerCase()] && !String(v[i][5]).trim()) { sh.getRange(i + 2, 6).setValue(now); n++; }
  return n;
}
// action app_notice_read { ids: [...] }
function appNoticeRead_(b, me) { return { read: noticeMarkRead_(SpreadsheetApp.openById(CFG.OPS_ID), b.ids || [], [me.id]) }; }
// staff ids for a trainer name, plus Romy and Majd
function appStaffFor_(trainer) {
  var out = [];
  APP.STAFF.forEach(function (s) { if (trainer && s.trainer && s.trainer === trainer) out.push(s.id); });
  [cfgDeskId_()].concat(cfgOwnerIds_()).forEach(function (id) { if (id && out.indexOf(id) < 0) out.push(id); });
  return out;
}

// =====================================================================
// SPEED: answers are cached for 2 minutes under their versions (see verGet_ in Code.gs)
//   staff boot and history: S · client and guest boot: C + one version per account on the email
// =====================================================================
function appBump_() { verBump_(['S', 'C']); }                       // packages, sessions, clients changed: every screen reloads
function appBumpStaff_() { verBump_(['S']); }                       // only staff screens (expenses, notes, intake, files, claims)
function appBumpClients_(cids) { verBump_((cids || []).map(function (c) { return 'c|' + String(c).toUpperCase(); })); }   // only the screens that show these clients
// the versions a cached answer depends on
function appDeps_(name, ids) {
  if (/^[bh]\|/.test(name)) return ['S'];
  return ['C'].concat((ids || []).map(function (c) { return 'c|' + String(c).toUpperCase(); }));
}
function appCacheKey_(name, ids) {
  var deps = appDeps_(name, ids), v = verGet_(deps), key = name + '|' + deps.map(function (d) { return v[d]; }).join('.');
  if (key.length > 200) key = 'k|' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key));   // cache keys must stay under 250 characters
  return key;
}
// drops ONE cached answer (e.g. one staff boot) without reloading everybody
function appUnCache_(name, ids) {
  try { CacheService.getScriptCache().remove(appCacheKey_(name, ids)); } catch (e) {}
}
function appCached_(name, build, ids) {
  var key = appCacheKey_(name, ids), hit = cacheGetBig_(key);
  if (hit) { hit.cached = true; return hit; }
  var out = build();
  cachePutBig_(key, out, 120);
  return out;
}
// owner analytics: sessions older than the normal 70 day window
function appHistory_() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var pv = ops.getSheetByName('PACKAGES').getDataRange().getValues(), pk = {};
  for (var i = 2; i < pv.length; i++) if (pv[i][0]) pk[String(pv[i][0]).trim()] = String(pv[i][1] || '').trim().toUpperCase();
  var sess = appSessions_(ops, appShift_(today, -APP.OWNER_BACK_DAYS), appShift_(today, -APP.BACK_DAYS - 1), null);
  sess.forEach(function (s) { s.clients.forEach(function (x) { x.cid = pk[x.pkg] || ''; }); });
  return { ok: true, sessions: sess };
}

function appSessions_(ops, from, to, pkgById) {
  var out = [];
  Object.keys(AT).forEach(function (k) {
    var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet);
    if (!sh || sh.getLastRow() < 3) return;
    var rng = sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width), v = rng.getValues(), d = rng.getDisplayValues();
    for (var i = 0; i < v.length; i++) {
      var r = v[i]; if (!r[0]) continue;
      var date = appYmd_(r[1], d[i][1]); if (!date || date < from || date > to) continue;
      var s = appSessObj_(k, cfg, r, d[i], i + 3, date);
      if (s.clients.length) out.push(s);
    }
  });
  return out;
}

function appSessObj_(k, cfg, r, d, row, date) {
  var rowStatus = String(r[cfg.status - 1] || '').trim();
  var tab = k === 'PP' ? (/prehab/i.test(String(r[cfg.svc - 1])) ? 'Prehab' : 'Physio') : k;
  var s = { id: String(r[0]), ref: k + '|' + row, tab: tab, date: date, start: appHm_(d[2]), end: appHm_(d[3]),
    trainer: cfg.fixed || appTrainer_(r[cfg.trainer - 1]), room: String(r[cfg.room - 1] || ''), status: 'Scheduled',
    pay: k === 'PP' ? String(r[8] || '') : '', clients: [] };
  cfg.slots.forEach(function (sl, i) {
    var pkg = String(r[sl.pkg - 1] || '').trim(); if (!pkg) return;
    var flag = String(r[sl.pass - 1] || '').trim(), att = '';
    if (sl.att) att = String(r[sl.att - 1] || '').trim();
    if (!att) {
      if (k === '1:2') att = app12Att_(String(r[cfg.note - 1] || ''), String(r[sl.name - 1] || ''), flag, rowStatus);   // no flag = not marked, never Present
      else if (rowStatus === 'Done') att = sl.att ? (flag === 'Y' ? 'Present' : '') : 'Present';
      else if (/Cancel|No Show/.test(rowStatus)) att = rowStatus === 'Cancelled' ? 'Early Cancel' : rowStatus;
    }
    s.clients.push({ slot: i, pkg: pkg, name: String(r[sl.name - 1] || ''), att: att, flag: flag, reminded: false, note: '' });
  });
  var allCancel = s.clients.length && s.clients.every(function (x) { return /Cancel/.test(x.att); });
  if (rowStatus === 'Cancelled' || allCancel) s.status = 'Cancelled';
  else if (rowStatus === 'Done' || (k === '1:2' ? s.clients.every(function (x) { return x.att; }) : s.clients.some(function (x) { return x.att; }))) s.status = 'Done';
  return s;
}

// 1:2 attendance of one client: from the pass flag, plus the last mark written in the note
// (Y = Present, unless the note says Late Cancel / No Show for that name) · N = Early Cancel · empty = not marked
function app12Att_(note, name, flag, rowStatus) {
  if (rowStatus === 'Cancelled' || rowStatus === 'Early Cancel' || flag === 'N') return 'Early Cancel';
  if (flag !== 'Y') return '';
  var m = app12Mark_(note, name);
  return m === 'Late Cancel' || m === 'No Show' ? m : 'Present';
}
function app12Mark_(note, name) {
  name = String(name || '').trim(); if (!name) return '';
  var re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': (Present|Late Cancel|No Show|Early Cancel)', 'g'), m, last = '';
  while ((m = re.exec(String(note || '')))) last = m[1];
  return last;
}

function appLeads_(ops) {
  var sh = ops.getSheetByName(CFG.LEADS_TAB); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, LH.length).getDisplayValues(), out = [];
  v.forEach(function (r, i) {
    if (!r[L.ID]) return;
    if (r[L.STATUS] === 'Cancelled' || r[L.STATUS] === 'No Answer') return;
    out.push({ id: r[L.ID], row: i + 2, name: r[L.NAME], phone: r[L.PHONE], date: parseYmd_(r[L.DATE]) || '', time: r[L.TIME], type: r[L.TYPE],
      status: r[L.STATUS], injuries: r[L.INJ] || 'No', why: r[L.WHY], submitted: r[L.SUB] });
  });
  return out;
}

// =====================================================================
// WRITES
// =====================================================================
function appAtt_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), at = appFind_(ops, b.ref, b.id);
  var cfg = AT[at.k];
  if (me.role === 'trainer') {
    var tr = cfg.fixed || appTrainer_(at.sh.getRange(at.row, cfg.trainer).getValue());
    if (tr !== me.trainer) throw new Error('Not your session');
  }
  var pkg = appSetAtt_(at.sh, cfg, at.row, b.i, b.att, me.name);
  appRecount_(ops, pkg);
  return { pkg: pkg, used: appUsed_(ops, pkg) };
}

// att: Present | Late Cancel | No Show | Early Cancel | '' (back to scheduled)
// opt (1:2 early cancel only): { all: staff cancelled the whole pair, ping: WhatsApp Romy }
function appSetAtt_(sh, cfg, row, i, att, by, reason, opt) {
  var sl = cfg.slots[i]; if (!sl) throw new Error('No client in that spot');
  var pkg = String(sh.getRange(row, sl.pkg).getValue()).trim();
  var flag = att ? (DEDUCTS[att] ? 'Y' : 'N') : '';
  if (sl.att) {                                          // 1:3: per client attendance
    sh.getRange(row, sl.att).setValue(att);
    sh.getRange(row, sl.pass).setValue(flag);
    var st = String(sh.getRange(row, cfg.status).getValue());
    if (att && (st === 'Scheduled' || !st)) sh.getRange(row, cfg.status).setValue('Done');
  } else if (cfg.slots.length === 1) {                   // single client tabs: status drives the pass
    sh.getRange(row, cfg.status).setValue(att ? (att === 'Present' ? 'Done' : att) : 'Scheduled');
    sh.getRange(row, sl.pass).setValue(flag);
  } else {                                               // 1:2: one status for the row, one flag per client
    if (att === 'Early Cancel') { app12EarlyCancel_(sh, cfg, row, i, by, reason, opt || {}); return pkg; }   // private pair: the whole session is cancelled
    sh.getRange(row, sl.pass).setValue(flag);
    var nm12 = String(sh.getRange(row, sl.name).getValue()).trim(), note12 = String(sh.getRange(row, cfg.note).getValue() || '');
    // Late Cancel / No Show leave a mark in the note (the pass flag is Y for those too); Present overrides an older mark
    if ((att === 'Late Cancel' || att === 'No Show' || (att === 'Present' && app12Mark_(note12, nm12))) && !reason) {
      note12 = appendNote_(note12, nm12 + ': ' + att + ' via app, ' + by);
      sh.getRange(row, cfg.note).setValue(note12);
    }
    var flags = cfg.slots.map(function (x) { return String(sh.getRange(row, x.pass).getValue()).trim(); });
    var names = cfg.slots.map(function (x) { return String(sh.getRange(row, x.pkg).getValue()).trim() ? String(sh.getRange(row, x.name).getValue()).trim() || '?' : ''; });
    var active = [], marked = []; names.forEach(function (n, k) { if (n) { active.push(k); if (flags[k]) marked.push(k); } });
    var withReason = reason ? appendNote_(note12, nm12 + ': ' + att) : note12;
    var anyPresent = active.some(function (k) { return app12Att_(withReason, names[k], flags[k], '') === 'Present'; });
    // never Done before someone is marked Present (or both are marked): the other client stays Scheduled
    var rowSt = !marked.length ? 'Scheduled' : (active.every(function (k) { return flags[k] === 'N'; }) ? 'Cancelled' : ((marked.length === active.length || anyPresent) ? 'Done' : 'Scheduled'));
    sh.getRange(row, cfg.status).setValue(rowSt);
  }
  if (att === 'Early Cancel' || reason) {
    var nm = String(sh.getRange(row, sl.name).getValue());
    var cur = String(sh.getRange(row, cfg.note).getValue() || '');
    sh.getRange(row, cfg.note).setValue(appendNote_(cur, nm + ': ' + att + (reason ? ' (exception: ' + reason + ')' : '') + ' via app, ' + by));
  }
  return pkg;
}

// 1:2 early cancel (a day or more before) by one client: row Cancelled, both flags N, invites removed, nobody pays.
// The partner and the trainer get an in-app notice, Romy and Majd too; Romy also gets a WhatsApp when opt.ping.
function app12EarlyCancel_(sh, cfg, row, i, by, reason, opt) {
  var r = sh.getRange(row, 1, 1, cfg.width).getValues()[0], d = sh.getRange(row, 1, 1, cfg.width).getDisplayValues()[0];
  var filled = [], pks = [];
  cfg.slots.forEach(function (sl, k) { var p = String(r[sl.pkg - 1] || '').trim(); if (!p) return; filled.push(k); pks.push(p); sh.getRange(row, sl.pass).setValue('N'); });
  sh.getRange(row, cfg.status).setValue('Cancelled');
  appClearEvents_(sh, cfg, row, filled);
  var who = String(r[cfg.slots[i].name - 1] || '').trim(), first = who.split(' ')[0] || 'Your partner';
  var ymd = appYmd_(r[1], d[1]), hm = appHm_(d[2]), trainer = cfg.fixed || appTrainer_(r[cfg.trainer - 1]), when = ymd + ' at ' + hm;
  sh.getRange(row, cfg.note).setValue(appendNote_(String(r[cfg.note - 1] || ''), who + ': Early Cancel, whole 1:2 session cancelled, no pass used' + (reason ? ' (' + reason + ')' : '') + ' via app, ' + by));
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), pc = appPkgCidMap_(ops);
  filled.forEach(function (k) {
    if (k === i && !opt.all) return;                                   // the one who cancelled already knows
    var cid = pc[String(r[cfg.slots[k].pkg - 1]).trim()]; if (!cid) return;
    noticeAdd_(ops, cid, '1:2 cancelled', opt.all
      ? 'Your 1:2 session on ' + when + ' with ' + trainer + ' is cancelled by Wellbe. No pass was used. Message ' + cfgDeskName_() + ' to book another time.'
      : 'Your 1:2 session on ' + when + ' with ' + trainer + ' is cancelled: ' + first + ' cancelled a day or more before. No pass was used. Message ' + cfgDeskName_() + ' to book another time.');
  });
  var names = filled.map(function (k) { return String(r[cfg.slots[k].name - 1] || '').trim(); }).join(' + ');
  var staffTxt = '1:2 ' + names + ' on ' + when + ' with ' + trainer + ' is CANCELLED: ' + (opt.all ? 'cancelled for both by ' + by : who + ' cancelled early (' + by + ')') + '. No pass used. Rebook them if they want.';
  appStaffFor_(trainer).forEach(function (sid) { noticeAdd_(ops, sid, '1:2 cancelled', staffTxt); });
  if (opt.ping) clPingRomy_('Wellbe: ' + staffTxt);
  appRecountList_(ops, pks);
  return pks;
}

function appChange_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), at = appFind_(ops, b.ref, b.id), cfg = AT[at.k], sh = at.sh, row = at.row;
  var filled = cfg.slots.map(function (sl, i) { return String(sh.getRange(row, sl.pkg).getValue()).trim() ? i : -1; }).filter(function (i) { return i > -1; });
  var targets = (b.who === 'all' || filled.length === 1) ? filled : [Number(b.who)];
  var pk = [];
  if (b.what === 'cancel') {
    if (at.k === '1:2' && b.kind === 'Early Cancel') {   // private pair: one early cancel cancels the whole session (once)
      appSetAtt_(sh, cfg, row, targets[0], 'Early Cancel', me.name, b.reason || '', { all: targets.length === filled.length && filled.length > 1, ping: me.id !== cfgDeskId_() });
      return {};
    }
    targets.forEach(function (i) { pk.push(appSetAtt_(sh, cfg, row, i, b.kind, me.name, b.reason || '')); });
    if (targets.length === filled.length && at.k === '1:3' && /cancel/i.test(b.kind)) sh.getRange(row, cfg.status).setValue('Cancelled');
    appRecountList_(ops, pk);
    return {};
  }
  if (b.what === 'trainer') {
    if (!cfg.trainer) throw new Error('This session type has a fixed practitioner');
    appCapCheck_(ops, b.trainer, appYmd_(sh.getRange(row, 2).getValue(), sh.getRange(row, 2).getDisplayValue()), appHm_(sh.getRange(row, 3).getDisplayValue()), filled.length);
    sh.getRange(row, cfg.trainer).setValue(b.trainer);
    appClearEvents_(sh, cfg, row, filled);
    return {};
  }
  if (b.what === 'move') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) || !/^\d{2}:\d{2}$/.test(String(b.time))) throw new Error('Pick a valid day and time');
    var trainer = cfg.fixed || appTrainer_(sh.getRange(row, cfg.trainer).getValue());
    if (targets.length === filled.length) {
      appCapCheck_(ops, trainer, b.date, b.time, filled.length);
      sh.getRange(row, 2).setValue(beirutDate_(b.date, 0)).setNumberFormat('dd/MM/yyyy');
      sh.getRange(row, 3).setValue(b.time + ':00');
      sh.getRange(row, 4).setValue(appEnd_(b.time) + ':00');
      appClearEvents_(sh, cfg, row, filled);
      return {};
    }
    // one client leaves the group for another time: check first, and put them back if the new booking fails
    var i = targets[0], sl = cfg.slots[i];
    if (!sl || filled.indexOf(i) < 0) throw new Error('No client in that spot');
    var pkg = String(sh.getRange(row, sl.pkg).getValue()).trim(), name = String(sh.getRange(row, sl.name).getValue());
    if (!cfg.fixed) appCapCheck_(ops, trainer, b.date, b.time, 1);   // trainer's max per hour
    appKindOk_(ops, at.k, pkg);                                                        // right package for this session type
    appSlotFree_(ops, b.date, b.time, pkg);                                            // not already booked at that time
    var cols = [sl.pkg, sl.name, sl.pass].concat(sl.att ? [sl.att] : []).concat([sl.gcal]);
    var old = cols.map(function (c) { return sh.getRange(row, c).getValue(); });
    cols.forEach(function (c) { sh.getRange(row, c).setValue(''); });
    var res;
    try { res = appBookInto_(ops, at.k, b.date, b.time, trainer, pkg, name, null); }
    catch (e) { cols.forEach(function (c, j) { sh.getRange(row, c).setValue(old[j]); }); throw e; }   // the client keeps the old spot
    appDeleteEvent_(old[old.length - 1]);                                              // old invite removed only after the new spot is booked
    appRecount_(ops, pkg);
    return res;
  }
  throw new Error('Unknown change');
}

function appBook_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  b.name = cellSafe_(clean_(b.name, 80));
  var k = { 'Prehab': 'PP', 'Physio': 'PP' }[b.type] || b.type;
  if (!AT[k]) throw new Error('Unknown session type');
  appPkgDates_(ops, b.pkg, b.date, b.restart);
  return appBookInto_(ops, k, b.date, b.time, b.trainer, b.pkg, b.name, b.type);
}
// package dates follow the client:
// 1) a 3/6 month bundle month starts on its first session (same length after, 30 days)
// 2) a session booked after the end date, with passes still left, moves the end date to that session so no pass is lost
function appPkgDates_(ops, pkgId, ymd, restart) {
  var ps = ops.getSheetByName('PACKAGES'), row = appPkgRow_(ps, pkgId), v = ps.getRange(row, 1, 1, 21).getValues()[0];
  var f = function (d) { return d instanceof Date ? Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd') : ''; };
  var used = Number(v[5]) || 0, total = Number(v[4]) || 0, s0 = f(v[9]), e0 = f(v[12]) || f(v[10]);
  if (restart && used === 0) {
    var len = (v[9] instanceof Date && (v[12] || v[10]) instanceof Date) ? Math.round(((v[12] || v[10]) - v[9]) / 86400000) : 30;
    if (!(len > 0)) len = 30;
    var st = beirutDate_(ymd, 0), ex = beirutDate_(appShift_(ymd, len), 0);
    ps.getRange(row, 10, 1, 2).setValues([[st, ex]]); ps.getRange(row, 13).setValue(ex); ps.getRange(row, 14).setValue('Active');
    ps.getRange(row, 10, 1, 4).setNumberFormat('dd/MM/yyyy');
    return;
  }
  if (e0 && ymd > e0 && used < total) {
    var nx = beirutDate_(ymd, 0);
    ps.getRange(row, 11).setValue(nx); ps.getRange(row, 13).setValue(nx); ps.getRange(row, 14).setValue('Active');
    ps.getRange(row, 11, 1, 3).setNumberFormat('dd/MM/yyyy');
    ps.getRange(row, 21).setValue(String(v[20] || '') + ' · End moved ' + e0 + ' to ' + ymd + ' to finish passes.');
  }
}

// joins an open session (same day, hour, trainer, free spot) or creates a new row
function appBookInto_(ops, k, ymd, hm, trainer, pkg, name, label) {
  var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet);
  if (!pkg) throw new Error('No package for this client: sell one first');
  appKindOk_(ops, k, pkg);
  name = cellSafe_(name);
  if (!cfg.fixed) appCapCheck_(ops, trainer, ymd, hm, 1);
  var last = sh.getLastRow();
  if (last >= 3) {
    var v = sh.getRange(3, 1, last - 2, cfg.width).getValues(), d = sh.getRange(3, 1, last - 2, cfg.width).getDisplayValues();
    for (var i = 0; i < v.length; i++) {
      if (!v[i][0] || appYmd_(v[i][1], d[i][1]) !== ymd || appHm_(d[i][2]) !== hm) continue;
      if (/cancel/i.test(String(v[i][cfg.status - 1]))) continue;
      if (!cfg.fixed && appTrainer_(v[i][cfg.trainer - 1]) !== appTrainer_(trainer)) continue;
      if (cfg.slots.some(function (sl) { return String(v[i][sl.pkg - 1]).trim() === pkg; })) return { id: String(v[i][0]), joined: true };
      for (var s = 0; s < cfg.slots.length; s++) {
        if (String(v[i][cfg.slots[s].pkg - 1]).trim()) continue;
        if (cfg.slots.length === 1) break;
        sh.getRange(i + 3, cfg.slots[s].pkg, 1, 2).setValues([[pkg, name]]);
        return { id: String(v[i][0]), joined: true };
      }
    }
  }
  var info = scanIds_(sh, 0, new RegExp('^(' + cfg.pre + '-)(\\d+)$', 'i'), cfg.pre + '-', 4);
  var id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  var row = [];
  row[0] = id; row[1] = beirutDate_(ymd, 0); row[2] = hm + ':00'; row[3] = appEnd_(hm) + ':00';
  if (cfg.trainer) row[cfg.trainer - 1] = trainer;
  if (cfg.svc) row[cfg.svc - 1] = /physio/i.test(label || '') ? 'Physio - Single Session' : 'Prehab - Package Session';
  if (k === 'PP') row[8] = 'Client Direct';
  row[cfg.room - 1] = cfgRoom_(k);
  row[cfg.slots[0].pkg - 1] = pkg; row[cfg.slots[0].name - 1] = name;
  row[cfg.status - 1] = 'Scheduled';
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, id);
  sh.getRange(info.lastRow + 1, 2).setNumberFormat('dd/MM/yyyy');
  cfg.slots.forEach(function (sl) { sh.getRange(info.lastRow + 1, sl.pass).setValue(''); if (sl.att) sh.getRange(info.lastRow + 1, sl.att).setValue(''); });
  return { id: id, joined: false };
}

// the package must fit the session type (training packages for 1:1 / 1:2 / 1:3, physio for PP, ...)
function appKindOk_(ops, k, pkg) {
  var pkSh = ops.getSheetByName('PACKAGES'), pkKind = cfgKind_(pkSh.getRange(appPkgRow_(pkSh, pkg), 4).getValue()), pkOk = { 'PP': ['Prehab', 'Physio'], 'Osteo': ['Osteo'], 'Madero': ['Madero'] }[k] || ['1:1', '1:2', '1:3'];
  if (pkOk.indexOf(pkKind) < 0) throw new Error('Package ' + pkg + ' is a ' + pkKind + ' package, it cannot be used for a ' + k + ' session. Pick the right package.');
}
// the client (package) is not already in a session at that day and time, on any tab
function appSlotFree_(ops, ymd, hm, pkg) {
  Object.keys(AT).forEach(function (k) {
    var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet); if (!sh || sh.getLastRow() < 3) return;
    var rng = sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width), v = rng.getValues(), d = rng.getDisplayValues();
    for (var i = 0; i < v.length; i++) {
      if (!v[i][0] || appYmd_(v[i][1], d[i][1]) !== ymd || appHm_(d[i][2]) !== hm || /cancel/i.test(String(v[i][cfg.status - 1]))) continue;
      if (cfg.slots.some(function (sl) { return String(v[i][sl.pkg - 1]).trim() === pkg; })) throw new Error('This client already has a session on ' + ymd + ' at ' + hm + '.');
    }
  });
}

function appWeek_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), added = 0, skipped = [];
  (b.items || []).forEach(function (it) {
    var k = { 'Prehab': 'PP', 'Physio': 'PP' }[it.type] || it.type;
    if (!AT[k]) return;
    (it.clients || []).forEach(function (c) {
      try { var r = appBookInto_(ops, k, it.date, it.time, it.trainer, c.pkg, c.name, it.type); if (r) added++; }
      catch (e) { skipped.push(c.name + ' ' + it.date + ' ' + it.time + ': ' + e.message); }
    });
  });
  return { added: added, skipped: skipped };
}

function appPay_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName('PACKAGES'), row = appPkgRow_(sh, b.pkg);
  var amt = Number(b.amount); if (!(amt > 0)) throw new Error('Amount missing');
  var paid = (appNum_(sh.getRange(row, 22).getValue()) || 0) + amt;
  sh.getRange(row, 22).setValue(paid);
  var note = String(sh.getRange(row, 21).getValue() || '');
  sh.getRange(row, 21).setValue(appendNote_(note, '$' + amt + ' ' + (b.method || 'Cash') + ' ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM') + ' (' + me.name + ')' + (b.note ? ': ' + clean_(b.note, 200) : '')));
  return { paid: paid };
}

// sells 1 package, or a 3 / 6 month bundle of a monthly package (one row per month, starting every 30 days)
// b.months: 1 | 3 | 6   b.discount: % on the whole bundle   b.paid: paid now, filled into month 1, then 2, ...
function appSell_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName('PACKAGES');
  var ty = cfgTypes_().filter(function (x) { return x.name === b.type; })[0]; if (!ty) throw new Error('Unknown package type');
  var t = [ty.name, ty.passes, ty.price], valid = cfgValid_(ty);
  var cid = String(b.cid).toUpperCase(), client = appClientInfo_(cid); if (!client) throw new Error('Client not found');
  var months = Math.max(1, Number(b.months) || 1);
  if (months > 1 && !/x\/month/.test(t[0])) throw new Error('3 and 6 months only work with monthly packages');
  var madero = ty.kind === 'Madero';
  if (ty.mel && !appIsMel_(cid)) appFlag_({ cid: cid, name: client.name, mel: true });
  var mine = !madero && appIsMel_(cid);
  var disc = Math.max(0, Math.min(100, Number(b.discount) || 0));
  var total = Math.round(t[2] * months * (1 - disc / 100)); if (b.price !== undefined && b.price !== null && b.price !== '' && Number(b.price) >= 0) { total = Math.round(Number(b.price) * 100) / 100; disc = t[2] * months > 0 ? Math.max(0, Math.round((1 - total / (t[2] * months)) * 10000) / 100) : 0; } var each = Math.round(total / months * 100) / 100;
  var left = Math.min(total, Number(b.paid) || 0);
  var startYmd = b.start || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  // Romy's bonus: first PAID package with more than 1 session, never on Melanie's clients
  var v = sh.getDataRange().getValues(), hadPaid = false;
  for (var i = 2; i < v.length; i++) if (String(v[i][1]).trim().toUpperCase() === cid && Number(v[i][8]) > 0 && Number(v[i][4]) > 1) hadPaid = true;
  var mel = madero || !!ty.mel;
  var melS = cfgStaffByTrainer_(cfgFixed_('Madero')) || { trainer: 'Melanie', pay: {} }, melN = melS.trainer, melCut = (melS.pay || {}).cut;   // Melanie: Madero is all hers
  var ids = [];
  for (var k = 0; k < months; k++) {
    var price = k < months - 1 ? each : Math.round((total - each * (months - 1)) * 100) / 100;
    var paid = Math.min(price, left); left = Math.round((left - paid) * 100) / 100;
    var sYmd = appShift_(startYmd, 30 * k), start = beirutDate_(sYmd, 0), exp = new Date(start.getTime());
    if (valid.months) exp.setMonth(exp.getMonth() + valid.months);
    else exp = beirutDate_(appShift_(sYmd, valid.days), 0);
    var newClient = (k === 0 && !hadPaid && total > 0 && t[1] > 1 && !mel && !mine) ? 'Y' : 'N';
    var info = scanIds_(sh, 0, /^(PKG-)(\d+)$/i, 'PKG-', 4);
    var id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
    var note = (months > 1 ? months + ' month bundle, month ' + (k + 1) + ' of ' + months + '. ' : '') + (madero ? 'Madero (100% ' + melN + '). ' : '') + (mine ? melN + "'s client (center gets $" + melCut + '/pass from ' + melN + '). ' : '') +
      (disc ? disc + '% off. ' : '') + (paid ? '$' + paid + ' ' + (b.method || 'Cash') + ' ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM') : '') + ' (' + me.name + ')';
    var row = [id, cid, client.name, t[0], t[1], 0, t[1], t[1] ? Math.round(price / t[1] * 100) / 100 : 0, price, start, exp, '', exp, 'Active', '', newClient, '', '', '', disc / 100, note, paid, ''];
    writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, id);
    sh.getRange(info.lastRow + 1, 10, 1, 4).setNumberFormat('dd/MM/yyyy');
    var r = info.lastRow + 1;
    if (!sh.getRange(r, 23).getFormula()) sh.getRange(r, 23).setFormula('=IF(I' + r + '="","",IF(V' + r + '="",I' + r + ',I' + r + '-V' + r + '))');
    ids.push(id);
  }
  return { id: ids[0], ids: ids, total: total };
}

function appClient_(b) {
  var name = clean_(b.name, 80), phone = clean_(b.phone, 30);
  if (!name || !phone) throw new Error('Name and phone needed');
  var c = getOrCreateClient_(name, phone, clean_(b.email, 120));
  if (b.mel) appFlag_({ cid: c.id, name: name, mel: true });
  return { id: c.id, isNew: c.isNew };
}

function appNotes_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid).toUpperCase();
  if (me.role === 'trainer' && !appTrainerSees_(ops, me, cid)) throw new Error('This client is not one of yours');
  var sh = appTab_(ops, 'CLIENT NOTES', NOTES_HEAD);
  var now = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var at = ids.indexOf(cid);
  var vals = [[cid, clean_(b.name, 80), cellSafe_(String(b.always || '').slice(0, 500)), cellSafe_(String(b.program || '').slice(0, 2000)), me.name, now]];
  if (at > -1) sh.getRange(at + 2, 1, 1, 6).setValues(vals); else sh.appendRow(vals[0]);
  if (b.note) {
    var ls = appTab_(ops, 'SESSION NOTES', ['Date', 'Session ID', 'Client ID', 'Client', 'By', 'Note', 'Logged at']);
    ls.appendRow([cellSafe_(String(b.date || '').slice(0, 10)), clean_(b.sid, 20), cid, clean_(b.name, 80), me.trainer || me.name, cellSafe_(String(b.note).slice(0, 1000)), now]);
  }
  return {};
}

// =====================================================================
// PHYSIO INTAKE + CLIENT FILES (owner only; files live in a private Drive folder)
// =====================================================================
var INTAKE_HEAD = ['Date', 'Client ID', 'Client', 'By', 'Body area', 'Complaint', 'Pain now (0-10)', 'Red flags', 'Clinical impression', 'Plan', 'Full form (JSON)'];

function appIntake_(b, me) {
  var d = b.data || {}, cid = String(b.cid || '').toUpperCase(), name = clean_(b.name || d.name, 80);
  if (!cid) {
    if (!name || !d.phone) throw new Error('Name and phone needed for a new client');
    cid = getOrCreateClient_(name, clean_(d.phone, 30), clean_(d.email, 120)).id;
  }
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = appTab_(ops, 'PHYSIO INTAKE', INTAKE_HEAD);
  var now = beirutDate_(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), 0);
  sh.appendRow([now, cid, name, me.name, clean_(d.area, 60), cellSafe_(String(d.complaint || '').slice(0, 500)), d.painNow === '' ? '' : Number(d.painNow),
    cellSafe_((d.flags || []).join(', ')), cellSafe_(String(d.dx || '').slice(0, 500)), cellSafe_(String(d.plan || '').slice(0, 500)), JSON.stringify(d).slice(0, 45000)]);
  sh.getRange(sh.getLastRow(), 1).setNumberFormat('dd/MM/yyyy');
  if (b.alert) {   // short warning shown to trainers on every booking
    var ns = appTab_(ops, 'CLIENT NOTES', NOTES_HEAD);
    var ids = ns.getLastRow() > 1 ? ns.getRange(2, 1, ns.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
    var at = ids.indexOf(cid), stamp = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');
    if (at < 0) ns.appendRow([cid, name, cellSafe_(String(b.alert).slice(0, 300)), '', me.name, stamp, '']);
    else { var cur = String(ns.getRange(at + 2, 3).getValue() || ''); ns.getRange(at + 2, 3).setValue(cellSafe_(cur && cur.indexOf(b.alert) < 0 ? cur + ' | ' + b.alert : (cur || b.alert))); ns.getRange(at + 2, 5, 1, 2).setValues([[me.name, stamp]]); }
  }
  return { cid: cid };
}

function appFolder_() {
  var it = DriveApp.getFoldersByName(APP.FILES_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(APP.FILES_FOLDER);
}

function appUpload_(b, me) {
  var cid = String(b.cid || '').toUpperCase(); if (!cid || !b.b64) throw new Error('Nothing to upload');
  var root = appFolder_(), name = clean_(b.cname, 80), sub = cid + ' ' + name, it = root.getFoldersByName(sub);
  var folder = it.hasNext() ? it.next() : root.createFolder(sub);
  var blob = Utilities.newBlob(Utilities.base64Decode(b.b64), b.mime || 'application/octet-stream', clean_(b.name, 120) || 'file');
  var f = folder.createFile(blob);   // private: only the owner's Google account can open it
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = appTab_(ops, 'CLIENT FILES', FILES_HEAD);
  sh.appendRow([cid, name, f.getName(), f.getUrl(), b.mime || '', me.name, beirutDate_(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), 0)]);
  sh.getRange(sh.getLastRow(), 7).setNumberFormat('dd/MM/yyyy');
  return { url: f.getUrl(), name: f.getName() };
}

// marks / unmarks a client as Melanie's own client (CLIENT NOTES column G)
function appFlag_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid).toUpperCase();
  var sh = appTab_(ops, 'CLIENT NOTES', NOTES_HEAD);
  if (sh.getRange(1, 7).getValue() !== 'Melanie client') sh.getRange(1, 7).setValue('Melanie client').setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var at = ids.indexOf(cid);
  if (at < 0) { sh.appendRow([cid, clean_(b.name, 80), '', '', '', '', b.mel ? 'Y' : '']); return {}; }
  sh.getRange(at + 2, 7).setValue(b.mel ? 'Y' : '');
  return {};
}
function appIsMel_(cid) {
  var sh = SpreadsheetApp.openById(CFG.OPS_ID).getSheetByName('CLIENT NOTES');
  if (!sh || sh.getLastRow() < 2) return false;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]).toUpperCase() === cid) return String(v[i][6]) === 'Y';
  return false;
}

function appLead_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName(CFG.LEADS_TAB), row = Number(b.row);
  if (String(sh.getRange(row, L.ID + 1).getValue()) !== String(b.id)) return { ok: false, error: 'Lead moved in the sheet, refresh and try again' };
  if (b.act === 'cancel') {
    sh.getRange(row, L.STATUS + 1).setValue('Cancelled');
    var n0 = String(sh.getRange(row, L.NOTES + 1).getValue() || '');
    sh.getRange(row, L.NOTES + 1).setValue(appendNote_(n0, 'Cancelled in the app ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM HH:mm') + (b.reason ? ': ' + clean_(b.reason, 120) : '')));
    return { ok: true };
  }
  if (b.date && b.time) {
    var h = toHour_(b.time); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) || h === null) return { ok: false, error: 'Pick a valid day and time' };
    var oldD = String(sh.getRange(row, L.DATE + 1).getDisplayValue()), oldT = String(sh.getRange(row, L.TIME + 1).getDisplayValue());
    sh.getRange(row, L.DATE + 1, 1, 2).setNumberFormat('@').setValues([[String(b.date), hourLabel_(h)]]);
    if (oldD !== String(b.date) || oldT !== hourLabel_(h)) sh.getRange(row, L.NOTES + 1).setValue(appendNote_(String(sh.getRange(row, L.NOTES + 1).getValue() || ''), 'Moved by ' + cfgDeskName_() + ' from ' + (oldD || 'no date') + ' ' + oldT + ' to ' + b.date + ' ' + hourLabel_(h)));
  }
  sh.getRange(row, L.STATUS + 1).setValue('Confirmed');
  w40_confirmRow(row);
  var st = String(sh.getRange(row, L.STATUS + 1).getValue()), note = String(sh.getRange(row, L.NOTES + 1).getValue());
  if (st !== 'Confirmed') return { ok: false, error: (note.split('AUTO FAILED: ').pop() || 'Confirm failed') };
  return { ok: true };
}

function appExpense_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName('EXPENSES');
  var amt = Number(b.amt); if (!(amt > 0) || !b.what) throw new Error('What and amount needed');
  var info = scanIds_(sh, 0, /^(EXP-)(\d+)$/i, 'EXP-', 6);
  var id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, [id, beirutDate_(b.d, 0), clean_(b.what, 120), clean_(b.cat, 40), amt, me.name, b.recId ? 'Recurring ' + b.recId : ''], null, id);
  sh.getRange(info.lastRow + 1, 2).setNumberFormat('dd/MM/yyyy');
  if (b.recId) {
    var rs = ops.getSheetByName('RECURRING EXPENSES'), ids = rs.getRange(2, 1, Math.max(1, rs.getLastRow() - 1), 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === b.recId) rs.getRange(i + 2, 9).setValue(b.d);
  }
  return { id: id };
}

function appRecAdd_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  var sh = appTab_(ops, 'RECURRING EXPENSES', ['ID', 'What', 'Category', 'Amount (USD)', 'Every', 'First date', 'End date', 'Active', 'Last logged']);
  var id = nextId_(sh, 'REC-', 3);   // highest + 1: stays unique after a row is deleted
  sh.appendRow([id, clean_(b.what, 120), clean_(b.cat, 40), Number(b.amt) || 0, cellSafe_(String(b.every || '').slice(0, 40)), cellSafe_(String(b.start || '').slice(0, 10)), cellSafe_(String(b.end || '').slice(0, 10)), 'Y', '']);
  return { id: id };
}

function appRecStop_(b) {
  var sh = SpreadsheetApp.openById(CFG.OPS_ID).getSheetByName('RECURRING EXPENSES');
  var ids = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === b.id) sh.getRange(i + 2, 8).setValue('N');
  return {};
}

function appPos_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName('POS SALES'), inv = ops.getSheetByName('POS INVENTORY');
  var qty = Number(b.qty) || 1, each = Number(b.price) || 0;
  var iv = inv.getDataRange().getValues(), cost = 0, invRow = -1;
  for (var i = 1; i < iv.length; i++) if (iv[i][3] === b.product) { cost = Number(iv[i][5]) || 0; invRow = i + 1; break; }
  if (invRow < 0) throw new Error('Product not found');
  var info = scanIds_(sh, 0, /^(POSS-)(\d+)$/i, 'POSS-', 4);
  var id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, [id, beirutDate_(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), 0), b.product, clean_(b.to, 80), qty, each * qty, cost, each * qty - cost * qty, 'Paid', 'via app (' + me.name + ')'], null, id);
  sh.getRange(info.lastRow + 1, 2).setNumberFormat('dd/MM/yyyy');
  // same as s2_recountInventory
  var sv = sh.getDataRange().getValues(), sold = 0;
  for (var j = 1; j < sv.length; j++) if (sv[j][2] === b.product) sold += Number(sv[j][4]) || 0;
  inv.getRange(invRow, 8).setValue(sold);
  inv.getRange(invRow, 9).setValue((Number(iv[invRow - 1][4]) || 0) - sold);
  return { id: id };
}

// standing discount % per client (CLIENT NOTES column H), pre-filled when selling
// edit a client's name, phone, email (Client Portal > CLIENTS columns B, C, D)
function appClientEdit_(b) {
  var cid = String(b.cid || '').toUpperCase(), name = clean_(b.name, 80), phone = clean_(b.phone, 30), email = clean_(b.email, 120).toLowerCase();
  if (!name) throw new Error('Name needed');
  if (email && !emailOk_(email)) throw new Error('This email does not look right');
  var sh = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB), ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues(), row = -1;
  for (var i = 1; i < ids.length; i++) if (String(ids[i][0]).trim().toUpperCase() === cid) { row = i + 1; break; }
  if (row < 0) throw new Error('Client ' + cid + ' not found');
  var old = String(sh.getRange(row, 3).getValue() || '').trim().toLowerCase();
  sh.getRange(row, 4).setNumberFormat('@');
  sh.getRange(row, 2, 1, 3).setValues([[name, email, phone]]);
  var cache = CacheService.getScriptCache(); [old, email].forEach(function (e) { if (e) cache.remove('clacc|' + e); });   // client app sees it right away
  return { id: cid };
}

function appDisc_(b) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid).toUpperCase();
  var sh = appTab_(ops, 'CLIENT NOTES', NOTES_HEAD);
  if (sh.getMaxColumns() < 8) sh.insertColumnsAfter(sh.getMaxColumns(), 8 - sh.getMaxColumns());
  if (sh.getRange(1, 8).getValue() !== 'Discount %') sh.getRange(1, 8).setValue('Discount %').setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  var d = Math.max(0, Math.min(100, Number(b.disc) || 0));
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var at = ids.indexOf(cid);
  if (at < 0) sh.appendRow([cid, clean_(b.name, 80), '', '', '', '', '', d]);
  else sh.getRange(at + 2, 8).setValue(d);
  return { disc: d };
}

// staff freeze: 1 week, once per package (same rule as the client app)
function appFreeze_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), pkg = String(b.pkg);
  if (clFrozen_(ops)[pkg]) throw new Error('This package already had its freeze');
  var from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.from)) ? String(b.from) : Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var end = clFreezeApply_(ops, pkg, from, me.name);
  var ps = ops.getSheetByName('PACKAGES'), pr = appPkgRow_(ps, pkg), cid = String(ps.getRange(pr, 2).getValue()).toUpperCase(), name = String(ps.getRange(pr, 3).getValue());
  var id = clLog_(ops, cid, name, 'Freeze', CL.FREEZE_DAYS + ' days from ' + from + ', new end ' + end + (b.note ? ' · ' + clean_(b.note, 200) : '') + ' (by ' + me.name + ')', from, pkg, 'Done', { from: from },
    { by: me.name, at: Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm') });
  return { end: end, req: id };
}

// =====================================================================
// DEFAULT PRESENT (trigger, 21:30): any session today nobody marked = Present, pass taken
// =====================================================================
function appDefaultPresent() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), pk = {};
  Object.keys(AT).forEach(function (k) {
    var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet); if (!sh || sh.getLastRow() < 3) return;
    var v = sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width).getValues(), d = sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width).getDisplayValues();
    for (var i = 0; i < v.length; i++) {
      if (!v[i][0] || appYmd_(v[i][1], d[i][1]) !== today) continue;
      var st = String(v[i][cfg.status - 1] || '').trim();
      if (/cancel/i.test(st)) continue;
      cfg.slots.forEach(function (sl, s) {
        var pkg = String(v[i][sl.pkg - 1] || '').trim(); if (!pkg) return;
        var open = sl.att ? !String(v[i][sl.att - 1] || '').trim()
          : (cfg.slots.length > 1 ? !String(v[i][sl.pass - 1] || '').trim() : (st === 'Scheduled' || !st));   // 1:2: each client with no flag yet
        if (!open) return;
        appSetAtt_(sh, cfg, i + 3, s, 'Present', 'auto 21:30');
        pk[pkg] = 1;
      });
    }
  });
  appRecountMany_(ops, pk);
  Logger.log('Default Present: ' + Object.keys(pk).length + ' packages updated');
}

// =====================================================================
// HELPERS
// =====================================================================
// same logic as s2_recountPackage in Operations: Used = number of Y flags
function appRecount_(ops, pkgId) {
  if (!pkgId) return;
  var used = 0;
  Object.keys(AT).forEach(function (k) {
    var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet); if (!sh || sh.getLastRow() < 3) return;
    var v = sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width).getValues();
    v.forEach(function (r) { cfg.slots.forEach(function (sl) { if (r[sl.pkg - 1] === pkgId && r[sl.pass - 1] === 'Y') used++; }); });
  });
  var ps = ops.getSheetByName('PACKAGES'), row = appPkgRow_(ps, pkgId);
  var total = parseInt(ps.getRange(row, 5).getValue(), 10) || 0;
  ps.getRange(row, 6).setValue(used);
  ps.getRange(row, 7).setValue(Math.max(0, total - used));
}
function appRecountMany_(ops, ids) { var used = {}; Object.keys(ids).forEach(function (k) { used[k] = 0; }); Object.keys(AT).forEach(function (k) { var cfg = AT[k], sh = ops.getSheetByName(cfg.sheet); if (!sh || sh.getLastRow() < 3) return; sh.getRange(3, 1, sh.getLastRow() - 2, cfg.width).getValues().forEach(function (r) { cfg.slots.forEach(function (sl) { var p = r[sl.pkg - 1]; if (used.hasOwnProperty(p) && r[sl.pass - 1] === 'Y') used[p]++; }); }); }); var ps = ops.getSheetByName('PACKAGES'), v = ps.getRange(1, 1, ps.getLastRow(), 5).getValues(); for (var i = 2; i < v.length; i++) { var id = String(v[i][0]).trim(); if (used.hasOwnProperty(id)) { var total = parseInt(v[i][4], 10) || 0; ps.getRange(i + 1, 6, 1, 2).setValues([[used[id], Math.max(0, total - used[id])]]); } } }
// same result as appRecount_ for each package, but the session tabs are read once for all of them
function appRecountList_(ops, list) {
  var ids = {}, ps = ops.getSheetByName('PACKAGES'), have = {};
  (list || []).forEach(function (p) { if (p) ids[p] = 1; });
  if (!Object.keys(ids).length) return;
  ps.getRange(1, 1, ps.getLastRow(), 1).getValues().forEach(function (r, i) { if (i >= 2) have[String(r[0]).trim()] = 1; });
  var missing = Object.keys(ids).filter(function (p) { return !have[p]; })[0];
  if (missing) throw new Error('Package ' + missing + ' not found');
  appRecountMany_(ops, ids);
}
function appUsed_(ops, pkgId) { var ps = ops.getSheetByName('PACKAGES'); return Number(ps.getRange(appPkgRow_(ps, pkgId), 6).getValue()) || 0; }

function appPkgRow_(sh, id) {
  var v = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 2; i < v.length; i++) if (String(v[i][0]).trim() === id) return i + 1;
  throw new Error('Package ' + id + ' not found');
}

// =====================================================================
// SESSION EDITOR (tap a session in Schedule): room, payment, remove a client, notify clients
// =====================================================================
// client IDs of the filled slots of a session row (from their packages)
function appSessCids_(ops, sh, cfg, row) {
  var byPkg = {}; pkgsAll_(ops).forEach(function (x) { byPkg[x.id] = x.cid; });
  return cfg.slots.map(function (sl) { return byPkg[String(sh.getRange(row, sl.pkg).getValue()).trim()] || ''; }).filter(String);
}
// action app_sess_edit { ref, id, room?, pay? }: room of any session; payment only on physio / prehab (the only tab with a payment column)
function appSessEdit_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), at = appFind_(ops, b.ref, b.id), cfg = AT[at.k], sh = at.sh, row = at.row, log = [];
  if (b.room !== undefined && b.room !== null && b.room !== '') {
    var rooms = {}; Object.keys(cfg_().services || {}).forEach(function (k) { var r = cfg_().services[k].room; if (r) rooms[r] = 1; });
    if (!rooms[b.room]) throw new Error('Unknown room: ' + b.room);
    sh.getRange(row, cfg.room).setValue(b.room); log.push('room ' + b.room);
  }
  if (b.pay !== undefined && b.pay !== null) {
    if (!cfg.pay) throw new Error('This session type has no payment column');
    var ok = appSessPays_(); if (ok.indexOf(String(b.pay)) < 0) throw new Error('Unknown payment: ' + b.pay);
    sh.getRange(row, cfg.pay).setValue(b.pay === 'Not paid' ? 'Not paid' : String(b.pay)); log.push('payment ' + b.pay);
  }
  if (log.length) sh.getRange(row, cfg.note).setValue(appendNote_(String(sh.getRange(row, cfg.note).getValue() || ''), 'Changed ' + log.join(', ') + ' via app, ' + me.name));
  return { cids: appSessCids_(ops, sh, cfg, row) };
}
// payment values allowed for one session: the center's payment methods + Insurance + Not paid
function appSessPays_() { var m = ((cfg_().lists || {}).methods || []).slice(); ['Insurance', 'Not paid'].forEach(function (x) { if (m.indexOf(x) < 0) m.push(x); }); return m; }
// action app_sess_remove { ref, id, slot }: takes one client out of a session (no pass used), removes their invite
function appSessRemove_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), at = appFind_(ops, b.ref, b.id), cfg = AT[at.k], sh = at.sh, row = at.row;
  var i = Number(b.slot), sl = cfg.slots[i]; if (!sl) throw new Error('No client in that spot');
  var pkg = String(sh.getRange(row, sl.pkg).getValue()).trim(), name = String(sh.getRange(row, sl.name).getValue()).trim();
  if (!pkg && !name) throw new Error('No client in that spot');
  var cid = (pkgsAll_(ops).filter(function (x) { return x.id === pkg; })[0] || {}).cid || '';
  appDeleteEvent_(sh.getRange(row, sl.gcal).getValue());
  [sl.pkg, sl.name, sl.pass].concat(sl.att ? [sl.att] : []).concat([sl.gcal]).forEach(function (c) { sh.getRange(row, c).setValue(''); });
  var left = cfg.slots.some(function (s2) { return String(sh.getRange(row, s2.pkg).getValue()).trim() || String(sh.getRange(row, s2.name).getValue()).trim(); });
  if (!left) sh.getRange(row, cfg.status).setValue('Cancelled');
  sh.getRange(row, cfg.note).setValue(appendNote_(String(sh.getRange(row, cfg.note).getValue() || ''), name + ' removed from the session via app, ' + me.name));
  if (pkg) appRecount_(ops, pkg);
  return { pkg: pkg, used: pkg ? appUsed_(ops, pkg) : 0, cancelled: !left, cids: cid ? [cid] : [] };
}
// action app_notify { cids, type, text }: an in-app message to each client (shows in their Center until they tap Got it)
function appNotify_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), text = String(b.text || '').trim().slice(0, 600), type = String(b.type || 'Session update').slice(0, 60), seen = {}, n = 0, ids = [];
  if (!text) throw new Error('Write the message first');
  (b.cids || []).forEach(function (c) { c = String(c || '').trim().toUpperCase(); if (!/^[CG]\d+$/.test(c) || seen[c]) return; seen[c] = 1; noticeAdd_(ops, c, type, text); n++; ids.push(c); });
  if (!n) throw new Error('No client to notify');
  return { sent: n, cids: ids };
}

// finds a session row from "tab|row", double checked with the Session ID
function appFind_(ops, ref, id) {
  var p = String(ref || '').split('|'), k = p[0], cfg = AT[k]; if (!cfg) throw new Error('Bad session');
  var sh = ops.getSheetByName(cfg.sheet), row = Number(p[1]);
  if (String(sh.getRange(row, 1).getValue()) !== String(id)) {
    var v = sh.getRange(1, 1, sh.getLastRow(), 1).getValues(); row = -1;
    for (var i = 0; i < v.length; i++) if (String(v[i][0]) === String(id)) { row = i + 1; break; }
    if (row < 0) throw new Error('Session ' + id + ' not found, refresh');
  }
  return { k: k, sh: sh, row: row };
}

// a trainer with a max per hour (STAFF tab, Joe: 3) never goes above it, across 1:1, 1:2 and 1:3
function appCapCheck_(ops, trainer, ymd, hm, adding) {
  var name = cfgTrainerName_(trainer), cap = cfgCap_(name); if (!cap) return;
  var h = Number(String(hm).split(':')[0]);
  var n = trainerLoad_(ops, cfgStaffByTrainer_(name).match).all[ymd + '|' + h] || 0;
  if (n + adding > cap) throw new Error(name + ' already has ' + n + ' clients at ' + hm + ' on ' + ymd + '. Max is ' + cap + '.');
}

// date / time changed: remove the calendar invites, the Operations scanner sends fresh ones
function appClearEvents_(sh, cfg, row, slots) {
  var cal = null; try { cal = CalendarApp.getCalendarById(APP.CAL_ID); } catch (e) {}
  slots.forEach(function (i) {
    var c = cfg.slots[i].gcal, id = String(sh.getRange(row, c).getValue() || '');
    if (!id) return;
    try { if (cal) { var ev = cal.getEventById(id); if (ev) ev.deleteEvent(); } } catch (e) { Logger.log('event delete failed ' + id); }
    sh.getRange(row, c).setValue('');
  });
}

// deletes one calendar invite by its event id (after a move)
function appDeleteEvent_(id) {
  id = String(id || ''); if (!id) return;
  try { var cal = CalendarApp.getCalendarById(APP.CAL_ID), ev = cal ? cal.getEventById(id) : null; if (ev) ev.deleteEvent(); } catch (e) { Logger.log('event delete failed ' + id); }
}

function appClientInfo_(cid) { if (/^G\d+$/.test(String(cid))) { var gq = guestById_(cid); return gq ? { name: gq.name, phone: gq.phone, email: gq.email } : null; }

  var v = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB).getDataRange().getDisplayValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]).trim().toUpperCase() === cid) return { name: v[i][1], phone: v[i][3], email: v[i][2] };
  return null;
}
function appRows_(ops, name, startRow, width) {
  var sh = ops.getSheetByName(name); if (!sh || sh.getLastRow() < startRow) return [];
  return sh.getRange(startRow, 1, sh.getLastRow() - startRow + 1, width).getValues();
}
function appKind_(t) {
  t = String(t);
  if (/^1:3|trial|- 1:3 \(free\)/i.test(t)) return '1:3';
  if (/^1:2/.test(t)) return '1:2';
  if (/^1:1|with mel|stretching/i.test(t)) return '1:1';
  if (/prehab/i.test(t)) return 'Prehab';
  if (/physio|assessment/i.test(t)) return 'Physio';
  if (/osteo/i.test(t)) return 'Osteo';
  if (/madero/i.test(t)) return 'Madero';
  return '1:1';
}
// raw Trainer cell -> trainer name (STAFF tab: Match text)
function appTrainer_(v) { return cfgTrainerName_(v); }
function appNum_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[$,\s]/g, '').replace(/\.{2,}/g, '.'));
  return isNaN(n) ? 0 : n;
}
function appYmd_(v, disp) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  var s = String(disp || v || '').trim(), m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}
function appHm_(s) {
  var m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?/i);
  if (!m) return '';
  var h = Number(m[1]); if (m[3] && /p/i.test(m[3]) && h < 12) h += 12; if (m[3] && /a/i.test(m[3]) && h === 12) h = 0;
  return ('0' + h).slice(-2) + ':' + m[2];
}
function appEnd_(hm) { var h = Number(hm.split(':')[0]) + 1; return ('0' + h).slice(-2) + ':' + hm.split(':')[1]; }
function appShift_(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function appDays_(a, b) { return (new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5; }