// =====================================================================
// GUESTS: people who are not Wellbe clients yet (client app)
// Add as a NEW FILE called "Guest" in the "Wellbe W40 Backend" project.
//
// Flow: "I'm new to Wellbe" -> name + email -> 6 digit code -> guest account (APP GUESTS tab, made only once the code is right).
// A guest sees the Wellbe page (why us, services, packages), Play and the 3 keys streak.
// Free trial, free 15 min coach call and package requests become a lead in LEADS W40
// (same pipeline as the landing page: Romy confirms -> client + trial package + session).
// The moment their email is in CLIENTS (trial confirmed, or Romy adds them), the app
// switches to the full client app by itself, and their game + streak follow them.
// =====================================================================
var GUEST = {
  TAB: 'APP GUESTS',
  HEAD: ['Guest ID', 'Email', 'Name', 'Phone', 'Created', 'Verified', 'Lead ID', 'Asked', 'Client ID'],
  MOVE_TABS: ['CORNICHE RUN', 'CLIENT STREAKS', 'CLIENT GOALS']   // rows that follow the guest when they become a client
};

function guestSheet_() { return appTab_(SpreadsheetApp.openById(CFG.OPS_ID), GUEST.TAB, GUEST.HEAD); }
function guestAll_() {
  var sh = guestSheet_(), n = sh.getLastRow(); if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, GUEST.HEAD.length).getDisplayValues().map(function (r, i) {
    return { row: i + 2, id: r[0], email: String(r[1]).toLowerCase(), name: r[2], phone: r[3], created: r[4], verified: r[5], lead: r[6], asked: r[7], cid: r[8] };
  });
}
function guestFind_(email) {
  var c = CacheService.getScriptCache(), k = 'gst|' + email, hit = c.get(k);
  if (hit) return hit === '-' ? null : JSON.parse(hit);
  var g = guestAll_().filter(function (x) { return x.email === email; })[0] || null;
  c.put(k, g ? JSON.stringify(g) : '-', 600);
  return g;
}
function guestById_(id) { return guestAll_().filter(function (x) { return x.id === String(id).toUpperCase(); })[0] || null; }
function guestSet_(g, col, val) {   // col = header name
  var sh = guestSheet_(), j = GUEST.HEAD.indexOf(col);
  sh.getRange(g.row, j + 1).setValue(val);
  CacheService.getScriptCache().remove('gst|' + g.email);
}
// called from clLogin_ under the script lock, only AFTER the email code is checked
function guestCreate_(email, name) {
  var sh = guestSheet_(), id = nextId_(sh, 'G', 4);   // highest + 1: unique even after a row is deleted
  sh.appendRow([id, cellSafe_(email), cellSafe_(name), '', Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), '', '', '', '']);
  CacheService.getScriptCache().remove('gst|' + email);
  return guestFind_(email);
}
// first verified sign in: tell Majd and Romy
function guestVerified_(email) {
  if (clAccounts_(email).length) return;
  var g = guestFind_(email); if (!g || g.verified) return;
  guestSet_(g, 'Verified', Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'));
  alert_('NEW APP SIGN UP (not a client yet)\n' + g.name + '\n' + email + '\nThey are looking at the packages. If they ask for a trial or a call, you get another message.');
}

// a guest who now has a CLIENTS row: game, streak and promise move to the client ID (once)
function guestConvert_(g, cid) {
  if (!g || g.cid || !cid) return;
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  GUEST.MOVE_TABS.forEach(function (t) {
    var sh = ops.getSheetByName(t); if (!sh || sh.getLastRow() < 2) return;
    var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); });
    var at = ids.indexOf(g.id); if (at < 0 || ids.indexOf(cid) > -1) return;
    sh.getRange(at + 2, 1).setValue(cid);
  });
  guestSet_(g, 'Client ID', cid);
}

// ---------------------------------------------------------------------
// READ: the guest app
// ---------------------------------------------------------------------
function guestBoot_(who) {
  var g = who.guest, ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var goals = clGoalsMap_(ops), asked = {};
  try { asked = JSON.parse(g.asked || '{}'); } catch (e) {}
  var trial = null;
  if (g.lead) {
    var sh = leadsSheet_(), v = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), LH.length).getDisplayValues();
    for (var i = 0; i < v.length; i++) if (v[i][L.ID] === g.lead) {
      if (v[i][L.DATE] && /Pending|Confirmed/.test(v[i][L.STATUS])) trial = { date: v[i][L.DATE], time: v[i][L.TIME], status: v[i][L.STATUS] };
      break;
    }
  }
  var pkgs = APP.TYPES.filter(function (t) { return t[2] > 0 && !/trial|with mel|streak/i.test(t[0]); })
    .map(function (t) { return { name: t[0], label: String(t[0]).replace(/\s*\(\$[^)]*\)/, ''), n: t[1], price: t[2], kind: appKind_(t[0]) }; });
  return {
    ok: true, guest: { id: g.id, phone: g.phone, trial: trial, asked: asked, slots: trial ? [] : getSlots_().days, packages: pkgs },
    today: today, now: Date.now(), email: who.email, wa: CL.WA, friend: CL.FRIEND, review: CL.REVIEW, slots: [], shop: [],
    physio: { price: CL.PHYSIO_PRICE, was: CL.PHYSIO_WAS },
    accounts: [{ cid: g.id, name: g.name, first: String(g.name).split(' ')[0], full: false, guest: true, pkgs: [], upcoming: [], past: [], requests: [], goal: goals[g.id] || null }]
  };
}

// ---------------------------------------------------------------------
// ACTION app_cl_guest  op: trial {date, hour, phone} | call {phone, note} | pkg {pkg, phone}
// ---------------------------------------------------------------------
function guestAct_(b, gid, who) {
  var g = guestFind_(who.email); if (!g || g.id !== gid) throw new Error('Please sign in again.');
  var phone = clean_(b.phone || g.phone, 30);
  if (phoneKey_(phone).length < 7) throw new Error('Type your WhatsApp number so Romy can confirm.');
  if (phone !== g.phone) { guestSet_(g, 'Phone', phone); g.phone = phone; }
  var lead = g.lead;
  if (!lead) {
    var r = saveLead_({ name: g.name, phone: phone, email: g.email, source: 'Client app' });
    if (!r.ok) throw new Error(r.error);
    lead = r.leadId; guestSet_(g, 'Lead ID', lead);
  }
  var asked = {}; try { asked = JSON.parse(g.asked || '{}'); } catch (e) {}
  var op = String(b.op), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), out = {};
  if (op === 'trial') {
    var res = book_({ leadId: lead, date: String(b.date || ''), hour: Number(b.hour) });
    if (!res.ok) throw new Error(res.error);
    out.trial = { date: res.date, time: hourLabel_(res.hour), status: 'Pending' };
  } else if (op === 'call') {
    if (asked.call === today) throw new Error('Your call request is in. The coach will WhatsApp you soon.');
    guestNote_(lead, 'Client app: wants a free 15 min coach call' + (b.note ? ' (' + clean_(b.note, 200) + ')' : ''));
    alert_('APP: FREE COACH CALL REQUEST\n' + g.name + '\n' + phone + '\n' + g.email + (b.note ? '\nGoal: ' + clean_(b.note, 200) : '') + '\nWhatsApp them within the hour.');
    asked.call = today;
  } else if (op === 'pkg') {
    var t = APP.TYPES.filter(function (x) { return x[0] === b.pkg; })[0];
    if (!t) throw new Error('Pick a package.');
    guestNote_(lead, 'Client app: wants ' + t[0] + ', pays at the center');
    alert_('APP: PACKAGE REQUEST\n' + g.name + '\n' + phone + '\n' + g.email + '\nWants: ' + t[0] + '\nWhatsApp them to set the start date. They pay at the center.\nUse this email when you add them, so their app turns into the client app.');
    asked.pkg = t[0]; asked.pkgDate = today;
  } else throw new Error('unknown');
  guestSet_(g, 'Asked', JSON.stringify(asked));
  out.asked = asked;
  return out;
}
function guestNote_(leadId, text) {
  var sh = leadsSheet_(), ids = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues();
  for (var i = 1; i < ids.length; i++) if (ids[i][0] === leadId) {
    var c = sh.getRange(i + 1, L.NOTES + 1);
    c.setValue(appendNote_(String(c.getValue() || ''), text + ' ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM HH:mm')));
    return;
  }
}