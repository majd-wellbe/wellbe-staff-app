#!/usr/bin/env node
// =====================================================================
// 0009_align.sql + server/Supabase.gs, against the Apps Script, real Postgres 16 (deploy order: 0008 last).
//  1. sbPushCalendar(): what it sends (URL, key header, rows), the RPC as the public key would call it (role anon),
//     wrong secret refused, then the physio slots of the client boot and a physio request on a busy time are the same
//     as the Apps Script reading the same calendar.
//  2. sbPushBrand(): the catalog the client boot shows equals profBrand_(); an empty catalog keeps the last good one.
//  3. sbSetupTriggers(): old triggers removed, one 10 minute and one 6 hour trigger made.
//  4. A sale made in the app shows its "to" in the staff boot POS list, like the sheet.
// The freeze alignment is a differential scenario in run.js.
// Run: node run_align.js
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js'), BF = require('./lib/boot_fixture.js'), FD = require('./lib/feat_db.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wba-')), DB = 'wb_align';
let pass = 0, fail = 0;
const J = x => JSON.stringify(x), K = x => JSON.stringify(x, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, n) => (o[n] = v[n], o), {}) : v);   // K: same JSON, keys sorted (jsonb sorts keys)
function ok(c, msg, extra) { if (c) { pass++; console.log('   ok   ' + msg); } else { fail++; console.log('   FAIL ' + msg + (extra ? '\n         ' + String(extra).slice(0, 2000) : '')); } }
const SECRET = 'test-sync-secret-0123456789abcdef', KEY = { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel', melanie: 'k-mel', jad: 'k-jad' };
const EMAILS = ['alice@x.com', 'bea@x.com', 'carl@x.com', 'dina@x.com', 'elie@x.com', 'fadi@x.com', 'gia@x.com', 'gus@x.com'];

// ---------- Apps Script side mocks for this file ----------
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../../server/Supabase.gs'), 'utf8'), { filename: 'Supabase.gs' });
let EVENTS = [], POSTS = [], PRODUCTS = [], TRIG = [], DELETED = [], RESP = null;
const ev = (id, a, b, allDay) => ({ getId: () => id, getStartTime: () => new Date(a), getEndTime: () => new Date(b), isAllDayEvent: () => !!allDay });
global.CalendarApp = { getCalendarById: () => ({ getEvents: () => EVENTS.slice(), getName: () => 'cal' }), subscribeToCalendar: () => null };
global.UrlFetchApp = { fetch: (url, opt) => {
  if (/products\.json/.test(url)) return { getResponseCode: () => 200, getContentText: () => J({ products: PRODUCTS }) };
  POSTS.push({ url, opt, body: JSON.parse(opt.payload) });
  const r = RESP || { code: 200, body: '{"ok":true}' }; return { getResponseCode: () => r.code, getContentText: () => r.body }; } };
const chain = h => { const t = { h, every: null }; const c = { timeBased: () => c, everyMinutes: n => (t.every = n + 'm', c), everyHours: n => (t.every = n + 'h', c), create: () => (TRIG.push(t), t) }; return c; };
global.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'sbPushCalendar' }, { getHandlerFunction: () => 'appDefaultPresent' }],
  deleteTrigger: t => DELETED.push(t.getHandlerFunction()), newTrigger: h => chain(h) };

async function rpc(c, fn, body, role) {        // as PostgREST does for POST /rest/v1/rpc/<fn> with the publishable key
  await c.query('begin');
  try {
    await c.query(`set local role ${role || 'anon'}`);
    const args = Object.keys(body).map((k, i) => `${k} := $${i + 1}`).join(', ');
    const r = (await c.query(`select public.${fn}(${args}) as x`, Object.keys(body).map(k => typeof body[k] === 'string' ? body[k] : J(body[k])))).rows[0].x;
    await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); return { error: e.message }; }
}
async function door(c, who, action, body) {
  await c.query('begin');
  try {
    await c.query('set local role service_role');
    const r = (await c.query(`select public.wb_call($1, $2, $3, $4::jsonb) as x`, [action, KEY[who] || null, KEY[who] ? null : 'wb1.' + who, J(body || {})])).rows[0].x;
    await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); return { ok: false, error: e.message }; }
}
const fresh = () => { CFG_MEMO_ = null; M.cache = {}; };

(async () => {
  F.build(); BF.extend();
  M.props.SB_URL = 'https://fuwxmbdygqrmcbhwvrfx.supabase.co'; M.props.SB_SYNC_SECRET = SECRET;
  FD.buildTemplate();
  const dir = path.join(TMP, DB); exportBooks(M.books, dir);
  const { sql } = I.run(dir, GS);
  await FD.freshDb(DB);
  await D.withDb(DB, async c => {
    await c.query(['begin;'].concat(sql, ['commit;']).join('\n'));
    await D.makeLogins(c);
    await c.query(`select app.import_staff_keys($1::jsonb)`, [J(KEY)]);
    for (const e of EMAILS) await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, e]);

    console.log('\n-- 1. physio calendar');
    fresh(); const free = F.cl('app_cl_boot', 'dina@x.com').slots;
    ok(free.length > 3, 'Apps Script physio slots without calendar events: ' + free.length);
    const s1 = free[1], s2 = free[3], at = x => clAt_(x.d, x.t);
    EVENTS = [ev('evA', at(s1) + 15 * 60000, at(s1) + 45 * 60000), ev('evR', at(s2), at(s2) + 3600000), ev('evR', at(s2) + 7 * 864e5, at(s2) + 7 * 864e5 + 3600000),
      ev('allday', at(s1) - 8 * 3600000, at(s1) + 16 * 3600000, true)];
    POSTS = []; const r1 = sbPushCalendar(), p = POSTS[0];
    ok(POSTS.length === 1 && p.url === 'https://fuwxmbdygqrmcbhwvrfx.supabase.co/rest/v1/rpc/wb_sync_calendar' && p.opt.method === 'post' && p.opt.headers.apikey === SB.KEY && !p.opt.headers.Authorization,
      'sends one POST to /rest/v1/rpc/wb_sync_calendar with the public key only', J(p && { url: p.url, h: p.opt.headers }));
    ok(p.body.secret === SECRET && p.body.rows.length === 4 && p.body.rows[3].allDay === true && typeof p.body.rows[0].s === 'number', 'rows: id, start and end in ms, all day flag', J(p.body.rows));
    ok(r1 && r1.ok, 'returns the answer');
    const bad = await rpc(c, 'wb_sync_calendar', { secret: 'wrong-secret-0123456789abcdef', rows: p.body.rows });
    ok(/not allowed/.test(bad.error || ''), 'wrong secret refused', J(bad));
    const none = await rpc(c, 'wb_sync_calendar', { secret: SECRET, rows: p.body.rows });
    ok(/not allowed/.test(none.error || ''), 'refused while Supabase has no sync_secret yet', J(none));
    await c.query(`insert into app.secrets (key, value) values ('sync_secret', $1) on conflict (key) do update set value = excluded.value`, [SECRET]);
    const good = await rpc(c, 'wb_sync_calendar', p.body);
    ok(good.ok && good.n === 4, 'synced as anon: 4 rows (recurring event with one id kept twice)', J(good));
    ok((await rpc(c, 'wb_sync_calendar', p.body)).n === 4 && (await c.query(`select count(*)::int as n from public.calendar_busy`)).rows[0].n === 4, 'running it again replaces, no duplicates');
    const dirty = await c.query(`select has_table_privilege('anon', 'public.calendar_busy', 'insert') as i, has_function_privilege('anon', 'app.sync_ok(text)', 'execute') as f`);
    ok(!dirty.rows[0].i && !dirty.rows[0].f, 'anon cannot write the table or call the check directly');
    fresh(); const gsBoot = F.cl('app_cl_boot', 'dina@x.com');
    const sqlBoot = await door(c, 'dina@x.com', 'app_cl_boot', {});
    const has = (l, x) => l.some(y => y.d === x.d && y.t === x.t);
    ok(J(gsBoot.slots) === J(sqlBoot.slots) && !has(gsBoot.slots, s1) && !has(gsBoot.slots, s2) && has(gsBoot.slots, free[0]), 'client boot physio slots equal the Apps Script with the same calendar (2 busy hours gone)', J(gsBoot.slots).slice(0, 400) + '\n' + J(sqlBoot.slots).slice(0, 400));
    fresh(); const gr = F.cl('app_cl_request', 'dina@x.com', { cid: 'C050', kind: 'physio', d: s1.d, t: s1.t });
    const sr = await door(c, 'dina@x.com', 'app_cl_request', { cid: 'C050', kind: 'physio', d: s1.d, t: s1.t });
    ok(!gr.ok && !sr.ok && gr.error === sr.error, 'physio request on a busy calendar time refused the same: ' + gr.error, J(gr) + J(sr));
    const s3 = free[0]; fresh(); const gr2 = F.cl('app_cl_request', 'dina@x.com', { cid: 'C050', kind: 'physio', d: s3.d, t: s3.t });
    const sr2 = await door(c, 'dina@x.com', 'app_cl_request', { cid: 'C050', kind: 'physio', d: s3.d, t: s3.t });
    ok(gr2.ok && sr2.ok, 'a free time still works on both', J(gr2) + J(sr2));
    EVENTS = []; global.CalendarApp = { getCalendarById: () => null, subscribeToCalendar: () => { throw new Error('no'); } }; POSTS = [];
    const r2 = sbPushCalendar();
    ok(r2.ok === false && POSTS.length === 0, 'calendar not readable: nothing sent, Supabase keeps the last copy');
    RESP = { code: 400, body: '{"message":"not allowed"}' }; global.CalendarApp = { getCalendarById: () => ({ getEvents: () => [] }) };
    let thrown = ''; try { sbPushCalendar(); } catch (e) { thrown = e.message; }
    ok(thrown === 'Supabase wb_sync_calendar 400: not allowed', 'a refusal shows the database message in the trigger log', thrown); RESP = null;
    delete M.props.SB_URL; thrown = ''; try { sbPushCalendar(); } catch (e) { thrown = e.message; }
    ok(/Set SB_URL/.test(thrown), 'no SB_URL: clear message', thrown); M.props.SB_URL = 'https://fuwxmbdygqrmcbhwvrfx.supabase.co';

    console.log('\n-- 2. brand catalog');
    PRODUCTS = [{ handle: 'necklux-2-0-the-ultimate-neck-massager', title: 'Necklux 2.0', product_type: 'Neck', variants: [{ price: '49.00', compare_at_price: '69.00' }], images: [{ src: 'https://cdn/x.jpg' }] },
      { handle: 'backlux-lower-back-massager', title: 'Backlux', product_type: 'Back', variants: [{ price: '59.5' }], images: [] }];
    fresh(); POSTS = []; sbPushBrand(); const b = POSTS[0];
    fresh(); const want = profBrand_();
    ok(b && /wb_sync_brand$/.test(b.url) && J(b.body.items) === J(want) && want.length === 2, 'sends exactly profBrand_()', J(b && b.body));
    const bg = await rpc(c, 'wb_sync_brand', b.body);
    ok(bg.ok && bg.n === 2, 'synced as anon', J(bg));
    fresh(); const gb = F.cl('app_cl_boot', 'alice@x.com'), sb = await door(c, 'alice@x.com', 'app_cl_boot', {});
    ok(K(gb.brand) === K(sb.brand) && sb.brand.length === 2, 'client boot brand equals the Apps Script', J(gb.brand) + '\n' + J(sb.brand));
    const keep = await rpc(c, 'wb_sync_brand', { secret: SECRET, items: [] });
    ok(keep.kept && (await c.query(`select jsonb_array_length(items) as n from public.brand_cache`)).rows[0].n === 2, 'empty catalog (shop down) keeps the last good one');
    ok(/not allowed/.test((await rpc(c, 'wb_sync_brand', { secret: SECRET.slice(0, 20), items: b.body.items })).error || ''), 'short or wrong secret refused');

    console.log('\n-- 3. triggers');
    POSTS = []; TRIG = []; DELETED = []; const st = sbSetupTriggers();
    ok(J(DELETED) === J(['sbPushCalendar']) && J(TRIG) === J([{ h: 'sbPushCalendar', every: '10m' }, { h: 'sbPushBrand', every: '6h' }]), 'old sync trigger removed, others kept; 10 minute + 6 hour triggers made', J({ DELETED, TRIG }));
    ok(POSTS.length === 2 && st.calendar && st.brand, 'both sent once right away');

    console.log('\n-- 4. POS "to" in the staff boot');
    fresh(); const gp = F.st('app_pos', 'k-romy', { product: 'Protein bar', qty: 1, price: 3, to: 'Bea Bitar' });
    const sp = await door(c, 'romy', 'app_pos', { product: 'Protein bar', qty: 1, price: 3, to: 'Bea Bitar' });
    fresh(); const gpos = F.st('app_boot', 'k-majd').pos, spos = (await door(c, 'majd', 'app_boot', {})).pos;
    const last = a => a[a.length - 1];
    ok(gp.ok && sp.ok && last(gpos).to === 'Bea Bitar' && last(spos).to === 'Bea Bitar' && J(last(gpos)) === J(last(spos)), 'new sale shows "to" on both', J(last(gpos)) + J(last(spos)));
  });
  await D.dropDb(DB);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
