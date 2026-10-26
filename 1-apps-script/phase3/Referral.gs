// =====================================================================
// REFERRALS: "Invite a friend" in the client app -> wallet credit for the client who invited
// Add as a NEW FILE called "Referral" in the "Wellbe W40 Backend" project.
//
// 1. A client sends an invite (client app, action app_cl_request kind invite, Client.gs):
//    a row goes into the REFERRALS tab (made by itself the first time) next to Romy's request.
//    Friend phone is saved normalized (phoneKey_ in Code.gs: no spaces, no +961 / 961 / leading 0).
// 2. A package is sold (staff app app_sell, appSell_ in App.gs, the 3 / 6 month offers in Client.gs):
//    refOnSale_ checks the buyer. When the buyer is an invited friend and this is their FIRST PAID
//    package (price above 0, not a trial or free type), the client who invited them gets the credit
//    in CLIENT WALLET: + amount, Reason "Referral: <friend name>", Package = the friend's package, By "auto".
//    Rules: once per friend phone; the first client who invited that phone wins; never to yourself;
//    nothing when the friend already had a paid package when the invite was sent.
//    Running it twice changes nothing (the row says Rewarded, the wallet line is checked first).
// 3. The amount is the setting referral.amount (SETTINGS tab, default 5). 0 = referrals off.
//
// Statuses in the REFERRALS tab:
//   Invited           waiting for the friend's first paid package
//   Rewarded          credit given (Friend client ID, Friend package, Credit, Rewarded at filled)
//   Already a client  the friend had a paid package before the invite: no credit
//   Already invited   another client invited this phone first: no credit
//   Not eligible      self referral found later (same person): no credit
// =====================================================================
var REF = {
  TAB: 'REFERRALS',
  HEAD: ['ID', 'Date', 'Referrer ID', 'Referrer', 'Friend', 'Friend phone', 'Status', 'Friend client ID', 'Friend package', 'Credit', 'Rewarded at', 'Request ID', 'Last package at invite', 'Note'],
  WALLET_TAB: 'CLIENT WALLET',
  WALLET_HEAD: ['Date', 'Client ID', 'Client', 'Amount', 'Reason', 'Package', 'By']
};
var RC = { ID: 0, DATE: 1, BY: 2, BYNAME: 3, FRIEND: 4, PHONE: 5, STATUS: 6, FCID: 7, FPKG: 8, CREDIT: 9, AT: 10, REQ: 11, MARK: 12, NOTE: 13 };

function refAmount_() { var r = cfg_().referral || {}, n = Number(r.amount); return n > 0 ? n : 0; }
function refKey_(p) { return phoneKey_(p); }
function refNow_() { return Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'); }
function refTab_(ops) { return appTab_(ops, REF.TAB, REF.HEAD); }

// every referral row, oldest first (row order = invite order)
function refRows_(ops) {
  var sh = ops.getSheetByName(REF.TAB); if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, REF.HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[RC.ID]).trim(), date: r[RC.DATE], by: String(r[RC.BY]).trim().toUpperCase(), byName: String(r[RC.BYNAME]),
      friend: String(r[RC.FRIEND]), key: refKey_(r[RC.PHONE]), status: String(r[RC.STATUS]).trim(), fcid: String(r[RC.FCID]).trim().toUpperCase(),
      pkg: String(r[RC.FPKG]), credit: Number(r[RC.CREDIT]) || 0, at: r[RC.AT], mark: Number(r[RC.MARK]) || 0 };
  }).filter(function (x) { return x.id; });
}
function refSet_(ops, row, fields) {   // fields: { col index: value }
  var sh = refTab_(ops);
  Object.keys(fields).forEach(function (c) { sh.getRange(row, Number(c) + 1).setValue(fields[c]); });
}
function refSetReq_(ops, row, reqId) { var f = {}; f[RC.REQ] = reqId; refSet_(ops, row, f); }

// PACKAGES: highest PKG number and each client's paid packages (price above 0, not trial / free, not cancelled)
function refPkgNum_(id) { var m = String(id || '').match(/(\d+)\s*$/); return m ? Number(m[1]) : 0; }
function refPkgInfo_(ops) {
  var sh = ops.getSheetByName('PACKAGES'), out = { max: 0, paidBy: {} };
  if (!sh || sh.getLastRow() < 3) return out;
  sh.getRange(3, 1, sh.getLastRow() - 2, 14).getValues().forEach(function (r) {
    var id = String(r[0] || '').trim(); if (!/^PKG-/i.test(id)) return;
    var n = refPkgNum_(id); if (n > out.max) out.max = n;
    var cid = String(r[1] || '').trim().toUpperCase(), t = cfgType_(String(r[3] || ''));
    var price = typeof appNum_ === 'function' ? appNum_(r[8]) : Number(r[8]);
    if (!(Number(price) > 0) || (t && (t.trial || t.free)) || /cancel/i.test(String(r[13] || ''))) return;
    (out.paidBy[cid] = out.paidBy[cid] || []).push({ id: id, num: n });
  });
  Object.keys(out.paidBy).forEach(function (c) { out.paidBy[c].sort(function (a, b) { return a.num - b.num; }); });
  return out;
}

// who is behind a phone: client records (CLIENTS col D), leads (LEADS W40 phone -> client ID), app guests (phone -> client ID)
// keysOf[cid] = { phoneKey: 1 }, cidsOf[phoneKey] = { cid: 1 }, known[phoneKey] = 1 (a client, a lead or a guest: they joined)
function refIndex_(ops) {
  var out = { keysOf: {}, cidsOf: {}, known: {} };
  var link = function (cid, key) {
    if (!key || key.length < 6) return;
    out.known[key] = 1;
    cid = String(cid || '').trim().toUpperCase(); if (!/^C\d+$/.test(cid)) return;
    (out.keysOf[cid] = out.keysOf[cid] || {})[key] = 1;
    (out.cidsOf[key] = out.cidsOf[key] || {})[cid] = 1;
  };
  try {
    var cs = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB);
    if (cs) cs.getDataRange().getDisplayValues().forEach(function (r, i) { if (i) link(r[0], refKey_(r[3])); });
  } catch (e) { Logger.log('Referral: clients not read ' + e); }
  var ls = ops.getSheetByName(CFG.LEADS_TAB);
  if (ls && ls.getLastRow() > 1) ls.getRange(2, 1, ls.getLastRow() - 1, L.CID + 1).getDisplayValues().forEach(function (r) { if (r[L.ID]) link(r[L.CID], refKey_(r[L.PHONE])); });
  var gs = ops.getSheetByName('APP GUESTS');
  if (gs && gs.getLastRow() > 1) gs.getRange(2, 1, gs.getLastRow() - 1, 9).getDisplayValues().forEach(function (r) { if (r[0]) link(r[8], refKey_(r[3])); });
  return out;
}

// =====================================================================
// 1. THE INVITE (Client.gs clRequest_, kind invite). Throws on a self referral.
// returns { id, status, row } (or the row already there when the same client invites the same phone again)
// =====================================================================
function refInvite_(ops, cid, name, friend, phone) {
  cid = String(cid).toUpperCase();
  var key = refKey_(phone);
  if (key.length < 6) throw new Error('Check the phone number.');
  var me = appClientInfo_(cid) || {}, idx = refIndex_(ops), fc = Object.keys(idx.cidsOf[key] || {});
  if (refKey_(me.phone) === key || fc.indexOf(cid) > -1 || (idx.keysOf[cid] || {})[key]) throw new Error('This is your own number. Invite a friend instead.');
  var rows = refRows_(ops), same = rows.filter(function (r) { return r.key === key; });
  var mine = same.filter(function (r) { return r.by === cid; })[0];
  if (mine) return { id: mine.id, status: mine.status, row: mine.row, again: true };
  var pk = refPkgInfo_(ops), status = 'Invited', note = '';
  var paidFriend = fc.filter(function (c) { return (pk.paidBy[c] || []).length; })[0];
  if (paidFriend) { status = 'Already a client'; note = paidFriend + ' already had a paid package'; }
  else if (same.length) { status = 'Already invited'; note = 'Invited first by ' + same[0].byName + ' (' + same[0].id + ')'; }
  var sh = refTab_(ops), id = nextId_(sh, 'REF-', 4);
  sh.appendRow([id, refNow_(), cid, cellSafe_(name), cellSafe_(friend), key, status, paidFriend || fc[0] || '', '', '', '', '', pk.max, cellSafe_(note)]);
  var row = sh.getLastRow();
  sh.getRange(row, RC.PHONE + 1).setNumberFormat('@').setValue(key);   // a phone stays text in the sheet
  return { id: id, status: status, row: row };
}

// =====================================================================
// 2. THE REWARD: call after any package is created for a client. Safe to call many times.
// returns { id, by, byName, friend, amount, pkg } when credit was given now, else null. Never throws.
// =====================================================================
function refOnSale_(ops, cid) {
  try { return refOnSaleRun_(ops, String(cid || '').trim().toUpperCase()); }
  catch (e) { Logger.log('Referral check failed for ' + cid + ': ' + (e && e.message || e)); return null; }
}
function refOnSaleRun_(ops, cid) {
  var amt = refAmount_(); if (!amt || !/^C\d+$/.test(cid)) return null;
  var sh = ops.getSheetByName(REF.TAB); if (!sh || sh.getLastRow() < 2) return null;
  var pk = refPkgInfo_(ops), paid = pk.paidBy[cid] || []; if (!paid.length) return null;
  var idx = refIndex_(ops), keys = idx.keysOf[cid]; if (!keys) return null;
  var rows = refRows_(ops).filter(function (r) { return keys[r.key]; });
  if (!rows.length || rows.some(function (r) { return r.status === 'Rewarded'; })) return null;   // once per friend phone
  var r = rows.filter(function (x) { return x.status === 'Invited'; })[0];                     // the first client who invited wins
  if (!r) return null;
  var f = {};
  if (r.by === cid || (idx.keysOf[r.by] || {})[r.key]) {
    f[RC.STATUS] = 'Not eligible'; f[RC.FCID] = cid; f[RC.NOTE] = 'Self referral'; refSet_(ops, r.row, f); return null;
  }
  var before = paid.filter(function (p) { return p.num <= r.mark; }), after = paid.filter(function (p) { return p.num > r.mark; });
  if (before.length || !after.length) {
    f[RC.STATUS] = 'Already a client'; f[RC.FCID] = cid; f[RC.NOTE] = 'Paid package ' + (before[0] || paid[0]).id + ' was there before the invite'; refSet_(ops, r.row, f); return null;
  }
  var pkg = after[0].id, who = appClientInfo_(r.by) || { name: r.byName }, reason = 'Referral: ' + r.friend;
  if (!refWalletHas_(ops, r.by, reason, pkg)) refWalletAdd_(ops, r.by, who.name || r.byName, amt, reason, pkg);
  f[RC.STATUS] = 'Rewarded'; f[RC.FCID] = cid; f[RC.FPKG] = pkg; f[RC.CREDIT] = amt; f[RC.AT] = refNow_();
  refSet_(ops, r.row, f);
  try {
    if (typeof noticeAdd_ === 'function') noticeAdd_(ops, r.by, 'Referral credit', String(r.friend).split(' ')[0] + ' joined Wellbe. $' + amt + ' Wellbe Credit is ready for your next package. Thank you for sharing Wellbe!');
  } catch (e) { Logger.log('Referral notice not saved: ' + e); }
  return { id: r.id, by: r.by, byName: who.name || r.byName, friend: r.friend, amount: amt, pkg: pkg };
}

// wallet: the live Wallet.gs walletAdd_ when it is there (same as Insurance.gs), else one row in CLIENT WALLET
function refWalletAdd_(ops, cid, name, amt, reason, pkg) {
  if (typeof walletAdd_ === 'function') return walletAdd_(ops, cid, name, amt, reason, pkg, 'auto');
  appTab_(ops, REF.WALLET_TAB, REF.WALLET_HEAD).appendRow([new Date(), cid, cellSafe_(name), amt, cellSafe_(reason), pkg, 'auto']);
}
function refWalletHas_(ops, cid, reason, pkg) {
  return appRows_(ops, REF.WALLET_TAB, 2, 7).some(function (w) {
    return String(w[1]).trim().toUpperCase() === cid && String(w[4]).replace(/^'/, '') === reason && String(w[5]) === String(pkg);
  });
}
function refWalletBal_(ops, cid) {
  var s = 0;
  appRows_(ops, REF.WALLET_TAB, 2, 7).forEach(function (w) { if (String(w[1]).trim().toUpperCase() === cid) s += Number(w[3]) || 0; });
  return Math.round(s * 100) / 100;
}

// =====================================================================
// 3. WHAT THE APPS SEE
// =====================================================================
// client app boot: a.refs = this client's invites, a.credit = wallet balance (real money for packages, not the game Cash)
// st: invited | joined (the friend is a lead, guest or client now) | earned | already (another client invited first) | client (already a client)
function refClientBoot_(d) {
  try {
    if (!d || !d.accounts || !d.accounts.length) return d;
    var ops = SpreadsheetApp.openById(CFG.OPS_ID), ids = {};
    d.accounts.forEach(function (a) { ids[a.cid] = 1; });
    var rows = refRows_(ops).filter(function (r) { return ids[r.by]; }), idx = rows.length ? refIndex_(ops) : null;
    d.accounts.forEach(function (a) {
      a.refs = rows.filter(function (r) { return r.by === a.cid; }).reverse().slice(0, 20).map(function (r) {
        var st = { 'Rewarded': 'earned', 'Already invited': 'already', 'Already a client': 'client', 'Not eligible': 'client' }[r.status] || (idx.known[r.key] ? 'joined' : 'invited');
        return { n: r.friend, d: refYmd_(r.date), st: st, amt: r.credit || 0 };
      });
      var bal = refWalletBal_(ops, a.cid); if (bal > 0) a.credit = bal;
    });
  } catch (e) { Logger.log('Referral client boot: ' + e); }
  return d;
}
// staff app boot (owner and front desk): d.refs = every referral, with the client IDs the friend phone belongs to
// due = the friend's first paid package will give the credit (the sell screen shows "Referred by X")
function refStaffBoot_(d, me) {
  try {
    if (!d || !me || me.role === 'trainer') return d;
    var ops = SpreadsheetApp.openById(CFG.OPS_ID), rows = refRows_(ops);
    d.referral = { amount: refAmount_() };
    if (!rows.length) { d.refs = []; return d; }
    var idx = refIndex_(ops), pk = refPkgInfo_(ops), first = {};
    d.refs = rows.map(function (r) {
      var cids = Object.keys(idx.cidsOf[r.key] || {}), o = { id: r.id, by: r.by, byName: r.byName, friend: r.friend, phone: r.key, st: r.status, d: refYmd_(r.date), cids: cids, fcid: r.fcid, pkg: r.pkg, amt: r.credit };
      if (r.status === 'Invited' && !first[r.key] && d.referral.amount) {
        first[r.key] = 1;
        o.due = cids.filter(function (c) { return c !== r.by && !(pk.paidBy[c] || []).some(function (p) { return p.num <= r.mark; }); });
      }
      return o;
    });
  } catch (e) { Logger.log('Referral staff boot: ' + e); }
  return d;
}
function refYmd_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}

// from the editor, any time: gives the credit for packages typed straight into the PACKAGES tab (not sold in the app)
function refCheckAll() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), idx = refIndex_(ops), done = {}, n = 0;
  refRows_(ops).forEach(function (r) {
    if (r.status !== 'Invited') return;
    Object.keys(idx.cidsOf[r.key] || {}).forEach(function (c) { if (done[c]) return; done[c] = 1; if (refOnSale_(ops, c)) n++; });
  });
  if (n && typeof appBump_ === 'function') appBump_();
  Logger.log('Referral credits given now: ' + n);
}

// run once from the editor (optional): creates the REFERRALS tab and logs the amount
function refSetup() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  refTab_(ops);
  Logger.log('REFERRALS tab ready. Referral credit: $' + refAmount_() + ' (SETTINGS key referral.amount). Rows: ' + refRows_(ops).length);
}
