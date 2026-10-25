#!/usr/bin/env node
// =====================================================================
// WELLBE features (migrations/0006_features.sql): Apps Script vs Postgres, same fixture, same calls.
// Every call is made on both sides (Apps Script in memory sheets / Postgres through public.wb_call) and the
// answers are compared field by field; at the end the sheets are imported again and the tables compared.
// Areas: workouts, nutrition (calculator numbers), landing page, guests, game screen, streak, promise,
// profile, session editor. Run: node run_features.js   (local Postgres 16 on PGHOST/PGPORT, see README)
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js'), FD = require('./lib/feat_db.js'), BF = require('./lib/boot_fixture.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbf-'));

let pass = 0, fail = 0; const fails = [];
const J = x => JSON.stringify(x);
function ok(c, msg, extra) { if (c) pass++; else { fail++; fails.push(msg); console.log('   FAIL ' + msg + (extra ? '\n         ' + String(extra).slice(0, 2500) : '')); } }
const fl = x => typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : Array.isArray(x) ? x.map(fl) : x && typeof x === 'object' ? Object.keys(x).reduce((o, k) => (o[k] = fl(x[k]), o), {}) : x;
function diff(a, b, p0) {
  const out = [];
  (function walk(x, y, p) {
    if (out.length > 10 || J(x) === J(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) out.push(`${p}: ${x.length} vs ${y.length} rows\n           gs:  ${J(x).slice(0, 800)}\n           sql: ${J(y).slice(0, 800)}`); else x.forEach((v, i) => walk(v, y[i], p + '[' + i + ']')); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { new Set(Object.keys(x).concat(Object.keys(y))).forEach(k => walk(x[k], y[k], p + '.' + k)); return; }
    out.push(`${p}: gs ${J(x)} vs sql ${J(y)}`);
  })(fl(a), fl(b), p0 || '');
  return out;
}
// intentional differences: ok (transport), leadId (random part), row (sheet row -> gone), ref (sheet row -> legacy ID)
function norm(x) {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') {
    const o = {};
    Object.keys(x).forEach(k => {
      if (k === 'ok' || k === 'row' || x[k] === undefined) return;
      o[k] = k === 'leadId' ? String(x[k]).replace(/-[0-9A-F]{8}$/, '-X') : norm(x[k]);
    });
    return o;
  }
  return x;
}
const errOf = r => r && r.ok === false ? String(r.error || '').replace(/^ERROR:\s*/, '') : null;
function cmp(name, g, s) {
  const ge = errOf(g), se = errOf(s);
  if (ge || se) { ok(ge === se, name + ' (error)', 'gs: ' + ge + '\n         sql: ' + se); return; }
  const d = diff(norm(g), norm(s)); ok(d.length === 0, name, d.join('\n         '));
}

(async () => {
  // ---------- one fixture, then the same sheets into Postgres ----------
  F.build(); BF.extend();
  const ops = M.books[CFG.OPS_ID], T = n => F.today(n);
  M.cache = {}; CFG_MEMO_ = null;
  FD.buildTemplate();
  const load = async (db, extra) => {
    const dir = path.join(TMP, db + Date.now()); exportBooks(M.books, dir);
    const { sql } = I.run(dir, GS);
    await FD.freshDb(db);
    return D.withDb(db, async c => { await c.query(['begin;'].concat(sql, extra || [], ['commit;']).join('\n')); });
  };
  await load('feat_sql');
  await D.withDb('feat_sql', async c => {
    const sqlCall = await FD.doors(c, ['alice@x.com', 'bea@x.com', 'gia@x.com', 'gus@x.com', 'dina@x.com']);
    const fresh = () => { CFG_MEMO_ = null; M.cache = {}; };
    // the same call on both sides; returns both answers
    const both = async (name, who, action, body, gsCall) => {
      fresh();
      const keys = { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe', mikel: 'k-mikel' };
      let g;
      try { g = gsCall ? gsCall() : (keys[who] ? F.st(action, keys[who], JSON.parse(J(body || {}))) : F.cl(action, who, JSON.parse(J(body || {})))); }
      catch (e) { g = { ok: false, error: String(e.message || e) }; }
      const s = await sqlCall(who, action, body || {});
      cmp(name, g, s);
      return { g, s };
    };

    // ===================== WORKOUTS =====================
    console.log('workouts');
    const prog = { start: T(-10), goal: 'Strong knees\nno pain', phases: [
      { name: 'Base', len: 2, unit: 'w', note: 'Easy start', workouts: [
        { name: 'A', warm: [{ ex: 'Bike', reps: '5 min' }, { ex: '' }], main: [{ type: 'superset', rounds: 3, rest: '60s', moves: [{ ex: 'Goblet squat', sets: 3, reps: '10' }, { ex: 'Push up', sets: '3', reps: '8' }, { ex: 'Row' }, { ex: 'cut' }] },
          { type: 'weird', moves: [{ ex: 'Plank', sets: 2 }, { ex: 'no' }] }], abs: [{ ex: 'Dead bug', sets: 2, reps: 10 }], stretch: [{ ex: 'Cobra', det: '30 s' }] },
        { name: '', main: [{ moves: [{ ex: 'Deadlift', sets: 4, reps: 5 }] }] }, { name: 'C' }] },
      { name: 'Build', len: 1.6, unit: 'm', workouts: [{ name: 'D' }] }, { len: 'x', unit: 'q' }] };
    await both('wo_save: clean program (trainer)', 'joe', 'app_wo_save', { cid: 'C001', ver: 0, prog });
    await both('wo_save: old version refused', 'joe', 'app_wo_save', { cid: 'C001', ver: 0, prog });
    await both('wo_save: no start date', 'joe', 'app_wo_save', { cid: 'C001', ver: 1, prog: { phases: [] } });
    await both('wo_save: no phase', 'joe', 'app_wo_save', { cid: 'C001', ver: 1, prog: { start: T(0), phases: [{ name: 'x' }].slice(1) } });
    await both('wo_save: not one of yours (Mikel)', 'mikel', 'app_wo_save', { cid: 'C001', ver: 1, prog });
    await both('wo_save: client missing', 'romy', 'app_wo_save', { cid: 'G0001', ver: 0, prog });
    const w1 = await both('wo_get: plan, missed workout, question', 'joe', 'app_wo_get', { cid: 'C001' });
    ok(w1.s.asks && w1.s.asks.length === 1 && w1.s.items.some(x => x.state === 'missed'), 'the miss and its question are there', J(w1.s.items));
    await both('wo_get: copy', 'joe', 'app_wo_get', { cid: 'C001', copy: 1 });
    await both('wo_get: trainer who never trained them', 'mikel', 'app_wo_get', { cid: 'C001' });
    await both('wo_get: client without program (owner)', 'majd', 'app_wo_get', { cid: 'C050' });
    await both('wo_list (Joe)', 'joe', 'app_wo_list', {});
    await both('wo_decide: catch up', 'joe', 'app_wo_decide', { cid: 'C001', sid: 'S12-0002', choice: 'catch', missed: 'A' });
    await both('wo_decide: session missing', 'joe', 'app_wo_decide', { cid: 'C001', choice: 'keep' });
    await both('wo_list full (owner)', 'majd', 'app_wo_list', { full: 1 });
    await both('wo_list (Mikel)', 'mikel', 'app_wo_list', {});
    await both('wo_log: staff log', 'romy', 'app_wo_log', { cid: 'C001', sid: 'S12-0003', date: T(-4), wname: 'A', name: 'Alice Aoun',
      entries: [{ ex: 'Goblet squat', sets: [{ kg: 20, reps: 10 }, { kg: 22.37, reps: 8.4 }, { kg: 0, reps: 0 }] }, { ex: '', sets: [] }, { ex: 'Push up', sets: [{ kg: 0, reps: 12 }] }] });
    await both('wo_log: nothing to save', 'romy', 'app_wo_log', { cid: 'C001', sid: 'S12-0003', date: T(-4), entries: [{ ex: ' ' }] });
    await both('wo_log: date missing', 'romy', 'app_wo_log', { cid: 'C001', sid: 'S12-0003', entries: [] });
    await both('wo_ex: new exercise', 'joe', 'app_wo_ex', { group: 'Chest', name: 'Svend press' });
    await both('wo_ex: same name again', 'joe', 'app_wo_ex', { group: 'Chest', name: 'svend PRESS' });
    await both('wo_ex: new group', 'joe', 'app_wo_ex', { group: 'Mobility', name: 'Ankle rocks' });
    await both('cl_wo: body', 'alice@x.com', 'app_cl_wo', { cid: 'C001', op: 'body', weight: 64.5, height: 168, birth: 1991, sex: 'F' });
    await both('cl_wo: bad weight', 'alice@x.com', 'app_cl_wo', { cid: 'C001', op: 'body', weight: 20 });
    await both('cl_wo: get', 'alice@x.com', 'app_cl_wo', { cid: 'C001' });
    await both('cl_wo: log today', 'alice@x.com', 'app_cl_wo', { cid: 'C001', op: 'log', sid: 'S12-0002', entries: [{ ex: 'Deadlift', sets: [{ kg: 60, reps: 5 }, { kg: 62.5, reps: 5 }] }] });
    await both('cl_wo: log a future session', 'alice@x.com', 'app_cl_wo', { cid: 'C001', op: 'log', sid: 'S12-0001', entries: [{ ex: 'x', sets: [{ kg: 1, reps: 1 }] }] });
    await both('cl_wo: log not in program', 'alice@x.com', 'app_cl_wo', { cid: 'C001', op: 'log', sid: 'S13-0001', entries: [] });
    await both('cl_wo: another client', 'bea@x.com', 'app_cl_wo', { cid: 'C002' });
    await both('cl_wo: not your account', 'bea@x.com', 'app_cl_wo', { cid: 'C001' });
    const w2 = await both('wo_get after logs and the decision', 'joe', 'app_wo_get', { cid: 'C001' });
    ok(w2.s.items.some(x => x.catchUp) && Object.keys(w2.s.logs).length >= 3 && w2.s.bmr && w2.s.bmr.bmr > 0, 'catch up, logs and BMR are there', J(w2.s).slice(0, 600));
    await both('wo_save: second version', 'joe', 'app_wo_save', { cid: 'C001', ver: 1, prog: Object.assign({}, prog, { start: T(-40) }) });
    await both('cl_wo: get (phase over)', 'alice@x.com', 'app_cl_wo', { cid: 'C001' });

    // ===================== NUTRITION =====================
    console.log('nutrition');
    await both('cl_nut: intake_get (empty)', 'alice@x.com', 'app_cl_nut', { cid: 'C001' });
    await both('cl_nut: done too early', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'intake_save', step: 2, done: 1, answers: { goal: 'lose', job: 'desk' } });
    const ans = { goal: 'lose', why: 'Wedding\nin June', pace: 'fast', event: '=June', job: 'mixed', train_days: '3', train_time: 'am', wake: '06:30', sleep: '6', meals: '3s', breakfast: 'yes',
      cook: 'me', cook_time: '30', out: '2', budget: 'mid', now_day: 'Manakish, rice', often: ['bread', 'sweets', 'nope', 'none'], love: ['tabbouleh'], dislike: 'liver',
      allergy: ['none'], rules: [], digest: ['ok'], coffee: '2', sugar_drinks: 1, health: ['none', 'thyroid'], unknown: 'x' };
    await both('cl_nut: intake_save done', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'intake_save', step: 9, done: true, answers: ans });
    await both('cl_nut: body + target + comp', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'body', weight: 70, height: 168, birth: 1990, sex: 'F', target: 62, comp: { bf: 31.26, smm: 99, visceral: '7', date: 'x' } });
    await both('cl_nut: bad target', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'body', target: 20 });
    const n1 = await both('cl_nut: calc', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'calc' });
    ok(n1.s.calc.ok && n1.s.calc.kcal > 1000 && n1.s.calc.projection.text.en.length > 50, 'calculator answered with numbers', J(n1.s.calc));
    await both('cl_nut: generate', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'generate' });
    await both('cl_nut: generate again (open plan)', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'generate' });
    await both('cl_nut: weigh in', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'weigh', kg: 69.4 });
    await both('cl_nut: bad weigh in', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'weigh', kg: 400 });
    await both('nut_list (Romy)', 'romy', 'app_nut_list', {});
    await both('nut_list all (Joe)', 'joe', 'app_nut_list', { all: 1 });
    await both('nut_list (Mikel: none of his)', 'mikel', 'app_nut_list', { all: 1 });
    await both('nut_get', 'romy', 'app_nut_get', { cid: 'C001' });
    await both('nut_decide: approve a queued plan', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0001', act: 'approve' });
    // the worker wrote the meals: same plan on both sides, waiting for a coach
    const meals = { days: [{ name: { en: 'A' }, meals: [] }], notes: { en: [], ar: [] } };
    nutSetPlan_(ops, nutPlans_(ops, 'C001').filter(p => p.id === 'NP-0001')[0], { plan: meals, status: 'Pending' });
    await c.query(`update public.nutrition_plans set plan = $1::jsonb, status = 'Pending' where legacy_id = 'NP-0001'`, [J(meals)]);
    await both('nut_decide: note', 'joe', 'app_nut_decide', { cid: 'C001', id: 'NP-0001', act: 'note', note: 'Check carbs' });
    await both('nut_decide: approve', 'joe', 'app_nut_decide', { cid: 'C001', id: 'NP-0001', act: 'approve' });
    await both('cl_nut: get (approved plan with meals)', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'get' });
    const n2 = await both('cl_nut: weigh in far from the plan (auto replan)', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'weigh', kg: 66 });
    ok(/^NP-\d{4}$/.test(n2.s.replan || ''), 'auto replan made a plan', J(n2.s.replan));
    await both('cl_nut: new target (auto replan)', 'alice@x.com', 'app_cl_nut', { cid: 'C001', op: 'body', target: 60 });
    await both('nut_decide: regen with coach numbers', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0003', act: 'regen', kcal: 1650.4, p: 130, note: 'More protein' });
    await both('nut_decide: regen too low', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0004', act: 'regen', kcal: 800 });
    await both('nut_decide: decline', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0004', act: 'decline', note: 'Talk first' });
    await both('nut_decide: unknown act', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0004', act: 'x' });
    await both('nut_decide: not found', 'romy', 'app_nut_decide', { cid: 'C001', id: 'NP-0099', act: 'note' });
    await both('nut_decide: trainer, not his client', 'mikel', 'app_nut_decide', { cid: 'C001', id: 'NP-0004', act: 'note' });
    // health answers that need a coach (Bea: pregnant), a guest (free calculator only), a man with body fat (Katch-McArdle), a gain goal, a low target
    await both('cl_nut: Bea intake (pregnant)', 'bea@x.com', 'app_cl_nut', { cid: 'C002', op: 'intake_save', step: 7, done: 1, answers: Object.assign({}, ans, { health: ['pregnant', 'diabetes'] }) });
    await both('cl_nut: Bea body', 'bea@x.com', 'app_cl_nut', { cid: 'C002', op: 'body', weight: 60, height: 160, birth: 1995, sex: 'F' });
    await both('cl_nut: Bea generate (coach review)', 'bea@x.com', 'app_cl_nut', { cid: 'C002', op: 'generate' });
    await both('cl_nut: guest calculator', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'body', weight: 92, height: 181, birth: 1984, sex: 'M', target: 80, comp: { bf: 27 } });
    await both('cl_nut: guest answers (gain, 5 days)', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'intake_save', answers: { goal: 'gain', job: 'active', train_days: '5', pace: 'slow' } });
    await both('cl_nut: guest target up (gain)', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'body', target: 96 });
    await both('cl_nut: guest generate (not paid)', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'generate' });
    await both('cl_nut: guest target too low', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'body', target: 55 });
    await both('cl_nut: guest keep weight', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'body', target: 92.3 });
    await both('cl_nut: upload without file', 'gia@x.com', 'app_cl_nut', { cid: 'G0002', op: 'upload' });
    // the calculator alone, on many profiles (numbers compared exactly)
    const profs = [];
    for (const w of [48, 55, 61.5, 70, 77.7, 83.2, 95, 101, 120]) for (const h of [152, 168, 185]) for (const sex of ['F', 'M']) for (const tg of [0, w - 12, w + 6, 50]) for (const pace of ['slow', 'fast'])
      profs.push({ weight: w, height: h, age: 19 + (profs.length % 50), sex, target: tg, pace, bf: profs.length % 3 ? 0 : 12 + (profs.length % 40), ans: { job: ['desk', 'mixed', 'active', ''][profs.length % 4], train_days: String(profs.length % 7) } });
    const today = T(0);
    const sqlCalc = (await c.query(`select coalesce(jsonb_agg(app.nut_calc(x, $2::date) order by i), '[]') as r from jsonb_array_elements($1::jsonb) with ordinality t(x, i)`, [J(profs), today])).rows[0].r;
    let calcBad = []; profs.forEach((p, i) => { const d = diff(nutCalc_(p, today), sqlCalc[i]); if (d.length) calcBad.push(J(p) + '\n           ' + d.join('\n           ')); });
    ok(calcBad.length === 0, `nutrition calculator: ${profs.length} profiles, every number and text the same`, calcBad.slice(0, 3).join('\n         '));

    // ===================== LANDING PAGE =====================
    console.log('landing page');
    await both('slots', 'anon', 'slots', {}, () => getSlots_());
    const lead = (b) => () => F.post(Object.assign({ action: 'lead' }, b));
    const L1 = { name: 'Nour N', phone: '+961 3 123 456', email: 'Nour@X.com', source: 'ig?by=C001', trained: 'yes' };
    const l1 = await both('lead: new', 'anon', 'lead', L1, lead(L1));
    await both('lead: same phone + email = same lead', 'anon', 'lead', L1, lead(L1));
    await both('lead: same phone, other email = new lead', 'anon', 'lead', Object.assign({}, L1, { email: 'other@x.com' }), lead(Object.assign({}, L1, { email: 'other@x.com' })));
    await both('lead: bad phone', 'anon', 'lead', { name: 'X', phone: '12' }, lead({ name: 'X', phone: '12' }));
    await both('lead: bad email', 'anon', 'lead', { name: 'X', phone: '03123456', email: 'a@b' }, lead({ name: 'X', phone: '03123456', email: 'a@b' }));
    const A = { trained: 'Gym 2 years', stopped: 'Kids', why: 'Health', injuries: 'none' };
    await both('answers', 'anon', 'answers', Object.assign({ leadId: l1.s.leadId }, A), () => F.post(Object.assign({ action: 'answers', leadId: l1.g.leadId }, A)));
    await both('answers: unknown lead', 'anon', 'answers', { leadId: 'W40-x' }, () => F.post({ action: 'answers', leadId: 'W40-x' }));
    const sl = getSlots_(), day = sl.days.find(d => d.slots.some(x => x.type === 'instant')), inst = day && day.slots.find(x => x.type === 'instant');
    const full = sl.days.map(d => ({ d, x: d.slots.find(x => x.type === 'full') })).find(x => x.x);
    ok(!!inst, 'fixture has an instant slot');
    if (inst) {
      await both('book: instant slot', 'anon', 'book', { leadId: l1.s.leadId, date: day.date, hour: String(inst.hour) }, () => F.post({ action: 'book', leadId: l1.g.leadId, date: day.date, hour: String(inst.hour) }));
      const ab = await both('book: already booked', 'anon', 'book', { leadId: l1.s.leadId, date: day.date, hour: inst.hour }, () => F.post({ action: 'book', leadId: l1.g.leadId, date: day.date, hour: inst.hour }));
      ok(ab.g.already === true && ab.s.already === true, 'book: {already:true} flag next to the error on both (0008 wb_call passes the detail)', J(ab));
      await both('lead: again after booking (booked)', 'anon', 'lead', L1, lead(L1));
      await both('slots after the booking', 'anon', 'slots', {}, () => getSlots_());
    }
    const L2 = { name: 'Rita R', phone: '70999888' }, l2 = await both('lead: second', 'anon', 'lead', L2, lead(L2));
    if (full) { const fb = await both('book: full hour', 'anon', 'book', { leadId: l2.s.leadId, date: full.d.date, hour: full.x.hour }, () => F.post({ action: 'book', leadId: l2.g.leadId, date: full.d.date, hour: full.x.hour }));
      ok(fb.g.full === true && fb.s.full === true, 'book: {full:true} flag on both', J(fb)); }
    await both('book: closed hour', 'anon', 'book', { leadId: l2.s.leadId, date: T(0), hour: 3 }, () => F.post({ action: 'book', leadId: l2.g.leadId, date: T(0), hour: 3 }));
    await both('book: unknown lead', 'anon', 'book', { leadId: 'nope', date: T(1), hour: 8 }, () => F.post({ action: 'book', leadId: 'nope', date: T(1), hour: 8 }));
    const fu = await c.query(`select app.lead_followups_json() as x`);
    fresh(); const gfu = appLeadFollowups_(ops).map(x => Object.assign({}, x, { row: undefined }));
    { const d = diff(norm(gfu.map(x => Object.assign({}, x, { id: x.id.replace(/-[0-9A-F]{8}$/, '-X') }))), norm(fu.rows[0].x.map(x => Object.assign({}, x, { id: x.id.replace(/-[0-9A-F]{8}$/, '-X') })))); ok(d.length === 0, 'lead follow ups (15 min / 24 h / 72 h, quiet hours)', d.join('\n         ')); }

    // ===================== GUESTS =====================
    console.log('guests');
    await both('guest: no phone', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'call', phone: '12' });
    await both('guest: call request (makes the lead)', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'call', phone: '03 444 555', note: 'Lose 5 kg' });
    await both('guest: call again today', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'call' });
    await both('guest: package request', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'pkg', pkg: '1:3 - 8x/month ($140pp)' });
    await both('guest: unknown package', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'pkg', pkg: 'Gold' });
    if (inst) await both('guest: trial', 'gia@x.com', 'app_cl_guest', { cid: 'G0002', op: 'trial', date: day.date, hour: inst.hour });
    await both('guest: trial already booked (Gus)', 'gus@x.com', 'app_cl_guest', { cid: 'G0001', op: 'trial', date: T(1), hour: 8 });
    await both('guest: unknown op', 'gus@x.com', 'app_cl_guest', { cid: 'G0001', op: 'x' });

    // ===================== GAME =====================
    console.log('game');
    await both('run: get (first time)', 'alice@x.com', 'app_cl_run', { cid: 'C001' });
    await both('run: buy life without coins', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'buy', item: 'life' });
    await both('run: buy unknown', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'buy', item: 'cape' });
    await both('run: shop not in shop', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'shop', item: 'cape' });
    await both('run: redeem too little', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'redeem' });
    await both('run: get hidden from boards', 'alice@x.com', 'app_cl_run', { cid: 'C001', lbHide: true });
    // coins and credit on both sides, then a run, buys and a redeem
    const rr = ops.getSheetByName('CORNICHE RUN'), ri = rr.d.findIndex(r => r[0] === 'C001'); rr.d[ri][4] = 9000; rr.d[ri][17] = 450;
    await c.query(`update public.game_players set coins = 9000, credit_cents = 450 where client_id = app.client_by_legacy('C001')`);
    M.cache = {};
    await both('run: save a run', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'save', lbHide: false, run: { secs: 120, m: 1300, coins: 160, score: 6200, spent: 0, ev: { jumps: 50, slides: 10, roof: 120, powers: 3, clean: 700, mult: 3, letters: 2 } } });
    await both('run: buy magnet', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'buy', item: 'magnet' });
    await both('run: buy life', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'buy', item: 'life' });
    await both('run: shop magnet (level 2 needed? coins)', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'shop', item: 'magnet' });
    await both('run: shop jetpack', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'shop', item: 'jet' });
    await both('run: redeem', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'redeem' });
    await both('run: redeem again (one waiting)', 'alice@x.com', 'app_cl_run', { cid: 'C001', op: 'redeem' });
    await both('run: guest get', 'gia@x.com', 'app_cl_run', { cid: 'G0002' });

    // ===================== STREAK, PROMISE, PROFILE =====================
    console.log('streak, promise, profile');
    await both('streak: read', 'alice@x.com', 'app_cl_streak', { cid: 'C001' });
    await both('streak: tick 3 keys', 'alice@x.com', 'app_cl_streak', { cid: 'C001', keys: [1, true, 'y'] });
    await both('streak: untick one', 'alice@x.com', 'app_cl_streak', { cid: 'C001', keys: [true, 0, true] });
    // 30 days in a row already done -> the reward package
    const sk = ops.getSheetByName('CLIENT STREAKS') || ops.add('CLIENT STREAKS', [STREAK.HEAD.slice()]);
    const days = []; for (let i = 1; i <= 30; i++) days.push(T(-i));
    const si = sk.d.findIndex(r => r[0] === 'C050'); if (si > -1) sk.d.splice(si, 1);
    sk.d.push(['C050', 'Dina Daher', days.join(','), '', '', '', '', 0]);
    await c.query(`insert into public.streaks (client_id, done_days) values (app.client_by_legacy('C050'), $1::date[]) on conflict (client_id) do update set done_days = excluded.done_days`, ['{' + days.join(',') + '}']);
    await both('streak: 30 days -> free session', 'dina@x.com', 'app_cl_streak', { cid: 'C050' });
    await both('goal: too short', 'alice@x.com', 'app_cl_goal', { cid: 'C001', promise: 'ab' });
    await both('goal: back pain template', 'alice@x.com', 'app_cl_goal', { cid: 'C001', promise: '  I want my back\npain gone ' });
    await both('goal: guest', 'gia@x.com', 'app_cl_goal', { cid: 'G0002', promise: 'Run a marathon' });
    await both('profile: photo', 'alice@x.com', 'app_cl_profile', { cid: 'C001', op: 'photo', photo: 'data:image/png;base64,QUJDRA==' });
    await both('profile: not a photo', 'alice@x.com', 'app_cl_profile', { cid: 'C001', op: 'photo', photo: 'http://x' });
    await both('profile: rate 2 (desk told)', 'alice@x.com', 'app_cl_profile', { cid: 'C001', op: 'rate', stars: 2.4, note: 'Slow\napp' });
    await both('profile: rate 9 -> 5', 'bea@x.com', 'app_cl_profile', { cid: 'C002', op: 'rate', stars: 9 });
    await both('profile: unknown op', 'bea@x.com', 'app_cl_profile', { cid: 'C002', op: 'x' });

    // ===================== SESSION EDITOR =====================
    console.log('session editor');
    const refOf = id => { for (const k of Object.keys(AT)) { const sh = ops.getSheetByName(AT[k].sheet); const r = sh ? sh.d.findIndex(x => x[0] === id) + 1 : 0; if (r) return k + '|' + r; } };
    const sess = (name, who, action, id, extra) => both(name, who, action, Object.assign({ ref: id.slice(0, 3) + '|' + id, id }, extra),
      () => F.st(action, { majd: 'k-majd', romy: 'k-romy', joe: 'k-joe' }[who], Object.assign({ ref: refOf(id), id }, extra)));
    await sess('sess_edit: room', 'romy', 'app_sess_edit', 'S13-0001', { room: 'Physio Room' });
    await sess('sess_edit: unknown room', 'romy', 'app_sess_edit', 'S13-0001', { room: 'Kitchen' });
    await sess('sess_edit: payment on a 1:3', 'romy', 'app_sess_edit', 'S13-0001', { pay: 'Cash' });
    await sess('sess_edit: physio payment', 'majd', 'app_sess_edit', 'SPP-0002', { pay: 'Insurance' });
    await sess('sess_edit: unknown payment', 'majd', 'app_sess_edit', 'SPP-0002', { pay: 'Gold' });
    await sess('sess_edit: trainer not allowed', 'joe', 'app_sess_edit', 'SPP-0002', { room: 'Physio Room' });
    await sess('sess_remove: one client out', 'romy', 'app_sess_remove', 'S13-0001', { slot: 1 });
    await sess('sess_remove: empty spot', 'romy', 'app_sess_remove', 'S13-0001', { slot: 2 });
    await sess('sess_remove: last client out = cancelled', 'romy', 'app_sess_remove', 'S11-0002', { slot: 0 });
    await both('notify', 'romy', 'app_notify', { cids: ['c001', 'C002', 'C001', 'X9', 'G0002'], type: 'Room change', text: ' Your session moved to the physio room ' });
    await both('notify: no text', 'romy', 'app_notify', { cids: ['C001'], text: ' ' });
    await both('notify: nobody', 'romy', 'app_notify', { cids: ['X'], text: 'Hi' });

    // ===================== END STATE: the sheets imported again vs the database =====================
    console.log('end state');
    fresh();
    await load('feat_gs');
    const sGs = await D.withDb('feat_gs', FD.snapshot), sSql = await FD.snapshot(c);
    Object.keys(sSql).forEach(k => { const d = diff(sGs[k], sSql[k], k); ok(d.length === 0, 'end state · ' + k, d.join('\n         ')); });
    ok(calcBad.length === 0 && profs.length > 400, 'calculator profiles checked: ' + profs.length);
    const ob = await c.query(`select channel, to_staff, split_part(body, E'\\n', 1) as first from public.outbox where body ~ '^(NEW W40|W40 TRIAL|APP:)' order by id`);
    ok(ob.rows.length >= 5, 'landing page and guest alerts queued in the outbox (' + ob.rows.length + ')', J(ob.rows));
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map(f => ' - ' + f).join('\n')); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exit(1); });
