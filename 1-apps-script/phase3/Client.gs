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
  TOKEN_DAYS: 180,
  CODES_PER_DAY: 8,                        // sign in codes one email can ask for in a day (plus 3 per 15 minutes)
  GOAL_HEAD: ['Client ID', 'Client', 'Promise', 'Key 1', 'Key 2', 'Key 3', 'Updated', 'Made by'],
  // the values below come from the settings (Config.gs: center, offers, hours, windows)
  get WA() { return cfg_().center.wa; },                           // center WhatsApp (front desk)
  get SITE() { return cfg_().center.clientSite; },
  get FRIEND() { return cfg_().center.friend; },
  get REVIEW() { return cfg_().center.review; },
  get PHYSIO_PRICE() { return cfg_().offers.physioPrice; },        // physio single sold at a discount
  get PHYSIO_WAS() { return cfg_().offers.physioWas; },
  get PHYSIO_DAYS() { return cfg_().windows.physioDays; },
  get PHYSIO_NOTICE_H() { return cfg_().windows.physioNoticeH; },
  get PHYSIO_HOURS() { return cfg_().hours.physio; },              // day of week (0 Sunday) -> start times, 60 minutes each
  get JOIN_MIN_H() { return cfg_().windows.joinMinH; },
  get JOIN_DAYS() { return cfg_().windows.joinDays; },
  get FREEZE_DAYS() { return cfg_().windows.freezeDays; },
  REQ_HEAD: ['ID', 'Created', 'Client ID', 'Client', 'Type', 'Details', 'Slot / Session', 'Package', 'Status', 'Handled by', 'Handled at', 'Data']
};

// =====================================================================
// ROUTER: called from the first line of app_route_ in App.gs
// =====================================================================
function client_route_(b) {
  reqStart_();
  try { return clRoute_(b); }
  catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
  finally { flushNotify_(); }                       // WhatsApp / email only after the lock is released
}
function clRoute_(b) {
  var a = String(b.action);
  delete b._pre;                                    // filled by the server only, never by the phone
  if (a === 'app_cl_code') return json_(clCode_(b));
  if (a === 'app_cl_login') return json_(clLogin_(b));
  var who = clWho_(b.token);
  if (!who) return json_({ ok: false, error: 'signin' });
  if (a === 'app_cl_boot') return json_(appCached_('c|' + who.email, function () {
    return appReadOnly_(function () {
      var d = profBoot_(who.guest ? guestBoot_(who) : insClientBoot_(clBoot_(who)));
      if (d && !who.guest && typeof refClientBoot_ === 'function') d = refClientBoot_(d);   // "Your invites" + wallet credit (Referral.gs)
      if (d) d.cfg = cfgPublic_('client');
      if (d) d.notices = noticesFor_(SpreadsheetApp.openById(CFG.OPS_ID), who.ids);   // unread in-app notices (e.g. a 1:2 partner cancelled)
      return d;
    });
  }, who.ids));
  var cid = String(b.cid || '').toUpperCase();
  if (who.ids.indexOf(cid) < 0) return json_({ ok: false, error: 'Not your account' });
  var fn = (who.guest
    ? { app_cl_run: clRun_, app_cl_streak: clStreak_, app_cl_goal: clGoal_, app_cl_guest: guestAct_, app_cl_nut: nutClient_, app_cl_profile: profClient_, app_cl_delete: clDelete_, app_cl_notice_read: clNoticeRead_ }      // not a client yet
    : { app_cl_run: clRun_, app_cl_wo: clWo_, app_cl_cancel: clCancel_, app_cl_join: clJoin_, app_cl_request: clRequest_, app_cl_upgrade6: clUpgrade6_, app_cl_goal: clGoal_, app_cl_streak: clStreak_, app_cl_nut: nutClient_, app_cl_profile: profClient_, app_cl_delete: clDelete_, app_cl_notice_read: clNoticeRead_ })[a];
  if (!fn) return json_({ ok: false, error: 'unknown action' });
  // slow outside calls (AI, Drive upload) run BEFORE the lock, so nobody waits behind them
  var pre = { app_cl_goal: clGoalPre_, app_cl_nut: nutClientPre_ }[a];
  if (pre) b._pre = pre(b, cid, who) || null;
  // read only screens (game, workout, nutrition answers, streak) are first answered without the lock
  if (clReadOnly_(a, b)) { var rt = roTry_(function () { return fn(b, cid, who) || {}; }); if (rt) { delete rt.v._bump; rt.v.ok = true; return json_(rt.v); } }
  var lock = LockService.getScriptLock();
  lock.waitLock(25000); LOCK_HELD_ = true;
  try {
    var out = fn(b, cid, who) || {};
    // client-only writes (goal, streak, profile, game, workout log, nutrition) only reload this person's boot;
    // anything that changes packages or sessions reloads everyone (a streak reward adds a package: out._bump)
    var bump = !/^app_cl_(run|wo|streak|nut|profile|goal|notice_read)$/.test(a) || out._bump;
    delete out._bump;
    if (bump) appBump_(); else appBumpClients_(who.ids);
    out.ok = true;
    return json_(out);
  } finally { LOCK_HELD_ = false; try { lock.releaseLock(); } catch (x) {} }
}

// actions that normally only read: tried without the lock first (a write on the way falls back to the lock)
function clReadOnly_(a, b) {
  var op = String(b.op || '');
  if (a === 'app_cl_run') return !op || op === 'get';
  if (a === 'app_cl_wo') return !op || op === 'get';
  if (a === 'app_cl_nut') return !op || op === 'intake_get' || op === 'get';
  if (a === 'app_cl_streak') return !b.keys;
  return false;
}
// =====================================================================
// SIGN IN: email -> 6 digit code -> signed token
// =====================================================================
function clCode_(b) {
  var email = clEmail_(b.email);
  if (!email) return { ok: false, error: 'Please type a valid email.' };
  var acc = clAccounts_(email), g = null, out = { ok: true }, pendName = '';
  if (!acc.length) {                       // not a client: a guest (new to Wellbe)
    g = guestFind_(email);
    if (!g) {
      if (b.mode !== 'new') return { ok: false, error: 'unknown' };
      pendName = clean_(b.name, 60);
      if (pendName.replace(/[^A-Za-z\u0600-\u06FF]/g, '').length < 2) return { ok: false, error: 'Please type your name.' };
      // the guest row is created only once the code is checked (clLogin_): the name waits with the code
    }
    out.guest = true;
  } else if (b.mode === 'new') out.client = true;   // tapped "new" but already a client: sign them in as a client
  var cache = CacheService.getScriptCache();
  var sent = Number(cache.get('clsend|' + email) || 0);
  if (sent >= 3) return { ok: false, error: 'Too many codes asked. Wait 15 minutes, then try again.' };
  var dayKey = 'clday|' + email + '|' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd'), day = Number(cache.get(dayKey) || 0);
  if (day >= CL.CODES_PER_DAY) return { ok: false, error: 'Too many codes for this email today. Try again tomorrow, or message ' + cfgDeskName_() + ' on WhatsApp.' };
  var code = String(Math.floor(100000 + Math.random() * 900000));
  cache.put('clcode|' + email, JSON.stringify({ c: code, n: 0, name: pendName }), 600);
  cache.put('clsend|' + email, String(sent + 1), 900);
  cache.put(dayKey, String(day + 1), 86400);
  var first = String(pendName || (acc[0] || g || {}).name || '').split(' ')[0];
  try { MailApp.sendEmail({
    to: email, name: 'Wellbe Health Center', subject: 'Your Wellbe code: ' + code,
    body: 'Hi ' + first + ',\n\nYour Wellbe app code is ' + code + '\nIt works for 10 minutes.\n\nDid not ask for it? Ignore this email.\n\nWellbe Health Center',
    htmlBody: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#151b1e">' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:2px;color:#1f6e5b">WELLBE</div>' +
      '<p style="font-size:16px">Hi ' + first + ', here is your code:</p>' +
      '<div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#e9f6f2;border-radius:12px;padding:16px;text-align:center">' + code + '</div>' +
      '<p style="color:#5b6b70;font-size:14px">It works for 10 minutes. Did not ask for it? Just ignore this email.</p></div>'
  }); } catch (e) {   // daily email quota reached or Gmail down: say it clearly instead of a raw error
    Logger.log('Sign in email failed: ' + e); cache.remove('clcode|' + email);
    return { ok: false, error: 'We could not send the email right now. Try again in a few minutes, or message ' + cfgDeskName_() + ' on WhatsApp.' };
  }
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
  if (!clAccounts_(email).length) {                 // a guest: the guest row is made now that the email is proven
    var lock = LockService.getScriptLock();
    lock.waitLock(20000); LOCK_HELD_ = true;
    try {
      if (!guestFind_(email)) {
        if (!st.name) return { ok: false, error: 'Please start again and type your name.' };
        guestCreate_(email, st.name);
      }
      try { guestVerified_(email); } catch (e) { Logger.log('guestVerified_: ' + e); }
    } finally { LOCK_HELD_ = false; try { lock.releaseLock(); } catch (x) {} }
  }
  return { ok: true, token: clSign_(email) };
}

function clSecret_() {
  var s = propGet_('CL_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); propSet_('CL_SECRET', s); }
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
  var del = clDeleted_()[x[0]];
  if (del && Number(x[1]) - CL.TOKEN_DAYS * 864e5 <= del) return null;   // account deletion asked: every older sign in is dead
  var acc = clAccounts_(x[0]), g = guestFind_(x[0]);
  if (!acc.length) {                                                 // not a client (yet): guest account
    if (!g) return null;
    return { email: x[0], ids: [g.id], acc: [{ id: g.id, name: g.name, phone: g.phone }], guest: g };
  }
  if (g && !g.cid) { try { guestConvert_(g, acc[0].id); } catch (e) {} }   // just became a client: game and streak follow
  return { email: x[0], ids: acc.map(function (a) { return a.id; }), acc: acc };
}
// changes the secret: every client has to sign in again
function clSignOutEveryone() { propSet_('CL_SECRET', null); clSecret_(); Logger.log('Done. Every client signs in again with a new code.'); }

function clEmail_(v) { var e = String(v || '').trim().toLowerCase(); return emailOk_(e) ? e : ''; }

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
  cache.put('clacc|' + email, JSON.stringify(out), out.length ? 600 : 30);   // not a client: remembered 30 seconds (guests ask on every screen; a client typed into CLIENTS shows up fast)
  return out;
}

// =====================================================================
// READ: everything one email can see
// =====================================================================
function clBoot_(who) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), now = Date.now();
  var ids = {}; who.ids.forEach(function (id) { ids[id] = 1; });
  var all = [], pkById = {};
  pkgsAll_(ops).forEach(function (x) {
    if (!ids[x.cid]) return;
    var p = { id: x.id, cid: x.cid, type: x.type, total: x.total, used: x.used, price: x.price, paid: x.paid,
      start: x.start, end: x.d12 || x.d11 || x.d10, status: x.status.trim() };
    p.kind = cfgKind_(p.type); p.left = Math.max(0, p.total - p.used); p.due = Math.max(0, Math.round((p.price - p.paid) * 100) / 100);
    p.label = p.type.replace(/\s*\(\$[^)]*\)/, '').replace(/\s*\(Free\)/i, ' (free)');
    p.phase = pkgPhase_(p, today);
    all.push(p); pkById[p.id] = p;
  });
  var reqs = appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && ids[String(r[2]).toUpperCase()]; }).map(clReqObj_);
  var sess = appSessions_(ops, appShift_(today, -cfg_().windows.clientBack), appShift_(today, Math.max(APP.AHEAD_DAYS, CL.PHYSIO_DAYS)), null);
  var slots = clSlots_(sess, appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0]; }).map(clReqObj_), today);
  var load = {};   // clients per trainer|date|hour for trainers with a max per hour (Joe), same rule as trainerLoad_
  sess.forEach(function (s) {
    if (!cfgCap_(s.trainer) || ['1:1', '1:2', '1:3'].indexOf(s.tab) < 0 || s.status === 'Cancelled') return;
    var k = s.trainer + '|' + s.date + '|' + Number(s.start.split(':')[0]); load[k] = (load[k] || 0) + s.clients.length;
  });
  var seats = clSeats13_();

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
        if (s.tab !== '1:3' || s.status === 'Cancelled' || s.clients.length >= seats) return;
        var at = clAt_(s.date, s.start);
        if (at - now < CL.JOIN_MIN_H * 3600000 || s.date > appShift_(today, CL.JOIN_DAYS)) return;
        if (s.clients.some(function (c) { return pkById[c.pkg] && pkById[c.pkg].cid === a.id; })) return;
        var cap = cfgCap_(s.trainer); if (cap && (load[s.trainer + '|' + s.date + '|' + Number(s.start.split(':')[0])] || 0) >= cap) return;
        if (p13.end && s.date > p13.end) return;
        acc.open.push({ id: s.id, date: s.date, start: s.start, trainer: s.trainer, spots: seats - s.clients.length, at: at });
      });
      acc.open.sort(function (x, y) { return x.at - y.at; });
      acc.grid = clGrid_(sess, today, now, acc.open, p13, a.id, pkById);
    }
    return acc;
  });

  return { ok: true, today: today, now: now, email: who.email, accounts: accounts, slots: slots, shop: clShop_(ops), review: CL.REVIEW,
    wa: CL.WA, friend: CL.FRIEND, physio: { price: CL.PHYSIO_PRICE, was: CL.PHYSIO_WAS } };
}
// chairs in one semi private (1:3): the service setting, never more than the tab has columns for
function clSeats13_() { return Math.min(Number(cfgService_('1:3').cap) || AT['1:3'].slots.length, AT['1:3'].slots.length); }

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
    for (var k = rows.length - 3; k >= 0; k--) if (appDays_(rows[k + 2].start, rows[k].start) <= cfg_().offers.bundleDays) { i = k; break; }
    if (i > -1 && rows.slice(i).some(function (p) { return p.phase !== 'past'; })) {
      var r1 = rows[i], r3 = rows[i + 2], day = appDays_(today, r1.start);
      var extended = rows.length > i + 3;
      var asked = reqs.some(function (q) { return q.type === '6 month upgrade' && q.pkg === r1.id && q.status !== 'Declined'; });
      if (!extended && !asked && day >= 52 && day <= 68) {
        var paid3 = r1.price + rows[i + 1].price + r3.price, p6 = Math.round(mo * 6 * (100 - cfg_().offers.m6Pct) / 100), due = p6 - paid3;
        if (due > 0) out.m6 = { pkg: r1.id, type: r1.label, mo: mo, t6: mo * 6, p6: p6, paid3: paid3, due: due, each: Math.round(due / 3), save: mo * 6 - p6, starts: appShift_(r3.start, 30) };
      }
      return;                                             // on a bundle: no 3 month offer for this type
    }
    var cur = rows.filter(function (p) { return p.phase === 'current'; }).pop();
    if (!cur || rows.some(function (p) { return p.phase === 'future'; })) return;
    var half = cur.used >= cur.total / 2 || appDays_(today, cur.start) >= 15;
    var asked3 = reqs.some(function (q) { return q.type === '3 month offer' && q.pkg === cur.id && q.status !== 'Declined'; });
    if (half && !asked3) out.m3 = { pkg: cur.id, type: cur.label, mo: mo, t3: mo * 3, p3: Math.round(mo * 3 * (100 - cfg_().offers.m3Pct) / 100), save: mo * 3 - Math.round(mo * 3 * (100 - cfg_().offers.m3Pct) / 100), starts: cur.end };
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
      if (ss.length && !ss.some(function (s) { return s.clients.length < clSeats13_(); })) { out.push({ date: ymd, start: h, trainer: ss[0].trainer, state: 'full' }); return; }
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
    if (s.trainer !== cfgFixed_('Physio') || s.status === 'Cancelled' || s.date < today || s.date > until) return;
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
  if (clAt_(ymd, hm) <= Date.now()) throw new Error('This session already started. Message ' + cfgDeskName_() + '.');
  var sl = cfg.slots[i];
  if (sl.att && String(r[sl.att - 1]).trim()) throw new Error('Already marked. Message ' + cfgDeskName_() + '.');
  if (!sl.att && cfg.slots.length > 1 && String(r[sl.pass - 1]).trim()) throw new Error('Already marked. Message ' + cfgDeskName_() + '.');
  if (/cancel/i.test(String(r[cfg.status - 1]))) throw new Error('Already cancelled.');
  var kind = ymd > today ? 'Early Cancel' : 'Late Cancel';
  var whole = at.k === '1:2' && kind === 'Early Cancel';   // 1:2 is a private pair: an early cancel cancels the session for both
  var pkg = appSetAtt_(sh, cfg, row, i, kind, 'client app', '', { ping: false });   // Romy's WhatsApp comes from clLog_ below
  if (at.k === '1:3') {
    var allOut = cfg.slots.every(function (s) { return !String(sh.getRange(row, s.pkg).getValue()).trim() || /cancel/i.test(String(sh.getRange(row, s.att).getValue())); });
    if (allOut) sh.getRange(row, cfg.status).setValue('Cancelled');
  }
  appRecount_(ops, pkg);
  var name = String(r[sl.name - 1] || '');
  clLog_(ops, cid, name, 'Cancelled', kind + (kind === 'Late Cancel' ? ' (same day, counts as done)' : (whole ? ' (whole 1:2 session cancelled, partner and trainer told in the app)' : ' (session kept)')) + ' · ' + at.k + ' with ' + (cfg.fixed || appTrainer_(r[cfg.trainer - 1])), ymd + ' ' + hm + ' · ' + b.id, pkg, 'New', {});
  return { kind: kind, whole: whole };
}

function clJoin_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), ymd = String(b.date), hm = String(b.time), trainer = appTrainer_(b.trainer);
  if (clAt_(ymd, hm) - Date.now() < CL.JOIN_MIN_H * 3600000) throw new Error('Less than ' + CL.JOIN_MIN_H + ' hours away: message ' + cfgDeskName_() + ' to add you.');
  var cfg = AT['1:3'], sh = ops.getSheetByName(cfg.sheet), last = sh.getLastRow(), found = false;
  var v = sh.getRange(3, 1, last - 2, cfg.width).getValues(), dv = sh.getRange(3, 1, last - 2, cfg.width).getDisplayValues();
  for (var i = 0; i < v.length; i++) {
    if (!v[i][0] || appYmd_(v[i][1], dv[i][1]) !== ymd || appHm_(dv[i][2]) !== hm || appTrainer_(v[i][cfg.trainer - 1]) !== trainer) continue;
    if (/cancel/i.test(String(v[i][cfg.status - 1]))) continue;
    if (cfg.slots.some(function (sl) { return !String(v[i][sl.pkg - 1]).trim(); })) { found = true; break; }
  }
  if (!found) throw new Error('This spot was just taken. Pick another one.');
  // the client's 1:3 package that covers that day, with a pass left that is not already booked
  // (same rule as canJoin in clBoot_: passes left minus upcoming sessions not marked yet)
  var pv = ops.getSheetByName('PACKAGES').getDataRange().getValues(), cands = [], pkg = null, name = '', now = Date.now();
  var today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  for (var j = 2; j < pv.length; j++) {
    var r = pv[j];
    if (String(r[1]).trim().toUpperCase() !== cid || String(r[13]).trim() !== 'Active' || cfgKind_(r[3]) !== '1:3' || !String(r[0]).trim()) continue;
    var end = appYmd_(r[12]) || appYmd_(r[11]) || appYmd_(r[10]);
    if (appYmd_(r[9]) > ymd || (end && ymd > end)) continue;
    cands.push({ id: String(r[0]).trim(), name: String(r[2]), left: (Number(r[4]) || 0) - (Number(r[5]) || 0) });
  }
  if (!cands.some(function (p) { return p.left > 0; })) throw new Error('No group sessions left on your package. Message ' + cfgDeskName_() + ' to renew.');
  var booked = {};
  appSessions_(ops, appShift_(today, -1), appShift_(today, Math.max(APP.AHEAD_DAYS, CL.JOIN_DAYS) + 1), null).forEach(function (s) {
    if (s.status === 'Cancelled') return;
    var sat = clAt_(s.date, s.start);
    s.clients.forEach(function (c) { if (!c.att && sat > now - 3600000) booked[c.pkg] = (booked[c.pkg] || 0) + 1; });
  });
  var pick = cands.filter(function (p) { return p.left - (booked[p.id] || 0) > 0; })[0];
  if (!pick) throw new Error('Every session left on your package is already booked. Cancel one, or message ' + cfgDeskName_() + ' to renew.');
  pkg = pick.id; name = pick.name;
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
    if (reqs.some(function (q) { return q.cid === cid && q.type === 'Physio visit' && q.status === 'New'; })) throw new Error('You already have a physio request waiting. ' + cfgDeskName_() + ' will confirm it soon.');
    var sess = appSessions_(ops, today, appShift_(today, CL.PHYSIO_DAYS + 1), null);
    var ok = clSlots_(sess, reqs, today).some(function (s) { return s.d === b.d && s.t === b.t; });
    if (!ok) throw new Error('This time was just taken. Pick another one.');
    clLog_(ops, cid, name, 'Physio visit', 'Physio visit with ' + cfgFixed_('Physio') + ', $' + CL.PHYSIO_PRICE + ' (was $' + CL.PHYSIO_WAS + ')' + (note ? ' · ' + note : ''), b.d + ' ' + b.t, '', 'New', { d: b.d, t: b.t });
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
    var ref = typeof refInvite_ === 'function' ? refInvite_(ops, cid, name, fn, ph) : null;   // REFERRALS tab (Referral.gs); refuses your own number
    var inv = 'https://wa.me/' + ph + '?text=' + encodeURIComponent(String(b.msg || '').slice(0, 300));
    var refTxt = !ref ? '' : ' Referral ' + ref.id + (ref.status === 'Invited' ? ': ' + name + ' gets $' + refAmount_() + ' credit when ' + fn + ' buys a first paid package.' : ' (' + ref.status + ', no credit).');
    var reqId = clLog_(ops, cid, name, 'Friend invite', name + ' would like to invite ' + fn + ' (+' + ph + ') to Wellbe.' + refTxt + ' Tap to send them the invite: ' + inv, '', '', 'New', { fname: fn, phone: ph, ref: ref ? ref.id : '' });
    if (ref && !ref.again) refSetReq_(ops, ref.row, reqId);
    return ref ? { ref: { id: ref.id, status: ref.status } } : {};
  }
  throw new Error('Unknown request');
}

// 6 months: months 4, 5, 6 are created now, priced as the remaining payment split in 3
function clUpgrade6_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var reqs = appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && String(r[2]).toUpperCase() === cid; }).map(clReqObj_);
  var pk = clPkgsOf_(ops, cid, today), o = clOffers_(pk, reqs, today).m6;
  if (!o) throw new Error('The 6 month upgrade is not open on your package right now.');
  // nothing is created now: Romy accepts it in her To do (appReqDone_), then months 4, 5, 6 are added
  var src = pk.filter(function (p) { return p.id === o.pkg; })[0], name = appClientInfo_(cid).name;
  o.ptype = src ? src.type : '';
  clLog_(ops, cid, name, '6 month upgrade', 'Wants the 6 month upgrade: pays $' + o.due + ' at the center (' + cfg_().offers.m6Pct + '% off, $' + o.each + ' a month for months 4 to 6, starting ' + o.starts + '). Accept to add months 4, 5 and 6.', '', o.pkg, 'New', o);
  return { due: o.due, ids: [] };
}

// =====================================================================
// STAFF SIDE: requests in Romy's To do (App.gs boot + app_req_done)
// =====================================================================
function clStaffRequests_(ops) {
  return appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).filter(function (r) { return r[0] && String(r[8]) === 'New'; }).map(clReqObj_);
}

// act: done | decline | accept  (accept: physio = sell $40 visit + book it, freeze = +7 days, 3 month offer = create the 3 months,
//                               6 month upgrade = create months 4, 5, 6)
function appReqDone_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
  var v = sh.getRange(1, 1, sh.getLastRow(), CL.REQ_HEAD.length).getValues(), row = -1;
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === String(b.id)) { row = i + 1; break; }
  if (row < 0) throw new Error('Request not found, refresh');
  var q = clReqObj_(v[row - 1]), out = {};
  if (q.status !== 'New') throw new Error('Already handled by ' + (q.by || 'someone')); if (q.type === 'Nutrition plan') out = nutFromReq_(q, b, me);
  if (b.act === 'accept') {
    if (q.type === 'Physio visit') {
      var x = q.slot.split(' ');
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.d || '')) && /^\d{2}:\d{2}$/.test(String(b.t || ''))) x = [String(b.d), String(b.t)];
      var sold = appSell_({ type: cfg_().offers.physioType, cid: q.cid, discount: cfg_().offers.physioPct, paid: 0, start: x[0] }, me);
      var bk = appBookInto_(ops, 'PP', x[0], x[1], cfgFixed_('Physio'), sold.id, q.client, 'Physio');
      out = { pkg: sold.id, session: bk.id };
    } else if (q.type === 'Freeze') {
      out = { end: clFreezeApply_(ops, q.pkg, q.data.from || '', me.name) };
    } else if (q.type === '3 month offer') {
      var o = q.data, made = [], cur = clPkgsOf_(ops, q.cid, '0000-00-00').filter(function (p) { return p.id === q.pkg; })[0];
      if (!cur) throw new Error('Package ' + q.pkg + ' not found');
      var each = Math.round(o.p3 / 3);
      for (var k = 0; k < 3; k++) made.push(clAddPkg_(ops, q.cid, q.client, cur.type, k < 2 ? each : o.p3 - each * 2, appShift_(o.starts || cur.end, 30 * k), 0.07, '3 month bundle (7% off, one payment), month ' + (k + 1) + ' of 3. From the client app.'));
      out = { ids: made };
    } else if (q.type === '6 month upgrade') {
      var o6 = q.data || {}, all6 = clPkgsOf_(ops, q.cid, '0000-00-00'), src6 = all6.filter(function (p) { return p.id === q.pkg; })[0];
      if (!src6) throw new Error('Package ' + q.pkg + ' not found');
      if (!(Number(o6.due) > 0) || !o6.starts) throw new Error('This request has no offer details: add months 4 to 6 by hand');
      var type6 = o6.ptype || src6.type;
      if (all6.some(function (p) { return p.type === type6 && p.start === o6.starts; })) throw new Error('Months 4 to 6 already exist for this client (made before this update). Tap done instead.');
      var made6 = [], each6 = Number(o6.each) || Math.round(o6.due / 3);
      for (var k6 = 0; k6 < 3; k6++) made6.push(clAddPkg_(ops, q.cid, q.client, type6, k6 < 2 ? each6 : o6.due - each6 * 2, appShift_(o6.starts, 30 * k6), 0.15, '6 month upgrade (15% off), month ' + (4 + k6) + ' of 6. Accepted by ' + me.name + ' from the client app.'));
      out = { ids: made6 };
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
// WhatsApp ping to Romy for every new client app request: queued, sent after the lock is free
// (CallMeBot: ROMY_WA + ROMY_KEY in Script Properties, see setupSecrets_help in Code)
function clPingRomy_(msg) { notifyLater_(msg, 'romy'); }

// ---------- the client's promise + 3 keys (AI when ANTHROPIC_KEY is set in Script Properties, otherwise a smart template) ----------
function clGoalsMap_(ops) {
  var out = {};
  appRows_(ops, 'CLIENT GOALS', 2, CL.GOAL_HEAD.length).forEach(function (r) {
    if (r[0] && r[2]) out[String(r[0]).toUpperCase()] = { promise: String(r[2]), keys: [String(r[3]), String(r[4]), String(r[5])].filter(String), updated: String(r[6]) };
  });
  return out;
}
// runs BEFORE the script lock (client_route_): checks, rate limit and the AI call
function clGoalPre_(b, cid) {
  var promise = String(b.promise || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  if (promise.length < 4) throw new Error('Write your promise first.');
  var cache = CacheService.getScriptCache(), n = Number(cache.get('clgoal|' + cid) || 0);
  if (n >= 6) throw new Error('You changed it a lot today. Try again tomorrow.');
  cache.put('clgoal|' + cid, String(n + 1), 86400);
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), info = appClientInfo_(cid) || {}, first = String(info.name || '').split(' ')[0];
  var kinds = clPkgsOf_(ops, cid, Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd')).filter(function (p) { return p.phase !== 'past'; }).map(function (p) { return p.label; });
  var keys = null;
  try { keys = clGoalAI_(promise, first, kinds); } catch (e) { Logger.log('AI goal failed: ' + e); }
  return { promise: promise, keys: keys, name: info.name || cid };
}
// under the lock: only the sheet write
function clGoal_(b, cid) {
  var pre = b._pre || clGoalPre_(b, cid), promise = pre.promise, keys = pre.keys, by = keys ? 'AI' : 'template';
  if (!keys) keys = clGoalTemplate_(promise);
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  var sh = appTab_(ops, 'CLIENT GOALS', CL.GOAL_HEAD), now = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var row = [cid, cellSafe_(pre.name), clean_(promise, 240), cellSafe_(keys[0]), cellSafe_(keys[1]), cellSafe_(keys[2]), now, by], at = ids.indexOf(cid);
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
  if (/pain|back|knee|neck|shoulder|injur|hurt|hip|posture/.test(p)) return ['Do your 10 minute mobility routine every morning', 'Never skip two sessions in a row: steady training calms pain', 'Book your monthly physio check with ' + cfgFixed_('Physio')];
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
// handled (optional): { by, at } when the request is logged as already done by staff
function clLog_(ops, cid, name, type, details, slot, pkg, status, data, handled) {
  var sh = appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
  var id = nextId_(sh, 'REQ-', 4);   // highest + 1 (under the lock): never a duplicate after a row is deleted
  sh.appendRow([id, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), cid, cellSafe_(name), cellSafe_(type), cellSafe_(String(details).slice(0, 900)), cellSafe_(slot), cellSafe_(pkg), status,
    handled ? cellSafe_(handled.by) : '', handled ? handled.at : '', JSON.stringify(data || {}).slice(0, 4000)]);
  if (status === 'New' && clPingOk_(cid)) clPingRomy_('Wellbe app: ' + name + ' · ' + type + (slot ? ' · ' + slot : '') + '\n' + String(details).slice(0, 300) + '\nOpen your To do in the staff app.');
  return id;
}
// at most one WhatsApp to Romy per client every 10 minutes (CallMeBot bans numbers that get spammed).
// Every request is still saved and shows in her To do list.
function clPingOk_(cid) {
  try {
    var c = CacheService.getScriptCache(), k = 'romyping|' + String(cid || '').toUpperCase();
    if (c.get(k)) return false;
    c.put(k, '1', 600);
  } catch (e) {}
  return true;
}
function clPkgIds_(ops, cid) {
  var v = ops.getSheetByName('PACKAGES').getDataRange().getValues(), out = {};
  for (var i = 2; i < v.length; i++) if (String(v[i][1]).trim().toUpperCase() === cid) out[String(v[i][0]).trim()] = 1;
  return out;
}
function clPkgsOf_(ops, cid, today) {
  var out = [];
  pkgsAll_(ops).forEach(function (x) {
    if (x.cid !== cid) return;
    var p = { id: x.id, type: x.type, total: x.total, used: x.used, price: x.price, start: x.start, end: x.d12 || x.d10, status: x.status.trim() };
    p.label = p.type.replace(/\s*\(\$[^)]*\)/, '');
    p.phase = pkgPhase_(p, today);
    out.push(p);
  });
  return out;
}
// same row layout as appSell_
function clAddPkg_(ops, cid, name, type, price, startYmd, disc, note) {
  var sh = ops.getSheetByName('PACKAGES'), t = cfgType_(type), total = t ? t.passes : 12;
  var start = beirutDate_(startYmd, 0), exp = beirutDate_(appShift_(startYmd, 30), 0);
  var info = scanIds_(sh, 0, /^(PKG-)(\d+)$/i, 'PKG-', 4), id = info.prefix + String(info.max + 1).padStart(info.pad, '0');
  var row = [id, cid, name, type, total, 0, total, total ? Math.round(price / total * 100) / 100 : 0, price, start, exp, '', exp, 'Active', '', 'N', '', '', '', disc, note, 0, ''];
  writeLikeTemplate_(sh, info.lastRow + 1, info.lastRow, row, null, id);
  var r = info.lastRow + 1;
  sh.getRange(r, 10, 1, 4).setNumberFormat('dd/MM/yyyy');
  if (!sh.getRange(r, 23).getFormula()) sh.getRange(r, 23).setFormula('=IF(I' + r + '="","",IF(V' + r + '="",I' + r + ',I' + r + '-V' + r + '))');
  if (typeof refOnSale_ === 'function') refOnSale_(ops, cid);   // referral credit if this is an invited friend's first paid package (Referral.gs)
  return id;
}
// ---------- delete account (clients and guests): action app_cl_delete ----------
// Romy gets a 'Delete account' request, the DELETION REQUESTS tab gets a row, and every sign in of this email stops working.
var DEL_HEAD = ['ID', 'Created', 'Email', 'Account IDs', 'Names', 'Status', 'Done by', 'Done at'];
function clDelete_(b, cid, who) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), ids = who.ids.join(', '), names = (who.acc || []).map(function (a) { return a.name; }).join(', ');
  var sh = appTab_(ops, 'DELETION REQUESTS', DEL_HEAD), id = nextId_(sh, 'DEL-', 4);
  sh.appendRow([id, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), cellSafe_(who.email), ids, cellSafe_(names), 'New', '', '']);
  clLog_(ops, cid, ((who.acc || [])[0] || {}).name || cid, 'Delete account', 'Asked to delete their Wellbe app account and data (' + who.email + ' · ' + ids + '). Do it within 7 days and tick ' + id + ' in DELETION REQUESTS. They are signed out of the app.', '', '', 'New', { email: who.email, ids: who.ids, del: id });
  clDeny_(who.email);
  CacheService.getScriptCache().remove('clacc|' + who.email);
  return { msg: 'We will delete your account and data within 7 days.' };
}
// email -> time of the deletion request; tokens made before it are refused in clWho_
function clDeleted_() { try { return JSON.parse(propGet_('CL_DELETED') || '{}'); } catch (e) { return {}; } }
function clDeny_(email) {
  var m = clDeleted_(), old = Date.now() - (CL.TOKEN_DAYS + 1) * 864e5;
  Object.keys(m).forEach(function (k) { if (m[k] < old) delete m[k]; });   // older tokens are expired anyway
  m[email] = Date.now();
  propSet_('CL_DELETED', JSON.stringify(m));
}
// action app_cl_notice_read { ids: [...] }
function clNoticeRead_(b, cid, who) { return { read: noticeMarkRead_(SpreadsheetApp.openById(CFG.OPS_ID), b.ids || [], who.ids) }; }

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