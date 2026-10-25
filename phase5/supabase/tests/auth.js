// Tests for migrations/0008_auth.sql: the API door, staff keys, client codes and tokens, old Apps Script tokens.
// Run: node auth.js   (local Postgres from README; builds its own database auth_test)
const { Client } = require('pg'), crypto = require('crypto'), { execFileSync } = require('child_process'), path = require('path');
const HOST = process.env.PGHOST || '/var/lib/postgresql/wbtest', PORT = Number(process.env.PGPORT || 5544), DB = 'auth_test';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('   FAIL: ' + m); } };
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// exactly like Client.gs clSign_
const legacyToken = (email, expMs, secret) => { const payload = email + '|' + expMs; return b64u(payload) + '.' + b64u(crypto.createHmac('sha256', secret).update(payload).digest()); };

(async () => {
  execFileSync(path.join(__dirname, 'reset.sh'), [DB], { env: Object.assign({}, process.env, { PGHOST: HOST, PGPORT: String(PORT) }), stdio: 'pipe' });
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: DB }); await c.connect();
  const q = async (sql, p) => (await c.query(sql, p || [])).rows;
  const one = async (sql, p) => { const r = await q(sql, p); return r[0] ? r[0][Object.keys(r[0])[0]] : null; };
  // as the edge function: service role
  const svc = async (sql, p) => { await c.query('begin'); try { await c.query('set local role service_role'); const r = await c.query(sql, p || []); await c.query('commit'); return r.rows[0] ? r.rows[0][Object.keys(r.rows[0])[0]] : null; } catch (e) { await c.query('rollback'); return { thrown: e.message }; } };
  const call = (action, key, token, body) => svc('select public.wb_call($1,$2,$3,$4::jsonb) r', [action, key || null, token || null, JSON.stringify(body || {})]);
  // a person straight through the public API (PostgREST), not through the door
  const direct = async (role, sql, p, sub) => { await c.query('begin'); try { await c.query(`set local role ${role}`); if (sub) await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [sub]); const r = await c.query(sql, p || []); await c.query('rollback'); return { rows: r.rows }; } catch (e) { await c.query('rollback'); return { error: e.message }; } };

  // test data + test API functions
  await q(`insert into public.clients (legacy_id, kind, name, email) values ('C001','client','Alice Aoun','alice@x.com'),('C003','client','Bob Bitar','bob@x.com'),('G0001','guest','Gina Guest','gina@x.com')`);
  await q(`insert into public.clients (legacy_id, kind, name, email, parent_email) values ('C002','client','Kid Aoun',null,'alice@x.com')`);
  await q(`create or replace function public.api_app_whoami(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$ begin return jsonb_build_object('me', app.caller(), 'role', app.my_role(), 'staff', app.my_staff()); end $$`);
  await q(`create or replace function public.api_app_cl_whoami(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$ begin return jsonb_build_object('me', app.caller(), 'clients', (select coalesce(jsonb_agg(legacy_id order by legacy_id), '[]') from public.clients where id in (select app.my_clients())), 'body', p); end $$`);
  await q(`create or replace function public.api_slots(p jsonb) returns jsonb language sql as $$ select jsonb_build_object('slots', 3, 'role', app.my_role()) $$`);
  await q(`create or replace function public.api_app_failwrite(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$ begin insert into public.audit_log (action) values ('should_not_stay'); raise exception 'Joe already has 3 clients at that hour'; end $$`);
  await q(`create or replace function public.api_app_secret(p jsonb) returns jsonb language sql as $$ select '{"x":1}'::jsonb $$`);
  ok(await one(`select app.api_sync()`) >= 6, 'api_sync registers the API functions');
  await q(`update app.api_actions set enabled = false where action = 'app_secret'`);

  // staff keys
  ok(await one(`select app.import_staff_keys($1::jsonb)`, [JSON.stringify({ majd: 'k-majd', joe: 'k-joe', romy: 'k-romy', nobody: 'k-x' })]) === 3, 'import_staff_keys: 3 staff (unknown skipped)');
  ok(!(await one(`select count(*) from app.staff_keys where key_hash like 'k-%'`) > 0), 'only hashes stored');
  let r = await call('app_whoami', 'k-joe');
  ok(r.ok && r.role === 'trainer' && r.staff === 'joe' && r.me.trainer === 'Joe', 'key -> staff identity: ' + JSON.stringify(r));
  r = await call('app_whoami', 'k-majd'); ok(r.ok && r.me.role === 'owner', 'owner key');
  r = await call('app_whoami', 'wrong'); ok(!r.ok && r.error === 'auth', 'bad key -> auth');
  r = await call('app_whoami'); ok(!r.ok && r.error === 'auth', 'no key -> auth');
  const newKey = await one(`select app.reset_staff_key('joe')`);
  r = await call('app_whoami', 'k-joe'); ok(!r.ok && r.error === 'auth', 'old key dead after reset');
  r = await call('app_whoami', newKey); ok(r.ok && r.staff === 'joe', 'new key works');
  await q(`update public.staff set active = false where id = 'romy'`);
  r = await call('app_whoami', 'k-romy'); ok(!r.ok && r.error === 'auth', 'inactive staff refused');
  await q(`update public.staff set active = true where id = 'romy'`);

  // client codes
  r = await svc(`select public.wb_login_code('Alice@X.com', null, null)`);
  ok(r.ok && /^\d{6}$/.test(r.code) && r.first === 'Alice' && !r.guest, 'code issued for a client: ' + JSON.stringify(r));
  const code = r.code;
  r = await svc(`select public.wb_login_verify('alice@x.com', $1)`, [code === '000000' ? '111111' : '000000']);
  ok(!r.ok && /Wrong code\. 4 tries left/.test(r.error), 'wrong code: ' + JSON.stringify(r));
  r = await svc(`select public.wb_login_verify('alice@x.com', $1)`, [code]);
  ok(r.ok && /^wb1\./.test(r.token), 'right code -> token');
  const tok = r.token;
  ok(await one(`select count(*)::int from app.sessions where token_hash = app.sha($1)`, [tok]) === 1 && await one(`select count(*)::int from app.sessions where token_hash = $1`, [tok]) === 0, 'only the token hash is stored');
  r = await svc(`select public.wb_login_verify('alice@x.com', $1)`, [code]); ok(!r.ok && /expired/.test(r.error), 'a code works once');
  r = await call('app_cl_whoami', null, tok, { cid: 'C001' });
  ok(r.ok && r.me.role === 'client' && JSON.stringify(r.clients) === '["C001","C002"]', 'token -> client identity incl. the child: ' + JSON.stringify(r.clients));
  // body cannot speak for the caller
  r = await call('app_cl_whoami', null, tok, { role: 'owner', staff: 'majd', email: 'bob@x.com', identity: { role: 'owner' }, key: 'k-majd', token: 'x', _ident: { role: 'owner' } });
  ok(r.ok && r.me.role === 'client' && r.me.email === 'alice@x.com' && JSON.stringify(r.clients) === '["C001","C002"]' && !('key' in r.body) && !('identity' in r.body) && r.body.email === 'bob@x.com', 'body spoof ignored: ' + JSON.stringify(r.me));
  r = await call('app_whoami', null, tok); ok(!r.ok && r.error === 'auth', 'client token on a staff action -> auth');
  r = await call('app_cl_whoami', 'k-majd'); ok(!r.ok && r.error === 'signin', 'staff key on a client action -> signin');
  r = await call('app_cl_whoami', null, tok + 'x'); ok(!r.ok && r.error === 'signin', 'tampered token -> signin');
  r = await call('slots'); ok(r.ok && r.slots === 3 && r.role === 'anon', 'landing page action needs no sign in, runs as anon');
  r = await call('nope', 'k-majd'); ok(!r.ok && r.error === 'unknown action', 'unknown action');
  r = await call('app_secret', 'k-majd'); ok(!r.ok && r.error === 'unknown action', 'switched off action');
  r = await call('whoami', 'k-majd'); ok(!r.ok && r.error === 'unknown action', 'only whitelisted names (no api_ prefix tricks)');
  r = await call('app_failwrite', 'k-majd');
  ok(!r.ok && /Joe already has 3/.test(r.error) && await one(`select count(*)::int from public.audit_log where action = 'should_not_stay'`) === 0, 'errors come back as {ok:false} and roll back the writes');
  ok(await one(`select current_setting('wb.identity', true)`) === null || await one(`select coalesce(current_setting('wb.identity', true), '')`) === '', 'identity does not leak out of the call');

  // sign out
  await svc(`select public.wb_signout($1)`, [tok]);
  r = await call('app_cl_whoami', null, tok); ok(!r.ok && r.error === 'signin', 'signed out token refused');
  // limits: 3 codes per 15 minutes
  for (let i = 0; i < 3; i++) await svc(`select public.wb_login_code('bob@x.com', null, null)`);
  r = await svc(`select public.wb_login_code('bob@x.com', null, null)`); ok(!r.ok && /Wait 15 minutes/.test(r.error), '4th code in 15 min refused');
  await q(`update app.login_sends set at = at - interval '20 minutes' where email = 'bob@x.com'`);
  r = await svc(`select public.wb_login_code('bob@x.com', null, null)`); ok(r.ok, 'allowed again after 15 min');
  await q(`insert into app.login_sends (email, at) select 'bob@x.com', now() - interval '1 hour' from generate_series(1, 8)`);
  r = await svc(`select public.wb_login_code('bob@x.com', null, null)`); ok(!r.ok && /today/.test(r.error), 'codesPerDay limit');
  // 5 wrong tries
  r = await svc(`select public.wb_login_code('gina@x.com', null, null)`); ok(r.ok && r.guest, 'guest gets a code');
  for (let i = 0; i < 5; i++) await svc(`select public.wb_login_verify('gina@x.com', '999999')`);
  r = await svc(`select public.wb_login_verify('gina@x.com', $1)`, [r.code]); ok(!r.ok && /Too many tries|expired/.test(r.error), 'code dead after 5 wrong tries: ' + JSON.stringify(r));
  // unknown email
  r = await svc(`select public.wb_login_code('new@x.com', null, null)`); ok(!r.ok && r.error === 'unknown', 'unknown email without mode new');
  r = await svc(`select public.wb_login_code('new@x.com', 'new', 'x')`); ok(!r.ok && /name/.test(r.error), 'new person needs a name');
  r = await svc(`select public.wb_login_code('new@x.com', 'new', 'Nadia Nasr')`); ok(r.ok && r.guest && r.first === 'Nadia', 'new person gets a code');
  r = await svc(`select public.wb_login_verify('new@x.com', $1)`, [r.code]);
  ok(r.ok && await one(`select legacy_id from public.clients where email = 'new@x.com'`) === 'G0002', 'guest row made after the code (G0002)');
  ok(await one(`select count(*)::int from public.outbox where body like 'NEW APP SIGN UP%Nadia Nasr%'`) === 2, 'owner and desk told');
  const gtok = r.token; r = await call('app_cl_whoami', null, gtok); ok(r.ok && r.me.role === 'guest' && JSON.stringify(r.clients) === '["G0002"]', 'guest identity');

  // old Apps Script tokens keep working
  const SEC = 'secret-from-CL_SECRET';
  await q(`select app.import_legacy_auth($1, $2::jsonb)`, [SEC, JSON.stringify({ 'bob@x.com': Date.now() - 1000 })]);
  const exp = Date.now() + 100 * 864e5;
  const lt = legacyToken('alice@x.com', exp, SEC);
  r = await call('app_cl_whoami', null, lt); ok(r.ok && r.me.email === 'alice@x.com' && r.clients.length === 2, 'Apps Script token accepted: ' + JSON.stringify(r).slice(0, 120));
  r = await call('app_cl_whoami', null, legacyToken('alice@x.com', exp, 'wrong secret')); ok(!r.ok, 'wrong secret refused');
  r = await call('app_cl_whoami', null, legacyToken('alice@x.com', Date.now() - 1000, SEC)); ok(!r.ok, 'expired refused');
  r = await call('app_cl_whoami', null, legacyToken('bob@x.com', exp, SEC)); ok(!r.ok, 'deleted account (CL_DELETED) refused');
  r = await call('app_cl_whoami', null, legacyToken('nobody@x.com', exp, SEC)); ok(!r.ok, 'no account -> refused');
  // revoke one email, then everyone
  r = await svc(`select public.wb_login_code('alice@x.com', null, null)`); const t2 = (await svc(`select public.wb_login_verify('alice@x.com', $1)`, [r.code])).token;
  ok((await call('app_cl_whoami', null, t2)).ok, 'fresh token ok');
  await q(`select app.revoke_email('alice@x.com')`);
  ok(!(await call('app_cl_whoami', null, t2)).ok && !(await call('app_cl_whoami', null, lt)).ok, 'revoke_email kills new and old tokens');
  await q(`delete from app.signout_before where email = 'alice@x.com'`);
  ok((await call('app_cl_whoami', null, lt)).ok, 'legacy token ok again once the block is removed (test reset)');
  r = await call('app_signout_everyone', 'k-romy'); ok(!r.ok && /not allowed/.test(r.error), 'assistant cannot sign everyone out');
  r = await call('app_signout_everyone', 'k-majd'); ok(r.ok, 'owner signs everyone out');
  ok(!(await call('app_cl_whoami', null, lt)).ok && !(await call('app_cl_whoami', null, gtok)).ok, 'every token dead');

  // direct access through the public API (PostgREST roles) is closed
  const someone = '11111111-1111-4111-8111-111111111111';
  let d = await direct('authenticated', `select public.wb_call('app_whoami','k-majd',null,'{}')`, [], someone); ok(/permission denied/.test(d.error || ''), 'wb_call not callable by a signed up user');
  d = await direct('anon', `select public.wb_login_code('alice@x.com',null,null)`); ok(/permission denied/.test(d.error || ''), 'login code not callable by anon');
  d = await direct('authenticated', `select public.api_app_whoami('{}')`, [], someone); ok(/permission denied/.test(d.error || ''), 'API functions not callable directly');
  d = await direct('authenticated', `select public.pay_package(gen_random_uuid(), 10, 'Cash', null)`, [], someone);
  ok(/not allowed/.test(d.error || ''), 'signed up user without profile is NOT system any more: ' + d.error);
  d = await direct('authenticated', `select set_config('wb.identity','{"role":"owner","staff":"majd"}',true), set_config('wb.identity_sig','00',true), public.pay_package(gen_random_uuid(), 10, 'Cash', null)`, [], someone);
  ok(/not allowed/.test(d.error || ''), 'forged identity ignored: ' + d.error);
  const sig = await one(`select app.hmac_hex('{"role": "owner", "staff": "majd"}', app.secret('ident_key'))`);
  d = await direct('authenticated', `select set_config('wb.identity','{"role": "owner", "staff": "majd"}',true), set_config('wb.identity_sig',$1,true), public.pay_package(gen_random_uuid(), 10, 'Cash', null)`, [sig], someone);
  ok(/not allowed/.test(d.error || ''), 'even a correctly signed identity is ignored from the public API roles: ' + d.error);
  d = await direct('anon', `select * from app.sessions`); ok(/permission denied/.test(d.error || ''), 'sessions table closed');
  d = await direct('authenticated', `select * from app.secrets`, [], someone); ok(/permission denied/.test(d.error || ''), 'secrets closed');
  // workers (no request role) are still system
  ok((await one(`select app.caller()->>'role'`)) === 'system', 'SQL editor / workers stay system');
  ok((await svc(`select public.wb_whoami('k-majd', null)`)).staff === 'majd' && (await svc(`select public.wb_whoami(null, 'junk')`)) === null, 'wb_whoami for other functions');
  d = await direct('anon', `select public.wb_whoami('k-majd', null)`); ok(/permission denied/.test(d.error || ''), 'wb_whoami closed to anon');
  // shadow log
  r = await svc(`select public.wb_shadow('k-majd', null, 'app_boot', false, '{"x":[1,2]}')`); ok(r.ok, 'shadow log insert');
  r = await svc(`select public.wb_shadow(null, null, 'app_boot', true, null)`); ok(!r.ok, 'shadow log needs a sign in');
  let thrown = null; try { await q(`delete from app.shadow_log`); } catch (e) { thrown = e.message; } ok(/insert only/.test(thrown || ''), 'shadow log insert only');

  await c.end();
  console.log(`auth: ${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
