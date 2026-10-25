// Part C (operations) test helpers: own template (0001-0004 + 0007, no other part's files), own databases (ops_*),
// and a snapshot of the operations tables on top of the shared one.
const { execFileSync } = require('child_process'), path = require('path'), fs = require('fs');
const D = require('./db.js');
const TPL = 'ops_tpl', DIR = path.join(__dirname, '../..');

function buildTemplate() {
  const env = Object.assign({}, process.env, { PGUSER: 'postgres', PGHOST: D.HOST, PGPORT: String(D.PORT) });
  const psql = args => execFileSync('psql', args, { env, stdio: 'pipe' });
  psql(['-q', '-d', 'postgres', '-c', `drop database if exists ${TPL}`, '-c', `create database ${TPL}`]);
  const files = [path.join(DIR, 'tests/00_supabase_stub.sql')]
    .concat(['0001_schema.sql', '0002_security.sql', '0003_logic.sql', '0004_jobs.sql'].concat(['0005_boot.sql', '0006_features.sql'].filter(f => fs.existsSync(path.join(DIR, 'migrations', f)))).concat(['0007_ops.sql', '0009_align.sql', '0008_auth.sql']).map(f => path.join(DIR, 'migrations', f)))
    .concat([path.join(DIR, 'seed/seed.sql')]);
  files.forEach(f => {
    try { psql(['-q', '-v', 'ON_ERROR_STOP=1', '-d', TPL, '-f', f]); }
    catch (e) { throw new Error('FAILED in ' + f + '\n' + String(e.stderr || e.message)); }
  });
}
async function freshDb(name) {
  await D.withDb('postgres', async c => { await c.query(`drop database if exists ${name}`); await c.query(`create database ${name} template ${TPL}`); });
  return name;
}
async function snapshot(c) {
  const q = async s => (await c.query(s)).rows;
  const base = await D.snapshot(c);
  return Object.assign(base, {
    clients: await q(`select legacy_id, kind, name, email, phone, is_mel from public.clients order by legacy_id`),
    client_notes: await q(`select c.legacy_id, n.always_show, n.program, n.updated_by from public.client_notes n join public.clients c on c.id = n.client_id order by 1`),
    requests: await q(`select r.legacy_id, c.legacy_id as client, r.type, r.details, r.slot, p.legacy_id as pkg, r.status, r.handled_by from public.client_requests r
        join public.clients c on c.id = r.client_id left join public.packages p on p.id = r.package_id order by 1`),
    leads: await q(`select l.legacy_id, l.status, l.trial_date::text, l.trial_time, l.notes, c.legacy_id as client, p.legacy_id as pkg, s.legacy_id as sess from public.leads l
        left join public.clients c on c.id = l.client_id left join public.packages p on p.id = l.package_id left join public.sessions s on s.id = l.session_id order by 1`),
    expenses: await q(`select day::text, what, category, amount_cents, by_who from public.expenses order by 1, 2`),
    recurring: await q(`select legacy_id, what, category, amount_cents, every, first_day::text, end_day::text, active, last_logged::text from public.recurring_expenses order by 1`),
    inventory: await q(`select item, stock, cost_cents from public.inventory order by 1`),
    pos: await q(`select at::date::text as day, item, qty, amount_cents from public.pos_sales order by 1, 2, 3`),
    ins_clients: await q(`select c.legacy_id, i.insurer, i.member_number, i.notes, i.rate_cents, i.by_who from public.insurance_clients i join public.clients c on c.id = i.client_id order by 1`),
    ins_claims: await q(`select k.legacy_id, c.legacy_id as client, k.insurer, k.month::text, k.sessions, k.amount_cents,
        (select string_agg(p.legacy_id, ',' order by p.legacy_id) from public.packages p where p.id = any(k.package_ids)) as pkgs, k.submitted::text, k.expected::text, k.reference, k.status,
        k.paid_on::text, k.paid_cents, k.by_who from public.insurance_claims k join public.clients c on c.id = k.client_id order by 1`)
  });
}
module.exports = { buildTemplate, freshDb, snapshot, TPL };
