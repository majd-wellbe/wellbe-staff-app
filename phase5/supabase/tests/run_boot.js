#!/usr/bin/env node
// =====================================================================
// WELLBE boot reads: Apps Script vs Postgres, field by field (migrations/0005_boot.sql)
//  staff boot (owner, assistant, trainer x2), owner history, client boot (with a child account, insured, offers, open spots),
//  guest boot (with and without a trial), and who may call what.
// Run: node run_boot.js   (local Postgres 16 on PGHOST/PGPORT, see README)
// Intentional differences are normalized below in NORM, each with its reason.
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js'), BF = require('./lib/boot_fixture.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbb-')), DB = 'wb_boot';

let pass = 0, fail = 0;
const J = x => JSON.stringify(x);
function ok(c, msg, extra) { if (c) { pass++; console.log('   ok   ' + msg); } else { fail++; console.log('   FAIL ' + msg + (extra ? '\n         ' + String(extra).slice(0, 3000) : '')); } }
const fl = x => typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : Array.isArray(x) ? x.map(fl) : x && typeof x === 'object' ? Object.keys(x).reduce((o, k) => (o[k] = fl(x[k]), o), {}) : x;
function diff(a, b, p0) {
  const out = [];
  (function walk(x, y, p) {
    if (out.length > 12 || J(x) === J(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) out.push(`${p}: ${x.length} vs ${y.length} rows\n           gs:  ${J(x).slice(0, 700)}\n           sql: ${J(y).slice(0, 700)}`); else x.forEach((v, i) => walk(v, y[i], p + '[' + i + ']')); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { new Set(Object.keys(x).concat(Object.keys(y))).forEach(k => walk(x[k], y[k], p + '.' + k)); return; }
    out.push(`${p}: gs ${J(x)} vs sql ${J(y)}`);
  })(fl(a), fl(b), p0 || '');
  return out;
}
// ---------------------------------------------------------------------
// intentional differences (documented in the report / 0005 header)
//  ref   'k|row' -> 'k|legacy ID' (no sheet rows): only the tab key is compared
//  row   sheet row number -> legacy ID: not compared
//  now   server clock in ms: compared within 2 minutes
//  ok, cached: transport fields, not part of the payload
// ---------------------------------------------------------------------
function norm(x, k) {
  if (Array.isArray(x)) return x.map(v => norm(v));
  if (x && typeof x === 'object') {
    const o = {};
    Object.keys(x).forEach(key => {
      if (key === 'ok' || key === 'cached' || key === 'row') return;
      if (key === 'ref') { o.ref = String(x.ref).split('|')[0]; return; }
      if (key === 'now') { o.now = Math.round(x.now / 120000); return; }
      o[key] = norm(x[key], key);
    });
    return o;
  }
  return x;
}
function cmp(name, gs, sql) {
  if (sql && sql.error) { ok(false, name + ': SQL error', sql.error); return; }
  if (!gs || gs.ok === false) { ok(false, name + ': Apps Script error', J(gs)); return; }
  const g = norm(gs), s = norm(sql);
  const gc = g.cfg, sc = s.cfg; delete g.cfg; delete s.cfg;
  // field groups, so one difference does not hide the others
  const keys = [...new Set(Object.keys(g).concat(Object.keys(s)))];
  keys.forEach(k => { const d = diff(g[k], s[k], k); ok(d.length === 0, `${name} · ${k}`, d.join('\n         ')); });
  if (gc !== undefined || sc !== undefined) { delete gc.v; delete sc.v; delete sc.game_rules; const d = diff(gc, sc, 'cfg'); ok(d.length === 0, `${name} · cfg`, d.join('\n         ')); }
}

(async () => {
  // ---------- Apps Script side ----------
  F.build(); BF.extend();
  const gs = {}, fresh = () => { CFG_MEMO_ = null; M.cache = {}; };
  fresh(); gs.owner = F.st('app_boot', 'k-majd');
  fresh(); gs.romy = F.st('app_boot', 'k-romy');
  fresh(); gs.joe = F.st('app_boot', 'k-joe');
  fresh(); gs.mikel = F.st('app_boot', 'k-mikel');
  fresh(); gs.hist = F.st('app_history', 'k-majd');
  fresh(); gs.histJoe = F.st('app_history', 'k-joe');
  for (const e of ['alice@x.com', 'elie@x.com', 'fadi@x.com', 'dina@x.com', 'carl@x.com', 'gus@x.com', 'gia@x.com']) { fresh(); gs[e] = F.cl('app_cl_boot', e); }
  fresh();
  // ---------- Postgres side: same sheets -> CSV -> import.js (+ the tabs it does not load yet) ----------
  D.buildTemplate();
  const dir = path.join(TMP, DB); exportBooks(M.books, dir);
  const { sql } = I.run(dir, GS), extra = [];
  await D.freshDb(DB);
  await D.withDb(DB, async c => {
    await c.query(['begin;'].concat(sql, extra, ['commit;']).join('\n'));
    await D.makeLogins(c);
    // through the API door (0008 public.wb_call, as the edge function: service role): staff key or client token
    await c.query(`select app.import_staff_keys($1::jsonb)`, [J({ majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel', melanie: 'k-mel', jad: 'k-jad' })]);
    for (const e of ['alice@x.com', 'bea@x.com', 'elie@x.com', 'fadi@x.com', 'dina@x.com', 'carl@x.com', 'gus@x.com', 'gia@x.com'])
      await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, e]);
    const keyOf = { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel' };
    const call = async (who, fn, p) => {
      await c.query('begin');
      try {
        await c.query('set local role service_role');
        const r = (await c.query(`select public.wb_call($1, $2, $3, $4::jsonb) as x`, [fn.replace(/^api_/, ''), keyOf[who] || null, keyOf[who] ? null : 'wb1.' + who, J(p || {})])).rows[0].x;
        await c.query('commit');
        return r && r.ok === false ? { error: r.error } : r;
      } catch (e) { await c.query('rollback'); return { error: e.message }; }
    };
    const direct = async (who, fn) => { const r = await D.as(c, who, `select public.${fn}('{}'::jsonb)`); return r.error || 'no error'; };

    console.log('staff boot');
    cmp('owner boot', gs.owner, await call('majd', 'api_app_boot'));
    cmp('assistant boot', gs.romy, await call('romy', 'api_app_boot'));
    cmp('trainer boot (Joe)', gs.joe, await call('joe', 'api_app_boot'));
    cmp('trainer boot (Mikel)', gs.mikel, await call('mikel', 'api_app_boot'));
    cmp('owner history', gs.hist, await call('majd', 'api_app_history'));
    console.log('client boot');
    for (const e of ['alice@x.com', 'elie@x.com', 'fadi@x.com', 'dina@x.com', 'carl@x.com']) cmp('client boot ' + e, gs[e], await call(e, 'api_app_cl_boot'));
    console.log('guest boot');
    cmp('guest boot with trial (gus)', gs['gus@x.com'], await call('gus@x.com', 'api_app_cl_boot'));
    cmp('guest boot no trial (gia)', gs['gia@x.com'], await call('gia@x.com', 'api_app_cl_boot'));

    console.log('fixture coverage (so the comparisons above are not empty)');
    const a = gs['alice@x.com'], f = gs['fadi@x.com'];
    ok(a.accounts.length === 2 && a.accounts[1].cid === 'C080', 'parent email sees the child account');
    ok(gs.owner.leads.length >= 3 && gs.owner.requests.length === 2 && gs.owner.intakes.length === 2 && gs.owner.files.length === 1 && gs.owner.ins.claims.length === 1, 'owner boot has leads, requests, intakes, files, claims');
    ok(gs.romy.expenses.length === 1 && gs.owner.expenses.length === 2 && gs.romy.pos.length === 1 && gs.owner.pos.length === 2, 'assistant sees this month only, owner everything');
    ok(gs.joe.clients.every(x => x.phone === '' && x.email === '') && gs.joe.intakes.length === 1 && Object.keys(gs.joe.wallet).join() === 'C001', 'trainer: no contacts, own intakes and wallets');
    ok(f.accounts[0].open.length > 0 && (f.accounts[0].grid || []).some(x => x.state === 'instant') && (f.accounts[0].grid || []).some(x => x.state === 'request'), 'open spots + grid (instant, request)');
    ok(gs['dina@x.com'].accounts[0].insurer === 'NextCare' && gs['elie@x.com'].accounts[0].offers.m6, 'insured client, 6 month offer');
    ok(gs['gia@x.com'].guest.slots.length > 0 && gs['gus@x.com'].guest.trial && gs['gia@x.com'].accounts[0].photo, 'guest: trial slots, booked trial, photo');
    ok(gs.hist.sessions.length >= 4 && gs.histJoe.ok === false, 'history: owner only');

    console.log('who may call');
    const err = async (who, fn, p) => (await call(who, fn, p)).error || '';
    ok(/permission denied/.test(await direct('anon', 'api_app_boot')) && /permission denied/.test(await direct('anon', 'api_app_cl_boot')) && /permission denied/.test(await direct('anon', 'api_app_history')), 'anon cannot call any boot');
    ok(/permission denied/.test(await direct('majd', 'api_app_boot')) && /permission denied/.test(await direct('alice@x.com', 'api_app_cl_boot')), 'signed in users cannot call the boots around the API door');
    ok(/signin/.test(await err('nobody@x.com', 'api_app_cl_boot')) && /auth/.test((await (async () => { await c.query('begin'); await c.query('set local role service_role'); const r = (await c.query(`select public.wb_call('app_boot', 'k-wrong', null, '{}') as x`)).rows[0].x; await c.query('commit'); return r.error; })())), 'unknown key / token refused');
    ok(/not allowed/.test(await err('joe', 'api_app_history')) && /not allowed/.test(await err('romy', 'api_app_history')), 'only the owner gets history');
    const tj = await call('joe', 'api_app_boot', { as: 'majd', role: 'owner', staff: 'majd' });
    ok(tj.me.id === 'joe' && !('requests' in tj) && !('files' in tj) && tj.ins.claims.length === 0 && tj.clients.every(x => !x.phone), 'a trainer gets the trainer boot whatever he sends');
    ok(/auth/.test(await err('alice@x.com', 'api_app_boot')) && /auth/.test(await err('gus@x.com', 'api_app_boot')), 'clients and guests cannot get a staff boot');
    ok(/signin/.test(await err('romy', 'api_app_cl_boot')), 'staff logins get no client boot');
    const bea = await call('bea@x.com', 'api_app_cl_boot', { email: 'alice@x.com' });
    ok(bea.accounts.length === 1 && bea.accounts[0].cid === 'C002', 'a client only gets their own accounts (email in the body ignored)');
    ok(/permission denied/.test((await D.as(c, 'alice@x.com', `select app.boot_sess(current_date - 900, current_date + 90)`)).error || ''), 'boot helpers are not callable from the API');
  });
  await D.dropDb(DB);
  console.log(`\nboot: ${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
