// =====================================================================
// WELLBE CLIENT APP BACKEND
// Add as a NEW FILE called "Client" in the "Wellbe W40 Backend" project
// (next to Code and App). Same /exec URL, no extra deployment.
//
// How clients sign in: they type the email we have for them, get a
// 6 digit code by email (valid 10 minutes), and stay signed in 180 days.
// People who are not clients yet sign in as guests: see Guest.gs.
// Parents: the child's row in CLIENTS has the parent's email, so the
// parent sees the child's account (and their own, if they train too).
//
// Test once from the editor: clTest()  -> checks the calendar and the tabs.
// Kill every client session at once (lost phone etc): clSignOutEveryone()
// =====================================================================

var CL = {
  CAL: 'majdbouhabib@gmail.com',          // physio availability
  WA: '96176511048',                       // Romy, center WhatsApp
  SITE: 'https://majd-wellbe.github.io/wellbe-staff-app/client/',
  FRIEND: 'https://majd-wellbe.github.io/Wellbe-center-landingpage-womenAMsessions/?by=',
  TOKEN_DAYS: 180,
  PHYSIO_PRICE: 40, PHYSIO_WAS: 50,        // Physio single sold at 20% off
  PHYSIO_DAYS: 14, PHYSIO_NOTICE_H: 12,
  // physio hours: day of week (0 Sunday) -> session start times, 60 minutes each, no gap
  PHYSIO_HOURS: {
    1: ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00'],
    3: ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00'],
    4: ['16:00', '17:00', '18:00', '19:00', '20:00'],
    5: ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00']
  },
  JOIN_MIN_H: 48, JOIN_DAYS: 10,
  REVIEW: 'https://search.google.com/local/writereview?placeid=ChIJ35Nmu5s_HxURBmvCuEEY8U0',
  GOAL_HEAD: ['Client ID', 'Client', 'Promise', 'Key 1', 'Key 2', 'Key 3', 'Updated', 'Made by'],
  FREEZE_DAYS: 7,
  REQ_HEAD: ['ID', 'Created', 'Client ID', 'Client', 'Type', 'Details', 'Slot / Session', 'Package', 'Status', 'Handled by', 'Handled at', 'Data']
};

// =====================================================================
// ROUTER: called from the first line of app_route_ in App.gs
// =====================================================================
function client_route_(b) {
  try {
    var a = String(b.action);
    if (a === 'app_cl_code') return json_(clCode_(b));
    if (a === 'app_cl_login') return json_(clLogin_(b));
    var who = clWho_(b.token);
    if (!who) return json_({ ok: false, error: 'signin' });
    if (a === 'app_cl_boot') return json_(appCached_('c|' + who.email, function () { return who.guest ? guestBoot_(who) : insClientBoot_(clBoot_(who)); }));
    var cid = String(b.cid || '').toUpperCase();
    if (who.ids.indexOf(cid) < 0) return json_({ ok: false, error: 'Not your account' });
    var fn = (who.guest
      ? { app_cl_run: clRun_, app_cl_streak: clStreak_, app_cl_goal: clGoal_, app_cl_guest: guestAct_ }      // not a client yet
      : { app_cl_run: clRun_, app_cl_wo: clWo_, app_cl_cancel: clCancel_, app_cl_join: clJoin_, app_cl_request: clRequest_, app_cl_upgrade6: clUpgrade6_, app_cl_goal: clGoal_, app_cl_streak: clStreak_ })[a];
    if (!fn) return json_({ ok: false, error: 'unknown action' });
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      var out = fn(b, cid, who) || {};
      if (!/^app_cl_(run|wo|streak)$/.test(a)) appBump_();
      out.ok = true;
      return json_(out);
    } finally { try { lock.releaseLock(); } catch (x) {} }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// =====================================================================
// SIGN IN: email -> 6 digit code -> signed token
// =====================================================================
function clCode_(b) {
  var email = clEmail_(b.email);
  if (!email) return { ok: false, error: 'Please type a valid email.' };
  var acc = clAccounts_(email), g = null, out = { ok: true };
  if (!acc.length) {                       // not a client: a guest (new to Wellbe)
    g = guestFind_(email);
    if (!g) {
      if (b.mode !== 'new') return { ok: false, error: 'unknown' };
      var gname = clean_(b.name, 60);
      if (gname.replace(/[^A-Za-z\u0600-\u06FF]/g, '').length < 2) return { ok: false, error: 'Please type your name.' };
      g = guestCreate_(email, gname);
    }
    out.guest = true;
  } else if (b.mode === 'new') out.client = true;   // tapped "new" but already a client: sign them in as a client
  var cache = CacheService.getScriptCache();
  var sent = Number(cache.get('clsend|' + email) || 0);
  if (sent >= 3) return { ok: false, error: 'Too many codes asked. Wait 15 minutes, then try again.' };
  var dayKey = 'clday|' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd'), day = Number(cache.get(dayKey) || 0);
  if (day >= 80) return { ok: false, error: 'Sign in is busy today. Message Romy on WhatsApp.' };
  var code = String(Math.floor(100000 + Math.random() * 900000));
  cache.put('clcode|' + email, JSON.stringify({ c: code, n: 0 }), 600);
  cache.put('clsend|' + email, String(sent + 1), 900);
  cache.put(dayKey, String(day + 1), 21600);
  var first = String((acc[0] || g).name || '').split(' ')[0];
  MailApp.sendEmail({
    to: email, name: 'Wellbe Health Center', subject: 'Your Wellbe code: ' + code,
    body: 'Hi ' + first + ',\n\nYour Wellbe app code is ' + code + '\nIt works for 10 minutes.\n\nDid not ask for it? Ignore this email.\n\nWellbe Health Center',
    htmlBody: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#151b1e">' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:2px;color:#1f6e5b">WELLBE</div>' +
      '<p style="font-size:16px">Hi ' + first + ', here is your code:</p>' +
      '<div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#e9f6f2;border-radius:12px;padding:16px;text-align:center">' + code + '</div>' +
      '<p style="color:#5b6b70;font-size:14px">It works for 10 minutes. Did not ask for it? Just ignore this email.</p></div>'
  });
  return out;
}

function clLogin_(b) {
  var email = clEmail_(b.email), code = String(b.code || '').replace(/\D/g, '');
  if (!email || code.length !== 6) return { ok: false, error: 'Type the 6 digit code from the email.' };
  var cache = CacheService.getScriptCache(), raw = cache.get('clcode|' + email);
  if (!raw) return { ok: false, error: 'This code expired. Ask for a new one.' };
  var st = JSON.parse(raw);
  if (st.n >= 5) { cache.remove('clcode|' + email); return { ok: false, error: 'Too many tries. Ask for a new code.' }; }
  if (st.c !== code) {
    st.n++; cache.put('clcode|' + email, JSON.stringify(st), 600);
    return { ok: false, error: 'Wrong code. ' + (5 - st.n) + ' tries left.' };
  }
  cache.remove('clcode|' + email);
  try { guestVerified_(email); } catch (e) {}
  return { ok: true, token: clSign_(email) };
}

function clSecret_() {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('CL_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('CL_SECRET', s); }
  return s;
}
function clSign_(email) {
  var exp = Date.now() + CL.TOKEN_DAYS * 864e5, payload = email + '|' + exp;
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, clSecret_())).replace(/=+$/, '');
  return Utilities.base64EncodeWebSafe(payload).replace(/=+$/, '') + '.' + sig;
}
function clWho_(token) {
  var p = String(token || '').split('.'); if (p.length !== 2) return null;
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(p[0] + '==='.slice((p[0].length + 3) % 4))).getDataAsString(); } catch (e) { return null; }
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, clSecret_())).replace(/=+$/, '');
  if (sig !== p[1]) return null;
  var x = payload.split('|'); if (Number(x[1]) < Date.now()) return null;
  var acc = clAccounts_(x[0]), g = guestFind_(x[0]);
  if (!acc.length) {                                                 // not a client (yet): guest account
    if (!g) return null;
    return { email: x[0], ids: [g.id], acc: [{ id: g.id, name: g.name, phone: g.phone }], guest: g };
  }
  if (g && !g.cid) { try { guestConvert_(g, acc[0].id); } catch (e) {} }   // just became a client: game and streak follow
  return { email: x[0], ids: acc.map(function (a) { return a.id; }), acc: acc };
}
// changes the secret: every client has to sign in again
function clSignOutEveryone() { PropertiesService.getScriptProperties().deleteProperty('CL_SECRET'); clSecret_(); Logger.log('Done. Every client signs in again with a new code.'); }

function clEmail_(v) { var e = String(v || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ''; }

// every CLIENTS row whose email cell holds this email (a cell may hold 2 emails)
function clAccounts_(email) {
  var cache = CacheService.getScriptCache(), hit = cache.get('clacc|' + email);
  if (hit) return JSON.parse(hit);
  var v = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB).getDataRange().getDisplayValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var id = String(v[i][0] || '').trim().toUpperCase(); if (!/^C\d+$/.test(id)) continue;
    var list = String(v[i][2] || '').toLowerCase().split(/[\s,;\/]+/);
    if (list.indexOf(email) > -1) out.push({ id: id, name: String(v[i][1] || '').trim(), phone: String(v[i][3] || '') });
  }
  if (out.length) cache.put('clacc|' + email, JSON.stringify(out), 600);
  return out;
}

// =====================================================================
// READ: everything one email can see
// =====================================================================
function clBoot_(who) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), now = Date.now();
  var ids = {}; who.ids.forEach(function (id) { ids[id] = 1; });
  var pv = ops.getSheetByName('PACKAGES').getDataRange().getValues(), all = [], pkById = {};
  for (var i = 2; i < pv.length; i++) {
    var r = pv[i], id = String(r[0] || '').trim(), cid = String(r[1] || '').trim().toUpperCase();
    if (!id || !ids[cid]) continue;
    var p = { id: id, cid: cid, type: String(r[3] || ''), total: Number(r[4]) || 0, used: Number(r[5]) || 0, price: appNum_(r[8]), paid: appNum_(r[21]),
      start: appYmd_(r[9]), end: appYmd_(r[12]) || appYmd_(r[11]) || appYmd_(r[10]), status: String(r[13] || '').trim() };
    p.kind = appKind_(p.type); p.left = Math.max(0, p.total - p.used); p.due = Math.max(0, Math.round((p.price - p.paid) * 100) / 100);
    p.label = p.type.replace(/\s*\(\$[^)]*\)/, '').replace(/\s*\(Free\)/i, ' (free)');
    p.phase = /cancel/i.test(p.status) ? 'past' : (p.status === 'Active' && p.start > today ? 'future' : (p.status === 'Active' && p.total > 0 && !(p.end && p.end < today && p.used >= p.total) ? 'current' : 'past'));
    all.push(p); pkById[id] = p;
  }
  var reqs = appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && ids[String(r[2]).toUpperCase()]; }).map(clReqObj_);
  var sess = appSessions_(ops, appShift_(today, -45), appShift_(today, Math.max(APP.AHEAD_DAYS, CL.PHYSIO_DAYS)), null);
  var slots = clSlots_(sess, appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0]; }).map(clReqObj_), today);
  var joe = {};   // Joe's load per date|hour, same rule as joeLoad_
  sess.forEach(function (s) {
    if (s.trainer !== 'Joe' || ['1:1', '1:2', '1:3'].indexOf(s.tab) < 0 || s.status === 'Cancelled') return;
    var k = s.date + '|' + Number(s.start.split(':')[0]); joe[k] = (joe[k] || 0) + s.clients.length;
  });

  var goals = clGoalsMap_(ops);
  var accounts = who.acc.map(function (a) {
    var pk = all.filter(function (p) { return p.cid === a.id; }).sort(function (x, y) { return (x.start || '') < (y.start || '') ? -1 : 1; });
    var mySess = [];
    sess.forEach(function (s) {
      s.clients.forEach(function (c) {
        var p = pkById[c.pkg]; if (!p || p.cid !== a.id) return;
        mySess.push({ id: s.id, ref: s.ref, tab: s.tab, date: s.date, start: s.start, end: s.end, trainer: s.trainer, i: c.slot, pkg: c.pkg,
          att: c.att || (s.status === 'Cancelled' ? 'Cancelled' : ''), group: s.clients.length, at: clAt_(s.date, s.start) });
      });
    });
    mySess.sort(function (x, y) { return x.at - y.at; });
    var upcoming = mySess.filter(function (s) { return !s.att && s.at > now - 3600000; });
    var past = mySess.filter(function (s) { return s.date >= appShift_(today, -30) && (s.att || s.at <= now - 3600000) && s.date <= today; }).reverse();
    var myReqs = reqs.filter(function (q) { return q.cid === a.id; }).reverse().slice(0, 30);
    var active = pk.filter(function (p) { return p.phase === 'current' || p.phase === 'future'; });
    var acc = { cid: a.id, name: a.name, first: a.name.split(' ')[0], full: active.length > 0, pkgs: pk.map(clPkgOut_), upcoming: upcoming, past: past, requests: myReqs, goal: goals[a.id] || null };
    if (!acc.full) return acc;

    // freeze: once per package, current or future
    acc.pkgs.forEach(function (p) {
      if (p.phase === 'past') return;
      var used = myReqs.some(function (q) { return q.type === 'Freeze' && q.pkg === p.id && q.status !== 'Declined'; });
      p.canFreeze = !used; p.frozen = used;
    });
    acc.offers = clOffers_(pk, myReqs, today);
    // physio banner: training clients with no prehab, no physio in the last 4 weeks, nothing pending
    var training = active.some(function (p) { return ['1:1', '1:2', '1:3'].indexOf(p.kind) > -1; });
    var prehab = active.some(function (p) { return p.kind === 'Prehab'; });
    var recentPhysio = mySess.some(function (s) { return (s.tab === 'Physio' || s.tab === 'Prehab') && s.date >= appShift_(today, -28) && !/cancel/i.test(s.att); });
    var pendingPhysio = myReqs.some(function (q) { return q.type === 'Physio visit' && q.status === 'New'; });
    acc.physio = { show: training && !prehab, recent: recentPhysio, pending: pendingPhysio };
    // open 1:3 spots: 48h+ ahead, free chair, Joe under his cap, and passes left
    var p13 = active.filter(function (p) { return p.kind === '1:3' && p.left > 0 && p.phase === 'current'; })[0];
    acc.open = [];
    if (p13) {
      var booked = upcoming.filter(function (s) { return s.pkg === p13.id; }).length;
      acc.canJoin = p13.left - booked;
      if (acc.canJoin > 0) sess.forEach(function (s) {
        if (s.tab !== '1:3' || s.status === 'Cancelled' || s.clients.length >= 3) return;
        var at = clAt_(s.date, s.start);
        if (at - now < CL.JOIN_MIN_H * 3600000 || s.date > appShift_(today, CL.JOIN_DAYS)) return;
        if (s.clients.some(function (c) { return pkById[c.pkg] && pkById[c.pkg].cid === a.id; })) return;
        if (s.trainer === 'Joe' && (joe[s.date + '|' + Number(s.start.split(':')[0])] || 0) >= CFG.CAP) return;
        if (p13.end && s.date > p13.end) return;
        acc.open.push({ id: s.id, date: s.date, start: s.start, trainer: s.trainer, spots: 3 - s.clients.length, at: at });
      });
      acc.open.sort(function (x, y) { return x.at - y.at; });
      acc.grid = clGrid_(sess, today, now, acc.open, p13, a.id, pkById);
    }
    return acc;
  });

  return { ok: true, today: today, now: now, email: who.email, accounts: accounts, slots: slots, shop: clShop_(ops), review: CL.REVIEW,
    wa: CL.WA, friend: CL.FRIEND, physio: { price: CL.PHYSIO_PRICE, was: CL.PHYSIO_WAS } };
}

function clPkgOut_(p) {
  return { id: p.id, label: p.label, kind: p.kind, total: p.total, used: p.used, left: p.left, start: p.start, end: p.end,
    status: p.status, phase: p.phase, due: p.due, price: p.price };
}

// upsells
//  3 months (7% off, 1 payment): monthly package at least half way, not already on a 3 month bundle, no next package yet
//  6 months (15% off): a 3 month bundle, from the last week of month 2 to the first week of month 3: pay the rest, months 4 to 6 added now
function clOffers_(pk, reqs, today) {
  var out = {};
  var monthly = pk.filter(function (p) { return /x\/month \(\$\d+/.test(p.type) && !/cancel/i.test(p.status) && p.start; });
  var byType = {};
  monthly.forEach(function (p) { (byType[p.type] = byType[p.type] || []).push(p); });
  Object.keys(byType).forEach(function (t) {
    var rows = byType[t].sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    var mo = Number(/\(\$(\d+)/.exec(t)[1]);
    // the latest run of 3 rows within 70 days = a 3 month bundle
    var i = -1;
    for (var k = rows.length - 3; k >= 0; k--) if (appDays_(rows[k + 2].start, rows[k].start) <= 70) { i = k; break; }
    if (i > -1 && rows.slice(i).some(function (p) { return p.phase !== 'past'; })) {
      var r1 = rows[i], r3 = rows[i + 2], day = appDays_(today, r1.start);
      var extended = rows.length > i + 3;
      var asked = reqs.some(function (q) { return q.type === '6 month upgrade' && q.pkg === r1.id && q.status !== 'Declined'; });
      if (!extended && !asked && day >= 52 && day <= 68) {
        var paid3 = r1.price + rows[i + 1].price + r3.price, p6 = Math.round(mo * 6 * 0.85), due = p6 - paid3;
        if (due > 0) out.m6 = { pkg: r1.id, type: r1.label, mo: mo, t6: mo * 6, p6: p6, paid3: paid3, due: due, each: Math.round(due / 3), save: mo * 6 - p6, starts: appShift_(r3.start, 30) };
      }
      return;                                             // on a bundle: no 3 month offer for this type
    }
    var cur = rows.filter(function (p) { return p.phase === 'current'; }).pop();
    if (!cur || rows.some(function (p) { return p.phase === 'future'; })) return;
    var half = cur.used >= cur.total / 2 || appDays_(today, cur.start) >= 15;
    var asked3 = reqs.some(function (q) { return q.type === '3 month offer' && q.pkg === cur.id && q.status !== 'Declined'; });
    if (half && !asked3) out.m3 = { pkg: cur.id, type: cur.label, mo: mo, t3: mo * 3, p3: Math.round(mo * 3 * 0.93), save: mo * 3 - Math.round(mo * 3 * 0.93), starts: cur.end };
  });
  return out;
}

// semi private calendar for the next JOIN_DAYS days
//  instant = a 1:3 already running with a free chair, 48h+ ahead (same rule as clJoin_)
//  request = a usual 1:3 hour (ran at least twice on that weekday in the last 45 days) or a group under 48h away
//  full    = every group at that hour has 3 clients
function clGrid_(sess, today, now, open, p13, cid, pkById) {
  var cnt = {}, usual = {}, mine = {}, future = {}, out = [];
  sess.forEach(function (s) {
    if (s.tab !== '1:3' || s.status === 'Cancelled') return;
    if (s.date < today) { var k = new Date(s.date + 'T12:00:00Z').getUTCDay() + '|' + s.start; cnt[k] = (cnt[k] || 0) + 1; }
    else (future[s.date + '|' + s.start] = future[s.date + '|' + s.start] || []).push(s);
  });
  Object.keys(cnt).forEach(function (k) { if (cnt[k] >= 2) { var x = k.split('|'); (usual[x[0]] = usual[x[0]] || []).push(x[1]); } });
  sess.forEach(function (s) {
    if (s.status === 'Cancelled') return;
    s.clients.forEach(function (c) { var p = pkById[c.pkg]; if (p && p.cid === cid && !/cancel/i.test(c.att || '')) mine[s.date + '|' + s.start] = 1; });
  });
  for (var d = 1; d <= CL.JOIN_DAYS; d++) {
    var ymd = appShift_(today, d), dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
    if (dow === 0 || CFG.BLOCKED_DATES.indexOf(ymd) > -1 || (p13.end && ymd > p13.end)) continue;
    var hours = {};
    (usual[dow] || []).forEach(function (h) { hours[h] = 1; });
    Object.keys(future).forEach(function (k) { if (k.indexOf(ymd + '|') === 0) hours[k.split('|')[1]] = 1; });
    Object.keys(hours).sort().forEach(function (h) {
      var key = ymd + '|' + h; if (mine[key]) return;
      var o = open.filter(function (x) { return x.date === ymd && x.start === h; })[0];
      if (o) { out.push({ date: ymd, start: h, trainer: o.trainer, spots: o.spots, state: 'instant' }); return; }
      var ss = future[key] || [];
      if (ss.length && !ss.some(function (s) { return s.clients.length < 3; })) { out.push({ date: ymd, start: h, trainer: ss[0].trainer, state: 'full' }); return; }
      out.push({ date: ymd, start: h, trainer: ss.length ? ss[0].trainer : '', state: 'request' });
    });
  }
  return out;
}

// physio slots on Majd's calendar: 60 minutes, minus calendar events, his sessions, and pending requests
function clSlots_(sess, reqs, today) {
  var busy = [], calOk = true, now = Date.now(), until = appShift_(today, CL.PHYSIO_DAYS + 1);
  try {
    var cal = CalendarApp.getCalendarById(CL.CAL);
    if (!cal) { try { cal = CalendarApp.subscribeToCalendar(CL.CAL); } catch (x) {} }   // shared but not added yet
    if (!cal) throw new Error('no calendar');
    cal.getEvents(beirutDate_(today, 0), beirutDate_(until, 0)).forEach(function (e) {
      if (e.isAllDayEvent()) return;
      busy.push([e.getStartTime().getTime(), e.getEndTime().getTime()]);
    });
  } catch (e) { calOk = false; Logger.log('Physio calendar not readable: ' + e); }
  sess.forEach(function (s) {
    if (s.trainer !== 'Majd' || s.status === 'Cancelled' || s.date < today || s.date > until) return;
    var a = clAt_(s.date, s.start); busy.push([a, a + 3600000]);
  });
  reqs.forEach(function (q) {
    if (q.type !== 'Physio visit' || q.status !== 'New' || !q.slot) return;
    var x = q.slot.split(' '), a = clAt_(x[0], x[1]); busy.push([a, a + 3600000]);
  });
  var out = [];
  for (var d = 0; d <= CL.PHYSIO_DAYS; d++) {
    var ymd = appShift_(today, d), dow = new Date(ymd + 'T12:00:00Z').getUTCDay(), hours = CL.PHYSIO_HOURS[dow];
    if (!hours || CFG.BLOCKED_DATES.indexOf(ymd) > -1) continue;
    hours.forEach(function (t) {
      var a = clAt_(ymd, t), b = a + 3600000;
      if (a - now < CL.PHYSIO_NOTICE_H * 3600000) return;
      if (busy.some(function (x) { return x[0] < b && x[1] > a; })) return;
      out.push({ d: ymd, t: t });
    });
  }
  return out;
}

function clShop_(ops) {
  var seen = {}, out = [];
  appRows_(ops, 'POS INVENTORY', 2, 11).forEach(function (r) {
    var n = String(r[3] || '').trim(); if (!n) return;
    var price = appNum_(r[10]); if (!(price > 0)) return;
    if (seen[n]) { seen[n].left += Math.max(0, Number(r[8]) || 0); return; }
    seen[n] = { n: n, price: price, left: Math.max(0, Number(r[8]) || 0) }; out.push(seen[n]);
  });
  return out;
}

// =====================================================================
// WRITES
// =====================================================================
// cancel: a day or more before = Early Cancel (session kept); on the day = Late Cancel (counts as done)
function clCancel_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), at = appFind_(ops, b.ref, b.id), cfg = AT[at.k], sh = at.sh, row = at.row;
  var r = sh.getRange(row, 1, 1, cfg.width).getValues()[0], d = sh.getRange(row, 1, 1, cfg.width).getDisplayValues()[0];
  var ymd = appYmd_(r[1], d[1]), hm = appHm_(d[2]), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var mine = clPkgIds_(ops, cid), i = -1;
  cfg.slots.forEach(function (sl, k) { if (mine[String(r[sl.pkg - 1]).trim()]) i = k; });
  if (i < 0) throw new Error('This session is not on your account.');
  if (clAt_(ymd, hm) <= Date.now()) throw new Error('This session already started. Message Romy.');
  var sl = cfg.slots[i];
  if (sl.att && String(r[sl.att - 1]).trim()) throw new Error('Already marked. Message Romy.');
  if (/cancel/i.test(String(r[cfg.status - 1]))) throw new Error('Already cancelled.');
  var kind = ymd > today ? 'Early Cancel' : 'Late Cancel';
  var pkg = appSetAtt_(sh, cfg, row, i, kind, 'client app');
  if (at.k === '1:3') {
    var allOut = cfg.slots.every(function (s) { return !String(sh.getRange(row, s.pkg).getValue()).trim() || /cancel/i.test(String(sh.getRange(row, s.att).getValue())); });
    if (allOut) sh.getRange(row, cfg.status).setValue('Cancelled');
  }
  appRecount_(ops, pkg);
  var name = String(r[sl.name - 1] || '');
  clLog_(ops, cid, name, 'Cancelled', kind + (kind === 'Late Cancel' ? ' (same day, counts as done)' : ' (session kept)') + ' · ' + at.k + ' with ' + (cfg.fixed || appTrainer_(r[cfg.trainer - 1])), ymd + ' ' + hm + ' · ' + b.id, pkg, 'New', {});
  return { kind: kind };
}

function clJoin_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), ymd = String(b.date), hm = String(b.time), trainer = appTrainer_(b.trainer);
  if (clAt_(ymd, hm) - Date.now() < CL.JOIN_MIN_H * 3600000) throw new Error('Less than 48 hours away: message Romy to add you.');
  var cfg = AT['1:3'], sh = ops.getSheetByName(cfg.sheet), last = sh.getLastRow(), found = false;
  var v = sh.getRange(3, 1, last - 2, cfg.width).getValues(), dv = sh.getRange(3, 1, last - 2, cfg.width).getDisplayValues();
  for (var i = 0; i < v.length; i++) {
    if (!v[i][0] || appYmd_(v[i][1], dv[i][1]) !== ymd || appHm_(dv[i][2]) !== hm || appTrainer_(v[i][cfg.trainer - 1]) !== trainer) continue;
    if (/cancel/i.test(String(v[i][cfg.status - 1]))) continue;
    if (cfg.slots.some(function (sl) { return !String(v[i][sl.pkg - 1]).trim(); })) { found = true; break; }
  }
  if (!found) throw new Error('This spot was just taken. Pick another one.');
  // the client's 1:3 package with sessions left
  var pv = ops.getSheetByName('PACKAGES').getDataRange().getValues(), pkg = null, name = '';
  for (var j = 2; j < pv.length; j++) {
    var r = pv[j];
    if (String(r[1]).trim().toUpperCase() !== cid || String(r[13]).trim() !== 'Active' || appKind_(r[3]) !== '1:3') continue;
    if ((Number(r[4]) || 0) - (Number(r[5]) || 0) <= 0 || appYmd_(r[9]) > ymd) continue;
    pkg = String(r[0]).trim(); name = String(r[2]); break;
  }
  if (!pkg) throw new Error('No group sessions left on your package. Message Romy to renew.');
  var res = appBookInto_(ops, '1:3', ymd, hm, trainer, pkg, name, null);
  clLog_(ops, cid, name, 'Joined a spot', '1:3 with ' + trainer, ymd + ' ' + hm + ' · ' + res.id, pkg, 'New', {});
  return { id: res.id };
}

// generic request that Romy handles from her To do
function clRequest_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var name = appClientInfo_(cid).name, kind = String(b.kind), note = clean_(b.note, 400), mine = clPkgIds_(ops, cid);
  var reqs = appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0]; }).map(clReqObj_);
  if (kind === 'physio') {
    if (reqs.some(function (q) { return q.cid === cid && q.type === 'Physio visit' && q.status === 'New'; })) throw new Error('You already have a physio request waiting. Romy will confirm it soon.');
    var sess = appSessions_(ops, today, appShift_(today, CL.PHYSIO_DAYS + 1), null);
    var ok = clSlots_(sess, reqs, today).some(function (s) { return s.d === b.d && s.t === b.t; });
    if (!ok) throw new Error('This time was just taken. Pick another one.');
    clLog_(ops, cid, name, 'Physio visit', 'Physio visit with Majd, $' + CL.PHYSIO_PRICE + ' (was $' + CL.PHYSIO_WAS + ')' + (note ? ' · ' + note : ''), b.d + ' ' + b.t, '', 'New', { d: b.d, t: b.t });
    return {};
  }
  if (kind === 'reschedule') {
    if (!b.when) throw new Error('Tell us what time suits you.');
    clLog_(ops, cid, name, 'Reschedule', 'Wants: ' + clean_(b.when, 200) + (note ? ' · ' + note : ''), clean_(b.slabel, 80) + ' · ' + clean_(b.sid, 20), clean_(b.pkg, 20), 'New', { sid: b.sid, ref: b.ref });
    return {};
  }
  if (kind === 'freeze') {
    if (!mine[b.pkg]) throw new Error('Package not found.');
    if (reqs.some(function (q) { return q.type === 'Freeze' && q.pkg === b.pkg && q.status !== 'Declined'; })) throw new Error('This package already had its freeze.');
    var from = String(b.from || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from < today) throw new Error('Pick a start date from today.');
    clLog_(ops, cid, name, 'Freeze', CL.FREEZE_DAYS + ' days from ' + from + ' to ' + appShift_(from, CL.FREEZE_DAYS - 1) + (note ? ' · ' + note : ''), from, b.pkg, 'New', { from: from });
    return {};
  }
  if (kind === 'offer3') {
    var o = clOffers_(clPkgsOf_(ops, cid, today), reqs.filter(function (q) { return q.cid === cid; }), today).m3;
    if (!o) throw new Error('This offer is not open on your package.');
    clLog_(ops, cid, name, '3 month offer', '3 months of ' + o.type + ': $' + o.p3 + ' instead of $' + o.t3 + ' (7% off, one payment), starts ' + o.starts, '', o.pkg, 'New', o);
    return {};
  }
  if (kind === 'order') {
    var shop = clShop_(ops), lines = [], total = 0;
    (b.items || []).forEach(function (it) {
      var p = shop.filter(function (x) { return x.n === it.n; })[0], q = Math.max(1, Math.min(10, Number(it.q) || 1));
      if (!p) return;
      lines.push(q + ' x ' + p.n + ' ($' + p.price * q + ')' + (p.left < q ? ' [to order in]' : '')); total += p.price * q;
    });
    if (!lines.length) throw new Error('Your cart is empty.');
    clLog_(ops, cid, name, 'Supplement order', lines.join(', ') + ' · TOTAL $' + total + ' · pay and pick up at next session', '', '', 'New', { items: b.items, total: total });
    return { total: total };
  }
  if (kind === 'late') {
    var mins = Math.max(5, Math.min(60, Number(b.minutes) || 10));
    clLog_(ops, cid, name, 'Running late', 'About ' + mins + ' min late' + (note ? ' · ' + note : ''), clean_(b.slabel, 80) + ' · ' + clean_(b.sid, 20), clean_(b.pkg, 20), 'New', { sid: b.sid, minutes: mins });
    return {};
  }
  if (kind === 'supp') {
    if (!note) throw new Error('Tell us which supplement.');
    clLog_(ops, cid, name, 'Supplement request', note, '', '', 'New', {});
    return {};
  }
  if (kind === 'session') {
    clLog_(ops, cid, name, 'Session request', clean_(b.what, 60) + ' · ' + clean_(b.when, 200) + (note ? ' · ' + note : ''), '', clean_(b.pkg, 20), 'New', {});
    return {};
  }
  if (kind === 'invite') {
    var fn = clean_(b.fname, 60), ph = String(b.phone || '').replace(/\D/g, '');
    if (!fn || ph.length < 10) throw new Error('Check the name and phone number.');
    var inv = 'https://wa.me/' + ph + '?text=' + encodeURIComponent(String(b.msg || '').slice(0, 300));
    clLog_(ops, cid, name, 'Friend invite', name + ' would like to invite ' + fn + ' (+' + ph + ') to Wellbe. Tap to send them the invite: ' + inv, '', '', 'New', { fname: fn, phone: ph });
    return {};
  }
  throw new Error('Unknown request');
}

// 6 months: months 4, 5, 6 are created now, priced as the remaining payment split in 3
function clUpgrade6_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var reqs = appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && String(r[2]).toUpperCase() === cid; }).map(clReqObj_);
  var pk = clPkgsOf_(ops, cid, today), o = clOffers_(pk, reqs, today).m6;
  if (!o) throw new Error('The 6 month upgrade is not open on your package right now.');
  var src = pk.filter(function (p) { return p.id === o.pkg; })[0], name = appClientInfo_(cid).name, made = [];
  for (var k = 0; k < 3; k++) {
    var price = k < 2 ? o.each : o.due - o.each * 2;
    made.push(clAddPkg_(ops, cid, name, src.type, price, appShift_(o.starts, 30 * k), 0.15, '6 month upgrade (15% off), month ' + (4 + k) + ' of 6. Requested in the client app.'));
  }
  clLog_(ops, cid, name, '6 month upgrade', 'Upgraded to 6 months: pay $' + o.due + ' at the center (months 4 to 6 added: ' + made.join(', ') + ')', '', o.pkg, 'New', o);
  return { due: o.due, ids: made };
}

// =====================================================================
// STAFF SIDE: requests in Romy's To do (App.gs boot + app_req_done)
// =====================================================================
function clStaffRequests_(ops) {
  return appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && String(r[8]) === 'New'; }).map(clReqObj_);
}

// act: done | decline | accept  (accept: physio = sell $40 visit + book it, freeze = +7 days, 3 month offer = create the 3 months)
function appReqDone_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
  var v = sh.getRange(1, 1, sh.getLastRow(), CL.REQ_HEAD.length).getValues(), row = -1;
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === String(b.id)) { row = i + 1; break; }
  if (row < 0) throw new Error('Request not found, refresh');
  var q = clReqObj_(v[row - 1]), out = {};
  if (q.status !== 'New') throw new Error('Already handled by ' + (q.by || 'someone'));
  if (b.act === 'accept') {
    if (q.type === 'Physio visit') {
      var x = q.slot.split(' ');
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.d || '')) && /^\d{2}:\d{2}$/.test(String(b.t || ''))) x = [String(b.d), String(b.t)];
      var sold = appSell_({ type: 'Physio - Single Session ($50)', cid: q.cid, discount: 20, paid: 0, start: x[0] }, me);
      var bk = appBookInto_(ops, 'PP', x[0], x[1], 'Majd', sold.id, q.client, 'Physio');
      out = { pkg: sold.id, session: bk.id };
    } else if (q.type === 'Freeze') {
      out = { end: clFreezeApply_(ops, q.pkg, q.data.from || '', me.name) };
    } else if (q.type === '3 month offer') {
      var o = q.data, made = [], cur = clPkgsOf_(ops, q.cid, '0000-00-00').filter(function (p) { return p.id === q.pkg; })[0];
      if (!cur) throw new Error('Package ' + q.pkg + ' not found');
      var each = Math.round(o.p3 / 3);
      for (var k = 0; k < 3; k++) made.push(clAddPkg_(ops, q.cid, q.client, cur.type, k < 2 ? each : o.p3 - each * 2, appShift_(o.starts || cur.end, 30 * k), 0.07, '3 month bundle (7% off, one payment), month ' + (k + 1) + ' of 3. From the client app.'));
      out = { ids: made };
    }
  }
  sh.getRange(row, 9, 1, 3).setValues([[b.act === 'decline' ? 'Declined' : 'Done', me.name, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm')]]);
  return out;
}

// =====================================================================
// HELPERS
// =====================================================================
// moves a package end date FREEZE_DAYS later; returns the new end (yyyy-MM-dd)
function clFreezeApply_(ops, pkg, from, by) {
  var ps = ops.getSheetByName('PACKAGES'), pr = appPkgRow_(ps, pkg), ex = ps.getRange(pr, 11, 1, 3).getValues()[0];
  var curEnd = appYmd_(ex[2]) || appYmd_(ex[1]) || appYmd_(ex[0]);
  if (!curEnd) throw new Error('Package ' + pkg + ' has no end date: fix it in the sheet first');
  var endYmd = appShift_(curEnd, CL.FREEZE_DAYS), newEnd = beirutDate_(endYmd, 0);
  ps.getRange(pr, 12).setValue(newEnd).setNumberFormat('dd/MM/yyyy');                                          // Extended Expiry
  if (!ps.getRange(pr, 13).getFormula()) ps.getRange(pr, 13).setValue(newEnd).setNumberFormat('dd/MM/yyyy');   // Effective Expiry
  ps.getRange(pr, 21).setValue(appendNote_(String(ps.getRange(pr, 21).getValue() || ''), 'Frozen ' + CL.FREEZE_DAYS + ' days from ' + from + ', ends ' + endYmd + ' (' + by + ')'));
  return endYmd;
}
// packages that already used their freeze (requested or done, not declined)
function clFrozen_(ops) {
  var out = {};
  appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).forEach(function (r) { if (r[0] && String(r[4]) === 'Freeze' && String(r[8]) !== 'Declined' && r[7]) out[String(r[7])] = 1; });
  return out;
}
// WhatsApp ping to Romy for every new client app request (CallMeBot, her own key in Code.gs CFG)
function clPingRomy_(msg) {
  if (!CFG.ROMY_WA || !CFG.ROMY_KEY) return;
  try { UrlFetchApp.fetch('https://api.callmebot.com/whatsapp.php?phone=' + CFG.ROMY_WA + '&text=' + encodeURIComponent(msg) + '&apikey=' + CFG.ROMY_KEY, { muteHttpExceptions: true }); }
  catch (e) { Logger.log('Romy WhatsApp failed: ' + e); }
}

// ---------- the client's promise + 3 keys (AI when ANTHROPIC_KEY is set in Script Properties, otherwise a smart template) ----------
function clGoalsMap_(ops) {
  var out = {};
  appRows_(ops, 'CLIENT GOALS', 2, CL.GOAL_HEAD.length).forEach(function (r) {
    if (r[0] && r[2]) out[String(r[0]).toUpperCase()] = { promise: String(r[2]), keys: [String(r[3]), String(r[4]), String(r[5])].filter(String), updated: String(r[6]) };
  });
  return out;
}
function clGoal_(b, cid) {
  var promise = String(b.promise || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  if (promise.length < 4) throw new Error('Write your promise first.');
  var cache = CacheService.getScriptCache(), n = Number(cache.get('clgoal|' + cid) || 0);
  if (n >= 6) throw new Error('You changed it a lot today. Try again tomorrow.');
  cache.put('clgoal|' + cid, String(n + 1), 86400);
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), info = appClientInfo_(cid), first = String(info.name || '').split(' ')[0];
  var kinds = clPkgsOf_(ops, cid, Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd')).filter(function (p) { return p.phase !== 'past'; }).map(function (p) { return p.label; });
  var keys = null, by = 'template';
  try { keys = clGoalAI_(promise, first, kinds); if (keys) by = 'AI'; } catch (e) { Logger.log('AI goal failed: ' + e); }
  if (!keys) keys = clGoalTemplate_(promise);
  var sh = appTab_(ops, 'CLIENT GOALS', CL.GOAL_HEAD), now = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var row = [cid, info.name, clean_(promise, 240), keys[0], keys[1], keys[2], now, by], at = ids.indexOf(cid);
  if (at < 0) sh.appendRow(row); else sh.getRange(at + 2, 1, 1, row.length).setValues([row]);
  return { goal: { promise: promise, keys: keys, updated: now } };
}
function clGoalAI_(promise, first, kinds) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY'); if (!key) return null;
  var model = PropertiesService.getScriptProperties().getProperty('AI_MODEL') || 'claude-haiku-5-5';
  var sys = 'You are the head coach at Wellbe Health Center, a physiotherapy and semi-private training center in Lebanon. ' +
    'A client wrote the promise they make to themselves. Give the 3 most important things they should do to keep it. ' +
    'Rules: each item is one short action in the second person, max 12 words, concrete and doable every week; ' +
    'tie at least one to their Wellbe sessions; no medical diagnosis, no medication, no calorie or weight numbers, no extreme diets; warm, confident, simple English. ' +
    'Answer ONLY with a JSON array of 3 strings.';
  var msg = 'Client first name: ' + first + '\nTheir packages: ' + (kinds.join(', ') || 'none') + '\nTheir promise: "' + promise + '"';
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: 300, system: sys, messages: [{ role: 'user', content: msg }] }) });
  if (r.getResponseCode() !== 200) { Logger.log('AI ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300)); return null; }
  var txt = (JSON.parse(r.getContentText()).content || []).map(function (c) { return c.text || ''; }).join('');
  var m = txt.match(/\[[\s\S]*\]/); if (!m) return null;
  var arr = JSON.parse(m[0]).map(function (x) { return String(x).trim().slice(0, 120); }).filter(String);
  return arr.length >= 3 ? arr.slice(0, 3) : null;
}
function clGoalTemplate_(p) {
  p = p.toLowerCase();
  if (/pain|back|knee|neck|shoulder|injur|hurt|hip|posture/.test(p)) return ['Do your 10 minute mobility routine every morning', 'Never skip two sessions in a row: steady training calms pain', 'Book your monthly physio check with Majd'];
  if (/weight|kg|kilo|fat|slim|lose|belly|shape|tone/.test(p)) return ['Train with us 3 times a week, every week', 'Put protein and vegetables on every plate', 'Walk 30 minutes on the days you don’t train'];
  if (/strong|strength|muscle|lift|power|fit/.test(p)) return ['Show up to every booked session, no excuses', 'Ask your coach each week what to push next', 'Sleep 7 hours: muscle is built while you rest'];
  if (/energy|tired|stress|sleep|mood|mind|confiden|happy/.test(p)) return ['Keep your Wellbe sessions as appointments with yourself', 'Be in bed at the same time every night', 'Drink water before your first coffee'];
  if (/run|marathon|sport|game|football|tennis|ski|hike/.test(p)) return ['Never skip strength day: it protects your joints', 'Warm up properly before every run or game', 'Tell your coach your next event so we plan for it'];
  return ['Show up to every booked session, even on lazy days', 'Move 30 minutes on the days you don’t train', 'Sleep 7 hours and drink water before coffee'];
}

function clReqObj_(r) {
  var data = {}; try { data = JSON.parse(r[11] || '{}'); } catch (e) {}
  return { id: String(r[0]), created: String(r[1]), cid: String(r[2]).toUpperCase(), client: String(r[3]), type: String(r[4]), details: String(r[5]),
    slot: String(r[6] || ''), pkg: String(r[7] || ''), status: String(r[8] || 'New'), by: String(r[9] || ''), handled: String(r[10] || ''), data: data };
}
function clLog_(ops, cid, name, type, details, slot, pkg, status, data) {
  var sh = appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD), n = Math.max(1, sh.getLastRow());
  var id = 'REQ-' + String(n).padStart(4, '0');
  sh.appendRow([id, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), cid, name, type, String(details).slice(0, 900), slot, pkg, status, '', '', JSON.stringify(data || {}).slice(0, 4000)]);
  if (status === 'New') clPingRomy_('Wellbe app: ' + name + ' · ' + type + (slot ? ' · ' + slot : '') + '\n' + String(details).slice(0, 300) + '\nOpen your To do in the staff app.');
  return id;
}
function clPkgIds_(ops, cid) {
  var v = ops.getSheetByName('PACKAGES').getDataRange().getValues(), out = {};
  for (var i = 2; i < v.length; i++) if (String(v[i][1]).trim().toUpperCase() === cid) out[String(v[i][0]).trim()] = 1;
  return out;
}
function clPkgsOf_(ops, cid, today) {
  var v = ops.getSheetByName('PACKAGES').getDataRange().getValues(), out = [];
  for (var i = 2; i < v.length; i++) {
    var r = v[i]; if (String(r[1]).trim().toUpperCase() !== cid || !r[0]) continue;
    var p = { id: String(r[0]).trim(), type: String(r[3]), total: Number(r[4]) || 0, used: Number(r[5]) || 0, price: appNum_(r[8]),
      start: appYmd_(r[9]), end: appYmd_(r[12]) || appYmd_(r[10]), status: String(r[13] || '').trim() };
    p.label = p.type.replace(/\s*\(\$[^)]*\)/, '');
    p.phase = /cancel/i.test(p.status) ? 'past' : (p.status === 'Active' && p.start > today ? 'future' : (p.status === 'Active' && p.total > 0 && !(p.end && p.end < today && p.used >= p.total) ? 'current' : 'past'));
    out.push(p);
  }
  return out;
}
// same row layout as appSell_
function clAddPkg_(ops, cid, name, type, price, startYmd, disc, note) {
  var sh = ops.getSheetByName('PACKAGES'), t = APP.TYPES.filter(function (x) { return x[0] === type; })[0], total = t ? t[1] : 12;
  var start = beirutDate_(startYmd, 0), exp = beirutDate_(appShift_(startYmd, 30), 0);
  var info = scanIds_(sh, 0, /^(PKG-)(\d+)$/i, 'PKG-', 4), id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  var row = [id, cid, name, type, total, 0, total, total ? Math.round(price / total * 100) / 100 : 0, price, start, exp, '', exp, 'Active', '', 'N', '', '', '', disc, note, 0, ''];
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, id);
  var r = info.lastRow + 1;
  sh.getRange(r, 10, 1, 4).setNumberFormat('dd/MM/yyyy');
  if (!sh.getRange(r, 23).getFormula()) sh.getRange(r, 23).setFormula('=IF(I' + r + '="","",IF(V' + r + '="",I' + r + ',I' + r + '-V' + r + '))');
  return id;
}
// Beirut wall clock -> ms
function clAt_(ymd, hm) {
  var p = String(hm || '00:00').split(':');
  return beirutDate_(ymd, 0).getTime() + (Number(p[0]) * 60 + Number(p[1] || 0)) * 60000;
}

// run once from the editor to check everything is wired
function clTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
  clSecret_();
  var cal = null; try { cal = CalendarApp.getCalendarById(CL.CAL); if (!cal) cal = CalendarApp.subscribeToCalendar(CL.CAL); } catch (e) {}
  Logger.log('Script runs as: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Physio calendar: ' + (cal ? cal.getName() + ' OK' : 'NOT READABLE: share ' + CL.CAL + ' with the account above'));
  var today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  Logger.log('Physio slots next 14 days: ' + clSlots_(appSessions_(ops, today, appShift_(today, 15), null), [], today).length);
  Logger.log('Shop items: ' + clShop_(ops).map(function (x) { return x.n; }).join(', '));
  Logger.log('Client link: ' + CL.SITE);
}