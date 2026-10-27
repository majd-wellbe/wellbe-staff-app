#!/usr/bin/env node
// =====================================================================
// Nutrition v2 (migrations/0012_nutrition.sql + functions/nutrition-worker/plan.ts) on a real Postgres 16.
// Everything goes through the API door (public.wb_call) with a staff key or a client token, like the apps.
// The worker path is the edge function's: wb_nut_claim -> plan.ts step (AI mocked with tests/lib/nut_fixture.cjs)
// -> wb_nut_save / wb_nut_finish / wb_nut_error.
//  1. calculator: same numbers as Nutrition.gs nutCalc_ (run on both), sport goal, maintenance goals, water, flags, refused target
//  2. lock and test access, the cycle, one plan per cycle, no replans on weigh-ins
//  3. unflagged plan: written, checked, shown at once; reminders; grocery ticks
//  4. flagged client: to the OWNER only, cycle starts at approval; stop flags: no AI until the owner sets numbers
//  5. failed the checks twice -> owner; AI errors -> Failed; owner edit re-checked in code
//  6. cycle end: plan locked, reminders off, ticks refused, free calculator stays; RLS on every table
// Writes the sample paid plan to $WB_SAMPLE_OUT (default: tests/.out/sample-plan.json).
// Run: node nutrition.js   (local Postgres from README, PGHOST/PGPORT)
// =====================================================================
const { Client } = require('pg'), { execFileSync } = require('child_process'), path = require('path'), fs = require('fs'), vm = require('vm');
const HOST = process.env.PGHOST || '/var/lib/postgresql/wbtest', PORT = Number(process.env.PGPORT || 5544), DB = 'nut_test';
const X = require('./lib/nut_fixture.cjs');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) pass++; else { fail++; console.log('   FAIL: ' + m + (extra !== undefined ? '\n         ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 1500) : '')); } };
const canon = x => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.keys(x).sort().reduce((o, k) => (o[k] = canon(x[k]), o), {}) : x;   // key order does not matter (jsonb)
const eq = (a, b, m) => ok(JSON.stringify(canon(a)) === JSON.stringify(canon(b)), m, 'got ' + JSON.stringify(a) + '\n         want ' + JSON.stringify(b));

// Nutrition.gs (the live Apps Script) in a sandbox, for the calculator comparison
function loadGs() {
  const ctx = { Math, JSON, Number, String, Date, Object, Array, isNaN,
    appShift_: (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../1-apps-script/phase3/Nutrition.gs'), 'utf8'), ctx);
  return ctx;
}

(async () => {
  const P = await import('../functions/nutrition-worker/plan.ts');
  execFileSync(path.join(__dirname, 'reset.sh'), [DB], { env: Object.assign({}, process.env, { PGHOST: HOST, PGPORT: String(PORT) }), stdio: 'pipe' });
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: DB }); await c.connect();
  const q = async (sql, p) => (await c.query(sql, p || [])).rows;
  const one = async (sql, p) => { const r = await q(sql, p); return r[0] ? r[0][Object.keys(r[0])[0]] : null; };
  const svc = async (sql, p) => { await c.query('begin'); try { await c.query('set local role service_role'); const r = await c.query(sql, p || []); await c.query('commit'); return r.rows[0] ? r.rows[0][Object.keys(r.rows[0])[0]] : null; } catch (e) { await c.query('rollback'); return { thrown: e.message }; } };
  const call = (action, who, body) => svc('select public.wb_call($1,$2,$3,$4::jsonb) r', [action, who.key || null, who.token || null, JSON.stringify(body || {})]);
  const today = await one(`select app_today()::text`);

  // ---------- people ----------
  await q(`insert into public.clients (legacy_id, kind, name, email) values
    ('C101','client','Karim Haddad','karim@x.com'), ('C102','client','Rana Khoury','rana@x.com'), ('C103','client','Maya Saad','maya@x.com'),
    ('C104','client','Majd Bou Habib','majdbouhabib@gmail.com'), ('C105','client','Nour Fares','nour@x.com'), ('C106','client','Ziad Aoun','ziad@x.com'),
    ('G0101','guest','Gina Guest','gina@x.com')`);
  for (const e of ['karim', 'rana', 'maya', 'majdbouhabib', 'nour', 'ziad', 'gina']) {
    const em = e === 'majdbouhabib' ? 'majdbouhabib@gmail.com' : e + '@x.com';
    await q(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, em]);
  }
  for (const s of ['majd', 'romy', 'joe']) await q(`insert into app.staff_keys (staff_id, key_hash) values ($1, app.sha($2))`, [s, 'k-' + s]);
  const T = n => ({ token: 'wb1.' + n }), MAJD = { key: 'k-majd' }, ROMY = { key: 'k-romy' }, JOE = { key: 'k-joe' };
  const K = T('karim');
  const nut = (who, cid, op, body) => call('app_cl_nut', who, Object.assign({ cid, op }, body || {}));
  const fill = async (who, cid, body, answers) => {
    await nut(who, cid, 'body', body);
    return nut(who, cid, 'intake_save', { answers, step: 7, done: true });
  };

  // ---------- 0. questionnaire v2 ----------
  let r = await nut(K, 'C101', 'intake_get');
  ok(r.ok && r.v === 2, 'client screen v2', r);
  eq(r.questions.map(s => s.q.map(x => x.k).join(',')), ['goal,why,pace,event', 'job,train_days,train_time,wake,bed,sleep',
    'meals,breakfast,cook,skill,cook_time,out,budget,household,variety,prep_day,prep_time', 'now_day,often,love,style,love_other,dislike',
    'allergy,allergy_other,rules,digest', 'coffee,sugar_drinks,alcohol,water,cravings,weekend,supps', 'health'], 'questionnaire v2 keys by step');
  const allQ = {}; r.questions.forEach(s => s.q.forEach(x => { allQ[x.k] = x; }));
  ok(Object.values(allQ).every(x => x.t.en && x.t.ar && (!x.opts || x.opts.every(o => o.en && o.ar))), 'every question and option in English and Arabic');
  eq(allQ.goal.opts.map(o => o.v), ['lose', 'tone', 'gain', 'sport', 'health'], 'sport goal added');
  eq(allQ.pace.show_if, { goal: ['lose', 'gain'] }, 'pace only for lose / gain');
  ok(allQ.goal.opts[0].ar === 'خسارة دهون' && allQ.job.t.ar === 'شغلك بالنهار', 'existing Arabic reused');
  ok(!JSON.stringify(r.questions).match(/InBody|body composition/i), 'no body composition question');
  r = await nut(K, 'C101', 'upload', { b64: 'x', mime: 'image/png' });
  ok(r.ok === false && /removed/.test(r.error), 'InBody upload removed', r);
  r = await nut(K, 'C101', 'intake_save', { answers: { variety: 'nine', bed: '25:00', prep_day: 'sun', household: '4', skill: 'ok', style: ['lebanese', 'x'] }, step: 3 });
  eq([r.answers.variety, r.answers.bed, r.answers.prep_day, r.answers.style], [undefined, '', 'sun', ['lebanese']], 'new answers checked against the server definition');

  // ---------- 1. calculator ----------
  const GS = loadGs();
  const profiles = [
    { weight: 92, height: 178, age: 34, sex: 'M', target: 82, pace: 'slow', ans: { goal: 'lose', job: 'desk', train_days: '3' } },
    { weight: 62, height: 163, age: 34, sex: 'F', target: 56, pace: 'fast', ans: { goal: 'lose', job: 'mixed', train_days: '5' } },
    { weight: 70, height: 168, age: 29, sex: 'F', target: 74, pace: 'slow', ans: { goal: 'gain', job: 'active', train_days: '2' } },
    { weight: 58, height: 170, age: 41, sex: 'F', target: 50, pace: 'fast', ans: { goal: 'lose', job: 'desk', train_days: '1' } },     // floor
    { weight: 120, height: 185, age: 52, sex: 'M', target: 95, pace: 'fast', ans: { goal: 'lose', job: 'desk', train_days: '0' } },
    { weight: 80, height: 175, age: 30, sex: 'M', target: 80, pace: 'slow', ans: { goal: 'lose', job: 'desk', train_days: '4' } },     // keep
  ];
  for (const p of profiles) {
    p.ans.pace = p.pace;
    const g = GS.nutCalc_(Object.assign({ bf: 0 }, p), today);
    const s = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(p), today]);
    const pick = o => ({ kcal: o.kcal, p: o.p, c: o.c, f: o.f, bmr: o.bmr, tdee: o.tdee, rateKg: o.rateKg, dir: o.dir, floorHit: !!o.floorHit, proj: o.projection && o.projection.text });
    eq(pick(s), pick(g), `calculator = Nutrition.gs nutCalc_ (${p.weight} > ${p.target} kg ${p.ans.goal} ${p.pace})`);
  }
  const blocked = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify({ weight: 60, height: 175, age: 25, sex: 'F', target: 50, ans: { goal: 'lose' } }), today]);
  eq([blocked.blocked, blocked.safeMin, blocked.msg], [true, 57, 'This target is under a healthy weight for your height. The closest healthy target is 57 kg.'], 'target refused under BMI 18.5, closest healthy target offered');
  eq(GS.nutCalc_({ weight: 60, height: 175, age: 25, sex: 'F', target: 50, ans: {} }, today).safeMin, 57, 'same safe target as Nutrition.gs');
  // maintenance goals and sport
  const base = { weight: 80, height: 180, age: 30, sex: 'M', target: 72, ans: { job: 'mixed', train_days: '4', pace: 'fast' } };
  const g0 = GS.nutCalc_(Object.assign({}, base, { target: 80, bf: 0 }), today);
  for (const goal of ['tone', 'health']) {
    const s = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(Object.assign({}, base, { ans: Object.assign({}, base.ans, { goal }) })), today]);
    eq([s.dir, s.kcal, s.p, s.c, s.f, s.target], ['keep', g0.kcal, g0.p, g0.c, g0.f, 80], goal + ' = maintenance (target weight ignored, pace ignored)');
  }
  const sp = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(Object.assign({}, base, { ans: Object.assign({}, base.ans, { goal: 'sport' }) })), today]);
  const fat25 = Math.round(g0.kcal * 0.25 / 9);
  eq([sp.dir, sp.kcal, sp.p, sp.f, sp.c, sp.sport], ['keep', g0.kcal, 160, fat25, Math.round((g0.kcal - 160 * 4 - fat25 * 9) / 4 / 5) * 5, true], 'sport = maintenance calories, fat 25%, carbs the rest');
  eq(await q(`select app.nut_water(w) w from unnest(array[92, 60, 61, 45, 120.5]::float8[]) w`).then(x => x.map(y => y.w)), [3.25, 2, 2.25, 1.5, 4.25], 'water: 1 L per 30 kg, rounded up to 0.25 L');

  const kb0 = X.profile.body;
  // the free calculator through the API: a guest, a client; flagged clients see no numbers
  r = await fill(T('gina'), 'G0101', { weight: 70, height: 165, birth: 1990, sex: 'F', target: 64 }, { goal: 'lose', pace: 'slow', job: 'desk', train_days: '2', meals: '3', allergy: ['none'], health: ['none'] });
  ok(r.ok && r.calc.ok && r.calc.kcal > 1200 && r.calc.water_l === 2.5, 'guest gets the free calculator with water', r.calc);
  eq([r.nut.state, r.paid], ['coming_soon', false], 'guest: paid plan coming soon');
  r = await fill(T('rana'), 'C102', kb0, Object.assign({}, X.profile.answers, { health: ['diabetes'] }));   // same body as the sample, so the mocked plan fits her numbers
  eq([r.calc.ok, r.calc.coach, r.calc.kcal, r.calc.water_l, r.calc.msg], [false, true, undefined, undefined, 'Our team will set your numbers with you personally, to keep you safe.'], 'flagged: no calorie targets, the team sets them');
  r = await fill(T('maya'), 'C103', { weight: 55, height: 160, birth: 2010, sex: 'F', target: 52 }, Object.assign({}, X.profile.answers, { health: ['none'], allergy: ['none'] }));
  eq([r.calc.coach, r.flags], [true, ['minor']], 'under 18: flagged');

  // ---------- 2. lock and test access ----------
  const kb = X.profile.body;
  r = await fill(K, 'C101', kb, X.profile.answers);
  eq([r.calc.kcal, r.calc.p, r.calc.c, r.calc.f, r.calc.water_l], [1990, 165, 195, 62, 3.25], 'sample client targets (the fixture plan is written for these)');
  eq([r.nut.open, r.nut.tester, r.nut.state, r.nut.can_start], [false, false, 'coming_soon', false], 'locked: coming soon');
  r = await nut(K, 'C101', 'generate');
  eq(r.error, 'Your full nutrition plan is coming soon.', 'locked: a client cannot generate');
  r = await call('app_nut_settings', ROMY, { paid_open: true });
  eq(r.error, 'not allowed', 'only the owner opens the paid plan');
  r = await call('app_nut_cycle', ROMY, { cid: 'C101', act: 'tester_on' });
  eq(r.error, 'not allowed', 'only the owner adds testers');
  // a staff member's own client account is a tester
  r = await fill(T('majdbouhabib'), 'C104', { weight: 85, height: 180, birth: 1990, sex: 'M', target: 80 }, Object.assign({}, X.profile.answers));
  eq([r.nut.tester, r.nut.state, r.nut.can_start], [true, 'none', true], 'staff email = tester, can start a test cycle while locked');
  // the owner marks Karim as a nutrition tester
  r = await call('app_nut_cycle', MAJD, { cid: 'C101', act: 'tester_on', note: 'try it' });
  ok(r.ok && r.tester === true && r.cycle === null, 'owner marks a tester', r);
  r = await nut(K, 'C101', 'generate');
  ok(r.ok && r.status === 'Queued', 'tester generates while locked', r);
  eq([r.nut.state, r.nut.cycle.source, r.nut.cycle.start, r.nut.cycle.end, r.nut.cycle.day, r.nut.cycle.days_left],
    ['active', 'test', today, await one(`select ($1::date + 21)::text`, [today]), 1, 21], 'test cycle: starts today, ends start + 21 days');
  eq([r.plan.state, r.plan.msg.en], ['preparing', 'Your plan is being prepared by our team.'], 'client sees "being prepared"');
  r = await nut(K, 'C101', 'generate');
  ok(r.ok === false && /A new plan comes with your next 3-week cycle/.test(r.error), 'one plan per cycle', r);
  eq(await one(`select count(*)::int from public.nutrition_plans where review = 'auto' and engine = 'v2'`), 1, 'unflagged plan: no coach approval needed');

  // ---------- 3. the worker writes it (mocked AI), checks pass, shown at once ----------
  const aiCalls = [];
  const mock = (plant) => (system, user) => {
    aiCalls.push(user);
    const keys = /Write day templates? ([A-G](?: and [A-G])?)/.exec(user)[1].split(' and ');
    return Promise.resolve(X.aiAnswer(keys, plant ? plant(aiCalls.length) : undefined));
  };
  const runWorker = async (ask, max = 30) => {   // the edge function's loop (index.ts runOnce), on this database
    const out = [];
    for (let i = 0; i < max; i++) {
      const job = await svc(`select public.wb_nut_claim(240, $1) r`, [!ask]);
      if (!job) break;
      if (job.thrown) { out.push(job); break; }
      try {
        const st = await P.step({ macros: job.macros, answers: job.answers || {}, draft: job.draft, job: job.job, model: 'mock' }, ask || (() => Promise.reject(new Error('no AI key'))), new Date('2026-10-27T10:00:00Z'));
        if (!st.done) { await svc(`select public.wb_nut_save($1, $2::jsonb)`, [job.id, JSON.stringify(st.draft)]); continue; }
        out.push(await svc(`select public.wb_nut_finish($1, $2::jsonb, $3::jsonb)`, [job.id, JSON.stringify(st.plan), JSON.stringify(st.problems)]));
      } catch (e) { out.push(await svc(`select public.wb_nut_error($1, $2)`, [job.id, String(e.message)])); }
    }
    return out;
  };
  // the worker door is closed to everyone but the service role
  const direct = async (role, sql) => { await c.query('begin'); try { await c.query(`set local role ${role}`); await c.query(sql); await c.query('rollback'); return 'ran'; } catch (e) { await c.query('rollback'); return e.message; } };
  ok(/permission denied/.test(await direct('authenticated', `select public.wb_nut_claim(1, false)`)) && /permission denied/.test(await direct('anon', `select public.wb_nut_finish(gen_random_uuid(), '{}', '[]')`)), 'worker functions: service role only');
  eq(await call('nut_claim', K, {}), { ok: false, error: 'unknown action' }, 'worker functions are not API actions');

  let w = await runWorker(mock());
  eq(w, [{ status: 'Approved', passed: true }], 'unflagged plan passed the code checks: approved automatically');
  eq(aiCalls.length, 1, 'one AI call (2 alternating days)');
  r = await nut(K, 'C101', 'get');
  const P1 = r.plan;
  ok(P1.state === 'ready' && P1.data && P1.data.days.length === 2 && P1.data.schedule.length === 21, 'client sees the plan at once', P1 && P1.state);
  eq(P1.data.days[0].meals.map(m => m.slot + ' ' + m.time), ['breakfast 07:45', 'lunch 12:15', 'snack 16:30', 'dinner 21:00'], '4 eating times set in code');
  ok(P1.data.days.every(d => d.meals.every(m => m.swap && m.swap.items.length && m.items.every(x => x.g > 0 && x.measure.en && x.measure.ar))), 'portions in grams + household measure, one swap per meal');
  eq(P1.data.grocery.length, 3, '3 weekly grocery lists');
  ok(P1.data.disclaimer.en.startsWith('General guidance') && r.nut.disclaimer.ar.length > 10, 'disclaimer on the plan and the screen');
  eq(await one(`select by_who from public.nutrition_plans where legacy_id = $1`, [P1.id]), 'auto check', 'approved by the code check');
  // reminders
  const rem = r.reminders;
  eq([rem.active, rem.delivery, rem.window, rem.quiet], [true, 'pending', { from: '07:00', to: '23:30' }, { from: '23:30', to: '07:00' }], 'reminders on, push delivery pending, quiet hours outside wake-bed');
  eq(rem.items.filter(x => x.kind === 'meal').map(x => x.time), ['07:45', '12:15', '16:30', '21:00'], 'a reminder at each planned meal');
  eq(rem.items.filter(x => x.kind === 'water').map(x => x.time), ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00'], 'water every 2 hours inside wake-bed');
  eq(rem.items.filter(x => x.kind === 'prep').map(x => [x.time, x.days, x.label.en]), [['11:00', 'sun', 'Meal prep for the week (Sunday)']], 'weekly meal-prep reminder');
  r = await nut(K, 'C101', 'reminders', { prefs: { meal: { times: { 2: '17:15', 7: '10:00' } }, water: { every_h: 3 }, quiet: { from: '22:00', to: '08:00' } }, snooze_min: 60 });
  eq(r.reminders.items.filter(x => x.kind === 'meal').map(x => x.time), ['12:15', '17:15', '21:00'], 'meal time changed; 07:45 now in quiet hours (22:00 to 08:00)');
  eq(r.reminders.items.filter(x => x.kind === 'water').map(x => x.time), ['10:00', '13:00', '16:00', '19:00'], 'water every 3 hours, none in quiet hours');
  ok(r.reminders.paused && r.reminders.snooze_until && !r.reminders.muted, 'snoozed', r.reminders);
  r = await nut(K, 'C101', 'reminders', { mute: true, snooze_min: 0, prefs: { quiet: null, meal: {}, water: { every_h: 2 } } });
  ok(r.reminders.muted && r.reminders.paused && !r.reminders.snooze_until && r.reminders.quiet.from === '23:30', 'muted, snooze off, own quiet hours cleared', r.reminders);
  // grocery ticks
  const gi = P1.data.grocery[0].aisles[0].items[0];
  r = await nut(K, 'C101', 'tick', { plan: P1.id, week: 1, item: gi.key, on: true });
  eq(r.plan.ticks, { 1: [gi.key] }, 'grocery item ticked (stored per client)');
  r = await nut(T('nour'), 'C101', 'tick', { plan: P1.id, week: 1, item: gi.key, on: false });
  eq(r.error, 'Not your account', 'another client cannot tick');
  r = await nut(K, 'C101', 'tick', { plan: P1.id, week: 1, item: gi.key, on: false });
  eq(r.plan.ticks, {}, 'untick');
  // the sample for the owner
  const scr = await nut(K, 'C101', 'get');
  const sampleOut = process.env.WB_SAMPLE_OUT || path.join(__dirname, '.out', 'sample-plan.json');
  fs.mkdirSync(path.dirname(sampleOut), { recursive: true });
  fs.writeFileSync(sampleOut, JSON.stringify({
    note: 'Sample paid plan made by the v2 code path (migrations/0012 + functions/nutrition-worker/plan.ts). The AI step was replaced by a hand-written plan (tests/lib/nut_fixture.cjs) that passes the code checks. Test client: a Lebanese desk worker.',
    client: { body: X.profile.body, answers: X.profile.answers }, plan_id: scr.plan.id, plan_state: scr.plan.state, cycle: scr.nut.cycle,
    targets: scr.plan.macros, calculator_now: scr.calc, reminders: scr.reminders, disclaimer: scr.nut.disclaimer, plan: scr.plan.data }, null, 1));

  // weigh-ins only move the projection
  const before = (await nut(K, 'C101', 'get')).calc;
  r = await nut(K, 'C101', 'weigh', { kg: 87 });
  ok(r.ok && r.calc.weight === 87 && r.calc.projection.text.en !== before.projection.text.en, 'weigh-in updates the projection', r.calc);
  r = await nut(K, 'C101', 'body', { target: 78 });
  eq([await one(`select count(*)::int from public.nutrition_plans where client_id = app.client_by_legacy('C101')`), r.plan.id, r.plan.state, r.replan], [1, P1.id, 'ready', undefined], 'no automatic replan on weight or target change');
  // ---------- 4. flagged client: owner only; the cycle starts at approval ----------
  await call('app_nut_cycle', MAJD, { cid: 'C102', act: 'tester_on' });
  aiCalls.length = 0;
  r = await nut(T('rana'), 'C102', 'generate');
  ok(r.ok && r.status === 'Queued' && r.nut.state === 'waiting' && r.nut.cycle.start === null, 'flagged: plan queued, cycle waiting', r.nut);
  w = await runWorker(mock());
  eq(w, [{ status: 'Pending', passed: true }], 'flagged: passed the checks but goes to the owner');
  r = await nut(T('rana'), 'C102', 'get');
  eq([r.plan.state, r.plan.data, r.plan.msg.en, r.nut.state], ['preparing', undefined, 'Your plan is being prepared by our team.', 'waiting'], 'flagged client sees "being prepared", no plan yet');
  let L = await call('app_nut_list', MAJD, {});
  const rq = L.plans.find(x => x.cid === 'C102');
  ok(rq && rq.status === 'Pending' && /Health answers: diabetes/.test(rq.reason) && rq.passed === true, 'owner queue has it, with the reason', L.plans);
  for (const who of [ROMY, JOE]) { L = await call('app_nut_list', who, {}); eq([L.ok, L.plans, L.owner_only], [true, [], true], 'not in the queue of other staff'); }
  r = await call('app_nut_decide', ROMY, { cid: 'C102', id: rq.id, act: 'approve' });
  eq(r.error, 'not allowed', 'only the owner approves');
  r = await call('app_nut_get', MAJD, { cid: 'C102', id: rq.id });
  ok(r.ok && r.can_decide && r.plan.reason && r.plan.checks.passed === true && r.calc.kcal > 0 && r.cycle.state === 'waiting', 'owner opens it: numbers, checks, cycle', r);
  r = await call('app_nut_decide', MAJD, { cid: 'C102', id: rq.id, act: 'approve', note: 'Keep the dates to 2 a day' });
  eq(r.status, 'Approved', 'owner approves');
  r = await nut(T('rana'), 'C102', 'get');
  eq([r.plan.state, r.nut.state, r.nut.cycle.start, r.nut.cycle.days_left, r.plan.note], ['ready', 'active', today, 21, 'Keep the dates to 2 a day'], 'flagged: the 21 days start at the owner\'s approval');
  ok(await one(`select count(*)::int from public.outbox where to_staff = 'majd' and body like '%Rana Khoury%'`) >= 1, 'owner told on WhatsApp (outbox)');
  // stop flags (minor): no AI until the owner sets the numbers
  await call('app_nut_cycle', MAJD, { cid: 'C103', act: 'grant', source: 'test' });
  r = await nut(T('maya'), 'C103', 'generate');
  ok(r.ok && r.status === 'Coach review' && r.nut.state === 'waiting', 'under 18: plan waits for the owner, no AI', r);
  eq(await runWorker(mock()), [], 'worker does not touch it');
  L = await call('app_nut_list', MAJD, {});
  const mq = L.plans.find(x => x.cid === 'C103');
  r = await call('app_nut_decide', MAJD, { cid: 'C103', id: mq.id, act: 'regen', kcal: 1990, p: 165, c: 195, f: 62, note: 'small portions at school' });
  ok(r.ok && r.status === 'Queued', 'owner sets the numbers: the AI writes it', r);
  w = await runWorker(mock());
  eq(w, [{ status: 'Pending', passed: true }], 'back to the owner, never shown automatically');
  ok(/small portions at school/.test(aiCalls[aiCalls.length - 1]), 'owner note in the prompt');

  // ---------- 5. failures ----------
  // failed the checks twice -> owner, with the problems
  await call('app_nut_cycle', MAJD, { cid: 'C105', act: 'grant', source: 'payment', note: 'paid cash at the desk' });
  await fill(T('nour'), 'C105', kb, X.profile.answers);
  r = await nut(T('nour'), 'C105', 'generate');
  ok(r.ok && r.nut.cycle.source === 'payment', 'owner grants a paid cycle by hand (no payment provider yet)', r);
  aiCalls.length = 0;
  w = await runWorker(mock(() => j => { j.days[0].meals[1].items[0].food.en = 'Chicken with cashew sauce'; }));
  eq(w, [{ status: 'Pending', passed: false }], 'allergen planted twice: not shown, to the owner');
  eq(aiCalls.length, 2, 'one retry');
  ok(/fix all of them: Day A: Chicken with cashew sauce breaks "nuts"/.test(aiCalls[1]), 'retry lists the problem');
  r = await call('app_nut_get', MAJD, { cid: 'C105' });
  ok(r.plan.checks.passed === false && r.plan.checks.problems.some(x => /cashew/.test(x)) && /code checks after a retry/.test(r.plan.reason), 'owner sees the problems', r.plan);
  eq((await nut(T('nour'), 'C105', 'get')).plan.state, 'preparing', 'client: being prepared');
  // the owner fixes it by hand: checked again in code (no AI key needed)
  const fixed = { days: X.planDays(), notes: X.notes };
  r = await call('app_nut_decide', MAJD, { cid: 'C105', id: r.plan.id, act: 'fix', plan: fixed });
  eq(r.status, 'Queued', 'owner edit queued for the code check');
  w = await runWorker(null);
  eq(w, [{ status: 'Pending', passed: true }], 'owner edit re-checked without AI, back to the owner');
  r = await call('app_nut_decide', MAJD, { cid: 'C105', id: r.id, act: 'approve' });
  eq((await nut(T('nour'), 'C105', 'get')).plan.state, 'ready', 'approved after the fix');
  // AI errors: Failed after 3, to the owner
  await call('app_nut_cycle', MAJD, { cid: 'C106', act: 'grant' });
  await fill(T('ziad'), 'C106', kb, X.profile.answers);
  await nut(T('ziad'), 'C106', 'generate');
  w = await runWorker(() => Promise.reject(new Error('AI 529: overloaded')), 1);
  eq(w, [{ status: 'Queued' }], 'AI error: tried again later');
  await q(`update public.nutrition_plans set lease_until = null`);
  w = await runWorker(() => Promise.reject(new Error('AI 529: overloaded')), 5);
  eq(w, [{ status: 'Queued' }, { status: 'Failed' }], 'third AI error: Failed');
  L = await call('app_nut_list', MAJD, {});
  ok(L.plans.some(x => x.cid === 'C106' && x.status === 'Failed'), 'failed plan in the owner queue');
  // old Apps Script plans are never taken by the worker
  await q(`insert into public.nutrition_plans (legacy_id, client_id, status, macros) values ('NP-0900', app.client_by_legacy('C106'), 'Queued', '{"kcal":2000}')`);
  eq(await runWorker(mock()), [], 'v1 plans left alone');

  // ---------- 6. the cycle ends ----------
  const kid = await one(`select id from public.clients where legacy_id = 'C101'`);
  // the same client through the public API with a Supabase Auth login (RLS path)
  await q(`insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'karim@x.com')`);
  await q(`insert into public.profiles (user_id, email, role) values ('11111111-1111-4111-8111-111111111111', 'karim@x.com', 'client')`);
  const asKarim = async sql => { await c.query('begin'); try { await c.query(`set local role authenticated`); await c.query(`select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true)`); const x = await c.query(sql); await c.query('rollback'); return x.rows; } catch (e) { await c.query('rollback'); return { error: e.message }; } };
  eq((await asKarim(`select legacy_id from public.nutrition_plans`)).length, 1, 'RLS: client reads their plan while the cycle runs');
  const tl = await asKarim(`select client_id from public.nutrition_testers`);
  ok(tl.error || tl.length === 0, 'RLS: testers list is owner only', tl);
  await q(`update public.nutrition_cycles set starts_on = starts_on - 21, ends_on = ends_on - 21 where client_id = $1`, [kid]);
  r = await nut(K, 'C101', 'get');
  eq([r.nut.state, r.plan.state, r.plan.data, r.reminders.active, r.reminders.items, r.paid, r.calc.ok], ['ended', 'locked', undefined, false, [], false, true], 'cycle over: plan locked, reminders stop, free calculator stays');
  r = await nut(K, 'C101', 'tick', { plan: P1.id, week: 1, item: gi.key, on: true });
  eq(r.error, 'This grocery list is closed.', 'ticks closed');
  eq((await asKarim(`select legacy_id from public.nutrition_plans`)).length, 0, 'RLS: the plan is closed after the cycle');
  r = await nut(K, 'C101', 'get');
  eq([r.nut.state, r.nut.can_start], ['ended', true], 'a tester may start a new cycle (new plan only with a new cycle)');
  r = await call('app_nut_cycle', MAJD, { cid: 'C102', act: 'end' });
  eq(r.cycle.state, 'ended', 'owner can end a cycle');

  // the lock opens
  r = await call('app_nut_settings', MAJD, { paid_open: true });
  eq(r.settings.paid_open, true, 'owner opens the paid plan');
  r = await nut(T('gina'), 'G0101', 'get');
  eq([r.nut.state, r.nut.can_start], ['none', false], 'open: no cycle yet (payment comes later), not coming soon');
  r = await nut(T('gina'), 'G0101', 'generate');
  ok(r.ok === false && /starts with/.test(r.error), 'open but no cycle: ask the desk', r);
  await call('app_nut_settings', MAJD, { paid_open: false });

  // ---------- the database ----------
  eq(await one(`select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity`), 0, 'every table has RLS');
  ok(await one(`select count(*)::int from app.api_actions`) >= 60, 'API actions registered');
  eq(await one(`select value from public.settings where key = 'backend'`), { use: 'apps' }, 'backend setting untouched');

  await c.end();
  console.log(`\nnutrition: ${pass} checks passed, ${fail} failed` + (fail ? '' : `\nsample plan: ${sampleOut}`));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
