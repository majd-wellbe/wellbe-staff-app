#!/usr/bin/env node
// =====================================================================
// WELLBE Supabase tests (real Postgres 16):
//  A. differential: the same action on the same data in the Apps Script (in memory sheets) and in Postgres,
//     then the end states are compared field by field (packages, sessions, attendance, notices, requests, wallet, game, streak)
//  B. who sees what (Row Level Security) for owner, assistant, trainer, client, other client, anon
//  C. import: fixture sheets -> CSV -> import.js -> database, every row accounted for
// Run: ./lib/snapshot.sh (once, copies the Apps Script from git) then: node run.js
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-'));

let pass = 0, fail = 0; const fails = [];
function ok(c, msg, extra) { if (c) pass++; else { fail++; fails.push(msg); console.log('   FAIL: ' + msg + (extra ? '\n         ' + String(extra).slice(0, 1500) : '')); } }
const J = x => JSON.stringify(x);
const fl = x => typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : typeof x === 'string' ? x.replace(/\d+\.\d{7,}/g, m => String(Math.round(Number(m) * 1e6) / 1e6))
  : Array.isArray(x) ? x.map(fl) : x && typeof x === 'object' ? Object.keys(x).reduce((o, k) => (o[k] = fl(x[k]), o), {}) : x;
function diff(a, b, pathS) {   // first differences between two JSON-able values
  const out = [];
  a = fl(a); b = fl(b);
  (function walk(x, y, p) {
    if (out.length > 8) return;
    if (J(x) === J(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) out.push(`${p}: ${x.length} rows vs ${y.length} rows\n           gs:  ${J(x).slice(0, 600)}\n           sql: ${J(y).slice(0, 600)}`); else x.forEach((v, i) => walk(v, y[i], p + '[' + i + ']')); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { new Set(Object.keys(x).concat(Object.keys(y))).forEach(k => walk(x[k], y[k], p + '.' + k)); return; }
    out.push(`${p}: gs ${J(x)} vs sql ${J(y)}`);
  })(a, b, pathS || '');
  return out;
}

// sheets -> csv -> sql -> a fresh database copy, with logins
async function loadInto(db) {
  const dir = path.join(TMP, db); exportBooks(M.books, dir);
  const { sql, P } = I.run(dir, GS);
  await D.freshDb(db);
  await D.withDb(db, async c => {
    await c.query(['begin;'].concat(sql, ['commit;']).join('\n'));
    await D.makeLogins(c);
  });
  return P;
}
const rowOf = (sh, id) => sh.d.findIndex(r => r[0] === id) + 1;
function ref(id) { for (const k of Object.keys(AT)) { const sh = M.books[CFG.OPS_ID].getSheetByName(AT[k].sheet); const r = sh ? rowOf(sh, id) : 0; if (r) return k + '|' + r; } throw new Error('no session ' + id); }
const sid = (c, legacy) => c.query('select id from public.sessions where legacy_id = $1', [legacy]).then(r => r.rows[0].id);
const pid = (c, legacy) => c.query('select id from public.packages where legacy_id = $1', [legacy]).then(r => r.rows[0].id);
const cidOf = (c, legacy) => c.query('select id from public.clients where legacy_id = $1', [legacy]).then(r => r.rows[0].id);
const gsUsed = () => M.books[CFG.OPS_ID].getSheetByName('PACKAGES').d.slice(2).filter(r => r[0]).map(r => [r[0], Number(r[5]) || 0]);

// ---------------------------------------------------------------------
// A. differential scenarios: setup (both sides) -> gs action / sql action -> compare states
// ---------------------------------------------------------------------
const today = n => F.today(n || 0);
const SC = [];
const sc = (name, o) => SC.push(Object.assign({ name }, o));
const err = r => (r && r.error ? r.error.replace(/^ERROR:\s*/, '') : null);

sc('sell 1:3 8x, 1 month, paid in full', {
  gs: () => F.st('app_sell', 'k-romy', { type: '1:3 - 8x/month ($140pp)', cid: 'C050', months: 1, paid: 140 }),
  sql: async c => D.as(c, 'romy', `select public.sell_package($1, '1:3 - 8x/month ($140pp)', 1, 0, null, 140, null, 'Cash')`, [await cidOf(c, 'C050')]) });
sc('sell 3 months at 7%, part paid', {
  gs: () => F.st('app_sell', 'k-romy', { type: '1:3 - 12x/month ($200pp)', cid: 'C001', months: 3, discount: 7, paid: 250, method: 'Whish' }),
  sql: async c => D.as(c, 'romy', `select public.sell_package($1, '1:3 - 12x/month ($200pp)', 3, 7, null, 250, null, 'Whish')`, [await cidOf(c, 'C001')]) });
sc('sell 6 months at a typed final price, starting in 3 days', {
  gs: () => F.st('app_sell', 'k-majd', { type: '1:2 - 8x/month ($180pp)', cid: 'C002', months: 6, price: 900, paid: 0, start: today(3) }),
  sql: async c => D.as(c, 'majd', `select public.sell_package($1, '1:2 - 8x/month ($180pp)', 6, 0, 900, 0, $2::date, 'Cash')`, [await cidOf(c, 'C002'), today(3)]) });
sc('sell Madero (2 months, Melanie) and PT with Mel (client becomes Melanie\'s)', {
  gs: () => [F.st('app_sell', 'k-romy', { type: 'Madero - 6 Sessions ($270)', cid: 'C060', paid: 270 }), F.st('app_sell', 'k-romy', { type: 'PT with Mel 1:1 - 8 Sessions ($250)', cid: 'C070', paid: 100 }),
    F.st('app_sell', 'k-romy', { type: '1:1 - 4x/month ($110)', cid: 'C070', paid: 0 })],
  sql: async c => [await D.as(c, 'romy', `select public.sell_package($1, 'Madero - 6 Sessions ($270)', 1, 0, null, 270)`, [await cidOf(c, 'C060')]),
    await D.as(c, 'romy', `select public.sell_package($1, 'PT with Mel 1:1 - 8 Sessions ($250)', 1, 0, null, 100)`, [await cidOf(c, 'C070')]),
    await D.as(c, 'romy', `select public.sell_package($1, '1:1 - 4x/month ($110)', 1, 0, null, 0)`, [await cidOf(c, 'C070')])] });
sc('sell Prehab (3 months), Stretching (42 days), Physio single (10 days), 31st of the month start', {
  gs: () => [F.st('app_sell', 'k-romy', { type: 'Prehab - 10 Sessions ($400)', cid: 'C010', paid: 400, start: '2026-01-31' }),
    F.st('app_sell', 'k-romy', { type: 'Stretching & Mobility - 4 Sessions ($140)', cid: 'C010', paid: 0 }), F.st('app_sell', 'k-romy', { type: 'Physio - Single Session ($50)', cid: 'C010', discount: 20, paid: 40 })],
  sql: async c => { const x = await cidOf(c, 'C010'); return [await D.as(c, 'romy', `select public.sell_package($1, 'Prehab - 10 Sessions ($400)', 1, 0, null, 400, '2026-01-31')`, [x]),
    await D.as(c, 'romy', `select public.sell_package($1, 'Stretching & Mobility - 4 Sessions ($140)', 1, 0, null, 0)`, [x]), await D.as(c, 'romy', `select public.sell_package($1, 'Physio - Single Session ($50)', 1, 20, null, 40)`, [x])]; } });
sc('overpaid at the sale goes to the wallet, then used on the next package', {
  gs: () => [F.st('app_sell', 'k-romy', { type: '1:3 - 8x/month ($140pp)', cid: 'C071', paid: 200 }), F.st('app_sell', 'k-romy', { type: '1:3 - 8x/month ($140pp)', cid: 'C071', paid: 0, useWallet: true })],
  sql: async c => { const x = await cidOf(c, 'C071'); return [await D.as(c, 'romy', `select public.sell_package($1, '1:3 - 8x/month ($140pp)', 1, 0, null, 200)`, [x]), await D.as(c, 'romy', `select public.sell_package($1, '1:3 - 8x/month ($140pp)', 1, 0, null, 0, null, 'Cash', true)`, [x])]; } });
sc('payment: part, then more than due (extra to wallet)', {
  gs: () => [F.st('app_pay', 'k-romy', { pkg: 'PKG-0005', amount: 100, method: 'Cash' }), F.st('app_pay', 'k-romy', { pkg: 'PKG-0005', amount: 60, method: 'Whish', note: 'rest' })],
  sql: async c => { const p = await pid(c, 'PKG-0005'); return [await D.as(c, 'romy', `select public.pay_package($1, 100, 'Cash')`, [p]), await D.as(c, 'romy', `select public.pay_package($1, 60, 'Whish', 'rest')`, [p])]; } });
sc('a trainer cannot sell', { refusal: true,
  gs: () => F.st('app_sell', 'k-joe', { type: '1:3 - 8x/month ($140pp)', cid: 'C050', paid: 0 }),
  sql: async c => D.as(c, 'joe', `select public.sell_package($1, '1:3 - 8x/month ($140pp)')`, [await cidOf(c, 'C050')]),
  result: (g, s) => ok(!g.ok && /not allowed/.test(g.error) && /not allowed/.test(err(s)), 'both refuse: ' + J(g) + ' ' + J(s)) });

sc('attendance: 1:3 Present by Joe, 1:1 Late Cancel by Romy, 1:2 one Late Cancel then the other Present', {
  gs: () => [F.st('app_att', 'k-joe', { ref: ref('S13-0001'), id: 'S13-0001', i: 0, att: 'Present' }), F.st('app_att', 'k-romy', { ref: ref('S11-0001'), id: 'S11-0001', i: 0, att: 'Late Cancel' }),
    F.st('app_att', 'k-romy', { ref: ref('S12-0002'), id: 'S12-0002', i: 0, att: 'Late Cancel' }), F.st('app_att', 'k-romy', { ref: ref('S12-0002'), id: 'S12-0002', i: 1, att: 'Present' })],
  sql: async c => [await D.as(c, 'joe', `select public.mark_attendance($1, 0, 'Present')`, [await sid(c, 'S13-0001')]), await D.as(c, 'romy', `select public.mark_attendance($1, 0, 'Late Cancel')`, [await sid(c, 'S11-0001')]),
    await D.as(c, 'romy', `select public.mark_attendance($1, 0, 'Late Cancel')`, [await sid(c, 'S12-0002')]), await D.as(c, 'romy', `select public.mark_attendance($1, 1, 'Present')`, [await sid(c, 'S12-0002')])] });
sc('attendance: Mikel cannot mark Joe\'s session', { refusal: true,
  gs: () => F.st('app_att', 'k-mikel', { ref: ref('S13-0001'), id: 'S13-0001', i: 0, att: 'Present' }),
  sql: async c => D.as(c, 'mikel', `select public.mark_attendance($1, 0, 'Present')`, [await sid(c, 'S13-0001')]),
  result: (g, s) => ok(!g.ok && /Not your session/.test(g.error) && /Not your session/.test(err(s)), 'both refuse') });
sc('staff: 1:2 Early Cancel by Romy cancels the pair with notices', {
  gs: () => F.st('app_att', 'k-romy', { ref: ref('S12-0001'), id: 'S12-0001', i: 1, att: 'Early Cancel' }),
  sql: async c => D.as(c, 'romy', `select public.mark_attendance($1, 1, 'Early Cancel')`, [await sid(c, 'S12-0001')]) });
sc('client: 1:2 early cancel cancels both, partner + trainer + desk + owner told', {
  gs: () => F.cl('app_cl_cancel', 'alice@x.com', { cid: 'C001', ref: ref('S12-0001'), id: 'S12-0001' }),
  sql: async c => D.as(c, 'alice@x.com', `select public.cancel_session($1, $2)`, [await sid(c, 'S12-0001'), await cidOf(c, 'C001')]),
  result: (g, s) => ok(g.ok && g.kind === 'Early Cancel' && g.whole === true && s.rows && s.rows[0].cancel_session.whole === true, 'result kind/whole ' + J(g) + J(s)) });
sc('client: 1:3 early cancel keeps the session for the others', {
  gs: () => F.cl('app_cl_cancel', 'fadi@x.com', { cid: 'C070', ref: ref('S13-0001'), id: 'S13-0001' }),
  sql: async c => D.as(c, 'fadi@x.com', `select public.cancel_session($1, $2)`, [await sid(c, 'S13-0001'), await cidOf(c, 'C070')]) });
sc('client: cannot cancel someone else\'s session', { refusal: true,
  gs: () => F.cl('app_cl_cancel', 'bea@x.com', { cid: 'C001', ref: ref('S12-0001'), id: 'S12-0001' }),
  sql: async c => D.as(c, 'bea@x.com', `select public.cancel_session($1, $2)`, [await sid(c, 'S12-0001'), await cidOf(c, 'C001')]),
  result: (g, s) => ok(!g.ok && /Not your account/.test(g.error) && /Not your account/.test(err(s)), 'both refuse ' + J(g) + J(s)) });
sc('client: join a free 1:3 chair after buying a package', {
  gs: () => [F.st('app_sell', 'k-romy', { type: '1:3 - 8x/month ($140pp)', cid: 'C050', paid: 140 }), F.cl('app_cl_join', 'dina@x.com', { cid: 'C050', date: today(4), time: '08:00', trainer: 'Joe' })],
  sql: async c => { const x = await cidOf(c, 'C050'); return [await D.as(c, 'romy', `select public.sell_package($1, '1:3 - 8x/month ($140pp)', 1, 0, null, 140)`, [x]),
    await D.as(c, 'dina@x.com', `select public.client_join($1, $2::date, '08:00', 'Joe')`, [x, today(4)])]; } });
sc('client: join refused when every pass is already booked', { refusal: true,
  gs: () => F.cl('app_cl_join', 'carl@x.com', { cid: 'C010', date: today(4), time: '08:00', trainer: 'Joe' }),
  sql: async c => D.as(c, 'carl@x.com', `select public.client_join($1, $2::date, '08:00', 'Joe')`, [await cidOf(c, 'C010'), today(4)]),
  result: (g, s) => ok(!g.ok && err(s) === g.error, 'same refusal: ' + g.error + ' | ' + err(s)) });
sc('staff: book a new 1:2 and a physio', {
  gs: () => [F.st('app_book', 'k-romy', { type: '1:2', date: today(7), time: '18:00', trainer: 'Mikel', pkg: 'PKG-0001', name: 'Alice Aoun' }),
    F.st('app_sell', 'k-romy', { type: 'Physio - Single Session ($50)', cid: 'C050', paid: 0 }), F.st('app_book', 'k-romy', { type: 'Physio', date: today(8), time: '16:00', trainer: '', pkg: 'PKG-0012', name: 'Dina Daher' })],
  sql: async c => [await D.as(c, 'romy', `select public.book_session('1:2', $1::date, '18:00', 'Mikel', $2, 'Alice Aoun')`, [today(7), await pid(c, 'PKG-0001')]),
    await D.as(c, 'romy', `select public.sell_package($1, 'Physio - Single Session ($50)', 1, 0, null, 0)`, [await cidOf(c, 'C050')]),
    await D.as(c, 'romy', `select public.book_session('Physio', $1::date, '16:00', '', $2, 'Dina Daher')`, [today(8), await pid(c, 'PKG-0012')])] });
sc('staff: Joe already has 3 at 09:00 (cap), and a physio package cannot go in a 1:1', {
  gs: () => [F.st('app_book', 'k-romy', { type: '1:1', date: today(4), time: '09:00', trainer: 'Joe', pkg: 'PKG-0004', name: 'Dina Daher' }),
    F.st('app_sell', 'k-romy', { type: 'Physio - Single Session ($50)', cid: 'C050', paid: 0 }), F.st('app_book', 'k-romy', { type: '1:1', date: today(9), time: '10:00', trainer: 'Mikel', pkg: 'PKG-0012', name: 'Dina Daher' })],
  sql: async c => [await D.as(c, 'romy', `select public.book_session('1:1', $1::date, '09:00', 'Joe', $2, 'Dina Daher')`, [today(4), await pid(c, 'PKG-0004')]),
    await D.as(c, 'romy', `select public.sell_package($1, 'Physio - Single Session ($50)', 1, 0, null, 0)`, [await cidOf(c, 'C050')]),
    await D.as(c, 'romy', `select public.book_session('1:1', $1::date, '10:00', 'Mikel', $2, 'Dina Daher')`, [today(9), await pid(c, 'PKG-0012')])],
  result: (g, s) => { ok(!g[0].ok && err(s[0]) === g[0].error, 'cap refusal same: ' + g[0].error + ' | ' + err(s[0])); ok(!g[2].ok && err(s[2]) === g[2].error, 'kind refusal same: ' + g[2].error + ' | ' + err(s[2])); } });
sc('6 month upgrade: client asks, Romy accepts, months 4 to 6 created', {
  gs: () => { const a = F.cl('app_cl_upgrade6', 'elie@x.com', { cid: 'C060' }); const rq = M.books[CFG.OPS_ID].getSheetByName('CLIENT REQUESTS').d.filter(r => r[4] === '6 month upgrade')[0];
    return [a, F.st('app_req_done', 'k-romy', { id: rq[0], act: 'accept' })]; },
  sql: async c => { const x = await cidOf(c, 'C060'); const a = await D.as(c, 'elie@x.com', `select public.request_upgrade6($1)`, [x]);
    const r = (await c.query(`select id from public.client_requests where type = '6 month upgrade'`)).rows[0]; return [a, await D.as(c, 'romy', `select public.handle_request($1, 'accept')`, [r.id])]; },
  result: (g, s) => ok(g[0].ok && s[0].rows && fl(Number(s[0].rows[0].request_upgrade6.due)) === fl(g[0].due), 'same amount due ' + J(g[0]) + J(s[0])) });
sc('freeze request accepted: end moves 7 days', {
  setup: () => { const sh = M.books[CFG.OPS_ID].getSheetByName('CLIENT REQUESTS') || appTab_(M.books[CFG.OPS_ID], 'CLIENT REQUESTS', CL.REQ_HEAD);
    sh.appendRow(['REQ-0001', '23/10/2026 09:00', 'C010', 'Carl Chami', 'Freeze', 'Away', today(1), 'PKG-0003', 'New', '', '', JSON.stringify({ from: today(1) })]); },
  gs: () => F.st('app_req_done', 'k-romy', { id: 'REQ-0001', act: 'accept' }),
  sql: async c => D.as(c, 'romy', `select public.handle_request((select id from public.client_requests where legacy_id = 'REQ-0001'), 'accept')`) });
sc('freeze request when Effective end is later than Extended (0009: Effective first, like clFreezeApply_)', {
  setup: () => { const ops = M.books[CFG.OPS_ID], pk = ops.getSheetByName('PACKAGES').d.find(r => r[0] === 'PKG-0003');
    pk[11] = beirutDate_(today(5), 0); pk[12] = beirutDate_(today(12), 0);
    const sh = ops.getSheetByName('CLIENT REQUESTS') || appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD);
    sh.appendRow(['REQ-0001', '23/10/2026 09:00', 'C010', 'Carl Chami', 'Freeze', 'Away', today(1), 'PKG-0003', 'New', '', '', JSON.stringify({ from: today(1) })]); },
  gs: () => F.st('app_req_done', 'k-romy', { id: 'REQ-0001', act: 'accept' }),
  sql: async c => D.as(c, 'romy', `select public.handle_request((select id from public.client_requests where legacy_id = 'REQ-0001'), 'accept')`),
  result: (g, s) => { const e = s.rows && s.rows[0].handle_request.end; ok(g.ok && e === today(19), 'end = Effective + 7 on both: gs ' + J(g) + ' sql ' + e); } });
sc('21:30 default Present for everyone not marked today', {
  gs: () => appDefaultPresent(),
  sql: async c => D.as(c, 'system', `select public.default_present()`) });
sc('game: a 2,600 m run (credit, missions, XP, badges)', {
  gs: () => F.cl('app_cl_run', 'alice@x.com', { cid: 'C001', op: 'save', run: { secs: 160, m: 2600, coins: 300, score: 9000, spent: 0, ev: { jumps: 40, slides: 31, roof: 320, powers: 5, clean: 700, mult: 3, letters: 2 } } }),
  sql: async c => D.as(c, 'alice@x.com', `select public.game_save_run($1, $2::jsonb)`, [await cidOf(c, 'C001'), J({ secs: 160, m: 2600, coins: 300, score: 9000, spent: 0, ev: { jumps: 40, slides: 31, roof: 320, powers: 5, clean: 700, mult: 3, letters: 2 } })]),
  result: (g, s) => { const r = s.rows && s.rows[0].game_save_run; ok(r && g.ok, 'both saved ' + J(g).slice(0, 200) + ' ' + J(s).slice(0, 300));
    if (r) ['earned', 'cashEarned', 'xpGain', 'record', 'coins', 'best', 'runs'].forEach(k => ok(J(g[k]) === J(r[k]), 'game ' + k + ': gs ' + J(g[k]) + ' sql ' + J(r[k])));
    if (r) ['levelUps', 'newBadges', 'mdone'].forEach(k => ok(diff(g[k], r[k]).length === 0, 'game ' + k + ': ' + diff(g[k], r[k]).join(' '))); } });
sc('game: impossible run refused, ticket without owning one refused', { refusal: true,
  gs: () => [F.cl('app_cl_run', 'bea@x.com', { cid: 'C002', op: 'save', run: { secs: 10, m: 5000, coins: 0, score: 0 } }), F.cl('app_cl_run', 'bea@x.com', { cid: 'C002', op: 'save', run: { secs: 100, m: 1600, coins: 0, score: 0, ev: { t1500: 1 } } })],
  sql: async c => { const x = await cidOf(c, 'C002'); return [await D.as(c, 'bea@x.com', `select public.game_save_run($1, $2::jsonb)`, [x, J({ secs: 10, m: 5000, coins: 0, score: 0 })]),
    await D.as(c, 'bea@x.com', `select public.game_save_run($1, $2::jsonb)`, [x, J({ secs: 100, m: 1600, coins: 0, score: 0, ev: { t1500: 1 } })])]; },
  result: (g, s) => { ok(!g[0].ok && g[0].error === err(s[0]), 'impossible: ' + g[0].error + ' | ' + err(s[0])); ok(!g[1].ok && g[1].error === err(s[1]), 'ticket: ' + g[1].error + ' | ' + err(s[1])); } });
sc('game: level ups from a big XP run, chests and free tickets', {
  setup: () => { appTab_(M.books[CFG.OPS_ID], 'CORNICHE RUN', RUN.HEAD).appendRow(['C010', 'Carl Chami', 100, 900, 500, 3, 2000, '', 0, '', 0, '{"magnet":1}', '{}', '["first"]', '', 400, '', 120, 120, 12200, '{}']); },
  gs: () => F.cl('app_cl_run', 'carl@x.com', { cid: 'C010', op: 'save', run: { secs: 300, m: 4000, coins: 200, score: 3000, ev: { lifeUsed: 0 } } }),
  sql: async c => D.as(c, 'carl@x.com', `select public.game_save_run($1, $2::jsonb)`, [await cidOf(c, 'C010'), J({ secs: 300, m: 4000, coins: 200, score: 3000, ev: { lifeUsed: 0 } })]),
  result: (g, s) => { const r = s.rows && s.rows[0].game_save_run; ok(r && g.levelUps.length > 0 && diff(g.levelUps, r.levelUps).length === 0, 'levelUps ' + J(g.levelUps) + ' | ' + J(r && r.levelUps)); } });
sc('game: redeem Wellbe Credit to the desk (and only once at a time)', {
  setup: () => { appTab_(M.books[CFG.OPS_ID], 'CORNICHE RUN', RUN.HEAD).appendRow(['C050', 'Dina Daher', 0, 0, 0, 0, 0, '', 0, '', 0, '{}', '{}', '[]', '', 0, '', 250, 250, 0, '{}']); },
  gs: () => [F.cl('app_cl_run', 'dina@x.com', { cid: 'C050', op: 'redeem' }), F.cl('app_cl_run', 'dina@x.com', { cid: 'C050', op: 'redeem' })],
  sql: async c => { const x = await cidOf(c, 'C050'); return [await D.as(c, 'dina@x.com', `select public.game_redeem($1)`, [x]), await D.as(c, 'dina@x.com', `select public.game_redeem($1)`, [x])]; },
  result: (g, s) => { ok(g[0].ok && s[0].rows && s[0].rows[0].game_redeem.redeemed === g[0].redeemed, 'redeemed ' + J(g[0]).slice(0, 100) + J(s[0])); ok(!g[1].ok && g[1].error === err(s[1]), 'second: ' + g[1].error + ' | ' + err(s[1])); } });
sc('streak: the 30th day in a row gives a free session', {
  setup: () => { const days = []; for (let i = 29; i >= 1; i--) days.push(today(-i));
    appTab_(M.books[CFG.OPS_ID], 'CLIENT STREAKS', STREAK.HEAD).appendRow(['C050', 'Dina Daher', days.join(','), '', '', '', '', 0]); },
  gs: () => F.cl('app_cl_streak', 'dina@x.com', { cid: 'C050', keys: [true, true, true] }),
  sql: async c => D.as(c, 'dina@x.com', `select public.streak_tick($1, array[true,true,true])`, [await cidOf(c, 'C050')]),
  result: (g, s) => { const r = s.rows && s.rows[0].streak_tick; ok(g.ok && r && g.unlocked === true && r.unlocked === true && g.count === r.count && g.streak === r.streak, 'streak ' + J(g) + ' | ' + J(r)); } });

async function runScenario(s, i) {
  // Apps Script side
  F.build(); if (s.setup) s.setup(); CFG_MEMO_ = null;
  const before = {}; gsUsed().forEach(([id, u]) => before[id] = u);
  let g; try { g = s.gs(); } catch (e) { g = { error: String(e.message) }; }
  const usedGs = gsUsed().filter(([id, u]) => before[id] === undefined || before[id] !== u);   // packages the action recounted
  await loadInto('wb_gs');
  const A = await D.withDb('wb_gs', D.snapshot);
  // Postgres side
  F.build(); if (s.setup) s.setup(); CFG_MEMO_ = null;
  await loadInto('wb_sql');
  const r = await D.withDb('wb_sql', async c => { const b0 = await D.snapshot(c); const x = await s.sql(c); return { res: x, before: b0, snap: await D.snapshot(c), used: (await c.query('select legacy_id, used from public.packages')).rows }; });
  const d = diff(A, r.snap, 'state');
  ok(d.length === 0, `[${s.name}] end state matches`, d.join('\n         '));
  const um = {}; r.used.forEach(x => um[x.legacy_id] = x.used);
  const ud = usedGs.filter(([id, u]) => um[id] !== undefined && um[id] !== u);
  ok(ud.length === 0, `[${s.name}] passes used match the sheet after the action`, J(ud));
  const sqlErrs = (Array.isArray(r.res) ? r.res : [r.res]).filter(x => x && x.error).map(x => x.error), gsErrs = (Array.isArray(g) ? g : [g]).filter(x => x && x.ok === false).map(x => x.error);
  if (!s.refusal) ok(diff(r.before, r.snap).length > 0, `[${s.name}] the action really changed something`);
  if (!s.result && !s.refusal) ok(sqlErrs.length === 0 && gsErrs.length === 0, `[${s.name}] no errors on either side`, 'gs ' + J(gsErrs) + ' sql ' + J(sqlErrs));
  if (s.result) s.result(g, r.res);
  else ok(J(sqlErrs) === J(gsErrs), `[${s.name}] same errors`, 'gs ' + J(gsErrs) + ' sql ' + J(sqlErrs));
  console.log('ran: ' + s.name);
}

// ---------------------------------------------------------------------
// B. who sees what
// ---------------------------------------------------------------------
async function rls() {
  F.build(); CFG_MEMO_ = null;
  // who each trainer may see, from the Apps Script itself
  const ops = M.books[CFG.OPS_ID], expect = {};
  ['joe', 'mikel', 'melanie', 'jad'].forEach(t => { const me = { role: 'trainer', trainer: cfgStaffById_(t).trainer, id: t };
    expect[t] = ['C001', 'C002', 'C010', 'C050', 'C060', 'C070', 'C071', 'C072', 'C073'].filter(x => appTrainerSees_(ops, me, x)); });
  await loadInto('wb_rls');
  await D.withDb('wb_rls', async c => {
    const ids = async who => { const r = await D.as(c, who, `select legacy_id from public.clients order by 1`); return r.error ? r.error : r.rows.map(x => x.legacy_id); };
    for (const t of Object.keys(expect)) { const got = await ids(t); ok(J(got) === J(expect[t]), `trainer ${t} sees the same clients as appTrainerSees_`, 'gs ' + J(expect[t]) + ' sql ' + J(got)); }
    ok((await ids('majd')).length === 9 && (await ids('romy')).length === 9, 'owner and assistant see every client');
    ok(J(await ids('alice@x.com')) === '["C001"]', 'a client sees only themselves');
    { const an = await ids('anon'); ok(J(an) === '[]' || /permission denied/.test(an), 'nobody signed in sees nothing: ' + J(an)); }
    // money and pay
    const money = async who => D.as(c, who, `select count(*)::int n from public.package_money`).then(D.one);
    ok(await money('joe') === 0, 'a trainer sees no prices or payments');
    ok(await money('romy') === 11, 'the desk sees every price');
    ok(await money('alice@x.com') === 1, 'a client sees only their own package money');
    ok(/permission denied/.test((await D.as(c, 'joe', `select price_cents from public.packages limit 1`)).error || ''), 'price column is closed on packages (trainer)');
    ok(/permission denied/.test((await D.as(c, 'romy', `select pay from public.staff`)).error || ''), 'pay column is closed on staff (assistant)');
    ok(await D.as(c, 'romy', `select app.staff_pay('joe')`).then(D.one) === null, 'assistant cannot read pay through the helper');
    ok(D.one(await D.as(c, 'joe', `select app.staff_pay('joe')`)) !== null && D.one(await D.as(c, 'joe', `select app.staff_pay('mikel')`)) === null, 'a trainer reads only their own pay');
    ok(D.one(await D.as(c, 'majd', `select app.staff_pay('joe')`)) !== null, 'the owner reads pay');
    // medical notes
    ok(J((await D.as(c, 'joe', `select c.legacy_id from public.client_notes n join public.clients c on c.id = n.client_id order by 1`)).rows.map(x => x.legacy_id)) === '["C001"]', 'Joe sees medical notes of his client only');
    ok(J((await D.as(c, 'mikel', `select c.legacy_id from public.client_notes n join public.clients c on c.id = n.client_id order by 1`)).rows.map(x => x.legacy_id)) === '["C050"]', 'Mikel sees medical notes of his client only');
    ok((await D.as(c, 'alice@x.com', `select count(*)::int from public.client_notes`)).rows[0].count === 0, 'a client does not see the coaches\' medical notes');
    // sessions
    const ses = async who => (await D.as(c, who, `select legacy_id from public.sessions order by 1`)).rows.map(x => x.legacy_id);
    ok(J(await ses('alice@x.com')) === '["S12-0001","S12-0002"]', 'a client sees only sessions they are in: ' + J(await ses('alice@x.com')));
    ok((await D.as(c, 'alice@x.com', `select count(*)::int n from public.session_clients`)).rows[0].n === 2, 'a client sees only their own place in a 1:2 (not the partner\'s package)');
    ok(J(await ses('mikel')) === '["S11-0001"]', 'Mikel sees only his sessions');
    // leads and requests
    ok((await D.as(c, 'joe', `select count(*)::int n from public.leads`)).rows[0].n === 0 && !(await D.as(c, 'romy', `select count(*)::int n from public.leads`)).error, 'leads: desk only');
    ok(/not allowed/.test((await D.as(c, 'alice@x.com', `select public.sell_package((select id from public.clients limit 1), '1:3 - 8x/month ($140pp)')`)).error || ''), 'a client cannot sell');
    ok(/Not your account/.test((await D.as(c, 'bea@x.com', `select public.game_save_run((select id from public.clients where legacy_id = 'C001'), '{}'::jsonb)`)).error || ''), 'a client cannot play as someone else');
    ok(/permission denied|new row violates/.test((await D.as(c, 'alice@x.com', `update public.packages set used = 0`)).error || 'no error') || (await D.as(c, 'alice@x.com', `update public.packages set used = 0 returning id`)).rows.length === 0, 'a client cannot change packages');
    // internal helpers cannot be called directly (they skip the role checks on purpose)
    ok(/permission denied/.test((await D.as(c, 'alice@x.com', `select app.set_att((select id from public.sessions limit 1), 0, 'Present', 'x')`)).error || ''), 'a client cannot call internal helpers');
    ok(/permission denied/.test((await D.as(c, 'joe', `select app.book_into('1:3', current_date, '08:00', 'Joe', (select id from public.packages limit 1), 'x')`)).error || ''), 'a trainer cannot call internal helpers');
    ok(/permission denied/.test((await D.as(c, 'anon', `select public.sell_package(gen_random_uuid(), 'x')`)).error || ''), 'nobody signed in cannot call the API functions');
    ok(/permission denied/.test((await D.as(c, 'romy', `select public.default_present()`)).error || ''), 'the 21:30 job is for the scheduler only');
    // settings
    const cfgC = D.one(await D.as(c, 'alice@x.com', `select public.public_cfg()`)), cfgO = D.one(await D.as(c, 'majd', `select public.public_cfg()`)), cfgT = D.one(await D.as(c, 'joe', `select public.public_cfg()`));
    ok(cfgC && !cfgC.pay && !cfgC.lists && !cfgC.insurance && cfgC.staff.every(s => !s.email && !s.phone && !s.pay), 'client settings: no pay, emails, phones, lists');
    ok(cfgO && cfgO.staff.some(s => s.email) && cfgO.pay, 'owner settings: emails and pay');
    ok(cfgT && cfgT.staff.filter(s => s.pay).map(s => s.id).join() === 'joe' && cfgT.staff.every(s => !s.email), 'trainer settings: only own pay, no emails');
    // the same as Config.gs cfgPublic_ (shape and values)
    const gsC = JSON.parse(JSON.stringify(cfgPublic_('client'))), dC = JSON.parse(JSON.stringify(cfgC)); delete dC.v; delete gsC.v; delete dC.game_rules;
    const cd = diff(gsC, dC, 'cfg'); ok(cd.length === 0, 'client settings equal Config.gs cfgPublic_(client)', cd.join('\n         '));
    // RLS on every table
    const off = (await c.query(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`)).rows.map(x => x.tablename);
    ok(off.length === 0, 'Row Level Security is on for every table', J(off));
    const nopol = (await c.query(`select t.tablename from pg_tables t where t.schemaname = 'public' and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)`)).rows.map(x => x.tablename);
    ok(J(nopol) === '[]', 'every table has at least one policy (no accidental lockout)', J(nopol));
  });
  console.log('ran: who sees what');
}

// ---------------------------------------------------------------------
// C. import checks and lead follow ups
// ---------------------------------------------------------------------
async function importChecks() {
  F.build(); CFG_MEMO_ = null;
  const sh = M.books[CFG.OPS_ID].getSheetByName(CFG.LEADS_TAB), now = Date.now(), at = m => new Date(now - m * 60000);
  const lead = (id, min, status, pkg) => { const r = new Array(LH.length).fill(''); r[L.ID] = id; r[L.SUB] = at(min); r[L.NAME] = 'Lead ' + id; r[L.PHONE] = '03 123 456'; r[L.STATUS] = status; r[L.PKG] = pkg || ''; sh.appendRow(r); };
  lead('W40-0001', 5, 'No Booking'); lead('W40-0002', 20, 'No Booking'); lead('W40-0003', 26 * 60, 'Pending'); lead('W40-0004', 80 * 60, 'No Booking'); lead('W40-0005', 31 * 1440, 'No Booking');
  lead('W40-0006', 30, 'Pending', 'PKG-0001'); lead('W40-0007', 30, 'Confirmed'); lead('W40-0007', 40, 'No Booking');
  // bad rows on purpose
  M.books[CFG.OPS_ID].getSheetByName('PACKAGES').appendRow(['PKG-0099', 'C999', 'Ghost', '1:3 - 8x/month ($140pp)', 8, 0, 8, 17.5, 'abc', '', '', '', '', 'Active']);
  M.books[CFG.CLIENTS_ID].getSheetByName(CFG.CLIENTS_TAB).appendRow(['C001', 'Alice Copy', 'alice2@x.com', '03 999 999']);
  const gsFollow = appLeadFollowups_(M.books[CFG.OPS_ID]).map(x => x.id + ':' + x.stage);
  // night leads: the Apps Script and SQL agree on when a lead starts (quiet hours 21:00 to 9:00 Beirut)
  const stamps = ['2026-10-23T20:59:00+03:00', '2026-10-23T21:00:00+03:00', '2026-10-23T23:10:00+03:00', '2026-10-24T02:00:00+03:00', '2026-10-24T08:59:00+03:00', '2026-10-24T09:00:00+03:00', '2026-01-10T23:30:00+02:00', '2026-03-28T22:00:00+02:00'];
  const gsStart = stamps.map(t => { const v = appLeadStart_(new Date(t).getTime()); return v ? new Date(v).toISOString() : null; });
  const P = await loadInto('wb_imp');
  ok(P.warn.some(w => /Duplicate client C001/.test(w)), 'import flags a duplicate client ID', J(P.warn));
  ok(P.warn.some(w => /unknown client C999/.test(w)), 'import flags a package of an unknown client', J(P.warn));
  ok(P.warn.some(w => /Duplicate lead W40-0007/.test(w)), 'import flags a duplicate lead ID', J(P.warn));
  await D.withDb('wb_imp', async c => {
    const n = async t => (await c.query(`select count(*)::int n from public.${t}`)).rows[0].n;
    ok(await n('clients') === 10 && await n('packages') === 11 && await n('sessions') === 11 && await n('session_clients') === 16 && await n('leads') === 8, 'every good row imported (10 clients incl. the renamed copy, 11 packages, 11 sessions, 16 places, 8 leads)');
    ok((await c.query(`select phone from public.clients where legacy_id = 'C001'`)).rows[0].phone === '9613111111', 'phones normalized to 961...');
    const sqlStart = [];
    for (const t of stamps) { const r = (await c.query('select app.lead_start($1::timestamptz) as v', [t])).rows[0].v; sqlStart.push(r ? new Date(r).toISOString() : null); }
    ok(J(sqlStart) === J(gsStart), 'night leads start at the same time in SQL and Apps Script', 'gs ' + J(gsStart) + ' sql ' + J(sqlStart));
    const sqlFollow = (await D.as(c, 'romy', `select legacy_id || ':' || stage as x from public.lead_followups`)).rows.map(x => x.x.replace('-dup', ''));
    ok(J(sqlFollow.sort()) === J(gsFollow.sort()), 'lead follow ups (15 min / 24 h / 72 h) equal the Apps Script', 'gs ' + J(gsFollow) + ' sql ' + J(sqlFollow));
    const att = (await c.query(`select s.legacy_id, sc.att, sc.pass from public.session_clients sc join public.sessions s on s.id = sc.session_id where s.legacy_id in ('S13-0005','S11-0001') order by 1`)).rows;
    ok(J(att) === J([{ legacy_id: 'S11-0001', att: 'Present', pass: 'Y' }, { legacy_id: 'S13-0005', att: 'Present', pass: 'Y' }]), 'attendance read the same way as the staff app', J(att));
  });
  // offers, from the boot of the Apps Script and from Postgres
  F.build(); CFG_MEMO_ = null;
  const bootE = F.cl('app_cl_boot', 'elie@x.com', {}), bootC = F.cl('app_cl_boot', 'carl@x.com', {});
  await loadInto('wb_off');
  await D.withDb('wb_off', async c => {
    const of = async l => D.one(await D.as(c, 'system', `select app.offers((select id from public.clients where legacy_id = $1))`, [l]));
    const strip = o => { const x = JSON.parse(J(o || {})); Object.values(x).forEach(v => { delete v.pkgId; }); return x; };
    const e = strip(await of('C060')), cc = strip(await of('C010'));
    const ge = bootE.accounts[0].offers, gc = bootC.accounts[0].offers;
    ok(diff(ge, e).length === 0, '6 month offer equals the Apps Script', diff(ge, e).join(' '));
    ok(diff(gc, cc).length === 0, '3 month offer equals the Apps Script', diff(gc, cc).join(' '));
  });
  console.log('ran: import + follow ups + offers');
}

(async () => {
  D.buildTemplate();
  for (let i = 0; i < SC.length; i++) { try { await runScenario(SC[i], i); } catch (e) { ok(false, `[${SC[i].name}] crashed`, e.stack); } }
  try { await rls(); } catch (e) { ok(false, 'who sees what crashed', e.stack); }
  try { await importChecks(); } catch (e) { ok(false, 'import crashed', e.stack); }
  for (const db of ['wb_gs', 'wb_sql', 'wb_rls', 'wb_imp', 'wb_off']) await D.dropDb(db);
  console.log(`\n${SC.length} scenarios + RLS + import: ${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
