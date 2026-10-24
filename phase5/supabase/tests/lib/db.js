// Test database helpers: template database, per scenario copies, logins, state snapshots.
const { Client } = require('pg'), crypto = require('crypto'), { execFileSync } = require('child_process'), path = require('path');
const HOST = process.env.PGHOST || '/var/lib/postgresql/wbtest', PORT = Number(process.env.PGPORT || 5544);
const TPL = 'wellbe_tpl';

async function withDb(db, fn) {
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: db });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
function buildTemplate() {
  execFileSync(path.join(__dirname, '../reset.sh'), [TPL], { env: Object.assign({}, process.env, { PGHOST: HOST, PGPORT: String(PORT) }), stdio: 'pipe' });
}
async function freshDb(name) {
  await withDb('postgres', async c => {
    await c.query(`drop database if exists ${name}`);
    await c.query(`create database ${name} template ${TPL}`);
  });
  return name;
}
async function dropDb(name) { await withDb('postgres', c => c.query(`drop database if exists ${name}`)); }

// deterministic auth user id for a staff id ('romy') or an email ('alice@x.com')
function uid(who) { const h = crypto.createHash('md5').update('wb:' + who).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }

// logins for every staff member and every client email (what Supabase Auth will hold after the move)
async function makeLogins(c) {
  const staff = (await c.query(`select id, role, coalesce(email, id || '@staff.local') as email from public.staff`)).rows;
  for (const s of staff) {
    await c.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid(s.id), s.email + '#' + s.id]);
    await c.query(`insert into public.profiles (user_id, email, role, staff_id) values ($1, $2, $3, $4) on conflict do nothing`, [uid(s.id), s.email, s.role, s.id]);
  }
  const em = (await c.query(`select lower(email) as email, bool_and(kind = 'guest') as guest from public.clients where email is not null group by 1`)).rows;
  for (const e of em) {
    await c.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid(e.email), e.email]);
    await c.query(`insert into public.profiles (user_id, email, role) values ($1, $2, $3) on conflict do nothing`, [uid(e.email), e.email, e.guest ? 'guest' : 'client']);
  }
}

// run SQL as a logged in person: 'romy', 'joe', 'alice@x.com'; 'anon' for nobody; 'system' = database owner
async function as(c, who, sql, params) {
  await c.query('begin');
  try {
    if (who !== 'system') {
      await c.query(`set local role ${who === 'anon' ? 'anon' : 'authenticated'}`);
      if (who !== 'anon') await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid(who)]);
    }
    const r = await c.query(sql, params || []);
    await c.query('commit');
    return { rows: r.rows };
  } catch (e) {
    await c.query('rollback');
    return { error: e.message };
  }
}
const one = r => (r.error ? { error: r.error } : (r.rows[0] ? r.rows[0][Object.keys(r.rows[0])[0]] : null));

// the state that matters, by today's IDs (no uuids, no created_at)
async function snapshot(c) {
  const q = async s => (await c.query(s)).rows;
  return {
    packages: await q(`select p.legacy_id, c.legacy_id as client, p.type_name, p.kind, p.passes, p.used, p.price_cents, p.paid_cents, p.discount_pct::float as disc,
        p.start_date::text as start, p.expiry_date::text as expiry, p.extended_expiry::text as ext, p.effective_expiry::text as eff, p.status, p.new_client, btrim(p.note) as note
        from public.packages p join public.clients c on c.id = p.client_id order by p.legacy_id`),
    clients: await q(`select legacy_id, is_mel from public.clients order by legacy_id`),
    sessions: await q(`select legacy_id, kind, day::text as day, to_char(start_time, 'HH24:MI') as start, trainer, room, status, btrim(note) as note from public.sessions order by legacy_id`),
    session_clients: await q(`select s.legacy_id as session, sc.slot, p.legacy_id as pkg, sc.att, sc.pass from public.session_clients sc
        join public.sessions s on s.id = sc.session_id join public.packages p on p.id = sc.package_id order by 1, 2`),
    notices: await q(`select n.legacy_id, coalesce(c.legacy_id, n.for_staff) as for, n.type, n.text, n.read_at is not null as read from public.notices n left join public.clients c on c.id = n.for_client order by 1`),
    requests: await q(`select r.legacy_id, c.legacy_id as client, r.type, r.details, r.slot, p.legacy_id as pkg, r.status from public.client_requests r
        join public.clients c on c.id = r.client_id left join public.packages p on p.id = r.package_id order by 1`),
    wallet: await q(`select c.legacy_id as client, w.amount_cents, w.reason from public.wallet_ledger w join public.clients c on c.id = w.client_id order by 1, 2, 3`),
    game: await q(`select c.legacy_id as client, g.best_score, g.best_m, g.coins, g.runs, g.total_m, g.day_best, g.week_best, g.upgrades, g.missions - 'd' as missions, g.badges,
        g.earned_total, g.credit_cents, g.credit_earned_cents, g.xp, g.owned from public.game_players g join public.clients c on c.id = g.client_id order by 1`),
    streaks: await q(`select c.legacy_id as client, s.done_days::text, s.keys_day::text, s.keys::text, s.last_reward::text, s.rewards from public.streaks s join public.clients c on c.id = s.client_id order by 1`)
  };
}
module.exports = { withDb, buildTemplate, freshDb, dropDb, uid, makeLogins, as, one, snapshot, HOST, PORT };
