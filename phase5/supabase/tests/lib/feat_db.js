// Part B (features) test helpers: own template (feat_tpl, all migrations in order + seed), own databases (feat_*),
// the API door caller (public.wb_call as the edge function) and a snapshot of the feature tables.
const { execFileSync } = require('child_process'), path = require('path'), fs = require('fs');
const D = require('./db.js');
const TPL = 'feat_tpl', DIR = path.join(__dirname, '../..');

function buildTemplate() {
  const env = Object.assign({}, process.env, { PGUSER: 'postgres', PGHOST: D.HOST, PGPORT: String(D.PORT) });
  const psql = args => execFileSync('psql', args, { env, stdio: 'pipe' });
  psql(['-q', '-d', 'postgres', '-c', `drop database if exists ${TPL}`, '-c', `create database ${TPL}`]);
  const mig = fs.readdirSync(path.join(DIR, 'migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort((a, b) => (a === '0008_auth.sql') - (b === '0008_auth.sql') || (a < b ? -1 : 1));   // deploy order: 0008 last
  const files = [path.join(DIR, 'tests/00_supabase_stub.sql')].concat(mig.map(f => path.join(DIR, 'migrations', f))).concat([path.join(DIR, 'seed/seed.sql')]);
  files.forEach(f => {
    try { psql(['-q', '-v', 'ON_ERROR_STOP=1', '-d', TPL, '-f', f]); }
    catch (e) { throw new Error('FAILED in ' + f + '\n' + String(e.stderr || e.message)); }
  });
}
async function freshDb(name) {
  await D.withDb('postgres', async c => { await c.query(`drop database if exists ${name}`); await c.query(`create database ${name} template ${TPL}`); });
  return name;
}
// logins as today: staff keys + client tokens, then calls through public.wb_call (service role, like the edge function)
async function doors(c, emails) {
  await c.query(`select app.import_staff_keys($1::jsonb)`, [JSON.stringify({ majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel', melanie: 'k-mel', jad: 'k-jad' })]);
  for (const e of emails) await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day') on conflict do nothing`, ['wb1.' + e, e]);
  const keyOf = { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel', melanie: 'k-mel', jad: 'k-jad', anon: null };
  return async (who, action, body) => {
    await c.query('begin');
    try {
      await c.query('set local role service_role');
      const staff = who in keyOf, r = (await c.query(`select public.wb_call($1, $2, $3, $4::jsonb) as x`,
        [action, staff ? keyOf[who] : null, staff || who === 'anon' ? null : 'wb1.' + who, JSON.stringify(body || {})])).rows[0].x;
      await c.query('commit');
      return r;
    } catch (e) { await c.query('rollback'); return { ok: false, error: 'SQL: ' + e.message }; }
  };
}
async function snapshot(c) {
  const q = async s => (await c.query(s)).rows;
  const base = await D.snapshot(c);
  delete base.game;                      // compared through the game answers (anti cheat clock differs)
  return Object.assign(base, {
    wo_programs: await q(`select c.legacy_id, w.program, w.version, w.updated_by from public.wo_programs w join public.clients c on c.id = w.client_id order by 1`),
    wo_logs: await q(`select c.legacy_id, l.day::text, coalesce(s.legacy_id, l.session_ref, '') as sid, l.workout, l.exercise, l.sets, l.by_who from public.wo_logs l
        join public.clients c on c.id = l.client_id left join public.sessions s on s.id = l.session_id order by 1, 2, 3, 5`),
    body: await q(`select c.legacy_id, b.day::text, b.weight_kg::float8, b.height_cm::float8, b.birth_year, b.sex from public.client_body b join public.clients c on c.id = b.client_id order by 1, 2, 3`),
    intake: await q(`select c.legacy_id, i.answers, i.step, i.done, greatest(i.version, 1) as version,  -- import.js reads a 0 version as 1
        i.target_kg::float8, i.body_comp, coalesce(i.flags, '') as flags from public.nutrition_intake i join public.clients c on c.id = i.client_id order by 1`),
    plans: await q(`select p.legacy_id, c.legacy_id as client, p.status, p.macros->'kcal' as kcal, p.macros->'p' as prot, p.intake_version, p.weight_at_plan::float8, p.target::float8,
        coalesce(p.by_who, '') as by_who, coalesce(p.coach_note, '') as note from public.nutrition_plans p join public.clients c on c.id = p.client_id order by 1`),
    weighins: await q(`select c.legacy_id, w.day::text, w.weight_kg::float8 from public.nutrition_weighins w join public.clients c on c.id = w.client_id order by 1, 2, 3`),
    goals: await q(`select c.legacy_id, g.promise, g.key1, g.key2, g.key3, g.made_by from public.client_goals g join public.clients c on c.id = g.client_id order by 1`),
    leads: await q(`select l.name, l.phone, coalesce(l.email, '') as email, l.status, l.trial_date::text, l.trial_time, l.booking_type, l.trained_before, l.why_now,
        regexp_replace(coalesce(l.notes, ''), '\\d\\d/\\d\\d \\d\\d:\\d\\d', 'TIME', 'g') as notes, l.source from public.leads l order by l.name, l.phone, l.email`),
    guests: await q(`select legacy_id, phone, guest_asked from public.clients where kind = 'guest' order by 1`)
  });
}
module.exports = { buildTemplate, freshDb, doors, snapshot, TPL };
