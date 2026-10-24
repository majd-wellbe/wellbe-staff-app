// =====================================================================
// INSURANCE: clients whose insurance pays 100% (e.g. NextCare)
// INSURANCE CLIENTS tab: who is covered and by whom
// INSURANCE CLAIMS tab: one claim per client per month of sessions
//   claim for month M is sent between the 1st and 10th of M+1 (latest the 14th)
//   insurance pays about 90 days after it was sent
// The router holds the lock.
// =====================================================================
var INS_CLIENT_HEAD = ['Client ID', 'Client', 'Insurance', 'Member number', 'Notes', 'Updated', 'By', 'Pays per session'];
var INS_CLAIM_HEAD = ['Claim ID', 'Client ID', 'Client', 'Insurance', 'Month', 'Sessions', 'Amount', 'Packages', 'Submitted', 'Expected payment', 'Reference', 'Status', 'Paid on', 'Paid amount', 'By'];

function insClientsTab_(ops) { return appTab_(ops, 'INSURANCE CLIENTS', INS_CLIENT_HEAD); }
function insClaimsTab_(ops) { return appTab_(ops, 'INSURANCE CLAIMS', INS_CLAIM_HEAD); }
function insYmd_(v) { return v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || ''); }
function insShift_(ymd, k) { return appShift_(ymd, k); }

function insClients_(ops) {
  var sh = insClientsTab_(ops), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, INS_CLIENT_HEAD.length).getValues().filter(function (r) { return r[0] && r[2]; })
    .map(function (r) { return { cid: String(r[0]).trim().toUpperCase(), name: String(r[1]), insurer: String(r[2]), member: String(r[3]), notes: String(r[4]), rate: Number(r[7]) || cfg_().insurance.rate }; });
}
function insClaims_(ops) {
  var sh = insClaimsTab_(ops), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, INS_CLAIM_HEAD.length).getValues().filter(function (r) { return r[0]; }).map(function (r, i) {
    return { id: String(r[0]), row: i + 2, cid: String(r[1]).toUpperCase(), name: String(r[2]), insurer: String(r[3]), month: insYmd_(r[4]).slice(0, 7),
      sessions: Number(r[5]) || 0, amount: Number(r[6]) || 0, pkgs: String(r[7]), submitted: insYmd_(r[8]), expected: insYmd_(r[9]), ref: String(r[10]),
      status: String(r[11]), paidOn: insYmd_(r[12]), paidAmount: Number(r[13]) || 0 };
  });
}
function insMap_(ops) { var m = {}; insClients_(ops).forEach(function (x) { m[x.cid] = x; }); return m; }

// app_ins_set: { cid, name, insurer ('' = no longer insured), member, notes }
function insSet_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = insClientsTab_(ops), cid = String(b.cid).toUpperCase();
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
  var row = [cid, clean_(b.name, 80), clean_(b.insurer, 60), clean_(b.member, 60), clean_(b.notes, 300), Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), me.name, Number(b.rate) || cfg_().insurance.rate];
  var at = ids.indexOf(cid);
  if (at < 0) { if (row[2]) sh.appendRow(row); } else sh.getRange(at + 2, 1, 1, row.length).setValues([row]);
  return {};
}

// app_ins_submit: { cid, name, insurer, month 'yyyy-MM', sessions, amount, submitted 'yyyy-MM-dd', ref, pkgs }
function insSubmit_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid).toUpperCase(), month = String(b.month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month missing');
  if (insClaims_(ops).some(function (c) { return c.cid === cid && c.month === month; })) throw new Error('This month is already submitted');
  var amt = Number(b.amount); if (!(amt > 0)) throw new Error('Amount missing');
  var sent = /^\d{4}-\d{2}-\d{2}$/.test(String(b.submitted)) ? String(b.submitted) : Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var sh = insClaimsTab_(ops), id = nextId_(sh, 'CLM-', 4);   // highest + 1: unique even after a row is deleted
  var exp = insShift_(sent, 90);
  sh.appendRow([id, cid, clean_(b.name, 80), clean_(b.insurer, 60), "'" + month, Number(b.sessions) || 0, amt, clean_(b.pkgs, 200),
    beirutDate_(sent, 0), beirutDate_(exp, 0), clean_(b.ref, 80), 'Submitted', '', '', me.name]);
  sh.getRange(sh.getLastRow(), 9, 1, 2).setNumberFormat('dd/MM/yyyy');
  return { id: id, expected: exp };
}

// app_ins_paid: { id, amount, date } -> claim paid; money goes on the client's packages, oldest first
function insPaid_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), c = insClaims_(ops).filter(function (x) { return x.id === String(b.id); })[0];
  if (!c) throw new Error('Claim not found, refresh');
  if (c.status === 'Paid') throw new Error('Already marked paid');
  var amt = Number(b.amount); if (!(amt > 0)) throw new Error('Amount missing');
  var day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var sh = insClaimsTab_(ops);
  sh.getRange(c.row, 12, 1, 3).setValues([['Paid', beirutDate_(day, 0), amt]]);
  sh.getRange(c.row, 13).setNumberFormat('dd/MM/yyyy');
  // spread the money over the client's packages that still have a balance, the claim's packages first
  var ps = ops.getSheetByName('PACKAGES'), pv = ps.getDataRange().getValues(), list = [];
  var mine = c.pkgs.split(/[,\s]+/).filter(String);
  for (var i = 2; i < pv.length; i++) {
    if (String(pv[i][1]).trim().toUpperCase() !== c.cid || /cancel/i.test(String(pv[i][13]))) continue;
    var due = Math.round(((appNum_(pv[i][8]) || 0) - (appNum_(pv[i][21]) || 0)) * 100) / 100;
    if (due > 0) list.push({ id: String(pv[i][0]).trim(), due: due, first: mine.indexOf(String(pv[i][0]).trim()) > -1 ? 0 : 1, start: insYmd_(pv[i][9]) });
  }
  list.sort(function (a, b) { return a.first - b.first || (a.start < b.start ? -1 : 1); });
  var left = amt;
  list.forEach(function (p) {
    if (left <= 0) return;
    var take = Math.min(left, p.due);
    appPay_({ pkg: p.id, amount: take, method: c.insurer, note: 'claim ' + c.id + ' (' + c.month + ')' }, me);
    left = Math.round((left - take) * 100) / 100;
  });
  if (left > 0 && typeof walletAdd_ === 'function') walletAdd_(ops, c.cid, c.name, left, c.insurer + ' paid $' + amt + ' for claim ' + c.id + ', more than the packages needed.', '', me.name);
  return { left: left };
}

// app_pkg_price: { pkg, price } change what a sold package costs (price per session follows)
function pkgPrice_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = ops.getSheetByName('PACKAGES'), row = appPkgRow_(sh, b.pkg);
  var price = Math.round(Number(b.price) * 100) / 100; if (!(price >= 0)) throw new Error('Price missing');
  var total = Number(sh.getRange(row, 5).getValue()) || 0, old = appNum_(sh.getRange(row, 9).getValue()) || 0;
  sh.getRange(row, 9).setValue(price);
  sh.getRange(row, 8).setValue(total ? Math.round(price / total * 100) / 100 : 0);
  var note = String(sh.getRange(row, 21).getValue() || '');
  sh.getRange(row, 21).setValue(appendNote_(note, 'Price $' + old + ' -> $' + price + ' ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM') + ' (' + me.name + ')'));
  return { price: price };
}

// staff boot: insured clients, claims, and the discount of each package
function insBoot_(d) {
  try {
    var ops = SpreadsheetApp.openById(CFG.OPS_ID);
    d.ins = { clients: insClients_(ops), claims: insClaims_(ops).map(function (c) { delete c.row; return c; }) };
    var disc = {};
    pkgsAll_(ops).forEach(function (x) { disc[x.id] = x.disc; });
    (d.pkgs || []).forEach(function (p) { if (disc[p.id]) p.disc = disc[p.id]; });
  } catch (e) { d.ins = { clients: [], claims: [] }; }
  return d;
}

// client app boot: insured clients never see money owed
function insClientBoot_(d) {
  try {
    var m = insMap_(SpreadsheetApp.openById(CFG.OPS_ID));
    (d.accounts || []).forEach(function (a) {
      var x = m[String(a.cid).toUpperCase()]; if (!x) return;
      a.insurer = x.insurer;
      (a.pkgs || []).forEach(function (p) { p.due = 0; p.ins = x.insurer; });
    });
  } catch (e) {}
  return d;
}

// run once from the editor: creates both tabs
function insTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  insClientsTab_(ops); insClaimsTab_(ops);
  Logger.log('Insurance tabs ready. Clients: ' + insClients_(ops).length + ', claims: ' + insClaims_(ops).length);
}