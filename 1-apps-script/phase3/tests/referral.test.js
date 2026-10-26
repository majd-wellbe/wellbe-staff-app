#!/usr/bin/env node
// Referral server tests: Referral.gs + the real appSell_ (App.gs), clRequest_ invite (Client.gs), clAddPkg_ (Client.gs),
// phoneKey_ / nextId_ / scanIds_ (Code.gs) and the settings (Config.gs), in node with in memory sheets.
// Run: node 1-apps-script/phase3/tests/referral.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const DIR = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg + (extra !== undefined ? '\n        ' + JSON.stringify(extra).slice(0, 900) : '')); } }

// one top level function out of a .gs file (brace counting, strings and comments skipped)
function fnSrc(file, name) {
  const s = fs.readFileSync(path.join(DIR, file), 'utf8'), i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error(name + ' not found in ' + file);
  let k = s.indexOf('{', i), depth = 0, q = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '/' && s[k + 1] === '/') { k = s.indexOf('\n', k); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(i + 1, k + 1);
  }
  throw new Error('no end for ' + name);
}

// ---------- a tiny Apps Script world ----------
function makeWorld(opt) {
  opt = opt || {};
  const books = {}, cache = {};
  function Sheet(name) { this.name = name; this.rows = []; this.fmt = {}; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { let n = this.rows.length; while (n && !(this.rows[n - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) n--; return n; };
  Sheet.prototype.getLastColumn = function () { return this.rows.reduce((m, r) => Math.max(m, (r || []).length), 0); };
  Sheet.prototype.getMaxRows = function () { return 5000; };
  Sheet.prototype.getMaxColumns = function () { return 30; };
  Sheet.prototype.appendRow = function (r) { this.rows[this.getLastRow()] = r.slice(); return this; };
  Sheet.prototype.setFrozenRows = function () {};
  Sheet.prototype.getDataRange = function () { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    const sh = this; nr = nr || 1; nc = nc || 1;
    const vals = () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined || v === null ? '' : v); } out.push(o); } return out; };
    const rg = {
      getValues: vals,
      getDisplayValues: () => vals().map(row => row.map(v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v))),
      getValue: () => vals()[0][0],
      setValues: (vs) => { vs.forEach((vr, i) => { const ri = r - 1 + i; while (sh.rows.length <= ri) sh.rows.push([]); sh.rows[ri] = sh.rows[ri] || []; vr.forEach((v, j) => { sh.rows[ri][c - 1 + j] = v; }); }); return rg; },
      setValue: (v) => rg.setValues([[v]]),
      setNumberFormat: (f) => { sh.fmt[r + ':' + c] = f; return rg; },
      getFormula: () => '', setFormula: () => rg, setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg
    };
    return rg;
  };
  function Book() { this.tabs = {}; }
  Book.prototype.getSheetByName = function (n) { return this.tabs[n] || null; };
  Book.prototype.insertSheet = function (n) { return (this.tabs[n] = new Sheet(n)); };
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Error, RegExp, encodeURIComponent,
    Logger: { log: (m) => { if (opt.log) console.log('    log: ' + m); } },
    SpreadsheetApp: { openById: (id) => books[id] || (books[id] = new Book()), flush: () => {} },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) },
    Utilities: { formatDate: (d, tz, f) => {
      const p = n => String(n).padStart(2, '0'), y = d.getUTCFullYear(), mo = p(d.getUTCMonth() + 1), da = p(d.getUTCDate());
      if (f === 'yyyy-MM-dd') return y + '-' + mo + '-' + da; if (f === 'dd/MM') return da + '/' + mo;
      return da + '/' + mo + '/' + y + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  };
  vm.createContext(ctx);
  const cfgSrc = fs.readFileSync(path.join(DIR, 'Config.gs'), 'utf8');
  const code = [
    "var CFG = { OPS_ID: 'OPS', CLIENTS_ID: 'CLI', CLIENTS_TAB: 'CLIENTS', LEADS_TAB: 'LEADS W40', TZ: 'UTC' };",
    fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8').match(/var L = \{[\s\S]*?\};/)[0],
    cfgSrc.slice(cfgSrc.indexOf('var CFG_DEFAULTS'), cfgSrc.indexOf('var CFG_KINDS')),
    'var CFG_MEMO_ = null; function cfg_() { return CFG_MEMO_ || (CFG_MEMO_ = JSON.parse(JSON.stringify(CFG_DEFAULTS))); }',
    // App.gs / Code.gs / Client.gs helpers used as they are
    ...['phoneKey_', 'clean_', 'cellSafe_', 'nextId_', 'scanIds_'].map(n => fnSrc('Code.gs', n)),
    ...['cfgType_', 'cfgTypes_', 'cfgValid_', 'cfgStaffByTrainer_', 'cfgStaffById_', 'cfgFixed_', 'cfgService_', 'cfgDeskName_', 'cfgDeskId_', 'cfgStaff_'].map(n => fnSrc('Config.gs', n)),
    ...['appSell_', 'appTab_', 'appRows_', 'appNum_', 'appShift_', 'appClientInfo_', 'noticeAdd_', 'noticeTab_'].map(n => fnSrc('App.gs', n)),
    "var NOTICE_HEAD = ['ID', 'Created', 'For', 'Type', 'Text', 'Read'];",
    ...['clRequest_', 'clLog_', 'clReqObj_', 'clPkgIds_', 'clPingOk_', 'clAddPkg_'].map(n => fnSrc('Client.gs', n)),
    "var CL = { REQ_HEAD: ['ID', 'Created', 'Client ID', 'Client', 'Type', 'Details', 'Slot / Session', 'Package', 'Status', 'Handled by', 'Handled at', 'Data'] };",
    // stubs for what is not under test
    'function roGuard_() {} function clPingRomy_() {} function guestById_() { return null; }',
    'var MEL = {}; function appIsMel_(cid) { return !!MEL[cid]; } function appFlag_(b) { MEL[b.cid] = 1; }',
    "function beirutDate_(ymd) { return new Date(ymd + 'T00:00:00Z'); }",
    'function writeLikeTemplate_(sh, rowNum, tplRow, row) { sh.getRange(rowNum, 1, 1, row.length).setValues([row]); }',
    opt.walletAdd ? 'var WALLET_CALLS = []; function walletAdd_() { WALLET_CALLS.push([].slice.call(arguments, 1)); }' : '',
    fs.readFileSync(path.join(DIR, 'Referral.gs'), 'utf8')
  ].join('\n');
  vm.runInContext(code, ctx);

  // the sheets: CLIENTS (Client Portal), PACKAGES with its 2 header rows and the template row PKG-0001
  const cli = ctx.SpreadsheetApp.openById('CLI').insertSheet('CLIENTS');
  cli.rows.push(['Client ID', 'Name', 'Email', 'Phone']);
  const ops = ctx.SpreadsheetApp.openById('OPS');
  const pk = ops.insertSheet('PACKAGES'); pk.rows.push(['PACKAGES'], ['Package ID', 'Client ID', 'Client Name', 'Package Type', 'Total', 'Used', 'Remaining', 'Per pass', 'Price']);
  pk.rows.push(['PKG-0001', 'C999', 'Old Client', '1:3 - 8x/month ($140pp)', 8, 8, 0, 17.5, 140, '', '', '', '', 'Active']);
  const leads = ops.insertSheet('LEADS W40'); leads.rows.push(['ID', 'Sub', 'Name', 'Phone', 'Trained', 'Stopped', 'Why', 'Inj', 'Date', 'Time', 'Type', 'Status', 'Called', 'Notes', 'Src', 'Client ID', 'Pkg', 'Sid', 'Email']);
  const w = {
    ctx, ops, cli, pk, leads,
    run: (src) => vm.runInContext(src, ctx),
    client: (id, name, phone) => { cli.rows.push([id, name, (name.split(' ')[0] + '@x.com').toLowerCase(), phone]); },
    lead: (name, phone, cid) => { const r = []; r[0] = 'L' + leads.rows.length; r[2] = name; r[3] = phone; r[15] = cid || ''; leads.rows.push(r); },
    // what the client app sends: phone as normPhone() makes it (961 + local number)
    invite: (cid, fname, phone) => { try { return vm.runInContext('clRequest_', ctx)({ kind: 'invite', fname: fname, phone: phone, msg: 'Hi ' + fname }, cid); } catch (e) { return { error: e.message }; } },
    sell: (cid, type, extra) => vm.runInContext('appSell_', ctx)(Object.assign({ type: type, cid: cid, paid: 0 }, extra || {}), { name: 'Romy' }),
    onSale: (cid) => vm.runInContext('refOnSale_', ctx)(ops, cid),
    refs: () => { const s = ops.getSheetByName('REFERRALS'); return s ? s.rows.slice(1).filter(r => r && r[0]) : []; },
    wallet: () => { const s = ops.getSheetByName('CLIENT WALLET'); return s ? s.rows.slice(1).filter(r => r && r[1]) : []; },
    reqs: () => { const s = ops.getSheetByName('CLIENT REQUESTS'); return s ? s.rows.slice(1).filter(r => r && r[0]) : []; }
  };
  return w;
}
const PAID = '1:3 - 8x/month ($140pp)', TRIAL = 'Trial Session - 1:3 (Free)', FREE = 'Assessment - Majd (Free)';

// ---------- 1. phone normalization ----------
console.log('1. phone normalization');
{
  const w = makeWorld(), k = w.run('refKey_');
  [['+961 3 123 456', '3123456'], ['03 123 456', '3123456'], ['961 3123456', '3123456'], ['9613123456', '3123456'], ['00961 3 123 456', '3123456'],
   ['+961 70-123-456', '70123456'], ['070 123 456', '70123456'], ['70123456', '70123456'], [' 961 70 123 456 ', '70123456']].forEach(([a, b]) => ok(k(a) === b, 'phone ' + JSON.stringify(a) + ' -> ' + b, k(a)));
  w.client('C001', 'Lara Khoury', '03 111 222');
  const r = w.invite('C001', 'Sara Haddad', '96170123456');
  const row = w.refs()[0];
  ok(!r.error && row && row[5] === '70123456', 'REFERRALS keeps the friend phone normalized', [r, row]);
  ok(w.ops.getSheetByName('REFERRALS').fmt['2:6'] === '@', 'phone cell is text (no number format)');
  ok(w.ops.getSheetByName('REFERRALS').rows[0].join() === w.run('REF.HEAD').join(), 'REFERRALS has its header row');
}

// ---------- 2. invite stored, request kept for Romy ----------
console.log('2. the invite');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222');
  const r = w.invite('C001', 'Sara Haddad', '96170123456');
  ok(r.ref && r.ref.status === 'Invited' && /^REF-0001$/.test(r.ref.id), 'answer has the referral (old apps ignore it)', r);
  const row = w.refs()[0], q = w.reqs()[0];
  ok(row[2] === 'C001' && row[3] === 'Lara Khoury' && row[4] === 'Sara Haddad' && row[6] === 'Invited' && /^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(row[1]), 'row: referrer, friend, status, date', row);
  ok(row[12] === 1, 'row remembers the last package number at the invite', row[12]);
  ok(q && q[4] === 'Friend invite' && q[2] === 'C001' && JSON.parse(q[11]).ref === 'REF-0001' && JSON.parse(q[11]).phone === '96170123456', 'CLIENT REQUESTS row still made for Romy, with the referral ID', q);
  ok(/Referral REF-0001: Lara Khoury gets \$5 credit/.test(q[5]) && /wa\.me\/96170123456/.test(q[5]), 'request text tells Romy about the credit, invite link kept', q[5]);
  ok(row[11] === q[0], 'referral row points to the request', [row[11], q[0]]);
  const again = w.invite('C001', 'Sara', '+961 70 123 456');
  ok(again.ref && again.ref.id === 'REF-0001' && w.refs().length === 1 && w.reqs().length === 2, 'same client, same friend again: no second referral row (request still goes to Romy)', [again, w.refs().length]);
  const bad = w.invite('C001', 'Sara', '123');
  ok(bad.error && w.refs().length === 1, 'bad phone refused', bad);
}

// ---------- 3. reward on the first paid package, not on trial or free ----------
console.log('3. reward on the first paid package only');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222');
  w.invite('C001', 'Sara Haddad', '96170123456');
  w.client('C010', 'Sara Haddad', '070 123 456');                  // she joins (Romy makes her a client)
  let s = w.sell('C010', TRIAL);
  ok(!s.referral && w.wallet().length === 0 && w.refs()[0][6] === 'Invited', 'free trial: no credit', s);
  s = w.sell('C010', FREE);
  ok(!s.referral && w.wallet().length === 0, 'free package: no credit', s);
  s = w.sell('C010', PAID, { price: 0 });
  ok(!s.referral && w.wallet().length === 0, 'paid type sold at $0: no credit', s);
  s = w.sell('C010', PAID, { paid: 140 });
  const wl = w.wallet(), row = w.refs()[0];
  ok(s.referral && s.referral.by === 'C001' && s.referral.amount === 5 && s.referral.friend === 'Sara Haddad', 'first paid package: credit given, sale answer says so', s);
  ok(wl.length === 1 && wl[0][1] === 'C001' && wl[0][2] === 'Lara Khoury' && wl[0][3] === 5 && wl[0][4] === 'Referral: Sara Haddad' && wl[0][5] === s.id && wl[0][6] === 'auto' && wl[0][0] instanceof Date,
    'CLIENT WALLET: + $5, Reason, friend package, By auto', wl);
  ok(row[6] === 'Rewarded' && row[7] === 'C010' && row[8] === s.id && row[9] === 5 && row[10], 'REFERRALS row: Rewarded, friend ID, package, credit, time', row);
  const n = w.ops.getSheetByName('NOTICES').rows.slice(1);
  ok(n.length === 1 && n[0][2] === 'C001' && /Sara joined Wellbe\. \$5 Wellbe Credit/.test(n[0][4]), 'the client who invited gets an in app notice', n);
  ok(w.run("refWalletBal_(SpreadsheetApp.openById('OPS'), 'C001')") === 5, 'wallet balance of the referrer is $5 (same ledger as any wallet credit)');
}

// ---------- 4. never twice ----------
console.log('4. no double reward');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C010', 'Sara Haddad', '70123456');
  w.invite('C001', 'Sara Haddad', '96170123456');
  w.sell('C010', PAID, { months: 3 });                                 // a 3 month bundle: 3 rows, one credit
  ok(w.wallet().length === 1, '3 month bundle: one credit', w.wallet());
  w.sell('C010', PAID);
  ok(w.onSale('C010') === null && w.onSale('C010') === null, 'running the check again gives nothing');
  ok(w.wallet().length === 1 && w.refs()[0][6] === 'Rewarded', 'second paid package: still one credit', w.wallet());
  // wallet line already there (row status lost): not written again
  w.refs()[0][6] = 'Invited';
  w.onSale('C010');
  ok(w.wallet().length === 1 && w.refs()[0][6] === 'Rewarded', 'wallet line already there: not added twice, row fixed', w.wallet());
  // the app_sell route runs the check a second time (App.gs appRoute_): idempotent
  const src = fs.readFileSync(path.join(DIR, 'App.gs'), 'utf8');
  ok(/b\.action === 'app_sell' && !out\.referral && typeof refOnSale_ === 'function'/.test(src) && /res\.referral = rw/.test(src), 'App.gs: hook in appSell_ and after app_sell in the router');
  ok(/refOnSale_\(ops, cid\)/.test(fnSrc('Client.gs', 'clAddPkg_')), 'Client.gs: clAddPkg_ (3 and 6 month offers) runs the check too');
}

// ---------- 5. first inviter wins ----------
console.log('5. first inviter wins');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C002', 'Maya Saab', '71 999 888');
  const a = w.invite('C001', 'Sara Haddad', '96170123456'), b = w.invite('C002', 'Sara H', '9610070123456'.replace('96100', '961'));
  ok(a.ref.status === 'Invited' && b.ref.status === 'Already invited', 'second client inviting the same phone: Already invited', [a, b]);
  ok(/Invited first by Lara Khoury \(REF-0001\)/.test(w.refs()[1][13]) && /no credit/.test(w.reqs()[1][5]), 'note and request say who invited first', [w.refs()[1], w.reqs()[1][5]]);
  w.client('C010', 'Sara Haddad', '+961 70 123 456');
  const s = w.sell('C010', PAID);
  ok(s.referral && s.referral.by === 'C001' && w.wallet().length === 1 && w.wallet()[0][1] === 'C001', 'credit to the first inviter only', w.wallet());
  ok(w.refs()[1][6] === 'Already invited', 'second inviter row unchanged', w.refs()[1]);
}

// ---------- 6. friend already a client ----------
console.log('6. existing client: no reward');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C020', 'Rami Aoun', '76 555 444');
  w.sell('C020', PAID);                                                // Rami already pays
  const r = w.invite('C001', 'Rami', '96176555444');
  ok(r.ref.status === 'Already a client' && w.refs()[0][7] === 'C020', 'invite of a paying client: Already a client', [r, w.refs()[0]]);
  const s = w.sell('C020', PAID);
  ok(!s.referral && w.wallet().length === 0, 'his next package: no credit', w.wallet());
  // a trial only client is not a paying client yet: eligible
  w.client('C021', 'Nour Fares', '81 222 333'); w.sell('C021', TRIAL);
  ok(w.invite('C001', 'Nour', '96181222333').ref.status === 'Invited', 'trial only client: Invited');
  ok(w.sell('C021', PAID).referral, 'her first paid package after the invite: credit');
  // paid before the invite, but the phone was not on file then: the package number check still says no
  w.client('C030', 'Karim Daher', '');
  w.sell('C030', PAID);
  ok(w.invite('C001', 'Karim', '96170777666').ref.status === 'Invited', 'unknown phone at the invite: Invited');
  w.cli.rows.filter(r => r[0] === 'C030')[0][3] = '70 777 666';      // Romy adds his phone later
  const k = w.sell('C030', PAID), row = w.refs().filter(r => r[4] === 'Karim')[0];
  ok(!k.referral && row[6] === 'Already a client' && /was there before the invite/.test(row[13]), 'had a paid package before the invite: no credit', row);
  ok(w.wallet().length === 1, 'only Nour gave credit', w.wallet());
}

// ---------- 7. self referral ----------
console.log('7. self referral: no reward');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222');
  const r = w.invite('C001', 'Me', '9613111222');
  ok(r.error && /own number/.test(r.error) && w.refs().length === 0 && w.reqs().length === 0, 'own phone refused, nothing saved', r);
  // her other number shows up later on a lead linked to her: no credit to herself
  w.invite('C001', 'Lea', '96171000111');
  w.lead('Lara Khoury', '71 000 111', 'C001');
  const s = w.sell('C001', PAID);
  ok(!s.referral && w.wallet().length === 0 && w.refs()[0][6] === 'Not eligible' && w.refs()[0][13] === 'Self referral', 'own second number: Not eligible', w.refs()[0]);
  // and an invite of a number already linked to her is refused
  ok(/own number/.test(w.invite('C001', 'X', '96171000111').error || ''), 'number linked to her (lead): refused');
}

// ---------- 8. matching through a lead / guest ----------
console.log('8. matched by the lead phone');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222');
  w.invite('C001', 'Sara Haddad', '96170123456');
  w.lead('Sara Haddad', '+961 70 123 456', 'C010');
  w.client('C010', 'Sara Haddad', '03 999 000');                       // another phone on her client card
  const s = w.sell('C010', PAID);
  ok(s.referral && s.referral.by === 'C001', 'friend found through LEADS W40 (phone -> client ID)', s);
  const g = makeWorld(); g.client('C001', 'Lara Khoury', '03 111 222');
  g.invite('C001', 'Tia', '96178123123');
  const gs = g.ops.insertSheet('APP GUESTS'); gs.rows.push(['Guest ID', 'Email', 'Name', 'Phone', 'Created', 'Verified', 'Lead ID', 'Asked', 'Client ID'], ['G0001', 't@x.com', 'Tia', '078 123 123', '', '', '', '', 'C011']);
  g.client('C011', 'Tia Nasr', '');
  ok(g.sell('C011', PAID).referral, 'friend found through APP GUESTS (phone -> client ID)');
}

// ---------- 9. the amount comes from the settings ----------
console.log('9. referral.amount setting');
{
  const w = makeWorld();
  ok(w.run('CFG_DEFAULTS.referral.amount') === 5, 'default $5 in Config.gs');
  w.run('cfg_().referral.amount = 10');
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C010', 'Sara', '70123456');
  w.invite('C001', 'Sara', '96170123456');
  ok(w.sell('C010', PAID).referral.amount === 10 && w.wallet()[0][3] === 10, 'SETTINGS referral.amount = 10: $10 credit', w.wallet());
  const z = makeWorld(); z.run('cfg_().referral.amount = 0');
  z.client('C001', 'Lara Khoury', '03 111 222'); z.client('C010', 'Sara', '70123456');
  z.invite('C001', 'Sara', '96170123456');
  ok(!z.sell('C010', PAID).referral && z.wallet().length === 0, 'amount 0: referrals off');
  // the setting row is accepted by the SETTINGS reader (same kind of value as the default)
  const cfgSrc = fs.readFileSync(path.join(DIR, 'Config.gs'), 'utf8');
  ok(/referral: \{ amount: 5 \}/.test(cfgSrc), 'Config.gs CFG_DEFAULTS.referral.amount (cfgSetup adds the SETTINGS row)');
}

// ---------- 10. the live Wallet.gs walletAdd_ is used when it is there ----------
console.log('10. walletAdd_');
{
  const w = makeWorld({ walletAdd: true });
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C010', 'Sara Haddad', '70123456');
  w.invite('C001', 'Sara Haddad', '96170123456');
  const s = w.sell('C010', PAID), calls = w.run('WALLET_CALLS');
  ok(calls.length === 1 && calls[0].join('|') === ['C001', 'Lara Khoury', 5, 'Referral: Sara Haddad', s.id, 'auto'].join('|'), 'walletAdd_(ops, cid, name, amount, reason, package, "auto")', calls);
}

// ---------- 11. what the apps see ----------
console.log('11. client and staff boot');
{
  const w = makeWorld();
  w.client('C001', 'Lara Khoury', '03 111 222'); w.client('C002', 'Maya Saab', '71 999 888');
  w.sell('C002', PAID);                                                // Maya already pays
  w.invite('C001', 'Sara Haddad', '96170123456'); w.invite('C001', 'Omar', '96176123123'); w.invite('C001', 'Maya', '96171999888'); w.invite('C002', 'Omar', '96176123123');
  w.lead('Omar', '76 123 123', '');                                    // Omar asked for a trial: joined
  w.client('C010', 'Sara Haddad', '70123456'); w.sell('C010', PAID);
  w.sell('C002', PAID);                                                // Maya's next package: nothing
  const d = w.run('refClientBoot_')({ accounts: [{ cid: 'C001' }, { cid: 'C002' }] });
  const a = d.accounts[0], by = {}; a.refs.forEach(x => { by[x.n] = x; });
  ok(a.refs.length === 3 && a.refs[0].n === 'Maya', 'newest invite first', a.refs);
  ok(by['Sara Haddad'].st === 'earned' && by['Sara Haddad'].amt === 5 && by.Omar.st === 'joined' && /^\d{4}-\d\d-\d\d$/.test(by.Omar.d), 'statuses: +$5 earned, Joined', by);
  ok(a.credit === 5, 'wallet credit shown to the client', a.credit);
  ok(d.accounts[1].refs[0].st === 'already' && !d.accounts[1].credit, 'second inviter sees Already invited, no credit', d.accounts[1]);
  ok(by.Maya.st === 'client', 'Maya was already a paying client when invited (she is C002)', by.Maya);
  const st = w.run('refStaffBoot_')({}, { role: 'assistant' });
  ok(st.referral.amount === 5 && st.refs.length === 4, 'staff boot: every referral', st);
  const omar = st.refs.filter(r => r.friend === 'Omar')[0];
  ok(omar.st === 'Invited' && Array.isArray(omar.due), 'invited friend without a client record yet: due list empty', omar);
  w.client('C012', 'Omar Itani', '76 123 123');
  const st2 = w.run('refStaffBoot_')({}, { role: 'owner' }), om2 = st2.refs.filter(r => r.friend === 'Omar' && r.st === 'Invited')[0];
  ok(om2.due.join() === 'C012' && om2.byName === 'Lara Khoury', 'once Omar is a client the sell screen can say "Referred by Lara"', om2);
  ok(!w.run('refStaffBoot_')({}, { role: 'trainer' }).refs, 'trainers get no referrals');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
