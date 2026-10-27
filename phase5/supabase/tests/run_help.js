#!/usr/bin/env node
// Help + profile steps (migrations/0013_help_steps.sql) against Help.gs: same calls, same answers.
// Run: node run_help.js   (local Postgres 16 on PGHOST/PGPORT, database rebuilt by reset.sh, see README)
const path = require('path'), vm = require('vm'), fs = require('fs'), { execFileSync } = require('child_process');
const { Client } = require('pg');
const HOST = process.env.PGHOST || '/var/lib/postgresql/wbtest', PORT = Number(process.env.PGPORT || 5544), DB = 'wb_help';
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('   FAIL ' + msg + (extra !== undefined ? '\n         ' + JSON.stringify(extra).slice(0, 900) : '')); } }
// Help.gs pure merge functions, for the side by side check
const gs = {}; vm.createContext(gs);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../1-apps-script/phase3/Help.gs'), 'utf8'), gs);
(async () => {
  execFileSync('bash', [path.join(__dirname, 'reset.sh'), DB], { env: Object.assign({}, process.env, { PGHOST: HOST, PGPORT: String(PORT) }), stdio: 'pipe' });
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: DB }); await c.connect();
  await c.query(`insert into public.clients (legacy_id, kind, name, email) values ('C901', 'client', 'Help Tester', 'help@x.com'), ('C902', 'client', 'Other', 'other@x.com')`);
  for (const e of ['help@x.com', 'other@x.com']) await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, e]);
  const call = async (who, body) => {
    await c.query('begin');
    try { await c.query('set local role service_role'); const r = (await c.query(`select public.wb_call('app_cl_profile', null, $1, $2::jsonb) as x`, ['wb1.' + who, JSON.stringify(body)])).rows[0].x; await c.query('commit'); return r; }
    catch (e) { await c.query('rollback'); return { ok: false, error: 'SQL: ' + e.message }; }
  };
  const me = b => call('help@x.com', Object.assign({ cid: 'C901' }, b));
  console.log('help + profile steps (0013)');
  let r = await me({ op: 'state' });
  ok(r.ok && r.help.tips === null && r.help.asked === 0 && r.help.tour === '' && JSON.stringify(r.steps) === '{}', 'empty state', r);
  r = await me({ op: 'help', help: { tips: true, asked: 1, tour: 'done', pages: { center: { s: 'done' }, play: { s: 'prog', n: 2 } } } });
  ok(r.ok && r.help.pages.play.n === 2 && r.help.tour === 'done', 'help saved', r);
  r = await me({ op: 'help', help: { asked: 0, tour: 'skipped', pages: { center: { s: 'prog', n: 0 }, play: { s: 'done' } } } });
  ok(r.help.pages.center.s === 'done' && r.help.pages.play.s === 'done' && r.help.asked === 1 && r.help.tour === 'done', 'never backwards', r.help);
  ok((await me({ op: 'help', help: { tips: false } })).help.tips === false, 'tips off');
  r = await me({ op: 'help_reset' });
  ok(JSON.stringify(r.help.pages) === '{}' && r.help.tips === true && r.help.tour === 'done', 'reset', r.help);
  r = await me({ op: 'steps', met: ['photo', 'body', 'hack'] });
  ok(r.steps.photo && r.steps.photo.doneAt && r.steps.body && !r.steps.hack, 'steps marked', r.steps);
  const t0 = r.steps.photo.doneAt;
  r = await me({ op: 'steps', met: [] });
  ok(r.steps.photo.doneAt === t0 && Object.keys(r.steps).length === 2, 'steps never removed', r.steps);
  r = await me({ op: 'state' });
  ok(r.help.tips === true && Object.keys(r.steps).length === 2, 'state reloads both', r);
  r = await call('other@x.com', { cid: 'C901', op: 'state' });
  ok(!r.ok && /Not your account/.test(r.error), 'other person refused', r);
  r = await me({ op: 'nope' });
  ok(!r.ok && /unknown/.test(r.error), 'unknown op', r);
  r = await me({ op: 'photo', photo: 'data:image/png;base64,QUJDRA==' });
  ok(r.ok && r.photo === 'data:image/png;base64,QUJDRA==', 'old op photo still works', r);
  // same merge answers as Help.gs
  const cases = [[{}, { tips: true, pages: { me: { s: 'prog', n: 3 } } }], [{ pages: { me: { s: 'done' } }, asked: 2 }, { asked: 1, pages: { me: { s: 'prog', n: 1 }, shop: { s: 'dismissed' } } }],
    [{ tour: 'skipped', toast: 1 }, { tour: 'done', tips: false, pages: { 'Bad!': { s: 'done' }, x: { s: 'done' } } }]];
  for (const [a, b] of cases) {
    const sql = (await c.query('select app.help_merge($1::jsonb, $2::jsonb) as x', [JSON.stringify(a), JSON.stringify(b)])).rows[0].x;
    const js = JSON.parse(JSON.stringify(gs.helpMerge_(a, b)));
    const norm = o => JSON.stringify(o, Object.keys(Object.assign({}, o, o.pages || {}, { s: 1, n: 1 })).sort());
    ok(norm(sql) === norm(js), 'help_merge same as Help.gs ' + JSON.stringify(b), { sql, js });
  }
  await c.end();
  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
