#!/usr/bin/env node
// =====================================================================
// Nutrition (migrations/0012_nutrition.sql + functions/nutrition-worker/plan.ts) on a real Postgres 16.
// Everything goes through the API door (public.wb_call) with a staff key or a client token, like the apps.
// The worker path is the edge function's (index.ts runOnce): wb_nut_claim -> restaurant lookup or plan.ts step
// (AI mocked with tests/lib/nut_fixture.cjs) -> wb_nut_rest_found / wb_nut_save / wb_nut_finish / wb_nut_error.
//  1. questionnaire v4, calculator = Nutrition.gs nutCalc_ (run on both), sport, maintenance, water, flags
//  2. lock and test access; the cycle waits for the client's approval
//  3. review loop: week 1 draft -> change requests (chips + text, max 2 rounds) -> approval -> full 3 weeks
//  4. picks, grocery ticks, reminders (meals, water, main prep, top-up, weekly weigh-in), weigh-ins (projection only)
//  5. flagged: owner first, then the client loop, owner again, the cycle starts at the later approval
//  6. failures: checks failed twice, AI errors, owner edit; restaurants (web search, library, owner list); notes
//  7. cycle end; renewal from the LATEST weigh-in with the client's notes in the prompt; RLS on every table
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
  const today = await one(`select app_today()::text`), plus = async n => one(`select ($1::date + $2::int)::text`, [today, n]);

  // ---------- people ----------
  await q(`insert into public.clients (legacy_id, kind, name, email) values
    ('C101','client','Ziad Haddad','ziad@x.com'), ('C102','client','Rana Khoury','rana@x.com'), ('C103','client','Maya Saad','maya@x.com'),
    ('C104','client','Majd Bou Habib','majdbouhabib@gmail.com'), ('C105','client','Nour Fares','nour@x.com'), ('C106','client','Karim Aoun','karim@x.com'),
    ('G0101','guest','Gina Guest','gina@x.com')`);
  for (const e of ['ziad', 'rana', 'maya', 'majdbouhabib', 'nour', 'karim', 'gina']) {
    const em = e === 'majdbouhabib' ? 'majdbouhabib@gmail.com' : e + '@x.com';
    await q(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '1 day')`, ['wb1.' + e, em]);
  }
  for (const s of ['majd', 'romy', 'joe']) await q(`insert into app.staff_keys (staff_id, key_hash) values ($1, app.sha($2))`, [s, 'k-' + s]);
  const T = n => ({ token: 'wb1.' + n }), MAJD = { key: 'k-majd' }, ROMY = { key: 'k-romy' }, JOE = { key: 'k-joe' }, Z = T('ziad');
  const nut = (who, cid, op, body) => call('app_cl_nut', who, Object.assign({ cid, op }, body || {}));
  const fill = async (who, cid, body, answers) => { await nut(who, cid, 'body', body); return nut(who, cid, 'intake_save', { answers, step: 7, done: true }); };
  const ZB = X.profile.body, ZA = X.profile.answers;

  // the worker (index.ts runOnce, on this database): mocked AI and web search
  const aiCalls = [], searches = [];
  const search = name => { searches.push(name); return Promise.resolve('{"found":false,"dishes":[]}'); };   // no menu invented for Kababji
  const runWorker = async (ask, max = 30, srch = search) => {
    const out = [];
    for (let i = 0; i < max; i++) {
      const job = await svc(`select public.wb_nut_claim(240, $1) r`, [!ask]);
      if (!job) break;
      if (job.thrown) { out.push(job); break; }
      try {
        const unknown = job.job !== 'recheck' && ask ? (job.restaurants || []).find(x => x.status === 'unknown') : null;
        if (unknown) {
          const dishes = P.parseSearch(await srch(unknown.name));
          await svc(`select public.wb_nut_rest_found($1, $2::jsonb)`, [unknown.name, JSON.stringify(dishes)]);
          await svc(`select public.wb_nut_save($1, $2::jsonb)`, [job.id, JSON.stringify(job.draft)]);
          continue;
        }
        const st = await P.step({ macros: job.macros, answers: job.answers || {}, draft: job.draft, job: job.job, model: 'mock', flags: job.flags || [], restaurants: job.restaurants || [], base: job.base, memory: job.memory || [], requests: job.requests || [] },
          ask || (() => Promise.reject(new Error('no AI key'))), new Date('2026-10-27T10:00:00Z'));
        if (!st.done) { await svc(`select public.wb_nut_save($1, $2::jsonb)`, [job.id, JSON.stringify(st.draft)]); continue; }
        out.push(await svc(`select public.wb_nut_finish($1, $2::jsonb, $3::jsonb)`, [job.id, JSON.stringify(st.plan), JSON.stringify(st.problems)]));
      } catch (e) { out.push(await svc(`select public.wb_nut_error($1, $2)`, [job.id, String(e.message)])); }
    }
    return out;
  };
  const mock = plant => { const m = X.mockAsk(plant); return (s, u, t) => { aiCalls.push(u); return m.ask(s, u, t); }; };

  // ---------- 1. questionnaire v4 ----------
  let r = await nut(Z, 'C101', 'intake_get');
  ok(r.ok && r.v === 2, 'client screen', r);
  eq(r.questions.map(s => s.q.map(x => x.k).join(',')), ['goal,why,pace,event', 'job,train_days,train_time,wake,bed,sleep',
    'meals,breakfast,cook,skill,cook_time,out,social,social_drinks,restaurants,budget,household,salad_freq,prep_day,prep_time', 'now_day,often,love,style,love_other,dislike',
    'allergy,allergy_other,rules,digest', 'coffee,sugar_drinks,alcohol,water,cravings,weekend,supps', 'health'], 'questionnaire keys by step (variety removed)');
  const allQ = {}; r.questions.forEach(s => s.q.forEach(x => { allQ[x.k] = x; }));
  ok(Object.values(allQ).every(x => x.t.en && x.t.ar && (!x.opts || x.opts.every(o => o.en && o.ar))), 'every question and option in English and Arabic');
  eq(allQ.social.opts.map(o => o.v), ['fri_night', 'sat_night', 'sun_lunch', 'midweek_dinner', 'family_lunch', 'rarely'], 'social slots incl. Sunday family lunch');
  eq(allQ.salad_freq.opts.map(o => o.v), ['most_meals', 'few_week', 'rarely'], 'salad frequency');
  eq([allQ.social_drinks.opts.map(o => o.v), allQ.social_drinks.show_if, allQ.restaurants.max], [['no', 'sometimes', 'usually'], { social: ['fri_night', 'sat_night'] }, 120], 'drinks and restaurants');
  ok(allQ.goal.opts[0].ar === 'خسارة دهون' && !JSON.stringify(r.questions).match(/InBody|body composition/i), 'existing Arabic reused, no InBody');
  r = await nut(Z, 'C101', 'upload', { b64: 'x' });
  ok(r.ok === false && /removed/.test(r.error), 'InBody upload removed', r);
  r = await nut(Z, 'C101', 'intake_save', { answers: { social: ['fri_night', 'rarely'], salad_freq: 'never', bed: '25:00', restaurants: 'A, B' }, step: 3 });
  eq([r.answers.social, r.answers.salad_freq, r.answers.bed, r.answers.restaurants], [['fri_night'], undefined, '', 'A, B'], 'answers checked against the server definition ("rarely" alone)');

  // ---------- calculator ----------
  const GS = loadGs();
  for (const p of [
    { weight: 92, height: 178, age: 34, sex: 'M', target: 82, pace: 'slow', ans: { goal: 'lose', job: 'desk', train_days: '3' } },
    { weight: 62, height: 163, age: 34, sex: 'F', target: 56, pace: 'fast', ans: { goal: 'lose', job: 'mixed', train_days: '5' } },
    { weight: 70, height: 168, age: 29, sex: 'F', target: 74, pace: 'slow', ans: { goal: 'gain', job: 'active', train_days: '2' } },
    { weight: 58, height: 170, age: 41, sex: 'F', target: 50, pace: 'fast', ans: { goal: 'lose', job: 'desk', train_days: '1' } },
    { weight: 120, height: 185, age: 52, sex: 'M', target: 95, pace: 'fast', ans: { goal: 'lose', job: 'desk', train_days: '0' } },
    { weight: 96, height: 190, age: 30, sex: 'M', target: 100, pace: 'slow', ans: { goal: 'gain', job: 'desk', train_days: '5' } },
  ]) {
    p.ans.pace = p.pace;
    const g = GS.nutCalc_(Object.assign({ bf: 0 }, p), today), s = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(p), today]);
    const pick = o => ({ kcal: o.kcal, p: o.p, c: o.c, f: o.f, bmr: o.bmr, tdee: o.tdee, rateKg: o.rateKg, dir: o.dir, floorHit: !!o.floorHit, proj: o.projection && o.projection.text });
    eq(pick(s), pick(g), `calculator = Nutrition.gs nutCalc_ (${p.weight} > ${p.target} kg ${p.ans.goal} ${p.pace})`);
  }
  const blocked = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify({ weight: 60, height: 175, age: 25, sex: 'F', target: 50, ans: { goal: 'lose' } }), today]);
  eq([blocked.blocked, blocked.safeMin, blocked.msg], [true, 57, 'This target is under a healthy weight for your height. The closest healthy target is 57 kg.'], 'target refused, closest healthy target offered');
  const base = { weight: 80, height: 180, age: 30, sex: 'M', target: 72, ans: { job: 'mixed', train_days: '4', pace: 'fast' } };
  const g0 = GS.nutCalc_(Object.assign({}, base, { target: 80, bf: 0 }), today);
  for (const goal of ['tone', 'health']) {
    const s = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(Object.assign({}, base, { ans: Object.assign({}, base.ans, { goal }) })), today]);
    eq([s.dir, s.kcal, s.p, s.c, s.f], ['keep', g0.kcal, g0.p, g0.c, g0.f], goal + ' = maintenance');
  }
  const sp = await one(`select app.nut_numbers($1::jsonb, $2::date)`, [JSON.stringify(Object.assign({}, base, { ans: Object.assign({}, base.ans, { goal: 'sport' }) })), today]);
  const fat25 = Math.round(g0.kcal * 0.25 / 9);
  eq([sp.dir, sp.kcal, sp.p, sp.f, sp.c, sp.sport], ['keep', g0.kcal, 160, fat25, Math.round((g0.kcal - 160 * 4 - fat25 * 9) / 4 / 5) * 5, true], 'sport = maintenance calories, fat 25%');
  eq(await q(`select app.nut_water(w) w from unnest(array[92, 60, 61, 45, 120.5]::float8[]) w`).then(x => x.map(y => y.w)), [3.25, 2, 2.25, 1.5, 4.25], 'water: 1 L per 30 kg, rounded up to 0.25 L');
  r = await fill(T('gina'), 'G0101', { weight: 70, height: 165, birth: 1990, sex: 'F', target: 64 }, { goal: 'lose', pace: 'slow', job: 'desk', train_days: '2', meals: '3', allergy: ['none'], health: ['none'] });
  ok(r.ok && r.calc.ok && r.calc.water_l === 2.5 && r.nut.state === 'coming_soon', 'guest: free calculator, paid plan coming soon', r.calc);
  r = await fill(T('rana'), 'C102', ZB, Object.assign({}, ZA, { health: ['diabetes'] }));
  eq([r.calc.ok, r.calc.coach, r.calc.kcal, r.calc.water_l], [false, true, undefined, undefined], 'flagged: no calorie targets');
  r = await fill(T('maya'), 'C103', { weight: 55, height: 160, birth: 2010, sex: 'F', target: 52 }, Object.assign({}, ZA, { health: ['none'] }));
  eq([r.calc.coach, r.flags], [true, ['minor']], 'under 18: flagged');

  // ---------- 2. lock and test access ----------
  r = await fill(Z, 'C101', ZB, ZA);
  eq([r.calc.kcal, r.calc.p, r.calc.c, r.calc.f, r.calc.water_l], [3120, 200, 360, 97, 3.25], 'sample client: 3,120 kcal (the owner\'s example)');
  eq([r.nut.state, (await nut(Z, 'C101', 'generate')).error], ['coming_soon', 'Your full nutrition plan is coming soon.'], 'locked: coming soon, no plan');
  eq((await call('app_nut_settings', ROMY, { paid_open: true })).error, 'not allowed', 'only the owner opens the paid plan');
  r = await fill(T('majdbouhabib'), 'C104', { weight: 85, height: 180, birth: 1990, sex: 'M', target: 80 }, ZA);
  eq([r.nut.tester, r.nut.state, r.nut.can_start], [true, 'none', true], 'staff email = tester');
  ok((await call('app_nut_cycle', MAJD, { cid: 'C101', act: 'tester_on' })).tester === true, 'owner marks a tester');
  r = await nut(Z, 'C101', 'generate');
  ok(r.ok && r.status === 'Queued', 'tester generates while locked', r);
  eq([r.nut.state, r.nut.cycle.source, r.nut.cycle.start, r.plan.state, r.plan.stage], ['waiting', 'test', null, 'preparing', 'draft'], 'cycle waits for the client\'s approval; week 1 draft being prepared');
  ok(/A new plan comes with your next 3-week cycle/.test((await nut(Z, 'C101', 'generate')).error), 'one plan per cycle');

  // ---------- 3. review loop ----------
  ok(/permission denied/.test(await (async () => { await c.query('begin'); try { await c.query('set local role authenticated'); await c.query('select public.wb_nut_claim(1, false)'); await c.query('rollback'); return 'ran'; } catch (e) { await c.query('rollback'); return e.message; } })()), 'worker functions: service role only');
  let w = await runWorker(mock());
  eq(w, [{ status: 'Draft', passed: true }], 'week 1 draft written and checked: to the client');
  eq(searches, ['Kababji'], 'the unknown restaurant was looked up once with web search');
  eq(await q(`select restaurant, status from public.restaurant_lookups where restaurant_key = 'kababji'`), [{ restaurant: 'Kababji', status: 'not_found' }], 'nothing found: recorded, no dish invented');
  r = await nut(Z, 'C101', 'get');
  const D1 = r.plan;
  eq([D1.state, D1.rounds_left, D1.data.stage, D1.data.weeks.length, D1.data.fixed.map(f => f.options.length)], ['draft', 2, 'draft', 1, [4, 4]], 'client sees the week 1 draft: 4 breakfast and 4 snack options');
  eq(D1.data.social[0].not_found[0].msg.en, 'Menu not found, coach will add it.', 'menu not found shown');
  eq(D1.data.social[0].suggestions.map(s => [s.dish, s.estimate]), [['Spicy Chicken (brown bread)', true]], 'restaurant estimate suggested');
  r = await nut(Z, 'C101', 'draft_feedback', { plan: D1.id, chips: [] });
  eq(r.error, 'Tell us what to change (tap a chip or write it).', 'a change round needs a request');
  r = await nut(Z, 'C101', 'draft_feedback', { plan: D1.id, chips: [{ kind: 'too_much' }, { kind: 'dont_eat', text: 'tuna' }, { kind: 'more_lebanese' }, { kind: 'swap_meal', meal: 'Kafta with rice' }, { kind: 'bogus' }], text: 'Lunch at work must be cold' });
  eq([r.status, r.round, r.plan.state, r.plan.msg.en], ['Queued', 1, 'preparing', 'We are changing week 1 as you asked.'], 'round 1 asked');
  eq(await q(`select kind, text, source from public.nutrition_notes where client_id = app.client_by_legacy('C101') order by text`),
    [{ kind: 'portion', text: 'Too much food', source: 'client chip' }, { kind: 'dislike', text: 'tuna', source: 'client chip' }, { kind: 'request', text: 'More Lebanese dishes', source: 'client chip' }, { kind: 'swap', text: 'Swap: Kafta with rice', source: 'client chip' }, { kind: 'request', text: 'Lunch at work must be cold', source: 'client text' }].sort((a, b) => a.text < b.text ? -1 : 1),
    'chips and free text kept as notes (memory)');
  aiCalls.length = 0;
  const noTuna = () => j => { if (j.fixed) j.fixed[1].options = j.fixed[1].options.map((o, i) => i === 2 ? X.fixed()[1].options[3] : o); };   // the mock AI follows "I don't eat tuna"
  w = await runWorker(mock(noTuna));
  ok(/"text":"Too much food"/.test(aiCalls[0]) && /"text":"Lunch at work must be cold"/.test(aiCalls[0]) && /The client reviewed this WEEK 1 draft/.test(aiCalls[0]), 'revision prompt has the draft and the requests');
  ok(/"dislikes":"mushrooms, tuna"/.test(aiCalls[0]), '"I don\'t eat tuna" added to the dislikes (enforced by the code check)');
  eq(w.map(x => x.status), ['Draft'], 'revised draft back to the client');
  r = await nut(Z, 'C101', 'get');
  eq([r.plan.state, r.plan.rounds_left], ['draft', 1], 'one round left');
  await nut(Z, 'C101', 'draft_feedback', { plan: r.plan.id, chips: [{ kind: 'cheaper' }] });
  eq(await runWorker(mock(noTuna)), [{ status: 'Draft', passed: true }], 'round 2 back to the client');
  r = await nut(Z, 'C101', 'draft_feedback', { plan: r.plan.id, chips: [{ kind: 'simpler' }] });
  ok(/You used your 2 change rounds/.test(r.error), 'revision cap: 2 rounds', r);
  r = await nut(Z, 'C101', 'get');
  eq([r.plan.state, r.plan.rounds_left], ['draft', 0], 'no rounds left: approve or ask the coach');
  // picks (the grocery list follows them)
  r = await nut(Z, 'C101', 'pick', { plan: r.plan.id, slot: 0, option: 1 });
  eq(r.plan.picks, { 0: 1 }, 'usual breakfast = option 2');
  ok((await nut(Z, 'C101', 'pick', { plan: r.plan.id, slot: 0, option: 7 })).error === 'Bad option', 'only existing options');
  // approval: the 21 days start; weeks 2 and 3
  r = await nut(Z, 'C101', 'draft_approve', { plan: r.plan.id });
  eq([r.status, r.nut.state, r.nut.cycle.start, r.nut.cycle.end, r.plan.msg.en], ['Queued', 'active', today, await plus(21), 'We are writing your full 3 weeks in the same style.'], 'approved: the 21 days start now');
  aiCalls.length = 0;
  w = await runWorker(mock());
  eq([w, aiCalls.length], [[{ status: 'Approved', passed: true }], 2], 'weeks 2 and 3 written (one call each), checked, live');
  ok(/Write WEEK 2 in the same style/.test(aiCalls[0]) && /"client_memory":\{/.test(aiCalls[0]) && /Too much food/.test(aiCalls[0]), 'full plan prompt carries this cycle\'s notes');
  r = await nut(Z, 'C101', 'get');
  const F1 = r.plan;
  eq([F1.state, F1.data.stage, F1.data.weeks.length, F1.picks], ['ready', 'final', 3, { 0: 1 }], 'final 3 weeks shown, picks kept');
  eq(await one(`select by_who from public.nutrition_plans where legacy_id = $1`, [F1.id]), 'auto check', 'unflagged: no coach approval');
  // reminders: meals, water, main prep, top-up, weekly weigh-in
  const rem = r.reminders;
  eq([rem.active, rem.delivery], [true, 'pending'], 'reminders on, push delivery pending');
  eq(rem.items.filter(x => x.kind !== 'water').map(x => [x.kind, x.time, x.days]), [['meal', '07:45', 'daily'], ['weigh', '07:00', 'mon'], ['prep', '11:00', 'sun'], ['meal', '12:15', 'daily'], ['meal', '16:30', 'daily'], ['topup', '19:00', 'wed'], ['meal', '21:00', 'daily']].sort((a, b) => (a[1] + a[0] < b[1] + b[0] ? -1 : 1)), 'meals, main prep Sunday, top-up Wednesday 19:00, weigh-in Monday (day after prep) at wake time');
  eq(rem.items.filter(x => x.kind === 'water').map(x => x.time), ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00'], 'water every 2 hours inside wake-bed');
  r = await nut(Z, 'C101', 'reminders', { prefs: { weigh: { day: 'fri', time: '06:30' }, topup: { day: 'thu', time: '20:00' }, quiet: { from: '22:00', to: '06:00' } }, snooze_min: 60 });
  eq(r.reminders.items.filter(x => x.kind === 'weigh' || x.kind === 'topup').map(x => [x.kind, x.days, x.time]), [['weigh', 'fri', '06:30'], ['topup', 'thu', '20:00']], 'weigh-in and top-up times changed by the client');
  ok(r.reminders.paused && r.reminders.snooze_until, 'snoozed');
  // grocery ticks
  const gi = F1.data.weeks[0].grocery.aisles[0].items[0];
  r = await nut(Z, 'C101', 'tick', { plan: F1.id, week: 1, item: 'ld:' + gi.key, on: true });
  eq(r.plan.ticks, { 1: ['ld:' + gi.key] }, 'grocery item ticked (stored per client)');
  eq((await nut(T('nour'), 'C101', 'tick', { plan: F1.id, week: 1, item: 'x', on: true })).error, 'Not your account', 'another client cannot tick');
  // weigh-ins: projection only, shown to the owner
  const before = (await nut(Z, 'C101', 'get')).calc;
  r = await nut(Z, 'C101', 'weigh', { kg: 97.5 });
  ok(r.ok && r.calc.weight === 97.5 && r.calc.projection.text.en !== before.projection.text.en && r.plan.id === F1.id, 'weigh-in moves the projection, same plan', r.calc);
  eq((await call('app_nut_get', MAJD, { cid: 'C101' })).weighins.slice(-1)[0].kg, 97.5, 'owner sees the weigh-ins');
  // the sample for the owner (written before the cycle is ended below)
  const scr = await nut(Z, 'C101', 'get');
  const sampleOut = process.env.WB_SAMPLE_OUT || path.join(__dirname, '.out', 'sample-plan.json');
  fs.mkdirSync(path.dirname(sampleOut), { recursive: true });
  fs.writeFileSync(sampleOut, JSON.stringify({
    note: 'Sample paid plan made by the code path (migrations/0012 + functions/nutrition-worker/plan.ts) with the AI step replaced by a hand-written plan (tests/lib/nut_fixture.cjs) that passes the code checks: week 1 draft, 2 change rounds, approval, weeks 2 and 3. In the mock, weeks 2 and 3 reuse week 1 pairs in a new order; the real AI writes new pairs. Breakfast and snack options = the owner\'s example set for this 3,120 kcal client. Restaurant dishes = library seed (real pages, unchecked estimates). Test client: a Lebanese desk worker.',
    client: { body: ZB, answers: ZA }, plan_id: scr.plan.id, plan_state: scr.plan.state, cycle: scr.nut.cycle, picks: scr.plan.picks, targets: scr.plan.macros,
    calculator_now: scr.calc, weighins: scr.weighins, reminders: scr.reminders, disclaimer: scr.nut.disclaimer, review_notes: (await call('app_nut_notes', MAJD, { cid: 'C101' })).notes, plan: scr.plan.data }, null, 1));

  // ---------- 5. flagged: owner first, then the client loop, owner again ----------
  await call('app_nut_cycle', MAJD, { cid: 'C102', act: 'tester_on' });
  r = await nut(T('rana'), 'C102', 'generate');
  ok(r.ok && r.nut.state === 'waiting', 'flagged: plan queued, cycle waiting', r.nut);
  eq(await runWorker(mock()), [{ status: 'Pending', passed: true }], 'flagged draft goes to the owner first');
  r = await nut(T('rana'), 'C102', 'get');
  eq([r.plan.state, r.plan.data, r.plan.msg.en], ['preparing', undefined, 'Your plan is being prepared by our team.'], 'client sees "being prepared"');
  let L = await call('app_nut_list', MAJD, {});
  const rq = L.plans.find(x => x.cid === 'C102');
  ok(rq && rq.status === 'Pending' && rq.stage === 'draft' && /Health answers: diabetes/.test(rq.reason), 'owner queue: the draft, with the reason', L.plans);
  for (const who of [ROMY, JOE]) { L = await call('app_nut_list', who, {}); eq([L.plans, L.owner_only], [[], true], 'not in other staff queues'); }
  eq((await call('app_nut_decide', ROMY, { cid: 'C102', id: rq.id, act: 'approve' })).error, 'not allowed', 'only the owner approves');
  eq((await call('app_nut_decide', MAJD, { cid: 'C102', id: rq.id, act: 'approve' })).status, 'Draft', 'owner approves the draft: to the client');
  r = await nut(T('rana'), 'C102', 'get');
  eq([r.plan.state, r.nut.state], ['draft', 'waiting'], 'the client reviews it; the cycle still waits');
  await nut(T('rana'), 'C102', 'draft_feedback', { plan: r.plan.id, chips: [{ kind: 'still_hungry' }] });
  eq(await runWorker(mock()), [{ status: 'Pending', passed: true }], 'flagged revision goes back to the owner');
  await call('app_nut_decide', MAJD, { cid: 'C102', id: rq.id, act: 'approve' });
  r = await nut(T('rana'), 'C102', 'draft_approve', { plan: rq.id });
  eq([r.nut.state, r.nut.cycle.start], ['waiting', null], 'client approved; a flagged cycle waits for the owner');
  eq(await runWorker(mock()), [{ status: 'Pending', passed: true }], 'flagged full plan: to the owner');
  await call('app_nut_decide', MAJD, { cid: 'C102', id: rq.id, act: 'approve', note: 'Keep the dates to 2 a day' });
  r = await nut(T('rana'), 'C102', 'get');
  eq([r.plan.state, r.nut.state, r.nut.cycle.start, r.nut.cycle.days_left, r.plan.note], ['ready', 'active', today, 21, 'Keep the dates to 2 a day'], 'the 21 days start at the later approval (the owner\'s)');
  ok(await one(`select count(*)::int from public.outbox where to_staff = 'majd' and body like '%Rana Khoury%'`) >= 2, 'owner told on WhatsApp (outbox)');
  // stop flags (under 18): no AI until the owner sets the numbers
  await call('app_nut_cycle', MAJD, { cid: 'C103', act: 'grant', source: 'test' });
  r = await nut(T('maya'), 'C103', 'generate');
  ok(r.ok && r.status === 'Coach review', 'under 18: waits for the owner, no AI', r);
  eq(await runWorker(mock()), [], 'worker does not touch it');
  const mq = (await call('app_nut_list', MAJD, {})).plans.find(x => x.cid === 'C103');
  ok((await call('app_nut_decide', MAJD, { cid: 'C103', id: mq.id, act: 'regen', kcal: 3120, p: 200, c: 360, f: 97, note: 'small portions at school' })).status === 'Queued', 'owner sets the numbers');
  aiCalls.length = 0;
  eq(await runWorker(mock()), [{ status: 'Pending', passed: true }], 'the draft comes back to the owner');
  ok(/small portions at school/.test(aiCalls[0]), 'owner note in the prompt');

  // ---------- 6. failures, owner edit, restaurants, notes ----------
  await call('app_nut_cycle', MAJD, { cid: 'C105', act: 'grant', source: 'payment', note: 'paid cash at the desk' });
  await fill(T('nour'), 'C105', ZB, ZA);
  r = await nut(T('nour'), 'C105', 'generate');
  eq([r.nut.cycle.source, r.nut.state], ['payment', 'waiting'], 'owner grants a paid cycle by hand (no payment provider yet)');
  aiCalls.length = 0;
  w = await runWorker(mock(() => j => { j.week.combos[0].lunch.items[0].food.en = 'Chicken with cashew sauce'; }), 30);
  eq(w, [{ status: 'Draft', passed: true }], 'cashew is fine without a nuts allergy');
  await call('app_nut_cycle', MAJD, { cid: 'C105', act: 'end' });
  await nut(T('nour'), 'C105', 'intake_save', { answers: { allergy: ['nuts'] } });
  await call('app_nut_cycle', MAJD, { cid: 'C105', act: 'grant' });
  r = await nut(T('nour'), 'C105', 'generate');
  aiCalls.length = 0;
  w = await runWorker(mock(() => j => { j.week.combos[0].lunch.items[0].food.en = 'Chicken with cashew sauce'; }));
  eq([w, aiCalls.length], [[{ status: 'Pending', passed: false }], 2], 'allergen planted twice: not shown, to the owner');
  r = await call('app_nut_get', MAJD, { cid: 'C105' });
  ok(r.plan.checks.passed === false && r.plan.checks.problems.some(x => /cashew/.test(x)) && /code checks after a retry/.test(r.plan.reason) && r.plan.stage === 'draft', 'owner sees the problems', r.plan);
  r = await call('app_nut_decide', MAJD, { cid: 'C105', id: r.plan.id, act: 'fix', plan: { fixed: X.fixed().map(f => ({ ...f, options: f.options.map(o => o.name.en.includes('almond') ? o : o) })), weeks: [X.week(1)], notes: X.notes } });
  eq(r.status, 'Queued', 'owner edit queued for the code check');
  w = await runWorker(null);
  eq(w, [{ status: 'Pending', passed: false }], 'owner edit re-checked without AI: the snack with almonds is caught for a nuts allergy');
  // AI errors: Failed after 3
  await call('app_nut_cycle', MAJD, { cid: 'C106', act: 'grant' });
  await fill(T('karim'), 'C106', ZB, ZA);
  await nut(T('karim'), 'C106', 'generate');
  w = await runWorker(() => Promise.reject(new Error('AI 529: overloaded')), 1);
  eq(w, [{ status: 'Queued' }], 'AI error: tried again later');
  await q(`update public.nutrition_plans set lease_until = null`);
  w = await runWorker(() => Promise.reject(new Error('AI 529: overloaded')), 5);
  eq(w, [{ status: 'Queued' }, { status: 'Failed' }], 'third AI error: Failed, to the owner');
  await q(`insert into public.nutrition_plans (legacy_id, client_id, status, macros) values ('NP-0900', app.client_by_legacy('C106'), 'Queued', '{"kcal":2000}')`);
  eq(await runWorker(mock()), [], 'old Apps Script plans left alone');
  // restaurant library (owner)
  eq(await one(`select app.rest_key('Zaatar w Zeit')`), P.restKey('Zaatar w Zeit'), 'restaurant key same in SQL and TS');
  r = await call('app_nut_rest_list', MAJD, { unchecked: true });
  eq([r.dishes.map(d => d.dish), r.not_found], [['All-Fit mushroom burger', 'Mushroom BBQ burger', 'Spicy Chicken (brown bread)'], ['Kababji']], 'owner review list: unchecked seed dishes, menus not found');
  ok(r.dishes.every(d => /^https:\/\//.test(d.source_url)), 'every seed dish has its source');
  eq((await call('app_nut_rest_list', ROMY, {})).error, 'not allowed', 'library: owner only');
  r = await call('app_nut_rest_save', MAJD, { restaurant: 'Kababji', dish: 'Shish taouk plate', kcal: 650, p: 52, c: 45, f: 28, source_url: 'https://example.org/kababji', checked: true });
  ok(r.id, 'owner adds a dish', r);
  eq((await svc(`select public.wb_nut_rest_found('Barbar', '[{"dish":"Taouk sandwich","kcal":520,"p":30,"c":50,"f":20,"source_url":"https://example.org/barbar"},{"dish":"No source","kcal":400}]'::jsonb)`)).found, 1, 'web search result: only dishes with a source saved');
  eq((await call('app_nut_list', MAJD, {})).rest_to_check, 4, 'owner queue counts dishes to check');
  // client notes (memory): the owner sees and edits them
  r = await call('app_nut_notes', MAJD, { cid: 'C101' });
  ok(r.notes.length === 6 && r.notes.some(n => n.text === 'Cheaper ingredients'), 'owner sees the client\'s notes', r.notes);
  const tunaNote = r.notes.find(n => n.text === 'tuna');
  r = await call('app_nut_note_save', MAJD, { cid: 'C101', kind: 'liked', text: 'Loves salmon with sweet potato' });
  ok(r.notes.some(n => n.source === 'owner' && n.kind === 'liked'), 'owner adds a note');
  r = await call('app_nut_note_save', MAJD, { cid: 'C101', id: r.notes.find(n => n.text === 'Too much food').id, kind: 'portion', text: 'Too much food at dinner', active: true });
  ok(r.notes.some(n => n.text === 'Too much food at dinner'), 'owner edits a note');
  eq((await call('app_nut_notes', JOE, { cid: 'C101' })).error, 'not allowed', 'notes: owner only');

  // ---------- 7. cycle end, renewal ----------
  const zid = await one(`select id from public.clients where legacy_id = 'C101'`);
  await q(`insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'ziad@x.com')`);
  await q(`insert into public.profiles (user_id, email, role) values ('11111111-1111-4111-8111-111111111111', 'ziad@x.com', 'client')`);
  const asZiad = async sql => { await c.query('begin'); try { await c.query(`set local role authenticated`); await c.query(`select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true)`); const x = await c.query(sql); await c.query('rollback'); return x.rows; } catch (e) { await c.query('rollback'); return { error: e.message }; } };
  eq((await asZiad(`select legacy_id from public.nutrition_plans`)).length, 1, 'RLS: the client reads their plan while the cycle runs');
  const tl = await asZiad(`select client_id from public.nutrition_testers`); ok(tl.error || tl.length === 0, 'RLS: testers are owner only', tl);
  await q(`update public.nutrition_cycles set starts_on = starts_on - 21, ends_on = ends_on - 21 where client_id = $1`, [zid]);
  r = await nut(Z, 'C101', 'get');
  eq([r.nut.state, r.plan.state, r.plan.data, r.reminders.active, r.reminders.items, r.calc.ok], ['ended', 'locked', undefined, false, [], true], 'cycle over: plan locked, reminders stop, free calculator stays');
  eq((await nut(Z, 'C101', 'tick', { plan: F1.id, week: 1, item: 'x', on: true })).error, 'This grocery list is closed.', 'ticks closed');
  eq((await asZiad(`select legacy_id from public.nutrition_plans`)).length, 0, 'RLS: the plan is closed after the cycle');
  // renewal: latest weigh-in, the client's notes from the last cycle in the prompt
  await nut(Z, 'C101', 'weigh', { kg: 98.4 });
  r = await nut(Z, 'C101', 'generate');
  ok(r.ok && r.nut.state === 'waiting', 'renewal: a new test cycle', r);
  const m2 = await one(`select macros from public.nutrition_plans where client_id = $1 and status = 'Queued'`, [zid]);
  const exp = await one(`select app.nut_numbers($1::jsonb, app_today())`, [JSON.stringify({ weight: 98.4, height: 190, age: 30, sex: 'M', target: 100, ans: ZA })]);
  eq([m2.weight, m2.kcal, m2.p], [98.4, exp.kcal, exp.p], 'renewal numbers from the LATEST weigh-in (98.4 kg), not the starting 96');
  aiCalls.length = 0;
  eq(await runWorker(mock(noTuna)), [{ status: 'Draft', passed: true }], 'renewal draft to the client');
  ok(/"client_memory":\{[^}]*"does_not_eat":\["tuna"\]/.test(aiCalls[0]) && /"portion_feedback":\[[^\]]*"Too much food at dinner"/.test(aiCalls[0]) && /"liked":\["Loves salmon with sweet potato"\]/.test(aiCalls[0]) && /"asked_for":\[[^\]]*"Cheaper ingredients"/.test(aiCalls[0]), 'renewal prompt: last cycle\'s notes (memory)', aiCalls[0] && aiCalls[0].slice(aiCalls[0].indexOf('client_memory'), aiCalls[0].indexOf('client_memory') + 400));
  // the lock opens
  eq((await call('app_nut_settings', MAJD, { paid_open: true })).settings.paid_open, true, 'owner opens the paid plan');
  r = await nut(T('gina'), 'G0101', 'get');
  eq([r.nut.state, r.nut.can_start], ['none', false], 'open: no cycle yet (payment comes later)');
  ok(/starts with/.test((await nut(T('gina'), 'G0101', 'generate')).error), 'open but no cycle: ask the desk');
  await call('app_nut_settings', MAJD, { paid_open: false });

  // ---------- the database ----------
  eq(await one(`select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity`), 0, 'every table has RLS');
  eq(await q(`select action from app.api_actions where action like '%nut%' order by 1`).then(x => x.map(y => y.action)), ['app_cl_nut', 'app_nut_cycle', 'app_nut_decide', 'app_nut_get', 'app_nut_list', 'app_nut_note_delete', 'app_nut_note_save', 'app_nut_notes', 'app_nut_rest_delete', 'app_nut_rest_list', 'app_nut_rest_save', 'app_nut_settings'], 'API actions registered');
  eq(await one(`select value from public.settings where key = 'backend'`), { use: 'apps' }, 'backend setting untouched');

  await c.end();
  console.log(`\nnutrition: ${pass} checks passed, ${fail} failed` + (fail ? '' : `\nsample plan: ${sampleOut}`));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
