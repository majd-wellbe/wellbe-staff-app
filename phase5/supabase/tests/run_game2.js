#!/usr/bin/env node
// Game + referral side by side (migrations/0014_game_referral_sync.sql) against the Apps Script in 1-apps-script/phase3:
// the same calls, on the same data, at the same (fake) time, in RunGame.gs / Levels.gs / Referral.gs (node, in memory sheets)
// and in Postgres through the API door (public.wb_call). Answers are compared field by field, then the saved rows.
// Scenarios follow 1-apps-script/phase3/tests/rungame.test.js and referral.test.js.
// Run: node run_game2.js   (local Postgres 16 on PGHOST/PGPORT, see reset.sh)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');
const { Client } = require('pg');
const HOST = process.env.PGHOST || '/var/lib/postgresql/wbtest', PORT = Number(process.env.PGPORT || 5544), TPL = 'wb_g2_tpl';
const DIR = path.join(__dirname, '../../../1-apps-script/phase3');
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('   FAIL ' + msg + (extra !== undefined ? '\n         ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 1800) : '')); } }
const J = JSON.stringify;

// ---------- fake time on both sides ----------
let NOW = Date.UTC(2026, 9, 25, 7, 0, 0);
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
const tick = ms => { NOW += ms; };

// ---------- compare: numbers rounded, object keys in any order ----------
const fl = x => typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : Array.isArray(x) ? x.map(fl) : x && typeof x === 'object' ? Object.keys(x).sort().reduce((o, k) => (o[k] = fl(x[k]), o), {}) : x;
function diff(a, b, p) {
  const out = []; a = fl(a); b = fl(b);
  (function walk(x, y, q) {
    if (out.length > 6 || J(x) === J(y)) return;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) { x.forEach((v, i) => walk(v, y[i], q + '[' + i + ']')); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) { new Set(Object.keys(x).concat(Object.keys(y))).forEach(k => walk(x[k], y[k], q + '.' + k)); return; }
    out.push(`${q}: gs ${J(x) === undefined ? 'undefined' : J(x).slice(0, 400)} | sql ${J(y) === undefined ? 'undefined' : J(y).slice(0, 400)}`);
  })(a, b, p || '');
  return out;
}

// ---------- one top level function out of a .gs file ----------
function fnSrc(file, name) {
  const s = fs.readFileSync(path.join(DIR, file), 'utf8'), i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error(name + ' not found in ' + file);
  let k = s.indexOf('{', i), depth = 0, q = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '/' && s[k + 1] === '/') { k = s.indexOf('\n', k); continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return s.slice(i + 1, k + 1);
  }
  throw new Error('no end for ' + name);
}
function fmt(d, tz, f) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
}

// ---------- the Apps Script world ----------
function Sheet(name) { this.name = name; this.rows = []; this.fmt = {}; }
Sheet.prototype.getName = function () { return this.name; };
Sheet.prototype.getLastRow = function () { let n = this.rows.length; while (n && !(this.rows[n - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) n--; return n; };
Sheet.prototype.getLastColumn = function () { return this.rows.reduce((m, r) => Math.max(m, (r || []).length), 0); };
Sheet.prototype.getMaxRows = function () { return 5000; };
Sheet.prototype.getMaxColumns = function () { return 30; };
Sheet.prototype.insertColumnsAfter = function () {};
Sheet.prototype.appendRow = function (r) { this.rows[this.getLastRow()] = r.slice(); return this; };
Sheet.prototype.setFrozenRows = function () {};
Sheet.prototype.getDataRange = function () { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); };
Sheet.prototype.getRange = function (r, c, nr, nc) {
  const sh = this; nr = nr || 1; nc = nc || 1;
  const vals = () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined || v === null ? '' : v); } out.push(o); } return out; };
  const rg = {
    getValues: vals, getDisplayValues: () => vals().map(row => row.map(v => v instanceof RealDate ? fmt(v, 'Asia/Beirut', 'yyyy-MM-dd') : String(v))),
    getValue: () => vals()[0][0],
    setValues: vs => { vs.forEach((vr, i) => { const ri = r - 1 + i; while (sh.rows.length <= ri) sh.rows.push([]); sh.rows[ri] = sh.rows[ri] || []; vr.forEach((v, j) => { sh.rows[ri][c - 1 + j] = v; }); }); return rg; },
    setValue: v => rg.setValues([[v]]), setNumberFormat: f => { sh.fmt[r + ':' + c] = f; return rg; },
    getFormula: () => '', setFormula: () => rg, setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg
  };
  return rg;
};
function Book() { this.tabs = {}; }
Book.prototype.getSheetByName = function (n) { return this.tabs[n] || null; };
Book.prototype.insertSheet = function (n) { return (this.tabs[n] = new Sheet(n)); };

// DATA: the people both sides know. clients: [{id, name, email, phone, kind}], pkgs: [{id, cid, type, price, status}], trained: {cid: true}
function gsWorld(DATA) {
  const books = {};
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Error, RegExp, encodeURIComponent, DATA,
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: id => books[id] || (books[id] = new Book()), flush: () => {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {}, getAll: () => ({}), putAll: () => {} }) },   // no cache: the logic itself is compared
    Utilities: { formatDate: fmt },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  };
  vm.createContext(ctx);
  const cfgSrc = fs.readFileSync(path.join(DIR, 'Config.gs'), 'utf8');
  const code = [
    "var CFG = { OPS_ID: 'OPS', CLIENTS_ID: 'CLI', CLIENTS_TAB: 'CLIENTS', LEADS_TAB: 'LEADS W40', TZ: 'Asia/Beirut' };",
    fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8').match(/var L = \{[\s\S]*?\};/)[0],
    cfgSrc.slice(cfgSrc.indexOf('var CFG_DEFAULTS'), cfgSrc.indexOf('var CFG_KINDS')),
    'var CFG_MEMO_ = null; function cfg_() { return CFG_MEMO_ || (CFG_MEMO_ = JSON.parse(JSON.stringify(CFG_DEFAULTS))); }',
    ...['phoneKey_', 'clean_', 'cellSafe_', 'nextId_', 'scanIds_'].map(n => fnSrc('Code.gs', n)),
    ...['cfgType_', 'cfgTypes_', 'cfgValid_', 'cfgStaffByTrainer_', 'cfgStaffById_', 'cfgFixed_', 'cfgService_', 'cfgDeskName_', 'cfgDeskId_', 'cfgStaff_'].map(n => fnSrc('Config.gs', n)),
    ...['appSell_', 'appTab_', 'appRows_', 'appNum_', 'appShift_', 'appClientInfo_', 'noticeAdd_', 'noticeTab_'].map(n => fnSrc('App.gs', n)),
    "var NOTICE_HEAD = ['ID', 'Created', 'For', 'Type', 'Text', 'Read'];",
    ...['clRequest_', 'clLog_', 'clReqObj_', 'clPingOk_', 'clAddPkg_'].map(n => fnSrc('Client.gs', n)),
    "var CL = { REQ_HEAD: ['ID', 'Created', 'Client ID', 'Client', 'Type', 'Details', 'Slot / Session', 'Package', 'Status', 'Handled by', 'Handled at', 'Data'] };",
    'function roGuard_() {} function clPingRomy_() {}',
    "function guestById_(id) { var c = DATA.clients.filter(function (x) { return x.id === id; })[0]; return c ? { name: c.name, phone: c.phone, email: c.email } : null; }",
    'var MEL = {}; function appIsMel_(cid) { return !!MEL[cid]; } function appFlag_(b) { MEL[b.cid] = 1; }',
    "function beirutDate_(ymd) { return new Date(ymd + 'T00:00:00Z'); }",
    'function writeLikeTemplate_(sh, rowNum, tplRow, row) { sh.getRange(rowNum, 1, 1, row.length).setValues([row]); }',
    // game: who trained (sessions), packages (runWho_), the small sheet helpers RunGame.gs uses
    "function clPkgIds_(ops, cid) { var o = {}; o['P-' + cid] = 1; return o; }",
    "function appSessions_(ops, a, b) { return Object.keys(DATA.trained).filter(function (c) { return DATA.trained[c]; }).map(function (c) { return { status: 'Done', date: a, start: '08:00', clients: [{ pkg: 'P-' + c, att: 'Present' }] }; }); }",
    "function pkgsAll_() { return DATA.pkgs.map(function (p) { return { cid: p.cid, type: p.type }; }); }",
    'function nutJ_(s, d) { try { var o = JSON.parse(s || ""); return o == null ? d : o; } catch (e) { return d; } }',
    'var VER = {}; function verGet_(n) { var o = {}; n.forEach(function (k) { o[k] = VER[k] || (VER[k] = "1"); }); return o; } function verBump_(n) { n.forEach(function (k) { VER[k] = String(Number(VER[k] || 0) + 1); }); }',
    'function cacheGetBig_() { return null; } function cachePutBig_() {}',
    fs.readFileSync(path.join(DIR, 'Levels.gs'), 'utf8'),
    fs.readFileSync(path.join(DIR, 'RunGame.gs'), 'utf8'),
    fs.readFileSync(path.join(DIR, 'Referral.gs'), 'utf8')
  ].join('\n');
  vm.runInContext(code, ctx);
  const cli = ctx.SpreadsheetApp.openById('CLI').insertSheet('CLIENTS'); cli.rows.push(['Client ID', 'Name', 'Email', 'Phone']);
  const ops = ctx.SpreadsheetApp.openById('OPS');
  const pk = ops.insertSheet('PACKAGES'); pk.rows.push(['PACKAGES'], ['Package ID', 'Client ID', 'Client Name', 'Package Type', 'Total', 'Used', 'Remaining', 'Per pass', 'Price']);
  const leads = ops.insertSheet('LEADS W40'); leads.rows.push(['ID', 'Sub', 'Name', 'Phone', 'Trained', 'Stopped', 'Why', 'Inj', 'Date', 'Time', 'Type', 'Status', 'Called', 'Notes', 'Src', 'Client ID', 'Pkg', 'Sid', 'Email']);
  const run = src => vm.runInContext(src, ctx);
  return { ctx, ops, cli, pk, leads, run,
    tab: () => ops.getSheetByName('CORNICHE RUN'),
    row: cid => { const t = ops.getSheetByName('CORNICHE RUN'); return t && t.rows.slice(1).filter(r => r && String(r[0]).toUpperCase() === cid)[0]; },
    game: (cid, b) => { try { return JSON.parse(J(run('clRun_')(b, cid))); } catch (e) { return { error: e.message }; } },
    call: (fn, ...a) => { try { const r = run(fn)(...a); return r === undefined ? r : JSON.parse(J(r)); } catch (e) { return { error: e.message }; } }
  };
}

// ---------- the Postgres side ----------
async function pgDb(name) {
  const a = new Client({ host: HOST, port: PORT, user: 'postgres', database: 'postgres' }); await a.connect();
  await a.query(`drop database if exists ${name}`); await a.query(`create database ${name} template ${TPL}`); await a.end();
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: name }); await c.connect();
  return c;
}
async function wb(c, action, who, body) {   // who: 'k-romy' (staff key) or an email (client sign in)
  await c.query(`update app.test_clock set t = $1`, [new RealDate(NOW).toISOString()]);
  await c.query('begin');
  try {
    await c.query('set local role service_role');
    const staff = /^k-/.test(who);
    const r = (await c.query(`select public.wb_call($1, $2, $3, $4::jsonb) as x`, [action, staff ? who : null, staff ? null : 'wb1.' + who, J(body)])).rows[0].x;
    await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); return { ok: false, error: 'SQL: ' + e.message }; }
}
const unwrap = r => { if (r && r.ok === false) return { error: r.error }; const o = Object.assign({}, r); delete o.ok; return o; };

// both sides get the same people
async function people(c, w, DATA) {
  for (const p of DATA.clients) {
    if (p.kind === 'guest') {
      await c.query(`insert into public.clients (legacy_id, kind, name, email, phone, converted_to) values ($1, 'guest', $2, $3, app.phone_norm($4), (select id from public.clients where legacy_id = $5))`, [p.id, p.name, p.email, p.phone || '', p.conv || null]);
    } else {
      w.cli.rows.push([p.id, p.name, p.email, p.phone || '']);
      await c.query(`insert into public.clients (legacy_id, kind, name, email, phone, sheet_row) values ($1, 'client', $2, $3, app.phone_norm($4), $5)`, [p.id, p.name, p.email, p.phone || '', w.cli.rows.length]);
    }
    await c.query(`insert into app.sessions (token_hash, email, expires_at) values (app.sha($1), $2, now() + interval '30 days') on conflict do nothing`, ['wb1.' + p.email, p.email]);
  }
  for (const k of DATA.pkgs) await addPkg(c, w, k);
  for (const cid of Object.keys(DATA.trained)) if (DATA.trained[cid]) await trainToday(c, cid);
}
async function addPkg(c, w, k) {
  w.pk.rows.push([k.id, k.cid, '', k.type, 8, 0, 8, 0, k.price, '', '', '', '', k.status || 'Active']);
  await c.query(`insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, start_date, expiry_date, effective_expiry, status)
    values ($1, (select id from public.clients where legacy_id = $2), $3, app.kind_of($3), 8, 0, $4, 0, current_date, current_date + 30, current_date + 30, $5)`, [k.id, k.cid, k.type, Math.round(k.price * 100), k.status || 'Active']);
}
async function trainToday(c, cid) {   // a Present seat today (1:3), the same thing appSessions_ says on the Apps Script side
  const day = fmt(new RealDate(NOW), 'Asia/Beirut', 'yyyy-MM-dd');
  const pid = (await c.query(`insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, start_date, expiry_date, effective_expiry, status)
     values ('TP-' || $1, (select id from public.clients where legacy_id = $1), '1:3 - 8x/month ($140pp)', '1:3', 8, 1, 0, 0, $2::date, $2::date + 30, $2::date + 30, 'Active') returning id`, [cid, day])).rows[0].id;
  const sid = (await c.query(`insert into public.sessions (legacy_id, kind, day, start_time, end_time, trainer, status) values ('ST-' || $1, '1:3', $2::date, '08:00', '09:00', 'Joe', 'Done') returning id`, [cid, day])).rows[0].id;
  await c.query(`insert into public.session_clients (session_id, slot, package_id, client_id, name, att, pass) values ($1, 0, $2, (select id from public.clients where legacy_id = $3), $3, 'Present', 'Y')`, [sid, pid, cid]);
}
// a game row field changed by hand on both sides (like the Apps Script tests edit the sheet)
const COL = { 4: 'coins', 6: 'total_m', 17: 'credit_cents', 19: 'xp' };
async function setCol(c, w, cid, col, v) { w.row(cid)[col] = v; await c.query(`update public.game_players set ${COL[col]} = $1 where client_id = (select id from public.clients where legacy_id = $2)`, [v, cid]); }
// the saved game row, the same shape from both sides
function gsRow(w, cid) {
  const r = w.row(cid); if (!r) return null;
  const pj = (s, d) => { try { return JSON.parse(s || ''); } catch (e) { return d; } }, m = /^T(\d+)(?: (.*))?$/.exec(String(r[14] || ''));
  return { name: r[1], best: Number(r[2]) || 0, bestM: Number(r[3]) || 0, coins: Number(r[4]) || 0, runs: Number(r[5]) || 0, totalM: Number(r[6]) || 0,
    day: String(r[7]).replace(/^D/, '') || null, dayBest: Number(r[8]) || 0, week: String(r[9]).replace(/^W/, '') || null, weekBest: Number(r[10]) || 0,
    up: pj(r[11], {}), ms: pj(r[12], {}), badges: pj(r[13], []), last: m ? Number(m[1]) : null, cause: m && m[2] ? JSON.parse(m[2]) : null,
    earned: Number(r[15]) || 0, credit: Number(r[17]) || 0, creditTotal: Number(r[18]) || 0, xp: Number(r[19]) || 0, owned: pj(r[20], {}), stats: pj(r[21], {}) };
}
async function sqlRow(c, cid) {
  const r = (await c.query(`select g.*, to_char(day_key, 'YYYY-MM-DD') dk, to_char(week_key, 'YYYY-MM-DD') wk, (extract(epoch from last_run_at) * 1000)::bigint as lastms
    from public.game_players g join public.clients c on c.id = g.client_id where c.legacy_id = $1`, [cid])).rows[0];
  if (!r) return null;
  return { name: r.name, best: r.best_score, bestM: r.best_m, coins: r.coins, runs: r.runs, totalM: Number(r.total_m), day: r.dk, dayBest: r.day_best, week: r.wk, weekBest: r.week_best,
    up: r.upgrades, ms: r.missions, badges: r.badges, last: r.lastms === null ? null : Number(r.lastms), cause: r.last_cause, earned: Number(r.earned_total), credit: r.credit_cents,
    creditTotal: r.credit_earned_cents, xp: Number(r.xp), owned: r.owned, stats: r.stats };
}

// ---------- a game scenario: steps run on both sides, every answer and the rows compared ----------
async function game(name, DATA, steps) {
  console.log('game: ' + name);
  NOW = DATA.start || Date.UTC(2026, 9, 25, 7, 0, 0);
  const w = gsWorld(DATA), c = await pgDb('wb_g2');
  await c.query(`update public.staff set phone = $1 where id = 'joe'`, ['+961 70 123 456']);   // a staff phone, same on both sides
  w.run("cfg_().staff.forEach(function (s) { if (s.id === 'joe') s.phone = '+961 70 123 456'; })");
  if (DATA.staffClients) { w.run('cfg_().game.staffClients = ' + J(DATA.staffClients)); await c.query(`update public.settings set value = jsonb_set(value, '{staffClients}', $1::jsonb) where key = 'game'`, [J(DATA.staffClients)]); }
  await people(c, w, DATA);
  const S = { w, c, results: [],
    async call(cid, body, label, check) {
      const email = DATA.clients.find(x => x.id === cid).email;
      const g = w.game(cid, body), s = unwrap(await wb(c, 'app_cl_run', email, Object.assign({ cid }, body)));
      const d = diff(g, s);
      ok(d.length === 0, `[${name}] ${label || J(body).slice(0, 80)} same answer`, d.join('\n         '));
      if (check) check(g, s);
      const rd = diff(gsRow(w, cid), await sqlRow(c, cid));
      ok(rd.length === 0, `[${name}] ${label || J(body).slice(0, 80)} same saved row`, rd.join('\n         '));
      return { g, s };
    },
    save(cid, run, label, check) { tick(3600 * 1000); return S.call(cid, { op: 'save', run }, label || 'save ' + run.m + ' m', check); }
  };
  try { await steps(S); } finally { await c.end(); }
}
const run1 = { secs: 160, m: 2600, coins: 300, score: 9000, spent: 0, ev: { jumps: 40, slides: 31, roof: 320, powers: 5, clean: 700, mult: 3, letters: 2 } };
const C = (id, name, extra) => Object.assign({ id, name, email: id.toLowerCase() + '@x.com', phone: '' }, extra || {});

if (require.main === module) (async () => {
  // template database: migrations + seed, the game clock under test control
  execFileSync('bash', [path.join(__dirname, 'reset.sh'), TPL], { env: Object.assign({}, process.env, { PGHOST: HOST, PGPORT: String(PORT) }), stdio: 'pipe' });
  { const c = new Client({ host: HOST, port: PORT, user: 'postgres', database: TPL }); await c.connect();
    await c.query(`create table app.test_clock (t timestamptz); insert into app.test_clock values (now());
      create or replace function app.clock() returns timestamptz language sql stable as $$ select coalesce((select t from app.test_clock limit 1), now()) $$;
      select app.import_staff_keys('{"romy":"k-romy","majd":"k-majd","joe":"k-joe"}'::jsonb);`);
    await c.end(); }

  await game('first runs: breakdown, ladders, old badge list', { clients: [C('C001', 'Lara Khoury'), C('C002', 'Maya Saab')], pkgs: [], trained: {} }, async S => {
    await S.call('C001', { op: 'get' }, 'get (new player)');
    await S.save('C001', run1, 'save 2,600 m', (g, s) => {
      ok(g.breakdown && g.breakdown.total === g.earned && s.newBadges && s.newBadges.indexOf('Runs played Bronze: 1 run') > -1, 'breakdown and first badge', [g.breakdown, s.newBadges]);
      ok(s.ladders && s.ladders.length === 12 && s.badgeCount.all === 60, '12 ladders, 60 badges', s.badgeCount);
    });
    await S.save('C001', Object.assign({}, run1, { m: 5200, secs: 300, score: 20000 }), 'save 5,200 m');
    await S.call('C002', { op: 'get' }, 'other player sees the boards');
  });
  await game('trained: double coins, WELLBE once, training days', { clients: [C('C002', 'Maya Saab')], pkgs: [], trained: { C002: true } }, async S => {
    for (let i = 0; i < 5; i++) await S.save('C002', run1, 'save ' + (i + 1));
  });
  await game('old 21 column row: badges map into the ladders', { clients: [C('C030', 'Old Player')], pkgs: [], trained: {} }, async S => {
    const { w, c } = S, sh = w.ops.insertSheet('CORNICHE RUN');
    sh.appendRow(['Client ID', 'Name', 'Best score', 'Best m', 'Coins', 'Runs', 'Total m', 'Day', 'Day best', 'Week', 'Week best', 'Upgrades', 'Missions', 'Badges', 'Last run', 'Earned total', 'Updated', 'Cash (cents)', 'Cash earned (cents)', 'XP', 'Owned']);
    sh.appendRow(['C030', 'Old Player', 12000, 5200, 900, 12, 30000, 'D2026-10-20', 100, 'W2026-10-19', 100, '{"life":1}', '{}', '["first","km1","km5","runs10","rich","boost","all1","week10"]', 'T' + (NOW - 86400000), 11000, '', 0, 0, 500, '{}']);
    await c.query(`insert into public.game_players (client_id, name, best_score, best_m, coins, runs, total_m, day_key, day_best, week_key, week_best, upgrades, badges, last_run_at, earned_total, xp)
      values ((select id from public.clients where legacy_id = 'C030'), 'Old Player', 12000, 5200, 900, 12, 30000, '2026-10-20', 100, '2026-10-19', 100, '{"life":1}',
              '["first","km1","km5","runs10","rich","boost","all1","week10"]', $1, 11000, 500)`, [new RealDate(NOW - 86400000).toISOString()]);
    await S.call('C030', { op: 'get' }, 'get on the old row');
    await S.save('C030', { secs: 60, m: 400, coins: 50, score: 600, spent: 0, ev: { jumps: 5, slides: 3 } }, 'save on the old row: no repeated badges');
  });
  await game('ladder progress texts and leaderboard badges', { clients: [C('C040', 'Ziad Nassar'), C('C051', 'A One'), C('C052', 'B Two'), C('C053', 'C Three')], pkgs: [], trained: {} }, async S => {
    await S.save('C040', { secs: 40, m: 450, coins: 40, score: 600, spent: 0, ev: { jumps: 60, slides: 50, clean: 250 } });
    await S.save('C040', { secs: 40, m: 520, coins: 40, score: 600, spent: 0, ev: { jumps: 60, slides: 10, clean: 310 } });
    await S.save('C040', { secs: 40, m: 300, coins: 10, score: 300, spent: 0, ev: {} });
    await S.save('C051', { secs: 40, m: 300, coins: 10, score: 300, ev: {} });
    await S.save('C052', { secs: 40, m: 300, coins: 10, score: 200, ev: {} });
    await S.save('C053', { secs: 100, m: 1200, coins: 10, score: 5000, ev: {} }, '#1 of the day with 4 players', (g, s) => ok(s.newBadges.indexOf('Leaderboard Silver: #1 of the day') > -1, 'Leaderboard Silver', s.newBadges));
    for (let i = 0; i < 3; i++) await S.save('C051', { secs: 300, m: 3000, coins: 400, score: 12000, spent: 0, ev: { jumps: 50, slides: 40, roof: 400, powers: 6, clean: 900, mult: 4 } }, 'missions run ' + (i + 1));
  });
  await game('run cause, one run at a time, refused runs', { clients: [C('C060', 'Rami Aoun')], pkgs: [], trained: {} }, async S => {
    await S.save('C060', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { cause: 'puddle', causeText: 'Stepped in a puddle, coach caught you', lane: 2, atM: 2600, hits: [{ k: 'cones', m: 900 }, { k: 'puddle', m: 2598 }] }) }), 'save with a cause');
    await S.call('C060', { op: 'save', run: run1 }, 'too soon: Slow down');
    await S.save('C060', run1, 'older phone: no cause');
    await S.save('C060', Object.assign({}, run1, { ev: { cause: 'x"}<script>', causeText: 'a\nb', hits: [1, null, { k: 'dog' }] } }), 'cause cleaned');
    await S.save('C060', { secs: 10, m: 5000, coins: 0, score: 0 }, 'impossible run');
    await S.save('C060', { secs: 100, m: 1600, coins: 0, score: 0, ev: { t1500: 1 } }, 'ticket not owned');
  });
  await game('outfits: prices, rules, buying, prestige', { clients: [C('C810', 'Nour Fares')], pkgs: [], trained: {} }, async S => {
    const { w } = S, xpFor = l => w.run('(function(){var t=0;for(var i=1;i<' + l + ';i++)t+=lvNeed_(i);return t})()');
    await S.save('C810', run1);
    await S.call('C810', { op: 'buy', item: 'street' }, 'not enough coins');
    await setCol(S.c, w, 'C810', 4, 20000);
    const O = r => { const m = {}; (r.outfits || []).forEach(o => { m[o.id] = o; }); return m; };
    const want = { ramadan: s => s.bought === 'Ramadan Night Run' && s.coins === 19000 && O(s).ramadan.own, matchday: s => s.error === 'You already have Yalla Lebnan',
      am530: s => /unlocks after 10 runs started before 7 am/.test(s.error || ''), race42: s => /unlocks when you have run 42 km/.test(s.error || ''), tyrian: s => s.error === 'Reach level 20 to buy Tyrian Purple' };
    let n = 0;
    for (const it of ['ramadan', 'ramadan', 'matchday', 'am530', 'race42', 'tyrian']) await S.call('C810', { op: 'buy', item: it }, 'buy ' + it, (g, s) => {
      if (it === 'ramadan' && n++) ok(s.error === 'You already have Ramadan Night Run', 'already owned refused', s.error); else ok(want[it](s), 'outfit ' + it, s.error || s.bought); });
    await S.call('C810', { op: 'shop', item: 'o1' }, 'shop o1 level gate');
    await S.call('C810', { op: 'buy', item: 'constructor' }, 'unknown item');
    await setCol(S.c, w, 'C810', 19, xpFor(20) + 5);
    await S.call('C810', { op: 'get' }, 'level 20: Tyrian Purple for coins');
    await S.call('C810', { op: 'buy', item: 'tyrian' }, 'buy Tyrian Purple', (g, s) => ok(s.bought === 'Tyrian Purple' && s.lv.have.o1 === true && s.coins === 16000, 'Tyrian bought', s.error || s.coins));
    await S.call('C810', { op: 'buy', item: 'cedar' }, 'Golden Cedar needs level 30');
    await setCol(S.c, w, 'C810', 19, xpFor(30) - 3);
    await S.save('C810', run1, 'level 30 chest: Golden Cedar can now be bought');
    await S.call('C810', { op: 'shop', item: 'magnet' }, 'shop: once item owned by level');
    await S.call('C810', { op: 'shop', item: 't500' }, 'shop: a ticket');
    await S.call('C810', { op: 'buy', item: 'magnet' }, 'upgrade buy');
    await S.call('C810', { op: 'buy', item: 'life' }, 'extra life');
    await S.call('C810', { op: 'shop', item: 'nope' }, 'not in the shop');
  });
  await game('Coach Kit for staff, Rehab Hero for physio clients, guests', {
    clients: [C('C900', 'Joe Al Hosny', { email: 'alhosnyjoe@gmail.com' }), C('C901', 'Phone Twin', { phone: '70 123 456' }), C('C801', 'Physio Client'), C('C802', 'Group Client'),
      C('C903', 'Other Phone', { phone: '81 123 456' }), C('C905', 'Listed Staff'), C('G0007', 'Guest Runner', { kind: 'guest' })],
    pkgs: [{ id: 'PKG-0101', cid: 'C801', type: 'Physio - Single Session ($50)', price: 50 }, { id: 'PKG-0102', cid: 'C802', type: '1:3 - 12x/month ($200pp)', price: 200 }],
    trained: {}, staffClients: ['c905'] }, async S => {
    const exp = { C900: [true, false], C901: [true, false], C801: [false, true], C802: [false, false], C903: [false, false], C905: [true, false], G0007: [false, false] };
    for (const cid of Object.keys(exp)) await S.call(cid, { op: 'get' }, 'outfits of ' + cid, (g, s) => { const o = {}; s.outfits.forEach(x => { o[x.id] = x; });
      ok(o.coach.own === exp[cid][0] && o.rehab.own === exp[cid][1], cid + ': Coach Kit ' + exp[cid][0] + ', Rehab Hero ' + exp[cid][1], [o.coach, o.rehab]); });
    await S.call('C900', { op: 'buy', item: 'coach' }, 'staff cannot pay for the free kit');
  });
  await game('5:30 AM Club and Race Day 42K', { clients: [C('C820', 'Early Bird')], pkgs: [], trained: {}, start: Date.UTC(2026, 10, 1, 3, 30) }, async S => {
    const short = { secs: 40, m: 200, coins: 20, score: 300, ev: {} };
    for (let i = 0; i < 9; i++) { NOW = Date.UTC(2026, 10, 1 + i, 3, 30); await S.call('C820', { op: 'save', run: run1 }, 'early run ' + (i + 1)); }
    NOW = Date.UTC(2026, 10, 12, 3, 30); await S.call('C820', { op: 'save', run: short }, 'early but short');
    NOW = Date.UTC(2026, 10, 13, 6, 10); await S.call('C820', { op: 'save', run: run1 }, 'started after 7');
    NOW = Date.UTC(2026, 10, 14, 5, 1); await S.call('C820', { op: 'save', run: run1 }, '10th run started 6:58 Beirut', (g, s) => ok(s.outfits.find(x => x.id === 'am530').own === true, '5:30 AM Club unlocked', s.outfits.find(x => x.id === 'am530')));
    await setCol(S.c, S.w, 'C820', 6, 41999); await S.call('C820', { op: 'get' }, '41,999 m');
    await setCol(S.c, S.w, 'C820', 6, 42000); await S.call('C820', { op: 'get' }, '42 km');
  });
  await game('runner names', { clients: [C('C701', 'Hala Mansour'), C('C702', 'Karim Daher')], pkgs: [], trained: {} }, async S => {
    await S.save('C701', run1); await S.save('C702', run1);
    await S.call('C701', { op: 'get', name: '  Corniche   Queen ' }, 'name through get');
    await S.call('C702', { op: 'get' }, 'others see the name');
    await S.call('C701', { op: 'name', name: 'Majd 961' }, 'op name');
    await S.save('C701', run1, 'a run keeps the name');
    for (const k of ['A', 'Abcdefghijklmno', 'Hi!', '<b>x</b>', 'fuckboy', 'Sh1t Runner', 'kos', 'Ya Sharmouta', 'nazi', 'ya ahbe', 'نيك', 'كسمك', 'manyak 1', 'ayre', 'شرموطة', 'Big Ass', 'Nazih', 'Kostas', 'Assaad', 'Airport Run', 'جاد', 'Élodie', 'خولة', 'نيكول', 'زبيدة', 'Wahbe', 'Rami 2', 12, true])
      await S.call('C701', { op: 'get', name: k }, 'name ' + J(k), (g, s) => ok(/^[A-Z][a-z]/.test(String(k)) && k.length > 3 && k.length <= 14 && !/[!<]/.test(k) && !/fuck|Sh1t|Sharm|Big Ass|manyak/.test(k) ? s.runName === k : true, 'name kept ' + k, s.error || s.runName));
    await S.call('C701', { op: 'get', name: '' }, 'empty name: back to the first name');
    await S.call('C701', { op: 'get', name: null }, 'null name changes nothing');
  });
  await game('studio items', { clients: [C('C750', 'Studio Fan')], pkgs: [], trained: {} }, async S => {
    const xpFor = l => S.w.run('(function(){var t=0;for(var i=1;i<' + l + ';i++)t+=lvNeed_(i);return t})()');
    await S.save('C750', run1);
    await setCol(S.c, S.w, 'C750', 4, 3000);
    for (const it of ['g_beanie', 'g_beanie', 'g_cap', 'tt_quwwa', 'tn_yes', 'g_avi', 'tn_salute']) await S.call('C750', { op: 'buy', item: it }, 'buy ' + it);
    await setCol(S.c, S.w, 'C750', 4, 10000);
    await S.call('C750', { op: 'buy', item: 'tn_capoeira' }, 'Capoeira level gate');
    await setCol(S.c, S.w, 'C750', 19, xpFor(10) + 5);
    await S.call('C750', { op: 'buy', item: 'tn_capoeira' }, 'Capoeira at level 10');
    await S.call('C750', { op: 'buy', item: 'tn_moonwalk' }, 'unknown studio id');
  });
  await game('Wellbe Credit, redeem, leaderboard privacy', { clients: [C('C050', 'Dina Daher'), C('C051', 'Eli Haddad')], pkgs: [], trained: {} }, async S => {
    await S.save('C050', run1); await S.save('C051', run1);
    await setCol(S.c, S.w, 'C050', 17, 250);
    await S.call('C050', { op: 'redeem' }, 'redeem');
    await S.call('C050', { op: 'redeem' }, 'redeem twice: waiting');
    await S.call('C051', { op: 'redeem' }, 'not enough credit');
    await S.call('C050', { op: 'get', lbHide: true }, 'hide from the boards');
    await S.call('C051', { op: 'get' }, 'the other player no longer sees them');
    await S.call('C050', { op: 'save', run: run1, lbHide: '0' }, 'too soon, then show again');
    tick(3600 * 1000); await S.call('C050', { op: 'save', run: run1, lbHide: 'false' }, 'save and show again');
    await S.save('C050', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { lifeUsed: 1 }) }), 'life used without lives');
  });

  // ---------------------------------------------------------------------
  // REFERRALS (referral.test.js scenarios): invites, sales, wallet, notices, boots
  // ---------------------------------------------------------------------
  const PAID = '1:3 - 8x/month ($140pp)', TRIAL = 'Trial Session - 1:3 (Free)', FREE = 'Assessment - Majd (Free)';
  async function ref(name, steps) {
    console.log('referral: ' + name);
    NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
    const DATA = { clients: [], pkgs: [], trained: {} }, w = gsWorld(DATA), c = await pgDb('wb_g2');
    // the template row PKG-0001 of the PACKAGES tab (an old paid package)
    DATA.clients.push(C('C999', 'Old Client')); await people(c, w, { clients: [C('C999', 'Old Client')], pkgs: [], trained: {} }); DATA.clients.length = 0; DATA.clients.push(C('C999', 'Old Client'));
    await addPkg(c, w, { id: 'PKG-0001', cid: 'C999', type: PAID, price: 140 });
    let nLead = 0;
    const R = { c,
      async client(id, name, phone) { const p = C(id, name, { phone }); DATA.clients.push(p); await people(c, w, { clients: [p], pkgs: [], trained: {} }); },
      async lead(name, phone, cid) { nLead++; const r = []; r[0] = 'W40-' + String(nLead).padStart(4, '0'); r[2] = name; r[3] = phone; r[15] = cid || ''; w.leads.rows.push(r);
        await c.query(`insert into public.leads (legacy_id, name, phone, client_id, sheet_row) values ($1, $2, app.phone_norm($3), (select id from public.clients where legacy_id = $4), $5)`, [r[0], name, phone, cid || null, w.leads.rows.length]); },
      async guest(gid, phone, cid) { const gs = w.ops.getSheetByName('APP GUESTS') || w.ops.insertSheet('APP GUESTS'); if (!gs.rows.length) gs.rows.push(['Guest ID', 'Email', 'Name', 'Phone', 'Created', 'Verified', 'Lead ID', 'Asked', 'Client ID']);
        gs.rows.push([gid, gid.toLowerCase() + '@x.com', 'Guest', phone, '', '', '', '', cid]);
        await c.query(`insert into public.clients (legacy_id, kind, name, email, phone, converted_to, sheet_row) values ($1, 'guest', 'Guest', $2, app.phone_norm($3), (select id from public.clients where legacy_id = $4), $5)`, [gid, gid.toLowerCase() + '@x.com', phone, cid, gs.rows.length]); },
      async invite(cid, fname, phone, label) {
        const b = { kind: 'invite', fname, phone, msg: 'Hi ' + fname };
        const g = w.call('clRequest_', b, cid), s = unwrap(await wb(c, 'app_cl_request', cid.toLowerCase() + '@x.com', Object.assign({ cid }, b)));
        const d = diff(g, s); ok(d.length === 0, `[${name}] invite ${label || fname} same answer`, d.join('\n         ')); await R.state(label || 'invite ' + fname); return g;
      },
      async sell(cid, type, extra, label) {
        const b = Object.assign({ type, cid, paid: 0 }, extra || {});
        const g = w.call('appSell_', b, { name: 'Romy' }), s = unwrap(await wb(c, 'app_sell', 'k-romy', b));
        const pick = x => x && x.error ? { error: x.error } : { id: x.id, ids: x.ids, total: x.total, referral: x.referral };
        const d = diff(pick(g), pick(s)); ok(d.length === 0, `[${name}] sell ${label || type} to ${cid} same answer`, d.join('\n         ')); await R.state(label || 'sell ' + cid);
        // the packages tab in the Apps Script world gets the price the sale wrote; keep DATA in step for runWho_ (not used here)
        return g;
      },
      async state(label) {
        const rs = w.ops.getSheetByName('REFERRALS'), gr = rs ? rs.rows.slice(1).filter(r => r && r[0]).map(r => ({ id: r[0], by: r[2], byName: r[3], friend: r[4], key: String(r[5]), status: r[6], fcid: r[7] || '', fpkg: r[8] || '',
          credit: r[9] === '' ? null : r[9], mark: r[12], note: r[13] || '', req: r[11] ? 'yes' : 'no' })) : [];
        const sr = (await c.query(`select r.legacy_id id, c.legacy_id by, r.referrer_name "byName", r.friend, r.friend_key key, r.status, r.friend_cid fcid, r.friend_pkg fpkg, r.credit::float8 credit, r.mark, r.note,
            case when r.request_id is null then 'no' else 'yes' end req from public.referrals r join public.clients c on c.id = r.referrer_id order by r.sheet_row nulls last, r.created_at, r.legacy_id`)).rows;
        let d = diff(gr, sr); ok(d.length === 0, `[${name}] ${label}: same REFERRALS rows`, d.join('\n         '));
        const ws = w.ops.getSheetByName('CLIENT WALLET'), gw = ws ? ws.rows.slice(1).filter(r => r && r[1]).map(r => ({ cid: r[1], amt: r[3], reason: r[4], pkg: r[5], by: r[6] })) : [];
        const sw = (await c.query(`select c.legacy_id cid, w.amount_cents / 100.0 amt, w.reason, coalesce(p.legacy_id, '') pkg, w.by_who "by" from public.wallet_ledger w join public.clients c on c.id = w.client_id
            left join public.packages p on p.id = w.package_id order by w.ctid`)).rows.map(x => Object.assign(x, { amt: Number(x.amt) }));
        d = diff(gw, sw); ok(d.length === 0, `[${name}] ${label}: same wallet lines`, d.join('\n         '));
        const ns = w.ops.getSheetByName('NOTICES'), gn = ns ? ns.rows.slice(1).filter(r => r && r[0]).map(r => ({ for: r[2], type: r[3], text: r[4] })) : [];
        const sn = (await c.query(`select c.legacy_id "for", n.type, n.text from public.notices n join public.clients c on c.id = n.for_client order by n.legacy_id`)).rows;
        d = diff(gn, sn); ok(d.length === 0, `[${name}] ${label}: same notices`, d.join('\n         '));
        const qs = w.ops.getSheetByName('CLIENT REQUESTS'), gq = qs ? qs.rows.slice(1).filter(r => r && r[0]).map(r => ({ id: r[0], cid: r[2], type: r[4], details: r[5], data: JSON.parse(r[11] || '{}') })) : [];
        const sq = (await c.query(`select q.legacy_id id, c.legacy_id cid, q.type, q.details, q.data from public.client_requests q join public.clients c on c.id = q.client_id order by q.legacy_id`)).rows;
        d = diff(gq, sq); ok(d.length === 0, `[${name}] ${label}: same requests`, d.join('\n         '));
      },
      async boots(cids) {
        const gd = w.call('refClientBoot_', { accounts: cids.map(x => ({ cid: x })) });
        for (const [i, cid] of cids.entries()) {
          const s = unwrap(await wb(c, 'app_cl_boot', cid.toLowerCase() + '@x.com', {}));
          const acc = (s.accounts || []).find(a => a.cid === cid) || {};
          const d = diff({ refs: gd.accounts[i].refs, credit: gd.accounts[i].credit }, { refs: acc.refs, credit: acc.credit });
          ok(d.length === 0, `[${name}] client boot ${cid}: same refs and credit`, d.join('\n         ') || s.error);
        }
        for (const [key, role] of [['k-romy', 'assistant'], ['k-majd', 'owner'], ['k-joe', 'trainer']]) {
          const gs = w.call('refStaffBoot_', {}, { role }), s = unwrap(await wb(c, 'app_boot', key, {}));
          const d = diff({ referral: gs.referral, refs: gs.refs }, { referral: s.referral, refs: s.refs });
          ok(d.length === 0, `[${name}] staff boot (${role}): same referrals`, d.join('\n         ') || s.error);
        }
      }
    };
    try { await steps(R); } finally { await c.end(); }
  }
  await ref('invite, reward on the first paid package only', async R => {
    await R.client('C001', 'Lara Khoury', '03 111 222');
    await R.invite('C001', 'Sara Haddad', '96170123456');
    await R.invite('C001', 'Sara', '+961 70 123 456', 'same friend again');
    await R.invite('C001', 'Sara', '123', 'bad phone');
    await R.client('C010', 'Sara Haddad', '070 123 456');
    await R.sell('C010', TRIAL); await R.sell('C010', FREE); await R.sell('C010', PAID, { price: 0 }, 'paid type at $0');
    const g1 = await R.sell('C010', PAID, { paid: 140 }, 'first paid package');
    ok(g1.referral && g1.referral.amount === 5 && g1.referral.by === 'C001', 'credit given on the first paid package', g1);
    await R.sell('C010', PAID, { months: 3 }, 'second paid package (3 months)');
    await R.boots(['C001', 'C010']);
    // the 3 / 6 month offers make packages with app.add_pkg (Client.gs clAddPkg_): the same referral check runs there (Supabase side only)
    await R.client('C011', 'Ola Saad', '71 444 555'); await R.invite('C001', 'Ola', '96171444555');
    await R.c.query(`select app.add_pkg((select id from public.clients where legacy_id = 'C011'), $1, 140, current_date, 0, 'offer')`, [PAID]);
    const n = (await R.c.query(`select count(*)::int n from public.wallet_ledger where reason = 'Referral: Ola'`)).rows[0].n;
    ok(n === 1 && (await R.c.query(`select status from public.referrals where friend = 'Ola'`)).rows[0].status === 'Rewarded', 'app.add_pkg (offers) gives the referral credit', n);
  });
  await game('Wellbe Credit stays separate from the referral credit', { clients: [C('C001', 'Lara Khoury')], pkgs: [], trained: {} }, async S => { await S.call('C001', { op: 'get' }, 'get'); });
  await ref('first inviter wins, existing clients, self referral', async R => {
    await R.client('C001', 'Lara Khoury', '03 111 222'); await R.client('C002', 'Maya Saab', '71 999 888'); await R.client('C020', 'Rami Aoun', '76 555 444');
    await R.invite('C001', 'Sara Haddad', '96170123456'); await R.invite('C002', 'Sara H', '96170123456', 'second inviter');
    await R.client('C010', 'Sara Haddad', '+961 70 123 456'); await R.sell('C010', PAID);
    await R.sell('C020', PAID); await R.invite('C001', 'Rami', '96176555444', 'a paying client');
    await R.sell('C020', PAID, {}, 'his next package');
    await R.client('C021', 'Nour Fares', '81 222 333'); await R.sell('C021', TRIAL);
    await R.invite('C001', 'Nour', '96181222333', 'trial only client'); await R.sell('C021', PAID, {}, 'her first paid package');
    await R.client('C030', 'Karim Daher', ''); await R.sell('C030', PAID);
    await R.invite('C001', 'Karim', '96170777666', 'unknown phone');
    await R.invite('C001', 'Me', '9613111222', 'own phone');
    await R.invite('C001', 'Lea', '96171000111', 'her other number');
    await R.lead('Lara Khoury', '71 000 111', 'C001');
    await R.sell('C001', PAID, {}, 'own second number: not eligible');
    await R.invite('C001', 'X', '96171000111', 'number linked to her');
    await R.lead('Omar', '76 123 123', '');
    await R.invite('C002', 'Omar', '96176123123', 'a lead: joined');
    await R.guest('G0001', '078 123 123', 'C002');
    await R.invite('C001', 'Tia', '96178123123', 'friend found through a guest');
    await R.boots(['C001', 'C002', 'C010']);
  });

  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
module.exports = { gsWorld, diff, fmt, setNow: t => { NOW = t; } };
