#!/usr/bin/env node
// =====================================================================
// WELLBE import: the test sheets exported as CSV (like Google Sheets "Download > CSV") -> import/import.js -> Postgres,
// then every column the boots, ops and features need is checked against the sheet cell it came from.
// A second pass rewrites the same CSV files the way real exports often look (BOM, Windows line ends, "$1,234.50",
// a blank line at the end) and checks the database comes out the same.
// No fill-ins: what is in the database comes only from import.js.
// Run: node run_import.js
// =====================================================================
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/gs.js'), M = F.M, { exportBooks } = require('./lib/export.js'), I = require('../import/import.js');
const D = require('./lib/db.js'), BF = require('./lib/boot_fixture.js');
const GS = path.join(__dirname, '.gs'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbi-'));
let pass = 0, fail = 0;
const J = x => JSON.stringify(x), S = v => String(v == null ? '' : v).trim();
function ok(c, msg, extra) { if (c) { pass++; console.log('   ok   ' + msg); } else { fail++; console.log('   FAIL ' + msg + (extra ? '\n         ' + String(extra).slice(0, 2000) : '')); } }

function extendMore() {                       // tabs the boot fixture does not have yet
  const ops = M.books[CFG.OPS_ID], T = n => F.today(n), st = min => Utilities.formatDate(new Date(Date.now() - min * 60000), CFG.TZ, 'dd/MM/yyyy HH:mm');
  ops.add('WORKOUT PROGRAMS', [WO.PROG_HEAD.slice(), ['C001', 'Alice Aoun', '{"days":[{"name":"A","ex":["Squat"]}]}', st(700), 'Joe', 3]]);
  ops.add('WORKOUT DECISIONS', [WO.DEC_HEAD.slice(), ['S12-0003', 'C001', 'catch', 'Day A', 'Joe', st(600)], ['S13-0008', 'C080', 'keep', '', 'Joe', st(500)]]);
  ops.add('EXERCISES', [WO.EX_HEAD.slice(), ['Legs', 'Box squat', 'Joe', beirutDate_(T(-5), 0)], ['Core', 'Dead bug', 'Mikel', beirutDate_(T(-4), 0)]]);
  ops.add('WORKOUT LOG', [WO.LOG_HEAD.slice(), [st(300), beirutDate_(T(-4), 0), 'C001', 'Alice Aoun', 'S12-0003', 'A', 'Squat', "'40x8, 45x6", 'Joe'],
    [st(200), beirutDate_(T(-3), 0), 'C001', 'Alice Aoun', 'free', 'A', 'Lunge', '12x10', 'Joe']]);
  ops.add('NUTRITION INTAKE', [NUT.INTAKE_HEAD.slice(), ['C050', 'Dina Daher', '{"goal":"lose"}', 3, '', 0, '', '', '', st(800)]]);
}

const Q = {                                   // what to read back, ordered, no generated ids
  clients: `select legacy_id, kind, discount_pct::float8 as disc, guest_asked, (select legacy_id from public.leads l where l.id = c.lead_id) as lead from public.clients c order by legacy_id`,
  notes: `select (select legacy_id from public.clients where id = client_id) as c, always_show, program from public.client_notes order by 1`,
  goals: `select (select legacy_id from public.clients where id = client_id) as c, promise, made_by, to_char(updated_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI') as at from public.client_goals order by 1`,
  sn: `select app.ymd(day) as d, (select legacy_id from public.sessions where id = session_id) as s, (select legacy_id from public.clients where id = client_id) as c, by_staff, note, to_char(logged_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI') as at from public.session_notes order by logged_at`,
  pi: `select (select legacy_id from public.clients where id = client_id) as c, by_staff, body_area, complaint, pain_now, red_flags, impression, plan, form from public.physio_intake order by created_at`,
  files: `select (select legacy_id from public.clients where id = client_id) as c, file_name, storage_path, file_type, uploaded_by, app.ymd(day) as d from public.client_files order by created_at`,
  photos: `select (select legacy_id from public.clients where id = client_id) as c, storage_path from public.client_photos order by 1`,
  inv: `select item, price_cents, stock, cost_cents, sold from public.inventory order by created_at`,
  pos: `select legacy_id, to_name, buyer, qty, amount_cents, cost_cents, profit_cents, status, note, by_who, app.ymd((at at time zone 'Asia/Beirut')::date) as d from public.pos_sales order by legacy_id`,
  exp: `select legacy_id, app.ymd(day) as d, what, category, amount_cents, by_who, (select legacy_id from public.recurring_expenses r where r.id = recurring_id) as rec from public.expenses order by legacy_id`,
  rec: `select legacy_id, what, amount_cents, every, active, app.ymd(last_logged) as last from public.recurring_expenses order by 1`,
  dec: `select (select legacy_id from public.sessions where id = session_id) as s, (select legacy_id from public.clients where id = client_id) as c, choice, missed_workout, decided_by, to_char(decided_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI') as at from public.wo_decisions order by 1, 2`,
  ex: `select group_name, exercise, added_by, app.ymd(day) as d from public.wo_exercises order by seq`,
  prog: `select (select legacy_id from public.clients where id = client_id) as c, program, version, updated_by, to_char(updated_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI') as at from public.wo_programs order by 1`,
  logs: `select session_ref, (select legacy_id from public.sessions where id = session_id) as s, exercise, sets from public.wo_logs order by seq`,
  intake: `select (select legacy_id from public.clients where id = client_id) as c, step, version, answers from public.nutrition_intake order by 1`,
  counts: `select (select count(*) from public.clients)::int as clients, (select count(*) from public.packages)::int as packages, (select count(*) from public.sessions)::int as sessions,
             (select count(*) from public.session_clients)::int as seats, (select count(*) from public.leads)::int as leads, (select count(*) from public.client_requests)::int as requests`
};
async function load(db, dir) {
  const { sql, P } = I.run(dir, GS);
  await D.freshDb(db);
  const out = {};
  await D.withDb(db, async c => {
    await c.query(['begin;'].concat(sql, ['commit;']).join('\n'));
    for (const k of Object.keys(Q)) out[k] = (await c.query(Q[k])).rows;
  });
  return { out, P };
}
function quirky(src, dst) {                   // the same files, the way real exports often arrive
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst);
  fs.readdirSync(src).forEach(f => {
    let t = fs.readFileSync(path.join(src, f), 'utf8');
    const rows = I.parseCsv(t);
    const money = /EXPENSES|POS SALES|POS INVENTORY|RECURRING/.test(f) ? { 'EXPENSES.csv': [4], 'POS SALES.csv': [5, 6, 7], 'POS INVENTORY.csv': [5, 10], 'RECURRING EXPENSES.csv': [3] }[f] || [] : [];
    const txt = rows.map((r, i) => r.map((v, j) => {
      let s = String(v);
      if (i > 0 && money.indexOf(j) > -1 && s !== '' && !isNaN(Number(s))) s = (Number(s) < 0 ? '-$' : '$') + Math.abs(Number(s)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    fs.writeFileSync(path.join(dst, f), '﻿' + txt + '\r\n\r\n');
  });
}

(async () => {
  F.build(); BF.extend(); extendMore();
  const tab = n => (M.books[CFG.OPS_ID].sheets[n] || M.books[CFG.CLIENTS_ID].sheets[n] || { d: [] }).d;
  const { disp } = require('./lib/export.js'), d = v => disp(v);
  D.buildTemplate();
  const dir = path.join(TMP, 'plain'); exportBooks(M.books, dir);
  console.log('\n-- import of the plain export');
  const { out: A, P } = await load('wb_imp', dir);
  ok(P.warn.length < 40, 'import problems listed: ' + P.warn.length, P.warn.join('\n'));
  const cents = v => Math.round(Number(v) * 100);

  // client discount, guest asked + lead
  const notes = tab('CLIENT NOTES').slice(1).filter(r => Number(r[7]));
  notes.forEach(r => ok(A.clients.find(x => x.legacy_id === r[0]).disc === Number(r[7]), `CLIENT NOTES ${r[0]} discount ${r[7]}%`));
  ok(A.clients.filter(x => x.disc).length === notes.length, 'no other client has a discount');
  tab(GUEST.TAB).slice(1).forEach(r => {
    const x = A.clients.find(y => y.legacy_id === r[0]);
    ok(x && J(x.guest_asked) === J(S(r[7]) ? JSON.parse(r[7]) : {}) && (x.lead || '') === S(r[6]), `APP GUESTS ${r[0]} asked + lead`, J(x) + ' vs ' + J(r));
  });
  // goals updated
  tab('CLIENT GOALS').slice(1).forEach(r => ok(A.goals.find(x => x.c === r[0]).at === d(r[6]), `CLIENT GOALS ${r[0]} updated ${d(r[6])}`));
  // session notes, physio, files, photos
  const sn = tab('SESSION NOTES').slice(1);
  ok(J(A.sn.map(x => [x.d, x.s || '', x.c, x.by_staff, x.note, x.at])) === J(sn.map(r => [r[0], r[1], r[2], r[4], r[5], d(r[6])])), `SESSION NOTES: ${sn.length} rows, session links kept`, J(A.sn));
  const pi = tab('PHYSIO INTAKE').slice(1);
  ok(J(A.pi.map(x => [x.c, x.by_staff, x.body_area, x.complaint, x.pain_now, x.red_flags, x.impression, x.plan, x.form])) === J(pi.map(r => [r[1], r[3], r[4], r[5], S(r[6]) === '' ? null : Number(r[6]), r[7], r[8], r[9], JSON.parse(r[10] || '{}')])), `PHYSIO INTAKE: ${pi.length} rows`, J(A.pi));
  const cf = tab('CLIENT FILES').slice(1);
  ok(J(A.files.map(x => [x.c, x.file_name, x.storage_path, x.file_type, x.uploaded_by, x.d])) === J(cf.map(r => [r[0], r[2], r[3], r[4], r[5], appYmd_(d(r[6]))])), `CLIENT FILES: ${cf.length} rows with their paths`, J(A.files));
  const ph = tab(PROF.TAB).slice(1);
  ok(J(A.photos.map(x => [x.c, x.storage_path])) === J(ph.map(r => [r[0], r[2]]).sort()), `profile photos: ${ph.length}`);
  // inventory, POS, expenses
  const iv = tab('POS INVENTORY').slice(1).filter(r => r[3]);
  ok(J(A.inv.map(x => [x.item, x.price_cents, x.stock, x.cost_cents, x.sold])) === J(iv.map(r => [r[3], cents(r[10] || 0), Number(r[8]) || 0, cents(r[5]), Number(r[7]) || 0])), 'POS INVENTORY: sale price (K), left (I), cost (F), sold (H)', J(A.inv));
  const ps = tab('POS SALES').slice(1).filter(r => r[0]);
  ok(J(A.pos.map(x => [x.legacy_id, x.to_name, x.buyer, x.qty, x.amount_cents, x.cost_cents, x.profit_cents, x.status, x.note, x.by_who, x.d])) ===
     J(ps.map(r => [r[0], r[3], r[3], r[4], cents(r[5]), cents(r[6]), cents(r[7]), r[8], r[9], (/via app \((.*)\)/.exec(r[9]) || [])[1], appYmd_(d(r[1]))]).sort()),
     'POS SALES: ID, to, cost, profit, status (I) and note (J) in their own columns, staff name from the note', J(A.pos));
  const ex = tab('EXPENSES').slice(1);
  ok(J(A.exp.map(x => [x.legacy_id, x.d, x.what, x.category, x.amount_cents, x.by_who, x.rec || ''])) ===
     J(ex.map(r => [r[0], appYmd_(d(r[1])), r[2], r[3], cents(r[4]), r[5], (/REC-\d+/.exec(S(r[6])) || [''])[0]]).sort()), 'EXPENSES: ID (A) and the recurring link (G)', J(A.exp));
  // workouts, intake
  const wd = tab('WORKOUT DECISIONS').slice(1);
  ok(J(A.dec.map(x => [x.s, x.c, x.choice, x.missed_workout, x.decided_by, x.at])) === J(wd.map(r => [r[0], r[1], r[2], r[3], r[4], d(r[5])]).sort()), `WORKOUT DECISIONS: ${wd.length}`, J(A.dec));
  const wx = tab('EXERCISES').slice(1);
  ok(J(A.ex.map(x => [x.group_name, x.exercise, x.added_by, x.d])) === J(wx.map(r => [r[0], r[1], r[2], appYmd_(d(r[3]))])), `EXERCISES: ${wx.length}`, J(A.ex));
  const pr = tab('WORKOUT PROGRAMS').slice(1)[0];
  ok(A.prog.length === 1 && A.prog[0].version === 3 && A.prog[0].at === d(pr[3]) && A.prog[0].updated_by === 'Joe', 'WORKOUT PROGRAMS: version and updated time', J(A.prog));
  ok(J(A.logs) === J([{ session_ref: 'S12-0003', s: 'S12-0003', exercise: 'Squat', sets: [{ kg: 40, reps: 8 }, { kg: 45, reps: 6 }] }, { session_ref: 'free', s: null, exercise: 'Lunge', sets: [{ kg: 12, reps: 10 }] }]),
     'WORKOUT LOG: session ID kept as typed, sets read from "40x8, 45x6"', J(A.logs));
  ok(A.intake.length === 1 && A.intake[0].version === 0 && A.intake[0].step === 3, 'NUTRITION INTAKE: version 0 stays 0', J(A.intake));

  console.log('\n-- the same sheets as a messy real export (BOM, CRLF, "$1,234.50", trailing blank line)');
  const dir2 = path.join(TMP, 'messy'); quirky(dir, dir2);
  const { out: B } = await load('wb_imp2', dir2);
  Object.keys(Q).forEach(k => ok(J(A[k]) === J(B[k]), `messy export: ${k} identical`, J(A[k]).slice(0, 600) + '\n         ' + J(B[k]).slice(0, 600)));

  console.log('\n-- the same sheets downloaded as .xlsx (all tabs at once) -> import/xlsx2csv.js -> import.js');
  const X = require('xlsx'), XC = require('../import/xlsx2csv.js'), xdir = path.join(TMP, 'xlsx'); fs.mkdirSync(xdir, { recursive: true });
  const serial = v => { const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(v).forEach(x => p[x.type] = x.value);
    const h = p.hour === '24' ? 0 : +p.hour, ms = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second); return { v: ms / 864e5 + 25569, z: h || +p.minute || +p.second ? 'dd/mm/yyyy hh:mm:ss' : 'dd/mm/yyyy' }; };
  const names = { [CFG.CLIENTS_ID]: 'Client Portal', [CFG.OPS_ID]: 'Operations' }; let bn = 0;
  Object.keys(M.books).forEach(id => {
    const wb = X.utils.book_new();
    Object.keys(M.books[id].sheets).forEach(tab => {
      const ws = {}, rows = M.books[id].sheets[tab].d; let maxc = 0;
      rows.forEach((r, i) => (r || []).forEach((v, j) => {
        if (v === '' || v === null || v === undefined) return; maxc = Math.max(maxc, j);
        const ref = X.utils.encode_cell({ r: i, c: j });
        if (v instanceof Date) { const x = serial(v); ws[ref] = { t: 'n', v: x.v, z: x.z }; }
        else if (typeof v === 'number') ws[ref] = { t: 'n', v };
        else if (typeof v === 'boolean') ws[ref] = { t: 'b', v };
        else ws[ref] = { t: 's', v: String(v) };
      }));
      ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: maxc } });
      X.utils.book_append_sheet(wb, ws, tab.replace(/[:\\/?*[\]]/g, '_').slice(0, 31));   // xlsx tab names cannot hold : / (Google writes them changed); import.js matches letters and digits only
    });
    X.writeFile(wb, path.join(xdir, (names[id] || 'Book ' + (++bn)) + '.xlsx'));
  });
  const dir3 = path.join(TMP, 'fromxlsx'), made = XC.convert(fs.readdirSync(xdir).map(f => path.join(xdir, f)), dir3);
  ok(made.some(n => n === 'Operations - POS SALES.csv') && made.some(n => n === 'Client Portal - ' + CFG.CLIENTS_TAB + '.csv'), 'one CSV per tab, named like the Google download: ' + made.length + ' tabs');
  const { out: C3 } = await load('wb_imp3', dir3);
  Object.keys(Q).forEach(k => ok(J(A[k]) === J(C3[k]), `xlsx route: ${k} identical`, J(A[k]).slice(0, 600) + '\n         ' + J(C3[k]).slice(0, 600)));
  await D.dropDb('wb_imp3');
  await D.dropDb('wb_imp'); await D.dropDb('wb_imp2');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
