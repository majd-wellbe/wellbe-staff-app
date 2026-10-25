#!/usr/bin/env node
// =====================================================================
// WELLBE: Google Sheets CSV export -> Supabase SQL
// Usage:
//   node import.js --in <folder of CSV files> --out import.sql --report report.md [--gs <folder with the .gs files>]
// Put one CSV per tab in the folder (File > Download > CSV in Google Sheets, one tab at a time).
// File names only need to END with the tab name: "Wellbe Operations - PACKAGES.csv", "SESSIONS 1_3.csv" are fine.
// Old rows are read with the Apps Script's own functions (appSessObj_, appYmd_, cfgKind_, appTrainer_),
// so every row means exactly what it means in the live app today.
// Nothing is written to any database: you run import.sql yourself (README-PHASE5.md, step "Import").
// =====================================================================
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---------- args ----------
const A = {}; for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const IN = A.in, OUT = A.out || 'import.sql', REPORT = A.report || 'import-report.md';
const GS = A.gs || path.join(__dirname, '../tests/.gs');

// ---------- load the Apps Script rules (with the node mock of the Google services) ----------
function loadGs(dir) {
  if (global.__wbGsLoaded) return;
  require(path.join(dir, 'tests/mock.js'));
  const vm = require('vm'), files = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort((a, b) => (a === 'Config.gs') - (b === 'Config.gs'));
  vm.runInThisContext(files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n'), { filename: 'all.gs' });
  global.__wbGsLoaded = true;
}

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function readTabs(dir) {
  const files = fs.readdirSync(dir).filter(f => /\.csv$/i.test(f)), out = {};
  return name => {
    const n = norm(name); if (out[n]) return out[n];
    const f = files.filter(x => norm(x.replace(/\.csv$/i, '')).endsWith(n)).sort((a, b) => a.length - b.length)[0];
    return (out[n] = f ? parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  };
}

// ---------- cleaning helpers ----------
const uuid = () => crypto.randomUUID();
const S = v => String(v == null ? '' : v).trim();
function cents(v) { const s = S(v).replace(/[$,\s]/g, ''); if (!s) return 0; const n = Number(s); return isNaN(n) ? null : Math.round(n * 100); }
function num(v) { const s = S(v).replace(/[,\s]/g, ''); if (!s) return null; const n = Number(s); return isNaN(n) ? null : n; }
function ymd(v) { const s = S(v); return s ? (appYmd_(s, s) || null) : null; }
// 'dd/MM/yyyy HH:mm(:ss)' or ISO -> timestamptz text in Beirut time
function stamp(v) {
  const s = S(v); if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'} Asia/Beirut`;
  m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (m) return `${m[1]} ${m[2] || '00:00:00'} Asia/Beirut`;
  return null;
}
function phone(v, cc) {
  let d = S(v).replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (!d) return null;
  if (/^0\d{6,8}$/.test(d)) d = cc + d.slice(1);           // local 03 123 456 -> 9613123456
  else if (/^[1-9]\d{6,7}$/.test(d)) d = cc + d;            // 70123456 -> 96170123456
  return d;
}
const yes = v => /^(y|yes|true|1|x)$/i.test(S(v));
function json(v, fb) { try { const s = S(v); return s ? JSON.parse(s) : fb; } catch (e) { return fb; } }
const q = v => v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const qj = v => q(JSON.stringify(v)) + '::jsonb';

// ---------- run ----------
function run(dir, gsDir) {
  loadGs(gsDir);
  const tab = readTabs(dir), sql = [], P = { info: [], warn: [], counts: {} };
  const cc = String((CFG_DEFAULTS.center || {}).country || '961');
  const warn = m => P.warn.push(m), count = (k, n) => { P.counts[k] = (P.counts[k] || 0) + (n || 1); };
  const ins = (table, cols, vals) => sql.push(`insert into public.${table} (${cols.join(', ')}) values (${vals.map(v => v && v.__raw ? v.__raw : q(v)).join(', ')});`);
  const raw = s => ({ __raw: s });
  const byLegacy = { client: {}, pkg: {}, sess: {}, lead: {}, req: {} };
  const seen = (map, id, what) => { if (map[id]) { warn(`Duplicate ${what} ${id}: second copy renamed ${id}-dup`); return id + '-dup'; } return id; };

  // ---- CLIENTS (Client Portal) ----
  const cl = tab(CFG.CLIENTS_TAB);
  if (!cl) warn('No CLIENTS file: clients cannot be imported (every other tab needs them).');
  else {
    const h = cl[0].map(norm), at = k => h.indexOf(norm(k));
    const iId = at('Client ID'), iName = at('Name') > -1 ? at('Name') : at('Client'), iEmail = at('Email'), iPhone = at('Phone'), iParent = at('Parent Email');
    cl.slice(1).forEach((r, i) => {
      let id = S(r[iId]).toUpperCase(); if (!id) return;
      if (!/^C\d+$/.test(id)) warn(`CLIENTS row ${i + 2}: client ID "${id}" is not like C012`);
      id = seen(byLegacy.client, id, 'client');
      const u = uuid(); byLegacy.client[id] = u;
      const email = clEmail_(r[iEmail]) || null; if (S(r[iEmail]) && !email) warn(`CLIENTS ${id}: email "${S(r[iEmail])}" is not valid, left empty`);
      const ph = phone(r[iPhone], cc); if (S(r[iPhone]) && ph !== S(r[iPhone])) count('phones normalized');
      ins('clients', ['id', 'legacy_id', 'kind', 'name', 'email', 'phone', 'parent_email'], [u, id, 'client', S(r[iName]) || id, email, ph, iParent > -1 ? clEmail_(r[iParent]) || null : null]);
      count('clients');
    });
  }
  // ---- APP GUESTS ----
  const gt = tab(GUEST.TAB);
  if (gt) gt.slice(1).forEach(r => {
    let id = S(r[0]).toUpperCase(); if (!id) return; id = seen(byLegacy.client, id, 'guest');
    const u = uuid(); byLegacy.client[id] = u;
    ins('clients', ['id', 'legacy_id', 'kind', 'name', 'email', 'phone', 'created_at', 'verified_at'],
      [u, id, 'guest', S(r[2]) || id, clEmail_(r[1]) || null, phone(r[3], cc), stamp(r[4]) || raw('now()'), yes(r[5]) ? stamp(r[4]) || raw('now()') : null]);
    if (S(r[8])) count('guests already converted to a client (kept as history)');
    count('guests');
  });
  const cid = (legacy, where) => { const id = S(legacy).toUpperCase(); if (!id) return null; const u = byLegacy.client[id]; if (!u) warn(`${where}: unknown client ${id}, row skipped`); return u || null; };

  // ---- CLIENT NOTES (medical notes, Melanie flag) ----
  const cn = tab('CLIENT NOTES');
  if (cn) cn.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'CLIENT NOTES row ' + (i + 2)); if (!u) return;
    ins('client_notes', ['client_id', 'always_show', 'program', 'updated_by'], [u, S(r[2]), S(r[3]), S(r[4]) || null]);
    if (yes(r[6])) sql.push(`update public.clients set is_mel = true where id = ${q(u)};`);
    count('client notes');
  });

  // ---- PACKAGES (data from row 3) ----
  const pk = tab('PACKAGES'), pkgClient = {};
  if (!pk) warn('No PACKAGES file.');
  else pk.slice(2).forEach((r, i) => {
    let id = S(r[0]); if (!id) return;
    const rowN = i + 3, u = cid(r[1], `PACKAGES ${id} (row ${rowN})`); if (!u) return;
    id = seen(byLegacy.pkg, id, 'package');
    const pid = uuid(); byLegacy.pkg[id] = pid; pkgClient[id] = u;
    const type = S(r[3]), kind = cfgKind_(type), price = cents(r[8]), paid = cents(r[21]);
    if (price === null) warn(`PACKAGES ${id}: price "${S(r[8])}" is not a number, set to 0`);
    if (paid === null) warn(`PACKAGES ${id}: paid "${S(r[21])}" is not a number, set to 0`);
    let disc = S(r[19]).replace('%', ''), d = num(disc); if (d !== null && !/%/.test(S(r[19])) && d <= 1) d = d * 100;
    const start = ymd(r[9]), exp = ymd(r[10]), ext = ymd(r[11]), eff = ymd(r[12]) || ext || exp;
    if (!start) warn(`PACKAGES ${id}: no start date`);
    if (start && eff && eff < start) warn(`PACKAGES ${id}: ends ${eff} before it starts ${start}`);
    const status = S(r[13]) || 'Active', passes = num(r[4]) || 0, used = num(r[5]) || 0;
    if (status === 'Active' && eff && eff < appShift_(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), -60) && used >= passes) count('packages Active but finished long ago (status kept, check them)');
    ins('packages', ['id', 'legacy_id', 'client_id', 'type_name', 'kind', 'passes', 'used', 'price_cents', 'paid_cents', 'discount_pct', 'start_date', 'expiry_date', 'extended_expiry', 'effective_expiry', 'status', 'new_client', 'note'],
      [pid, id, u, type, kind, passes, used, price || 0, paid || 0, Math.round((d || 0) * 100) / 100, start, exp, ext, eff, status, yes(r[15]), S(r[20])]);
    count('packages');
  });

  // ---- SESSIONS: the 6 session tabs, read with appSessObj_ ----
  const valid = ['Scheduled', 'Done', 'Cancelled', 'Late Cancel', 'No Show'];
  Object.keys(AT).forEach(k => {
    const cfg = AT[k], t = tab(cfg.sheet); if (!t) { warn(`No ${cfg.sheet} file.`); return; }
    t.slice(2).forEach((r, i) => {
      let id = S(r[0]); if (!id) return;
      const row = i + 3, d = r.slice(); while (d.length < cfg.width) d.push('');
      const date = appYmd_(d[1], d[1]); if (!date) { warn(`${cfg.sheet} ${id}: no date, skipped`); return; }
      const s = appSessObj_(k, cfg, d, d, row, date);
      if (!s.start) { warn(`${cfg.sheet} ${id}: no start time, skipped`); return; }
      id = seen(byLegacy.sess, id, 'session');
      const su = uuid(); byLegacy.sess[id] = su;
      let st = S(d[cfg.status - 1]); if (st === 'Early Cancel') st = 'Cancelled'; if (valid.indexOf(st) < 0) { if (st) warn(`${cfg.sheet} ${id}: status "${st}" unknown, read as ${s.status}`); st = s.status; }
      if (!cfg.fixed && !s.trainer) warn(`${cfg.sheet} ${id}: no trainer`);
      else if (!cfg.fixed && !CFG_DEFAULTS.staff.concat(cfg_().staff).some(x => x.trainer === s.trainer)) warn(`${cfg.sheet} ${id}: trainer "${S(d[cfg.trainer - 1])}" is not in STAFF (kept as "${s.trainer}")`);
      ins('sessions', ['id', 'legacy_id', 'kind', 'day', 'start_time', 'end_time', 'trainer', 'room', 'status', 'pay_source', 'note'],
        [su, id, s.tab, date, s.start, s.end || appEnd_(s.start), s.trainer, s.room, st, s.pay, S(d[cfg.note - 1])]);
      s.clients.forEach(c => {
        const p = byLegacy.pkg[c.pkg]; if (!p) { warn(`${cfg.sheet} ${id}: package ${c.pkg} (${c.name}) not found, that client is left out`); return; }
        const flag = c.flag === 'Y' || c.flag === 'N' ? c.flag : '';
        if (c.flag && !flag) warn(`${cfg.sheet} ${id}: pass flag "${c.flag}" read as empty`);
        ins('session_clients', ['session_id', 'slot', 'package_id', 'client_id', 'name', 'att', 'pass', 'gcal_event'],
          [su, c.slot, p, pkgClient[c.pkg], c.name, c.att || '', flag, S(d[cfg.slots[c.slot].gcal - 1]) || null]);
        count('session clients');
      });
      count('sessions');
    });
  });
  // used counts: the database recounts from the Y flags; differences are reported
  // Used is kept as it is in the sheet (what clients see today). The Apps Script recounts a package from its Y flags
  // each time one of its sessions is marked, and so does the database: packages where the two differ are listed at the end.
  sql.push(`create temp table _used_flags as select p.id, p.legacy_id, p.used, (select count(*) from public.session_clients sc where sc.package_id = p.id and sc.pass = 'Y')::int as flags from public.packages p;`);

  // ---- LEADS W40 ----
  const ld = tab(CFG.LEADS_TAB);
  if (ld) ld.slice(1).forEach((r, i) => {
    let id = S(r[L.ID]); if (!id) return; id = seen(byLegacy.lead, id, 'lead'); const u = uuid(); byLegacy.lead[id] = u;
    let st = S(r[L.STATUS]) || 'No Booking'; if (STATUSES.indexOf(st) < 0) { warn(`LEADS ${id}: status "${st}" read as No Booking`); st = 'No Booking'; }
    ins('leads', ['id', 'legacy_id', 'submitted_at', 'name', 'phone', 'email', 'trained_before', 'stopped', 'why_now', 'injuries', 'trial_date', 'trial_time', 'booking_type', 'status', 'called', 'notes', 'source', 'client_id', 'package_id', 'session_id'],
      [u, id, stamp(r[L.SUB]) || raw('now()'), S(r[L.NAME]), phone(r[L.PHONE], cc), clEmail_(r[L.EMAIL]) || null, S(r[L.TRAINED]), S(r[L.STOPPED]), S(r[L.WHY]), S(r[L.INJ]),
       ymd(r[L.DATE]), S(r[L.TIME]), S(r[L.TYPE]), st, S(r[L.CALLED]), S(r[L.NOTES]), S(r[L.SRC]),
       byLegacy.client[S(r[L.CID]).toUpperCase()] || null, byLegacy.pkg[S(r[L.PKG])] || null, byLegacy.sess[S(r[L.SID])] || null]);
    if (S(r[L.PKG]) && !byLegacy.pkg[S(r[L.PKG])]) warn(`LEADS ${id}: package ${S(r[L.PKG])} not found`);
    count('leads');
  });

  // ---- CLIENT REQUESTS ----
  const rq = tab('CLIENT REQUESTS');
  if (rq) rq.slice(1).forEach((r, i) => {
    let id = S(r[0]); if (!id) return; const u = cid(r[2], 'CLIENT REQUESTS ' + id); if (!u) return;
    id = seen(byLegacy.req, id, 'request'); const ru = uuid(); byLegacy.req[id] = ru;
    let st = S(r[8]) || 'New'; if (['New', 'Done', 'Declined'].indexOf(st) < 0) { warn(`CLIENT REQUESTS ${id}: status "${st}" read as Done`); st = 'Done'; }
    ins('client_requests', ['id', 'legacy_id', 'created_at', 'client_id', 'type', 'details', 'slot', 'package_id', 'status', 'handled_by', 'handled_at', 'data'],
      [ru, id, stamp(r[1]) || raw('now()'), u, S(r[4]), S(r[5]), S(r[6]), byLegacy.pkg[S(r[7])] || null, st, S(r[9]) || null, stamp(r[10]), raw(qj(json(r[11], {})))]);
    count('client requests');
  });

  // ---- NOTICES ----
  const nt = tab('NOTICES');
  if (nt) nt.slice(1).forEach(r => {
    const id = S(r[0]); if (!id) return; const f = S(r[2]), isClient = /^[CG]\d+$/i.test(f);
    const u = isClient ? cid(f, 'NOTICES ' + id) : null; if (isClient && !u) return;
    const staffId = isClient ? null : f.toLowerCase();
    if (!isClient && !CFG_DEFAULTS.staff.concat(cfg_().staff).some(s => s.id === staffId)) { warn(`NOTICES ${id}: for "${f}" is not a client or staff ID, skipped`); return; }
    ins('notices', ['legacy_id', 'created_at', 'for_client', 'for_staff', 'type', 'text', 'read_at'], [id, stamp(r[1]) || raw('now()'), u, staffId, S(r[3]), S(r[4]), stamp(r[5])]);
    count('notices');
  });

  // ---- CORNICHE RUN (game) ----
  const gr = tab('CORNICHE RUN');
  if (gr) gr.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'CORNICHE RUN row ' + (i + 2)); if (!u) return;
    const dk = S(r[7]).replace(/^D/, ''), wk = S(r[9]).replace(/^W/, ''), last = Number((/^T(\d+)/.exec(S(r[14])) || [])[1]) || 0;   // 'T' + time, then maybe the cause JSON
    ins('game_players', ['client_id', 'name', 'best_score', 'best_m', 'coins', 'runs', 'total_m', 'day_key', 'day_best', 'week_key', 'week_best', 'upgrades', 'missions', 'badges', 'last_run_at', 'earned_total', 'credit_cents', 'credit_earned_cents', 'xp', 'owned', 'created_at'],
      [u, S(r[1]), num(r[2]) || 0, num(r[3]) || 0, Math.max(0, num(r[4]) || 0), num(r[5]) || 0, num(r[6]) || 0, /^\d{4}-\d{2}-\d{2}$/.test(dk) ? dk : null, num(r[8]) || 0,
       /^\d{4}-\d{2}-\d{2}$/.test(wk) ? wk : null, num(r[10]) || 0, raw(qj(json(r[11], {}))), raw(qj(json(r[12], {}))), raw(qj(json(r[13], []))),
       last ? new Date(last).toISOString() : null, num(r[15]) || 0, Math.max(0, num(r[17]) || 0), num(r[18]) || 0, num(r[19]) || 0, raw(qj(json(r[20], {}))),
       raw(`clock_timestamp() + interval '${i} microseconds'`)]);
    count('game players');
  });

  // ---- CLIENT STREAKS ----
  const sk = tab('CLIENT STREAKS');
  if (sk) sk.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'CLIENT STREAKS row ' + (i + 2)); if (!u) return;
    const days = S(r[2]).split(',').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), keys = (S(r[4]) || '000').split('').slice(0, 3).map(c => c === '1');
    while (keys.length < 3) keys.push(false);
    ins('streaks', ['client_id', 'done_days', 'keys_day', 'keys', 'last_reward', 'reward_pkg', 'rewards'],
      [u, raw(q('{' + days.join(',') + '}') + '::date[]'), ymd(r[3]), raw(q('{' + keys.join(',') + '}') + '::boolean[]'), ymd(r[5]), byLegacy.pkg[S(r[6])] || null, num(r[7]) || 0]);
    count('streaks');
  });

  // ---- CLIENT WALLET ----
  const wl = tab('CLIENT WALLET');
  if (wl) wl.slice(1).forEach((r, i) => {
    const u = cid(r[1], 'CLIENT WALLET row ' + (i + 2)); if (!u) return; const a = cents(r[3]);
    if (a === null) { warn(`CLIENT WALLET row ${i + 2}: amount "${S(r[3])}" not a number, skipped`); return; }
    ins('wallet_ledger', ['day', 'client_id', 'amount_cents', 'reason', 'package_id', 'by_who'], [ymd(r[0]) || raw('current_date'), u, a, S(r[4]), byLegacy.pkg[S(r[5])] || null, S(r[6])]);
    count('wallet lines');
  });

  // ---- CLIENT GOALS ----
  const gl = tab('CLIENT GOALS');
  if (gl) gl.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'CLIENT GOALS row ' + (i + 2)); if (!u) return;
    ins('client_goals', ['client_id', 'promise', 'key1', 'key2', 'key3', 'made_by'], [u, S(r[2]), S(r[3]), S(r[4]), S(r[5]), S(r[7])]);
    count('goals');
  });

  // ---- WORKOUTS ----
  const wp = tab('WORKOUT PROGRAMS');
  if (wp) wp.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'WORKOUT PROGRAMS row ' + (i + 2)); if (!u) return; const pj = json(r[2], null);
    if (S(r[2]) && pj === null) warn(`WORKOUT PROGRAMS ${S(r[0])}: program is not valid JSON, saved empty`);
    ins('wo_programs', ['client_id', 'program', 'version', 'updated_by'], [u, raw(qj(pj || {})), num(r[5]) || 1, S(r[4])]);
    count('workout programs');
  });
  const wlog = tab('WORKOUT LOG');
  if (wlog) wlog.slice(1).forEach((r, i) => {
    const u = cid(r[2], 'WORKOUT LOG row ' + (i + 2)); if (!u) return;
    const sets = S(r[7]).split(/[,;]\s*/).filter(Boolean).map(x => { const m = /([\d.]+)\s*x\s*(\d+)/i.exec(x); return m ? { kg: Number(m[1]), reps: Number(m[2]) } : { raw: x }; });
    ins('wo_logs', ['logged_at', 'day', 'client_id', 'session_id', 'workout', 'exercise', 'sets', 'by_who'], [stamp(r[0]) || raw('now()'), ymd(r[1]) || raw('current_date'), u, byLegacy.sess[S(r[4])] || null, S(r[5]), S(r[6]) || '?', raw(qj(sets)), S(r[8])]);
    count('workout log lines');
  });
  const body = tab('CLIENT BODY');
  if (body) body.slice(1).forEach((r, i) => {
    const u = cid(r[1], 'CLIENT BODY row ' + (i + 2)); if (!u) return;
    ins('client_body', ['day', 'client_id', 'weight_kg', 'height_cm', 'birth_year', 'sex', 'by_who'], [ymd(r[0]) || raw('current_date'), u, num(r[3]), num(r[4]), num(r[5]), S(r[6]) || null, S(r[7])]);
    count('body lines');
  });

  // ---- NUTRITION ----
  const ni = tab('NUTRITION INTAKE');
  if (ni) ni.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'NUTRITION INTAKE row ' + (i + 2)); if (!u) return;
    ins('nutrition_intake', ['client_id', 'answers', 'step', 'done', 'version', 'target_kg', 'body_comp', 'flags'], [u, raw(qj(json(r[2], {}))), num(r[3]) || 0, yes(r[4]), num(r[5]) || 1, num(r[6]), raw(qj(json(r[7], null))), S(r[8])]);
    count('nutrition intakes');
  });
  const np = tab('NUTRITION PLANS');
  if (np) np.slice(1).forEach((r, i) => {
    const u = cid(r[1], 'NUTRITION PLANS row ' + (i + 2)); if (!u) return;
    const plan = json(S(r[6]) + S(r[7]) + S(r[8]), null), st = S(r[4]);
    if ((S(r[6]) || S(r[7])) && plan === null) warn(`NUTRITION PLANS ${S(r[0])}: plan JSON could not be read, saved empty`);
    const ok = ['Queued', 'Writing', 'Pending', 'Approved', 'Declined', 'Failed', 'Coach review', 'Replaced'];
    ins('nutrition_plans', ['legacy_id', 'client_id', 'created_at', 'status', 'macros', 'plan', 'intake_version', 'weight_at_plan', 'target', 'by_who', 'decided_at', 'coach_note', 'error', 'attempts'],
      [S(r[0]) || null, u, stamp(r[3]) || raw('now()'), ok.indexOf(st) > -1 ? st : 'Failed', raw(qj(json(r[5], null))), raw(qj(plan)), num(r[9]), num(r[10]), num(r[11]), S(r[12]), stamp(r[13]), S(r[14]), S(r[15]), num(r[16]) || 0]);
    count('nutrition plans');
  });
  const nw = tab('NUTRITION WEIGHINS');
  if (nw) nw.slice(1).forEach((r, i) => {
    const u = cid(r[1], 'NUTRITION WEIGHINS row ' + (i + 2)); if (!u || num(r[3]) === null) return;
    ins('nutrition_weighins', ['day', 'client_id', 'weight_kg', 'by_who'], [ymd(r[0]) || raw('current_date'), u, num(r[3]), S(r[4])]);
    count('weigh-ins');
  });

  // ---- INSURANCE ----
  const ic = tab('INSURANCE CLIENTS');
  if (ic) ic.slice(1).forEach((r, i) => {
    const u = cid(r[0], 'INSURANCE CLIENTS row ' + (i + 2)); if (!u || !S(r[2])) return;
    ins('insurance_clients', ['client_id', 'insurer', 'member_number', 'notes', 'rate_cents', 'by_who'], [u, S(r[2]), S(r[3]), S(r[4]), cents(r[7]) || null, S(r[6])]);
    count('insured clients');
  });
  const ik = tab('INSURANCE CLAIMS');
  if (ik) ik.slice(1).forEach((r, i) => {
    const u = cid(r[1], 'INSURANCE CLAIMS ' + S(r[0])); if (!u) return;
    const pkgs = S(r[7]).split(/[,\s]+/).filter(Boolean).map(x => byLegacy.pkg[x]).filter(Boolean);
    ins('insurance_claims', ['legacy_id', 'client_id', 'insurer', 'month', 'sessions', 'amount_cents', 'package_ids', 'submitted', 'expected', 'reference', 'status', 'paid_on', 'paid_cents', 'by_who'],
      [S(r[0]) || null, u, S(r[3]), (ymd(r[4]) || (S(r[4]).slice(0, 7) + '-01')), num(r[5]) || 0, cents(r[6]) || 0, raw(q('{' + pkgs.join(',') + '}') + '::uuid[]'), ymd(r[8]), ymd(r[9]), S(r[10]), S(r[11]) || 'To send', ymd(r[12]), cents(r[13]), S(r[14])]);
    count('insurance claims');
  });

  // ---- MONEY OUT and POS ----
  const ex = tab('EXPENSES');
  if (ex) ex.slice(1).forEach((r, i) => {
    if (!S(r[0]) && !S(r[2])) return; const a = cents(r[4]);
    if (a === null) { warn(`EXPENSES ${S(r[0])}: amount "${S(r[4])}" not a number, skipped`); return; }
    if (!ymd(r[1])) { warn(`EXPENSES ${S(r[0])}: no date, skipped`); return; }
    ins('expenses', ['day', 'what', 'category', 'amount_cents', 'by_who'], [ymd(r[1]), S(r[2]) || '?', S(r[3]), a, S(r[5])]);
    count('expenses');
  });
  const re = tab('RECURRING EXPENSES');
  if (re) re.slice(1).forEach(r => {
    if (!S(r[0])) return;
    ins('recurring_expenses', ['legacy_id', 'what', 'category', 'amount_cents', 'every', 'first_day', 'end_day', 'active', 'last_logged'],
      [S(r[0]), S(r[1]), S(r[2]), cents(r[3]) || 0, S(r[4]) || 'Monthly', ymd(r[5]) || raw('current_date'), ymd(r[6]), S(r[7]) === '' ? true : yes(r[7]), ymd(r[8])]);
    count('recurring expenses');
  });
  const inv = tab('POS INVENTORY'), invSeen = {};
  if (inv) inv.slice(1).forEach(r => {
    const item = S(r[3]); if (!item || invSeen[item]) return; invSeen[item] = 1;
    ins('inventory', ['item', 'price_cents', 'stock', 'cost_cents'], [item, 0, num(r[8]) || 0, cents(r[5])]);
    count('inventory items');
  });
  if (inv) warn('POS INVENTORY: the sale price column is not known from the code; prices were set to 0, fill them in after the import.');
  const pos = tab('POS SALES');
  if (pos) pos.slice(1).forEach(r => {
    if (!S(r[0])) return;
    ins('pos_sales', ['at', 'item', 'qty', 'amount_cents', 'method', 'by_who'], [stamp(r[1]) || raw('now()'), S(r[2]), num(r[4]) || 1, cents(r[5]) || 0, S(r[8]), S(r[9])]);
    count('POS sales');
  });

  // ---- what is NOT imported automatically ----
  ['CLIENT PROFILE', 'CLIENT FILES', 'PHYSIO INTAKE', 'SESSION NOTES'].forEach(n => { const t = tab(n); if (t && t.length > 1) P.info.push(`${n}: ${t.length - 1} rows NOT imported by this script (photos and files must be uploaded to Storage first, see README).`); });

  return { sql, P };
}

// ---------- write ----------
if (require.main === module) {
  if (!IN) { console.error('Usage: node import.js --in <csv folder> --out import.sql --report report.md [--gs <.gs folder>]'); process.exit(1); }
  const { sql, P } = run(IN, GS);
  fs.writeFileSync(OUT, ['-- generated by import/import.js on ' + new Date().toISOString(), 'begin;', 'set constraints all immediate;'].concat(sql, [
    `-- packages whose Used in the sheet is not the number of Y flags (check them; the next mark recounts from the flags)`,
    `select legacy_id, used as used_in_sheet, flags as y_flags from _used_flags where used <> flags order by 1;`,
    'commit;']).join('\n') + '\n');
  const rep = ['# Import report', '', 'Generated ' + new Date().toISOString(), '', '## Counts', ''].concat(
    Object.keys(P.counts).map(k => `- ${k}: ${P.counts[k]}`), ['', '## Problems (' + P.warn.length + ')', ''], P.warn.map(w => '- ' + w), ['', '## Not imported', ''], P.info.map(w => '- ' + w));
  fs.writeFileSync(REPORT, rep.join('\n') + '\n');
  console.log(`import.sql: ${sql.length} statements · problems: ${P.warn.length} · report: ${REPORT}`);
}
module.exports = { run, parseCsv, phone, cents, stamp };
