#!/usr/bin/env node
// =====================================================================
// Part C (operations) tests, real Postgres 16, migrations 0001-0005 + 0007 + 0008 (the API door) applied.
// Every action runs twice on the same data: in the Apps Script (real .gs files on the in memory sheets, through
// app_route_ / client_route_) and in Postgres THROUGH public.wb_call (as the edge function: service role, staff key or client token).
// Compared: the result object (minus ok, or the refusal text word for word) and the end state of the tables
// (the Apps Script sheets go through export -> import.js, the same path as the real move).
// Run: node run_ops.js
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js'), O = require('./lib/ops_db.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbops-'));
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('   FAIL: ' + msg + (extra ? '\n         ' + String(extra).slice(0, 1800) : '')); } }
const J = x => JSON.stringify(x);
// JS float noise in texts ($323.40000000000003) is rounded on purpose in SQL (README "Different on purpose"): compared rounded
const fl = x => typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : typeof x === 'string' ? x.replace(/\d+\.\d{7,}/g, m => String(Math.round(Number(m) * 1e6) / 1e6))
  : Array.isArray(x) ? x.map(fl) : x && typeof x === 'object' ? Object.keys(x).reduce((o, k) => (o[k] = fl(x[k]), o), {}) : x;
function diff(a, b, p0) {
  const out = []; a = fl(a); b = fl(b);
  (function walk(x, y, p) {
    if (out.length > 8 || J(x) === J(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) out.push(`${p}: ${x.length} rows vs ${y.length}\n           gs:  ${J(x).slice(0, 700)}\n           sql: ${J(y).slice(0, 700)}`); else x.forEach((v, i) => walk(v, y[i], p + '[' + i + ']')); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { new Set(Object.keys(x).concat(Object.keys(y))).forEach(k => walk(x[k], y[k], p + '.' + k)); return; }
    out.push(`${p}: gs ${J(x)} vs sql ${J(y)}`);
  })(a, b, p0 || '');
  return out;
}
const T = n => F.today(n || 0);
const KEY = { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel', melanie: 'k-mel', jad: 'k-jad' };
const EMAILS = ['alice@x.com', 'bea@x.com', 'carl@x.com', 'dina@x.com', 'elie@x.com', 'fadi@x.com', 'gina@x.com', 'hadi@x.com', 'ines@x.com', 'zed@x.com'];
const ops = () => M.books[CFG.OPS_ID];
const rowOf = (sh, id) => sh.d.findIndex(r => r[0] === id) + 1;
function kindOf(id) { return { S11: '1:1', S12: '1:2', S13: '1:3', SPP: 'PP', SOT: 'Osteo', SMD: 'Madero' }[id.slice(0, 3)]; }
function gsRef(id) { const k = kindOf(id); return k + '|' + rowOf(ops().getSheetByName(AT[k].sheet), id); }
const physioDay = (() => { for (let n = 2; n < 14; n++) { const d = T(n), w = new Date(d + 'T12:00:00Z').getUTCDay(); if ([1, 3, 4, 5].includes(w)) return d; } })();

// ---------------------------------------------------------------------
// extra sheets for the operations (both sides start from them: Postgres gets them through the import)
// ---------------------------------------------------------------------
function opsTabs() {
  const o = ops();
  o.add('EXPENSES', [['ID', 'Date', 'What', 'Category', 'Amount', 'By', 'Note'], ['EXP-000001', beirutDate_(T(-3), 0), 'Rent', 'Rent', 900, 'Majd', '']]);
  o.add('RECURRING EXPENSES', [['ID', 'What', 'Category', 'Amount (USD)', 'Every', 'First date', 'End date', 'Active', 'Last logged'], ['REC-001', 'Internet', 'Utilities', 40, 'Monthly', T(-60), '', 'Y', T(-30)]]);
  o.add('POS INVENTORY', [['ID', 'x', 'x', 'Product', 'Stock', 'Cost', 'x', 'Sold', 'Left', 'x', 'Price'],
    ['INV-1', '', '', 'Whey', 10, 20, '', 2, 8, '', 45], ['INV-2', '', '', 'Creatine', 3, 10, '', 3, 0, '', 25]]);
  o.add('POS SALES', [['ID', 'Date', 'Product', 'To', 'Qty', 'Total', 'Cost', 'Profit', 'Status', 'Note'], ['POSS-0001', beirutDate_(T(-2), 0), 'Whey', 'Alice', 2, 90, 20, 50, 'Paid', 'x']]);
  const ls = o.getSheetByName(CFG.LEADS_TAB), lead = (id, name, phone, email, date, time, status) => {
    const r = new Array(LH.length).fill(''); r[L.ID] = id; r[L.SUB] = new Date(Date.now() - 3600e3); r[L.NAME] = name; r[L.PHONE] = phone; r[L.EMAIL] = email;
    r[L.DATE] = date; r[L.TIME] = time; r[L.STATUS] = status || 'Pending'; ls.appendRow(r); };
  lead('W40-0001', 'Nour Nassar', '03 777 888', 'nour@x.com', T(6), '8:00 AM');
  lead('W40-0002', 'Rana Rizk', '70 123 456', '', T(5), '9:00 AM');
  lead('W40-0003', 'Alice A', '03111111', 'alice@x.com', '', '');
  lead('W40-0004', 'Sara Saad', '76 555 444', '', T(4), '9:00 AM');
}
// today's sessions for the 21:30 default Present
function todayTabs() {
  const o = ops();
  o.getSheetByName('SESSIONS 1:1').appendRow(F.sessRow('1:1', 'S11-0002', T(0), '06:00', 'Mikel', [['PKG-0004', 'Dina Daher']]));
  o.getSheetByName('SESSIONS 1:1').appendRow(F.sessRow('1:1', 'S11-0003', T(0), '11:00', 'Mikel', [['PKG-0004', 'Dina Daher', 'Y']], 'No Show'));
  o.getSheetByName('SESSIONS 1:3').appendRow(F.sessRow('1:3', 'S13-0006', T(0), '06:00', 'Joe Al Hosny', [['PKG-0005', 'Fadi Fares', 'Y', '', 'No Show'], ['PKG-0006', 'Gina G'], ['PKG-0007', 'Hadi H']], 'Done'));
}

// ---------------------------------------------------------------------
// scenarios: steps [who, action, body] run the same on both sides
// ---------------------------------------------------------------------
const SC = [], sc = (name, o) => SC.push(Object.assign({ name, setup: [opsTabs] }, o));
const st = (who, a, b, o) => Object.assign({ who, a, b: b || {} }, o || {});

sc('attendance: 1:2 Late Cancel then Present for the same client (note mark), Joe marks his 1:3', { steps: [
  st('romy', 'app_att', { id: 'S12-0002', i: 0, att: 'Late Cancel' }), st('romy', 'app_att', { id: 'S12-0002', i: 0, att: 'Present' }),
  st('joe', 'app_att', { id: 'S13-0001', i: 1, att: 'Present' }), st('mikel', 'app_att', { id: 'S13-0001', i: 0, att: 'Present' })] });
sc('change: 1:3 cancel for all (Late Cancel), 1:2 Early Cancel for both by Romy', { steps: [
  st('romy', 'app_change', { id: 'S13-0002', what: 'cancel', who: 'all', kind: 'Late Cancel' }),
  st('majd', 'app_change', { id: 'S12-0001', what: 'cancel', who: 'all', kind: 'Early Cancel', reason: 'coach sick' })] });
sc('change: one 1:3 client No Show with an exception reason', { steps: [st('romy', 'app_change', { id: 'S13-0001', what: 'cancel', who: 1, kind: 'No Show', reason: 'traffic' })] });
sc('change: trainer (ok, cap refusal, fixed practitioner refusal)', { steps: [
  st('romy', 'app_change', { id: 'S13-0003', what: 'trainer', trainer: 'Mikel' }),
  st('romy', 'app_change', { id: 'S12-0001', what: 'trainer', trainer: 'Joe' }),
  st('romy', 'app_change', { id: 'SPP-0001', what: 'trainer', trainer: 'Joe' })] });
sc('change: move the whole session, move one client out, refusals (cap, already booked, bad day)', { steps: [
  st('romy', 'app_change', { id: 'S12-0001', what: 'move', who: 'all', date: T(8), time: '10:00' }),
  st('romy', 'app_change', { id: 'S13-0001', what: 'move', who: 0, date: T(9), time: '08:00' }),
  st('romy', 'app_change', { id: 'S13-0001', what: 'move', who: 'all', date: T(4), time: '09:00' }),
  st('romy', 'app_change', { id: 'S13-0002', what: 'move', who: 0, date: T(5), time: '08:00' }),
  st('romy', 'app_change', { id: 'S13-0002', what: 'move', who: 0, date: 'tomorrow', time: '08:00' })] });
sc('the Supabase boot ref (<kind>|<session ID>) alone finds the session', { sqlRefOnly: true, steps: [st('romy', 'app_att', { id: 'S13-0001', i: 0, att: 'Present' })] });
sc('book: join a 1:3, new 1:1, unknown type and missing package refused', { steps: [
  st('romy', 'app_book', { type: '1:3', date: T(4), time: '08:00', trainer: 'Joe', pkg: 'PKG-0008', name: 'Ines I' }),
  st('romy', 'app_book', { type: '1:1', date: T(10), time: '12:00', trainer: 'Mikel', pkg: 'PKG-0004', name: 'Dina Daher' }),
  st('romy', 'app_book', { type: 'Yoga', date: T(10), time: '12:00', trainer: 'Mikel', pkg: 'PKG-0004', name: 'Dina' }),
  st('romy', 'app_book', { type: '1:1', date: T(10), time: '12:00', trainer: 'Mikel', pkg: '', name: 'Dina' })] });
sc('week template: booked, joined, and one skipped (cap) with the reason', { steps: [
  st('romy', 'app_week', { items: [{ type: '1:3', date: T(11), time: '08:00', trainer: 'Joe', clients: [{ pkg: 'PKG-0005', name: 'Fadi Fares' }, { pkg: 'PKG-0006', name: 'Gina G' }] },
    { type: '1:1', date: T(4), time: '09:00', trainer: 'Joe', clients: [{ pkg: 'PKG-0004', name: 'Dina Daher' }] }, { type: 'Spin', date: T(4), time: '09:00', clients: [{ pkg: 'PKG-0004' }] }] })] });
sc('pay: part, then a fully paid package (only the wallet moves), then amount missing', { steps: [
  st('romy', 'app_pay', { pkg: 'PKG-0005', amount: 100, method: 'Whish', note: 'first' }), st('romy', 'app_pay', { pkg: 'PKG-0009', amount: 10 }),
  st('romy', 'app_pay', { pkg: 'PKG-0005', amount: '' })] });
sc('sell: 3 months part paid, then with the wallet', { steps: [
  st('romy', 'app_sell', { type: '1:3 - 12x/month ($200pp)', cid: 'C001', months: 3, discount: 7, paid: 700, method: 'Cash' }),
  st('majd', 'app_sell', { type: '1:3 - 8x/month ($140pp)', cid: 'C001', paid: 0, useWallet: true })] });
sc('leads: confirm (moved, joins a 1:3), confirm (new 1:3 row), confirm existing client, full hour fails back to Pending, cancel', { steps: [
  st('romy', 'app_lead', { id: 'W40-0001', date: T(6), time: '8:00 AM' }),
  st('romy', 'app_lead', { id: 'W40-0002', date: T(7), time: '10' }),
  st('romy', 'app_lead', { id: 'W40-0003', date: T(4), time: '8:00 AM' }),
  st('romy', 'app_lead', { id: 'W40-0004' }),
  st('romy', 'app_lead', { id: 'W40-0004', act: 'cancel', reason: 'no show at the call' }),
  st('romy', 'app_lead', { id: 'W40-0001' })] });
sc('expenses: log one from a recurring, add a recurring, stop it, refusal', { steps: [
  st('romy', 'app_expense', { d: T(0), what: 'Internet', cat: 'Utilities', amt: 40, recId: 'REC-001' }), st('majd', 'app_expense', { d: T(-1), what: '=cleaning', cat: 'Supplies', amt: '12.5' }),
  st('majd', 'app_rec_add', { what: 'Insurance', cat: 'Other', amt: 120, every: 'Yearly', start: T(1), end: '' }), st('majd', 'app_rec_stop', { id: 'REC-001' }),
  st('romy', 'app_expense', { d: T(0), what: '', amt: 5 })],
  check: (gsRows, c) => directExpenses(gsRows, c) });
sc('POS: sale with stock recount, unknown product refused', { steps: [
  st('romy', 'app_pos', { product: 'Whey', qty: 3, price: 45, to: 'Bea' }), st('romy', 'app_pos', { product: 'Nope', qty: 1, price: 1 })],
  check: (gsRows, c) => directPos(gsRows, c) });
sc('clients: new, same phone (other format), Melanie flag, discount, edit, bad email refused', { steps: [
  st('romy', 'app_client', { name: 'Tia Tannous', phone: '+961 71 234 567', email: 'Tia@X.com', mel: true }),
  st('romy', 'app_client', { name: 'Someone Else', phone: '0371234567' }), st('romy', 'app_client', { name: 'Tia', phone: '71234567' }),
  st('romy', 'app_flag', { cid: 'C050', name: 'Dina Daher', mel: true }), st('romy', 'app_flag', { cid: 'C072', name: 'Hadi H', mel: true }),
  st('romy', 'app_disc', { cid: 'C010', name: 'Carl Chami', disc: 150 }),
  st('romy', 'app_cedit', { cid: 'C002', name: 'Bea B', phone: '03 999 000', email: 'BEA2@x.com' }), st('romy', 'app_cedit', { cid: 'C002', name: 'Bea', email: 'bad@' }),
  st('romy', 'app_cedit', { cid: 'C999', name: 'Ghost' }), st('romy', 'app_client', { name: 'No Phone' })],
  check: (gsRows, c) => directDisc(c) });
sc('staff freeze, then a second one refused', { steps: [
  st('romy', 'app_freeze', { pkg: 'PKG-0003', from: T(2), note: 'travel' }), st('romy', 'app_freeze', { pkg: 'PKG-0003' })] });
sc('client requests of every kind, with their refusals', { steps: [
  st('alice@x.com', 'app_cl_request', { cid: 'C001', kind: 'physio', d: physioDay, t: '16:00', note: 'knee' }),
  st('alice@x.com', 'app_cl_request', { cid: 'C001', kind: 'physio', d: physioDay, t: '17:00' }),
  st('bea@x.com', 'app_cl_request', { cid: 'C002', kind: 'physio', d: physioDay, t: '16:00' }),
  st('bea@x.com', 'app_cl_request', { cid: 'C002', kind: 'reschedule', when: 'Thursday evening', note: 'work', slabel: 'Tue 8 AM', sid: 'S12-0001', pkg: 'PKG-0002' }),
  st('bea@x.com', 'app_cl_request', { cid: 'C002', kind: 'reschedule' }),
  st('carl@x.com', 'app_cl_request', { cid: 'C010', kind: 'freeze', pkg: 'PKG-0003', from: T(3) }),
  st('carl@x.com', 'app_cl_request', { cid: 'C010', kind: 'freeze', pkg: 'PKG-0003', from: T(3) }),
  st('dina@x.com', 'app_cl_request', { cid: 'C050', kind: 'freeze', pkg: 'PKG-0004', from: T(-1) }),
  st('dina@x.com', 'app_cl_request', { cid: 'C050', kind: 'freeze', pkg: 'PKG-0003', from: T(1) }),
  st('carl@x.com', 'app_cl_request', { cid: 'C010', kind: 'offer3' }), st('dina@x.com', 'app_cl_request', { cid: 'C050', kind: 'offer3' }),
  st('fadi@x.com', 'app_cl_request', { cid: 'C070', kind: 'order', items: [{ n: 'Whey', q: 2 }, { n: 'Creatine', q: 1 }, { n: 'Ghost', q: 1 }] }),
  st('fadi@x.com', 'app_cl_request', { cid: 'C070', kind: 'order', items: [] }),
  st('gina@x.com', 'app_cl_request', { cid: 'C071', kind: 'late', minutes: 90, slabel: 'today 6 AM', sid: 'S13-0001', pkg: 'PKG-0006', note: 'parking' }),
  st('gina@x.com', 'app_cl_request', { cid: 'C071', kind: 'supp', note: 'magnesium' }), st('gina@x.com', 'app_cl_request', { cid: 'C071', kind: 'supp' }),
  st('hadi@x.com', 'app_cl_request', { cid: 'C072', kind: 'session', what: '1:1', when: 'mornings', pkg: 'PKG-0007' }),
  st('ines@x.com', 'app_cl_request', { cid: 'C073', kind: 'invite', fname: 'Maya', phone: '+961 70 111 222', msg: 'Come train with me! 100% fun & free?' }),
  st('ines@x.com', 'app_cl_request', { cid: 'C073', kind: 'invite', fname: 'Maya', phone: '123' }),
  st('ines@x.com', 'app_cl_request', { cid: 'C073', kind: 'dance' }),
  st('bea@x.com', 'app_cl_request', { cid: 'C001', kind: 'supp', note: 'x' })],
  sqlPrep: ["update public.inventory set price_cents = 4500 where item = 'Whey'", "update public.inventory set price_cents = 2500 where item = 'Creatine'"] });
sc('To do: accept physio (other time), 3 month offer, decline, done, then already handled', { steps: [
  st('alice@x.com', 'app_cl_request', { cid: 'C001', kind: 'physio', d: physioDay, t: '16:00' }),
  st('carl@x.com', 'app_cl_request', { cid: 'C010', kind: 'offer3' }), st('gina@x.com', 'app_cl_request', { cid: 'C071', kind: 'supp', note: 'zinc' }),
  st('bea@x.com', 'app_cl_request', { cid: 'C002', kind: 'reschedule', when: 'later' }),
  st('romy', 'app_req_done', { id: 'REQ-0001', act: 'accept', d: physioDay, t: '17:00' }), st('romy', 'app_req_done', { id: 'REQ-0002', act: 'accept' }),
  st('romy', 'app_req_done', { id: 'REQ-0003', act: 'decline' }), st('majd', 'app_req_done', { id: 'REQ-0004', act: 'done' }),
  st('romy', 'app_req_done', { id: 'REQ-0004', act: 'done' }), st('romy', 'app_req_done', { id: 'REQ-0099', act: 'done' })] });
sc('client: 6 month upgrade asked and accepted, cancel, join (through the api functions)', { steps: [
  st('elie@x.com', 'app_cl_upgrade6', { cid: 'C060' }), st('romy', 'app_req_done', { id: 'REQ-0001', act: 'accept' }),
  st('alice@x.com', 'app_cl_cancel', { cid: 'C001', id: 'S12-0001' }), st('fadi@x.com', 'app_cl_cancel', { cid: 'C070', id: 'S13-0001' }),
  st('bea@x.com', 'app_cl_cancel', { cid: 'C001', id: 'S12-0001' }),
  st('romy', 'app_sell', { type: '1:3 - 8x/month ($140pp)', cid: 'C050', paid: 140 }), st('dina@x.com', 'app_cl_join', { cid: 'C050', date: T(4), time: '08:00', trainer: 'Joe' }),
  st('carl@x.com', 'app_cl_join', { cid: 'C010', date: T(4), time: '08:00', trainer: 'Joe' })] });
sc('insurance: insure, submit (twice refused), paid over the packages with the rest to the wallet, uninsure', { steps: [
  st('romy', 'app_ins_set', { cid: 'C002', name: 'Bea Bitar', insurer: 'NextCare', member: 'NC-1', notes: 'ok' }),
  st('romy', 'app_ins_submit', { cid: 'C002', name: 'Bea Bitar', insurer: 'NextCare', month: T(-30).slice(0, 7), sessions: 6, amount: 162, submitted: T(-2), ref: 'R1', pkgs: 'PKG-0002' }),
  st('romy', 'app_ins_submit', { cid: 'C002', insurer: 'NextCare', month: T(-30).slice(0, 7), amount: 10 }),
  st('romy', 'app_ins_submit', { cid: 'C002', insurer: 'NextCare', month: 'x', amount: 10 }),
  st('romy', 'app_ins_paid', { id: 'CLM-0001', amount: 200, date: T(0) }), st('romy', 'app_ins_paid', { id: 'CLM-0001', amount: 200 }),
  st('romy', 'app_ins_set', { cid: 'C010', insurer: 'Globemed', rate: 30 }), st('romy', 'app_ins_set', { cid: 'C010', insurer: '' })] });
sc('package price, notes (desk, trainer, trainer refused), intake (owner), upload (owner)', { steps: [
  st('majd', 'app_pkg_price', { pkg: 'PKG-0004', price: 199.5 }), st('majd', 'app_pkg_price', { pkg: 'PKG-0004', price: 'abc' }),
  st('romy', 'app_notes', { cid: 'C050', name: 'Dina Daher', always: 'Back pain, no deadlifts', program: 'A/B', note: 'Good session', date: T(-3), sid: 'S11-0001' }),
  st('joe', 'app_notes', { cid: 'C001', name: 'Alice Aoun', always: 'Knee', program: '' }), st('mikel', 'app_notes', { cid: 'C001', always: 'x' }),
  st('majd', 'app_intake', { cid: 'C050', name: 'Dina Daher', data: { area: 'Lower back', complaint: 'Pain when bending', painNow: 6, flags: ['night pain', 'numbness'], dx: 'Disc?', plan: 'Rehab' }, alert: 'No flexion under load' }),
  st('majd', 'app_intake', { data: { name: 'Walk In', phone: '03 456 789', area: 'Shoulder' }, alert: 'Shoulder' }),
  st('majd', 'app_intake', { data: { area: 'x' } }),
  st('majd', 'app_upload', { cid: 'C050', cname: 'Dina Daher', name: 'scan 1.pdf', mime: 'application/pdf', b64: 'aGk=' }, { skipOut: true }),
  st('romy', 'app_intake', { cid: 'C050', data: {} }), st('romy', 'app_upload', { cid: 'C050', b64: 'aGk=' })],
  check: (gsRows, c) => directNotes(gsRows, c) });
sc('notices: a 1:2 cancel tells everyone, each reads their own', { steps: [
  st('romy', 'app_change', { id: 'S12-0001', what: 'cancel', who: 0, kind: 'Early Cancel' }),
  st('joe', 'app_notice_read', { ids: ['NT-00003', 'NT-00004', 'NT-00099'] }), st('bea@x.com', 'app_cl_notice_read', { cid: 'C002', ids: ['NT-00001', 'NT-00002', 'NT-00003'] })] });
sc('delete account: request + sign out, then the old sign in is refused', { steps: [
  st('alice@x.com', 'app_cl_delete', { cid: 'C001' }), st('alice@x.com', 'app_cl_request', { cid: 'C001', kind: 'supp', note: 'x' }, { expectSignin: true, sqlOnly: true })],
  check: (gsRows, c) => directDelete(c) });
sc('21:30 default Present: 1:2 partner of a late cancel, single sessions only when Scheduled, 1:3 only unmarked', {
  setup: [opsTabs, todayTabs], steps: [st('romy', 'app_att', { id: 'S12-0002', i: 1, att: 'Late Cancel' }), { job: 'default_present' }] });

// direct checks of columns the import does not carry
function gsTab(name) { return (ops().getSheetByName(name) || { d: [] }).d; }
async function directExpenses(g, c) {
  const e = g['EXPENSES'].filter(r => r[0] && r[0] !== 'ID').map(r => r[0]), s = (await c.query(`select e.legacy_id, r.legacy_id as rec from public.expenses e left join public.recurring_expenses r on r.id = e.recurring_id where e.legacy_id is not null order by 1`)).rows;
  ok(J(e) === J(s.map(x => x.legacy_id)) && s[1] && s[1].rec === 'REC-001' && /Recurring REC-001/.test(g['EXPENSES'][2][6]), 'expense IDs and recurring link equal the sheet', J(e) + J(s));
}
async function directPos(g, c) {
  const r = g['POS SALES'].find(x => x[0] === 'POSS-0002'), s = (await c.query(`select legacy_id, buyer, qty, amount_cents, cost_cents, profit_cents, status, note from public.pos_sales where legacy_id = 'POSS-0002'`)).rows[0];
  ok(r && s && s.buyer === r[3] && s.qty === r[4] && s.amount_cents === r[5] * 100 && s.cost_cents === r[6] * 100 && s.profit_cents === r[7] * 100 && s.status === r[8] && s.note === r[9], 'POS sale row equals the sheet', J(r) + J(s));
  const inv = g['POS INVENTORY'].find(x => x[3] === 'Whey'), si = (await c.query(`select stock, sold from public.inventory where item = 'Whey'`)).rows[0];
  ok(si.stock === inv[8] && si.sold === inv[7], 'stock left and sold equal the sheet', J(inv) + J(si));
}
async function directDisc(c) {
  const n = gsTab('CLIENT NOTES').find(r => r[0] === 'C010'), s = (await c.query(`select discount_pct::float d from public.clients where legacy_id = 'C010'`)).rows[0];
  ok(n && Number(n[7]) === s.d && s.d === 100, 'standing discount equals the sheet (capped at 100)', J(n) + J(s));
}
async function directNotes(g, c) {
  const sn = g['SESSION NOTES'].slice(1), s = (await c.query(`select n.day::text, x.legacy_id as sid, c.legacy_id as cid, n.by_staff, n.note from public.session_notes n join public.clients c on c.id = n.client_id left join public.sessions x on x.id = n.session_id`)).rows;
  ok(sn.length === 1 && s.length === 1 && J([sn[0][0], sn[0][1], sn[0][2], sn[0][4], sn[0][5]]) === J([s[0].day, s[0].sid, s[0].cid, s[0].by_staff, s[0].note]), 'session note equals the sheet', J(sn) + J(s));
  const pi = g['PHYSIO INTAKE'].slice(1), si = (await c.query(`select c.legacy_id, i.by_staff, i.body_area, i.complaint, i.pain_now, i.red_flags, i.impression, i.plan from public.physio_intake i join public.clients c on c.id = i.client_id order by 1`)).rows;
  ok(pi.length === 2 && si.length === 2 && pi.every(r => si.some(x => x.legacy_id === r[1] && x.by_staff === r[3] && x.body_area === r[4] && x.complaint === r[5] && String(x.pain_now == null ? '' : x.pain_now) === String(r[6] == null || Number.isNaN(r[6]) ? '' : r[6]) && x.red_flags === r[7] && x.impression === r[8] && x.plan === r[9])), 'physio intakes equal the sheet', J(pi.map(r => r.slice(0, 10))) + J(si));
}
async function directDelete(c) {
  const d = gsTab('DELETION REQUESTS').slice(1), s = (await c.query(`select legacy_id, email, names, status, (select string_agg(legacy_id, ', ') from public.clients where id = any(client_ids)) as ids from public.deletion_requests`)).rows;
  ok(d.length === 1 && s.length === 1 && J([d[0][0], d[0][2], d[0][3], d[0][4], d[0][5]]) === J([s[0].legacy_id, s[0].email, s[0].ids, s[0].names, s[0].status]), 'deletion request equals the sheet', J(d) + J(s));
}

// ---------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------
async function loadInto(db) {
  const dir = path.join(TMP, db); exportBooks(M.books, dir);
  const { sql } = I.run(dir, GS);
  await O.freshDb(db);
  await D.withDb(db, async c => {
    await c.query(['begin;'].concat(sql, ['commit;']).join('\n'));
    await D.makeLogins(c);
    await c.query(`select app.import_staff_keys($1::jsonb)`, [J(KEY)]);
    for (const e of EMAILS) await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, e]);
  });
}
async function door(c, who, action, body) {        // as the api edge function: service role, through public.wb_call
  await c.query('begin');
  try {
    await c.query('set local role service_role');
    const r = (await c.query(`select public.wb_call($1, $2, $3, $4::jsonb) as x`, [action, KEY[who] || null, KEY[who] ? null : 'wb1.' + who, J(body || {})])).rows[0].x;
    await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); return { ok: false, error: 'SQL: ' + e.message }; }
}
const noOk = o => { const x = Object.assign({}, o); delete x.ok; return x; };
function gsStep(s) {
  if (s.job) { appDefaultPresent(); return { ok: true }; }
  if (s.sqlOnly) return { skipped: true };   // the node mock signs a NEW token on every call, so an old token cannot be replayed there
  const b = JSON.parse(J(s.b));
  if (b.id && /^S(11|12|13|PP|OT|MD)-/.test(b.id)) b.ref = gsRef(b.id);
  if (s.a === 'app_lead') b.row = rowOf(ops().getSheetByName(CFG.LEADS_TAB), b.id);
  return KEY[s.who] ? F.st(s.a, KEY[s.who], b) : F.cl(s.a, s.who, b);
}
function sqlBody(s, refOnly) {
  const b = JSON.parse(J(s.b));
  if (b.id && /^S(11|12|13|PP|OT|MD)-/.test(b.id)) { b.ref = kindOf(b.id) + '|' + b.id; if (refOnly) delete b.id; }   // the Supabase boot's ref
  if (s.a === 'app_lead') b.row = b.id;
  return b;
}
async function runScenario(s) {
  F.build(); s.setup.forEach(f => f()); CFG_MEMO_ = null; M.cache = {};
  const g = s.steps.map(x => { CFG_MEMO_ = null; try { return gsStep(x); } catch (e) { return { ok: false, error: 'GS crash: ' + e.message }; } });
  const gRows = {}; ['EXPENSES', 'POS SALES', 'POS INVENTORY', 'SESSION NOTES', 'PHYSIO INTAKE'].forEach(n => gRows[n] = gsTab(n));
  const gsBooks = M.books;
  await loadInto('ops_gs');
  const A = await D.withDb('ops_gs', O.snapshot);
  F.build(); s.setup.forEach(f => f()); CFG_MEMO_ = null; M.cache = {};
  await loadInto('ops_sql');
  M.books = gsBooks;                                  // direct checks read the Apps Script side
  await D.withDb('ops_sql', async c => {
    for (const q of s.sqlPrep || []) await c.query(q);
    const b0 = await O.snapshot(c), res = [];
    for (const x of s.steps) res.push(x.job ? await (async () => { await c.query(`select public.default_present()`); return { ok: true }; })() : await door(c, x.who, x.a, sqlBody(x, s.sqlRefOnly)));
    const B = await O.snapshot(c);
    const d = diff(A, B, 'state'); ok(d.length === 0, `[${s.name}] end state matches`, d.join('\n         '));
    ok(diff(b0, B).length > 0, `[${s.name}] the action changed something`);
    s.steps.forEach((x, i) => {
      const gr = g[i], sr = res[i], lbl = `[${s.name}] step ${i + 1} ${x.a || x.job} (${x.who || 'job'})`;
      if (x.expectSignin) { ok(sr.ok === false && sr.error === 'signin', lbl + ': the sign in made before the request is refused', J(sr)); return; }
      if (gr.ok === false) { ok(sr.ok === false && sr.error === gr.error, lbl + ': same refusal', 'gs ' + J(gr.error) + ' | sql ' + J(sr.error)); return; }
      if (x.skipOut) { ok(sr.ok === true && /^[0-9a-f-]{36}\/\d+-scan_1\.pdf$/.test(sr.path || ''), lbl + ': storage path given', J(sr)); return; }
      const dd = diff(noOk(gr), noOk(sr)); ok(sr.ok === true && dd.length === 0, lbl + ': same result', 'gs ' + J(gr) + '\n         sql ' + J(sr) + '\n         ' + dd.join(' '));
    });
    if (s.check) await s.check(gRows, c);
  });
  console.log('ran: ' + s.name);
}

// ---------------------------------------------------------------------
// who may call what (through the door, and directly)
// ---------------------------------------------------------------------
const STAFF_ONLY = ['app_change', 'app_book', 'app_pay', 'app_sell', 'app_lead', 'app_expense', 'app_rec_add', 'app_rec_stop', 'app_pos', 'app_week', 'app_client', 'app_flag',
  'app_req_done', 'app_disc', 'app_freeze', 'app_cedit', 'app_ins_set', 'app_ins_submit', 'app_ins_paid', 'app_pkg_price'];
const CLIENT_ACTS = ['app_cl_cancel', 'app_cl_join', 'app_cl_request', 'app_cl_upgrade6', 'app_cl_delete', 'app_cl_notice_read'];
async function permissions() {
  F.build(); opsTabs(); CFG_MEMO_ = null;
  const gsT = STAFF_ONLY.map(a => F.st(a, 'k-joe', {})), gsO = ['app_intake', 'app_upload'].map(a => F.st(a, 'k-romy', {})), gsC = CLIENT_ACTS.map(a => F.cl(a, 'bea@x.com', { cid: 'C001' }));
  await loadInto('ops_perm');
  await D.withDb('ops_perm', async c => {
    for (let i = 0; i < STAFF_ONLY.length; i++) { const r = await door(c, 'joe', STAFF_ONLY[i], {}); ok(r.error === 'not allowed' && gsT[i].error === r.error, `trainer refused ${STAFF_ONLY[i]} like the Apps Script`, J(r) + J(gsT[i])); }
    for (const [i, a] of ['app_intake', 'app_upload'].entries()) for (const w of ['romy', 'joe']) { const r = await door(c, w, a, { cid: 'C050', data: {} }); ok(r.error === 'not allowed' && gsO[i].error === 'not allowed', `${w} refused ${a} (owner only)`, J(r)); }
    for (const [i, a] of CLIENT_ACTS.entries()) { const r = await door(c, 'bea@x.com', a, { cid: 'C001', ids: [] }); ok(r.error === 'Not your account' && gsC[i].error === r.error, `client refused ${a} on another account`, J(r) + J(gsC[i])); }
    for (const a of STAFF_ONLY.concat(['app_att', 'app_notes'])) { const r = await door(c, 'alice@x.com', a, {}); ok(r.ok === false && /auth|not allowed/.test(r.error), `client refused staff action ${a}`, J(r)); }
    for (const a of CLIENT_ACTS) { const r = await door(c, 'romy', a, { cid: 'C001' }); ok(r.ok === false && /signin|Not your account/.test(r.error), `staff key refused client action ${a}`, J(r)); }
    // guests: only delete and notices
    await c.query(`insert into public.clients (legacy_id, kind, name, email) values ('G0001', 'guest', 'Gus Guest', 'gus@x.com')`);
    await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha('wb1.gus@x.com'), 'gus@x.com', now() + interval '1 day')`);
    for (const a of ['app_cl_cancel', 'app_cl_join', 'app_cl_request', 'app_cl_upgrade6']) { const r = await door(c, 'gus@x.com', a, { cid: 'G0001' }); ok(r.error === 'unknown action', `guest refused ${a}`, J(r)); }
    ok((await door(c, 'gus@x.com', 'app_cl_notice_read', { cid: 'G0001', ids: [] })).read === 0, 'guest may read notices');
    // direct calls (not through the door) are closed, internal helpers too
    for (const f of ['api_app_sell', 'api_app_cl_request', 'api_app_expense']) { const r = await D.as(c, 'romy', `select public.${f}('{}'::jsonb)`); ok(/permission denied/.test(r.error || ''), `${f} not callable directly`, J(r)); }
    ok(/permission denied/.test((await D.as(c, 'romy', `select app.ops_client('a','1','')`)).error || ''), 'internal helper app.ops_client closed');
    ok(/permission denied/.test((await D.as(c, 'anon', `select public.api_app_pay('{}'::jsonb)`)).error || ''), 'anon cannot call');
    // a signed up user with no profile is not the system (sees nothing, cannot write)
    ok((await D.as(c, 'nobody@x.com', `select count(*)::int n from public.clients`)).rows[0].n === 0, 'signed up user with no profile sees no clients (not system)');
    const n = (await c.query(`select count(*)::int n from app.api_actions where action = any($1) and enabled`, [STAFF_ONLY.concat(CLIENT_ACTS, ['app_att', 'app_notes', 'app_intake', 'app_upload', 'app_notice_read'])])).rows[0].n;
    ok(n === STAFF_ONLY.length + CLIENT_ACTS.length + 5, 'all 31 actions registered in the API door', n);
  });
  console.log('ran: who may call what');
}

(async () => {
  O.buildTemplate();
  for (const s of SC) { try { await runScenario(s); } catch (e) { ok(false, `[${s.name}] crashed`, e.stack); } }
  try { await permissions(); } catch (e) { ok(false, 'permissions crashed', e.stack); }
  for (const db of ['ops_gs', 'ops_sql', 'ops_perm']) await D.dropDb(db);
  console.log(`\n${SC.length} scenarios + permissions: ${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
