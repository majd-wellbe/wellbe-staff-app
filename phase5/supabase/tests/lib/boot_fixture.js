// Boot test data on top of fixture.js F.build(): a child account, a guest, leads, requests, notices, wallet,
// insurance, money out, POS, coach notes, intakes, files, photos. Call after F.build(), before export.
const F = require('./gs.js');
function extend() {
  const ops = M.books[CFG.OPS_ID], cl = M.books[CFG.CLIENTS_ID], T = n => F.today(n), TZ = CFG.TZ;
  const stamp = min => Utilities.formatDate(new Date(Date.now() - min * 60000), TZ, 'dd/MM/yyyy HH:mm');
  const D = ymd => beirutDate_(ymd, 0);
  // phones as the import stores them (961...), so the comparison is not about phone formats
  const cs = cl.getSheetByName(CFG.CLIENTS_TAB);
  cs.d.slice(1).forEach((r, i) => { r[3] = '9613' + String(1000000 + i * 111111).slice(0, 6); });
  cs.d.push(['C080', 'Kid Aoun', 'alice@x.com', '96171222333']);                       // Alice's child: same email cell
  const pk = ops.getSheetByName('PACKAGES');
  pk.d.push(F.pkgRow('PKG-0012', 'C080', 'Kid Aoun', '1:3 - 8x/month ($140pp)', 8, 1, 140, T(-3), T(27), 'Active', 70));
  pk.d.push(F.pkgRow('PKG-0013', 'C050', 'Dina Daher', 'Prehab - 10 Sessions ($400)', 10, 0, 400, T(20), T(110)));   // future
  pk.d.push(F.pkgRow('PKG-0014', 'C002', 'Bea Bitar', '1:2 - 8x/month ($180pp)', 8, 8, 180, T(-70), T(-40), 'Cancelled'));
  pk.d[5][19] = 0.07;                                                                 // PKG-0004: 7% off
  const add = (k, rows) => { const sh = ops.getSheetByName(AT[k].sheet); rows.forEach(r => sh.d.push(r)); };
  add('1:3', [
    F.sessRow('1:3', 'S13-0006', T(2), '08:00', 'Joe Al Hosny', []),                                     // no client: not shown
    F.sessRow('1:3', 'S13-0007', T(5), '10:00', 'Joe Al Hosny', [['PKG-0012', 'Kid Aoun']]),            // open chairs
    F.sessRow('1:3', 'S13-0008', T(-2), '08:00', 'Joe Al Hosny', [['PKG-0012', 'Kid Aoun', 'Y', '', 'Present']], 'Done'),
    F.sessRow('1:3', 'S13-0009', T(-10), '08:00', 'Joe Al Hosny', [['PKG-0005', 'Fadi Fares', 'N', '', 'Early Cancel']]),
    F.sessRow('1:3', 'S13-0010', T(-7), '18:00', 'Joe Al Hosny', [['PKG-0006', 'Gina G', 'Y', '', 'Present']], 'Done'),
    F.sessRow('1:3', 'S13-0011', T(-14), '18:00', 'Joe Al Hosny', [['PKG-0006', 'Gina G', 'Y', '', 'Present']], 'Done'),
    F.sessRow('1:3', 'S13-0012', T(7), '07:00', 'Mikel', [['PKG-0005', 'Fadi Fares'], ['PKG-0006', 'Gina G'], ['PKG-0007', 'Hadi H']])]);
  add('1:1', [
    F.sessRow('1:1', 'S11-0002', T(1), '09:00', 'Mikel', [['PKG-0004', 'Dina Daher']]),
    F.sessRow('1:1', 'S11-0003', T(-1), '09:00', 'Mikel', [['PKG-0004', 'Dina Daher', 'Y']], 'Late Cancel')]);
  add('1:2', [F.sessRow('1:2', 'S12-0003', T(-4), '08:00', 'Joe Al Hosny', [['PKG-0001', 'Alice Aoun', 'Y'], ['PKG-0002', 'Bea Bitar', 'Y']], '', 'Alice Aoun: Late Cancel')]);
  add('PP', [F.sessRow('PP', 'SPP-0002', T(2), '16:00', '', [['PKG-0004', 'Dina Daher']]), F.sessRow('PP', 'SPP-0003', T(-6), '16:00', '', [['PKG-0004', 'Dina Daher', 'Y']], 'Done')]);
  // leads (Date objects like Sheets; trial date as text)
  const ls = ops.getSheetByName(CFG.LEADS_TAB), lead = (id, min, st, o) => { const r = new Array(LH.length).fill(''); r[L.ID] = id; r[L.SUB] = new Date(Date.now() - min * 60000);
    r[L.NAME] = 'Lead ' + id; r[L.PHONE] = '9617000' + id.slice(-4); r[L.STATUS] = st; Object.keys(o || {}).forEach(k => { r[L[k]] = o[k]; }); ls.d.push(r); };
  lead('W40-0001', 30, 'No Booking', { WHY: 'Back pain', INJ: 'Knee' });
  lead('W40-0002', 2 * 1440, 'Pending', { DATE: T(2), TIME: '08:00', TYPE: 'Trial' });
  lead('W40-0003', 3 * 1440, 'Cancelled');
  lead('W40-0004', 26 * 60, 'Confirmed', { DATE: T(-1), TIME: '9:00', TYPE: 'Trial', PKG: 'PKG-0005' });
  lead('W40-0005', 4 * 1440, 'Pending', { DATE: T(3), TIME: '7 am', TYPE: 'Trial' });
  // guests: one with a trial booked, one without
  ops.add(GUEST.TAB, [GUEST.HEAD.slice(), ['G0001', 'gus@x.com', 'Gus Guest', '96170111222', stamp(3000), stamp(2999), 'W40-0002', '{"trial":1}', ''],
    ['G0002', 'gia@x.com', 'Gia Guest', '96170333444', stamp(500), stamp(499), '', '{}', '']]);
  ops.add('CLIENT REQUESTS', [CL.REQ_HEAD.slice(),
    ['REQ-0001', stamp(600), 'C001', 'Alice Aoun', 'Physio visit', 'Knee check', T(3) + ' 16:00', '', 'New', '', '', '{}'],
    ['REQ-0002', stamp(500), 'C001', 'Alice Aoun', 'Freeze', 'Travel', '', 'PKG-0001', 'Done', 'Romy', stamp(400), '{"from":"' + T(1) + '"}'],
    ['REQ-0003', stamp(300), 'C010', 'Carl Chami', '3 month offer', '3 months', '', 'PKG-0003', 'Declined', 'Romy', stamp(200), '{}'],
    ['REQ-0004', stamp(100), 'C080', 'Kid Aoun', 'Reschedule', 'Move Friday', '', '', 'New', '', '', '{"a":1}']]);
  ops.add('NOTICES', [NOTICE_HEAD.slice(), ['NT-00001', stamp(90), 'joe', 'Cancel', 'Alice cancelled', ''], ['NT-00002', stamp(80), 'romy', 'Info', 'read one', stamp(70)],
    ['NT-00003', stamp(60), 'C001', 'Partner', 'Bea cancelled', ''], ['NT-00004', stamp(50), 'C080', 'Info', 'Kid notice', ''], ['NT-00005', stamp(40), 'majd', 'Info', 'For Majd', ''],
    ['NT-00006', stamp(30), 'G0002', 'Welcome', 'Hi Gia', ''], ['NT-00007', stamp(20), 'romy', 'Info', 'unread', '']]);
  ops.add('CLIENT WALLET', [WALLET_HEAD.slice(), [D(T(-9)), 'C001', 'Alice Aoun', 20, 'Overpaid', 'PKG-0001', 'Romy'], [D(T(-3)), 'C001', 'Alice Aoun', -5.5, 'Used', 'PKG-0001', 'Romy'],
    [D(T(-9)), 'C010', 'Carl Chami', 10, 'x', '', 'Romy'], [D(T(-8)), 'C010', 'Carl Chami', -10, 'y', '', 'Romy'], [D(T(-2)), 'C050', 'Dina Daher', 12.5, 'z', '', 'Romy']]);
  ops.add('CLIENT GOALS', [CL.GOAL_HEAD.slice(), ['C001', 'Alice Aoun', 'Squat without pain', 'Mobility daily', 'Never skip', '', stamp(1000), 'template'],
    ['G0002', 'Gia Guest', 'Feel strong', 'a', 'b', 'c', stamp(400), 'AI']]);
  ops.add('INSURANCE CLIENTS', [INS_CLIENT_HEAD.slice(), ['C050', 'Dina Daher', 'NextCare', 'M-1', 'note', stamp(900), 'Romy', 30], ['C070', 'Fadi Fares', 'GlobeMed', '', '', stamp(800), 'Romy', '']]);
  ops.add('INSURANCE CLAIMS', [INS_CLAIM_HEAD.slice(), ['CLM-0001', 'C050', 'Dina Daher', 'NextCare', '2026-09', 4, 108, 'PKG-0004, PKG-0013', '2026-10-05', '2027-01-03', 'R1', 'Sent', '', '', 'Romy']]);
  ops.add('EXPENSES', [['ID', 'Date', 'What', 'Category', 'Amount', 'By', 'x', 'y'], ['EXP-1', D(T(-2)), 'Towels', 'Supplies', 45, 'romy'], ['EXP-2', D(T(-120)), 'Rent', 'Rent', 900.5, 'majd', 'Recurring REC-001']]);
  ops.add('RECURRING EXPENSES', [['ID', 'What', 'Cat', 'Amt', 'Every', 'Start', 'End', 'Active', 'Last'], ['REC-001', 'Rent', 'Rent', 900, 'Monthly', T(-200), '', 'Y', T(-20)],
    ['REC-002', 'Old', 'Other', 10, 'Weekly', '2025-01-01', '2025-06-01', 'N', '']]);
  ops.add('POS INVENTORY', [['a', 'b', 'c', 'Item', 'e', 'Cost', 'g', 'h', 'Left', 'j', 'Price'], ['', '', '', 'Protein bar', 14, 1.5, '', 2, 12, '', 3],
    ['', '', '', 'Water', '', 0.2, '', '', 30, '', 0], ['', '', '', 'Gloves', -1, 5, '', 1, -2, '', 20]]);
  ops.add('POS SALES', [['ID', 'Date', 'Item', 'To', 'Qty', 'Amount', 'g', 'Profit', 'Method', 'By'], ['POSS-0001', D(T(-60)), 'Gloves', 'Carl Chami', 1, 20, 5, 15, 'Paid', 'via app (Romy)'],
    ['POSS-0002', D(T(-1)), 'Protein bar', 'Alice Aoun', 2, 6, 1.5, 3, 'Paid', 'via app (Majd Bou Habib)']]);
  ops.add('SESSION NOTES', [['Date', 'Session', 'Client ID', 'Client', 'By', 'Note', 'At'], [T(-4), 'S12-0003', 'C001', 'Alice Aoun', 'Joe', 'Knee ok', stamp(5000)],
    [T(-2), '', 'C001', 'Alice Aoun', 'Joe', 'Pushed squats', stamp(3000)], [T(-1), 'S11-0003', 'C050', 'Dina Daher', 'Mikel', 'Late', stamp(1000)]]);
  ops.add('PHYSIO INTAKE', [INTAKE_HEAD.slice(), [D(T(-30)), 'C001', 'Alice Aoun', 'Majd Bou Habib', 'Knee', 'Pain on stairs', 4, 'none', 'PFPS', 'Strength', '{"side":"L"}'],
    [D(T(-20)), 'C050', 'Dina Daher', 'Majd Bou Habib', 'Back', 'Stiff', '', '', 'Mech LBP', 'Mobility', '{}']]);
  ops.add('CLIENT FILES', [FILES_HEAD.slice(), ['C050', 'Dina Daher', 'mri.pdf', 'clients/C050/mri.pdf', 'application/pdf', 'Majd Bou Habib', D(T(-15))]]);
  ops.add(PROF.TAB, [PROF.HEAD.slice(), ['C001', 'Alice Aoun', 'data:image/jpeg;base64,QUJD', stamp(100)], ['G0002', 'Gia Guest', 'data:image/jpeg;base64,R0lB', stamp(90)]]);
  const notes = ops.getSheetByName('CLIENT NOTES');
  notes.d[1][7] = 5; notes.d[2][6] = 'Y';                                              // Alice: 5% client discount · Dina: Melanie's client
}
module.exports = { extend };
